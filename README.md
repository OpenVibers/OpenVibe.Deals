# OpenVibe.Deals

> Deals submitted and voted on by the community, with source, price and freshness always shown.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.deals`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.9.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Normalised deal submissions/imports, product/offer references, votes/hotness, watches and price/shipping/condition context. Source adapters and AI may normalise/explain; Community provides durable discussion.

## Owns

- `deal_products`, `deal_product_aliases`, `deal_offers`, `deal_offer_sources`, `deal_votes`, `deal_hotness_snapshots`, `deal_watches`, `deal_price_observations`, `deal_flags`

## Does not own

- coupon codes (OpenVibe.Coupons; cross-linked, separate database)
- discussion (Community)

## Planned surfaces

- submission, merchant/product normalisation and duplicate detection, timestamped price/shipping/trust display, add/change/remove votes, deterministic hotness, keyword/product watches via Notifications, expiry handling

## Data (authority tables / families)

- see above

## Capabilities and events

- `deals.offer.submit|update|expire`, `deals.vote.set|remove`, `deals.watch.create|delete`, `deals.product.resolve`

Events: ``deals.offer.created|updated|expired``, ``deals.vote.changed``, ``deals.watch.matched``

## Depends on

- source registry
- OpenVibe.Community
- Notifications
- Search
- OpenVibe.Events

## Acceptance (must be true before "done")

- price/availability is timestamped and never silently treated as current
- duplicate offers merge without losing votes/history
- vote abuse controls are server-side
- watches never notify twice for the same observation

## Bootstrap / extraction source

No current implementation; Wave 16.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
