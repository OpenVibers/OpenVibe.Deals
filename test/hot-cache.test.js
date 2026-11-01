'use strict';
/**
 * /hot's first page is one build shared by its readers (DEALS_HOT_TTL_MS), the same trade the
 * front page makes with DEALS_HOME_TTL_MS: a read inside the window does not run the latest-
 * snapshot query, a read after it gets the last copy while one background rebuild runs, and the
 * worker can rebuild it before the window closes so a visitor never pays for it. The build carries
 * no viewer; the layout is still rendered per request and only anonymous responses are public.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const configLib = require('../server/config');
const { createWorker } = require('../server/worker');
const { createPages } = require('../server/http/pages');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const t = await boot({ env: { DEALS_HOME_TTL_MS: '60000', DEALS_HOT_TTL_MS: '60000' } });
    const alice = t.network.addUser('alice');
    await t.submit(alice, { url: 'https://a.example/hot-1', title: 'Hot cached one', price: '10', currency: 'USD' });
    const warm = await t.get('/hot');
    assert.strictEqual(warm.status, 200);
    assert.ok(warm.text.includes('Hot cached one'));
    assert.match(warm.headers.get('cache-control'), /public, max-age=60/);

    await check('a /hot read inside the window reuses the build, byte for byte', async () => {
        await t.submit(alice, { url: 'https://a.example/hot-2', title: 'Hot cached two', price: '12', currency: 'USD' });
        const r = await t.get('/hot');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.text, warm.text, 'the same HTML, without the deal submitted after the build');
        assert.ok(!r.text.includes('Hot cached two'));
    });

    await check('after the window a reader gets the last copy and one background rebuild picks up the new deal', async () => {
        t.clock.advance(61_000);
        const stale = await t.get('/hot');
        assert.strictEqual(stale.status, 200);
        assert.ok(!stale.text.includes('Hot cached two'), 'served from the last build, not a blocking rebuild');
        let fresh = null;
        for (let i = 0; i < 100 && !fresh; i++) {
            await sleep(20);
            const r = await t.get('/hot');
            if (r.text.includes('Hot cached two')) fresh = r;
        }
        assert.ok(fresh, 'the background rebuild published the new deal');
        assert.ok(fresh.text.includes('Hot cached one'));
    });

    await check('the worker rebuilds both shared pages before their windows close, so no reader pays', async () => {
        t.clock.advance(61_000);
        await t.ctx.worker.warmNow();
        const hot = await t.get('/hot');
        assert.strictEqual(hot.status, 200);
        assert.ok(hot.text.includes('Hot cached two'), 'the warmed /hot build, not the stale copy');
        const home = await t.get('/');
        assert.strictEqual(home.status, 200);
        assert.ok(home.text.includes('Hot cached two'), 'the warmed front page build');
    });

    await check('the shared build is viewer-neutral: a signed-in reader gets their own navbar and a private response', async () => {
        const anon = await t.get('/hot');
        const user = await t.get('/hot', { as: alice });
        assert.strictEqual(user.status, 200);
        assert.match(user.headers.get('cache-control'), /private/);
        assert.match(anon.headers.get('cache-control'), /public, max-age=60/);
        assert.ok(user.text.includes('Sign out'), 'the account controls are rendered for the viewer, not cached');
        assert.ok(!anon.text.includes('Sign out'));
        assert.ok(user.text.includes('Hot cached two'), 'the same deals');
    });

    await check('the warm timer is off with the worker (tests and restore drills): start() arms nothing', async () => {
        assert.strictEqual(t.ctx.config.worker.enabled, false, 'the test harness boots with DEALS_WORKER=off');
        t.ctx.worker.start();
        assert.strictEqual(t.ctx.worker.status().warming, false);
    });

    await check('DEALS_HOT_TTL_MS is /hot\'s window: 60 s in production, off by default elsewhere', () => {
        assert.strictEqual(configLib.load({ NODE_ENV: 'production' }).hotTtlMs, 60_000);
        assert.strictEqual(configLib.load({ NODE_ENV: 'production', DEALS_HOT_TTL_MS: '15000' }).hotTtlMs, 15_000);
        assert.strictEqual(configLib.load({ NODE_ENV: 'test' }).hotTtlMs, 0);
        assert.strictEqual(typeof createPages, 'function', 'the routes and the shared builds live in pages.js');
    });

    await check('the worker warms at three quarters of the shortest window and stop() clears the timer', async () => {
        const intervals = [];
        const cleared = [];
        const timers = {
            setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; intervals.push(h); return h; },
            clearInterval: (h) => cleared.push(h),
            setTimeout: (fn, ms) => ({ fn, ms, unref() {} }),
        };
        let refreshes = 0;
        const worker = createWorker({
            config: { worker: { enabled: true, intervalMs: 10 * 60_000, hotWindowDays: 14 } },
            store: { now: () => 0 }, offers: {}, hotness: {}, indexing: {}, listings: {}, importer: {}, limits: {},
            log: { error() {} }, timers,
        });
        worker.warm([{ ttlMs: 60_000, refresh: async () => { refreshes++; } }]);
        worker.start();
        const warmTimer = intervals.find((h) => h.ms === 45_000);
        assert.ok(warmTimer, 'one warm interval, at three quarters of the 60 s window');
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(refreshes, 1, 'the first build fills the cache before a reader asks');
        await warmTimer.fn();
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(refreshes, 2, 'the interval rebuilds it before the window closes');
        worker.stop();
        assert.ok(cleared.includes(warmTimer), 'stop() clears the warm timer');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
