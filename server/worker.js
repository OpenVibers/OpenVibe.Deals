'use strict';
/**
 * Background work in the Deals process (one timer, DEALS_WORKER_INTERVAL_MS):
 *
 *   1. stated expiry     offers whose STATED end time has passed become expired (deals.offer.expired)
 *   2. hotness           a hot@1 snapshot of every active offer from the last DEALS_HOT_WINDOW_DAYS,
 *                        all at one shared t, so the hot list compares like with like
 *   3. freshness         re-derive every offer's Search document; a price that went stale since the
 *                        last tick changes the document (freshness facet, noindex) and only then is
 *                        an event emitted (the sequencer makes unchanged documents no-ops)
 *   4. Sources           pull the deals change feed, then re-confirm imported offers going stale
 *   5. housekeeping      prune old rate-limit windows
 *
 * Every step is idempotent, so a tick re-run after a crash changes nothing that already happened.
 */
function createWorker({ config, store, offers, hotness, indexing, listings, importer, limits, log = console }) {
    let timer = null;
    let running = false;
    let lastError = null;
    let lastTickAt = null;

    async function tick() {
        if (running) return null;
        running = true;
        const summary = {};
        try {
            summary.expired = offers.expireDue();
            summary.snapshots = hotness.tick({ windowDays: config.worker.hotWindowDays });
            let reindexed = 0;
            for (const o of listings.indexable()) {
                store.tx(() => { if (indexing.indexOffer(o)) reindexed++; });
            }
            for (const p of listings.products()) store.tx(() => { if (indexing.indexProduct(p)) reindexed++; });
            summary.reindexed = reindexed;
            summary.import = await importer.pull();
            summary.refresh = await importer.refresh();
            summary.pruned = limits.prune();
            lastError = null;
        } catch (err) {
            lastError = err.message;
            log.error('[Deals] worker tick failed:', err.stack || err.message);
        } finally {
            lastTickAt = store.now();
            running = false;
        }
        return summary;
    }

    return {
        tick,
        start() {
            if (!config.worker.enabled) return;
            timer = setInterval(() => { tick().catch(() => {}); }, config.worker.intervalMs);
            timer.unref();
            setTimeout(() => { tick().catch(() => {}); }, 2000).unref();
        },
        stop() { clearInterval(timer); },
        status: () => ({ enabled: config.worker.enabled, last_error: lastError, last_tick_at: lastTickAt ? new Date(lastTickAt).toISOString() : null }),
    };
}

module.exports = { createWorker };
