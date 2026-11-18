'use strict';
/**
 * GET /api/v1/search (11-18, plan §L.1: openvibe.markets searches Deals' offers first): the /search page's words and
 * matching as JSON, every offer with its latest observation (a price only "as of" its time); empty words answer
 * nothing; limit and offset are bounded; anyone may read it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const [alice] = ['alice'].map((n) => t.network.addUser(n));
    const svc = (caps, client = 'live') => t.network.serviceToken(client, caps);
    const add = (url, title, price) => t.get('/api/v1/offers', { as: svc(['deals.offer.submit']), headers: { 'X-OV-Subject': alice.subject }, json: { url, title, price, currency: 'USD' } });

    await check('the words find their offers, with the price as of its observation', async () => {
        assert.strictEqual((await add('https://shop.example/a', 'Noise cancelling headphones, over-ear', '149.99')).status, 201);
        assert.strictEqual((await add('https://shop.example/b', 'Wireless earbuds with case', '39.00')).status, 201);
        assert.strictEqual((await add('https://shop.example/c', 'Studio headphones for mixing', '89.50')).status, 201);
        const r = await t.get('/api/v1/search?q=headphones');
        assert.strictEqual(r.status, 200, r.text);
        const body = r.json();
        assert.deepStrictEqual([body.q, body.total, body.offers.length], ['headphones', 2, 2]);
        assert.deepStrictEqual(body.offers.map((o) => o.title).sort(), ['Noise cancelling headphones, over-ear', 'Studio headphones for mixing']);
        assert.ok(body.offers.every((o) => o.latest_observation && o.latest_observation.observed_at && o.latest_observation.currency === 'USD'), 'each price has its time');
        const two = (await t.get('/api/v1/search?q=headphones studio')).json();
        assert.deepStrictEqual(two.offers.map((o) => o.title), ['Studio headphones for mixing'], 'every word must match');
    });

    await check('no words, nothing; limit and offset bounded', async () => {
        assert.deepStrictEqual((await t.get('/api/v1/search?q=')).json().offers, []);
        const r = (await t.get('/api/v1/search?q=headphones&limit=1&offset=1')).json();
        assert.deepStrictEqual([r.limit, r.offset, r.offers.length, r.total], [1, 1, 1, 2]);
        assert.strictEqual((await t.get('/api/v1/search?q=headphones&limit=999')).json().limit, 50);
    });

    await done(t);
})().catch((err) => { console.error(err); process.exit(1); });
