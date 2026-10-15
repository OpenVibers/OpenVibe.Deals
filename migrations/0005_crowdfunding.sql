-- phase: expand
-- Crowdfunding discovery (server/domain/campaigns.js): the campaigns OpenVibe.Sources fetched in its `crowdfunding`
-- category (Open Collective's collectives, projects and funds), kept as Sources stated them. Amounts are observations:
-- observed_at is when Sources fetched them. A removed item is deleted here.
CREATE TABLE deal_campaigns (
    item_id       text COLLATE "C" PRIMARY KEY,
    source_key    text COLLATE "C" NOT NULL,
    platform      text NOT NULL,
    url           text NOT NULL,
    name          text NOT NULL,
    summary       text,
    kind          text,
    tag           text,
    currency      text,
    raised_cents  bigint,
    budget_cents  bigint,
    backers       integer,
    website       text,
    started_at    text,
    observed_at   bigint NOT NULL,
    first_seen_at bigint NOT NULL,
    updated_at    bigint NOT NULL
);
CREATE INDEX deal_campaigns_backers ON deal_campaigns (backers DESC NULLS LAST, item_id);
CREATE INDEX deal_campaigns_started ON deal_campaigns (started_at DESC NULLS LAST, item_id);
CREATE INDEX deal_campaigns_raised ON deal_campaigns (raised_cents DESC NULLS LAST, item_id);
