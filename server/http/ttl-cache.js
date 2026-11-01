'use strict';

/**
 * One value shared by every reader, built at most once at a time and reused for ttlMs.
 *
 * A reader inside the window gets the value without touching the database. A reader after it gets
 * the value we already have while one background rebuild starts (stale-while-revalidate); only when
 * the value is older than maxStaleMs does a reader wait for the build. So a slow build costs the
 * first reader after a deploy and nobody else, and a failed rebuild never outlives maxStaleMs.
 *
 * ttlMs = 0 turns it off: every read builds, exactly as before.
 */
function ttlCache(build, { ttlMs = 0, maxStaleMs = 0, now = Date.now } = {}) {
    const ttl = Math.max(0, Number(ttlMs) || 0);
    const maxStale = Math.max(ttl, Number(maxStaleMs) || 0);
    let value = null;
    let at = 0;
    let running = null;

    function refresh() {
        if (!running) {
            running = Promise.resolve().then(build).then((v) => {
                value = v;
                at = now();
                return v;
            }).finally(() => { running = null; });
        }
        return running;
    }

    return async function read() {
        if (!ttl) return await refresh();
        if (value) {
            const age = Math.max(0, now() - at);
            if (age < ttl) return value;
            if (age < maxStale) {
                // Serve what we have; the next readers get the rebuild. A failed rebuild keeps the
                // old value until maxStale, then the next reader waits for one and sees the error.
                refresh().catch(() => {});
                return value;
            }
        }
        return await refresh();
    };
}

module.exports = { ttlCache };
