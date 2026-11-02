-- phase: expand
-- The hotness prune finds old tick snapshots by this index (server/domain/hotness.js tick()). On 2026-11-02 a tick
-- re-snapshotted 39,547 offers every ten minutes, so a day of ticks was 4.2M rows (1.5 GB), and the prune's
-- NOT IN (SELECT MAX(id) … GROUP BY offer_id) took 1.2 s each run. Ticks are now kept two hours and the prune asks
-- the (offer_id, id) index whether a newer snapshot exists; this index hands it the old ticks in order.
CREATE INDEX IF NOT EXISTS deal_hotness_old_ticks ON deal_hotness_snapshots (computed_at) WHERE reason = 'tick';
