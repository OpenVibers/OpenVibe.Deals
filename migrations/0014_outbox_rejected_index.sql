-- phase: expand
-- no-transaction
-- openvibe-sdk's outbox.status().rejected reads the whole outbox for its count
-- (SELECT count(*) FROM event_outbox WHERE rejected_at IS NOT NULL): 625 ms and 79,944
-- pages on 2026-11-08, with 0 rejected rows. A partial index holds only the rejected
-- rows, so the same count is an index-only scan over an index that is usually empty.
CREATE INDEX CONCURRENTLY IF NOT EXISTS event_outbox_rejected ON event_outbox (rejected_at) WHERE rejected_at IS NOT NULL;
