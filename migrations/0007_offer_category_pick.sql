-- phase: expand
-- What a deal source says about a deal besides its price (server/domain/source-items.js): DealNews' feed names each
-- deal's category ("TVs", "Cleaning Supplies"; kept in the existing deal_offers.category, exactly as stated) and
-- whether its editors picked it. staff_pick is that statement (true/false), null when no source said. The home page
-- and /c/<category> list by them.
ALTER TABLE deal_offers ADD COLUMN IF NOT EXISTS staff_pick boolean;
CREATE INDEX IF NOT EXISTS deal_offers_category ON deal_offers (category) WHERE category IS NOT NULL AND merged_into IS NULL;
