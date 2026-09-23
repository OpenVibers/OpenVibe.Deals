'use strict';

/**
 * OpenVibe.Sources — the deals-category items (capability sources.item.read, audience
 * openvibe.sources, Deals' client-credentials token).
 *
 *   items({ after, limit })   GET /api/v1/items?category=deals&after=<change_seq>&include_removed=1
 *                             → { items, next_after, more, sources: { key: { status, stale, last_success_at } } }
 *   item(id)                  GET /api/v1/items/:id → { item, source }
 *
 * A failed call throws; the importer keeps its cursor and tries again later. Nothing is invented
 * for an item Deals could not read.
 */
const { serviceAuth, http } = require('openvibe-contracts');

function createSources({ config, fetchImpl = globalThis.fetch }) {
    const base = config.sources.internalUrl;
    const enabled = Boolean(config.sources.enabled && config.oauth.clientSecret && base);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.sources', scope: 'sources.item.read', fetchImpl,
    }) : null;

    async function call(path, ctx) {
        if (!tokens) throw new Error('Sources import is not configured (OV_OAUTH_CLIENT_SECRET / OV_SOURCES_INTERNAL_URL / DEALS_IMPORT)');
        const res = await fetchImpl(`${base}${path}`, {
            headers: { Accept: 'application/json', ...(ctx ? http.outboundHeaders(ctx) : {}), ...(await tokens.authHeaders()) },
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) {
            const err = new Error(`Sources answered ${res.status}${data && data.code ? ` (${data.code})` : ''}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    return {
        enabled,
        items: ({ after = 0, limit = 100 } = {}, ctx) => call(`/api/v1/items?category=deals&after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}&include_removed=1`, ctx),
        item: (id, ctx) => call(`/api/v1/items/${encodeURIComponent(id)}`, ctx),
    };
}

module.exports = { createSources };
