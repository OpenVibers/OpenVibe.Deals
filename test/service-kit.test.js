'use strict';
/**
 * openvibe-sdk/service (plan T1): Deals' shared JSON body parser answers 413 for a body over 64 kB
 * (the hand-rolled express.json answered 400 request.invalid_json there) and 415 for an encoding it
 * cannot read; an ApiError refusal keeps its own status and code and its Retry-After header; and the
 * entry point's graceful stop runs its stop and close steps, then exits 0.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { boot, check, done } = require('./helpers/boot');
const { createLifecycle } = require('../server/index');
const errors = require('../server/http/errors');

(async () => {
    const t = await boot();

    const app = express();
    app.post('/echo', errors.jsonBody, errors.run(async () => ({ ok: true })));
    app.post('/refuse', errors.run(async () => { throw new errors.ApiError(429, 'rate.limited', 'Slow down', { retry_after: 7 }); }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

    const read = async (r) => { const text = await r.text(); return { status: r.status, headers: r.headers, text, json: JSON.parse(text) }; };

    await check('a JSON body over 64 kB is 413 request.too_large, not 400 request.invalid_json', async () => {
        const r = await read(await post('/echo', JSON.stringify({ padding: 'y'.repeat(70 * 1024) })));
        assert.strictEqual(r.status, 413, r.text);
        assert.strictEqual(r.json.code, 'request.too_large');
    });

    await check('malformed JSON is 400 request.invalid_json', async () => {
        const r = await read(await post('/echo', '{oops'));
        assert.strictEqual(r.status, 400, r.text);
        assert.strictEqual(r.json.code, 'request.invalid_json');
    });

    await check('a Content-Encoding the parser cannot read is 415 request.unsupported_encoding', async () => {
        const r = await read(await post('/echo', '{}', { 'content-encoding': 'xz' }));
        assert.strictEqual(r.status, 415, r.text);
        assert.strictEqual(r.json.code, 'request.unsupported_encoding');
    });

    await check('an ApiError refusal keeps its status and code and sets Retry-After from extra.retry_after', async () => {
        const r = await read(await post('/refuse', '{}'));
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '7');
        assert.strictEqual(r.json.code, 'rate.limited');
    });

    await check('the entry point stop runs its stop and close steps, then exits 0', async () => {
        const steps = [];
        const spy = (obj, method, label) => {
            const orig = obj[method].bind(obj);
            obj[method] = (...a) => { steps.push(label); return orig(...a); };
        };
        spy(t.ctx.worker, 'stop', 'worker.stop');
        spy(t.ctx.outbox, 'stop', 'outbox.stop');
        spy(t.ctx.store, 'close', 'store.close');

        const stopServer = http.createServer(t.app);
        await new Promise((resolve) => stopServer.listen(0, '127.0.0.1', resolve));

        const exits = [];
        const lifecycle = createLifecycle({ server: stopServer, ctx: t.ctx, exit: (code) => exits.push(code), signals: false });
        const code = await lifecycle.stop('SIGTERM');

        assert.strictEqual(code, 0);
        assert.deepStrictEqual(exits, [0]);
        assert.deepStrictEqual(steps, ['worker.stop', 'outbox.stop', 'store.close']);
        assert.strictEqual(stopServer.listening, false);
    });

    server.close();
    try { await t.close(); } catch { /* the lifecycle above already closed the store */ }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
