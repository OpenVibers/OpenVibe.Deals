'use strict';

/**
 * Events and OpenVibe.Search documents. Everything here runs INSIDE the transaction that made the
 * change (the outbox rule): an event exists if and only if its change committed.
 *
 *   emitOffer('deals.offer.created'|'deals.offer.updated'|'deals.offer.expired', offer, …)
 *   indexOffer(offer)     deals.index_document.upserted|deleted for the canonical offer, or a
 *                         tombstone for a merged one. The chassis (openvibe-publishing/publication)
 *                         owns the mechanics — the sequencer revision, the search.index-document@1
 *                         event, the outbox write and the IndexNow ping — on the caller's transaction
 *                         handle, so the same document gets the same revision and re-sending an
 *                         unchanged document emits nothing. A document that changed (text, status,
 *                         freshness, indexability) gets revision + 1 and one event.
 *   indexProduct(id)      the same for product pages.
 *
 * When an indexable page appears, changes or disappears the chassis also tells IndexNow
 * (openvibe-shared/indexnow, injected at boot): the page's path and the sitemap. Off without a key.
 */
const hooks = require('openvibe-publishing/index-hooks');
const { createPublication: createPublicationGlue } = require('openvibe-publishing/publication');
const { iso } = require('./values');

function actorRef(actor) {
    const s = String(actor || '');
    if (/^usr_/.test(s)) return { type: 'user', id: s };
    if (/^svc:/.test(s)) return { type: 'service', id: s.slice(4) };
    return { type: 'service', id: 'deals' };
}

function createIndexing({ config, store, publication, outbox, catalog, indexnow = null }) {
    const { sequencer, db } = store;
    // The chassis owns the mechanics; Deals' gate, document builder and canonical paths stay here.
    const glue = createPublicationGlue({ owner: 'deals', sequencer, outbox, baseUrl: config.baseUrl, indexnow, db, now: store.now });

    function latestPayload(v) {
        return v.latest ? { price: v.latest.price, currency: v.latest.currency, availability: v.latest.availability, observed_at: iso(v.latest.observed_at) } : null;
    }

    /** deals.offer.* for the canonical offer. */
    async function emitOffer(type, offer, { actor = null, extra = {}, traceparent } = {}) {
        const v = await publication.offerView(offer);
        const r = v.root;
        return await outbox.emit({
            event_type: type,
            version: 1,
            source: 'deals',
            actor: actorRef(actor),
            subject: { type: 'offer', id: r.id },
            visibility: r.status === 'active' && v.decision.listable ? 'public' : 'internal',
            payload: {
                offer_id: r.id, slug: r.slug, url: publication.abs(publication.offerPath(r)), title: r.title,
                status: r.status, store: v.store ? v.store.domain : null, product_id: r.product_id,
                latest_observation: latestPayload(v), freshness: v.freshness.state,
                indexability: hooks.searchIndexability(v.decision),
                ...extra,
            },
        }, { traceparent });
    }

    function offerDocument(v) {
        const r = v.root;
        const provenance = v.sources.filter((s) => s.ref_service === 'sources' && !s.removed_at).slice(0, 40).map((s) => ({
            service: 'sources', type: 'item', id: s.ref_id, ...(Number.isInteger(s.ref_revision) ? { revision: s.ref_revision } : {}),
            url: s.url || undefined, retrievedAt: s.retrieved_at || undefined, label: s.source_key || undefined,
        }));
        const priceText = v.latest && v.latest.price != null ? `${v.latest.price}${v.latest.currency ? ` ${v.latest.currency}` : ''} as of ${iso(v.latest.observed_at)}` : 'price not stated';
        return hooks.buildIndexDocument({
            owner: 'deals', type: 'offer', id: r.id, revision: 0,
            state: r.status === 'disabled' ? 'unpublished' : 'published', visibility: 'public',
            canonicalUrl: publication.abs(publication.offerPath(r)),
            title: r.title,
            summary: r.description ? r.description.slice(0, 1000) : null,
            body: [r.title, r.description, v.product && v.product.name, v.store && (v.store.name || v.store.domain), priceText].filter(Boolean).join('\n'),
            facets: {
                status: r.status, freshness: v.freshness.state, store: v.store ? v.store.domain : null, category: r.category,
                currency: v.latest && v.latest.currency ? v.latest.currency : null, product: v.product ? v.product.slug : null,
            },
            authorship: { mode: r.text_origin === 'human' ? 'human' : r.text_origin === 'imported' ? 'imported' : 'hybrid' },
            provenance,
            decision: v.decision,
            publishedAt: r.created_at,
            updatedAt: v.latest ? Math.max(v.latest.observed_at, r.updated_at) : r.updated_at,
        });
    }

    async function indexOffer(offer) {
        if (!offer) return null;
        if (offer.merged_into) {
            // A merge is a delete: the duplicate's page goes away (announced only if Search had it).
            return await glue.tombstone(db, { type: 'offer', id: offer.id, page: publication.offerPath(offer) });
        }
        const v = await publication.offerView(offer);
        return await glue.index(db, { document: offerDocument(v), page: publication.offerPath(v.root) });
    }

    async function indexProduct(product) {
        if (!product) return null;
        const pv = await publication.productView(product);
        const lines = pv.offers.filter((v) => v.root.status === 'active').slice(0, 20).map((v) => `${v.root.title}${v.latest && v.latest.price != null ? ` — ${v.latest.price} ${v.latest.currency || ''} as of ${iso(v.latest.observed_at)}` : ''}`);
        const doc = hooks.buildIndexDocument({
            owner: 'deals', type: 'product', id: product.id, revision: 0, state: 'published', visibility: 'public',
            canonicalUrl: publication.abs(publication.productPath(product)), title: product.name,
            summary: product.description || null,
            body: [product.name, product.brand, ...pv.aliases.map((a) => a.value), ...lines].filter(Boolean).join('\n'),
            facets: { brand: product.brand || null, category: product.category || null, offers: pv.offers.filter((v) => v.root.status === 'active').length },
            authorship: { mode: 'human' },
            decision: pv.decision,
            publishedAt: product.created_at,
            updatedAt: pv.freshestObservedAt || product.updated_at,
        });
        return await glue.index(db, { document: doc, page: publication.productPath(product) });
    }

    /** After any change to an offer: its index document and its product's. */
    async function reindex(offer) {
        await indexOffer(offer);
        if (offer && offer.product_id) await indexProduct(await catalog.product(offer.product_id));
    }

    return { emitOffer, indexOffer, indexProduct, reindex, actorRef, offerDocument };
}

module.exports = { createIndexing, actorRef };
