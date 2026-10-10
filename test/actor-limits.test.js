'use strict';
/**
 * Per-actor rate limits (server/http/actor-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. A person is counted as themselves
 * whether they call directly or a service names them; a service relaying signed-out visitors is
 * counted by each forwarded address; a service reading for itself is not counted. Writes have their
 * own budget, shared by the API and the page form. Health, ready, release.json, metrics and the
 * signed Events deliveries are never limited; refusals are logged and counted.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { actor, serviceItself } = require('../server/http/actor-limits');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const lines = [];
    const log = { log() {}, error() {}, warn: (m) => lines.push(String(m)) };
    const t = await boot({ env: { DEALS_LIMITS_MINUTE: '3', DEALS_LIMITS_HOUR: '100', DEALS_WATCH_LIMIT: '100' }, limitsNow: () => clock, log });
    const ann = t.network.addUser('ann');
    const ben = t.network.addUser('ben');
    const svc = t.network.serviceToken('ai', ['deals.watch.read', 'deals.watch.create']);

    await check('a read: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/offers', { as: ann })).status, 200);
        const r = await t.get('/api/v1/offers', { as: ann });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')), r.headers.get('content-type'));
        const body = r.json();
        assert.deepStrictEqual([body.code, body.status, body.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(body.detail.includes('deals.read'), body.detail);
        assert.strictEqual((await t.get('/api/v1/offers', { as: ben })).status, 200, 'another person still passes');
    });

    await check('/search takes the read defaults too: 3 a minute per person, then 429 rate_limited', async () => {
        const cat = t.network.addUser('cat');
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/search?q=drone', { as: cat })).status, 200);
        const r = await t.get('/search?q=drone', { as: cat });
        assert.strictEqual(r.status, 429, r.text);
        assert.ok(r.json().detail.includes('deals.search'), r.json().detail);
    });

    await check('a service naming the person counts against that person', async () => {
        const r = await t.get('/api/v1/watches', { as: svc, headers: { 'X-OV-Subject': ann.subject } });
        assert.deepStrictEqual([r.status, r.json().code], [429, 'rate_limited']);
    });

    await check('relayed visitors count by forwarded address; a service reading for itself is not counted', async () => {
        const visitor = (ip) => t.get('/api/v1/offers', { as: svc, headers: { 'X-Forwarded-For': ip } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await visitor('203.0.113.7')).status, 200);
        assert.strictEqual((await visitor('203.0.113.7')).status, 429);
        assert.strictEqual((await visitor('203.0.113.8')).status, 200, 'another visitor still passes');
        for (let i = 0; i < 6; i++) assert.strictEqual((await t.get('/api/v1/offers', { as: svc })).status, 200);
    });

    await check('the next minute opens the window again', async () => {
        clock += 45 * 1000;
        assert.strictEqual((await t.get('/api/v1/offers', { as: ann })).status, 200);
    });

    await check('a write has its own budget (30 watch changes a minute), shared by the API and the form; nothing stored past it', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        const stored = async (u) => (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_watches WHERE subject = ?').get(u.subject)).n;
        for (let i = 0; i < 30; i++) {
            const r = await t.get('/api/v1/watches', { as: ann, json: { kind: 'keyword', query: `thing ${i}` } });
            assert.strictEqual(r.status, 201, `watch ${i + 1}: ${r.text}`);
        }
        const before = await stored(ann);
        const r = await t.get('/watches', { as: ann, form: { kind: 'keyword', query: 'one more' } });
        assert.deepStrictEqual([r.status, r.json().code, r.headers.get('retry-after')], [429, 'rate_limited', '60'], 'the form shares the API budget');
        assert.ok(r.json().detail.includes('deals.watch'), r.json().detail);
        assert.strictEqual(await stored(ann), before, 'nothing stored');
        assert.strictEqual((await t.get('/api/v1/watches', { as: ben, json: { kind: 'keyword', query: 'mine' } })).status, 201, 'another person still writes');
    });

    await check('health, ready, release.json, metrics and the Events deliveries are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.get('/api/health')).status, 200);
            assert.notStrictEqual((await t.get('/api/ready')).status, 429);
            assert.strictEqual((await t.get('/release.json')).status, 200);
            assert.strictEqual((await t.get('/metrics')).status, 200);
            assert.notStrictEqual((await t.get('/internal/events', { method: 'POST', json: {} })).status, 429);
        }
    });

    await check('refusals are counted in deals_rate_limited_total and logged without a token', async () => {
        const m = (await t.get('/metrics')).text;
        const counted = m.split('\n').filter((l) => l.includes('deals_rate_limited_total')).join('\n');
        assert.ok(/deals_rate_limited_total\{limit="deals.read",window="minute"\} 3/.test(m), counted);
        assert.ok(/deals_rate_limited_total\{limit="deals.watch",window="minute"\} 1/.test(m), counted);
        assert.ok(lines.some((l) => l.includes(`deals.read: user:${ann.subject} refused`)), lines.join('\n'));
        assert.ok(!lines.some((l) => /eyJ/.test(l)), 'a token in the log');
    });

    await check('who is counted', () => {
        const q = (viewer, { xff = null, ip = '127.0.0.1' } = {}) => ({ viewer, ip, get: (n) => (n === 'x-forwarded-for' ? xff : undefined) });
        assert.strictEqual(actor(q({ kind: 'user', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'ip:203.0.113.9');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: null })), 'svc:ai', 'acting as itself');
        assert.strictEqual(actor(q({ kind: 'service', service: 'app:app_1', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'app:app_1', 'an app never relays by address');
        assert.strictEqual(actor(q({ kind: 'anonymous', subject: null }, { ip: '198.51.100.4' })), 'ip:198.51.100.4');
        assert.strictEqual(serviceItself(q({ kind: 'service', service: 'svc:ai', subject: null })), true);
        assert.strictEqual(serviceItself(q({ kind: 'service', service: 'app:app_1', subject: null })), false);
    });

    await t.close();
    done();
})();
