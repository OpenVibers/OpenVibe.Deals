'use strict';

/**
 * Deals' own SQLite database: created on boot, idempotently. Nothing here is shared with another
 * service.
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
const Database = require('better-sqlite3');
const { createDiscussionRefs } = require('openvibe-publishing/discussion');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deal_stores (
    id          TEXT PRIMARY KEY,                       -- dst_<ULID>
    domain      TEXT NOT NULL UNIQUE,                   -- lower-case host without www.
    name        TEXT,                                   -- NULL: shown as the domain (never invented)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deal_products (
    id          TEXT PRIMARY KEY,                       -- dpr_<ULID>
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    brand       TEXT,
    category    TEXT,
    description TEXT,
    created_by  TEXT,                                   -- usr_… or svc:… (imports)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deal_product_aliases (
    id          TEXT PRIMARY KEY,                       -- dpa_<ULID>
    product_id  TEXT NOT NULL REFERENCES deal_products(id),
    kind        TEXT NOT NULL CHECK (kind IN ('name','gtin','mpn','sku','url')),
    value       TEXT NOT NULL,
    value_norm  TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('community','import','moderator')),
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (kind, value_norm)
);
CREATE INDEX IF NOT EXISTS deal_product_aliases_product ON deal_product_aliases (product_id);

CREATE TABLE IF NOT EXISTS deal_offers (
    id              TEXT PRIMARY KEY,                   -- dof_<ULID>
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    description     TEXT,
    url             TEXT NOT NULL,                      -- the offer link as normalised (tracking stripped)
    url_norm        TEXT NOT NULL,
    store_id        TEXT REFERENCES deal_stores(id),
    product_id      TEXT REFERENCES deal_products(id),
    category        TEXT,
    origin          TEXT NOT NULL CHECK (origin IN ('community','import')),
    submitted_by    TEXT,                               -- usr_… (community) / NULL (import)
    text_origin     TEXT NOT NULL DEFAULT 'human' CHECK (text_origin IN ('human','imported','ai')),
    review_state    TEXT NOT NULL DEFAULT 'not_required' CHECK (review_state IN ('not_required','pending','reviewed')),
    reviewed_by     TEXT,
    reviewed_at     INTEGER,
    ai_summary      TEXT,                               -- AI-assisted text, disclosed, noindex until reviewed
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','disabled')),
    expires_at      INTEGER,                            -- a STATED expiry (NULL: unknown, never assumed)
    expired_at      INTEGER,
    expired_reason  TEXT,
    disabled_at     INTEGER,
    disabled_reason TEXT,
    disabled_by     TEXT,
    merged_into     TEXT REFERENCES deal_offers(id),    -- duplicate of … (reversible; nothing is moved)
    merged_at       INTEGER,
    merged_by       TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    CHECK (merged_into IS NULL OR merged_into <> id)
);
CREATE INDEX IF NOT EXISTS deal_offers_url ON deal_offers (url_norm);
CREATE INDEX IF NOT EXISTS deal_offers_listing ON deal_offers (status, merged_into, created_at);
CREATE INDEX IF NOT EXISTS deal_offers_merged ON deal_offers (merged_into);
CREATE INDEX IF NOT EXISTS deal_offers_product ON deal_offers (product_id);
CREATE INDEX IF NOT EXISTS deal_offers_store ON deal_offers (store_id);

CREATE TABLE IF NOT EXISTS deal_offer_sources (
    id              TEXT PRIMARY KEY,                   -- dos_<ULID>
    offer_id        TEXT NOT NULL REFERENCES deal_offers(id),
    kind            TEXT NOT NULL CHECK (kind IN ('submission','community','sources_item')),
    ref_service     TEXT NOT NULL,                      -- 'deals' | 'sources'
    ref_type        TEXT NOT NULL,                      -- 'submission' | 'observer' | 'item'
    ref_id          TEXT NOT NULL,                      -- offer id | usr_… | itm_…
    ref_part        TEXT NOT NULL DEFAULT '',           -- which offer inside one Sources item
    ref_revision    INTEGER,                            -- the Sources item revision last imported
    source_key      TEXT,                               -- the Sources registry key (display)
    url             TEXT,
    label           TEXT,
    license_note    TEXT,
    submitted_by    TEXT,
    retrieved_at    INTEGER,                            -- Sources provenance.retrieved_at
    removed_at      INTEGER,
    removed_reason  TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE (kind, ref_service, ref_id, ref_part)
);
CREATE INDEX IF NOT EXISTS deal_offer_sources_offer ON deal_offer_sources (offer_id);

CREATE TABLE IF NOT EXISTS deal_price_observations (
    id              TEXT PRIMARY KEY,                   -- dpo_<ULID>
    offer_id        TEXT NOT NULL REFERENCES deal_offers(id),
    source_id       TEXT NOT NULL REFERENCES deal_offer_sources(id),
    observed_at     INTEGER NOT NULL,                   -- when the source saw it (not when we stored it)
    recorded_at     INTEGER NOT NULL,
    price           TEXT,                               -- decimal exactly as stated; NULL = not stated
    price_num       REAL,
    currency        TEXT,                               -- ISO 4217; NULL = not stated
    shipping        TEXT,                               -- decimal as stated (same currency); NULL = not stated
    shipping_num    REAL,
    shipping_note   TEXT,
    condition       TEXT CHECK (condition IS NULL OR condition IN ('new','used','refurbished','damaged')),
    availability    TEXT CHECK (availability IS NULL OR availability IN ('in_stock','out_of_stock','preorder','discontinued','limited','sold_out','online_only','in_store_only')),
    origin          TEXT NOT NULL CHECK (origin IN ('community','import','import_refresh')),
    observed_by     TEXT,                               -- usr_… for people; NULL for imports
    source_revision INTEGER,
    note            TEXT,
    CHECK ((price IS NULL) = (price_num IS NULL)),
    CHECK ((shipping IS NULL) = (shipping_num IS NULL))
);
CREATE INDEX IF NOT EXISTS deal_price_observations_offer ON deal_price_observations (offer_id, observed_at);

CREATE TABLE IF NOT EXISTS deal_votes (
    offer_id    TEXT NOT NULL REFERENCES deal_offers(id),
    subject     TEXT NOT NULL,                          -- usr_…
    value       INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),   -- 0 = removed (kept for history)
    weight      REAL NOT NULL,                          -- the weight when cast (new accounts count less)
    ip_hash     TEXT,
    via         TEXT NOT NULL DEFAULT 'user' CHECK (via IN ('user','service')),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (offer_id, subject)
);
CREATE INDEX IF NOT EXISTS deal_votes_subject ON deal_votes (subject, updated_at);
CREATE INDEX IF NOT EXISTS deal_votes_ip ON deal_votes (ip_hash, offer_id);

CREATE TABLE IF NOT EXISTS deal_hotness_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id      TEXT NOT NULL REFERENCES deal_offers(id),   -- the canonical (root) offer
    computed_at   INTEGER NOT NULL,
    formula       TEXT NOT NULL,
    up_count      INTEGER NOT NULL,
    down_count    INTEGER NOT NULL,
    up_weight     REAL NOT NULL,
    down_weight   REAL NOT NULL,
    score         REAL NOT NULL,
    hot           REAL NOT NULL,
    first_seen_at INTEGER NOT NULL,
    reason        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deal_hotness_offer ON deal_hotness_snapshots (offer_id, id);

CREATE TABLE IF NOT EXISTS deal_watches (
    id            TEXT PRIMARY KEY,                     -- dwt_<ULID>
    subject       TEXT NOT NULL,                        -- usr_…
    kind          TEXT NOT NULL CHECK (kind IN ('keyword','product','price_below','search')),
    query         TEXT,
    product_id    TEXT REFERENCES deal_products(id),
    max_price     TEXT,
    max_price_num REAL,
    currency      TEXT,
    notify        INTEGER NOT NULL DEFAULT 1,           -- 0: a saved search (never notifies)
    label         TEXT,
    created_at    INTEGER NOT NULL,
    deleted_at    INTEGER,
    CHECK (kind <> 'search' OR notify = 0),
    CHECK (kind <> 'price_below' OR (max_price_num IS NOT NULL AND currency IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS deal_watches_subject ON deal_watches (subject, deleted_at);
CREATE INDEX IF NOT EXISTS deal_watches_active ON deal_watches (notify, deleted_at, kind);

CREATE TABLE IF NOT EXISTS deal_flags (
    id           TEXT PRIMARY KEY,                      -- dfl_<ULID>
    offer_id     TEXT REFERENCES deal_offers(id),
    kind         TEXT NOT NULL CHECK (kind IN ('expired','price_wrong','spam','duplicate','other','vote_ring')),
    origin       TEXT NOT NULL CHECK (origin IN ('user','system')),
    reporter     TEXT,                                  -- usr_… (NULL for system flags)
    reason       TEXT,
    details      TEXT,                                  -- JSON
    dedupe_key   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    resolved_by  TEXT,
    resolved_at  INTEGER,
    resolution   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS deal_flags_open ON deal_flags (dedupe_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS deal_flags_status ON deal_flags (status, created_at);

CREATE TABLE IF NOT EXISTS watch_notifications (
    watch_id        TEXT NOT NULL REFERENCES deal_watches(id),
    observation_id  TEXT NOT NULL REFERENCES deal_price_observations(id),
    offer_id        TEXT NOT NULL,                      -- the canonical offer when it matched
    price_num       REAL,
    currency        TEXT,
    event_id        TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (watch_id, observation_id)
);
CREATE INDEX IF NOT EXISTS watch_notifications_offer ON watch_notifications (watch_id, offer_id);

CREATE TABLE IF NOT EXISTS moderation_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,                          -- merge | unmerge | expire | disable | enable | review | flag.resolve | flag.dismiss
    offer_id    TEXT,
    target_id   TEXT,
    actor       TEXT NOT NULL,                          -- usr_… | svc:…
    reason      TEXT,
    before      TEXT,                                   -- JSON
    after       TEXT,                                   -- JSON
    at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_log_offer ON moderation_log (offer_id, id);

CREATE TABLE IF NOT EXISTS rate_events (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    kind  TEXT NOT NULL,
    key   TEXT NOT NULL,
    at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_key ON rate_events (kind, key, at);

CREATE TABLE IF NOT EXISTS import_state (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subject_projections (
    subject       TEXT PRIMARY KEY,
    username      TEXT,
    display_name  TEXT,
    avatar_url    TEXT,
    first_seen_at INTEGER,                              -- when Deals first saw this person sign in
    refreshed_at  INTEGER NOT NULL
);
`;

const CHARTER_TABLES = ['deal_products', 'deal_product_aliases', 'deal_offers', 'deal_offer_sources', 'deal_votes',
    'deal_hotness_snapshots', 'deal_watches', 'deal_price_observations', 'deal_flags'];

/**
 * Open (or create) the database. opts.now — injectable clock (epoch ms) shared by everything, so
 * tests and replays are deterministic.
 */
function openStore(dbPath, { now = () => Date.now() } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return {
        db,
        now,
        discussion: createDiscussionRefs(db, { prefix: 'deal_offer', now }),
        sequencer: createIndexSequencer(db, { prefix: 'deal', now }),
        tx: (fn) => db.transaction(fn)(),
        close: () => db.close(),
    };
}

module.exports = { openStore, CHARTER_TABLES };
