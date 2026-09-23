'use strict';

/**
 * What an offer or product page says, and whether a crawler may index it.
 *
 * Freshness: every price is an observation with an observed_at. The latest observation of an
 * offer's group is `fresh` while it is younger than DEALS_FRESHNESS_HOURS, `stale` after, and an
 * offer with no observation is `unobserved`. Pages always print "as of <time>"; a stale price is
 * labelled stale and never presented as the price now.
 *
 * Indexability (openvibe-publishing/seo gate, policy priceMaxAgeMs = the freshness window):
 *   disabled by moderators          takedown        hidden (410 page, out of feeds, sitemaps, Search)
 *   expired (stated or marked)      expired         noindex
 *   latest observation stale/none   stale_price     noindex
 *   imported or AI text not reviewed by a person   noindex_requested (detail: review_pending)
 *
 * Structured data: Offer JSON-LD is built only from the latest observation's stated fields, and
 * only while that observation is fresh. A missing price is omitted (never 0), a missing currency
 * drops the price, a missing availability is omitted (never an assumed InStock).
 */
const seo = require('openvibe-publishing/seo');
const { iso } = require('./util');

function createPublication({ config, store, reads, catalog }) {
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const offerPath = (o) => `/d/${encodeURIComponent(o.slug)}`;
    const productPath = (p) => `/p/${encodeURIComponent(p.slug)}`;
    const storePath = (s) => `/s/${encodeURIComponent(s.domain)}`;

    function freshness(obs, now = store.now()) {
        if (!obs) return { state: 'unobserved', observed_at: null, age_ms: null, max_age_ms: config.freshnessMs };
        const age = Math.max(0, now - obs.observed_at);
        return { state: age <= config.freshnessMs ? 'fresh' : 'stale', observed_at: iso(obs.observed_at), age_ms: age, max_age_ms: config.freshnessMs };
    }

    function decideOffer(root, latest, now = store.now()) {
        const facts = {
            state: 'published',
            visibility: 'public',
            canonicalUrl: abs(offerPath(root)),
            wordCount: 0,
            price: { observedAt: latest ? latest.observed_at : null },
            takedown: root.status === 'disabled',
            noindex: root.review_state === 'pending',
        };
        const expiry = root.status === 'expired' ? (root.expired_at || now) : root.expires_at;
        if (expiry != null) facts.expiresAt = expiry;
        const d = seo.evaluate(facts, { policy: { minWords: 0, priceMaxAgeMs: config.freshnessMs }, now });
        for (const r of d.reasons) if (r.code === 'noindex_requested') r.detail = `review_pending: ${root.text_origin} text not yet reviewed by a person`;
        return d;
    }

    /** A product page is indexable while at least one of its active offers has a fresh observation. */
    function decideProduct(product, freshestObservedAt, now = store.now()) {
        return seo.evaluate({
            state: 'published', visibility: 'public', canonicalUrl: abs(productPath(product)), wordCount: 0,
            price: { observedAt: freshestObservedAt },
        }, { policy: { minWords: 0, priceMaxAgeMs: config.freshnessMs }, now });
    }

    /** Everything a page, the JSON twin, an event or the index needs about one canonical offer. */
    function offerView(offer, now = store.now()) {
        const root = reads.root(offer);
        const ids = reads.groupIds(root.id);
        const latest = reads.latestObservation(ids);
        const tally = reads.tally(ids);
        const snap = reads.lastSnapshot(root.id);
        return {
            root,
            ids,
            store: catalog.store(root.store_id),
            product: catalog.product(root.product_id),
            observations: reads.observations(ids),
            latest,
            freshness: freshness(latest, now),
            sources: reads.sources(ids),
            members: ids.filter((id) => id !== root.id).map((id) => reads.get(id)),
            tally,
            hotness: snap,
            decision: decideOffer(root, latest, now),
            now,
        };
    }

    function observationDto(o) {
        return {
            id: o.id, observed_at: iso(o.observed_at), recorded_at: iso(o.recorded_at),
            price: o.price, currency: o.currency, shipping: o.shipping, shipping_note: o.shipping_note,
            condition: o.condition, availability: o.availability, origin: o.origin,
            observed_by: o.observed_by || null, listing: o.offer_id,
            source: { id: o.source_id, kind: o.source_kind, ref: o.ref_service === 'sources' ? { service: 'sources', type: 'item', id: o.ref_id, revision: o.source_revision } : null, key: o.source_key || null, url: o.source_url || null },
        };
    }

    /** The JSON representation (API and /d/:slug.json): the same facts as the page. */
    function offerDto(v) {
        const r = v.root;
        return {
            id: r.id, slug: r.slug, url: abs(offerPath(r)), title: r.title, description: r.description,
            link: r.url, status: r.status, category: r.category, origin: r.origin, submitted_by: r.submitted_by,
            text_origin: r.text_origin, review_state: r.review_state, ai_summary: r.ai_summary,
            expires_at: iso(r.expires_at), expired_at: iso(r.expired_at), expired_reason: r.expired_reason,
            disabled_reason: r.status === 'disabled' ? r.disabled_reason : null,
            created_at: iso(r.created_at), updated_at: iso(r.updated_at),
            store: v.store ? { id: v.store.id, domain: v.store.domain, name: v.store.name, url: abs(storePath(v.store)) } : null,
            product: v.product ? { id: v.product.id, slug: v.product.slug, name: v.product.name, url: abs(productPath(v.product)) } : null,
            // "latest", never "current": whether it still holds is what freshness says.
            latest_observation: v.latest ? observationDto(v.latest) : null,
            freshness: v.freshness,
            observations: v.observations.map(observationDto),
            sources: v.sources.map((s) => ({
                id: s.id, kind: s.kind, listing: s.offer_id,
                ref: s.ref_service === 'sources' ? { service: 'sources', type: 'item', id: s.ref_id, revision: s.ref_revision } : null,
                key: s.source_key, url: s.url, label: s.label, license_note: s.license_note,
                retrieved_at: iso(s.retrieved_at), removed_at: iso(s.removed_at), removed_reason: s.removed_reason,
            })),
            merged_from: v.members.map((m) => ({ id: m.id, slug: m.slug, title: m.title, merged_at: iso(m.merged_at) })),
            votes: { up: v.tally.up, down: v.tally.down, up_weight: v.tally.upWeight, down_weight: v.tally.downWeight },
            hotness: v.hotness ? { formula: v.hotness.formula, hot: v.hotness.hot, score: v.hotness.score, computed_at: iso(v.hotness.computed_at) } : null,
            indexability: { indexable: v.decision.indexable, robots: v.decision.robots, reasons: v.decision.reasons },
        };
    }

    /** Offer JSON-LD fields from a fresh observation only; unknown stays out. */
    function offerLd(v) {
        const o = v.latest;
        const fresh = v.freshness.state === 'fresh' && v.root.status === 'active';
        const ld = {
            '@type': 'Offer',
            url: abs(offerPath(v.root)),
            seller: v.store ? { '@type': 'Organization', name: v.store.name || v.store.domain } : undefined,
        };
        if (fresh && o) {
            if (o.price != null && o.currency) { ld.price = o.price; ld.priceCurrency = o.currency; }
            if (o.availability) ld.availability = `https://schema.org/${{ in_stock: 'InStock', out_of_stock: 'OutOfStock', preorder: 'PreOrder', discontinued: 'Discontinued', limited: 'LimitedAvailability', sold_out: 'SoldOut', online_only: 'OnlineOnly', in_store_only: 'InStoreOnly' }[o.availability]}`;
            if (o.condition) ld.itemCondition = `https://schema.org/${{ new: 'NewCondition', used: 'UsedCondition', refurbished: 'RefurbishedCondition', damaged: 'DamagedCondition' }[o.condition]}`;
            if (o.shipping != null && o.currency) ld.shippingDetails = { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: o.shipping, currency: o.currency } };
        }
        if (v.root.expires_at && v.root.status === 'active') ld.validThrough = iso(v.root.expires_at);
        return ld;
    }

    function offerJsonLd(v) {
        const name = v.product ? v.product.name : v.root.title;
        return seo.compact({
            '@context': 'https://schema.org', '@type': 'Product', name, url: abs(offerPath(v.root)),
            description: v.root.description || undefined,
            brand: v.product && v.product.brand ? { '@type': 'Brand', name: v.product.brand } : undefined,
            offers: [offerLd(v)],
        });
    }

    const productOfferIds = store.db.prepare(`SELECT id FROM deal_offers WHERE product_id = ? AND merged_into IS NULL AND status <> 'disabled' ORDER BY created_at`);

    /**
     * A product's price comparison: every canonical, non-disabled offer with its own latest
     * observation and freshness. Order: fresh offers with a stated price first (by currency, then
     * price ascending), then fresh offers without a price, then stale / unobserved / expired ones —
     * an old or unknown price never sorts as if it were the price now, and unknown never sorts as 0.
     */
    function productView(product, now = store.now()) {
        const rows = productOfferIds.all(product.id).map((r) => offerView(reads.get(r.id), now));
        const rank = (v) => (v.root.status !== 'active' ? 4 : v.freshness.state !== 'fresh' ? 3 : (v.latest && v.latest.price != null && v.latest.currency) ? 1 : 2);
        rows.sort((a, b) => rank(a) - rank(b)
            || (rank(a) === 1 ? (a.latest.currency < b.latest.currency ? -1 : a.latest.currency > b.latest.currency ? 1 : a.latest.price_num - b.latest.price_num) : 0)
            || b.root.created_at - a.root.created_at);
        const fresh = rows.filter((v) => v.root.status === 'active' && v.freshness.state === 'fresh').map((v) => v.latest.observed_at);
        const freshest = fresh.length ? Math.max(...fresh) : null;
        return { product, offers: rows, aliases: catalog.aliases(product.id), decision: decideProduct(product, freshest, now), freshestObservedAt: freshest };
    }

    function productJsonLd(pv) {
        return seo.compact({
            '@context': 'https://schema.org', '@type': 'Product', name: pv.product.name, url: abs(productPath(pv.product)),
            description: pv.product.description || undefined,
            brand: pv.product.brand ? { '@type': 'Brand', name: pv.product.brand } : undefined,
            gtin: (pv.aliases.find((a) => a.kind === 'gtin') || {}).value,
            mpn: (pv.aliases.find((a) => a.kind === 'mpn') || {}).value,
            offers: pv.offers.filter((v) => v.root.status === 'active').map(offerLd),
        });
    }

    return { abs, offerPath, productPath, storePath, freshness, decideOffer, decideProduct, offerView, offerDto, observationDto, offerLd, offerJsonLd, productView, productJsonLd };
}

module.exports = { createPublication };
