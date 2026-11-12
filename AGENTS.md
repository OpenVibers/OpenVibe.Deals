# AGENTS.md — OpenVibe.Deals

## Project overview

Deals submitted and voted on by the community, with source, price and freshness always shown:
normalised deal submissions and imports, product/store records, offers with timestamped observations,
server-authoritative votes and hotness, duplicate resolution, watches and saved searches. Discussion
is OpenVibe.Community's; imports come from OpenVibe.Sources; notifications are events for Network.
Node.js/Express, PostgreSQL (`ov_deals`), server-rendered, CommonJS, **no build step**.

- Service id `deals`, port `4840`, origin `https://openvibe.deals`, unit `openvibe-deals.service`,
  release root `/opt/openvibe.deals`.
- **The one rule: a price is an observation.** It has a source and an `observed_at`, it is shown
  "as of" that time, and an offer is never presented as current without a fresh observation. A price
  nobody stated stays "not stated" — in the page, JSON, structured data, comparison, feeds and Search.

## What it owns

The nine charter tables in [migrations/](migrations/):

| Table | What |
|---|---|
| `deal_products` | product records (name, brand, category), `/p/:slug` |
| `deal_product_aliases` | `gtin` (14 digits), `mpn`, `sku`, exact `name`, `url` → one product; an alias never silently moves |
| `deal_offers` | title, link (tracking stripped except per-source policy), store, product, status `active\|expired\|disabled`, **stated** expiry, review state, `merged_into` |
| `deal_offer_sources` | the submission, a person's observations, or a Sources item reference `{sources, item, itm_…, revision}` — the item is never copied |
| `deal_votes` | one per (offer, subject): `+1`/`-1`/`0` (kept as history), weight and IP hash |
| `deal_hotness_snapshots` | every hotness computation with all inputs (`hot@1`) |
| `deal_watches` | keyword / product / price-below watches and saved searches |
| `deal_price_observations` | the only place a price lives: price/currency, shipping, condition, availability, `observed_at`, source |
| `deal_flags` | reports by people and system flags (vote rings) |

Companion tables include `deal_stores`, `watch_notifications` (unique watch+observation),
`moderation_log`, `rate_events`, `import_state`, `subject_projections`, `deal_campaigns`,
`event_outbox`/`idempotency_receipts`, and publishing's `deal_offer_discussion_refs`/
`deal_index_revisions`. [docs/](docs/) records the deviations from the charter list.

Not owned: comment content (Community), the source items (Sources), notification delivery and
membership (Network/VIP), payments (Billing), file bytes (Media).

## Who calls it, and whom it calls

- Callers: people in the browser; the browser extension/Embed for offers; services with a Network
  service token audience `openvibe.deals` and the route's capability; OpenVibe.Sources' pull loop and
  signed event consumer.
- Depends on: **Network** (SSO client `deals`, JWKS, `identity.subject.resolve`, future notification
  consumer); **Sources** (`sources.item.read`; the seeded `dealnews-daily` is disabled until a person
  re-verifies its terms; its terms are encoded in `server/domain/source-policy.js`); **Community**
  (`community.comment.write`, optionally moderate); **Events** (outbox, and `events.subscription.manage`
  once for `scripts/subscribe.js`); **Search** (consumes `deals.index_document.*`); PostgreSQL and
  Valkey; `openvibe-publishing` (seo/JSON-LD/feeds/sitemaps/index hooks, ingest, SSR).

## Repository map

- **Entry:** [server/index.js](server/index.js) — app, worker (Sources pull, hotness, expiry),
  outbox; graceful stop.
- **App:** [server/app.js](server/app.js) — helmet/CSP, `/auth`, `/shared`, `/internal/config`,
  `/internal/events`, `/api/v1`, pages, discovery, health/ready.
- **Config/db:** [server/config.js](server/config.js), [server/db.js](server/db.js),
  [server/settings.js](server/settings.js).
- **Domain:** [server/domain/](server/domain/) — `reads.js`, `catalog.js`, `publication.js`,
  `indexing.js`, `hotness.js`, `watches.js`, `limits.js`, `access.js`, `offers.js`, `flags.js`,
  `votes.js`, `listings.js`, `source-items.js`, `source-policy.js`, `account-data.js`.
- **Clients:** [server/clients/network.js](server/clients/network.js), `community.js`, and publishing's
  `openvibe-publishing/ingest`.
- **HTTP:** [server/http/api.js](server/http/api.js), `pages.js`, `discovery.js`, `events.js`,
  `actor-limits.js`; views [server/render/views.js](server/render/views.js).
- **Auth:** [server/auth/viewer.js](server/auth/viewer.js), [server/sharing.js](server/sharing.js).
- **Worker:** [server/worker.js](server/worker.js).
- **Deploy:** [deploy/systemd/openvibe-deals.service](deploy/systemd/openvibe-deals.service),
  [deploy/nginx/openvibe.deals.conf](deploy/nginx/openvibe.deals.conf).

## Commands

```bash
npm ci
npm run dev                # NODE_ENV=development node server/index.js
npm start                  # node server/index.js, http://127.0.0.1:4840
npm test                   # test/run.js, PGlite, mock Network/Sources/Community
npm run test:pg            # same on PostgreSQL (DEALS_TEST_STORE=pg)
npm test -- freshness      # filter by file name; --strict makes a skip fail
ov test                    # the harness's sharded run of what the change reaches
```

## Database and migrations

`ov_deals` on the host's data role (ADR-035); PGlite in development/tests. Async through
`openvibe-sdk/db`; migrations `migrations/NNNN_*.sql` applied at boot; never edit an applied one, add a
new number. The price observation is the only price storage; do not add a price column to
`deal_offers`. Votes keep history (`0` means removed); merges keep `merged_into` and never delete the
loser. Outbox rows are written in the same transaction as the change.

## Auth, votes and moderation

- People sign in through Network SSO (OAuth client `deals`); a person's subject is the identity, never a
  body/query integer. Service callers need a service token audience `openvibe.deals` and the route's
  capability; `X-OV-Subject` scopes a first-party service call.
- **Votes are server-authoritative.** The server computes the weight and hotness; a client-supplied
  score is ignored. Vote rings raise a system flag for moderators.
- Watches and saved searches are per person; notifications are events (`deals.watch.matched`) — no
  consumer exists yet, so nothing is "sent" by Deals.
- Moderation actions are audited; a flagged vote ring can be removed without erasing history.

## Frontend loading model

Every page is server-rendered and **useful without JavaScript**; there is no SPA, bundler or
transpiler. `openvibe-shared` supplies the Frame, legal/SEO and `/shared/*` from the pinned
node_modules; `openvibe-publishing` supplies JSON-LD, feeds, sitemaps and SSR. Discovery is generated
from the same data. CSP and cache policy are in [server/app.js](server/app.js) and
`openvibe-shared/cache-policy`.

## Deploy

`sudo ovhost deploy deals` (git-checkout: fetch, fast-forward `/opt/openvibe.deals`, install on a
lockfile change, restart, wait for `/api/ready`). Unit `openvibe-deals.service` on
`127.0.0.1:4840`, env `/etc/openvibe/deals.env`; the release migrates `ov_deals` at boot; vhost
[deploy/nginx/openvibe.deals.conf](deploy/nginx/openvibe.deals.conf). Rollback
`sudo ovhost rollback deals --to <sha>`; migrations only add tables and columns.

## Tests

`npm test` runs each `test/*.test.js` in its own process with PGlite and in-process Network/Sources/
Community mocks. The README's acceptance table maps each guarantee to its test: price observations and
freshness/as-of rendering, unknown stays unknown, votes/hotness/abuse, duplicate merge, watches and
saved searches, Sources import and per-source link policy, deletion/export, privacy and discovery.
`ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; domain in `server/domain/`, HTTP in
  `server/http/`, no SQL in routes.
- Money is integer minor units with an ISO 4217 currency; a price is never a float and never a bare
  number without its currency and `observed_at`.
- IDs/errors/capabilities from `openvibe-contracts`; errors are problem+json with stable codes.
- Time is UTC and rendered "as of" the observation; a page may say "not stated", never invent a price.

## Pitfalls

- **Never present a price as current.** Render the observation with `observed_at` and the source, or
  say it is not stated. A cached/stale page must keep its as-of date (and Search/JSON must agree).
- **Do not copy a Sources item into Deals.** Store the typed reference `{sources, item, itm_…,
  revision}` and read through the source; a copy drifts and breaks attribution.
- **An alias never silently moves** to another product; a wrong mapping needs a correction and an audit
  trail, not an update in place.
- **Track-only links are stripped**, except where a source policy keeps a link verbatim; the policy
  lives in `server/domain/source-policy.js`, not in the renderer.
- **A merge keeps both records**: the loser gets `merged_into`, its votes/observations stay for history,
  and the API redirects/canonicalises; do not hard-delete.
- **Only one notification per (watch, observation)** — the unique row is the guard; do not "notify
  again" on a retry.
- **Votes are not client-computed** and `0` is a removal kept as history; a vote ring raises a flag.
- **No delivery pretence:** `deals.watch.matched` is emitted but no consumer exists yet; the UI must not
  say a notification was sent.
- **The charter list is nine tables; the deviations are documented** (`deal_stores`, etc.) — adding a
  tenth charter table needs the doc updated, not just the migration.

## Documentation

- [README.md](README.md) — purpose, tables, routes, API, events, prices/freshness, duplicates, votes,
  watches, imports, discovery, acceptance, security and deploy.
- [docs/](docs/) — the charter deviations and source policy notes.
- OpenVibe.Contracts holds `deals.*` shapes/capabilities; Sources, Community and publishing own their
  contracts.
