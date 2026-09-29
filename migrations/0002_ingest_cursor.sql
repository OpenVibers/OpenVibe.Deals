-- phase: expand
-- The ingest cursor moves from import_state ('sources.deals.after') to the chassis' own table
-- (openvibe-publishing/ingest, prefix deals → deals_ingest_cursor). Additive: the old key is read
-- once here so a deployment continues from the cursor it had, never from zero.
-- The DDL is openvibe-publishing lib/ingest.js schema('deals').

CREATE TABLE IF NOT EXISTS deals_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);

INSERT INTO deals_ingest_cursor (name, cursor, updated_at)
SELECT 'sources.deals.after', value::bigint, (EXTRACT(EPOCH FROM now()) * 1000)::bigint
FROM import_state
WHERE key = 'sources.deals.after' AND value ~ '^[0-9]+$'
ON CONFLICT (name) DO NOTHING;
