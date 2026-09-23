'use strict';

/**
 * /api/v1 — JSON for services (Network client-credentials tokens, audience openvibe.deals, one
 * capability per route, acting for the person in X-OV-Subject) and for browsers or apps with a
 * Network user JWT (judged by the domain: signed in, submitter, moderator). Errors are problem+json.
 *
 *   GET    /offers?sort=hot|new&page=              public
 *   GET    /offers/:id                             public (id or slug; a merged id answers with its canonical offer)
 *   GET    /offers/:id/hotness                     public: the latest snapshot, its inputs and a recomputation
 *   POST   /offers                                 deals.offer.submit     (X-OV-Origin: ai → text held for review)
 *   PATCH  /offers/:id                             deals.offer.update     title, description, category, expires_at, product
 *   POST   /offers/:id/observations                deals.offer.update     { price, currency, shipping, shipping_note, condition, availability, observed_at? (services) }
 *   POST   /offers/:id/expire                      deals.offer.expire
 *   PUT    /offers/:id/vote                        deals.vote.set         { value: 1 | -1 }
 *   DELETE /offers/:id/vote                        deals.vote.remove
 *   POST   /offers/:id/flags                       deals.flag.create      { kind, reason, duplicate_of? }
 *   POST   /offers/:id/merge                       deals.offer.merge      { into, reason }   (moderators)
 *   POST   /offers/:id/unmerge                     deals.offer.merge      { reason }         (moderators)
 *   POST   /offers/:id/disable|enable|review       deals.offer.moderate   (moderators)
 *   GET    /flags?status=open                      deals.offer.moderate   (moderators)
 *   POST   /flags/:id/resolve                      deals.offer.moderate   { status: resolved|dismissed, resolution }
 *   GET    /products/:slug                         public
 *   POST   /products/resolve                       deals.product.resolve  { name, brand, gtin, mpn, sku, url, create? }
 *   GET    /stores/:domain                         public
 *   GET    /watches                                deals.watch.read       the acting person's watches
 *   POST   /watches                                deals.watch.create     { kind, query, product, max_price, currency, label }
 *   DELETE /watches/:id                            deals.watch.delete
 */
const express = require('express');
const { run, jsonBody, privateNoStore, ApiError } = require('./errors');
const { guard } = require('../auth/viewer');
const { iso } = require('../domain/util');

function cors(origins) {
    const allowed = new Set(origins);
    return (req, res, next) => {
        const origin = req.get('origin');
        if (origin && allowed.has(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, traceparent, X-OpenVibe-Request-Id');
            res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
            res.set('Access-Control-Expose-Headers', 'X-OpenVibe-Request-Id, Retry-After');
            res.set('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    };
}

function createApi(ctx) {
    const { config, reads, catalog, publication, listings, offers, votes, watches, flags, hotness, viewers, access } = ctx;
    const router = express.Router();
    router.use(cors(config.apiCorsOrigins));
    router.use(viewers.middleware());
    router.use((req, res, next) => { privateNoStore(res); res.set('X-Robots-Tag', 'noindex'); next(); });

    const opts = (req) => ({ ip: req.viewer.kind === 'service' ? null : req.ip, traceparent: req.ov && req.ov.traceparent });
    const offerOut = (offer) => ({ offer: publication.offerDto(publication.offerView(offer)) });
    const needSubject = (req) => { if (!req.viewer.subject) throw new ApiError(req.viewer.kind === 'service' ? 400 : 401, req.viewer.kind === 'service' ? 'subject.required' : 'auth.required', req.viewer.kind === 'service' ? 'X-OV-Subject must name the person this action is for' : 'Sign in first'); };

    // ── offers ──────────────────────────────────────────────

    router.get('/offers', run((req) => {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const per = 25;
        const rows = req.query.sort === 'new' ? listings.newest(per, (page - 1) * per) : listings.hot(per, (page - 1) * per);
        return { sort: req.query.sort === 'new' ? 'new' : 'hot', page, total: listings.countActive(), offers: rows.map((o) => publication.offerDto(publication.offerView(o))) };
    }));

    router.get('/offers/:id', run((req) => offerOut(reads.mustFind(req.params.id))));

    router.get('/offers/:id/hotness', run((req) => {
        const root = reads.root(reads.mustFind(req.params.id));
        const snap = reads.lastSnapshot(root.id);
        return {
            offer_id: root.id,
            formula: 'hot@1: score = upWeight − downWeight; hot = round6(score / (ageHours + 2)^1.5), ageHours = (t − firstSeenAt) / 3600000',
            snapshot: snap ? { ...snap, computed_at: iso(snap.computed_at), first_seen_at: iso(snap.first_seen_at) } : null,
            recomputed: snap ? hotness.recompute(snap) : null,
        };
    }));

    router.post('/offers', guard('deals.offer.submit'), jsonBody, run((req) => {
        needSubject(req);
        const out = offers.submit(req.viewer, req.body || {}, opts(req));
        return offerOut(out.offer);
    }, 201));

    router.patch('/offers/:id', guard('deals.offer.update'), jsonBody, run((req) => offerOut(offers.update(req.viewer, req.params.id, req.body || {}, opts(req)).offer)));

    router.post('/offers/:id/observations', guard('deals.offer.update'), jsonBody, run((req) => {
        needSubject(req);
        const out = offers.observe(req.viewer, req.params.id, req.body || {}, opts(req));
        return { ...offerOut(out.offer), observation: publication.observationDto({ ...out.observation, source_kind: 'community' }) };
    }, 201));

    router.post('/offers/:id/expire', guard('deals.offer.expire'), jsonBody, run((req) => offerOut(offers.expire(req.viewer, req.params.id, req.body || {}, opts(req)))));

    router.put('/offers/:id/vote', guard('deals.vote.set'), jsonBody, run((req) => {
        needSubject(req);
        const value = Number((req.body || {}).value);
        if (value !== 1 && value !== -1) throw new ApiError(422, 'request.invalid', 'value must be 1 or -1');
        const r = votes.set(req.viewer, req.params.id, value, opts(req));
        return { offer_id: r.root.id, value: r.value, previous: r.previous, changed: r.changed, votes: { up: r.tally.up, down: r.tally.down, up_weight: r.tally.upWeight, down_weight: r.tally.downWeight } };
    }));

    router.delete('/offers/:id/vote', guard('deals.vote.remove'), run((req) => {
        needSubject(req);
        const r = votes.remove(req.viewer, req.params.id, opts(req));
        return { offer_id: r.root.id, value: 0, previous: r.previous, changed: r.changed, votes: { up: r.tally.up, down: r.tally.down, up_weight: r.tally.upWeight, down_weight: r.tally.downWeight } };
    }));

    router.post('/offers/:id/flags', guard('deals.flag.create'), jsonBody, run((req) => {
        needSubject(req);
        const r = flags.report(req.viewer, req.params.id, req.body || {}, opts(req));
        return { flag: { id: r.flag.id, kind: r.flag.kind, status: r.flag.status }, created: r.created };
    }, (out) => (out.created ? 201 : 200)));

    router.post('/offers/:id/merge', guard('deals.offer.merge'), jsonBody, run((req) => {
        const b = req.body || {};
        const r = offers.merge(req.viewer, req.params.id, b.into, { reason: b.reason }, opts(req));
        return { ...offerOut(r.offer), merged: { id: r.merged.id, slug: r.merged.slug }, before: r.before, after: r.after };
    }));

    router.post('/offers/:id/unmerge', guard('deals.offer.merge'), jsonBody, run((req) => {
        const r = offers.unmerge(req.viewer, req.params.id, req.body || {}, opts(req));
        return { ...offerOut(r.offer), from: { id: r.from.id, slug: r.from.slug }, before: r.before, after: r.after };
    }));

    for (const action of ['disable', 'enable', 'review']) {
        router.post(`/offers/:id/${action}`, guard('deals.offer.moderate'), jsonBody, run((req) => offerOut(offers[action](req.viewer, req.params.id, req.body || {}, opts(req)).offer)));
    }

    router.get('/flags', guard('deals.offer.moderate'), run((req) => {
        if (!access.isModerator(req.viewer, 'deals.offer.moderate')) throw new ApiError(403, 'moderation.forbidden', 'Moderators only');
        const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
        return { flags: flags.list({ status }).map(flags.dto) };
    }));

    router.post('/flags/:id/resolve', guard('deals.offer.moderate'), jsonBody, run((req) => {
        const r = flags.resolve(req.viewer, req.params.id, req.body || {});
        return { flag: flags.dto(r.flag), changed: r.changed };
    }));

    // ── products and stores ─────────────────────────────────

    router.get('/products/:slug', run((req) => {
        const p = catalog.productBySlug(req.params.slug) || catalog.product(req.params.slug);
        if (!p) throw new ApiError(404, 'product.not_found', 'No such product');
        const pv = publication.productView(p);
        return {
            product: { id: p.id, slug: p.slug, name: p.name, brand: p.brand, category: p.category, url: publication.abs(publication.productPath(p)), aliases: pv.aliases.map((a) => ({ kind: a.kind, value: a.value })) },
            offers: pv.offers.map((v) => publication.offerDto(v)),
        };
    }));

    router.post('/products/resolve', guard('deals.product.resolve'), jsonBody, run((req) => {
        const b = req.body || {};
        const actor = req.viewer.subject || req.viewer.service || null;
        if (!actor) throw new ApiError(401, 'auth.required', 'Sign in first');
        const create = b.create !== false;
        const r = ctx.store.tx(() => {
            const out = catalog.resolve(b, { source: req.viewer.kind === 'service' ? 'import' : 'community', actor, create });
            if (out.created) ctx.indexing.indexProduct(out.product);
            return out;
        });
        if (!r.product) throw new ApiError(404, 'product.not_found', 'No product has these aliases');
        return { product: { id: r.product.id, slug: r.product.slug, name: r.product.name, url: publication.abs(publication.productPath(r.product)) }, created: r.created, conflicts: r.conflicts };
    }, (out) => (out.created ? 201 : 200)));

    router.get('/stores/:domain', run((req) => {
        const st = catalog.storeByDomain(req.params.domain);
        if (!st) throw new ApiError(404, 'store.not_found', 'No such store');
        return { store: { id: st.id, domain: st.domain, name: st.name, url: publication.abs(publication.storePath(st)) }, offers: listings.byStore(st.id, 50, 0).map((o) => publication.offerDto(publication.offerView(o))) };
    }));

    // ── watches ─────────────────────────────────────────────

    router.get('/watches', guard('deals.watch.read'), run((req) => { needSubject(req); return { watches: watches.list(req.viewer.subject).map(watches.dto) }; }));

    router.post('/watches', guard('deals.watch.create'), jsonBody, run((req) => {
        needSubject(req);
        return { watch: watches.dto(watches.create(req.viewer.subject, req.body || {})) };
    }, 201));

    router.delete('/watches/:id', guard('deals.watch.delete'), run((req) => { needSubject(req); return watches.remove(req.viewer.subject, req.params.id); }));

    router.use((req, res) => require('openvibe-contracts').http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    return router;
}

module.exports = { createApi };
