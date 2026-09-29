'use strict';

/**
 * Events and OpenVibe.Search documents. Everything here runs INSIDE the transaction that made the
 * change (the outbox rule): an event exists if and only if its change committed.
 *
 *   emitOffer('deals.offer.created'|'deals.offer.updated'|'deals.offer.expired', offer, …)
 *   indexOffer(offer)     deals.index_document.upserted|deleted for the canonical offer, or a
 *                         tombstone for a merged one. The openvibe-publishing sequencer gives the
 *                         same document the same revision, so re-sending an unchanged document emits
 *                         nothing; a document that changed (text, status, freshness, indexability)
 *                         gets revision + 1 and one event.
 *   indexProduct(id)      the same for product pages.
 *
 * When an indexable page appears, changes or disappears it also tells IndexNow (openvibe-shared/indexnow,
 * injected at boot): the page's path and the sitemap. Off without a key.
 */
const hooks = require('openvibe-publishing/index-hooks');
const { iso } = require('./util');

function actorRef(actor) {
    const s = String(actor || '');
    if (/^usr_/.test(s)) return { type: 'user', id: s };
    if (/^svc:/.test(s)) return { type: 'service', id: s.slice(4) };
    return { type: 'service', id: 'deals' };
}

function createIndexing({ store, publication, outbox, catalog, indexnow = null }) {
    const { sequencer, db } = store;

    /**
     * IndexNow: a public, indexable page appeared, changed or went away — tell the engines its path
     * (and the sitemap, which lists it). pingSoon never throws and is a no-op without a key, so it can
     * never take a write down. A draft, private or noindex page is never announced.
     */
    function announce(path) {
        if (indexnow && indexnow.enabled) indexnow.pingSoon([publication.abs(path), publication.abs('/sitemap.xml')]);
    }

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

    async function emitIfNew(doc, before) {
        if (before != null && doc.revision === before) return null;
        return await outbox.emit(hooks.indexEvent({ document: doc, now: store.now() }));
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
            const before = await sequencer.current('deals', 'offer', offer.id);
            const sent = await emitIfNew(await sequencer.stamp(db, hooks.tombstone({ owner: 'deals', type: 'offer', id: offer.id, revision: 0 })), before);
            // A merge is a delete: the duplicate's page goes away. Announce it only if Search had it.
            if (sent && before != null) announce(publication.offerPath(offer));
            return sent;
        }
        const v = await publication.offerView(offer);
        const before = await sequencer.current('deals', 'offer', v.root.id);
        const sent = await emitIfNew(await sequencer.stamp(db, offerDocument(v)), before);
        if (sent) {
            // An indexable page appears or changes; a page Search already had that is now explicitly
            // removed (a takedown) disappeared. An expired offer stays published-but-noindex, so it is
            // not announced — a noindex page is never pinged.
            const indexable = v.root.status === 'active' && v.decision.indexable;
            const removed = v.root.status === 'disabled' && before != null;
            if (indexable || removed) announce(publication.offerPath(v.root));
        }
        return sent;
    }

    async function indexProduct(product) {
        if (!product) return null;
        const pv = await publication.productView(product);
        const before = await sequencer.current('deals', 'product', product.id);
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
        const sent = await emitIfNew(await sequencer.stamp(db, doc), before);
        // A product page appears or changes while indexable; one Search had that is now no longer
        // indexable (its last fresh offer went) disappeared.
        if (sent && (pv.decision.indexable || before != null)) announce(publication.productPath(product));
        return sent;
    }

    /** After any change to an offer: its index document and its product's. */
    async function reindex(offer) {
        await indexOffer(offer);
        if (offer && offer.product_id) await indexProduct(await catalog.product(offer.product_id));
    }

    return { emitOffer, indexOffer, indexProduct, reindex, actorRef, offerDocument };
}

module.exports = { createIndexing, actorRef };
