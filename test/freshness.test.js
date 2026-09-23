'use strict';
/**
 * Prices and availability are timestamped and never silently treated as current.
 */
const assert = require('assert');
const { boot, check, done, jsonLd, robotsOf, HOUR } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    let offer;

    await check('a fresh observation is shown "as of" its time, indexable, with the price in JSON-LD', async () => {
        offer = await t.submit(alice, { url: 'https://shop.example/headphones', title: 'Studio headphones', price: '49.99', currency: 'USD', availability: 'in_stock' });
        const page = await t.get(`/d/${offer.slug}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /as of <time datetime="2026-09-22T12:00:00.000Z">2026-09-22 12:00 UTC<\/time>/);
        assert.match(page.text, /data-freshness="fresh"/);
        assert.strictEqual(robotsOf(page.text), 'index, follow');
        const ld = jsonLd(page.text).find((x) => x['@type'] === 'Product');
        assert.strictEqual(ld.offers[0].price, '49.99');
        assert.strictEqual(ld.offers[0].priceCurrency, 'USD');
        assert.strictEqual(ld.offers[0].availability, 'https://schema.org/InStock');
        const json = await t.offerJson(offer.slug);
        assert.strictEqual(json.freshness.state, 'fresh');
        assert.strictEqual(json.latest_observation.observed_at, '2026-09-22T12:00:00.000Z');
        assert.ok(!('current_price' in json) && !('price' in json), 'the offer has no "current price" field, only observations');
    });

    await check('past the freshness window the same price is stale: labelled, noindex (stale_price), out of JSON-LD and sitemaps', async () => {
        t.clock.advance(49 * HOUR);
        const page = await t.get(`/d/${offer.slug}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /data-freshness="stale"/);
        assert.doesNotMatch(page.text, /data-freshness="fresh"/);
        assert.match(page.text, /may no longer be available/);
        assert.match(page.text, /as of <time datetime="2026-09-22T12:00:00.000Z">/);
        assert.strictEqual(robotsOf(page.text), 'noindex, follow');
        assert.strictEqual(page.headers.get('x-robots-tag'), 'noindex, follow');
        const ld = jsonLd(page.text).find((x) => x['@type'] === 'Product');
        const o = ld.offers[0];
        assert.ok(!('price' in o) && !('priceCurrency' in o) && !('availability' in o), `stale JSON-LD must not state a price: ${JSON.stringify(o)}`);
        const json = await t.offerJson(offer.slug);
        assert.strictEqual(json.freshness.state, 'stale');
        assert.deepStrictEqual(json.indexability.reasons.map((r) => r.code), ['stale_price']);
        assert.strictEqual(json.latest_observation.price, '49.99', 'history is kept, with its time');
        const sm = await t.get('/sitemaps/offers.xml');
        assert.ok(!sm.text.includes(offer.slug));
        const list = await t.get('/');
        assert.match(list.text, /data-freshness="stale"/);
    });

    await check('nothing on the site calls a price "current"', async () => {
        for (const p of [`/d/${offer.slug}`, '/', '/new', `/d/${offer.slug}.json`, '/feed.xml', '/llms.txt']) {
            const r = await t.get(p);
            assert.doesNotMatch(r.text, /current price|price now:/i, p);
        }
    });

    await check('the worker re-indexes a price that went stale: one new Search document (noindex), then nothing', async () => {
        const before = t.events('deals.index_document.upserted').filter((e) => e.payload.id === offer.id);
        await t.ctx.worker.tick();
        const after = t.events('deals.index_document.upserted').filter((e) => e.payload.id === offer.id);
        assert.strictEqual(after.length, before.length + 1);
        const doc = after[after.length - 1].payload;
        assert.strictEqual(doc.facets.freshness, 'stale');
        assert.strictEqual(doc.indexability.decision, 'noindex');
        assert.ok(doc.revision > before[before.length - 1].payload.revision);
        await t.ctx.worker.tick();
        assert.strictEqual(t.events('deals.index_document.upserted').filter((e) => e.payload.id === offer.id).length, after.length);
    });

    await check('a new observation makes it fresh again, and the history keeps both, newest first', async () => {
        const r = await t.get(`/d/${offer.slug}/observe`, { as: bob, form: { price: '44.00', currency: 'USD', availability: 'limited' } });
        assert.strictEqual(r.status, 303);
        const json = await t.offerJson(offer.slug);
        assert.strictEqual(json.freshness.state, 'fresh');
        assert.strictEqual(json.latest_observation.price, '44.00');
        assert.deepStrictEqual(json.observations.map((o) => o.price), ['44.00', '49.99']);
        assert.strictEqual(json.observations[0].observed_by, bob.subject);
        const page = await t.get(`/d/${offer.slug}`);
        assert.strictEqual(robotsOf(page.text), 'index, follow');
        assert.strictEqual(jsonLd(page.text).find((x) => x['@type'] === 'Product').offers[0].price, '44.00');
    });

    await check('an imported observation is dated by when the source saw it: old retrieval → stale from the start', async () => {
        t.sources.put(sourceItem({ id: 'itm_01K5ZZZZZZZZZZZZZZZZZZZZZ1', title: 'Old TV offer', url: 'https://tv.example/old', fields: { price: '300', currency: 'EUR' }, retrievedAt: t.clock.now() - 72 * HOUR }));
        await t.ctx.importer.pull();
        const o = t.ctx.store.db.prepare("SELECT * FROM deal_offers WHERE url = 'https://tv.example/old'").get();
        const json = await t.offerJson(o.slug);
        assert.strictEqual(json.latest_observation.observed_at, new Date(t.clock.now() - 72 * HOUR).toISOString());
        assert.strictEqual(json.freshness.state, 'stale');
        assert.ok(json.indexability.reasons.some((r) => r.code === 'stale_price'));
    });

    await check('an offer can never be fresh without an observation: freshness is derived only from observed_at', async () => {
        const v = t.ctx.publication.freshness(null, t.clock.now());
        assert.strictEqual(v.state, 'unobserved');
        const d = t.ctx.publication.decideOffer({ slug: 'x', status: 'active', review_state: 'not_required', text_origin: 'human', expires_at: null }, null, t.clock.now());
        assert.ok(d.codes.includes('stale_price'));
        assert.strictEqual(d.indexable, false);
    });

    await check('an observation dated in the future is refused', async () => {
        const token = t.network.serviceToken('ai', ['deals.offer.update']);
        const r = await t.get(`/api/v1/offers/${offer.id}/observations`, { as: token, headers: { 'X-OV-Subject': bob.subject }, json: { price: '1', currency: 'USD', observed_at: new Date(t.clock.now() + 2 * HOUR).toISOString() } });
        assert.strictEqual(r.status, 422);
    });

    await t.close();
    done();
})();
