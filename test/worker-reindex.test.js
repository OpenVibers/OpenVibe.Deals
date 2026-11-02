'use strict';
/**
 * What a tick re-indexes: every offer and product at the first tick and once a day; in between, only the offers whose
 * price came of age (an observation crossed freshnessMs since the last pass), through reindex (offer and product).
 * Rebuilding all ~40,000 documents every ten minutes cost about half a core (2026-11-02); a write re-indexes its own
 * offer, so time alone is what the ticks are for.
 *
 *   node test/worker-reindex.test.js
 */
const assert = require('assert');
const { createWorker } = require('../server/worker');

(async () => {
    const HOUR = 3_600_000;
    let t = 1_000_000_000_000;
    const calls = { indexable: 0, products: 0, indexOffer: 0, indexProduct: 0, reindex: 0, aged: [] };
    const worker = createWorker({
        config: { freshnessMs: 48 * HOUR, worker: { enabled: false, intervalMs: 600_000, hotWindowDays: 14 } },
        store: { now: () => t, tx: async (fn) => fn() },
        offers: { expireDue: async () => 0 },
        hotness: { tick: async () => 0 },
        indexing: {
            indexOffer: async () => { calls.indexOffer += 1; return false; },
            indexProduct: async () => { calls.indexProduct += 1; return false; },
            reindex: async () => { calls.reindex += 1; },
        },
        listings: {
            indexable: async () => { calls.indexable += 1; return [{ id: 'a' }, { id: 'b' }, { id: 'c' }]; },
            products: async () => { calls.products += 1; return [{ id: 'p' }]; },
            agedInto: async (since, now, freshnessMs) => { calls.aged.push({ since, now, freshnessMs }); return [{ id: 'b' }]; },
        },
        importer: { pull: async () => ({}), refresh: async () => ({}) },
        limits: { prune: async () => 0 },
        log: { error() {}, log() {}, warn() {} },
    });

    let s = await worker.tick();
    assert.strictEqual(s.reindex, 'full', 'the first tick re-indexes everything');
    assert.deepStrictEqual([calls.indexable, calls.indexOffer, calls.indexProduct, calls.aged.length], [1, 3, 1, 0]);

    const first = t;
    t += 10 * 60_000;
    s = await worker.tick();
    assert.strictEqual(s.reindex, 'aged', 'ten minutes later: only what came of age');
    assert.strictEqual(calls.indexable, 1, 'not the whole set');
    assert.deepStrictEqual(calls.aged[0], { since: first - 60_000, now: t, freshnessMs: 48 * HOUR }, 'since the last pass, with a minute of margin');
    assert.strictEqual(calls.reindex, 1, 'each aged offer through reindex (its product too)');

    t += 10 * 60_000;
    await worker.tick();
    assert.strictEqual(calls.aged[1].since, t - 10 * 60_000 - 60_000, 'the window follows the passes');

    t = first + 24 * HOUR;
    s = await worker.tick();
    assert.strictEqual(s.reindex, 'full', 'once a day, everything again');
    assert.strictEqual(calls.indexable, 2);
    console.log('worker re-index: full at the first tick and daily, otherwise only offers whose price came of age');
})().catch((err) => { console.error(err); process.exit(1); });
