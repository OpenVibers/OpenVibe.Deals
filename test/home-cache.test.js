'use strict';
/**
 * The front page is one build shared by its readers (DEALS_HOME_TTL_MS): a read inside the window
 * does not touch the database, a read after it gets the last copy while one background rebuild runs,
 * and the copy is never older than three minutes. The build itself carries no viewer, so a signed-in
 * reader still gets their own navbar from the same data.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const t = await boot({ env: { DEALS_HOME_TTL_MS: '60000' } });
    const alice = t.network.addUser('alice');
    await t.submit(alice, { url: 'https://a.example/cached-1', title: 'Cached deal one', price: '10', currency: 'USD' });
    const warm = await t.get('/');
    assert.strictEqual(warm.status, 200);
    assert.ok(warm.text.includes('Cached deal one'));
    assert.match(warm.headers.get('cache-control'), /public, max-age=60/);

    await check('a home read inside the window reuses the build, byte for byte', async () => {
        await t.submit(alice, { url: 'https://a.example/cached-2', title: 'Cached deal two', price: '12', currency: 'USD' });
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Cached deal one'));
        assert.ok(!r.text.includes('Cached deal two'), 'the new deal is not in the reused build (the window has not passed)');
        assert.strictEqual(r.text, warm.text, 'the same HTML');
    });

    await check('after the window a reader gets the last copy and one background rebuild picks up the new deal', async () => {
        t.clock.advance(61_000);
        const stale = await t.get('/');
        assert.strictEqual(stale.status, 200);
        assert.ok(stale.text.includes('Cached deal one'));
        assert.ok(!stale.text.includes('Cached deal two'), 'served from the last build, not a blocking rebuild');
        let fresh = null;
        for (let i = 0; i < 100 && !fresh; i++) {
            await sleep(20);
            const r = await t.get('/');
            if (r.text.includes('Cached deal two')) fresh = r;
        }
        assert.ok(fresh, 'the background rebuild published the new deal');
        assert.ok(fresh.text.includes('Cached deal one'));
    });

    await check('the shared build is viewer-neutral: a signed-in reader still gets their own navbar', async () => {
        const anon = await t.get('/');
        const user = await t.get('/', { as: alice });
        assert.strictEqual(user.status, 200);
        assert.ok(user.text.includes('Sign out'), 'the account controls are rendered for the viewer, not cached');
        assert.ok(!anon.text.includes('Sign out'));
        assert.ok(user.text.includes('Cached deal two'), 'the same deals');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
