'use strict';
/**
 * The sitemaps' offer and product lists (server/http/discovery.js): one build serves every request that arrives while
 * it runs, at most 8 page views at once, reused for DEALS_SITEMAP_TTL_MS (production: 10 minutes; 0 rebuilds). On
 * 2026-10-23 each crawler fetch of /sitemap.xml read every offer's and product's view at once: 5,000-24,000 queries
 * queued on the pool for a minute while every page waited behind them.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createDiscoveryRoutes } = require('../server/http/discovery');

const seen = { now: 0, max: 0, views: 0 };
const tick = () => new Promise((r) => setImmediate(r));
const offers = Array.from({ length: 20 }, (_x, i) => ({ id: `dof_${i}`, slug: `deal-${i}`, updated_at: 1792700000000 + i }));
const indexable = { indexable: true, listable: true, robots: 'index, follow', reasons: [], codes: [] };

function routes(ttlMs, clock) {
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
        indexable: async () => offers, products: async () => [], newest: async () => [], countActive: async () => offers.length,
        countEnding: async () => 0, countPicks: async () => 0, categories: async () => [], sellers: async () => [],
    };
    return createDiscoveryRoutes({ config: { baseUrl: 'https://deals.test', sitemapTtlMs: ttlMs }, store: { now: () => clock.t }, publication, listings });
}

async function serve(router) {
    const app = express().use(router);
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { get: async (p) => { const res = await fetch(base + p); return { status: res.status, text: await res.text() }; }, close: () => server.close() };
}

(async () => {
    const clock = { t: Date.parse('2026-10-23T21:26:00Z') };

    // No reuse (tests, development): concurrent requests share one build; the next request rebuilds.
    let s = await serve(routes(0, clock));
    const [a, b, c] = await Promise.all([s.get('/sitemap.xml'), s.get('/sitemaps/offers.xml'), s.get('/llms-full.txt')]);
    assert.deepStrictEqual([a.status, b.status, c.status], [200, 200, 200]);
    assert.ok(b.text.includes('https://deals.test/d/deal-19'), 'every offer listed');
    assert.strictEqual(seen.views, 20, `three readers, one build (${seen.views} views)`);
    assert.ok(seen.max <= 8 && seen.max >= 2, `at most 8 views at once (saw ${seen.max})`);
    await s.get('/sitemaps/offers.xml');
    assert.strictEqual(seen.views, 40, 'no TTL: rebuilt');
    s.close();

    // DEALS_SITEMAP_TTL_MS: reused inside the window, rebuilt after.
    seen.views = 0;
    s = await serve(routes(600000, clock));
    await s.get('/sitemap.xml');
    clock.t += 9 * 60 * 1000;
    await s.get('/sitemaps/offers.xml');
    assert.strictEqual(seen.views, 20, 'reused inside ten minutes');
    clock.t += 2 * 60 * 1000;
    await s.get('/sitemaps/offers.xml');
    assert.strictEqual(seen.views, 40, 'rebuilt after');
    s.close();
    console.log('sitemap-build: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
