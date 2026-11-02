-- phase: expand
-- Each offer's latest hotness on the offer itself (server/domain/hotness.js snapshot() writes it with every snapshot):
-- the hot and upvoted lists read one indexed column instead of looking up every active offer's latest snapshot. On
-- 2026-11-02 the hot list's first page looked up 41,796 offers' latest among 5.8M snapshots: 748 ms, about twenty times
-- an hour. Release N-1 keeps writing snapshots only; an offer it snapshots keeps its previous hot_latest until the next
-- tick of this release (ten minutes).
ALTER TABLE deal_offers ADD COLUMN IF NOT EXISTS hot_latest double precision;
UPDATE deal_offers o SET hot_latest = h.hot
  FROM deal_hotness_snapshots h
 WHERE h.id = (SELECT MAX(id) FROM deal_hotness_snapshots WHERE offer_id = o.id);
CREATE INDEX IF NOT EXISTS deal_offers_hot_latest ON deal_offers ((COALESCE(hot_latest, 0)) DESC, created_at DESC, seq DESC)
    WHERE status = 'active' AND merged_into IS NULL;
