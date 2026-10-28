'use strict';
/**
 * A crawled source's list price (Sources jsonld@2): kept with its price only when it is in the same
 * currency and greater, shown in the trend/JSON/page, and the three reasons a crawled offer is a
 * deal (list_price, price_drop, watch). Migration 0008 is applied to a database that already has
 * observations, which stay null.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { priceTrend, isDeal, savingOf } = require('../server/domain/price-trend');
const { boot, check, done, HOUR } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');

const at = (n) => 1790000000000 + n * HOUR;
const obs = (n, price, extra = {}) => ({ observed_at: at(n), price, price_num: Number(price), currency: 'USD', ...extra });

(async () => {
    await check('selection is one of list_price, price_drop or watch — and the 5% list-price threshold', async () => {
        assert.strictEqual(isDeal([obs(1, '99.99', { list_price: '129.99', list_price_num: 129.99 })]), 'list_price');
        assert.deepStrictEqual(savingOf({ price: '99.99', price_num: 99.99, list_price: '129.99', list_price_num: 129.99 }), { num: 30, pct: 23 }, 'a 23% saving, rounded down');
        assert.strictEqual(isDeal([obs(1, '100.00', { list_price: '103.00', list_price_num: 103 })]), null, '3% is not enough on its own');
        assert.strictEqual(isDeal([obs(1, '99.75', { list_price: '105.00', list_price_num: 105 })]), 'list_price', '5% is enough');
        assert.strictEqual(isDeal([obs(2, '90.00'), obs(1, '100.00')]), 'price_drop');
        assert.strictEqual(isDeal([obs(3, '90.00'), obs(2, '95.00'), obs(1, '100.00')]), 'price_drop', 'at its lowest');
        assert.strictEqual(isDeal([obs(2, '100.00'), obs(1, '90.00')]), null, 'a rise is not a drop');
        assert.strictEqual(isDeal([obs(1, '90.00')], true), 'watch');
        assert.strictEqual(isDeal([obs(1, '90.00')]), null);
        assert.strictEqual(priceTrend([obs(1, '99.99', { list_price: '129.99', list_price_num: 129.99 })]).latest.saving_pct, 23);
    });

    await check('migration 0008 applies over a database that already has observations; they stay null', async () => {
        const migrations = path.join(__dirname, '..', 'migrations');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deals-lp-migrate-'));
        const db = createDb({ pglite: true, service: 'deals-lp-migration-test' });
        try {
            for (const f of fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
                if (f < '0008') fs.copyFileSync(path.join(migrations, f), path.join(dir, f));
            }
            await db.migrate({ dir, log: { log() {} } });
            await db.query(`INSERT INTO deal_offers (id, slug, title, url, url_norm, origin, created_at, updated_at)
                            VALUES ('dof_old', 'old-deal', 'Old deal', 'https://old.example/deal', 'old.example/deal', 'import', 1, 1)`);
            await db.query(`INSERT INTO deal_offer_sources (id, offer_id, kind, ref_service, ref_type, ref_id, created_at, updated_at)
                            VALUES ('dos_old', 'dof_old', 'sources_item', 'sources', 'item', 'itm_old', 1, 1)`);
            await db.query(`INSERT INTO deal_price_observations (id, offer_id, source_id, observed_at, recorded_at, price, price_num, currency, origin)
                            VALUES ('dpo_old', 'dof_old', 'dos_old', 1, 1, '10.00', 10, 'USD', 'import')`);

            fs.copyFileSync(path.join(migrations, '0008_list_price.sql'), path.join(dir, '0008_list_price.sql'));
            const applied = await db.migrate({ dir, log: { log() {} } });
            assert.deepStrictEqual(applied.applied.map((m) => m.id), ['0008']);

            const old = await db.prepare('SELECT list_price, list_price_num FROM deal_price_observations WHERE id = ?').get('dpo_old');
            assert.deepStrictEqual([old.list_price, old.list_price_num], [null, null], 'an existing observation stays null');
            const offer = await db.prepare('SELECT deal_reason FROM deal_offers WHERE id = ?').get('dof_old');
            assert.strictEqual(offer.deal_reason, null, 'an existing offer has no selection reason');

            await db.query(`INSERT INTO deal_price_observations (id, offer_id, source_id, observed_at, recorded_at, price, price_num, list_price, list_price_num, currency, origin)
                            VALUES ('dpo_new', 'dof_old', 'dos_old', 2, 2, '99.99', 99.99, '129.99', 129.99, 'USD', 'import')`);
            const fresh = await db.prepare('SELECT list_price, list_price_num FROM deal_price_observations WHERE id = ?').get('dpo_new');
            assert.deepStrictEqual([fresh.list_price, fresh.list_price_num], ['129.99', 129.99]);
        } finally {
            await db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    const t = await boot();
    const alice = t.network.addUser('alice');
    const byUrl = async (u) => await t.ctx.store.db.prepare('SELECT * FROM deal_offers WHERE url = ?').get(u);
    const obsOf = async (id) => await t.ctx.store.db.prepare('SELECT * FROM deal_price_observations WHERE offer_id = ? ORDER BY observed_at, seq').all(id);

    await check('a list price 129.99 against 99.99 USD is kept and shown as a 23% saving; other/equal/below list prices are null', async () => {
        t.sources.put(sourceItem({ id: 'itm_LP000000000000000000001', title: 'List price keeper', url: 'https://lp.example/keep', retrievedAt: t.clock.now(),
            fields: { price: '99.99', currency: 'USD', list_price: '129.99' } }));
        await t.ctx.importer.pull();
        const kept = await byUrl('https://lp.example/keep');
        const o = (await obsOf(kept.id))[0];
        assert.deepStrictEqual([o.price, o.list_price, o.list_price_num, o.currency], ['99.99', '129.99', 129.99, 'USD']);
        assert.strictEqual(kept.deal_reason, 'list_price');

        const json = await t.offerJson(kept.slug);
        assert.deepStrictEqual(
            [json.latest_observation.list_price, json.latest_observation.list_price_num, json.latest_observation.saving_num, json.latest_observation.saving_pct],
            ['129.99', 129.99, 30, 23],
        );
        assert.deepStrictEqual(
            [json.price_trend.latest.list_price, json.price_trend.latest.list_price_num, json.price_trend.latest.saving_num, json.price_trend.latest.saving_pct],
            ['129.99', 129.99, 30, 23],
        );
        assert.strictEqual(json.price_trend.at_lowest, false, 'one price is not a drop');
        const page = await t.get(`/d/${kept.slug}`);
        assert.match(page.text, /<s class="dl-list" data-list-price="129\.99">129\.99 USD<\/s> <span class="dl-saving">−23%<\/span>/);

        for (const [suffix, list] of [['equal', '99.99'], ['below', '89.99']]) {
            t.sources.put(sourceItem({ id: `itm_LP0000000000000000000${suffix === 'equal' ? '02' : '03'}`, title: `List price ${suffix}`,
                url: `https://lp.example/${suffix}`, retrievedAt: t.clock.now(), fields: { price: '99.99', currency: 'USD', list_price: list } }));
        }
        t.sources.put(sourceItem({ id: 'itm_LP000000000000000000004', title: 'List price another currency', url: 'https://lp.example/eur', retrievedAt: t.clock.now(),
            fields: { price: '99.99', currency: 'USD', list_price: '129.99', list_price_currency: 'EUR' } }));
        await t.ctx.importer.pull();
        for (const suffix of ['equal', 'below', 'eur']) {
            const row = await byUrl(`https://lp.example/${suffix}`);
            const x = (await obsOf(row.id))[0];
            assert.deepStrictEqual([x.list_price, x.list_price_num], [null, null], `${suffix}: dropped`);
            assert.strictEqual(row.deal_reason, null, `${suffix}: not selected by a list price`);
        }
    });

    await check('each offer of a product keeps its own list price; the JSON and the page carry only that offer\'s', async () => {
        t.sources.put(sourceItem({ id: 'itm_LP000000000000000000005', kind: 'product', title: 'Widget', url: 'https://lp.example/widget', retrievedAt: t.clock.now(),
            fields: { brand: 'W', offers: [
                { price: '50.00', currency: 'USD', list_price: '100.00', url: 'https://lp.example/widget-a', seller: 'A' },
                { price: '20.00', currency: 'USD', list_price: '19.00', url: 'https://lp.example/widget-b', seller: 'B' },
                { price: '10.00', currency: 'EUR', list_price: '15.00', url: 'https://lp.example/widget-c', seller: 'C' },
            ] } }));
        await t.ctx.importer.pull();
        const a = await byUrl('https://lp.example/widget-a');
        const b = await byUrl('https://lp.example/widget-b');
        const c = await byUrl('https://lp.example/widget-c');
        assert.deepStrictEqual((await obsOf(a.id))[0].list_price, '100.00');
        assert.deepStrictEqual((await obsOf(b.id))[0].list_price, null);
        assert.deepStrictEqual((await obsOf(c.id))[0].list_price, '15.00');
        assert.deepStrictEqual([a.deal_reason, b.deal_reason, c.deal_reason], ['list_price', null, 'list_price']);
        assert.strictEqual((await t.offerJson(a.slug)).latest_observation.saving_pct, 50);
        assert.strictEqual((await t.offerJson(b.slug)).latest_observation.list_price, null);
        assert.strictEqual((await t.offerJson(c.slug)).latest_observation.saving_pct, 33);
    });

    await check('a lower price than the previous observation selects price_drop; a first price does not', async () => {
        t.sources.put(sourceItem({ id: 'itm_LP000000000000000000006', title: 'Drop widget', url: 'https://lp.example/drop', retrievedAt: t.clock.now(),
            fields: { price: '100.00', currency: 'USD' } }));
        await t.ctx.importer.pull();
        const drop = await byUrl('https://lp.example/drop');
        assert.strictEqual(drop.deal_reason, null, 'one price is not a drop');

        t.clock.advance(2 * HOUR);
        t.sources.put(sourceItem({ id: 'itm_LP000000000000000000006', title: 'Drop widget', url: 'https://lp.example/drop', retrievedAt: t.clock.now(), revision: 2,
            fields: { price: '90.00', currency: 'USD' } }));
        await t.ctx.importer.pull();
        assert.strictEqual((await byUrl('https://lp.example/drop')).deal_reason, 'price_drop');
        assert.strictEqual((await t.offerJson(drop.slug)).price_trend.at_lowest, true);
    });

    await check('a matching price_below watch selects watch; a normal import with none of the three is not a deal', async () => {
        const w = await t.ctx.watches.create(alice.subject, { kind: 'price_below', query: 'watchwidget', max_price: '50', currency: 'USD' });
        t.sources.put(sourceItem({ id: 'itm_LP000000000000000000007', title: 'WatchWidget 3000', url: 'https://lp.example/watch', retrievedAt: t.clock.now(),
            fields: { price: '40.00', currency: 'USD' } }));
        await t.ctx.importer.pull();
        const watched = await byUrl('https://lp.example/watch');
        assert.strictEqual(watched.deal_reason, 'watch');
        assert.ok((await t.events('deals.watch.matched')).some((e) => e.payload.watch_id === w.id && e.payload.offer_id === watched.id));

        t.sources.put(sourceItem({ id: 'itm_LP000000000000000000008', title: 'Ordinary thing', url: 'https://lp.example/ordinary', retrievedAt: t.clock.now(),
            fields: { price: '25.00', currency: 'USD' } }));
        await t.ctx.importer.pull();
        const ordinary = await byUrl('https://lp.example/ordinary');
        assert.ok(ordinary, 'a crawled offer is still imported (existing selection behaviour)');
        assert.strictEqual(ordinary.deal_reason, null);
        assert.strictEqual((await t.offerJson(ordinary.slug)).latest_observation.list_price, null);
    });

    await t.close();
    done();
})();
