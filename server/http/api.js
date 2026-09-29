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
const { iso } = require('../domain/values');

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
    const { config, reads, catalog, publication, listings, offers, votes, watches, flags, hotness, viewers, access, actorLimits } = ctx;
    const router = express.Router();
    router.use(cors(config.apiCorsOrigins));
    router.use(viewers.middleware());
    // Per-actor limits (http/actor-limits.js), once req.viewer is resolved: every read takes the defaults;
    // each write names its budget after its capability guard and before its body is read.
    router.use(actorLimits.reads('deals.read'));
    const B = (name) => actorLimits.budget(name);
    router.use((req, res, next) => { privateNoStore(res); res.set('X-Robots-Tag', 'noindex'); next(); });

    const opts = (req) => ({ ip: req.viewer.kind === 'service' ? null : req.ip, traceparent: req.ov && req.ov.traceparent });
    const offerOut = async (offer) => ({ offer: publication.offerDto(await publication.offerView(offer)) });
    const needSubject = (req) => { if (!req.viewer.subject) throw new ApiError(req.viewer.kind === 'service' ? 400 : 401, req.viewer.kind === 'service' ? 'subject.required' : 'auth.required', req.viewer.kind === 'service' ? 'X-OV-Subject must name the person this action is for' : 'Sign in first'); };

    // ── offers ──────────────────────────────────────────────

    router.get('/offers', run(async (req) => {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const per = 25;
        const rows = req.query.sort === 'new' ? await listings.newest(per, (page - 1) * per) : await listings.hot(per, (page - 1) * per);
        return { sort: req.query.sort === 'new' ? 'new' : 'hot', page, total: await listings.countActive(), offers: await Promise.all(rows.map(async (o) => publication.offerDto(await publication.offerView(o)))) };
    }));

    // A removed deal answers like its page (410, reason only); moderators still read the whole record.
    router.get('/offers/:id', run(async (req) => {
        const offer = await reads.mustFind(req.params.id);
        const root = await reads.root(offer);
        if (root.status === 'disabled' && !access.isModerator(req.viewer)) {
            throw new ApiError(410, 'offer.disabled', 'This deal was removed by moderators', { id: root.id, slug: root.slug, status: 'disabled', reason: root.disabled_reason });
        }
        return await offerOut(offer);
    }));

    router.get('/offers/:id/hotness', run(async (req) => {
        const root = await reads.root(await reads.mustFind(req.params.id));
        const snap = await reads.lastSnapshot(root.id);
        return {
            offer_id: root.id,
            formula: 'hot@1: score = upWeight − downWeight; hot = round6(score / (ageHours + 2)^1.5), ageHours = (t − firstSeenAt) / 3600000',
            snapshot: snap ? { ...snap, computed_at: iso(snap.computed_at), first_seen_at: iso(snap.first_seen_at) } : null,
            recomputed: snap ? hotness.recompute(snap) : null,
        };
    }));

    router.post('/offers', guard('deals.offer.submit'), B('deals.offer.submit'), jsonBody, run(async (req) => {
        needSubject(req);
        const out = await offers.submit(req.viewer, req.body || {}, opts(req));
        return await offerOut(out.offer);
    }, 201));

    router.patch('/offers/:id', guard('deals.offer.update'), B('deals.offer.update'), jsonBody, run(async (req) => await offerOut((await offers.update(req.viewer, req.params.id, req.body || {}, opts(req))).offer)));

    router.post('/offers/:id/observations', guard('deals.offer.update'), B('deals.offer.observe'), jsonBody, run(async (req) => {
        needSubject(req);
        const out = await offers.observe(req.viewer, req.params.id, req.body || {}, opts(req));
        return { ...await offerOut(out.offer), observation: publication.observationDto({ ...out.observation, source_kind: 'community' }) };
    }, 201));

    router.post('/offers/:id/expire', guard('deals.offer.expire'), B('deals.offer.update'), jsonBody, run(async (req) => await offerOut(await offers.expire(req.viewer, req.params.id, req.body || {}, opts(req)))));

    router.put('/offers/:id/vote', guard('deals.vote.set'), B('deals.vote'), jsonBody, run(async (req) => {
        needSubject(req);
        const value = Number((req.body || {}).value);
        if (value !== 1 && value !== -1) throw new ApiError(422, 'request.invalid', 'value must be 1 or -1');
        const r = await votes.set(req.viewer, req.params.id, value, opts(req));
        return { offer_id: r.root.id, value: r.value, previous: r.previous, changed: r.changed, votes: { up: r.tally.up, down: r.tally.down, up_weight: r.tally.upWeight, down_weight: r.tally.downWeight } };
    }));

    router.delete('/offers/:id/vote', guard('deals.vote.remove'), B('deals.vote'), run(async (req) => {
        needSubject(req);
        const r = await votes.remove(req.viewer, req.params.id, opts(req));
        return { offer_id: r.root.id, value: 0, previous: r.previous, changed: r.changed, votes: { up: r.tally.up, down: r.tally.down, up_weight: r.tally.upWeight, down_weight: r.tally.downWeight } };
    }));

    router.post('/offers/:id/flags', guard('deals.flag.create'), B('deals.flag.create'), jsonBody, run(async (req) => {
        needSubject(req);
        const r = await flags.report(req.viewer, req.params.id, req.body || {}, opts(req));
        return { flag: { id: r.flag.id, kind: r.flag.kind, status: r.flag.status }, created: r.created };
    }, (out) => (out.created ? 201 : 200)));

    router.post('/offers/:id/merge', guard('deals.offer.merge'), B('deals.offer.moderate'), jsonBody, run(async (req) => {
        const b = req.body || {};
        const r = await offers.merge(req.viewer, req.params.id, b.into, { reason: b.reason }, opts(req));
        return { ...await offerOut(r.offer), merged: { id: r.merged.id, slug: r.merged.slug }, before: r.before, after: r.after };
    }));

    router.post('/offers/:id/unmerge', guard('deals.offer.merge'), B('deals.offer.moderate'), jsonBody, run(async (req) => {
        const r = await offers.unmerge(req.viewer, req.params.id, req.body || {}, opts(req));
        return { ...await offerOut(r.offer), from: { id: r.from.id, slug: r.from.slug }, before: r.before, after: r.after };
    }));

    for (const action of ['disable', 'enable', 'review']) {
        router.post(`/offers/:id/${action}`, guard('deals.offer.moderate'), B('deals.offer.moderate'), jsonBody, run(async (req) => await offerOut((await offers[action](req.viewer, req.params.id, req.body || {}, opts(req))).offer)));
    }

    router.get('/flags', guard('deals.offer.moderate'), run(async (req) => {
        if (!access.isModerator(req.viewer, 'deals.offer.moderate')) throw new ApiError(403, 'moderation.forbidden', 'Moderators only');
        const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
        return { flags: await Promise.all((await flags.list({ status })).map(flags.dto)) };
    }));

    router.post('/flags/:id/resolve', guard('deals.offer.moderate'), B('deals.offer.moderate'), jsonBody, run(async (req) => {
        const r = await flags.resolve(req.viewer, req.params.id, req.body || {}, opts(req));
        return { flag: await flags.dto(r.flag), changed: r.changed };
    }));

    // ── products and stores ─────────────────────────────────

    router.get('/products/:slug', run(async (req) => {
        const p = await catalog.productBySlug(req.params.slug) || await catalog.product(req.params.slug);
        if (!p) throw new ApiError(404, 'product.not_found', 'No such product');
        const pv = await publication.productView(p);
        return {
            product: { id: p.id, slug: p.slug, name: p.name, brand: p.brand, category: p.category, url: publication.abs(publication.productPath(p)), aliases: pv.aliases.map((a) => ({ kind: a.kind, value: a.value })) },
            offers: pv.offers.map((v) => publication.offerDto(v)),
        };
    }));

    router.post('/products/resolve', guard('deals.product.resolve'), B('deals.product.resolve'), jsonBody, run(async (req) => {
        const b = req.body || {};
        const actor = req.viewer.subject || req.viewer.service || null;
        if (!actor) throw new ApiError(401, 'auth.required', 'Sign in first');
        const create = b.create !== false;
        const r = await ctx.store.tx(async () => {
            const out = await catalog.resolve(b, { source: req.viewer.kind === 'service' ? 'import' : 'community', actor, create });
            if (out.created) await ctx.indexing.indexProduct(out.product);
            return out;
        });
        if (!r.product) throw new ApiError(404, 'product.not_found', 'No product has these aliases');
        return { product: { id: r.product.id, slug: r.product.slug, name: r.product.name, url: publication.abs(publication.productPath(r.product)) }, created: r.created, conflicts: r.conflicts };
    }, (out) => (out.created ? 201 : 200)));

    router.get('/stores/:domain', run(async (req) => {
        const st = await catalog.storeByDomain(req.params.domain);
        if (!st) throw new ApiError(404, 'store.not_found', 'No such store');
        return { store: { id: st.id, domain: st.domain, name: st.name, url: publication.abs(publication.storePath(st)) }, offers: await Promise.all((await listings.byStore(st.id, 50, 0)).map(async (o) => publication.offerDto(await publication.offerView(o)))) };
    }));

    // ── watches ─────────────────────────────────────────────

    router.get('/watches', guard('deals.watch.read'), run(async (req) => { needSubject(req); return { watches: await Promise.all((await watches.list(req.viewer.subject)).map(watches.dto)) }; }));

    router.post('/watches', guard('deals.watch.create'), B('deals.watch'), jsonBody, run(async (req) => {
        needSubject(req);
        return { watch: await watches.dto(await watches.create(req.viewer.subject, req.body || {})) };
    }, 201));

    router.delete('/watches/:id', guard('deals.watch.delete'), B('deals.watch'), run(async (req) => { needSubject(req); return await watches.remove(req.viewer.subject, req.params.id); }));

    router.use((req, res) => require('openvibe-contracts').http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    return router;
}

module.exports = { createApi };
