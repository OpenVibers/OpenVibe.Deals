-- phase: expand
-- OpenVibe.Deals on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE deal_stores (
    id          text COLLATE "C" PRIMARY KEY,                       -- dst_<ULID>
    domain      text COLLATE "C" NOT NULL UNIQUE,                   -- lower-case host without www.
    name        text COLLATE "C",                                   -- NULL: shown as the domain (never invented)
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
);

CREATE TABLE deal_products (
    id          text COLLATE "C" PRIMARY KEY,                       -- dpr_<ULID>
    slug        text COLLATE "C" NOT NULL UNIQUE,
    name        text COLLATE "C" NOT NULL,
    brand       text COLLATE "C",
    category    text COLLATE "C",
    description text COLLATE "C",
    created_by  text COLLATE "C",                                   -- usr_… or svc:… (imports)
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
);

CREATE TABLE deal_product_aliases (
    id          text COLLATE "C" PRIMARY KEY,                       -- dpa_<ULID>
    product_id  text COLLATE "C" NOT NULL REFERENCES deal_products(id),
    kind        text COLLATE "C" NOT NULL CHECK (kind IN ('name','gtin','mpn','sku','url')),
    value       text COLLATE "C" NOT NULL,
    value_norm  text COLLATE "C" NOT NULL,
    source      text COLLATE "C" NOT NULL CHECK (source IN ('community','import','moderator')),
    created_by  text COLLATE "C",
    created_at  bigint NOT NULL,
    UNIQUE (kind, value_norm)
);
CREATE INDEX deal_product_aliases_product ON deal_product_aliases (product_id);

CREATE TABLE deal_offers (
    id              text COLLATE "C" PRIMARY KEY,                   -- dof_<ULID>
    seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- insertion order (the SQLite rowid tiebreak)
    slug            text COLLATE "C" NOT NULL UNIQUE,
    title           text COLLATE "C" NOT NULL,
    description     text COLLATE "C",
    url             text COLLATE "C" NOT NULL,                      -- the offer link as normalised (tracking stripped)
    url_norm        text COLLATE "C" NOT NULL,
    store_id        text COLLATE "C" REFERENCES deal_stores(id),
    product_id      text COLLATE "C" REFERENCES deal_products(id),
    category        text COLLATE "C",
    origin          text COLLATE "C" NOT NULL CHECK (origin IN ('community','import')),
    submitted_by    text COLLATE "C",                               -- usr_… (community) / NULL (import)
    text_origin     text COLLATE "C" NOT NULL DEFAULT 'human' CHECK (text_origin IN ('human','imported','ai')),
    review_state    text COLLATE "C" NOT NULL DEFAULT 'not_required' CHECK (review_state IN ('not_required','pending','reviewed')),
    reviewed_by     text COLLATE "C",
    reviewed_at     bigint,
    ai_summary      text COLLATE "C",                               -- AI-assisted text, disclosed, noindex until reviewed
    status          text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','disabled')),
    expires_at      bigint,                            -- a STATED expiry (NULL: unknown, never assumed)
    expired_at      bigint,
    expired_reason  text COLLATE "C",
    disabled_at     bigint,
    disabled_reason text COLLATE "C",
    disabled_by     text COLLATE "C",
    merged_into     text COLLATE "C" REFERENCES deal_offers(id),    -- duplicate of … (reversible; nothing is moved)
    merged_at       bigint,
    merged_by       text COLLATE "C",
    created_at      bigint NOT NULL,
    updated_at      bigint NOT NULL,
    CHECK (merged_into IS NULL OR merged_into <> id)
);
CREATE INDEX deal_offers_url ON deal_offers (url_norm);
CREATE INDEX deal_offers_listing ON deal_offers (status, merged_into, created_at);
CREATE INDEX deal_offers_merged ON deal_offers (merged_into);
CREATE INDEX deal_offers_product ON deal_offers (product_id);
CREATE INDEX deal_offers_store ON deal_offers (store_id);

CREATE TABLE deal_offer_sources (
    id              text COLLATE "C" PRIMARY KEY,                   -- dos_<ULID>
    seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- insertion order (the SQLite rowid tiebreak)
    offer_id        text COLLATE "C" NOT NULL REFERENCES deal_offers(id),
    kind            text COLLATE "C" NOT NULL CHECK (kind IN ('submission','community','sources_item')),
    ref_service     text COLLATE "C" NOT NULL,                      -- 'deals' | 'sources'
    ref_type        text COLLATE "C" NOT NULL,                      -- 'submission' | 'observer' | 'item'
    ref_id          text COLLATE "C" NOT NULL,                      -- offer id | usr_… | itm_…
    ref_part        text COLLATE "C" NOT NULL DEFAULT '',           -- which offer inside one Sources item
    ref_revision    bigint,                            -- the Sources item revision last imported
    source_key      text COLLATE "C",                               -- the Sources registry key (display)
    url             text COLLATE "C",
    label           text COLLATE "C",
    license_note    text COLLATE "C",
    submitted_by    text COLLATE "C",
    retrieved_at    bigint,                            -- Sources provenance.retrieved_at
    removed_at      bigint,
    removed_reason  text COLLATE "C",
    created_at      bigint NOT NULL,
    updated_at      bigint NOT NULL,
    UNIQUE (kind, ref_service, ref_id, ref_part)
);
CREATE INDEX deal_offer_sources_offer ON deal_offer_sources (offer_id);

CREATE TABLE deal_price_observations (
    id              text COLLATE "C" PRIMARY KEY,                   -- dpo_<ULID>
    seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- insertion order (the SQLite rowid tiebreak)
    offer_id        text COLLATE "C" NOT NULL REFERENCES deal_offers(id),
    source_id       text COLLATE "C" NOT NULL REFERENCES deal_offer_sources(id),
    observed_at     bigint NOT NULL,                   -- when the source saw it (not when we stored it)
    recorded_at     bigint NOT NULL,
    price           text COLLATE "C",                               -- decimal exactly as stated; NULL = not stated
    price_num       double precision,
    currency        text COLLATE "C",                               -- ISO 4217; NULL = not stated
    shipping        text COLLATE "C",                               -- decimal as stated (same currency); NULL = not stated
    shipping_num    double precision,
    shipping_note   text COLLATE "C",
    condition       text COLLATE "C" CHECK (condition IS NULL OR condition IN ('new','used','refurbished','damaged')),
    availability    text COLLATE "C" CHECK (availability IS NULL OR availability IN ('in_stock','out_of_stock','preorder','discontinued','limited','sold_out','online_only','in_store_only')),
    origin          text COLLATE "C" NOT NULL CHECK (origin IN ('community','import','import_refresh')),
    observed_by     text COLLATE "C",                               -- usr_… for people; NULL for imports
    source_revision bigint,
    note            text COLLATE "C",
    CHECK ((price IS NULL) = (price_num IS NULL)),
    CHECK ((shipping IS NULL) = (shipping_num IS NULL))
);
CREATE INDEX deal_price_observations_offer ON deal_price_observations (offer_id, observed_at);

CREATE TABLE deal_votes (
    offer_id    text COLLATE "C" NOT NULL REFERENCES deal_offers(id),
    seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- insertion order (the SQLite rowid tiebreak)
    subject     text COLLATE "C" NOT NULL,                          -- usr_…
    value       bigint NOT NULL CHECK (value IN (-1, 0, 1)),   -- 0 = removed (kept for history)
    weight      double precision NOT NULL,                          -- the weight when cast (new accounts count less)
    ip_hash     text COLLATE "C",
    via         text COLLATE "C" NOT NULL DEFAULT 'user' CHECK (via IN ('user','service')),
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL,
    PRIMARY KEY (offer_id, subject)
);
CREATE INDEX deal_votes_subject ON deal_votes (subject, updated_at);
CREATE INDEX deal_votes_ip ON deal_votes (ip_hash, offer_id);

CREATE TABLE deal_hotness_snapshots (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id      text COLLATE "C" NOT NULL REFERENCES deal_offers(id),   -- the canonical (root) offer
    computed_at   bigint NOT NULL,
    formula       text COLLATE "C" NOT NULL,
    up_count      bigint NOT NULL,
    down_count    bigint NOT NULL,
    up_weight     double precision NOT NULL,
    down_weight   double precision NOT NULL,
    score         double precision NOT NULL,
    hot           double precision NOT NULL,
    first_seen_at bigint NOT NULL,
    reason        text COLLATE "C" NOT NULL
);
CREATE INDEX deal_hotness_offer ON deal_hotness_snapshots (offer_id, id);

CREATE TABLE deal_watches (
    id            text COLLATE "C" PRIMARY KEY,                     -- dwt_<ULID>
    subject       text COLLATE "C" NOT NULL,                        -- usr_…
    kind          text COLLATE "C" NOT NULL CHECK (kind IN ('keyword','product','price_below','search')),
    query         text COLLATE "C",
    product_id    text COLLATE "C" REFERENCES deal_products(id),
    max_price     text COLLATE "C",
    max_price_num double precision,
    currency      text COLLATE "C",
    notify        bigint NOT NULL DEFAULT 1,           -- 0: a saved search (never notifies)
    label         text COLLATE "C",
    created_at    bigint NOT NULL,
    deleted_at    bigint,
    CHECK (kind <> 'search' OR notify = 0),
    CHECK (kind <> 'price_below' OR (max_price_num IS NOT NULL AND currency IS NOT NULL))
);
CREATE INDEX deal_watches_subject ON deal_watches (subject, deleted_at);
CREATE INDEX deal_watches_active ON deal_watches (notify, deleted_at, kind);

CREATE TABLE deal_flags (
    id           text COLLATE "C" PRIMARY KEY,                      -- dfl_<ULID>
    offer_id     text COLLATE "C" REFERENCES deal_offers(id),
    kind         text COLLATE "C" NOT NULL CHECK (kind IN ('expired','price_wrong','spam','duplicate','other','vote_ring')),
    origin       text COLLATE "C" NOT NULL CHECK (origin IN ('user','system')),
    reporter     text COLLATE "C",                                  -- usr_… (NULL for system flags)
    reason       text COLLATE "C",
    details      text COLLATE "C",                                  -- JSON
    dedupe_key   text COLLATE "C" NOT NULL,
    status       text COLLATE "C" NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    resolved_by  text COLLATE "C",
    resolved_at  bigint,
    resolution   text COLLATE "C",
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL
);
CREATE UNIQUE INDEX deal_flags_open ON deal_flags (dedupe_key) WHERE status = 'open';
CREATE INDEX deal_flags_status ON deal_flags (status, created_at);

CREATE TABLE watch_notifications (
    watch_id        text COLLATE "C" NOT NULL REFERENCES deal_watches(id),
    observation_id  text COLLATE "C" NOT NULL REFERENCES deal_price_observations(id),
    offer_id        text COLLATE "C" NOT NULL,                      -- the canonical offer when it matched
    price_num       double precision,
    currency        text COLLATE "C",
    event_id        text COLLATE "C",
    created_at      bigint NOT NULL,
    PRIMARY KEY (watch_id, observation_id)
);
CREATE INDEX watch_notifications_offer ON watch_notifications (watch_id, offer_id);

CREATE TABLE moderation_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action      text COLLATE "C" NOT NULL,                          -- merge | unmerge | expire | disable | enable | review | flag.resolve | flag.dismiss
    offer_id    text COLLATE "C",
    target_id   text COLLATE "C",
    actor       text COLLATE "C" NOT NULL,                          -- usr_… | svc:…
    reason      text COLLATE "C",
    before      text COLLATE "C",                                   -- JSON
    after       text COLLATE "C",                                   -- JSON
    at          bigint NOT NULL
);
CREATE INDEX moderation_log_offer ON moderation_log (offer_id, id);

CREATE TABLE rate_events (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind  text COLLATE "C" NOT NULL,
    key   text COLLATE "C" NOT NULL,
    at    bigint NOT NULL
);
CREATE INDEX rate_events_key ON rate_events (kind, key, at);

CREATE TABLE import_state (
    key         text COLLATE "C" PRIMARY KEY,
    value       text COLLATE "C",
    updated_at  bigint NOT NULL
);

CREATE TABLE subject_projections (
    subject       text COLLATE "C" PRIMARY KEY,
    username      text COLLATE "C",
    display_name  text COLLATE "C",
    avatar_url    text COLLATE "C",
    first_seen_at bigint,                              -- when Deals first saw this person sign in
    refreshed_at  bigint NOT NULL
);

-- openvibe-publishing/discussion (prefix deal_offer)
CREATE TABLE IF NOT EXISTS deal_offer_discussion_refs (
    entity_id   text COLLATE "C" PRIMARY KEY,
    thread_id   text NOT NULL,
    ref         jsonb NOT NULL,
    resolved_at bigint NOT NULL
);

-- openvibe-publishing/index-hooks (prefix deal)
CREATE TABLE IF NOT EXISTS deal_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);

-- openvibe-sdk/events inbox: one receipt per (consumer, event) handled
CREATE TABLE IF NOT EXISTS idempotency_receipts (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
