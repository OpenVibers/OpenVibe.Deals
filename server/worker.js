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
 *   4. Sources           pull the deals change feed, then re-confirm imported offers going stale, then the
 *                        crowdfunding feed (domain/campaigns.js)
 *   5. housekeeping      prune old rate-limit windows
 *
 * Every step is idempotent, so a tick re-run after a crash changes nothing that already happened.
 */
function createWorker({ config, store, offers, hotness, indexing, listings, importer, campaigns = null, limits, log = console, timers = { setInterval, clearInterval, setTimeout } }) {
    let timer = null;
    let running = false;
    let lastError = null;
    let lastTickAt = null;
    // Shared page builds to keep warm (http/pages.js): the front page and /hot's first page. Their
    // refresh() rebuilds once even when several triggers meet.
    let warmCaches = [];
    let warmTimer = null;

    /** How often to rebuild: at three quarters of the shortest window, so a reader never finds it closed. */
    function warmEveryMs() {
        const ttls = warmCaches.map((c) => Number(c.ttlMs) || 0).filter((ms) => ms > 0);
        return ttls.length ? Math.max(1000, Math.floor(Math.min(...ttls) * 3 / 4)) : 0;
    }

    /** Rebuild every shared page now. A failure keeps the last copy; the next warm tries again. */
    async function warmNow() {
        for (const cache of warmCaches) {
            if (!Number(cache.ttlMs)) continue;
            try { await cache.refresh(); } catch (err) { log.error('[Deals] page warm failed:', err.stack || err.message); }
        }
    }

    async function tick() {
        if (running) return null;
        running = true;
        const summary = {};
        try {
            summary.expired = await offers.expireDue();
            summary.snapshots = await hotness.tick({ windowDays: config.worker.hotWindowDays });
            let reindexed = 0;
            for (const o of await listings.indexable()) {
                await store.tx(async () => { if (await indexing.indexOffer(o)) reindexed++; });
            }
            for (const p of await listings.products()) await store.tx(async () => { if (await indexing.indexProduct(p)) reindexed++; });
            summary.reindexed = reindexed;
            summary.import = await importer.pull();
            summary.refresh = await importer.refresh();
            if (campaigns) summary.campaigns = await campaigns.pull();
            summary.pruned = await limits.prune();
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
        /**
         * The shared page builds this worker keeps warm. Registered by app.js once the pages exist,
         * before start(); no timer runs while the worker is off (tests, restore drills).
         */
        warm(caches) { warmCaches = caches; },
        warmNow,
        start() {
            if (!config.worker.enabled) return;
            timer = timers.setInterval(() => { tick().catch(() => {}); }, config.worker.intervalMs);
            timer.unref();
            timers.setTimeout(() => { tick().catch(() => {}); }, 2000).unref();
            const everyMs = warmEveryMs();
            if (everyMs) {
                // Fill before the first reader, then rebuild before each window closes: a visitor's
                // request never pays for the front page's or /hot's latest-snapshot query.
                warmNow().catch(() => {});
                warmTimer = timers.setInterval(() => { warmNow().catch(() => {}); }, everyMs);
                warmTimer.unref();
            }
        },
        stop() {
            timers.clearInterval(timer);
            timers.clearInterval(warmTimer);
            warmTimer = null;
        },
        status: () => ({ enabled: config.worker.enabled, warming: warmTimer != null, last_error: lastError, last_tick_at: lastTickAt ? new Date(lastTickAt).toISOString() : null }),
    };
}

module.exports = { createWorker };
