-- phase: expand
-- The shop a source says sells the deal (server/domain/source-items.js): DealNews' feed names the retailer
-- ("Amazon") while its links go to DealNews' own pages, so the store (the link's domain) is dealnews.com and the
-- seller is kept here, exactly as stated. Null when no source named one.
ALTER TABLE deal_offers ADD COLUMN IF NOT EXISTS seller text;
