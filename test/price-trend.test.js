'use strict';
/**
 * The price over time (domain/price-trend.js): lowest, highest and the change since first seen, in the
 * latest price's currency only; the offer page's tiles and step line; price_trend in the JSON twin.
 */
const assert = require('assert');
const { priceTrend } = require('../server/domain/price-trend');
const { boot, check, done, HOUR } = require('./helpers/boot');

const obs = (at, price, currency = 'USD', extra = {}) => ({ observed_at: at, price, price_num: price == null ? null : Number(price), currency, ...extra });

(async () => {
    await check('priceTrend: newest-first observations → oldest-first points, lowest, highest, change', async () => {
        const t = priceTrend([obs(4, '64.00'), obs(3, '59.00'), obs(2, '89.00'), obs(1, '79.00')]);
        assert.deepStrictEqual(t.points.map((p) => p.price), ['79.00', '89.00', '59.00', '64.00']);
        assert.strictEqual(t.lowest.price, '59.00');
        assert.strictEqual(t.highest.price, '89.00');
        assert.deepStrictEqual(t.change, { amount: -15, percent: -19 });
        assert.strictEqual(t.atLowest, false);
        assert.strictEqual(t.currency, 'USD');
    });

    await check('priceTrend: only the latest currency, only stated prices, never a removed source', async () => {
        const t = priceTrend([obs(5, '50.00'), obs(4, null), obs(3, '40.00', 'EUR'), obs(2, '30.00', 'USD', { source_removed_at: 9 }), obs(1, '60.00')]);
        assert.deepStrictEqual(t.points.map((p) => p.price), ['60.00', '50.00']);
        assert.strictEqual(t.atLowest, true, 'the latest is the lowest seen');
        assert.strictEqual(priceTrend([obs(1, null)]), null);
        assert.strictEqual(priceTrend([]), null);
        const one = priceTrend([obs(1, '9.99')]);
        assert.strictEqual(one.change, null);
        assert.strictEqual(one.atLowest, false, 'one price is not "the lowest we have seen"');
    });

    await check('priceTrend: the same price twice is no change and not a low; ties keep the earliest time', async () => {
        const t = priceTrend([obs(2, '20'), obs(1, '20')]);
        assert.deepStrictEqual(t.change, { amount: 0, percent: 0 });
        assert.strictEqual(t.atLowest, false);
        assert.strictEqual(t.lowest.at, 1);
    });

    const t = await boot();
    const [alice, bob] = ['alice', 'bob'].map((n) => t.network.addUser(n));

    await check('an offer page with several prices: tiles, a step line naming each point, the table still under it', async () => {
        const deal = await t.submit(alice, { url: 'https://gadgets.example/kettle', title: 'Glass kettle', price: '79.00', currency: 'USD', condition: 'new' });
        const one = await t.get(`/d/${deal.slug}`);
        assert.doesNotMatch(one.text, /class="pc"/, 'one price draws no chart');
        for (const price of ['89.00', '59.00', '64.00']) {
            t.clock.advance(2 * HOUR);
            const r = await t.get(`/d/${deal.slug}/observe`, { as: bob, form: { price, currency: 'USD' } });
            assert.strictEqual(r.status, 303, r.text.slice(0, 200));
        }
        const page = await t.get(`/d/${deal.slug}`);
        assert.match(page.text, /<figure class="pc"/);
        assert.match(page.text, /<dt>Lowest<\/dt><dd><strong>59\.00 USD<\/strong>/);
        assert.match(page.text, /<dt>Highest<\/dt><dd><strong>89\.00 USD<\/strong>/);
        assert.match(page.text, /<dt>Since first seen<\/dt><dd><strong>−15\.00 USD<\/strong><span class="meta">−19% from 79\.00 USD on /);
        assert.match(page.text, /<path class="pc-line" d="M0 [\d.]+H/);
        assert.strictEqual((page.text.match(/class="pc-hit"/g) || []).length, 4, 'every point names its price and time');
        assert.match(page.text, /role="img" aria-label="Price over time in USD: 79\.00 on /);
        assert.ok(page.text.indexOf('class="pc"') < page.text.indexOf('<table class="obs">'), 'the chart sits above the table');

        const json = await t.offerJson(deal.slug);
        assert.strictEqual(json.price_trend.currency, 'USD');
        assert.strictEqual(json.price_trend.observations, 4);
        assert.strictEqual(json.price_trend.lowest.price, '59.00');
        assert.match(json.price_trend.lowest.observed_at, /^\d{4}-\d\d-\d\dT/);
        assert.deepStrictEqual(json.price_trend.change, { amount: -15, percent: -19 });
        assert.strictEqual(json.price_trend.at_lowest, false);

        t.clock.advance(2 * HOUR);
        await t.get(`/d/${deal.slug}/observe`, { as: bob, form: { price: '55.00', currency: 'USD' } });
        const low = await t.get(`/d/${deal.slug}`);
        assert.match(low.text, /class="pc-tile pc-best"><dt>Lowest<\/dt><dd><strong>55\.00 USD<\/strong><span class="meta">the lowest we have seen/);
        assert.strictEqual((await t.offerJson(deal.slug)).price_trend.at_lowest, true);
    });

    await t.close();
    done();
})();
