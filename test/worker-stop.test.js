'use strict';
/**
 * The worker stops cleanly: stop() ends the running tick at its next step (between offers in the re-index loop) and
 * resolves only once it has, and no tick starts after it. Before, stop() only cleared the timers, and a tick still
 * re-indexing went on after the service closed its database pool ("worker tick failed: Cannot use a pool after
 * calling end on the pool" on each deploy, 2026-11-02).
 *
 *   node test/worker-stop.test.js
 */
const assert = require('assert');
const { createWorker } = require('../server/worker');

(async () => {
    const OFFERS = Array.from({ length: 50 }, (_, i) => ({ id: `off_${i}` }));
    let indexed = 0;
    let closed = false;
    const later = () => new Promise((r) => setTimeout(r, 5));
    const store = { now: () => Date.now(), tx: async (fn) => { assert.ok(!closed, 'nothing touches the database after it closes'); return fn(); } };
    const worker = createWorker({
        config: { worker: { enabled: false, intervalMs: 60_000, hotWindowDays: 14 } },
        store,
        offers: { expireDue: async () => 0 },
        hotness: { tick: async () => 0 },
        indexing: { indexOffer: async () => { await later(); indexed += 1; return false; }, indexProduct: async () => false },
        listings: { indexable: async () => OFFERS, products: async () => [] },
        importer: { pull: async () => ({}), refresh: async () => ({}) },
        limits: { prune: async () => 0 },
        log: { error() {}, log() {}, warn() {} },
    });
    const ticking = worker.tick();
    while (indexed < 3) await later();
    const stopped = worker.stop();
    await stopped;
    closed = true;   // what the service does next: close the pool
    const summary = await ticking;
    assert.ok(indexed < OFFERS.length, `the tick ended early (${indexed} of ${OFFERS.length})`);
    assert.ok(!('import' in summary), 'it stopped before the importer');
    assert.strictEqual(await worker.tick(), null, 'no tick starts after stop()');
    assert.strictEqual(await worker.stop(), undefined, 'stop() with nothing running resolves at once');
    console.log(`worker stop: the tick ended after ${indexed} of ${OFFERS.length} offers; nothing ran after the pool closed`);
})().catch((err) => { console.error(err); process.exit(1); });
