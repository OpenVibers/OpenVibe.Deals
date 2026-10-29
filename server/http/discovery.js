'use strict';

/**
 * Crawl and machine-readability artifacts (roadmap §32.4/§32.5):
 *
 *   GET /robots.txt             sitemap location + explicit automated-consumer policy
 *   GET /llms.txt               orientation for language models
 *   GET /llms-full.txt          the same header plus a short summary of every indexable deal (never
 *                               the full source text)
 *   GET /sitemap.xml            sitemap index over the sections below
 *   GET /sitemaps/offers.xml    offers the gate calls indexable RIGHT NOW (fresh observation, not
 *                               expired, reviewed where review is needed); lastmod = the latest
 *                               observation or edit, never "now"
 *   GET /sitemaps/products.xml  product pages with at least one fresh offer
 *   GET /sitemaps/pages.xml     the front page and the lists: hot, new, ending soon, picks, every category and shop,
 *                               crowdfunding (an empty list is noindex and left out)
 *
 * Built from the database, never from the viewer (the offer and product lists at most once per
 * config.sitemapTtlMs, shared by concurrent readers). Stale, expired, disabled, merged and unreviewed
 * offers never appear.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const sharedSeo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { SITE_SUMMARY } = require('../render/layout');

// Offers or products whose page view a list build reads at once (the pool has a handful of connections for everyone).
const VIEWS_PARALLEL = 8;

/** fn over items, `limit` at a time; results in the items' order. */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/** One build at a time, shared by the readers that ask while it runs, reused for ttlMs (0: the next read rebuilds). */
function shared(build, ttlMs, now) {
    let value = null; let at = 0; let running = null;
    return async () => {
        if (value && now() - at < ttlMs) return value;
        if (!running) running = build().then((v) => { value = v; at = now(); return v; }).finally(() => { running = null; });
        return await running;
    };
}

function createDiscoveryRoutes({ config, store, publication, listings }) {
    const router = express.Router();
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const xml = (res, body) => res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(body);
    /** A short, whitespace-collapsed summary; the full source text is never included. */
    const brief = (value, max = 200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

    // Every offer's and product's page view, for the sitemaps and /llms-full.txt: built VIEWS_PARALLEL at a time, once
    // for concurrent readers, reused for config.sitemapTtlMs. All at once, each /sitemap.xml queued thousands of
    // queries on the pool for a minute (2026-10-23), and every page waited behind them.
    const ttl = Number(config.sitemapTtlMs) || 0;
    const offerEntries = shared(async () => mapLimit(await listings.indexable(), VIEWS_PARALLEL, async (o) => {
        const v = await publication.offerView(o);
        return { offer: o, view: v, loc: abs(publication.offerPath(o)), lastmod: v.latest ? Math.max(v.latest.observed_at, o.updated_at) : o.updated_at, decision: v.decision };
    }), ttl, store.now);
    const productEntries = shared(async () => mapLimit(await listings.products(), VIEWS_PARALLEL, async (p) => {
        const pv = await publication.productView(p);
        return { loc: abs(publication.productPath(p)), lastmod: Math.max(p.updated_at, ...pv.offers.map((v) => Math.max(v.root.updated_at, v.latest ? v.latest.observed_at : 0))), decision: pv.decision };
    }), ttl, store.now);

    /** The lists a person browses (all indexable while they have something to show); lastmod = their newest deal. */
    async function pageEntries() {
        const decide = (path, empty) => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: abs(path), wordCount: 0, noindex: empty }, { policy: { minWords: 0 }, now: store.now() });
        const newest = (await listings.newest(1, 0))[0];
        const active = await listings.countActive();
        const now = store.now();
        const lists = [
            { path: '/', empty: active === 0, lastmod: newest && newest.created_at },
            { path: '/hot', empty: active === 0, lastmod: newest && newest.created_at },
            { path: '/new', empty: active === 0, lastmod: newest && newest.created_at },
            { path: '/ending', empty: (await listings.countEnding(now, now + 7 * 86400000)) === 0 },
            { path: '/picks', empty: (await listings.countPicks()) === 0 },
            { path: '/crowdfunding', empty: false },
        ];
        const categories = await listings.categories();
        const sellers = await listings.sellers();
        lists.push({ path: '/c', empty: categories.length === 0 }, ...categories.map((c) => ({ path: `/c/${c.slug}`, empty: c.count === 0, lastmod: c.latest })));
        lists.push({ path: '/at', empty: sellers.length === 0 }, ...sellers.map((x) => ({ path: `/at/${x.slug}`, empty: x.count === 0, lastmod: x.latest == null ? null : Number(x.latest) })));
        return lists.map((l) => ({ loc: abs(l.path), lastmod: l.lastmod || null, decision: decide(l.path, l.empty) }));
    }

    router.get('/robots.txt', (_req, res) => {
        const body = [
            '# openvibe.deals automated-consumer policy: search engines and AI crawlers are welcome to read',
            '# public deal, product and store pages, feeds and sitemaps. Prices are observations with times;',
            '# read the "as of" time and the JSON twin (<deal URL>.json) rather than assuming a price is current.',
            '# Agent manifest: https://openvibe.deals/.well-known/agent.json; every public page has a .md twin.',
            '# Forms, sign-in, moderation and the API are not for crawling. Pages decide their own',
            '# indexability (meta robots / X-Robots-Tag): stale or expired deals are noindex. A Disallow is not a noindex.',
            sharedSeo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/submit', '/watches', '/mod', '/search', '/auth/', '/api/', '/internal/'] }),
        ].join('\n');
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(body);
    });

    router.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Deals',
            summary: SITE_SUMMARY,
            details: 'A price on this site is an observation: it has a source and an observed_at time, and it is only claimed "as of" that time. Offers whose latest observation is older than the freshness window are marked stale and are noindex; expired offers are noindex; a price nobody stated is shown as "not stated" and omitted from structured data (never 0). Every deal page has a JSON twin at <deal URL>.json with the full observation history, sources, votes and indexability reasons. Imported and AI-assisted text is noindex until a person reviews it.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'Front page', url: abs('/'), note: 'editors\' picks, newest, ending soon, under $20, categories, shops and crowdfunding' },
                    { title: 'Hot deals', url: abs('/hot') }, { title: 'New deals', url: abs('/new') }, { title: 'Ending soon', url: abs('/ending') },
                    { title: 'Editors\' picks', url: abs('/picks') }, { title: 'Categories', url: abs('/c') }, { title: 'Shops', url: abs('/at') }, { title: 'Crowdfunding', url: abs('/crowdfunding'), note: 'one search across Kickstarter, Indiegogo, GoFundMe, Open Collective and more, and open-source campaigns with what they raised (/crowdfunding.json)' }, { title: 'Sitemap', url: abs('/sitemap.xml') },
                ] },
                { title: 'Feeds', links: [{ title: 'RSS', url: abs('/feed.xml') }, { title: 'Atom', url: abs('/atom.xml') }, { title: 'JSON Feed', url: abs('/feed.json') }] },
                { title: 'Data', links: [
                    { title: 'Deal JSON', url: abs('/new'), note: 'append .json to any deal URL (/d/<slug>.json)' },
                    { title: 'Product JSON', url: abs('/sitemaps/products.xml'), note: 'append .json to any product URL (/p/<slug>.json)' },
                ] },
            ],
        }));
    });

    router.get('/llms-full.txt', async (_req, res) => {
        // The sitemap's gate (indexable RIGHT NOW), each entry as a short summary — the full source
        // text behind an imported deal is never included, and neither is an observation we cannot state.
        const entries = await offerEntries();
        const pages = [];
        for (const e of entries) {
            if (!e.decision.indexable) continue;
            const v = e.view;
            const price = v.latest ? `${v.latest.price} ${v.latest.currency}` : '';
            const text = [brief(v.root.description), price, v.store ? `at ${v.store.name || v.store.domain}` : ''].filter(Boolean).join(' ');
            pages.push({ title: v.root.title, url: e.loc, text });
        }
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsFull({
            site: 'OpenVibe.Deals',
            summary: SITE_SUMMARY,
            base: config.baseUrl,
            maxBytes: 512 * 1024,
            sections: [{ title: 'Deals', pages }],
        }));
    });

    router.get('/sitemap.xml', async (_req, res) => {
        const o = (await offerEntries()).filter((e) => e.decision.indexable).map((e) => e.lastmod).filter(Boolean);
        const p = (await productEntries()).filter((e) => e.decision.indexable).map((e) => e.lastmod).filter(Boolean);
        const g = (await pageEntries()).filter((e) => e.decision.indexable).map((e) => e.lastmod).filter(Boolean);
        const iso = (list) => (list.length ? { lastmod: new Date(Math.max(...list)).toISOString() } : {});
        xml(res, seo.sitemapIndex([{ loc: abs('/sitemaps/pages.xml'), ...iso(g) }, { loc: abs('/sitemaps/offers.xml'), ...iso(o) }, { loc: abs('/sitemaps/products.xml'), ...iso(p) }]));
    });

    router.get('/sitemaps/pages.xml', async (_req, res) => xml(res, seo.sitemap(await pageEntries()).files[0]));

    router.get('/sitemaps/offers.xml', async (_req, res) => xml(res, seo.sitemap(await offerEntries()).files[0]));
    router.get('/sitemaps/products.xml', async (_req, res) => xml(res, seo.sitemap(await productEntries()).files[0]));

    return router;
}

module.exports = { createDiscoveryRoutes };
