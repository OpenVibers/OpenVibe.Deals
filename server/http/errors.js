'use strict';

/**
 * Errors as RFC 9457 problems (contracts errors.problem@1, which keeps the legacy { error } field),
 * and the small request helpers every router shares. Built from openvibe-sdk/service (docs/service.md,
 * the Deals row) so every service answers the same way; the exports stay put so no call site moves.
 * ApiError stays Deals' own refusal (server/domain/values.js): the kit answers any error carrying an
 * HTTP status and a string code with its own status and code, and anything else as a generic 500.
 */
const svc = require('openvibe-sdk/service');
const cache = require('openvibe-shared/cache-policy');
const { ApiError } = require('../domain/values');

const o = { name: 'Deals API', ServiceError: ApiError };

/**
 * Wrap a JSON handler: its return value is the body; errors become problems. The kit's sendError does
 * not set Retry-After, so an ApiError refusal carrying err.extra.retry_after sets that header here.
 */
const run = (fn, status) => svc.run(async (req, res) => {
    try {
        return await fn(req, res);
    } catch (err) {
        if (err instanceof ApiError && err.extra && err.extra.retry_after) res.set('Retry-After', String(err.extra.retry_after));
        throw err;
    }
}, status, o);

/** JSON body parser whose failures are problems too: malformed 400, over 64 kB 413, unreadable encoding 415. */
const jsonBody = svc.jsonBody({ limit: '64kb' });

/** Private, per-viewer responses: never stored by a shared cache, never indexed. */
function privateNoStore(res) {
    res.set('Cache-Control', cache.htmlHeaders({ private: true }));
    res.vary('Cookie');
    res.vary('Authorization');
}

module.exports = { ApiError, run, jsonBody, privateNoStore };
