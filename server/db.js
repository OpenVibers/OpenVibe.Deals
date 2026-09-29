'use strict';

/**
 * Deals' own PostgreSQL database (ADR-035, roadmap WS-X2): the schema is migrations/NNNN_*.sql, applied at boot.
 * Nothing here is shared with another service.
 *
 * The nine charter tables (roadmap §15.13):
 *
 *   deal_products             product records (name, brand, category); slug for /p/:slug
 *   deal_product_aliases      name / gtin / mpn / sku / url aliases that resolve to a product
 *   deal_offers               an offer: title, link, store, product, state, stated expiry, merge pointer
 *   deal_offer_sources        where an offer came from: the submission, a person's observation,
 *                             an OpenVibe.Sources item (typed reference, never a copy of the item)
 *   deal_votes                one row per (offer, subject): +1 / -1 / 0 (removed), with the weight
 *                             and ip hash it was cast with
 *   deal_hotness_snapshots    server-computed hotness (formula hot@1) with every input it used
 *   deal_watches              keyword / product / price-below watches and saved searches
 *   deal_price_observations   every price / shipping / condition / availability observation with
 *                             its source and observed_at — the only place a price lives
 *   deal_flags                reports by people and system flags (vote rings) for moderators
 *
 * Companions (not charter tables):
 *   deal_stores               store records by domain (the plan's "store records" obligation)
 *   watch_notifications       one row per (watch, observation): the uniqueness that makes a watch
 *                             notify at most once per observation
 *   moderation_log            every merge, unmerge, expiry, disable, enable and review, with before/after
 *   rate_events               the sliding windows of the abuse controls
 *   import_state              the OpenVibe.Sources change cursor
 *   subject_projections       display cache of Network names + when Deals first saw a subject
 *   event_outbox, idempotency_receipts            openvibe-sdk outbox / inbox
 *   deal_offer_discussion_refs, deal_index_revisions   openvibe-publishing (discussion, index-hooks)
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

const CHARTER_TABLES = ['deal_products', 'deal_product_aliases', 'deal_offers', 'deal_offer_sources', 'deal_votes',
    'deal_hotness_snapshots', 'deal_watches', 'deal_price_observations', 'deal_flags'];

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite (DEALS_PGLITE_DIR overrides the directory — how a test gives a spawned server its own).
 * Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh deals)');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[Deals] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'deals', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'deals-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'deals', registry, log });
}

/**
 * Every store on a migrated database handle. opts.now — injectable clock (epoch ms) shared by everything, so tests
 * and replays are deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        discussion: createDiscussionRefs(db, { prefix: 'deal_offer', now }),
        sequencer: createIndexSequencer(db, { prefix: 'deal', now }),
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

/** openDb + createStore. */
async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

module.exports = { openDb, openStore, createStore, CHARTER_TABLES, MIGRATIONS };
