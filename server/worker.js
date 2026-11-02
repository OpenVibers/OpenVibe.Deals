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
    // stop(): no new tick starts, the one running ends at its next step, and stop() waits for it, so nothing touches
    // the database after the service closes its pool ("worker tick failed: Cannot use a pool after calling end on
    // the pool" on each deploy, 2026-11-02: the re-index loop runs offer by offer for minutes).
    let stopping = false;
    let current = null;
    // The re-index (plan T9's freshness): every write re-indexes its own offer (offers.js), and the document changes
    // with time alone only when the latest price comes of age (freshnessMs, 48 h). So a tick re-indexes the offers
    // whose observation crossed that line since the last pass, and the whole set only at boot and once a day (a
    // safety net, and how a change to the document's shape reaches every offer). Rebuilding all ~40,000 documents
    // every ten minutes cost about half a core and 26 reads a second (2026-11-02).
    const FULL_EVERY_MS = 24 * 3_600_000;
    const MARGIN_MS = 60_000;
    let lastFullAt = null;
    let lastPassAt = null;
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
        if (running || stopping) return null;
        running = true;
        const run = runTick();
        current = run;
        try { return await run; } finally { current = null; }
    }

    async function runTick() {
        const summary = {};
        try {
            summary.expired = await offers.expireDue();
            if (stopping) return summary;
            summary.snapshots = await hotness.tick({ windowDays: config.worker.hotWindowDays });
            let reindexed = 0;
            const passAt = store.now();
            const full = lastFullAt == null || lastPassAt == null || passAt - lastFullAt >= FULL_EVERY_MS || typeof listings.agedInto !== 'function';
            if (full) {
                for (const o of await listings.indexable()) {
                    if (stopping) return summary;
                    await store.tx(async () => { if (await indexing.indexOffer(o)) reindexed++; });
                }
                for (const p of await listings.products()) {
                    if (stopping) return summary;
                    await store.tx(async () => { if (await indexing.indexProduct(p)) reindexed++; });
                }
                lastFullAt = passAt;
            } else {
                // The offers that came of age since the last pass, and their products (reindex does both).
                const aged = await listings.agedInto(lastPassAt - MARGIN_MS, passAt, config.freshnessMs || 48 * 3_600_000);
                for (const o of aged) {
                    if (stopping) return summary;
                    await store.tx(async () => { await indexing.reindex(o); reindexed++; });
                }
            }
            lastPassAt = passAt;
            summary.reindexed = reindexed;
            summary.reindex = full ? 'full' : 'aged';
            if (stopping) return summary;
            summary.import = await importer.pull();
            if (stopping) return summary;
            summary.refresh = await importer.refresh();
            if (campaigns && !stopping) summary.campaigns = await campaigns.pull();
            if (stopping) return summary;
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
        /** Stop: no new tick, the running one ends at its next step; resolves once it has. */
        stop() {
            stopping = true;
            timers.clearInterval(timer);
            timers.clearInterval(warmTimer);
            warmTimer = null;
            return current ? current.then(() => undefined, () => undefined) : Promise.resolve();
        },
        status: () => ({ enabled: config.worker.enabled, warming: warmTimer != null, last_error: lastError, last_tick_at: lastTickAt ? new Date(lastTickAt).toISOString() : null }),
    };
}

module.exports = { createWorker };
