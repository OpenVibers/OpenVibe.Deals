'use strict';

/**
 * Errors as RFC 9457 problems (contracts errors.problem@1, which keeps the legacy { error } field),
 * and the small request helpers every router shares.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { ApiError } = require('../domain/util');

/** Wrap a JSON handler: its return value is the body; errors become problems. */
function run(fn, status = 200) {
    return async (req, res) => {
        try {
            const out = await fn(req, res);
            if (out === undefined || res.headersSent) return;
            res.status(typeof status === 'function' ? status(out) : status).json(out);
        } catch (err) {
            if (res.headersSent) return;
            if (err instanceof ApiError) {
                if (err.extra && err.extra.retry_after) res.set('Retry-After', String(err.extra.retry_after));
                return contracts.http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov, extra: err.extra || undefined });
            }
            console.error('[Deals API]', err && err.stack ? err.stack : err);
            contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        }
    };
}

const jsonParser = express.json({ limit: '64kb' });
/** JSON body parser whose syntax errors are problems too. */
function jsonBody(req, res, next) {
    jsonParser(req, res, (err) => (err ? contracts.http.sendProblem(res, 400, 'request.invalid_json', { detail: 'Malformed JSON body', ctx: req.ov }) : next()));
}

/** Private, per-viewer responses: never stored by a shared cache, never indexed. */
function privateNoStore(res) {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    res.vary('Authorization');
}

module.exports = { ApiError, run, jsonBody, privateNoStore };
