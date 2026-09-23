'use strict';
/**
 * Hotness is server-computed with one documented, deterministic formula (hot@1), from stored
 * rows only, and every snapshot can be recomputed from its own inputs.
 */
const assert = require('assert');
const { boot, check, done, HOUR } = require('./helpers/boot');
const { formula } = require('../server/domain/hotness');

(async () => {
    await check('hot@1 is a pure function with fixed rounding (worked examples from the README)', async () => {
        assert.deepStrictEqual(formula({ upWeight: 3, downWeight: 1, firstSeenAt: 0, t: 10 * HOUR }), { formula: 'hot@1', score: 2, hot: 0.048113, ageHours: 10 });
        assert.deepStrictEqual(formula({ upWeight: 2, downWeight: 0, firstSeenAt: 0, t: 0 }), { formula: 'hot@1', score: 2, hot: 0.707107, ageHours: 0 });
        assert.strictEqual(formula({ upWeight: 0.25, downWeight: 1, firstSeenAt: 0, t: 2 * HOUR }).hot, -0.09375);
        assert.strictEqual(formula({ upWeight: 1, downWeight: 0, firstSeenAt: 5 * HOUR, t: 0 }).ageHours, 0, 'a clock skew never makes an offer younger than new');
        for (let i = 0; i < 50; i++) assert.deepStrictEqual(formula({ upWeight: 7.75, downWeight: 2.25, firstSeenAt: 1000, t: 1000 + 37 * HOUR }), formula({ upWeight: 7.75, downWeight: 2.25, firstSeenAt: 1000, t: 1000 + 37 * HOUR }));
        assert.throws(() => formula({ upWeight: NaN, downWeight: 0, firstSeenAt: 0, t: 0 }));
    });

    const t = await boot();
    const users = Array.from({ length: 6 }, (_, i) => t.network.addUser(`u${i}`));
    const poster = t.network.addUser('poster');

    await check('the same votes in a different order give identical snapshots', async () => {
        const X = await t.submit(poster, { url: 'https://a.example/1', title: 'Offer X', price: '10', currency: 'USD' });
        const Y = await t.submit(poster, { url: 'https://a.example/2', title: 'Offer Y', price: '10', currency: 'USD' });
        t.clock.advance(3 * HOUR);
        const plan = [[users[0], 'up'], [users[1], 'up'], [users[2], 'down'], [users[3], 'up']];
        for (const [u, v] of plan) await t.get(`/d/${X.slug}/vote`, { as: u, form: { value: v } });
        for (const [u, v] of [...plan].reverse()) await t.get(`/d/${Y.slug}/vote`, { as: u, form: { value: v } });
        const sx = t.ctx.reads.lastSnapshot(X.id);
        const sy = t.ctx.reads.lastSnapshot(Y.id);
        for (const k of ['formula', 'up_count', 'down_count', 'up_weight', 'down_weight', 'score', 'hot']) assert.strictEqual(sx[k], sy[k], k);
        assert.strictEqual(sx.score, 2);
        assert.strictEqual(sx.hot, formula({ upWeight: 3, downWeight: 1, firstSeenAt: X.created_at, t: sx.computed_at }).hot);
    });

    await check('every stored snapshot recomputes to itself (GET /api/v1/offers/:id/hotness)', async () => {
        const rows = t.ctx.store.db.prepare('SELECT * FROM deal_hotness_snapshots').all();
        assert.ok(rows.length >= 6);
        for (const s of rows) assert.strictEqual(t.ctx.hotness.recompute(s).hot, s.hot, `snapshot ${s.id}`);
        const X = t.ctx.store.db.prepare("SELECT * FROM deal_offers WHERE title = 'Offer X'").get();
        const r = (await t.get(`/api/v1/offers/${X.slug}/hotness`)).json();
        assert.strictEqual(r.recomputed.hot, r.snapshot.hot);
        assert.match(r.formula, /hot@1/);
    });

    await check('clients cannot set weight, score or hotness: only value is read', async () => {
        const X = t.ctx.store.db.prepare("SELECT * FROM deal_offers WHERE title = 'Offer X'").get();
        const before = t.ctx.reads.lastSnapshot(X.id);
        const r = await t.get(`/api/v1/offers/${X.id}/vote`, { method: 'PUT', as: users[4], json: { value: 1, weight: 100, score: 999, hot: 999 } });
        assert.strictEqual(r.status, 200, r.text);
        const row = t.ctx.store.db.prepare('SELECT weight FROM deal_votes WHERE subject = ? AND offer_id = ?').get(users[4].subject, X.id);
        assert.strictEqual(row.weight, 1);
        const after = t.ctx.reads.lastSnapshot(X.id);
        assert.strictEqual(after.up_weight, before.up_weight + 1);
    });

    await check('accounts new to OpenVibe count 0.25 until there is evidence they are a week old', async () => {
        const X = t.ctx.store.db.prepare("SELECT * FROM deal_offers WHERE title = 'Offer X'").get();
        const fresh = t.network.addUser('newbie', { mintedAt: t.clock.now() - 2 * 24 * HOUR });
        await t.get(`/d/${X.slug}/vote`, { as: fresh, form: { value: 'up' } });
        const row = t.ctx.store.db.prepare('SELECT weight FROM deal_votes WHERE subject = ?').get(fresh.subject);
        assert.strictEqual(row.weight, 0.25);
        const snap = t.ctx.reads.lastSnapshot(X.id);
        assert.strictEqual(snap.up_count, 5);
        assert.strictEqual(snap.up_weight, 4.25);
        // Six days later the subject id proves ≥ 7 days: a new vote carries weight 1.
        t.clock.advance(6 * 24 * HOUR);
        await t.get(`/d/${X.slug}/vote`, { as: fresh, form: { value: 'down' } });
        assert.strictEqual(t.ctx.store.db.prepare('SELECT weight FROM deal_votes WHERE subject = ?').get(fresh.subject).weight, 1);
    });

    await check('the worker snapshots every active offer at one shared t; the hot list follows those snapshots', async () => {
        const Z = await t.submit(poster, { url: 'https://a.example/3', title: 'Offer Z', price: '10', currency: 'USD' });
        for (const u of users.slice(0, 5)) await t.get(`/d/${Z.slug}/vote`, { as: u, form: { value: 'up' } });
        t.clock.advance(HOUR);
        await t.ctx.worker.tick();
        const ticks = t.ctx.store.db.prepare("SELECT offer_id, computed_at, hot FROM deal_hotness_snapshots WHERE reason = 'tick'").all();
        assert.strictEqual(new Set(ticks.map((x) => x.computed_at)).size, 1);
        assert.strictEqual(ticks.length, 3);
        const list = await t.get('/api/v1/offers?sort=hot');
        const order = list.json().offers.map((o) => o.title);
        assert.strictEqual(order[0], 'Offer Z');
        const hots = list.json().offers.map((o) => o.hotness.hot);
        assert.deepStrictEqual(hots, [...hots].sort((a, b) => b - a));
    });

    await t.close();
    done();
})();
