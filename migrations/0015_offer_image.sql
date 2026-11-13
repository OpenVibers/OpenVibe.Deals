-- phase: expand
-- The picture of a product (the owner, 11-13: "update the listings for deals"): the one feed lists a
-- deal with its price, the price it was, the shop that sells it and the product's picture
-- (feed.item@1 1.1.0: group.items[].price / was / store, and the card's own media.thumb).
--
-- The image is the one the source stated for the listing (OpenVibe.Sources keeps the picture it
-- found in the item's fields). It is stored as stated, never fetched, and only when it is https.
--
-- Expand only: an older release never reads this column, and nothing here changes an existing row.
ALTER TABLE deal_offers ADD COLUMN image_url text;
