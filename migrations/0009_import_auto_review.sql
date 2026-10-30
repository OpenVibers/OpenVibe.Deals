-- phase: expand
-- The automatic review of imported offers (server/domain/import-review.js): an offer imported from a
-- configured feed source is checked when it is imported, and the existing imports are checked by
-- scripts/backfill-import-review.js. A pass sets review_state = 'auto_approved' (published and
-- indexable, reviewed_by = 'system:import-checks'); a fail stays 'pending' and the failed check's
-- name is kept in review_failed_check. Offers people submit by hand are not touched: their review
-- flow is unchanged.
ALTER TABLE deal_offers DROP CONSTRAINT IF EXISTS deal_offers_review_state_check;
ALTER TABLE deal_offers ADD CONSTRAINT deal_offers_review_state_check
    CHECK (review_state IN ('not_required','pending','reviewed','auto_approved'));
ALTER TABLE deal_offers ADD COLUMN IF NOT EXISTS review_failed_check text;
CREATE INDEX IF NOT EXISTS deal_offers_pending_import ON deal_offers (id) WHERE review_state = 'pending' AND origin = 'import';
