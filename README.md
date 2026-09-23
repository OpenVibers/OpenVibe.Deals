# OpenVibe.Deals

> Deals submitted and voted on by the community, with source, price and freshness always shown.

**Status:** alpha (roadmap Wave 18, Deals). The service runs and its tests pass. It is **not
deployed**, `openvibe.deals` still shows its placeholder from OpenVibe.Sites, and its capabilities and
service manifest are proposals that the next openvibe-contracts release has to include.
**Domain:** `openvibe.deals` · **Port:** 4840 · **Service id:** `deals`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.9; roadmap §15.13, §29, §32.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Normalised deal submissions and imports, product and store records, offers with timestamped price,
shipping, condition and availability observations, server-authoritative votes and hotness, duplicate
resolution, watches and saved searches. Discussion is OpenVibe.Community's; imports come from
OpenVibe.Sources; notifications are events for OpenVibe.Network.

The one rule everything else follows: **a price is an observation.** It has a source and an
`observed_at`, it is only ever shown "as of" that time, and an offer is never presented as current
without a fresh observation. A price nobody stated stays "not stated" — in the page, the JSON, the
structured data, the comparison, the feeds and Search.

## Owns

The nine charter tables live in Deals' own SQLite (`DEALS_DB_PATH`):

| Charter table | What it is |
|---|---|
| `deal_products` | product records (name, brand, category), `/p/:slug` |
| `deal_product_aliases` | `gtin` (normalised to 14 digits), `mpn`, `sku`, exact `name`, `url` → one product; an alias never silently moves to another product |
| `deal_offers` | an offer: title, link (tracking parameters stripped), store, product, status (`active`/`expired`/`disabled`), **stated** expiry, review state, and the merge pointer `merged_into` |
| `deal_offer_sources` | where an offer came from: the submission, a person's observations, or an OpenVibe.Sources item (typed reference `{sources, item, itm_…, revision}`; the item is never copied) |
| `deal_votes` | one row per (offer, subject): `+1` / `-1` / `0` (removed, kept as history), with the weight and IP hash it was cast with |
| `deal_hotness_snapshots` | every hotness computation with all of its inputs (formula `hot@1`) |
| `deal_watches` | keyword / product / price-below watches and saved searches |
| `deal_price_observations` | the only place a price lives: price and currency as stated, shipping, condition, availability, `observed_at`, source |
| `deal_flags` | reports by people and system flags (vote rings) for moderators |

Companion tables (not charter tables): `deal_stores` (store records by domain — the plan's "store
records" obligation; a deviation from the nine-table list, see the final section), `watch_notifications`
(the (watch, observation) uniqueness), `moderation_log`, `rate_events`, `import_state`,
`subject_projections`, the SDK's `event_outbox` / `idempotency_receipts`, and openvibe-publishing's
`deal_offer_discussion_refs` and `deal_index_revisions`.

## Does not own

- coupon codes (OpenVibe.Coupons; cross-linked later, separate database)
- discussion (OpenVibe.Community threads, referenced by id)
- source registry, fetching, robots and terms (OpenVibe.Sources)
- notifications delivery (OpenVibe.Network; Deals only emits `deals.watch.matched` and never emails)
- identity (OpenVibe.Network subjects; Deals stores `usr_…` ids only)

## What works

### Routes (server-rendered, useful without JavaScript)

| Route | What it is |
|---|---|
| `GET /`, `GET /new` | hot deals (latest `hot@1` snapshots) and newest deals; each card shows the latest price **as of** its time with a fresh/stale badge |
| `GET /d/:slug` | an offer: latest observation "as of", freshness, stated end (or "not stated"), votes and hotness with the formula, description (safe Markdown), AI/import disclosure, **price history table** (every observation, newest first, with its source), sources, merged listings, discussion. Forms: vote, report what the page says now, report a problem, mark expired (submitter), moderation. `…/:slug.json` is the same facts as data. A merged listing answers 301 to its canonical offer; a disabled one 410. |
| `GET /p/:slug` | a product: **price comparison** across its offers, each with its own latest observation and time (`.json` too) |
| `GET /s/:domain` | a store's deals |
| `GET /search?q=` | search (noindex), with "save this search" / "watch these words" |
| `GET/POST /submit` | submit a deal (signed in) |
| `GET/POST /watches` | watches and saved searches; `POST /watches/:id/delete` |
| `GET /mod` | moderators: open flags (incl. vote rings), text waiting for review, possible duplicates; `POST /mod/offers/:slug/(merge\|unmerge\|disable\|enable\|review\|expire)`, `POST /mod/flags/:id/(resolve\|dismiss)` |
| `GET /feed.xml`, `/atom.xml`, `/feed.json` | newest active deals, with "as of" times and stable ids `deals:offer:<id>` |
| `GET /robots.txt`, `/llms.txt`, `/sitemap.xml`, `/sitemaps/offers.xml`, `/sitemaps/products.xml` | discovery (below) |
| `GET /api/health`, `/api/ready`, `/release.json`, `/metrics` | operations (`/metrics` loopback only; nginx never proxies it) |
| `/auth/*` | Network SSO (the same session layer as Community/Blog) |

### API (`/api/v1`, problem+json errors)

Service tokens (audience `openvibe.deals`) are checked for **one capability per route** and act for
the person in `X-OV-Subject`; browsers or apps with a Network user JWT are judged by the domain
(signed in, submitter, moderator). Public reads need nothing.

| Route | Capability |
|---|---|
| `GET /offers?sort=hot\|new`, `GET /offers/:id`, `GET /offers/:id/hotness`, `GET /products/:slug`, `GET /stores/:domain` | public |
| `POST /offers` | `deals.offer.submit` |
| `PATCH /offers/:id`, `POST /offers/:id/observations` | `deals.offer.update` |
| `POST /offers/:id/expire` | `deals.offer.expire` |
| `PUT /offers/:id/vote` · `DELETE /offers/:id/vote` | `deals.vote.set` · `deals.vote.remove` |
| `POST /offers/:id/flags` | `deals.flag.create` |
| `POST /offers/:id/merge`, `/unmerge` | `deals.offer.merge` |
| `POST /offers/:id/disable\|enable\|review`, `GET /flags`, `POST /flags/:id/resolve` | `deals.offer.moderate` |
| `POST /products/resolve` | `deals.product.resolve` |
| `GET /watches` · `POST /watches` · `DELETE /watches/:id` | `deals.watch.read` · `deals.watch.create` · `deals.watch.delete` |

The eight charter capabilities are all there; `deals.offer.merge`, `deals.offer.moderate`,
`deals.watch.read` and `deals.flag.create` are additions (proposals in
[docs/capabilities-proposal/](docs/capabilities-proposal/), service manifest in
[docs/service-manifest-proposal.json](docs/service-manifest-proposal.json)).

### Events (SDK outbox, written in the same transaction as the change)

| Event | When | Visibility |
|---|---|---|
| `deals.offer.created` | a submission or an import created an offer | public if listable, else internal |
| `deals.offer.updated` | edit, new observation, merge/unmerge, review, disable/enable, source removed | public if listable, else internal |
| `deals.offer.expired` | submitter, moderator or stated end time | internal once expired |
| `deals.vote.changed` | a person's effective vote changed (payload: counts and hotness) | internal |
| `deals.watch.matched` | a watch matched a new observation (payload: `recipient`, offer, observation) — for Network's notification consumer, which does not exist yet | internal |
| `deals.index_document.upserted\|deleted` | the OpenVibe.Search document (`search.index-document@1`) or tombstone for offers and products | internal |

Consumed: `sources.item.created|updated|removed` at `POST /internal/events` (signed,
`DEALS_EVENTS_SECRET`, inbox-deduplicated). They carry no prices, so they only wake the importer.

## Prices and freshness

- Every price, shipping cost, condition and availability is a row in `deal_price_observations` with
  `observed_at` (when it was seen: the moment a person reported it, or the item's
  `provenance.retrieved_at` for imports) and its source. Prices are never edited in place.
- The latest observation is **fresh** while younger than `DEALS_FRESHNESS_HOURS` (48 h), **stale**
  after; no observation is **unobserved**. Pages print "as of <time>", a stale price says it may no
  longer be available, and nothing on the site calls a price "current".
- Stale → `noindex` (gate reason `stale_price`), out of `sitemaps/offers.xml`, the Offer JSON-LD
  loses its price/currency/availability, and the worker re-sends the Search document (freshness
  facet, `noindex`) — only when it actually changed.
- A price needs its currency: `10` without `USD` is refused (422), never completed. `$10` is refused
  (amounts are plain decimals). Imported values are copied as stated; a malformed one is `null`. A
  price in an imported headline is **not** parsed out of the text.
- JSON-LD: `Product` with one `Offer` per offer; `price`/`priceCurrency` only from a fresh observation
  that stated both, `availability`/`itemCondition` only when stated, `validThrough` only from a stated
  end. Unknown fields are omitted, never 0 or `InStock`.
- Expiry is only ever **stated** (by the submitter or the source's `valid_until`); the worker expires
  those. An unknown end stays "not stated" and never expires by itself (it goes stale instead).

## Duplicates and merging

- The same link (normalised: fragment and tracking/affiliate parameters removed, `www.` and scheme
  ignored) cannot be posted twice: a person gets the existing deal (409 / redirect), a second Sources
  item attaches to it as another source.
- Moderators merge listings of one deal (`/mod`, "possible duplicates" = same store and same product
  or title). **Merging moves nothing:** B gets `merged_into = A`; A's page, JSON, votes, history and
  sources read across the group; B's URL answers 301. A person who voted on both counts **once**
  (their most recent row in the group). Unmerge clears the pointer and B has exactly its own votes,
  observations and sources again. Both are in `moderation_log` with the tallies before and after, and
  Search gets a tombstone for B (and B back on unmerge). Cycles are refused.

## Votes, hotness and abuse controls

Votes are one row per (offer, subject); the server reads only `value` from a request. A vote cast
through a merged listing lands on the canonical offer.

**Hotness `hot@1`** (deterministic, computed only on the server, every snapshot stores its inputs
and `GET /api/v1/offers/:id/hotness` recomputes it):

```
score    = upWeight − downWeight                     (weighted effective votes, 4 decimals)
ageHours = max(0, (t − firstSeenAt) / 3 600 000)     (firstSeenAt: earliest created_at in the merge group)
hot      = round6( score / (ageHours + 2) ^ 1.5 )
```

Worked examples (tested): up 3, down 1, 10 h old → 2 / 12^1.5 = **0.048113**; up 2, 0 h → **0.707107**.
Snapshots are taken on every vote change, merge, unmerge and creation, and by the worker for every
active offer of the last 14 days at **one shared `t`**, so the hot list compares numbers computed at
the same moment.

**Abuse controls (server-side, SQLite windows shared by forms and API):**

| Control | Default |
|---|---|
| votes per person per hour | 60 (`DEALS_VOTE_LIMIT_SUBJECT_HOUR`) |
| votes per IP hash per hour (HMAC under `DEALS_IP_HASH_SECRET`; raw IPs are never stored) | 120 |
| vote changes per person per offer per hour | 6 |
| no votes on a deal you posted (any listing in the group) | — |
| new-account weight | 0.25 until there is evidence the account is ≥ 7 days old: the time in its `usr_` ULID or when Deals first saw it sign in, whichever is older (subjects were minted when identity moved to Network, so the ULID time is an upper bound on account age) |
| vote-ring flag `shared_ip` | ≥ 3 distinct voters on one offer from one IP hash |
| vote-ring flag `covote` | two voters who voted the same way on ≥ 5 offers within 10 minutes of each other each time |
| submissions / observations / reports | 20 per day / 30 per hour / 30 per day per person |

Ring flags are for moderators only (`/mod`, `GET /api/v1/flags`); they never remove votes on their
own. One open flag per ring (or per person and offer for reports).

## Watches and saved searches

`keyword` (every word must appear), `product`, `price_below` (product or words, a price **stated in
the watch's currency** below the limit — an unknown price never matches) and `search` (a saved
search that never notifies). Matching runs in the observation's transaction; `watch_notifications`
has primary key `(watch_id, observation_id)`, so an observation can produce at most one
`deals.watch.matched` per watch — replays, retries and re-runs cannot repeat it. On top: a keyword
or product watch notifies once per offer, a price watch again only for a lower price; stale
observations, inactive offers and a person's own reports do not notify.

## Imports from OpenVibe.Sources

The importer pulls `GET /api/v1/items?category=deals&after=<cursor>&include_removed=1` (cursor in
`import_state`, one savepoint per item so one bad item cannot stall it) every
`DEALS_IMPORT_INTERVAL_MS`, and early when a `sources.item.*` event arrives. `offer` items → one
offer; `product` items → a product and one offer per stated offer; `article` items (RSS) → an offer
with no price. A new revision or a newer retrieval is a new observation; a replay changes nothing.
Offers whose latest imported observation is getting old are re-confirmed from `GET /api/v1/items/:id`
when Sources fetched them again. A removed item (takedown, licence) removes its source; an imported
offer with no source left is disabled. Imported text is `review_state = pending` → `noindex` until a
moderator records a review (a `usr_` subject; a service cannot review).

## Discoverability (roadmap §32)

- SSR HTML with canonical, Open Graph, JSON-LD (`Product`/`Offer`, `BreadcrumbList`, `WebSite` with
  `SearchAction`), `meta robots` + `X-Robots-Tag` from the openvibe-publishing gate. Gate reasons:
  `takedown` (disabled: hidden), `expired`, `stale_price`, `noindex_requested` with detail
  `review_pending` (imported/AI text). Empty lists and search/forms are `noindex`.
- Sitemaps list only offers and products the gate calls indexable **now**; `lastmod` is the latest
  observation or edit, never "now". `robots.txt` states the automated-consumer policy, `llms.txt`
  explains observations and the JSON twins.
- AI-assisted text (`X-OV-Origin: ai`, e.g. OpenVibe.AI's `deals.enrich_deal`) is stored separately
  (`ai_summary`), disclosed on the page and `noindex` until a person reviews it.

### Caching

Only pages shown to anonymous visitors are `public, max-age=60` (freshness labels are computed at
render time, so the cache stays short); signed-in views, forms, API responses, errors and 410s are
`private, no-store`. Pages vary on `Cookie` and `Authorization`.

## Depends on

- **Packages** (pinned release tarballs): `openvibe-publishing` v0.2.0 (seo gate, JSON-LD, feeds,
  sitemaps, index-hooks, discussion, ssr), `openvibe-contracts` v0.19.0, `openvibe-shared` v1.3.0
  (chrome, app icon, footer, legal, release, metrics, ready), `openvibe-sdk` v0.2.2 (outbox, inbox,
  webhook signatures, service tokens).
- **OpenVibe.Network:** SSO (OAuth client `deals` — not yet in Network's seeded client list), JWKS,
  `identity.subject.resolve`.
- **OpenVibe.Sources:** `sources.item.read`; a `deals`-category source must be registered and enabled
  there (the seeded `dealnews-daily` is disabled until a person re-verifies its terms).
- **OpenVibe.Community:** `community.comment.write`, optionally `community.comment.moderate`.
- **OpenVibe.Events:** `events.event.publish`; `events.subscription.manage` once, for
  `scripts/subscribe.js`.
- **OpenVibe.Search:** consumes `deals.index_document.*`; `deals` is already in Search's default
  `SEARCH_EVENT_OWNERS`.
- **OpenVibe.Network notifications:** a future consumer of `deals.watch.matched`.

### Grants the Network must hold

Each grant is `[client, capability, audience]`:

- `[deals, identity.subject.resolve, openvibe.network]`
- `[deals, events.event.publish, openvibe.events]`
- `[deals, events.subscription.manage, openvibe.events]` (only to run `scripts/subscribe.js`)
- `[deals, sources.item.read, openvibe.sources]`
- `[deals, community.comment.write, openvibe.community]`
- `[deals, community.comment.moderate, openvibe.community]` (optional: hides a disabled deal's thread)
- For OpenVibe.AI enrichment (later): `[ai, deals.offer.update, openvibe.deals]`
- For a future Network notification consumer that reads watches: `[network, deals.watch.read, openvibe.deals]`

## Acceptance (automated: `npm test`)

| Charter / roadmap requirement | Test |
|---|---|
| Price and availability are timestamped and never silently current: "as of" on every price, stale after the window (label, `noindex`, no JSON-LD price, out of sitemaps, Search re-indexed once), imports dated by retrieval, no "current" anywhere, no future observations | `test/freshness.test.js` |
| Never fabricate missing prices: unknown stays unknown in page, JSON, JSON-LD (no price, no 0), comparison order, feeds and Search; no assumed currency; headline prices not parsed; malformed values null | `test/missing-price.test.js` |
| Duplicate offers merge without losing votes or history: a voter on both counts once, all observations and sources kept, 301, tombstone, audit with tallies, unmerge restores exactly, no cycles, moderators only | `test/merge.test.js` |
| Hotness is server-authoritative and deterministic: worked examples, order independence, recomputation of every snapshot, request fields ignored, new-account weight, shared-`t` ticks | `test/hotness.test.js` |
| Watches never notify twice for one observation: re-run matcher, replayed import, primary-key guarantee, unknown/other-currency prices, own reports, stale imports, deleted watches, saved searches | `test/watches.test.js` |
| Vote abuse controls are server-side: per person / IP hash / offer limits (form and API), own-offer refusal, no raw IPs, `shared_ip` and `covote` ring flags for moderators only, CSRF | `test/abuse.test.js` |
| Sources imports: mapping as stated, review gate, idempotent replays, revisions, dedupe by link, re-confirmation, removal → disabled + tombstone, signed event wake-up with inbox, honest failure | `test/import.test.js` |
| Useful without JavaScript: no seed deals, forms with tokens, votes, Community comments (referenced), product/store/search pages, expiry (submitter and stated), moderation (410, feeds, sitemaps, Search, thread hidden), feeds, robots, llms, sitemaps, operations endpoints | `test/pages.test.js` |
| API: one capability per route, `X-OV-Subject`, problem+json with request ids, AI text held for a person's review, votes, product resolve, merge grants, every event and Search document valid against openvibe-contracts | `test/api.test.js` |
| The contract proposals are valid against the released schemas and match the code | `test/contracts.test.js` |

## Launch rule

This repository alone doesn't make the product live. `openvibe.deals` keeps its placeholder on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of plan §12.12
exists. Status against each point:

1. **Runtime, health, readiness, observability:** done (`/api/health`, `/api/ready` with six checks, `/metrics`, `/release.json`).
2. **Canonical identity and auth:** done in code; the Network still needs the `deals` OAuth client and the grants above.
3. **SSR public routes useful without JS:** done.
4. **Persistence and end-to-end workflows:** done; imports need a registered, enabled deals source in Sources.
5. **Capability and event registration against OpenVibe.Contracts:** proposals are in `docs/`, waiting on the release.
6. **Migration and seed strategy, threat review, sitemap/robots/feed behaviour:** done. There is nothing to migrate and no seed (below); the threat review is below.
7. **Acceptance tests:** done.

**The launch release does all of these in one release:** removes `openvibe.deals` from
`OpenVibe.Sites/sites.json`, switches routing (nginx vhost, DNS, TLS), flips the Network hub entry
(`server/chrome/sites.js`, `status: 'soon'`) and registers maturity in the ecosystem registry. A
placeholder never counts as an implemented service, and this README doesn't call the service live.

## Seed

**None.** Deals starts empty: no example deals, no invented prices. Content arrives from members and
from sources registered in OpenVibe.Sources.

## Security and threat review

- **Identity:** only verified Network JWTs (offline RS256 against JWKS) and service tokens for audience
  `openvibe.deals`; a bad service token is refused, never downgraded to anonymous; identity never
  comes from a body or query; `X-OV-*` headers are ignored for browsers; pages ignore service tokens.
- **CSRF:** SameSite=Lax session cookie plus an HMAC form token (`DEALS_FORM_SECRET`) on every form.
- **XSS:** every value goes through openvibe-publishing/ssr auto-escaping; descriptions use its safe
  Markdown subset (no raw HTML, no images); only `http(s)` links are rendered; user links get
  `rel="nofollow noopener ugc"`; CSP from helmet.
- **Manipulation:** votes, weights and hotness are computed only on the server from stored rows; the
  abuse controls above; merges and moderation are audited; flags never act on their own.
- **Privacy:** raw IPs are never stored (HMAC, truncated); `deals.vote.changed` and
  `deals.watch.matched` are internal; watches are visible only to their owner.
- **SSRF:** Deals never fetches user-supplied URLs. It calls only its configured Network, Community,
  Sources and Events hosts. Links are stored and rendered, never followed.
- **Honesty:** no fabricated prices, currencies, availability, expiry or ratings in pages, JSON,
  JSON-LD, feeds or Search; stale and unknown are labelled; AI and imported text need a person's review
  before indexing.
- **Abuse:** Express rate limits on `/auth`, forms and `/api/v1`, mirrored in the nginx reference;
  `/internal/` and `/metrics` are host-local only.
- **Known gaps:**
  - Watch notifications are events only; nobody delivers them to people until Network's consumer exists.
  - The Community thread visibility sync on disable is best effort (needs `community.comment.moderate`).
  - Products are never merged automatically or through the UI yet; alias conflicts are reported by
    `products/resolve` and left to a person.
  - The covote detector compares votes on the same listing only (not across a merge group) and runs
    on each vote; it is a signal for moderators, not a proof.
  - Deals has no AI enrichment client of its own; it accepts `ai_summary` from OpenVibe.AI when granted.
  - Currency conversion is deliberately absent: the comparison groups by currency, it never converts.

## Development

```bash
fnm exec --using=22.22.1 npm install
fnm exec --using=22.22.1 npm test          # temp databases and in-process mocks, no network
fnm exec --using=22.22.1 npm run dev       # http://localhost:4840 (set OV_OAUTH_CLIENT_SECRET to sign in)
```

## Deploy (for the lead)

1. **Code and config:** put the code at `/opt/openvibe.deals` and run `npm ci --omit=dev` on Node 22
   (on the host, npm 9 may rewrite `package-lock.json`; restore it with `git checkout -- package-lock.json`).
   Create `/etc/openvibe/deals.env` (0600) from `.env.example`; set `OV_OAUTH_CLIENT_SECRET`,
   `DEALS_FORM_SECRET`, `DEALS_IP_HASH_SECRET`, `DEALS_EVENTS_SECRET` (`openssl rand -hex 32` each),
   `EVENTS_URL=http://127.0.0.1:4300`, `BASE_URL=https://openvibe.deals`, and `DEALS_MODERATORS` if
   anyone besides Network admins/global mods moderates.
2. **Network:** add `{ client_id: 'deals', name: 'OpenVibe.Deals', redirect_uris: ['https://openvibe.deals/auth/callback'] }`
   to the seeded clients, create the principal with `server/setup/service-principal.js` (secret into
   `deals.env`), and add the grants listed above.
3. **Sources:** register and enable a `deals`-category source once a person has checked its terms.
4. **Search:** nothing to do unless `SEARCH_EVENT_OWNERS` is overridden there (the default includes `deals`).
5. **systemd:** install `deploy/systemd/openvibe-deals.service` (port 4840, `StateDirectory=openvibe-deals`).
6. **nginx:** install `deploy/nginx/openvibe.deals.conf`. `/metrics` and `/internal/` are never proxied.
7. **Events subscription:** `node scripts/subscribe.js` (optional — the importer polls anyway).
8. **Contracts:** release the capability and manifest proposals in openvibe-contracts. Then CI's
   contracts check can drop `continue-on-error`.
9. **Launch:** in the same release, remove `openvibe.deals` from OpenVibe.Sites and flip the Network
   hub entry (see the launch rule above).

## Deviations from the charter

- `deal_stores` is a tenth `deal_` table (store records by domain), next to the nine charter tables.
- Capabilities beyond the charter's eight: `deals.offer.merge`, `deals.offer.moderate`,
  `deals.watch.read`, `deals.flag.create`.
- Saved searches are `deal_watches` rows of kind `search` with `notify = 0`, not a separate table.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
