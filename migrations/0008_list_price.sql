-- phase: expand
-- The list price a source states for the same offer (server/domain/source-items.js): Sources' jsonld@2
-- reads a ListPrice/StrikethroughPrice/MSRP/SRP priceSpecification and copies it exactly as the page
-- stated it. It is kept only when it is in the observation's currency and greater than its price; a
-- "list price" below the price is noise. The saving is derived (list_price_num - price_num), never
-- stored. Existing rows stay null.
ALTER TABLE deal_price_observations ADD COLUMN IF NOT EXISTS list_price text COLLATE "C";
ALTER TABLE deal_price_observations ADD COLUMN IF NOT EXISTS list_price_num double precision;

-- Why a crawled offer was selected as a deal (server/domain/source-items.js isDeal): 'list_price'
-- (the page states a list price at least 5% above the price), 'price_drop' (the latest price is at
-- its lowest / lower than the previous observation) or 'watch' (a person's price_below watch
-- matches). Null when none of the three applies; existing rows and community offers stay null.
ALTER TABLE deal_offers ADD COLUMN IF NOT EXISTS deal_reason text;
