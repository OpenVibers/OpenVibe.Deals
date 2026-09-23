'use strict';
/**
 * Duplicate offers merge without losing votes or history; a voter who voted on both counts once;
 * the merge is audited and reversible.
 */
const assert = require('assert');
const { boot, check, done, HOUR } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const [s1, s2, v1, v2, v3, v4, eve] = ['s1', 's2', 'v1', 'v2', 'v3', 'v4', 'eve'].map((n) => t.network.addUser(n));
    const vote = (u, slug, value) => t.get(`/d/${slug}/vote`, { as: u, form: { value } });
    let A, B, beforeB;

    await check('two listings of one deal, each with its own votes and observations', async () => {
        A = await t.submit(s1, { url: 'https://shop.example/tv-55', title: '55" TV deal', price: '399', currency: 'USD' });
        t.clock.advance(10 * 60 * 1000);
        B = await t.submit(s2, { url: 'https://shop.example/tv-55-inch?color=black', title: '55 inch TV at Shop', price: '399.00', currency: 'USD' });
        await t.get(`/d/${B.slug}/observe`, { as: v3, form: { price: '389', currency: 'USD' } });
        for (const [u, s, v] of [[v1, A, 'up'], [v2, A, 'up'], [v1, B, 'up'], [v3, B, 'down']]) {
            t.clock.advance(60 * 1000);
            assert.strictEqual((await vote(u, s.slug, v)).status, 303);
        }
        const a = await t.offerJson(A.slug);
        beforeB = await t.offerJson(B.slug);
        assert.deepStrictEqual([a.votes.up, a.votes.down], [2, 0]);
        assert.deepStrictEqual([beforeB.votes.up, beforeB.votes.down], [1, 1]);
        assert.strictEqual(beforeB.observations.length, 2);
    });

    await check('only moderators merge', async () => {
        const r = await t.get(`/mod/offers/${B.slug}/merge`, { as: eve, form: { into: A.slug } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(t.ctx.reads.get(B.id).merged_into, null);
    });

    await check('merge B into A: the voter who voted on both counts once, every observation and source is kept', async () => {
        const r = await t.get(`/mod/offers/${B.slug}/merge`, { as: t.mod, form: { into: A.slug, reason: 'same TV, same store' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        const a = await t.offerJson(A.slug);
        assert.deepStrictEqual([a.votes.up, a.votes.down], [2, 1], 'v1 (both), v2 up; v3 down');
        assert.strictEqual(a.observations.length, 3);
        assert.deepStrictEqual(a.observations.map((o) => o.price), ['389', '399.00', '399']);
        assert.strictEqual(a.latest_observation.price, '389', 'the latest observation of the group');
        assert.strictEqual(a.sources.length, 3);
        assert.deepStrictEqual(a.merged_from.map((m) => m.slug), [B.slug]);
        const rows = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_votes').get().n;
        assert.strictEqual(rows, 4, 'no vote row was deleted, moved or copied');
    });

    await check('the merged listing redirects to the canonical one (page and JSON), and Search drops it', async () => {
        const page = await t.get(`/d/${B.slug}`);
        assert.strictEqual(page.status, 301);
        assert.strictEqual(page.headers.get('location'), `/d/${A.slug}`);
        const json = await t.get(`/d/${B.slug}.json`);
        assert.strictEqual(json.headers.get('location'), `/d/${A.slug}.json`);
        const tomb = t.events('deals.index_document.deleted').filter((e) => e.payload.id === B.id);
        assert.strictEqual(tomb.length, 1);
        const upd = t.events('deals.offer.updated').filter((e) => e.payload.merged_offer_id === B.id);
        assert.strictEqual(upd.length, 1);
        assert.strictEqual(upd[0].subject.id, A.id);
    });

    await check('the merge is audited with the tallies before and after', async () => {
        const log = t.ctx.store.db.prepare("SELECT * FROM moderation_log WHERE action = 'merge'").all();
        assert.strictEqual(log.length, 1);
        assert.strictEqual(log[0].offer_id, B.id);
        assert.strictEqual(log[0].target_id, A.id);
        assert.strictEqual(log[0].actor, t.mod.subject);
        assert.strictEqual(log[0].reason, 'same TV, same store');
        const before = JSON.parse(log[0].before);
        assert.deepStrictEqual([before.target.up, before.duplicate.up, before.duplicate.down], [2, 1, 1]);
        assert.deepStrictEqual([JSON.parse(log[0].after).target.up, JSON.parse(log[0].after).target.down], [2, 1]);
    });

    await check('a vote cast through the merged listing lands on the canonical offer; changing a vote counts once', async () => {
        t.clock.advance(60 * 1000);
        assert.strictEqual((await vote(v4, B.slug, 'up')).status, 303);
        const row = t.ctx.store.db.prepare('SELECT offer_id FROM deal_votes WHERE subject = ?').get(v4.subject);
        assert.strictEqual(row.offer_id, A.id);
        t.clock.advance(60 * 1000);
        await vote(v1, A.slug, 'down');
        const a = await t.offerJson(A.slug);
        assert.deepStrictEqual([a.votes.up, a.votes.down], [2, 2], 'v2, v4 up; v1 (now down, once), v3 down');
        assert.strictEqual(t.ctx.votes.mine(v1.subject, t.ctx.reads.get(A.id)), -1);
    });

    await check('merging the canonical offer into its own duplicate is refused (no cycles)', async () => {
        const r = await t.get(`/api/v1/offers/${A.id}/merge`, { as: t.mod, json: { into: B.id } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json().code, 'offer.merge_cycle');
    });

    await check('unmerge restores B exactly as it was (its own votes and observations); A keeps what was cast on it', async () => {
        const r = await t.get(`/mod/offers/${B.slug}/unmerge`, { as: t.mod, form: { reason: 'different model' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        const b = await t.offerJson(B.slug);
        assert.deepStrictEqual(b.votes, beforeB.votes);
        assert.deepStrictEqual(b.observations.map((o) => o.id), beforeB.observations.map((o) => o.id));
        assert.deepStrictEqual(b.sources.map((s) => s.id), beforeB.sources.map((s) => s.id));
        assert.strictEqual(b.merged_from.length, 0);
        const a = await t.offerJson(A.slug);
        assert.deepStrictEqual([a.votes.up, a.votes.down], [2, 1], 'A: v2, v4 up, v1 down (cast on A)');
        assert.strictEqual(a.observations.length, 1);
        assert.strictEqual((await t.get(`/d/${B.slug}`)).status, 200);
        const log = t.ctx.store.db.prepare("SELECT action FROM moderation_log WHERE action IN ('merge','unmerge') ORDER BY id").all().map((x) => x.action);
        assert.deepStrictEqual(log, ['merge', 'unmerge']);
        const up = t.events('deals.index_document.upserted').filter((e) => e.payload.id === B.id).pop();
        assert.ok(up, 'B is back in Search');
    });

    await check('hotness after merge and unmerge is computed from the group (snapshots record the reason)', async () => {
        const reasons = t.ctx.store.db.prepare('SELECT reason FROM deal_hotness_snapshots WHERE offer_id = ? ORDER BY id').all(A.id).map((x) => x.reason);
        assert.ok(reasons.includes('merge') && reasons.includes('unmerge'));
        t.clock.advance(HOUR);
    });

    await t.close();
    done();
})();
