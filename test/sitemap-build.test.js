'use strict';
/**
 * The sitemaps' offer and product lists (server/http/discovery.js): one build serves every request that arrives while
 * it runs, at most 8 page views at once, reused for DEALS_SITEMAP_TTL_MS (production: 10 minutes; 0 rebuilds). On
 * 2026-10-23 each crawler fetch of /sitemap.xml read every offer's and product's view at once: 5,000-24,000 queries
 * queued on the pool for a minute while every page waited behind them.
 *
 * The catalog is split in SITEMAP_CHILD_MAX-URL chunks: /sitemap.xml names the pages child and one child per chunk,
 * and the chunks hold exactly the URLs (in the same order) the old single catalog sitemap did.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const seo = require('openvibe-publishing/seo');
const { createDiscoveryRoutes } = require('../server/http/discovery');

const seen = { now: 0, max: 0, views: 0 };
const tick = () => new Promise((r) => setImmediate(r));
const indexable = { indexable: true, listable: true, robots: 'index, follow', reasons: [], codes: [] };

function makeOffers(count) {
    return Array.from({ length: count }, (_x, i) => ({ id: `dof_${i}`, slug: `deal-${i}`, updated_at: 1792700000000 + i }));
}

function routes(ttlMs, clock, { offerCount = 20, products = [] } = {}) {
    const offers = makeOffers(offerCount);
    const publication = {
        async offerView(o) {
            seen.now++; seen.views++; seen.max = Math.max(seen.max, seen.now);
            await tick();
            seen.now--;
            return { root: { title: o.slug, description: '' }, latest: { observed_at: o.updated_at, price: '1', currency: 'USD' }, decision: indexable };
        },
        offerPath: (o) => `/d/${o.slug}`,
        async productView() { return { offers: [], decision: indexable }; },
        productPath: (p) => `/p/${p.slug}`,
    };
    const listings = {
        indexable: async () => offers, products: async () => products, newest: async () => [], countActive: async () => offers.length,
        countEnding: async () => 0, countPicks: async () => 0, categories: async () => [], sellers: async () => [],
    };
    return createDiscoveryRoutes({ config: { baseUrl: 'https://deals.test', sitemapTtlMs: ttlMs }, store: { now: () => clock.t }, publication, listings });
}

async function serve(router) {
    const app = express().use(router).use((_req, res) => res.status(404).type('text/plain').send('Not found'));
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { get: async (p) => { const res = await fetch(base + p); return { status: res.status, text: await res.text() }; }, close: () => server.close() };
}

const locs = (text) => [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const maps = (text) => [...text.matchAll(/<sitemap><loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

(async () => {
    const clock = { t: Date.parse('2026-10-23T21:26:00Z') };

    // No reuse (tests, development): concurrent requests share one build; the next request rebuilds.
    let s = await serve(routes(0, clock));
    const [a, b, c] = await Promise.all([s.get('/sitemap.xml'), s.get('/sitemap-0.xml'), s.get('/llms-full.txt')]);
    assert.deepStrictEqual([a.status, b.status, c.status], [200, 200, 200]);
    assert.ok(b.text.includes('https://deals.test/d/deal-19'), 'every offer listed');
    assert.strictEqual(seen.views, 20, `three readers, one build (${seen.views} views)`);
    assert.ok(seen.max <= 8 && seen.max >= 2, `at most 8 views at once (saw ${seen.max})`);
    await s.get('/sitemap-0.xml');
    assert.strictEqual(seen.views, 40, 'no TTL: rebuilt');
    s.close();

    // DEALS_SITEMAP_TTL_MS: reused inside the window, rebuilt after.
    seen.views = 0;
    s = await serve(routes(600000, clock));
    await s.get('/sitemap.xml');
    clock.t += 9 * 60 * 1000;
    await s.get('/sitemap-0.xml');
    assert.strictEqual(seen.views, 20, 'reused inside ten minutes');
    clock.t += 2 * 60 * 1000;
    await s.get('/sitemap-0.xml');
    assert.strictEqual(seen.views, 40, 'rebuilt after');
    s.close();

    // A catalog past 10,000 URLs: the index names every child and the children are the old single sitemap, split.
    const offerCount = 20005;
    const offers = makeOffers(offerCount);
    const products = [{ id: 'dpr_1', slug: 'novel', updated_at: 1792800000000 }];
    s = await serve(routes(0, clock, { offerCount, products }));
    const index = await s.get('/sitemap.xml');
    assert.strictEqual(index.status, 200);
    assert.match(index.text, /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.deepStrictEqual(maps(index.text), [
        'https://deals.test/sitemap-pages.xml',
        'https://deals.test/sitemap-0.xml',
        'https://deals.test/sitemap-1.xml',
        'https://deals.test/sitemap-2.xml',
    ], 'the pages child, then one child per catalog chunk');

    const sizes = [];
    const catalog = [];
    for (const url of maps(index.text)) {
        const child = await s.get(new URL(url).pathname);
        assert.strictEqual(child.status, 200, url);
        assert.match(child.text, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/, url);
        const found = locs(child.text);
        assert.ok(found.length <= 10000, `${url} holds ${found.length} URLs`);
        if (/\/sitemap-\d+\.xml$/.test(url)) { sizes.push(found.length); catalog.push(...found); }
        else assert.ok(found.includes('https://deals.test/') && found.includes('https://deals.test/hot'), 'the pages child');
    }
    assert.deepStrictEqual(sizes, [10000, 10000, 6], 'offers, then products: at most 10,000 a child');

    const oldSingle = seo.sitemap([
        ...offers.map((o) => ({ loc: `https://deals.test/d/${o.slug}`, lastmod: o.updated_at, decision: indexable })),
        ...products.map((p) => ({ loc: `https://deals.test/p/${p.slug}`, lastmod: p.updated_at, decision: indexable })),
    ]).files[0];
    assert.deepStrictEqual(catalog, locs(oldSingle), 'the union of the children is the old catalog sitemap, same order');
    assert.strictEqual(new Set(catalog).size, catalog.length, 'no URL twice');

    // A chunk number past the last one does not exist.
    for (const path of ['/sitemap-3.xml', '/sitemap-99.xml', '/sitemap-00.xml', '/sitemap-01.xml']) {
        assert.strictEqual((await s.get(path)).status, 404, path);
    }
    s.close();
    console.log('sitemap-build: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
