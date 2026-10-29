'use strict';
const showcase = require('openvibe-shared/showcase');

/**
 * Public, server-rendered routes — useful without JavaScript (every action is a plain form):
 *
 *   GET  /                       the front page: editors' picks, hot, newest, ending soon, under a price, categories,
 *                                shops and crowdfunding, then how it works and questions (render/home.js)
 *   GET  /hot                    hot deals (hot@1 snapshots)          GET /new    newest deals
 *   GET  /ending                 deals whose stated end is in the next 7 days, soonest first
 *   GET  /picks                  deals a source's editors picked      GET /c, /c/:category   deals by category
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
const cache = require('openvibe-shared/cache-policy');
const ssr = require('openvibe-publishing/ssr');
const { renderPage, SITE_SUMMARY } = require('../render/layout');
const views = require('../render/views');
const home = require('../render/home');
const { csrfToken, checkCsrf } = require('../auth/forms');
const { ApiError, iso } = require('../domain/values');

const PER_PAGE = 25;

function createPages(ctx) {
    const { config, store, reads, catalog, publication, listings, offers, votes, watches, flags, community, access, viewers, actorLimits } = ctx;
    const router = express.Router();
    router.use(viewers.middleware({ services: false }));
    // Per-actor limits on the forms (http/actor-limits.js), before the form is read: each shares its budget
    // with the API route that does the same thing. Reading pages is left to the per-address limits.
    const B = (name) => actorLimits.budget(name);
    const urls = { offerPath: publication.offerPath, productPath: publication.productPath, storePath: publication.storePath, sellerPath: publication.sellerPath, categoryPath: publication.categoryPath };
    const form = express.urlencoded({ extended: false, limit: '32kb' });
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    // ── helpers ─────────────────────────────────────────────

    function cacheHeaders(req, res, { cacheable, robots, status }) {
        res.vary('Cookie');
        res.vary('Authorization');
        if (cacheable && req.viewer.kind === 'anonymous' && status === 200) res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
        else res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (robots && robots !== 'index, follow') res.set('X-Robots-Tag', robots);
    }

    function send(req, res, status, page, { cacheable = false } = {}) {
        cacheHeaders(req, res, { cacheable, robots: page.decision.robots, status });
        // A page with a Markdown twin names it in the Link header, exactly as the agent layer's own responses do.
        if (page.agent) res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(page.canonical, `${String(config.baseUrl).replace(/\/+$/, '')}/llms.txt`).header);
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

    const DAY = 24 * 3600 * 1000;
    const FEEDS = [{ type: 'rss', href: '/feed.xml', title: 'New deals (RSS)' }, { type: 'atom', href: '/atom.xml', title: 'New deals (Atom)' }, { type: 'json', href: '/feed.json', title: 'New deals (JSON Feed)' }];
    /** The list pages: each one's path, heading, intro and rows (newest-first unless said). */
    const LISTS = {
        hot: { path: '/hot', heading: 'Hot deals', intro: 'Ranked by community votes over time (hotness formula hot@1). Every price shows when it was observed.',
            count: async () => await listings.countActive(), rows: async (n, off) => await listings.hot(n, off), empty: 'No deals have been posted yet. Submit the first one.' },
        new: { path: '/new', heading: 'New deals', intro: 'The newest deals first. Every price shows when it was observed.',
            count: async () => await listings.countActive(), rows: async (n, off) => await listings.newest(n, off), empty: 'No deals have been posted yet. Submit the first one.' },
        ending: { path: '/ending', heading: 'Deals ending soon', intro: 'Deals whose source states an end in the next seven days, soonest first. A deal with no stated end is never listed here.',
            description: 'Deals ending in the next seven days, soonest first, each with its stated end, its price and when that price was seen.',
            count: async () => await listings.countEnding(store.now(), store.now() + 7 * DAY), rows: async (n, off) => await listings.endingSoon(store.now(), store.now() + 7 * DAY, n, off), empty: 'No deal states an end in the next seven days.' },
        picks: { path: '/picks', heading: 'Editors\' picks', intro: 'Deals a source\'s editors marked as their picks (DealNews\' staff picks), newest first.',
            description: 'Deals picked by DealNews\' editors, newest first, each with its price and the time it was seen.',
            count: async () => await listings.countPicks(), rows: async (n, off) => await listings.picks(n, off), empty: 'No picks right now.' },
    };

    async function listPage(kind, page = 1) {
        const L = LISTS[kind];
        const path = L.path;
        const total = await L.count();
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return null;
        const list = await Promise.all((await L.rows(PER_PAGE, pager.offset)).map(async (o) => await publication.offerView(o)));
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        return {
            agent: true,
            title: L.heading,
            description: L.description || 'Deals submitted and voted on by the community, each with its source and the time its price was observed.',
            decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }),
            canonical,
            feeds: FEEDS,
            prev: pager.prev ? pager.prev.href : null,
            next: pager.next ? pager.next.href : null,
            body: views.offerList({ heading: L.heading, intro: L.intro, views: list, pager, urls, tabs: views.tabs(kind), empty: L.empty }),
        };
    }

    // ── the front page ──────────────────────────────────────

    // "Under $20": the most common currency's round limit. A card shows only a fresh, stated price at or below it.
    const UNDER = { amount: 20, currency: 'USD' };
    const HOME_CARDS = 8;

    async function homePage() {
        const now = store.now();
        const fresh = now - config.freshnessMs;
        const [total, sellers, categories, seenDay, endingWeek, cf] = await Promise.all([
            listings.countActive(), listings.sellers(), listings.categories(), listings.seenSince(now - DAY),
            listings.countEnding(now, now + 7 * DAY), ctx.campaigns ? ctx.campaigns.list({ sort: 'backers', limit: 6 }) : { total: 0, campaigns: [] },
        ]);
        // A deal shows once: picks and hot lead, the newest follow, and "under $20" skips all of those. "Ending soon"
        // skips only the picks and hot ones (a new deal that ends this week belongs there too). The candidates' cards are
        // read in parallel, then dealt out in that order.
        const [pickRows, upRows, newRows, endRows, underRows] = await Promise.all([
            listings.picks(HOME_CARDS * 2, 0), listings.upvoted(HOME_CARDS * 2), listings.newest(HOME_CARDS * 3, 0),
            listings.endingSoon(now, now + 7 * DAY, HOME_CARDS * 2, 0), listings.under(UNDER.amount, UNDER.currency, fresh, HOME_CARDS * 4),
        ]);
        const viewOf = new Map();
        for (const o of [...pickRows, ...upRows, ...newRows, ...endRows, ...underRows]) if (!viewOf.has(o.id)) viewOf.set(o.id, publication.cardView(o, now));
        await Promise.all(viewOf.values());
        const top = new Set();
        const shown = new Set();
        const take = async (rows, { skip = shown, keep = () => true, into = [top, shown] } = {}) => {
            const out = [];
            for (const o of rows) {
                if (out.length >= HOME_CARDS || skip.has(o.id)) continue;
                const v = await viewOf.get(o.id);
                if (!keep(v)) continue;
                for (const set of into) set.add(o.id);
                out.push(v);
            }
            return out;
        };
        const picks = await take(pickRows);
        const upvoted = await take(upRows);
        const latest = await take(newRows, { into: [shown] });
        const ending = await take(endRows, { skip: top, into: [shown] });
        const under = await take(underRows, {
            into: [shown], keep: (v) => v.freshness.state === 'fresh' && v.latest && v.latest.currency === UNDER.currency && Number(v.latest.price) <= UNDER.amount,
        });
        const faq = home.faqItems({ freshnessHours: Math.round(config.freshnessMs / 3600000) });
        const listed = [...picks, ...upvoted, ...latest];
        return {
            agent: true,
            title: 'Today\'s deals, every price with its time',
            description: 'Deals from Amazon, Walmart, Best Buy and more, by shop, category and end date, with price watches and crowdfunding. Every price says when it was seen.',
            // The home page carries the site summary an AI can read (ai-summary meta + WebPage JSON-LD).
            summary: SITE_SUMMARY, styles: [showcase.STYLESHEET],
            decision: pageDecision('/', { empty: total === 0 }),
            canonical: seo.canonicalUrl(config.baseUrl, '/'),
            feeds: FEEDS,
            jsonLd: [
                { '@context': 'https://schema.org', '@type': 'WebSite', name: 'OpenVibe.Deals', url: publication.abs('/'), potentialAction: { '@type': 'SearchAction', target: `${publication.abs('/search')}?q={q}`, 'query-input': 'required name=q' } },
                ...(listed.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: 'Deals on OpenVibe.Deals', itemListElement: listed.map((v, i) => ({ '@type': 'ListItem', position: i + 1, url: publication.abs(publication.offerPath(v.root)), name: v.root.title })) }] : []),
                home.faqJsonLd(faq),
            ],
            bodyClass: 'home',
            body: home.homePage({
                empty: total === 0, freshnessHours: Math.round(config.freshnessMs / 3600000), faq,
                stats: { active: total, shops: sellers.length, seenDay, endingWeek, categories: categories.length, campaigns: cf.total },
                picks, upvoted, latest, ending, under, underLimit: UNDER, categories, sellers, campaigns: cf.campaigns,
            }, urls),
        };
    }

    router.get('/', wrap(async (req, res) => {
        // The hot list's later pages moved to /hot with the front page.
        if (req.query.page && pageNumber(req) > 1) return res.redirect(301, `/hot?page=${pageNumber(req)}`);
        send(req, res, 200, await homePage(), { cacheable: true });
    }));
    const sendList = (kind) => wrap(async (req, res) => {
        const page = await listPage(kind, pageNumber(req));
        if (!page) return notFound(req, res);
        send(req, res, 200, page, { cacheable: true });
    });
    router.get('/hot', sendList('hot'));
    router.get('/ending', sendList('ending'));
    router.get('/picks', sendList('picks'));
    // What shipped on OpenVibe.Deals: the shared update log every OpenVibe site has.
    const updatesPage = () => ({
        agent: true,
        title: 'What shipped on OpenVibe.Deals', description: 'Every change deployed to OpenVibe.Deals, newest first.',
        decision: pageDecision('/updates'), canonical: `${config.baseUrl}/updates`,
        body: frame.updatesBody({ service: 'deals', siteName: 'OpenVibe.Deals' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    });
    router.get('/updates', (req, res) => send(req, res, 200, updatesPage(), { cacheable: true }));
    router.get('/new', sendList('new'));

    // ── offers ──────────────────────────────────────────────

    async function readComments(offer, label, ov) {
        if (!community.enabled) return { state: 'unavailable' };
        try {
            const threadId = await community.threadFor(offer, label, ov);
            if (!threadId) return { state: 'unavailable' };
            const data = await community.readThread(threadId, { ctx: ov });
            return { state: 'ok', comments: data.comments || [] };
        } catch (err) {
            console.warn(`[Deals] comments for ${offer.id} unavailable: ${err.message}`);
            return { state: 'unavailable' };
        }
    }

    /** One public offer, as the route and its Markdown twin (server/agent-pages.js) both render it. */
    async function offerPage(offer, { viewer = { kind: 'anonymous' }, ov = null, notice = null } = {}) {
        const v = await publication.offerView(offer);
        const r = v.root;
        if (r.status === 'disabled') return { status: 410, page: null, removed: r };
        const person = viewer.kind === 'user' && Boolean(viewer.subject);
        const c = await readComments(r, r.title, ov);
        const mergedComments = [];
        for (const m of v.members.slice(0, 3)) {
            const tid = community.enabled ? await community.knownThread(m) : null;
            if (!tid) continue;
            try { const data = await community.readThread(tid, { ctx: ov }); mergedComments.push({ title: m.title, comments: { state: 'ok', comments: data.comments || [] } }); } catch { mergedComments.push({ title: m.title, comments: { state: 'unavailable' } }); }
        }
        const isMod = access.isStaff(viewer);
        const canonical = publication.abs(publication.offerPath(r));
        return {
            status: 200,
            page: {
                agent: true,
                title: r.title,
                description: `${views.priceText(v.latest)}${v.latest ? ` as of ${views.when(v.latest.observed_at)}` : ''}${r.seller ? ` at ${r.seller}` : v.store ? ` at ${v.store.name || v.store.domain}` : ''}.${r.description ? ` ${r.description.slice(0, 120)}` : ''}`,
                decision: v.decision,
                canonical,
                type: 'website',
                jsonLd: [publication.offerJsonLd(v), seo.structuredData.breadcrumbs([{ name: 'Deals', url: publication.abs('/') }, ...(v.store ? [{ name: v.store.name || v.store.domain, url: publication.abs(publication.storePath(v.store)) }] : []), { name: r.title, url: canonical }])],
                body: views.offerPage({
                    v, dto: publication.offerDto(v), viewer, csrf: person ? csrfToken(config, viewer) : '', myVote: person ? await votes.mine(viewer.subject, r) : 0,
                    comments: c, mergedComments, canEdit: access.canEdit(viewer, r), isMod,
                    log: isMod ? await offers.moderationLog(r) : null, flags: isMod ? await Promise.all((await flags.forOffer(v.ids)).map(flags.dto)) : null, urls,
                    notice,
                }),
            },
        };
    }

    /** One public offer by slug for the agent twin, following a merge to its root; null when unknown or removed. */
    async function offerBySlug(slug) {
        const offer = await reads.find(String(slug || ''));
        if (!offer) return null;
        const root = offer.merged_into ? await reads.root(offer) : offer;
        const out = await offerPage(root);
        return out.status === 200 ? out.page : null;
    }

    async function offerFor(req, res) {
        const slug = String(req.params.slug || '');
        const json = slug.endsWith('.json');
        const offer = await reads.find(json ? slug.slice(0, -5) : slug);
        if (!offer) { notFound(req, res); return null; }
        if (offer.merged_into) {
            const root = await reads.root(offer);
            res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
            res.redirect(301, `${publication.offerPath(root)}${json ? '.json' : ''}`);
            return null;
        }
        return { offer, json };
    }

    router.get('/d/:slug', wrap(async (req, res) => {
        const f = await offerFor(req, res);
        if (!f) return;
        if (f.json) {
            const v = await publication.offerView(f.offer);
            const r = v.root;
            if (r.status === 'disabled') return sendJson(req, res, 410, { id: r.id, slug: r.slug, status: 'disabled', reason: r.disabled_reason }, v.decision, { cacheable: false });
            return sendJson(req, res, 200, { offer: publication.offerDto(v) }, v.decision);
        }
        const notice = req.query.done ? { text: { vote: 'Your vote is recorded.', observe: 'Thanks — your observation is recorded with the time you saw it.', flag: 'Thanks — moderators will look at your report.', expire: 'Marked expired.', comment: 'Comment posted.', moderated: 'Done.' }[req.query.done] || 'Done.' } : null;
        const out = await offerPage(f.offer, { viewer: req.viewer, ov: req.ov, notice });
        if (out.status !== 200) return messagePage(req, res, out.status, 'This deal was removed', `Moderators removed this deal${out.removed.disabled_reason ? `: ${out.removed.disabled_reason}` : ''}.`, { href: '/', label: 'Hot deals' });
        send(req, res, 200, out.page, { cacheable: true });
    }));

    const back = (req) => `/d/${encodeURIComponent(req.params.slug)}`;
    const ip = (req) => req.ip || null;

    router.post('/d/:slug/vote', B('deals.vote'), form, wrap(async (req, res) => await act(req, res, back(req), async () => {
        const value = { up: 1, down: -1, remove: 0 }[String(req.body.value || '')];
        if (value === undefined) throw new ApiError(422, 'request.invalid', 'Choose hot, cold or remove');
        if (value === 0) await votes.remove(req.viewer, req.params.slug, { ip: ip(req), traceparent: req.ov && req.ov.traceparent });
        else await votes.set(req.viewer, req.params.slug, value, { ip: ip(req), traceparent: req.ov && req.ov.traceparent });
        return `${back(req)}?done=vote`;
    })));

    router.post('/d/:slug/observe', B('deals.offer.observe'), form, wrap(async (req, res) => await act(req, res, back(req), async () => {
        await offers.observe(req.viewer, req.params.slug, req.body, { ip: ip(req), traceparent: req.ov && req.ov.traceparent });
        return `${back(req)}?done=observe#history`;
    })));

    router.post('/d/:slug/flag', B('deals.flag.create'), form, wrap(async (req, res) => await act(req, res, back(req), async () => {
        await flags.report(req.viewer, req.params.slug, req.body, { ip: ip(req) });
        return `${back(req)}?done=flag`;
    })));

    router.post('/d/:slug/expire', B('deals.offer.update'), form, wrap(async (req, res) => await act(req, res, back(req), async () => {
        await offers.expire(req.viewer, req.params.slug, {}, { traceparent: req.ov && req.ov.traceparent });
        return `${back(req)}?done=expire`;
    })));

    router.post('/d/:slug/comments', B('deals.comment.create'), form, wrap(async (req, res) => await act(req, res, back(req), async () => {
        const root = await reads.root(await reads.mustFind(req.params.slug));
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

    async function productPage(slug) {
        const raw = String(slug || '');
        const json = raw.endsWith('.json');
        const product = await catalog.productBySlug(json ? raw.slice(0, -5) : raw);
        if (!product) return null;
        const pv = await publication.productView(product);
        if (json) return { json: true, product, pv };
        const canonical = publication.abs(publication.productPath(product));
        return {
            status: 200,
            page: {
                agent: true,
                title: `${product.name} — price comparison`,
                description: `Offers for ${product.name}, each with the time its price was observed.`,
                decision: pv.decision, canonical,
                jsonLd: [publication.productJsonLd(pv), seo.structuredData.breadcrumbs([{ name: 'Deals', url: publication.abs('/') }, { name: product.name, url: canonical }])],
                body: views.productPage({ pv, urls }),
            },
        };
    }

    router.get('/p/:slug', wrap(async (req, res) => {
        const out = await productPage(req.params.slug);
        if (!out) return notFound(req, res);
        if (out.json) {
            const { product, pv } = out;
            return sendJson(req, res, 200, {
                product: { id: product.id, slug: product.slug, name: product.name, brand: product.brand, category: product.category, url: publication.abs(publication.productPath(product)), aliases: pv.aliases.map((a) => ({ kind: a.kind, value: a.value })) },
                offers: pv.offers.map((v) => { const d = publication.offerDto(v); return { id: d.id, slug: d.slug, url: d.url, title: d.title, status: d.status, store: d.store, latest_observation: d.latest_observation, freshness: d.freshness }; }),
                indexability: { indexable: pv.decision.indexable, robots: pv.decision.robots, reasons: pv.decision.reasons },
            }, pv.decision);
        }
        send(req, res, 200, out.page, { cacheable: true });
    }));

    async function storePage(domain, page = 1) {
        const st = await catalog.storeByDomain(String(domain || ''));
        if (!st) return null;
        const path = publication.storePath(st);
        const total = await listings.countStore(st.id);
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return null;
        const list = await Promise.all((await listings.byStore(st.id, PER_PAGE, pager.offset)).map(async (o) => await publication.offerView(o)));
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        return {
            agent: true,
            title: `Deals at ${st.name || st.domain}`, decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }), canonical,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            body: views.storePage({ st, views: list, pager, urls }),
        };
    }

    router.get('/s/:domain', wrap(async (req, res) => {
        const page = await storePage(req.params.domain, pageNumber(req));
        if (!page) return notFound(req, res);
        send(req, res, 200, page, { cacheable: true });
    }));

    // ── shops (the seller a source names, migration 0006) ──
    async function sellersIndexPage() {
        const sellers = await listings.sellers();
        return {
            agent: true,
            title: 'Deals by shop', decision: pageDecision('/at', { empty: sellers.length === 0 }), canonical: seo.canonicalUrl(config.baseUrl, '/at'),
            body: views.sellersPage({ sellers }),
        };
    }

    router.get('/at', wrap(async (req, res) => send(req, res, 200, await sellersIndexPage(), { cacheable: true })));

    async function sellerPage(seller, page = 1) {
        const want = String(seller || '').toLowerCase();
        const hit = /^[a-z0-9-]{1,80}$/.test(want) ? (await listings.sellers()).find((x) => x.slug === want) : null;
        if (!hit) return null;
        const path = `/at/${hit.slug}`;
        const total = await listings.countSeller(hit.seller);
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return null;
        const list = await Promise.all((await listings.bySeller(hit.seller, PER_PAGE, pager.offset)).map(async (o) => await publication.offerView(o)));
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        return {
            agent: true,
            title: `Deals at ${hit.seller}`, decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }), canonical,
            description: `${total} deal${total === 1 ? '' : 's'} at ${hit.seller}, each with its source, price and when it was seen.`,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            body: views.sellerPage({ seller: hit.seller, views: list, pager, urls, total }),
        };
    }

    router.get('/at/:seller', wrap(async (req, res) => {
        const page = await sellerPage(req.params.seller, pageNumber(req));
        if (!page) return notFound(req, res);
        send(req, res, 200, page, { cacheable: true });
    }));

    // ── categories (as each deal's source names it, migration 0007) ──
    async function categoriesIndexPage() {
        const categories = await listings.categories();
        return {
            agent: true,
            title: 'Deals by category', decision: pageDecision('/c', { empty: categories.length === 0 }), canonical: seo.canonicalUrl(config.baseUrl, '/c'),
            description: 'Every deal category on OpenVibe.Deals, from TVs to cleaning supplies, with how many active deals each has.',
            body: views.categoriesPage({ categories }),
        };
    }

    router.get('/c', wrap(async (req, res) => send(req, res, 200, await categoriesIndexPage(), { cacheable: true })));

    async function categoryPage(category, page = 1) {
        const want = String(category || '').toLowerCase();
        const hit = /^[a-z0-9-]{1,80}$/.test(want) ? (await listings.categories()).find((x) => x.slug === want) : null;
        if (!hit) return null;
        const path = `/c/${hit.slug}`;
        const total = await listings.countCategory(hit.category);
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total, href: (p) => (p === 1 ? path : `${path}?page=${p}`) });
        if (pager.outOfRange && total) return null;
        const list = await Promise.all((await listings.byCategory(hit.category, PER_PAGE, pager.offset)).map(async (o) => await publication.offerView(o)));
        const canonical = seo.canonicalUrl(config.baseUrl, pager.page === 1 ? path : `${path}?page=${pager.page}`, { query: ['page'] });
        return {
            agent: true,
            title: `${hit.category} deals`, decision: pageDecision(canonical, { empty: total === 0, query: ['page'] }), canonical,
            description: `${total} active ${hit.category} deal${total === 1 ? '' : 's'}, each with its shop, its price and when that price was seen.`,
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            body: views.categoryPage({ category: hit.category, views: list, pager, urls, total }),
        };
    }

    router.get('/c/:category', wrap(async (req, res) => {
        const page = await categoryPage(req.params.category, pageNumber(req));
        if (!page) return notFound(req, res);
        send(req, res, 200, page, { cacheable: true });
    }));

    // ── search ──────────────────────────────────────────────

    router.get('/search', actorLimits.reads('deals.search'), wrap(async (req, res) => {
        const q = String(req.query.q || '').slice(0, 100);
        const page = pageNumber(req);
        const r = q ? await listings.search(q, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE }) : { total: 0, rows: [] };
        const pager = q ? ssr.paginate({ page, perPage: PER_PAGE, total: r.total, href: (p) => `/search?q=${encodeURIComponent(q)}&page=${p}` }) : null;
        send(req, res, 200, {
            title: q ? `Search: ${q}` : 'Search deals',
            decision: pageDecision('/search', { indexable: false }),
            body: views.searchPage({ q, results: await Promise.all(r.rows.map(async (o) => await publication.offerView(o))), pager, urls, csrf: csrf(req), signedIn: signedIn(req) }),
        });
    }));

    // ── submit ──────────────────────────────────────────────

    router.get('/submit', wrap(async (req, res) => {
        if (!signedIn(req)) {
            return send(req, res, 200, { title: 'Submit a deal', decision: pageDecision('/submit', { indexable: false }), body: views.message({ heading: 'Submit a deal', text: 'Sign in with your OpenVibe account to submit a deal.', action: { href: '/auth/login?next=%2Fsubmit', label: 'Sign in' } }) });
        }
        send(req, res, 200, { title: 'Submit a deal', decision: pageDecision('/submit', { indexable: false }), body: views.submitForm({ csrf: csrf(req) }) });
    }));

    router.post('/submit', B('deals.offer.submit'), form, wrap(async (req, res) => {
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
            const { offer } = await offers.submit(req.viewer, input, { ip: ip(req), traceparent: req.ov && req.ov.traceparent });
            res.redirect(303, publication.offerPath(offer));
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            if (err.code === 'offer.duplicate') return res.redirect(303, `${new URL(err.extra.existing.url).pathname}?duplicate=1`);
            send(req, res, err.status, { title: 'Submit a deal', decision: pageDecision('/submit', { indexable: false }), body: views.submitForm({ csrf: csrf(req), values: b, error: err.message }) });
        }
    }));

    // ── watches ─────────────────────────────────────────────

    async function watchesPage(req, res, status = 200, { error, notice } = {}) {
        const list = await Promise.all((await watches.list(req.viewer.subject)).map(watches.dto));
        send(req, res, status, { title: 'Watches', decision: pageDecision('/watches', { indexable: false }), body: views.watchesPage({ csrf: csrf(req), watches: list, error, notice, urls }) });
    }

    router.get('/watches', wrap(async (req, res) => {
        if (!signedIn(req)) return send(req, res, 200, { title: 'Watches', decision: pageDecision('/watches', { indexable: false }), body: views.message({ heading: 'Watches', text: 'Sign in to watch keywords, products and prices, and to save searches.', action: { href: '/auth/login?next=%2Fwatches', label: 'Sign in' } }) });
        await watchesPage(req, res);
    }));

    router.post('/watches', B('deals.watch'), form, wrap(async (req, res) => {
        if (!formGuard(req, res, '/watches')) return;
        try {
            const b = req.body || {};
            await watches.create(req.viewer.subject, { kind: b.kind, query: b.query, product: b.product || null, max_price: b.max_price, currency: b.currency, label: b.label });
            res.redirect(303, '/watches');
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            await watchesPage(req, res, err.status, { error: err.message });
        }
    }));

    router.post('/watches/:id/delete', B('deals.watch'), form, wrap(async (req, res) => await act(req, res, '/watches', async () => {
        await watches.remove(req.viewer.subject, req.params.id);
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
        const dups = await Promise.all((await listings.possibleDuplicates()).map(async (d) => ({ a: await reads.get(d.a), b: await reads.get(d.b) })));
        send(req, res, 200, {
            title: 'Moderation', decision: pageDecision('/mod', { indexable: false }),
            body: views.modPage({ csrf: csrf(req), flags: await Promise.all((await flags.list({ status: 'open' })).map(flags.dto)), pending: await listings.pendingReview(), duplicates: dups, urls }),
        });
    }));

    router.post('/mod/offers/:slug/:action', B('deals.offer.moderate'), form, wrap(async (req, res) => {
        if (!modGuard(req, res)) return;
        const tp = { traceparent: req.ov && req.ov.traceparent };
        await act(req, res, `/d/${encodeURIComponent(req.params.slug)}`, async () => {
            const b = req.body || {};
            switch (req.params.action) {
                case 'merge': { const out = await offers.merge(req.viewer, req.params.slug, b.into, { reason: b.reason }, tp); return `${publication.offerPath(out.offer)}?done=moderated`; }
                case 'unmerge': { const out = await offers.unmerge(req.viewer, req.params.slug, { reason: b.reason }, tp); return `${publication.offerPath(out.offer)}?done=moderated`; }
                case 'disable': await offers.disable(req.viewer, req.params.slug, { reason: b.reason }, tp); return '/mod';
                case 'enable': await offers.enable(req.viewer, req.params.slug, { reason: b.reason }, tp); break;
                case 'review': await offers.review(req.viewer, req.params.slug, { note: b.note }, tp); break;
                case 'expire': await offers.expire(req.viewer, req.params.slug, { reason: b.reason }, tp); break;
                default: throw new ApiError(404, 'route.not_found', 'No such action');
            }
            return `/d/${encodeURIComponent((await reads.root(await reads.mustFind(req.params.slug))).slug)}?done=moderated`;
        });
    }));

    router.post('/mod/flags/:id/:action', B('deals.offer.moderate'), form, wrap(async (req, res) => {
        if (!modGuard(req, res)) return;
        await act(req, res, '/mod', async () => {
            const status = { resolve: 'resolved', dismiss: 'dismissed' }[req.params.action];
            if (!status) throw new ApiError(404, 'route.not_found', 'No such action');
            await flags.resolve(req.viewer, req.params.id, { status, resolution: req.body.resolution }, { traceparent: req.ov && req.ov.traceparent });
            return '/mod';
        });
    }));

    // ── feeds (never viewer-dependent) ──────────────────────

    async function feedItems() {
        return Promise.all((await listings.newest(50, 0)).map(async (o) => {
            const v = await publication.offerView(o);
            const price = `${views.priceText(v.latest)}${v.latest ? ` as of ${iso(v.latest.observed_at)}` : ''}`;
            // A source policy may require attribution: carried as text in the summary and as a tag.
            const via = v.attribution ? `Deal via ${v.attribution.text}` : null;
            return {
                id: `deals:offer:${o.id}`, url: publication.abs(publication.offerPath(o)), title: o.title,
                summary: `${via ? `${via}. ` : ''}${price}${v.root.seller ? ` at ${v.root.seller}` : v.store ? ` at ${v.store.name || v.store.domain}` : ''}.${o.description ? ` ${o.description.slice(0, 300)}` : ''}`,
                tags: via ? [via] : undefined,
                published: o.created_at, updated: Math.max(o.updated_at, v.latest ? v.latest.observed_at : 0), decision: v.decision,
            };
        }));
    }
    const channel = () => ({ title: 'OpenVibe.Deals — new deals', link: publication.abs('/new'), description: 'New deals, each with its source and the time its price was observed.', language: 'en' });

    router.get('/feed.xml', async (_req, res) => res.type('application/rss+xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(seo.rssFeed({ ...channel(), feedUrl: publication.abs('/feed.xml') }, await feedItems())));
    router.get('/atom.xml', async (_req, res) => {
        const items = await feedItems();
        res.type('application/atom+xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(seo.atomFeed({ ...channel(), feedUrl: publication.abs('/atom.xml'), ...(items.length ? {} : { updated: store.now() }) }, items));
    });
    router.get('/feed.json', async (_req, res) => res.type('application/feed+json').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(JSON.stringify(seo.jsonFeed({ ...channel(), feedUrl: publication.abs('/feed.json') }, await feedItems()))));

    // The public pages the agent layer's Markdown twins (server/agent-pages.js) render with the same builders.
    const publicViews = {
        home: homePage, list: listPage, offer: offerBySlug, product: productPage,
        store: storePage, sellers: sellersIndexPage, seller: sellerPage,
        categories: categoriesIndexPage, category: categoryPage, updates: updatesPage,
    };

    return { router, notFound, messagePage, publicViews };
}

module.exports = { createPages };
