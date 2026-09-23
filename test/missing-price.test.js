'use strict';
/**
 * "Never fabricate missing prices": an unknown price stays unknown in the page, the JSON, JSON-LD,
 * the price comparison, feeds and Search.
 */
const assert = require('assert');
const { boot, check, done, jsonLd, HOUR } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    let noPrice;

    await check('a deal submitted without a price says "Price not stated"; JSON has null; JSON-LD Offer has no price at all', async () => {
        noPrice = await t.submit(alice, { url: 'https://store.example/lamp', title: 'Desk lamp clearance', product_name: 'Acme desk lamp', product_gtin: '0012345678905' });
        const page = await t.get(`/d/${noPrice.slug}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /Price not stated/);
        assert.match(page.text, /data-price=""/);
        const json = await t.offerJson(noPrice.slug);
        assert.strictEqual(json.latest_observation.price, null);
        assert.strictEqual(json.latest_observation.currency, null);
        assert.strictEqual(json.latest_observation.availability, null);
        const ld = jsonLd(page.text).find((x) => x['@type'] === 'Product');
        assert.strictEqual(ld.offers.length, 1);
        const o = ld.offers[0];
        assert.strictEqual(o['@type'], 'Offer');
        for (const k of ['price', 'priceCurrency', 'availability', 'itemCondition', 'lowPrice', 'highPrice']) assert.ok(!(k in o), `JSON-LD must omit ${k}: ${JSON.stringify(o)}`);
        assert.doesNotMatch(JSON.stringify(ld), /"price":\s*"?0/);
    });

    await check('a price without a currency is refused (422), never completed with an assumed currency', async () => {
        const r = await t.get('/submit', { as: alice, form: { url: 'https://store.example/x', title: 'Currency test', price: '10' } });
        assert.strictEqual(r.status, 422);
        assert.match(r.text, /needs its currency/);
        assert.strictEqual(t.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM deal_offers WHERE url = 'https://store.example/x'").get().n, 0);
        const bad = await t.get('/submit', { as: alice, form: { url: 'https://store.example/y', title: 'Symbol test', price: '$10', currency: 'USD' } });
        assert.strictEqual(bad.status, 422);
    });

    await check('the price comparison ranks fresh stated prices first; unknown and stale never sort as cheap', async () => {
        const product = t.ctx.catalog.product(noPrice.product_id);
        // An older, cheaper offer that goes stale, then a fresh one with a stated price.
        const stale = await t.submit(alice, { url: 'https://cheap.example/lamp', title: 'Desk lamp at Cheap', price: '5.00', currency: 'USD', product_name: 'Acme desk lamp' });
        assert.strictEqual(stale.product_id, product.id, 'product resolved by its name alias');
        t.clock.advance(50 * HOUR);
        const fresh = await t.submit(alice, { url: 'https://fair.example/lamp', title: 'Desk lamp at Fair', price: '30.00', currency: 'USD', product_gtin: '12345678905' });
        assert.strictEqual(fresh.product_id, product.id, 'product resolved by GTIN (normalised)');
        // noPrice is stale too by now; refresh it with an availability-only observation (still no price).
        const obs = await t.get(`/d/${noPrice.slug}/observe`, { as: alice, form: { availability: 'in_stock' } });
        assert.strictEqual(obs.status, 303);
        const r = await t.get(`/p/${product.slug}.json`);
        const order = r.json().offers.map((o) => [o.slug, o.latest_observation.price, o.freshness.state]);
        assert.deepStrictEqual(order.map((x) => x[0]), [fresh.slug, noPrice.slug, stale.slug], JSON.stringify(order));
        assert.deepStrictEqual(order.map((x) => x[1]), ['30.00', null, '5.00']);
        assert.deepStrictEqual(order.map((x) => x[2]), ['fresh', 'fresh', 'stale']);
        const page = await t.get(`/p/${product.slug}`);
        assert.match(page.text, /Price not stated/);
        const ld = jsonLd(page.text).find((x) => x['@type'] === 'Product');
        assert.strictEqual(ld.gtin, '0012345678905');
        const prices = ld.offers.map((o) => o.price);
        assert.deepStrictEqual(prices, ['30.00', undefined, undefined], 'only the fresh stated price reaches structured data');
    });

    await check('a price in an imported headline is not parsed into a price', async () => {
        t.sources.put(sourceItem({ id: 'itm_01K5ZZZZZZZZZZZZZZZZZZZZZ2', kind: 'article', title: 'Acme blender for $19 + free shipping', url: 'https://deals.example/blender', retrievedAt: t.clock.now() }));
        await t.ctx.importer.pull();
        const o = t.ctx.store.db.prepare("SELECT * FROM deal_offers WHERE url = 'https://deals.example/blender'").get();
        const json = await t.offerJson(o.slug);
        assert.strictEqual(json.latest_observation.price, null);
        assert.strictEqual(json.latest_observation.currency, null);
    });

    await check('a malformed imported price stays null (never repaired)', async () => {
        t.sources.put(sourceItem({ id: 'itm_01K5ZZZZZZZZZZZZZZZZZZZZZ3', title: 'Weird price', url: 'https://deals.example/weird', fields: { price: 'call us', currency: 'USD', availability: 'SomethingElse' }, retrievedAt: t.clock.now() }));
        await t.ctx.importer.pull();
        const o = t.ctx.store.db.prepare("SELECT * FROM deal_offers WHERE url = 'https://deals.example/weird'").get();
        const json = await t.offerJson(o.slug);
        assert.strictEqual(json.latest_observation.price, null);
        assert.strictEqual(json.latest_observation.availability, null, 'an unknown availability term is not guessed');
    });

    await check('feeds and the Search document say "not stated", never 0', async () => {
        const feed = await t.get('/feed.json');
        const item = feed.json().items.find((i) => i.url.endsWith(noPrice.slug));
        assert.match(item.summary, /Price not stated/);
        const doc = t.events('deals.index_document.upserted').filter((e) => e.payload.id === noPrice.id).pop().payload;
        assert.match(doc.body, /price not stated/);
        assert.strictEqual(doc.facets.currency, undefined);
    });

    await t.close();
    done();
})();
