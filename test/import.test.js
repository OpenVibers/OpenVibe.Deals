'use strict';
/**
 * Imports from OpenVibe.Sources (deals category): observations dated by retrieval, idempotent
 * replays, dedupe by link, removal, re-confirmation, the signed event wake-up and failure states.
 */
const assert = require('assert');
const { boot, check, done, robotsOf, HOUR } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');
const { signDelivery } = require('openvibe-sdk/events');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const byUrl = (u) => t.ctx.store.db.prepare('SELECT * FROM deal_offers WHERE url = ?').get(u);
    const obsOf = (id) => t.ctx.store.db.prepare('SELECT * FROM deal_price_observations WHERE offer_id = ? ORDER BY observed_at, rowid').all(id);
    const T0 = t.clock.now();

    await check('offer, product and article items become offers; values exactly as stated; observed_at = retrieved_at', async () => {
        t.sources.put(sourceItem({ id: 'itm_01K5AAAAAAAAAAAAAAAAAAAAA1', title: 'Espresso machine', url: 'https://coffee.example/espresso', retrievedAt: T0 - HOUR,
            fields: { price: '249.00', currency: 'EUR', availability: 'InStock', condition: 'RefurbishedCondition', valid_until: '2026-10-01', seller: 'Coffee Shop' } }));
        t.sources.put(sourceItem({ id: 'itm_01K5AAAAAAAAAAAAAAAAAAAAA2', kind: 'product', title: 'Acme Kettle 2000', url: 'https://kettles.example/acme-2000', retrievedAt: T0,
            fields: { brand: 'Acme', gtin: '4006381333931', offers: [
                { price: '39.99', currency: 'USD', availability: 'InStock', url: 'https://kettles.example/acme-2000?utm_source=feed', seller: 'Kettles' },
                { price: null, currency: null, availability: 'OutOfStock', url: 'https://market.example/acme-2000', seller: 'Market' },
            ] } }));
        t.sources.put(sourceItem({ id: 'itm_01K5AAAAAAAAAAAAAAAAAAAAA3', kind: 'article', title: 'Weekend sale on garden tools', url: 'https://news.example/garden', retrievedAt: T0 }));
        const s = await t.ctx.importer.pull();
        assert.deepStrictEqual(s.outcomes, { created: 4 }, JSON.stringify(s));
        assert.strictEqual(s.items, 3);

        const esp = byUrl('https://coffee.example/espresso');
        assert.strictEqual(esp.origin, 'import');
        assert.strictEqual(esp.review_state, 'pending');
        assert.strictEqual(esp.expires_at, Date.parse('2026-10-01'));
        const o = obsOf(esp.id)[0];
        assert.deepStrictEqual([o.price, o.currency, o.availability, o.condition, o.observed_at, o.origin], ['249.00', 'EUR', 'in_stock', 'refurbished', T0 - HOUR, 'import']);
        assert.strictEqual(t.ctx.catalog.store(esp.store_id).name, 'Coffee Shop');

        const k1 = byUrl('https://kettles.example/acme-2000');
        const k2 = byUrl('https://market.example/acme-2000');
        assert.ok(k1 && k2 && k1.product_id && k1.product_id === k2.product_id, 'one product, two offers (tracking parameter stripped)');
        assert.strictEqual(obsOf(k2.id)[0].price, null);
        assert.strictEqual(obsOf(k2.id)[0].availability, 'out_of_stock');
        const product = t.ctx.catalog.product(k1.product_id);
        assert.strictEqual(product.brand, 'Acme', 'the brand the source stated');
        const p = (await t.get(`/p/${product.slug}.json`)).json();
        assert.strictEqual(p.offers.length, 2);
        assert.ok(p.product.aliases.some((a) => a.kind === 'gtin'));
    });

    await check('imported text is noindex until a person reviews it; review is recorded and re-indexes', async () => {
        const esp = byUrl('https://coffee.example/espresso');
        const page = await t.get(`/d/${esp.slug}`);
        assert.strictEqual(robotsOf(page.text), 'noindex, follow');
        assert.match(page.text, /imported from a source and has not been reviewed/);
        const json = await t.offerJson(esp.slug);
        const reason = json.indexability.reasons.find((r) => r.code === 'noindex_requested');
        assert.match(reason.detail, /review_pending/);
        const r = await t.get(`/mod/offers/${esp.slug}/review`, { as: t.mod, form: {} });
        assert.strictEqual(r.status, 303);
        const after = await t.offerJson(esp.slug);
        assert.strictEqual(after.review_state, 'reviewed');
        assert.strictEqual(after.indexability.indexable, true);
        const doc = t.events('deals.index_document.upserted').filter((e) => e.payload.id === esp.id).pop().payload;
        assert.strictEqual(doc.indexability.decision, 'index');
        assert.strictEqual(doc.authorship, 'imported');
        assert.deepStrictEqual(doc.provenance.map((x) => [x.service, x.type, x.id]), [['sources', 'item', 'itm_01K5AAAAAAAAAAAAAAAAAAAAA1']]);
    });

    await check('replaying the feed changes nothing (same revision, same retrieval)', async () => {
        const count = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_price_observations').get().n;
        const events = t.events().length;
        t.ctx.store.db.prepare("UPDATE import_state SET value = '0'").run();
        const s = await t.ctx.importer.pull();
        assert.deepStrictEqual(s.outcomes, { unchanged: 4 });
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_price_observations').get().n, count);
        assert.strictEqual(t.events().length, events);
    });

    await check('a new revision is a new observation; the history keeps the old price with its time', async () => {
        t.clock.advance(2 * HOUR);
        t.sources.put(sourceItem({ id: 'itm_01K5AAAAAAAAAAAAAAAAAAAAA1', title: 'Espresso machine', url: 'https://coffee.example/espresso', retrievedAt: t.clock.now(), revision: 2,
            fields: { price: '229.00', currency: 'EUR', availability: 'LimitedAvailability', seller: 'Coffee Shop' } }));
        const s = await t.ctx.importer.pull();
        assert.deepStrictEqual(s.outcomes, { updated: 1 });
        const esp = byUrl('https://coffee.example/espresso');
        assert.deepStrictEqual(obsOf(esp.id).map((o) => [o.price, o.source_revision]), [['249.00', 1], ['229.00', 2]]);
        assert.strictEqual((await t.offerJson(esp.slug)).latest_observation.price, '229.00');
    });

    await check('the same link from a person or another item attaches to the existing offer', async () => {
        const dup = await t.get('/submit', { as: alice, form: { url: 'https://coffee.example/espresso?utm_campaign=x#top', title: 'Espresso machine!', price: '229', currency: 'EUR' } });
        assert.strictEqual(dup.status, 303);
        assert.match(dup.headers.get('location'), /\?duplicate=1$/);
        t.sources.put(sourceItem({ id: 'itm_01K5AAAAAAAAAAAAAAAAAAAAA4', sourceKey: 'other-feed', kind: 'article', title: 'Espresso deal', url: 'http://www.coffee.example/espresso', retrievedAt: t.clock.now() }));
        const s = await t.ctx.importer.pull();
        assert.deepStrictEqual(s.outcomes, { attached: 1 });
        const esp = byUrl('https://coffee.example/espresso');
        const json = await t.offerJson(esp.slug);
        assert.deepStrictEqual(json.sources.map((x) => x.key).sort(), ['other-feed', 'shop-jsonld']);
    });

    await check('an imported offer is re-confirmed when Sources fetched the unchanged item again', async () => {
        t.clock.advance(30 * HOUR);
        const it = t.sources.items.find((i) => i.id === 'itm_01K5AAAAAAAAAAAAAAAAAAAAA3');
        it.provenance = { ...it.provenance, retrieved_at: new Date(t.clock.now() - HOUR).toISOString() };
        const r = await t.ctx.importer.refresh();
        assert.ok(r.outcomes.refreshed >= 1, JSON.stringify(r));
        const garden = byUrl('https://news.example/garden');
        const obs = obsOf(garden.id);
        assert.strictEqual(obs.length, 2);
        assert.strictEqual(obs[1].origin, 'import_refresh');
        assert.strictEqual(obs[1].observed_at, t.clock.now() - HOUR);
    });

    await check('a removed item removes its source; an imported offer with no source left is disabled (410, Search tombstone)', async () => {
        t.sources.put({ ...t.sources.items.find((i) => i.id === 'itm_01K5AAAAAAAAAAAAAAAAAAAAA3'), removed: { at: new Date(t.clock.now()).toISOString(), reason: 'licence withdrawn' } });
        const s = await t.ctx.importer.pull();
        assert.deepStrictEqual(s.outcomes, { removed: 1 });
        const garden = byUrl('https://news.example/garden');
        assert.strictEqual(garden.status, 'disabled');
        assert.match(garden.disabled_reason, /licence withdrawn/);
        assert.strictEqual((await t.get(`/d/${garden.slug}`)).status, 410);
        assert.ok(t.events('deals.index_document.deleted').some((e) => e.payload.id === garden.id));
        assert.ok(!(await t.get('/feed.xml')).text.includes(garden.slug));
    });

    await check('the signed event wake-up: bad signature 401, deals items scheduled once, others ignored', async () => {
        const env = (id, category) => ({ event: { event_id: id, event_type: 'sources.item.updated', source: 'sources', version: 1, timestamp: new Date().toISOString(), actor: { type: 'service', id: 'sources' }, subject: { type: 'item', id: 'itm_x' }, visibility: 'internal', payload: { category } }, seq: 1 });
        const post = (body, sig) => t.get('/internal/events', { body, headers: { 'content-type': 'application/json', 'x-openvibe-signature': sig } });
        const good = JSON.stringify(env('evt_01K5AAAAAAAAAAAAAAAAAAAAA1', 'deals'));
        assert.strictEqual((await post(good, 'sha256=00')).status, 401);
        const r1 = await post(good, signDelivery(good, 'whsec-test'));
        assert.deepStrictEqual([r1.status, r1.json().outcome, r1.json().duplicate], [200, 'import_scheduled', false]);
        const r2 = await post(good, signDelivery(good, 'whsec-test'));
        assert.strictEqual(r2.json().duplicate, true);
        const news = JSON.stringify(env('evt_01K5AAAAAAAAAAAAAAAAAAAAA2', 'news'));
        assert.strictEqual((await post(news, signDelivery(news, 'whsec-test'))).json().outcome, 'ignored');
    });

    await check('Sources down: the pull fails honestly (readiness says so), keeps its cursor, invents nothing', async () => {
        const cursor = t.ctx.importer.cursor();
        const offers = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_offers').get().n;
        t.sources.setDown(true);
        await t.ctx.importer.pull();
        assert.strictEqual(t.ctx.importer.cursor(), cursor);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_offers').get().n, offers);
        const ready = (await t.get('/api/ready')).json();
        assert.strictEqual(ready.checks.sources_import.status, 'fail');
        assert.match(ready.checks.sources_import.reason || JSON.stringify(ready.checks.sources_import), /Sources answered 503/);
        t.sources.setDown(false);
        await t.ctx.importer.pull();
        assert.strictEqual((await t.get('/api/ready')).json().checks.sources_import.status, 'ok');
    });

    await t.close();
    done();
})();
