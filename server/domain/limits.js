'use strict';

/**
 * Server-side sliding-window limits kept in SQLite (rate_events), so they hold across restarts and
 * across every route that performs the same action (page forms and the API share them).
 *
 *   limits.check(kind, key, max, windowMs)   → throws 429 with retry_after when the window is full
 *   limits.hit(kind, key)                     records one action (inside the action's transaction)
 *
 * IP addresses are never stored: ipHash() is an HMAC under DEALS_IP_HASH_SECRET, truncated.
 */
const crypto = require('crypto');
const { ApiError } = require('./util');

const fallbackKey = crypto.randomBytes(32);

function createLimits({ config, store }) {
    const { db } = store;
    const count = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_events WHERE kind = ? AND key = ? AND at > ?');
    const insert = db.prepare('INSERT INTO rate_events (kind, key, at) VALUES (?, ?, ?)');
    const prune = db.prepare('DELETE FROM rate_events WHERE at < ?');

    function check(kind, key, max, windowMs, code = 'rate.limited') {
        if (!key || !(max > 0)) return;
        const since = store.now() - windowMs;
        const r = count.get(kind, key, since);
        if (r.n >= max) {
            const retry = Math.max(1, Math.ceil((r.oldest + windowMs - store.now()) / 1000));
            throw new ApiError(429, code, `Too many ${kind.replace(/_/g, ' ')} actions; try again in ${retry} s`, { retry_after: retry });
        }
    }

    function hit(kind, key) { if (key) insert.run(kind, key, store.now()); }

    function ipHash(ip) {
        if (!ip) return null;
        return crypto.createHmac('sha256', config.ipHashSecret || fallbackKey).update(`deals-ip:${ip}`).digest('base64url').slice(0, 22);
    }

    return { check, hit, ipHash, prune: (olderThanMs = 3 * 24 * 3600 * 1000) => prune.run(store.now() - olderThanMs).changes, stableIpHash: Boolean(config.ipHashSecret) };
}

module.exports = { createLimits };
