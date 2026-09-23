'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real query on Deals' SQLite (the nine charter tables answer)
 *   network_jwks    optional  the Network signing key has loaded; without it pages and feeds still
 *                             serve, but nobody can sign in and service tokens are refused (503)
 *   events_relay    optional  the outbox relay is configured and has no rejected rows; when it is
 *                             off, events wait in event_outbox (Search and subscribers lag)
 *   sources_import  optional  the Sources importer is configured and its last pull succeeded
 *   worker          optional  the last worker tick (expiry, hotness, re-indexing) succeeded
 *   abuse_keys      optional  DEALS_IP_HASH_SECRET is set (otherwise IP hashes reset on restart)
 *
 * Request metrics come from openvibe-shared/metrics in app.js.
 */
const { createReadiness } = require('openvibe-shared/ready');
const { CHARTER_TABLES } = require('./db');

function createDealsReadiness({ store, auth, outbox, importer, worker, limits, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'deals',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: () => {
                    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name));
                    const missing = CHARTER_TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')}` : true;
                },
            },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    if (auth.client.publicKey) return true;
                    auth.ensureKey().catch(() => {});
                    return 'Network signing key not loaded yet: sign-in and service calls are unavailable';
                },
            },
            {
                name: 'events_relay', required: false,
                check: () => {
                    const s = outbox.status();
                    if (!s.enabled) return `relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset); ${s.pending} events waiting`;
                    if (s.rejected) return `${s.rejected} events rejected by OpenVibe.Events`;
                    return { ok: true, detail: { pending: s.pending } };
                },
            },
            {
                name: 'sources_import', required: false,
                check: () => {
                    const s = importer.status();
                    if (!s.enabled) return 'import off (DEALS_IMPORT=off, or OV_OAUTH_CLIENT_SECRET / OV_SOURCES_INTERNAL_URL unset)';
                    if (s.last_error) return `last pull failed: ${s.last_error}`;
                    return { ok: true, detail: { cursor: s.cursor, last_run_at: s.last_run_at } };
                },
            },
            {
                name: 'worker', required: false,
                check: () => {
                    const s = worker.status();
                    if (!s.enabled) return 'worker off (DEALS_WORKER=off): stated expiries, hotness ticks and freshness re-indexing wait';
                    if (s.last_error) return `last tick failed: ${s.last_error}`;
                    return { ok: true, detail: { last_tick_at: s.last_tick_at } };
                },
            },
            {
                name: 'abuse_keys', required: false,
                check: () => (limits.stableIpHash ? true : 'DEALS_IP_HASH_SECRET unset: IP hashes (vote limits, ring detection) reset on every restart'),
            },
        ],
    });
}

module.exports = { createDealsReadiness };
