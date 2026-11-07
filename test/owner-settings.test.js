'use strict';
/**
 * Owner settings (D11) for Deals' data sources (server/settings.js, deals.data_sources):
 *   - the Woot API key has a plain title, a 30+ character description, x-owner-input words and a test;
 *   - /internal/config is loopback only and needs deals.config.manage;
 *   - the key is write-only and marked in summaries, the code reads the owner value and falls back
 *     to WOOT_API_KEY, and the test hook never echoes or logs the key.
 *   node test/owner-settings.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { boot } = require('./helpers/boot');
const { createSettings } = require('../server/settings');

const CAP = 'deals.config.manage';
const NS = 'deals.data_sources';
const USR = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const KEY = 'woot-owner-key-sentinel';
const ENV_KEY = 'woot-env-key';

(async () => {
    const t = await boot({ env: { WOOT_API_KEY: ENV_KEY } });
    const TOKEN = t.network.serviceToken('network', [CAP]);
    const checks = [];
    const check = async (name, fn) => {
        try { await fn(); checks.push(name); console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n${e.stack}`); await t.close(); process.exit(1); }
    };

    await check('the Woot key has owner words and a test', async () => {
        const r = await t.get(`/internal/config/${NS}`, { as: TOKEN });
        assert.strictEqual(r.status, 200, r.text);
        const f = r.json().schema.properties.woot_api_key;
        assert.ok(f, 'woot_api_key exists');
        assert.ok(f.title && f.title.length >= 3);
        assert.ok(f.description && f.description.length >= 30);
        assert.strictEqual(f['x-owner-input'].group, 'Data sources');
        assert.ok(f['x-owner-input'].unlocks.length > 20);
        assert.strictEqual(f['x-owner-input'].get_it_at, 'https://developer.woot.com/');
        assert.strictEqual(f['x-owner-input'].test, true);
        assert.strictEqual(f['x-required-for'], 'Woot API deals');
    });

    await check('the routes are loopback only and need the capability', async () => {
        assert.strictEqual((await t.get(`/internal/config/${NS}`)).status, 401);
        assert.strictEqual((await t.get(`/internal/config/${NS}`, { as: t.network.serviceToken('network', ['deals.watch.read']) })).status, 403);
        assert.strictEqual((await t.get(`/internal/config/${NS}`, { as: TOKEN, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 404);
    });

    await check('the key is write-only and the environment is the fallback', async () => {
        assert.strictEqual(t.ctx.settings.wootApiKey(), ENV_KEY, 'the env is the fallback');
        const put = await t.get(`/internal/config/${NS}/secrets/woot_api_key`, {
            as: TOKEN, method: 'PUT', json: { value: KEY, reason: 'owner test' }, headers: { 'x-ov-subject': USR, 'x-ov-fresh': '1' },
        });
        assert.strictEqual(put.status, 200, put.text);
        assert.ok(put.json().fingerprint && put.json().hint);
        assert.ok(!put.text.includes(KEY), 'the marker never carries the value');
        const summary = await t.get(`/internal/config/${NS}`, { as: TOKEN });
        assert.ok(summary.json().values.woot_api_key.redacted);
        assert.ok(!summary.text.includes(KEY));
        assert.strictEqual(t.ctx.settings.wootApiKey(), KEY, 'the code reads the owner value when set');
    });

    await check('the test hook says ok/failed in one line and never echoes a key', async () => {
        const before = t.logs ? t.logs().length : 0;
        const fake = createSettings({
            db: t.ctx.store.db, env: {},
            probes: { woot: async ({ apiKey }) => { throw new Error(`refused ${apiKey}`); } },
        });
        await fake.ready;
        const app = express();
        app.use(express.json());
        fake.mount(app, { guard: (_req, _res, next) => next(), log: t.log });
        const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const r = await fetch(`http://127.0.0.1:${server.address().port}/internal/config/${NS}/test/woot_api_key`, { method: 'POST' });
            const body = await r.json();
            assert.strictEqual(r.status, 200);
            assert.strictEqual(body.ok, false);
            assert.ok(/^failed — Woot said: /.test(body.detail), body.detail);
            assert.ok(!body.detail.includes(KEY));
            assert.ok(!body.detail.includes('\n'));
        } finally { server.close(); }
        assert.ok(!(t.logs ? t.logs() : '').includes(KEY), 'no key in a captured log line');
    });

    await t.close();
    console.log(`\n${checks.length} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
