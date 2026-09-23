'use strict';
/**
 * Watches never notify twice for one observation; unknown prices never match a price watch;
 * saved searches never notify. Notifications are deals.watch.matched events (no email).
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done, HOUR } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');

(async () => {
    const t = await boot();
    const [watcher, poster, other] = ['watcher', 'poster', 'other'].map((n) => t.network.addUser(n));
    const matched = (watchId) => t.events('deals.watch.matched').filter((e) => !watchId || e.payload.watch_id === watchId);
    const w = {};
    let offer;

    await check('watches and a saved search are created through the no-JS form', async () => {
        for (const [key, form] of [
            ['keyword', { kind: 'keyword', query: 'Noise cancelling headphones' }],
            ['price', { kind: 'price_below', query: 'headphones', max_price: '40', currency: 'USD' }],
            ['saved', { kind: 'search', query: 'headphones' }],
        ]) {
            const r = await t.get('/watches', { as: watcher, form });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        }
        const list = t.ctx.watches.list(watcher.subject);
        for (const x of list) w[x.kind === 'price_below' ? 'price' : x.kind === 'search' ? 'saved' : 'keyword'] = x.id;
        assert.strictEqual(list.length, 3);
        const page = await t.get('/watches', { as: watcher });
        assert.match(page.text, /Saved search/);
        assert.match(page.text, /under 40 USD/);
        const bad = await t.get('/watches', { as: watcher, form: { kind: 'price_below', query: 'x', max_price: '10' } });
        assert.strictEqual(bad.status, 422, 'a price watch needs its currency');
    });

    await check('a matching new offer notifies the keyword watch once; the price watch stays quiet above its limit', async () => {
        offer = await t.submit(poster, { url: 'https://audio.example/nc700', title: 'Noise cancelling headphones NC700', price: '49.99', currency: 'USD' });
        assert.strictEqual(matched(w.keyword).length, 1);
        assert.strictEqual(matched(w.price).length, 0);
        assert.strictEqual(matched(w.saved).length, 0);
        const e = matched(w.keyword)[0];
        assert.strictEqual(e.payload.recipient, watcher.subject);
        assert.strictEqual(e.visibility, 'internal');
        assert.strictEqual(e.payload.observation.price, '49.99');
        const v = contracts.validate('events.event-envelope@1', e);
        assert.ok(v.valid, JSON.stringify(v.errors));
    });

    await check('a lower observation notifies the price watch; the keyword watch does not repeat for the same offer', async () => {
        await t.get(`/d/${offer.slug}/observe`, { as: other, form: { price: '35', currency: 'USD' } });
        assert.strictEqual(matched(w.price).length, 1);
        assert.strictEqual(matched(w.keyword).length, 1);
    });

    await check('re-running the matcher on the same observation emits nothing (one notification per observation)', async () => {
        const obs = t.ctx.store.db.prepare('SELECT * FROM deal_price_observations WHERE offer_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1').get(offer.id);
        const before = matched().length;
        for (let i = 0; i < 3; i++) t.ctx.store.tx(() => t.ctx.watches.onObservation(obs));
        assert.strictEqual(matched().length, before);
        const rows = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM watch_notifications WHERE observation_id = ?').get(obs.id).n;
        assert.strictEqual(rows, 1);
        // The primary key is the guarantee, not just the code path.
        const dup = t.ctx.store.db.prepare('INSERT OR IGNORE INTO watch_notifications (watch_id, observation_id, offer_id, created_at) VALUES (?, ?, ?, ?)').run(w.price, obs.id, offer.id, 0);
        assert.strictEqual(dup.changes, 0);
    });

    await check('the same price again does not re-notify; a lower one does', async () => {
        t.clock.advance(HOUR);
        await t.get(`/d/${offer.slug}/observe`, { as: other, form: { price: '35.00', currency: 'USD' } });
        assert.strictEqual(matched(w.price).length, 1);
        await t.get(`/d/${offer.slug}/observe`, { as: other, form: { price: '29.90', currency: 'USD' } });
        assert.strictEqual(matched(w.price).length, 2);
    });

    await check('an unknown price, another currency, or the watcher\'s own report never match a price watch', async () => {
        const before = matched(w.price).length;
        const o2 = await t.submit(poster, { url: 'https://audio.example/cheap', title: 'Cheap headphones' });
        await t.get(`/d/${o2.slug}/observe`, { as: other, form: { availability: 'in_stock' } });
        await t.get(`/d/${o2.slug}/observe`, { as: other, form: { price: '10', currency: 'EUR' } });
        await t.get(`/d/${o2.slug}/observe`, { as: watcher, form: { price: '9', currency: 'USD' } });
        assert.strictEqual(matched(w.price).length, before);
    });

    await check('an imported observation replayed from Sources notifies once', async () => {
        t.sources.put(sourceItem({ id: 'itm_01K5ZZZZZZZZZZZZZZZZZZZZW1', title: 'Wireless headphones deal', url: 'https://audio.example/wh', fields: { price: '19.99', currency: 'USD' }, retrievedAt: t.clock.now() }));
        const before = matched(w.price).length;
        await t.ctx.importer.pull();
        assert.strictEqual(matched(w.price).length, before + 1);
        // Replay the whole feed from the start: same items, same revision, same retrieval → nothing.
        t.ctx.store.db.prepare("UPDATE import_state SET value = '0'").run();
        await t.ctx.importer.pull();
        assert.strictEqual(matched(w.price).length, before + 1);
        const obsCount = t.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM deal_price_observations o JOIN deal_offers f ON f.id = o.offer_id WHERE f.url = 'https://audio.example/wh'").get().n;
        assert.strictEqual(obsCount, 1);
    });

    await check('an observation that is already stale when imported does not notify', async () => {
        const before = matched().length;
        t.sources.put(sourceItem({ id: 'itm_01K5ZZZZZZZZZZZZZZZZZZZZW2', title: 'Headphones from last week', url: 'https://audio.example/old', fields: { price: '5', currency: 'USD' }, retrievedAt: t.clock.now() - 5 * 24 * HOUR }));
        await t.ctx.importer.pull();
        assert.strictEqual(matched().length, before);
    });

    await check('a deleted watch stops; a saved search never notified', async () => {
        const r = await t.get(`/watches/${w.keyword}/delete`, { as: watcher, form: {} });
        assert.strictEqual(r.status, 303);
        const before = matched(w.keyword).length;
        await t.submit(poster, { url: 'https://audio.example/nc800', title: 'Noise cancelling headphones NC800', price: '20', currency: 'USD' });
        assert.strictEqual(matched(w.keyword).length, before);
        assert.strictEqual(matched(w.saved).length, 0);
        const cannot = await t.get(`/watches/${w.price}/delete`, { as: other, form: {} });
        assert.strictEqual(cannot.status, 404, 'someone else\'s watch is not found');
    });

    await check('API: watches are listed for the acting person only, with the deals.watch.* capabilities', async () => {
        const token = t.network.serviceToken('network', ['deals.watch.read']);
        const r = await t.get('/api/v1/watches', { as: token, headers: { 'X-OV-Subject': watcher.subject } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json().watches.map((x) => x.kind).sort(), ['price_below', 'search']);
        const denied = await t.get('/api/v1/watches', { as: token, method: 'POST', headers: { 'X-OV-Subject': watcher.subject }, json: { kind: 'keyword', query: 'x' } });
        assert.strictEqual(denied.status, 403);
    });

    await t.close();
    done();
})();
