'use strict';

/**
 * OpenVibe.Deals — process entry. `node server/index.js`
 * Listens on PORT (4840) behind nginx (deploy/). Starts the outbox relay (when EVENTS_URL and the
 * client secret are set) and the worker (stated expiry, hotness, freshness re-indexing, Sources import).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startSubscriptions } = require('openvibe-sdk/account-data');

/**
 * The process stop (openvibe-sdk/service, docs/service.md's 5 s family): the worker stops taking new
 * work, the HTTP drain runs (defaults 4000/5000), then the outbox settles and the store closes; past
 * the deadline the process exits 0, as the hand-rolled 5 s timer did. Exported so a test can inject
 * `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals, extra = [] }) {
    return gracefulStop({
        name: 'Deals', server, deadlineExitCode: 0, exit, signals,
        stop: [() => ctx.worker.stop(), ...extra],
        close: [() => ctx.outbox.stop(), () => ctx.store.close()],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[Deals] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.store.db.store})`);
        console.log(`[Deals] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; worker ${config.worker.enabled ? 'on' : 'off'}; Sources import ${ctx.sources.enabled ? 'on' : 'off'}`);
    });
    server.keepAliveTimeout = 65_000;
    ctx.outbox.start();
    ctx.worker.start();
    // The two account subscriptions at OpenVibe.Events (ADR-033), created when missing; off without EVENTS_URL,
    // DEALS_EVENTS_SECRET or the client secret. The Sources one stays scripts/subscribe.js's.
    const subscriptions = startSubscriptions({
        eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: config.events.webhookSecrets[0],
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
    });

    createLifecycle({ server, ctx, extra: [() => { if (subscriptions) subscriptions.stop(); }] });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[Deals] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
