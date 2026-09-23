'use strict';

/**
 * Watches and saved searches.
 *
 *   keyword      every word of `query` appears in the offer (title, description, product, store)
 *   product      the offer is for this product
 *   price_below  product or keyword, AND the observation states a price in `currency` below
 *                `max_price`. An observation without a stated price (or in another currency) never
 *                matches: an unknown price is not a low price.
 *   search       a saved search (notify = 0): listed on /watches, never notifies
 *
 * Matching runs inside the transaction that records an observation. The notification key is
 * (watch_id, observation_id) — the primary key of watch_notifications — so replaying an import,
 * re-running the matcher or retrying a request can never produce a second deals.watch.matched for
 * the same observation. On top of that, a keyword/product watch notifies once per offer, and a
 * price-below watch again for the same offer only when the price is lower than the last one it
 * notified about. Observations that are already stale when recorded, offers that are not active,
 * and a person's own submissions/observations do not notify.
 *
 * Deals never emails: deals.watch.matched is an internal event for OpenVibe.Network's notification
 * consumer (future work).
 */
const { ApiError, newId, text, tokens, parseAmount, parseCurrency, iso } = require('./util');

const KINDS = ['keyword', 'product', 'price_below', 'search'];

function createWatches({ config, store, reads, catalog, publication, outbox }) {
    const { db } = store;
    const q = {
        get: db.prepare('SELECT * FROM deal_watches WHERE id = ?'),
        listFor: db.prepare('SELECT * FROM deal_watches WHERE subject = ? AND deleted_at IS NULL ORDER BY created_at DESC'),
        countFor: db.prepare('SELECT COUNT(*) AS n FROM deal_watches WHERE subject = ? AND deleted_at IS NULL'),
        insert: db.prepare(`INSERT INTO deal_watches (id, subject, kind, query, product_id, max_price, max_price_num, currency, notify, label, created_at)
                            VALUES (@id, @subject, @kind, @query, @product_id, @max_price, @max_price_num, @currency, @notify, @label, @now)`),
        remove: db.prepare('UPDATE deal_watches SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
        active: db.prepare("SELECT * FROM deal_watches WHERE notify = 1 AND deleted_at IS NULL AND kind <> 'search'"),
        claim: db.prepare(`INSERT OR IGNORE INTO watch_notifications (watch_id, observation_id, offer_id, price_num, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
        setEvent: db.prepare('UPDATE watch_notifications SET event_id = ? WHERE watch_id = ? AND observation_id = ?'),
        priorForGroup: db.prepare(`SELECT price_num, currency FROM watch_notifications
                                   WHERE watch_id = ? AND offer_id IN (SELECT value FROM json_each(?)) AND event_id IS NOT NULL`),
        notifications: db.prepare('SELECT COUNT(*) AS n FROM watch_notifications WHERE watch_id = ? AND event_id IS NOT NULL'),
    };

    function create(subject, input) {
        if (!subject) throw new ApiError(401, 'auth.required', 'Sign in to save watches');
        const kind = String(input.kind || '');
        if (!KINDS.includes(kind)) throw new ApiError(422, 'request.invalid', `kind must be one of ${KINDS.join(', ')}`);
        if (q.countFor.get(subject).n >= config.abuse.watchesPerSubject) throw new ApiError(429, 'watch.limit', `At most ${config.abuse.watchesPerSubject} watches and saved searches`);
        const query = text(input.query, { field: 'query', max: 200 });
        let product = null;
        if (input.product) {
            product = catalog.productBySlug(input.product) || catalog.product(input.product);
            if (!product) throw new ApiError(404, 'product.not_found', 'No such product');
        }
        const row = { id: newId('dwt'), subject, kind, query: null, product_id: null, max_price: null, max_price_num: null, currency: null, notify: kind === 'search' ? 0 : 1, label: text(input.label, { max: 120 }), now: store.now() };
        if (kind === 'keyword' || kind === 'search') {
            if (!query || tokens(query).length === 0) throw new ApiError(422, 'request.invalid', 'query needs at least one word');
            row.query = query;
        } else if (kind === 'product') {
            if (!product) throw new ApiError(422, 'request.invalid', 'product is required');
            row.product_id = product.id;
        } else {
            const amount = parseAmount(input.max_price, 'max_price');
            const currency = parseCurrency(input.currency);
            if (!amount || !currency) throw new ApiError(422, 'request.invalid', 'max_price and currency are required');
            if (!product && !(query && tokens(query).length)) throw new ApiError(422, 'request.invalid', 'a price watch needs a product or keywords');
            Object.assign(row, { product_id: product ? product.id : null, query: product ? null : query, max_price: amount.text, max_price_num: amount.num, currency });
        }
        q.insert.run(row);
        return q.get.get(row.id);
    }

    function remove(subject, id, { staff = false } = {}) {
        const w = q.get.get(String(id || ''));
        if (!w || w.deleted_at || (w.subject !== subject && !staff)) throw new ApiError(404, 'watch.not_found', 'No such watch');
        q.remove.run(store.now(), w.id);
        return { id: w.id, deleted: true };
    }

    function offerText(v) {
        return new Set(tokens([v.root.title, v.root.description, v.product && v.product.name, v.product && v.product.brand, v.store && v.store.domain, v.store && v.store.name].filter(Boolean).join(' ')));
    }

    function matches(w, v, obs, words) {
        const productOk = w.product_id ? v.root.product_id === w.product_id : true;
        const keywordOk = w.query ? tokens(w.query).every((t) => words.has(t)) : true;
        if (w.kind === 'keyword') return keywordOk;
        if (w.kind === 'product') return productOk;
        if (w.kind === 'price_below') {
            if (obs.price_num == null || obs.currency !== w.currency) return false;
            return productOk && keywordOk && obs.price_num < w.max_price_num;
        }
        return false;
    }

    /** Inside the observation's transaction. Returns the envelopes emitted. */
    function onObservation(obs) {
        const offer = reads.get(obs.offer_id);
        const v = publication.offerView(offer);
        if (v.root.status !== 'active') return [];
        if (store.now() - obs.observed_at > config.freshnessMs) return [];
        const words = offerText(v);
        const out = [];
        for (const w of q.active.all()) {
            if (obs.observed_by && obs.observed_by === w.subject) continue;
            if (v.root.submitted_by && v.root.submitted_by === w.subject && obs.origin === 'community') continue;
            if (!matches(w, v, obs, words)) continue;
            const prior = q.priorForGroup.all(w.id, JSON.stringify(v.ids));
            if (w.kind !== 'price_below' && prior.length) continue;
            if (w.kind === 'price_below' && prior.some((p) => p.currency === obs.currency && p.price_num != null && p.price_num <= obs.price_num)) continue;
            // The uniqueness: at most one row, hence one event, per (watch, observation).
            if (q.claim.run(w.id, obs.id, v.root.id, obs.price_num, obs.currency, store.now()).changes === 0) continue;
            const env = outbox.emit({
                event_type: 'deals.watch.matched',
                version: 1,
                source: 'deals',
                actor: { type: 'service', id: 'deals' },
                subject: { type: 'watch', id: w.id },
                visibility: 'internal',
                payload: {
                    watch_id: w.id, recipient: w.subject, kind: w.kind, query: w.query, product_id: w.product_id,
                    max_price: w.max_price, currency: w.currency,
                    offer_id: v.root.id, offer_url: publication.abs(publication.offerPath(v.root)), title: v.root.title,
                    observation: { id: obs.id, observed_at: iso(obs.observed_at), price: obs.price, currency: obs.currency, availability: obs.availability },
                },
            });
            q.setEvent.run(env.event_id, w.id, obs.id);
            out.push(env);
        }
        return out;
    }

    function dto(w) {
        const product = w.product_id ? catalog.product(w.product_id) : null;
        return {
            id: w.id, kind: w.kind, query: w.query, label: w.label, notify: Boolean(w.notify),
            product: product ? { id: product.id, slug: product.slug, name: product.name, url: publication.abs(publication.productPath(product)) } : null,
            max_price: w.max_price, currency: w.currency, created_at: iso(w.created_at),
            notifications: q.notifications.get(w.id).n,
        };
    }

    return { create, remove, onObservation, list: (subject) => q.listFor.all(subject), get: (id) => q.get.get(id), dto, KINDS };
}

module.exports = { createWatches, KINDS };
