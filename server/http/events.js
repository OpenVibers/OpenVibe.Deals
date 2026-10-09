'use strict';

/**
 * Events consumer: POST /internal/events, the endpoint of Deals' OpenVibe.Events subscriptions to
 * `sources.item.*` (filter: payload.category = deals) and to network.account.export_requested and
 * network.account.deleted (ADR-033, answered by server/domain/account-data.js through openvibe-sdk/account-data). The signature (X-OpenVibe-Signature v2,
 * ±300 s; several comma-separated secrets allow rotation) and the exactly-once inbox come from the
 * chassis (openvibe-publishing/ingest.createEventConsumer): the receipt (consumer, event_id) and the
 * change commit in one PostgreSQL transaction, so a redelivery changes nothing.
 *
 * Source item events carry no prices, so a delivery only wakes the importer, which reads the change
 * feed from its cursor: a lost event delays an import, a repeated one changes nothing.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { createEventConsumer } = require('openvibe-publishing/ingest');

const CONSUMER = 'deals-sources';
const TYPES = new Set(['sources.item.created', 'sources.item.updated', 'sources.item.removed']);
const { TOPICS: ACCOUNT_TOPICS } = require('openvibe-sdk/account-data');

/**
 * accountData + accountSend: the account export and deletion handle and its sender to Network. A failure (Network
 * unreachable, a refusal worth retrying) throws, the inbox receipt rolls back and Events redelivers; account-data keeps
 * its own receipt per export and deletion id, so a redelivery never erases twice.
 */
function createEvents({ config, store, importer, accountData = null, accountSend = null }) {
    const router = express.Router();
    const consumer = createEventConsumer({ db: store.db, secrets: config.events.webhookSecrets, consumer: CONSUMER, now: store.now });

    router.post('/internal/events', express.raw({ type: () => true, limit: '256kb' }), async (req, res, next) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let r;
        try {
            r = await consumer.apply(raw, req.headers, async (event) => {
                if (ACCOUNT_TOPICS.includes(event.event_type)) {
                    if (!accountData || !accountSend) throw new Error('account export and deletion are not configured');
                    return await accountData.apply(event, { send: accountSend });
                }
                if (!TYPES.has(event.event_type) || event.source !== 'sources') return 'ignored';
                const category = event.payload && event.payload.category;
                if (category !== 'deals') return 'ignored';
                return 'import_scheduled';
            });
        } catch (err) { return next(err); }
        if (r.status === 503) return http.sendProblem(res, 503, 'deals.webhook_disabled', { detail: 'DEALS_EVENTS_SECRET is not set', ctx: req.ov });
        if (r.status === 401) return http.sendProblem(res, 401, 'deals.bad_signature', { detail: 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window', ctx: req.ov });
        if (r.status === 400) return http.sendProblem(res, 400, 'deals.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx: req.ov });
        if (!r.duplicate && r.outcome === 'import_scheduled') importer.kick();
        res.status(200).json({ event_id: r.event_id, duplicate: Boolean(r.duplicate), outcome: r.duplicate ? null : r.outcome });
    });

    return router;
}

module.exports = { createEvents, CONSUMER };
