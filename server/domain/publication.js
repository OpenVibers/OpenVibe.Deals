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
const { iso, pictureUrl } = require('./values');
const { attributionOf, hidesFromExtension } = require('./source-policy');
const { priceTrend, listPriceFields } = require('./price-trend');

function createPublication({ config, store, reads, catalog }) {
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const offerPath = (o) => `/d/${encodeURIComponent(o.slug)}`;
    const productPath = (p) => `/p/${encodeURIComponent(p.slug)}`;
    const storePath = (s) => `/s/${encodeURIComponent(s.domain)}`;
    const sellerPath = (name) => `/at/${require('./listings').sellerSlug(name)}`;
    const categoryPath = (name) => `/c/${require('./listings').sellerSlug(name)}`;

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
    async function offerView(offer, now = store.now(), pre = null) {
        const root = pre ? pre.root : await reads.root(offer);
        const ids = pre ? pre.ids : await reads.groupIds(root.id);
        const latest = pre ? pre.latest : await reads.latestObservation(ids);
        const tally = await reads.tally(ids);
        const snap = pre ? pre.snap : await reads.lastSnapshot(root.id);
        const sources = await reads.sources(ids);
        const observations = await reads.observations(ids);
        return {
            root,
            ids,
            store: await catalog.store(root.store_id),
            product: await catalog.product(root.product_id),
            observations,
            trend: priceTrend(observations),
            latest,
            freshness: freshness(latest, now),
            sources,
            // A source policy may require attribution (shown on cards, the page, JSON and feeds) and
            // may forbid the offer's content in a browser extension (DealNews' feed terms).
            attribution: attributionOf(sources),
            extensionExcluded: hidesFromExtension(sources),
            members: await Promise.all(ids.filter((id) => id !== root.id).map(async (id) => await reads.get(id))),
            tally,
            hotness: snap,
            decision: decideOffer(root, latest, now),
            now,
        };
    }

    /**
     * The page's shared reads: every root, group, latest observation and (for offer views) snapshot, once. A page of 25
     * offers used to repeat each of those per offer: 2.1 M snapshot lookups and 3.5 M latest-observation lookups a day
     * on 2026-11-08 (324 s and 251 s of DB time, pg_stat_statements).
     */
    async function prefetch(offers, { snapshots = true } = {}) {
        const roots = await Promise.all(offers.map(async (o) => (o.merged_into ? await reads.root(o) : o)));
        // A group read per offer, at most eight at once: the pool has a handful of connections for everyone.
        const groups = new Array(roots.length);
        for (let i = 0; i < roots.length; i += 8) {
            await Promise.all(roots.slice(i, i + 8).map(async (r, j) => { groups[i + j] = await reads.groupIds(r.id); }));
        }
        const [latest, snaps] = await Promise.all([
            reads.latestObservations(groups),
            snapshots ? reads.lastSnapshots(roots.map((r) => r.id)) : Promise.resolve(new Map()),
        ]);
        return { roots, groups, latest, snaps };
    }

    /** A whole page of offer views from one read per fact, each view with its own group's latest and its root's snapshot. */
    async function offerViews(offers, now = store.now()) {
        if (!offers.length) return [];
        const pre = await prefetch(offers);
        return await Promise.all(offers.map((o, i) => offerView(o, now, {
            root: pre.roots[i], ids: pre.groups[i], latest: pre.latest[i], snap: pre.snaps.get(pre.roots[i].id) || null,
        })));
    }

    /**
     * The little a card needs (the home page's sections): the group's latest observation, its freshness, the store and
     * the attribution a source requires. Four reads instead of offerView's ten, so a page of 40 cards stays quick.
     */
    async function cardView(offer, now = store.now(), pre = null) {
        const root = pre ? pre.root : (offer.merged_into ? await reads.root(offer) : offer);
        const ids = pre ? pre.ids : await reads.groupIds(root.id);
        const latest = pre ? pre.latest : await reads.latestObservation(ids);
        return { root, ids, store: await catalog.store(root.store_id), latest, freshness: freshness(latest, now), attribution: attributionOf(await reads.sources(ids)), now };
    }

    /** A whole home page of cards from one read per fact (no snapshots: a card has no hotness). */
    async function cardViews(offers, now = store.now()) {
        if (!offers.length) return [];
        const pre = await prefetch(offers, { snapshots: false });
        return await Promise.all(offers.map((o, i) => cardView(o, now, { root: pre.roots[i], ids: pre.groups[i], latest: pre.latest[i] })));
    }

    function observationDto(o) {
        return {
            id: o.id, observed_at: iso(o.observed_at), recorded_at: iso(o.recorded_at),
            price: o.price, currency: o.currency, ...listPriceFields(o), shipping: o.shipping, shipping_note: o.shipping_note,
            condition: o.condition, availability: o.availability, origin: o.origin,
            observed_by: o.observed_by || null, listing: o.offer_id,
            source: { id: o.source_id, kind: o.source_kind, ref: o.ref_service === 'sources' ? { service: 'sources', type: 'item', id: o.ref_id, revision: o.source_revision } : null, key: o.source_key || null, url: o.source_url || null },
        };
    }

    /**
     * The price over time as JSON: the stated prices, their times, and the change since the first.
     * The latest observation also carries its list price and the saving (all four fields null when
     * the observation states no usable list price).
     */
    function trendDto(t) {
        if (!t) return null;
        const at = (p) => ({ price: p.price, observed_at: iso(p.at) });
        return {
            currency: t.currency, observations: t.count, first: at(t.first),
            latest: { ...at(t.latest), ...listPriceFields(t.latest) },
            lowest: at(t.lowest), highest: at(t.highest), change: t.change, at_lowest: t.atLowest,
        };
    }

    /**
     * What the one feed needs about an offer (feed.item@1 1.1.0): what it costs now, what it cost
     * before, the shop that sells it and its picture. A price without a currency, or a currency that is
     * not an ISO code, is no price at all; a listing without a picture has none.
     */
    function feedFacts(v) {
        const latest = v.latest;
        const amount = latest ? Number(latest.price_num != null ? latest.price_num : latest.price) : NaN;
        const currency = String((latest && latest.currency) || '').trim().toUpperCase();
        const was = latest && latest.list_price_num != null ? Number(latest.list_price_num) : NaN;
        const store = (v.store && (v.store.name || v.store.domain)) || v.root.seller || null;
        const thumb = pictureUrl(v.root.image_url);
        return {
            price: Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/.test(currency) ? { amount, currency } : null,
            was: Number.isFinite(was) && was >= 0 ? was : null,
            store: store ? String(store).trim().slice(0, 60) || null : null,
            media: thumb ? { thumb } : null,
        };
    }

    /** The JSON representation (API and /d/:slug.json): the same facts as the page. */
    function offerDto(v) {
        const r = v.root;
        return {
            id: r.id, slug: r.slug, url: abs(offerPath(r)), title: r.title, description: r.description,
            link: r.url, status: r.status, category: r.category, origin: r.origin, submitted_by: r.submitted_by,
            // Why a crawled offer was selected as a deal (migration 0008); null for community offers.
            deal_reason: r.deal_reason || null,
            text_origin: r.text_origin, review_state: r.review_state, ai_summary: r.ai_summary,
            expires_at: iso(r.expires_at), expired_at: iso(r.expired_at), expired_reason: r.expired_reason,
            disabled_reason: r.status === 'disabled' ? r.disabled_reason : null,
            created_at: iso(r.created_at), updated_at: iso(r.updated_at),
            store: v.store ? { id: v.store.id, domain: v.store.domain, name: v.store.name, url: abs(storePath(v.store)) } : null,
            // The shop a source says sells it, as stated (the store is where the link goes).
            seller: r.seller || null,
            // What the one feed lists the offer with: the price now, the price before, the shop and the
            // product's picture (feed.item@1 1.1.0).
            feed: feedFacts(v),
            product: v.product ? { id: v.product.id, slug: v.product.slug, name: v.product.name, url: abs(productPath(v.product)) } : null,
            // "latest", never "current": whether it still holds is what freshness says.
            latest_observation: v.latest ? observationDto(v.latest) : null,
            freshness: v.freshness,
            attribution: v.attribution || null,
            observations: v.observations.map(observationDto),
            // Lowest, highest and the change since first seen, in the latest price's currency only (never converted).
            price_trend: trendDto(v.trend),
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
            seller: v.root.seller ? { '@type': 'Organization', name: v.root.seller } : v.store ? { '@type': 'Organization', name: v.store.name || v.store.domain } : undefined,
        };
        if (fresh && o) {
            // The price a buyer pays, as a number (the page shows the same number and its currency).
            if (o.price != null && o.currency) { ld.price = o.price_num != null ? o.price_num : Number(o.price); ld.priceCurrency = o.currency; }
            if (o.availability) ld.availability = `https://schema.org/${{ in_stock: 'InStock', out_of_stock: 'OutOfStock', preorder: 'PreOrder', discontinued: 'Discontinued', limited: 'LimitedAvailability', sold_out: 'SoldOut', online_only: 'OnlineOnly', in_store_only: 'InStoreOnly' }[o.availability]}`;
            if (o.condition) ld.itemCondition = `https://schema.org/${{ new: 'NewCondition', used: 'UsedCondition', refurbished: 'RefurbishedCondition', damaged: 'DamagedCondition' }[o.condition]}`;
            if (o.shipping != null && o.currency) ld.shippingDetails = { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: o.shipping, currency: o.currency } };
        }
        if (v.root.expires_at && v.root.status === 'active') ld.validThrough = iso(v.root.expires_at);
        return ld;
    }

    /**
     * The offer's own page: one Product node, named by the page's own heading (the offer's title).
     * The page never names a brand, so no brand is claimed; the brand belongs to the product's own page.
     */
    function offerJsonLd(v) {
        return seo.compact({
            '@context': 'https://schema.org', '@type': 'Product', name: v.root.title, url: abs(offerPath(v.root)),
            description: v.root.description || undefined,
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
    async function productView(product, now = store.now()) {
        const offers = await Promise.all((await productOfferIds.all(product.id)).map(async (r) => await reads.get(r.id)));
        const rows = await offerViews(offers, now);
        const rank = (v) => (v.root.status !== 'active' ? 4 : v.freshness.state !== 'fresh' ? 3 : (v.latest && v.latest.price != null && v.latest.currency) ? 1 : 2);
        rows.sort((a, b) => rank(a) - rank(b)
            || (rank(a) === 1 ? (a.latest.currency < b.latest.currency ? -1 : a.latest.currency > b.latest.currency ? 1 : a.latest.price_num - b.latest.price_num) : 0)
            || b.root.created_at - a.root.created_at);
        const fresh = rows.filter((v) => v.root.status === 'active' && v.freshness.state === 'fresh').map((v) => v.latest.observed_at);
        const freshest = fresh.length ? Math.max(...fresh) : null;
        return { product, offers: rows, aliases: await catalog.aliases(product.id), decision: decideProduct(product, freshest, now), freshestObservedAt: freshest };
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

    /** A short, whitespace-collapsed summary; the full source text is never included. */
    const brief = (value, max = 200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

    /**
     * What an index artifact (a sitemap chunk, /llms-full.txt) keeps about one offer: its URL, when it last changed,
     * whether a crawler may index it, and the short summary /llms-full.txt prints. Two reads (the merge group and its
     * latest observation) instead of offerView's ten, and nothing that grows with the group's price history is
     * retained; the entry measured ~0.6 KB. The sitemap cache holds one per offer for DEALS_SITEMAP_TTL_MS; keeping
     * the full views instead cost ~6.7 KB an offer — ~340 MB of a 50,000-offer catalog, held twice over once products
     * were built (2026-11-07: the Deals process at 667 MB-923 MB, peaking at 2 GB).
     */
    async function indexEntry(offer, now = store.now(), pre = null) {
        const root = pre ? pre.root : (offer.merged_into ? await reads.root(offer) : offer);
        const ids = pre ? pre.ids : await reads.groupIds(root.id);
        const latest = pre ? pre.latest : await reads.latestObservation(ids);
        // listings.indexable() joins the store onto each row; any other caller gets it looked up here.
        const s = root.store_domain !== undefined
            ? (root.store_domain ? { name: root.store_name, domain: root.store_domain } : null)
            : (root.store_id ? await catalog.store(root.store_id) : null);
        const price = latest && latest.price != null && latest.currency ? `${latest.price} ${latest.currency}` : '';
        return {
            loc: abs(offerPath(root)),
            lastmod: latest ? Math.max(latest.observed_at, root.updated_at) : root.updated_at,
            decision: decideOffer(root, latest, now),
            title: root.title,
            text: [brief(root.description), price, s ? `at ${s.name || s.domain}` : ''].filter(Boolean).join(' '),
        };
    }

    /** The sitemap arrays, prefetched in chunks: one latest-observation read per 100 offers instead of per offer. */
    async function indexEntries(offers, now = store.now(), { chunk = 100 } = {}) {
        const out = [];
        for (let i = 0; i < offers.length; i += chunk) {
            const part = offers.slice(i, i + chunk);
            const pre = await prefetch(part, { snapshots: false });
            out.push(...await Promise.all(part.map((o, j) => indexEntry(o, now, { root: pre.roots[j], ids: pre.groups[j], latest: pre.latest[j] }))));
        }
        return out;
    }

    // A product's lastmod and freshest active observation in one read: each offer's group latest observation (a merge
    // group shares one price history), without loading every offer's view. The same facts productView derives below.
    const productIndex = store.db.prepare(`SELECT MAX(GREATEST(o.updated_at, COALESCE(l.observed_at, 0))) AS lastmod,
                                                  MAX(CASE WHEN o.status = 'active' THEN l.observed_at END) AS active_latest
                                             FROM deal_offers o
                                             LEFT JOIN LATERAL (
                                                 WITH RECURSIVE g(id, depth) AS (SELECT o.id, 0 UNION
                                                     SELECT c.id, g.depth + 1 FROM deal_offers c JOIN g ON c.merged_into = g.id WHERE g.depth < 50)
                                                 SELECT p.observed_at FROM deal_price_observations p JOIN deal_offer_sources s ON s.id = p.source_id
                                                  WHERE p.offer_id IN (SELECT id FROM g) AND s.removed_at IS NULL
                                                  ORDER BY p.observed_at DESC, p.seq DESC LIMIT 1) l ON true
                                            WHERE o.product_id = ? AND o.merged_into IS NULL AND o.status <> 'disabled'`);

    /** What the sitemaps keep about one product page: its URL, when it last changed, whether it is indexable. */
    async function productIndexEntry(product, now = store.now()) {
        const r = await productIndex.get(product.id);
        const activeLatest = r.active_latest == null ? null : Number(r.active_latest);
        const freshest = activeLatest != null && now - activeLatest <= config.freshnessMs ? activeLatest : null;
        return {
            loc: abs(productPath(product)),
            lastmod: Math.max(product.updated_at, Number(r.lastmod) || 0),
            decision: decideProduct(product, freshest, now),
        };
    }

    return { abs, offerPath, productPath, storePath, sellerPath, categoryPath, freshness, decideOffer, decideProduct, offerView, offerViews, cardView, cardViews, offerDto, observationDto, offerLd, offerJsonLd, productView, productJsonLd, indexEntry, indexEntries, productIndexEntry };
}

module.exports = { createPublication };
