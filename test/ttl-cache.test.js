'use strict';
/**
 * The small shared-build cache the front page uses (server/http/ttl-cache.js): one build per window,
 * one at a time, stale-while-revalidate up to maxStaleMs, and no reuse when ttlMs is 0.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { ttlCache } = require('../server/http/ttl-cache');

const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };
const gate = () => { const g = {}; g.promise = new Promise((resolve) => { g.open = resolve; }); return g; };

(async () => {
    await check('inside ttlMs every reader shares one build', async () => {
        let now = 1000;
        let builds = 0;
        const read = ttlCache(async () => ++builds, { ttlMs: 100, now: () => now });
        assert.strictEqual(await read(), 1);
        now += 99;
        assert.strictEqual(await read(), 1);
        assert.strictEqual(builds, 1);
    });

    await check('concurrent cold readers share one build', async () => {
        const g = gate();
        let builds = 0;
        const read = ttlCache(async () => { builds++; await g.promise; return builds; }, { ttlMs: 100, now: () => 0 });
        const [a, b] = [read(), read()];
        await settle();
        assert.strictEqual(builds, 1);
        g.open();
        assert.deepStrictEqual(await Promise.all([a, b]), [1, 1]);
    });

    await check('after ttlMs a reader gets the last value and one background build runs', async () => {
        let now = 0;
        let builds = 0;
        const g = gate();
        const read = ttlCache(async () => { builds++; if (builds > 1) await g.promise; return builds; }, { ttlMs: 100, maxStaleMs: 300, now: () => now });
        assert.strictEqual(await read(), 1);
        now = 101;
        assert.strictEqual(await read(), 1, 'the last copy, immediately');
        assert.strictEqual(await read(), 1, 'still the last copy while the rebuild is running');
        await settle();
        assert.strictEqual(builds, 2, 'one rebuild, not one per reader');
        g.open();
        await settle();
        assert.strictEqual(await read(), 2, 'the rebuild is published');
    });

    await check('past maxStaleMs a reader waits for the build', async () => {
        let now = 0;
        let builds = 0;
        const g = gate();
        const read = ttlCache(async () => { builds++; if (builds > 1) await g.promise; return builds; }, { ttlMs: 100, maxStaleMs: 300, now: () => now });
        assert.strictEqual(await read(), 1);
        now = 301;
        const next = read();
        await settle();
        assert.strictEqual(builds, 2, 'the build is already running');
        g.open();
        assert.strictEqual(await next, 2);
    });

    await check('a failed background build keeps the last copy until maxStaleMs, then surfaces the error', async () => {
        let now = 0;
        let builds = 0;
        let fail = false;
        const read = ttlCache(async () => { builds++; if (fail) throw new Error('database down'); return builds; }, { ttlMs: 100, maxStaleMs: 300, now: () => now });
        assert.strictEqual(await read(), 1);
        now = 101;
        fail = true;
        assert.strictEqual(await read(), 1, 'the last copy');
        await settle();
        assert.strictEqual(builds, 2, 'one rebuild was tried');
        assert.strictEqual(await read(), 1, 'still the last copy inside maxStaleMs');
        now = 301;
        await assert.rejects(() => read(), /database down/, 'past maxStaleMs the reader sees the failure');
    });

    await check('ttlMs 0 builds on every read', async () => {
        let builds = 0;
        const read = ttlCache(async () => ++builds, { ttlMs: 0, now: () => 0 });
        assert.deepStrictEqual([await read(), await read(), await read()], [1, 2, 3]);
    });

    await check('refresh() rebuilds before the window closes, and the next read sees it without waiting', async () => {
        let now = 0;
        let builds = 0;
        const read = ttlCache(async () => ({ build: ++builds }), { ttlMs: 100, maxStaleMs: 300, now: () => now });
        assert.deepStrictEqual(await read(), { build: 1 });
        now = 50;
        assert.strictEqual(read.ttlMs, 100, 'the window is readable so the worker can warm before it closes');
        assert.deepStrictEqual(await read.refresh(), { build: 2 });
        assert.deepStrictEqual(await read(), { build: 2 });
    });

    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
