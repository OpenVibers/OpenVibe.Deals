'use strict';
/**
 * What the one feed gets from an offer (feed.item@1 1.1.0): the price now, the price before, the shop
 * that sells it and the product's picture. The owner, 11-13: "update the listings for deals".
 *
 * OpenVibe.Network's collector reads these offers (GET /api/v1/offers) and folds a run of them into
 * one card whose items list what each deal costs.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');

(async () => {
    const t = await boot();
    const T0 = t.clock.now();

    await check('an offer carries what it costs, the shop that sells it and its picture', async () => {
        t.sources.put(sourceItem({
            id: 'itm_01K5FEED00000000000000A1', title: 'Espresso machine', url: 'https://coffee.example/espresso',
            retrievedAt: T0,
            fields: {
                price: '249.00', currency: 'EUR', list_price: '299.00', seller: 'Coffee Shop',
                image: 'https://coffee.example/img/espresso.jpg',
            },
        }));
        const summary = await t.ctx.importer.pull();
        assert.strictEqual(summary.outcomes.created, 1, JSON.stringify(summary));
        const offers = (await t.get('/api/v1/offers?sort=new')).json().offers;
        const offer = offers.find((o) => o.title === 'Espresso machine');
        assert.ok(offer, 'the offer is in the list the feed reads');
        assert.deepStrictEqual(offer.feed.price, { amount: 249, currency: 'EUR' }, 'the price, with its currency in upper case');
        assert.strictEqual(offer.feed.was, 299, 'the price it was');
        assert.strictEqual(offer.feed.store, 'Coffee Shop', 'the shop that sells it');
        assert.deepStrictEqual(offer.feed.media, { thumb: 'https://coffee.example/img/espresso.jpg' }, 'the picture of the product');
    });

    await check('the picture is kept as the source stated it, and only when it is https', async () => {
        t.sources.put(sourceItem({
            id: 'itm_01K5FEED00000000000000A2', title: 'Tea kettle', url: 'https://tea.example/kettle',
            retrievedAt: T0, fields: { price: '39.99', currency: 'USD', image: 'http://tea.example/img/kettle.jpg' },
        }));
        await t.ctx.importer.pull();
        const offers = (await t.get('/api/v1/offers?sort=new')).json().offers;
        const offer = offers.find((o) => o.title === 'Tea kettle');
        assert.ok(offer, 'the offer is in the list');
        assert.strictEqual(offer.feed.media, null, 'a picture that is not https is not a picture');
        assert.deepStrictEqual(offer.feed.price, { amount: 39.99, currency: 'USD' }, 'its price is still there');
        assert.strictEqual(offer.feed.was, null, 'no list price stated, so no old price');
    });

    await check('an offer with no price states no price', async () => {
        t.sources.put(sourceItem({
            id: 'itm_01K5FEED00000000000000A3', kind: 'article', title: 'Weekend sale on garden tools',
            url: 'https://news.example/garden', retrievedAt: T0,
        }));
        await t.ctx.importer.pull();
        const offers = (await t.get('/api/v1/offers?sort=new')).json().offers;
        const offer = offers.find((o) => o.title === 'Weekend sale on garden tools');
        assert.ok(offer, 'the offer is in the list');
        assert.strictEqual(offer.feed.price, null, 'no price is never a price of zero');
        assert.strictEqual(offer.feed.was, null);
        assert.strictEqual(offer.feed.media, null);
    });

    await check('a deal a person submitted carries its price too', async () => {
        const alice = t.network.addUser('alice');
        const offer = await t.submit(alice, { url: 'https://shop.example/lamp', title: 'Reading lamp', price: '24.50', currency: 'GBP' });
        assert.ok(offer, 'the offer was submitted');
        const json = await t.offerJson(offer.slug);
        assert.deepStrictEqual(json.feed.price, { amount: 24.5, currency: 'GBP' }, 'the price the person stated');
        assert.strictEqual(json.feed.was, null, 'nothing was said about an old price');
        assert.strictEqual(json.feed.media, null, 'and there is no picture');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
