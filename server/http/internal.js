'use strict';

/**
 * Events consumer: POST /internal/events, the endpoint of Deals' OpenVibe.Events subscription to
 * `sources.item.*` (filter: payload.category = deals). Signed with X-OpenVibe-Signature
 * (HMAC-SHA256 of the raw body under DEALS_EVENTS_SECRET; several comma-separated secrets allow
 * rotation), recorded exactly once per event_id in the inbox (idempotency_receipts).
 *
 * Source item events carry no prices, so a delivery only wakes the importer, which reads the change
 * feed from its cursor: a lost event delays an import, a repeated one changes nothing.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { verifyDelivery, createInbox } = require('openvibe-sdk/events');

const CONSUMER = 'deals-sources';
const TYPES = new Set(['sources.item.created', 'sources.item.updated', 'sources.item.removed']);

function createInternalRoutes({ config, store, importer }) {
    const router = express.Router();
    const inbox = createInbox(store.db, { now: store.now });
    inbox.ensureSchema();

    router.post('/internal/events', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
        const secrets = config.events.webhookSecrets;
        if (!secrets.length) return http.sendProblem(res, 503, 'deals.webhook_disabled', { detail: 'DEALS_EVENTS_SECRET is not set', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const sig = req.get('x-openvibe-signature');
        if (!secrets.some((s) => verifyDelivery(raw, sig, s))) return http.sendProblem(res, 401, 'deals.bad_signature', { detail: 'X-OpenVibe-Signature does not verify', ctx: req.ov });
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
        const event = body && body.event;
        if (!event || typeof event.event_id !== 'string' || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(event.event_id)) {
            return http.sendProblem(res, 400, 'deals.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx: req.ov });
        }
        const r = inbox.once(CONSUMER, event.event_id, () => {
            if (!TYPES.has(event.event_type) || event.source !== 'sources') return 'ignored';
            const category = event.payload && event.payload.category;
            if (category !== 'deals') return 'ignored';
            return 'import_scheduled';
        });
        if (!r.duplicate && r.result === 'import_scheduled') importer.kick();
        res.status(200).json({ event_id: event.event_id, duplicate: Boolean(r.duplicate), outcome: r.duplicate ? null : r.result });
    });

    return router;
}

module.exports = { createInternalRoutes, CONSUMER };
