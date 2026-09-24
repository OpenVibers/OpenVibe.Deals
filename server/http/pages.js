'use strict';

/**
 * Public, server-rendered routes — useful without JavaScript (every action is a plain form):
 *
 *   GET  /                       hot deals (hot@1 snapshots)          GET /new    newest deals
 *   GET  /d/:slug                an offer: latest observation "as of", freshness, price history,
 *                                sources, votes, discussion (…/:slug.json: the same facts as data)
 *   POST /d/:slug/vote           value=up|down|remove                 POST /d/:slug/observe
 *   POST /d/:slug/flag           POST /d/:slug/expire                 POST /d/:slug/comments
 *   GET  /p/:slug                a product: price comparison across offers, each with its time (.json)
 *   GET  /s/:domain              a store's deals
 *   GET  /search?q=              search (noindex)
 *   GET|POST /submit             submit a deal
 *   GET|POST /watches            watches and saved searches; POST /watches/:id/delete
 *   GET  /mod                    moderators: flags (incl. vote rings), reviews, possible duplicates
 *   POST /mod/offers/:slug/(merge|unmerge|disable|enable|review|expire), /mod/flags/:id/(resolve|dismiss)
 *   GET  /feed.xml /atom.xml /feed.json   newest active deals
 *
 * Caching: only pages rendered for an ANONYMOUS visitor are `public, max-age=60`; everything else
 * is `private, no-store`. Pages vary on Cookie and Authorization.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const seo = require('openvibe-publishing/seo');
const ssr = require('openvibe-publishing/ssr');
const { renderPage } = require('../render/layout');
const views = require('../render/views');
const { csrfToken, checkCsrf } = require('../auth/forms');
const { ApiError, iso } = require('../domain/util');

const PER_PAGE = 25;

function createPages(ctx) {
    const { config, store, reads, catalog, publication, listings, offers, votes, watches, flags, community, access, viewers } = ctx;
    const router = express.Router();
    router.use(viewers.middleware({ services: false }));
    const urls = { offerPath: publication.offerPath, productPath: publication.productPath, storePath: publication.storePath };
    const form = express.urlencoded({ extended: false, limit: '32kb' });
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    // ── helpers ─────────────────────────────────────────────

    function cacheHeaders(req, res, { cacheable, robots, status }) {
        res.vary('Cookie');
        res.vary('Authorization');
        if (cacheable && req.viewer.kind === 'anonymous' && status === 200) res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
        else res.set('Cache-Control', 'private, no-store');
        if (robots && robots !== 'index, follow') res.set('X-Robots-Tag', robots);
    }

    function send(req, res, status, page, { cacheable = false } = {}) {
        cacheHeaders(req, res, { cacheable, robots: page.decision.robots, status });
        res.status(status).type('html').send(renderPage({ ...page, viewer: req.viewer, config, path: req.originalUrl }));
    }

    function sendJson(req, res, status, body, decision, { cacheable = true } = {}) {
        cacheHeaders(req, res, { cacheable, robots: decision ? seo.xRobotsTag(decision) : 'noindex', status });
        res.status(status).json(body);
    }

    /** A decision for a page that is not an offer (collections, forms, messages). */
    function pageDecision(path, { indexable = true, empty = false, query = [] } = {}) {
        return seo.evaluate({
            state: indexable ? 'published' : 'draft', visibility: indexable ? 'public' : 'private',
            canonicalUrl: seo.canonicalUrl(config.baseUrl, path, { query }), wordCount: 0, noindex: empty,
        }, { policy: { minWords: 0 }, now: store.now() });
    }

    function messagePage(req, res, status, heading, text, action) {
        send(req, res, status, { title: heading, decision: pageDecision(req.path, { indexable: false }), body: views.message({ heading, text, action }) });
    }
    const notFound = (req, res) => messagePage(req, res, 404, 'Not found', 'There is nothing at this address.', { href: '/', label: 'Hot deals' });

    const pageNumber = (req) => { const n = parseInt(req.query.page, 10); return Number.isInteger(n) && n > 0 ? n : 1; };
    const signedIn = (req) => req.viewer.kind === 'user' && Boolean(req.viewer.subject);
    const csrf = (req) => csrfToken(config, req.viewer);

    /** Form POST guard: signed in, valid form token. → true when the handler may continue. */
    function formGuard(req, res, back) {
        if (!signedIn(req)) { res.redirect(303, `/auth/login?next=${encodeURIComponent(back)}`); return false; }
        if (!checkCsrf(config, req.viewer, req.body && req.body.csrf)) {
            messagePage(req, res, 403, 'This form expired', 'Reload the page and try again.', { href: back, label: 'Back' });
            return false;
        }
        return true;
    }

    /** Run a form action; ApiErrors become a readable page, success redirects back. */
    async function act(req, res, back, fn) {
        if (!formGuard(req, res, back)) return;
        try {
            const target = await fn();
            res.redirect(303, typeof target === 'string' ? target : back);
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            if (err.extra && err.extra.retry_after) res.set('Retry-After', String(err.extra.retry_after));
            messagePage(req, res, err.status, 'That did not work', err.message, err.extra && err.extra.existing ? { href: err.extra.existing.url, label: 'The existing deal' } : { href: back, label: 'Back' });
        }
    }

    // ── lists ───────────────────────────────────────────────

    function listPage(req, res, kind) {
        const page = pageNumber(req);
        const path = kind === 'hot' ? '/' : '/new';
        const total = listings.countActive();
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        const rows = kind === 'hot' ? listings.hot(PER_PAGE, pager.offset) : listings.newest(PER_PAGE, pager.offset);
        const list = rows.map((o) => publication.offerView(o));
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        send(req, res, 200, {
            title: kind === 'hot' ? 'Hot deals' : 'New deals',
            description: 'Deals submitted and voted on by the community, each with its source and the time its price was observed.',
            decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }),
            canonical,
            feeds: [{ type: 'rss', href: '/feed.xml', title: 'New deals (RSS)' }, { type: 'atom', href: '/atom.xml', title: 'New deals (Atom)' }, { type: 'json', href: '/feed.json', title: 'New deals (JSON Feed)' }],
            prev: pager.prev ? pager.prev.href : null,
            next: pager.next ? pager.next.href : null,
            jsonLd: [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'OpenVibe.Deals', url: publication.abs('/'), potentialAction: { '@type': 'SearchAction', target: `${publication.abs('/search')}?q={q}`, 'query-input': 'required name=q' } }],
            body: views.offerList({
                heading: kind === 'hot' ? 'Hot deals' : 'New deals',
                intro: kind === 'hot' ? 'Ranked by community votes over time (hotness formula hot@1). Every price shows when it was observed.' : 'The newest deals first. Every price shows when it was observed.',
                views: list, pager, urls, tabs: views.tabs(kind),
                empty: 'No deals have been posted yet. Submit the first one.',
            }),
        }, { cacheable: true });
    }

    router.get('/', wrap(async (req, res) => listPage(req, res, 'hot')));
    // What shipped on OpenVibe.Deals: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(req, res, 200, {
        title: 'What shipped on OpenVibe.Deals', description: 'Every change deployed to OpenVibe.Deals, newest first.',
        decision: pageDecision('/updates'), canonical: `${config.baseUrl}/updates`,
        body: frame.updatesBody({ service: 'deals', siteName: 'OpenVibe.Deals' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    }, { cacheable: true }));
    router.get('/new', wrap(async (req, res) => listPage(req, res, 'new')));

    // ── offers ──────────────────────────────────────────────

    async function readComments(offer, label, req) {
        if (!community.enabled) return { state: 'unavailable' };
        try {
            const threadId = await community.threadFor(offer, label, req.ov);
            if (!threadId) return { state: 'unavailable' };
            const data = await community.readThread(threadId, { ctx: req.ov });
            return { state: 'ok', comments: data.comments || [] };
        } catch (err) {
            console.warn(`[Deals] comments for ${offer.id} unavailable: ${err.message}`);
            return { state: 'unavailable' };
        }
    }

    async function renderOffer(req, res, offer, { json = false } = {}) {
        const v = publication.offerView(offer);
        const r = v.root;
        const dto = publication.offerDto(v);
        if (r.status === 'disabled') {
            if (json) return sendJson(req, res, 410, { id: r.id, slug: r.slug, status: 'disabled', reason: r.disabled_reason }, v.decision, { cacheable: false });
            return messagePage(req, res, 410, 'This deal was removed', `Moderators removed this deal${r.disabled_reason ? `: ${r.disabled_reason}` : ''}.`, { href: '/', label: 'Hot deals' });
        }
        if (json) return sendJson(req, res, 200, { offer: dto }, v.decision);
        const c = r.status === 'disabled' ? { state: 'off' } : await readComments(r, r.title, req);
        const mergedComments = [];
        for (const m of v.members.slice(0, 3)) {
            const tid = community.enabled ? community.knownThread(m) : null;
            if (!tid) continue;
            try { const data = await community.readThread(tid, { ctx: req.ov }); mergedComments.push({ title: m.title, comments: { state: 'ok', comments: data.comments || [] } }); } catch { mergedComments.push({ title: m.title, comments: { state: 'unavailable' } }); }
        }
        const isMod = access.isStaff(req.viewer);
        const canonical = publication.abs(publication.offerPath(r));
        send(req, res, 200, {
            title: r.title,
            description: `${views.priceText(v.latest)}${v.latest ? ` as of ${views.when(v.latest.observed_at)}` : ''}${v.store ? ` at ${v.store.name || v.store.domain}` : ''}.${r.description ? ` ${r.description.slice(0, 120)}` : ''}`,
            decision: v.decision,
            canonical,
            type: 'website',
            jsonLd: [publication.offerJsonLd(v), seo.structuredData.breadcrumbs([{ name: 'Deals', url: publication.abs('/') }, ...(v.store ? [{ name: v.store.name || v.store.domain, url: publication.abs(publication.storePath(v.store)) }] : []), { name: r.title, url: canonical }])],
            body: views.offerPage({
                v, dto, viewer: req.viewer, csrf: csrf(req), myVote: signedIn(req) ? votes.mine(req.viewer.subject, r) : 0,
                comments: c, mergedComments, canEdit: access.canEdit(req.viewer, r), isMod,
                log: isMod ? offers.moderationLog(r) : null, flags: isMod ? flags.forOffer(v.ids).map(flags.dto) : null, urls,
                notice: req.query.done ? { text: { vote: 'Your vote is recorded.', observe: 'Thanks — your observation is recorded with the time you saw it.', flag: 'Thanks — moderators will look at your report.', expire: 'Marked expired.', comment: 'Comment posted.', moderated: 'Done.' }[req.query.done] || 'Done.' } : null,
            }),
        }, { cacheable: true });
    }

    function offerFor(req, res) {
        const slug = String(req.params.slug || '');
        const json = slug.endsWith('.json');
        const offer = reads.find(json ? slug.slice(0, -5) : slug);
        if (!offer) { notFound(req, res); return null; }
        if (offer.merged_into) {
            const root = reads.root(offer);
            res.set('Cache-Control', 'public, max-age=300');
            res.redirect(301, `${publication.offerPath(root)}${json ? '.json' : ''}`);
            return null;
        }
        return { offer, json };
    }

    router.get('/d/:slug', wrap(async (req, res) => {
        const f = offerFor(req, res);
        if (f) await renderOffer(req, res, f.offer, { json: f.json });
    }));

    const back = (req) => `/d/${encodeURIComponent(req.params.slug)}`;
    const ip = (req) => req.ip || null;

    router.post('/d/:slug/vote', form, wrap(async (req, res) => act(req, res, back(req), () => {
        const value = { up: 1, down: -1, remove: 0 }[String(req.body.value || '')];
        if (value === undefined) throw new ApiError(422, 'request.invalid', 'Choose hot, cold or remove');
        if (value === 0) votes.remove(req.viewer, req.params.slug, { ip: ip(req), traceparent: req.ov && req.ov.traceparent });
        else votes.set(req.viewer, req.params.slug, value, { ip: ip(req), traceparent: req.ov && req.ov.traceparent });
        return `${back(req)}?done=vote`;
    })));

    router.post('/d/:slug/observe', form, wrap(async (req, res) => act(req, res, back(req), () => {
        offers.observe(req.viewer, req.params.slug, req.body, { ip: ip(req), traceparent: req.ov && req.ov.traceparent });
        return `${back(req)}?done=observe#history`;
    })));

    router.post('/d/:slug/flag', form, wrap(async (req, res) => act(req, res, back(req), () => {
        flags.report(req.viewer, req.params.slug, req.body, { ip: ip(req) });
        return `${back(req)}?done=flag`;
    })));

    router.post('/d/:slug/expire', form, wrap(async (req, res) => act(req, res, back(req), () => {
        offers.expire(req.viewer, req.params.slug, {}, { traceparent: req.ov && req.ov.traceparent });
        return `${back(req)}?done=expire`;
    })));

    router.post('/d/:slug/comments', form, wrap(async (req, res) => act(req, res, back(req), async () => {
        const root = reads.root(reads.mustFind(req.params.slug));
        if (root.status === 'disabled') throw new ApiError(409, 'offer.disabled', 'This deal was removed');
        const message = String(req.body.message || '').trim().slice(0, 4000);
        if (!message) return `${back(req)}#comments`;
        if (!community.enabled) throw new ApiError(503, 'comments.unavailable', 'Comments are not available right now');
        try {
            const threadId = await community.threadFor(root, root.title, req.ov);
            await community.comment(threadId, req.viewer.subject, { message }, req.ov);
        } catch (err) {
            throw new ApiError(err.status && err.status < 500 ? err.status : 503, 'comments.unavailable', `Community did not accept the comment: ${err.message}`);
        }
        return `${back(req)}?done=comment#comments`;
    })));

    // ── products and stores ─────────────────────────────────

    router.get('/p/:slug', wrap(async (req, res) => {
        const slug = String(req.params.slug || '');
        const json = slug.endsWith('.json');
        const product = catalog.productBySlug(json ? slug.slice(0, -5) : slug);
        if (!product) return notFound(req, res);
        const pv = publication.productView(product);
        if (json) {
            return sendJson(req, res, 200, {
                product: { id: product.id, slug: product.slug, name: product.name, brand: product.brand, category: product.category, url: publication.abs(publication.productPath(product)), aliases: pv.aliases.map((a) => ({ kind: a.kind, value: a.value })) },
                offers: pv.offers.map((v) => { const d = publication.offerDto(v); return { id: d.id, slug: d.slug, url: d.url, title: d.title, status: d.status, store: d.store, latest_observation: d.latest_observation, freshness: d.freshness }; }),
                indexability: { indexable: pv.decision.indexable, robots: pv.decision.robots, reasons: pv.decision.reasons },
            }, pv.decision);
        }
        const canonical = publication.abs(publication.productPath(product));
        send(req, res, 200, {
            title: `${product.name} — price comparison`,
            description: `Offers for ${product.name}, each with the time its price was observed.`,
            decision: pv.decision, canonical,
            jsonLd: [publication.productJsonLd(pv), seo.structuredData.breadcrumbs([{ name: 'Deals', url: publication.abs('/') }, { name: product.name, url: canonical }])],
            body: views.productPage({ pv, urls }),
        }, { cacheable: true });
    }));

    router.get('/s/:domain', wrap(async (req, res) => {
        const st = catalog.storeByDomain(req.params.domain);
        if (!st) return notFound(req, res);
        const path = publication.storePath(st);
        const total = listings.countStore(st.id);
        const pager = ssr.paginate({ page: pageNumber(req), perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return notFound(req, res);
        const list = listings.byStore(st.id, PER_PAGE, pager.offset).map((o) => publication.offerView(o));
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        send(req, res, 200, {
            title: `Deals at ${st.name || st.domain}`, decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }), canonical,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            body: views.storePage({ st, views: list, pager, urls }),
        }, { cacheable: true });
    }));

    // ── search ──────────────────────────────────────────────

    router.get('/search', wrap(async (req, res) => {
        const q = String(req.query.q || '').slice(0, 200);
        const page = pageNumber(req);
        const r = q ? listings.search(q, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE }) : { total: 0, rows: [] };
        const pager = q ? ssr.paginate({ page, perPage: PER_PAGE, total: r.total, href: (p) => `/search?q=${encodeURIComponent(q)}&page=${p}` }) : null;
        send(req, res, 200, {
            title: q ? `Search: ${q}` : 'Search deals',
            decision: pageDecision('/search', { indexable: false }),
            body: views.searchPage({ q, results: r.rows.map((o) => publication.offerView(o)), pager, urls, csrf: csrf(req), signedIn: signedIn(req) }),
        });
    }));

    // ── submit ──────────────────────────────────────────────

    router.get('/submit', wrap(async (req, res) => {
        if (!signedIn(req)) {
            return send(req, res, 200, { title: 'Submit a deal', decision: pageDecision('/submit', { indexable: false }), body: views.message({ heading: 'Submit a deal', text: 'Sign in with your OpenVibe account to submit a deal.', action: { href: '/auth/login?next=%2Fsubmit', label: 'Sign in' } }) });
        }
        send(req, res, 200, { title: 'Submit a deal', decision: pageDecision('/submit', { indexable: false }), body: views.submitForm({ csrf: csrf(req) }) });
    }));

    router.post('/submit', form, wrap(async (req, res) => {
        if (!formGuard(req, res, '/submit')) return;
        const b = req.body || {};
        const input = {
            url: b.url, title: b.title, description: b.description, price: b.price, currency: b.currency, shipping: b.shipping,
            shipping_note: b.shipping_note, condition: b.condition, availability: b.availability, store_name: b.store_name,
            // datetime-local has no zone: it is read as UTC, and the form says so on the page it renders.
            expires_at: b.expires_at ? `${b.expires_at}${/Z|[+-]\d\d:\d\d$/.test(b.expires_at) ? '' : 'Z'}` : null,
            product: b.product_name || b.product_gtin ? { name: b.product_name, gtin: b.product_gtin } : null,
        };
        try {
            const { offer } = offers.submit(req.viewer, input, { ip: ip(req), traceparent: req.ov && req.ov.traceparent });
            res.redirect(303, publication.offerPath(offer));
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            if (err.code === 'offer.duplicate') return res.redirect(303, `${new URL(err.extra.existing.url).pathname}?duplicate=1`);
            send(req, res, err.status, { title: 'Submit a deal', decision: pageDecision('/submit', { indexable: false }), body: views.submitForm({ csrf: csrf(req), values: b, error: err.message }) });
        }
    }));

    // ── watches ─────────────────────────────────────────────

    function watchesPage(req, res, status = 200, { error, notice } = {}) {
        const list = watches.list(req.viewer.subject).map(watches.dto);
        send(req, res, status, { title: 'Watches', decision: pageDecision('/watches', { indexable: false }), body: views.watchesPage({ csrf: csrf(req), watches: list, error, notice, urls }) });
    }

    router.get('/watches', wrap(async (req, res) => {
        if (!signedIn(req)) return send(req, res, 200, { title: 'Watches', decision: pageDecision('/watches', { indexable: false }), body: views.message({ heading: 'Watches', text: 'Sign in to watch keywords, products and prices, and to save searches.', action: { href: '/auth/login?next=%2Fwatches', label: 'Sign in' } }) });
        watchesPage(req, res);
    }));

    router.post('/watches', form, wrap(async (req, res) => {
        if (!formGuard(req, res, '/watches')) return;
        try {
            const b = req.body || {};
            watches.create(req.viewer.subject, { kind: b.kind, query: b.query, product: b.product || null, max_price: b.max_price, currency: b.currency, label: b.label });
            res.redirect(303, '/watches');
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            watchesPage(req, res, err.status, { error: err.message });
        }
    }));

    router.post('/watches/:id/delete', form, wrap(async (req, res) => act(req, res, '/watches', () => {
        watches.remove(req.viewer.subject, req.params.id);
        return '/watches';
    })));

    // ── moderation ──────────────────────────────────────────

    function modGuard(req, res) {
        if (!signedIn(req)) { res.redirect(303, '/auth/login?next=%2Fmod'); return false; }
        if (!access.isStaff(req.viewer)) { messagePage(req, res, 403, 'Moderators only', 'This page is for OpenVibe moderators.'); return false; }
        return true;
    }

    router.get('/mod', wrap(async (req, res) => {
        if (!modGuard(req, res)) return;
        const dups = listings.possibleDuplicates().map((d) => ({ a: reads.get(d.a), b: reads.get(d.b) }));
        send(req, res, 200, {
            title: 'Moderation', decision: pageDecision('/mod', { indexable: false }),
            body: views.modPage({ csrf: csrf(req), flags: flags.list({ status: 'open' }).map(flags.dto), pending: listings.pendingReview(), duplicates: dups, urls }),
        });
    }));

    router.post('/mod/offers/:slug/:action', form, wrap(async (req, res) => {
        if (!modGuard(req, res)) return;
        const tp = { traceparent: req.ov && req.ov.traceparent };
        await act(req, res, `/d/${encodeURIComponent(req.params.slug)}`, () => {
            const b = req.body || {};
            switch (req.params.action) {
                case 'merge': { const out = offers.merge(req.viewer, req.params.slug, b.into, { reason: b.reason }, tp); return `${publication.offerPath(out.offer)}?done=moderated`; }
                case 'unmerge': { const out = offers.unmerge(req.viewer, req.params.slug, { reason: b.reason }, tp); return `${publication.offerPath(out.offer)}?done=moderated`; }
                case 'disable': offers.disable(req.viewer, req.params.slug, { reason: b.reason }, tp); return '/mod';
                case 'enable': offers.enable(req.viewer, req.params.slug, { reason: b.reason }, tp); break;
                case 'review': offers.review(req.viewer, req.params.slug, { note: b.note }, tp); break;
                case 'expire': offers.expire(req.viewer, req.params.slug, { reason: b.reason }, tp); break;
                default: throw new ApiError(404, 'route.not_found', 'No such action');
            }
            return `/d/${encodeURIComponent(reads.root(reads.mustFind(req.params.slug)).slug)}?done=moderated`;
        });
    }));

    router.post('/mod/flags/:id/:action', form, wrap(async (req, res) => {
        if (!modGuard(req, res)) return;
        await act(req, res, '/mod', () => {
            const status = { resolve: 'resolved', dismiss: 'dismissed' }[req.params.action];
            if (!status) throw new ApiError(404, 'route.not_found', 'No such action');
            flags.resolve(req.viewer, req.params.id, { status, resolution: req.body.resolution });
            return '/mod';
        });
    }));

    // ── feeds (never viewer-dependent) ──────────────────────

    function feedItems() {
        return listings.newest(50, 0).map((o) => {
            const v = publication.offerView(o);
            const price = `${views.priceText(v.latest)}${v.latest ? ` as of ${iso(v.latest.observed_at)}` : ''}`;
            return {
                id: `deals:offer:${o.id}`, url: publication.abs(publication.offerPath(o)), title: o.title,
                summary: `${price}${v.store ? ` at ${v.store.name || v.store.domain}` : ''}.${o.description ? ` ${o.description.slice(0, 300)}` : ''}`,
                published: o.created_at, updated: Math.max(o.updated_at, v.latest ? v.latest.observed_at : 0), decision: v.decision,
            };
        });
    }
    const channel = () => ({ title: 'OpenVibe.Deals — new deals', link: publication.abs('/new'), description: 'New deals, each with its source and the time its price was observed.', language: 'en' });

    router.get('/feed.xml', (_req, res) => res.type('application/rss+xml').set('Cache-Control', 'public, max-age=300').send(seo.rssFeed({ ...channel(), feedUrl: publication.abs('/feed.xml') }, feedItems())));
    router.get('/atom.xml', (_req, res) => {
        const items = feedItems();
        res.type('application/atom+xml').set('Cache-Control', 'public, max-age=300').send(seo.atomFeed({ ...channel(), feedUrl: publication.abs('/atom.xml'), ...(items.length ? {} : { updated: store.now() }) }, items));
    });
    router.get('/feed.json', (_req, res) => res.type('application/feed+json').set('Cache-Control', 'public, max-age=300').send(JSON.stringify(seo.jsonFeed({ ...channel(), feedUrl: publication.abs('/feed.json') }, feedItems()))));

    return { router, notFound, messagePage };
}

module.exports = { createPages };
