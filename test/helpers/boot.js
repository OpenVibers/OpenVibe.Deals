'use strict';
/**
 * Boots Deals on a temp database with a controllable clock and mocks of its neighbours, and returns
 * a small HTTP client. Every test file gets its own instance.
 *
 *   const t = await boot();                  // t.get(path, { as: user | token, form, json, method, headers })
 *   t.clock.advance(ms)                      // the app's clock (freshness, hotness, limits, gate)
 *   t.events('deals.watch.matched')          // envelopes in event_outbox
 *   t.submit(user, { url, title, price, … }) // a deal through the no-JS form, → offer row
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork, startCommunity, startSources } = require('./mocks');

const HOUR = 3600 * 1000;

function makeClock(start = Date.parse('2026-09-22T12:00:00Z')) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; } };
}

async function boot(opts = {}) {
    const network = await startNetwork();
    const community = await startCommunity({ network });
    const sources = await startSources({ network });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-deals-test-'));
    const dbPath = path.join(dir, 'deals.db');
    const clock = opts.clock || makeClock();
    const mod = network.addUser('moddy', { display_name: 'Mod', role: 'global_mod' });
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.deals', TRUST_PROXY: '1',
        DEALS_DB_PATH: dbPath,
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'deals', OV_OAUTH_CLIENT_SECRET: 'shh', COOKIE_SECURE: 'false',
        OV_COMMUNITY_URL: 'https://openvibe.community', OV_COMMUNITY_INTERNAL_URL: community.url,
        OV_SOURCES_INTERNAL_URL: sources.url,
        DEALS_WORKER: 'off', DEALS_FORM_SECRET: 'test-form-secret', DEALS_IP_HASH_SECRET: 'test-ip-secret',
        DEALS_EVENTS_SECRET: 'whsec-test',
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const quiet = { log() {}, warn() {}, error: (...a) => { if (process.env.VERBOSE) console.error(...a); } };

    let server = null;
    let built = null;
    async function start() {
        const config = configLib.load(env);
        built = createApp({ config, now: clock.now, log: quiet });
        await built.ctx.auth.ensureKey();
        server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        t.base = `http://127.0.0.1:${server.address().port}`;
        t.app = built.app;
        t.ctx = built.ctx;
    }
    async function stop() {
        if (server) await new Promise((r) => server.close(r));
        if (built) { built.ctx.worker.stop(); await built.ctx.outbox.stop(); built.ctx.store.close(); }
        server = null; built = null;
    }

    /** as: a network user ({ subject, … }) → ov_token cookie; a string → Bearer token. ip → X-Forwarded-For. */
    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as && typeof o.as === 'object') headers.cookie = `ov_token=${network.userToken(o.as)}`;
        if (typeof o.as === 'string') headers.authorization = `Bearer ${o.as}`;
        if (o.ip) headers['x-forwarded-for'] = o.ip;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) {
            const f = { ...o.form };
            if (o.as && typeof o.as === 'object' && f.csrf === undefined) f.csrf = t.csrf(o.as);
            body = new URLSearchParams(f).toString();
            headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        const res = await fetch(t.base + p, { method: o.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text, json() { return JSON.parse(text); } };
    }

    /** Rows of event_outbox as parsed envelopes. */
    function events(type = null) {
        return t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope))
            .filter((e) => !type || e.event_type === type || (type instanceof RegExp && type.test(e.event_type)));
    }

    /** Submit through the no-JS form; → the offer row. */
    async function submit(user, fields, { ip } = {}) {
        const r = await get('/submit', { as: user, form: fields, ip });
        if (r.status !== 303) throw new Error(`submit answered ${r.status}: ${r.text.slice(0, 400)}`);
        const slug = decodeURIComponent(r.headers.get('location').replace(/^\/d\//, '').replace(/\?.*$/, ''));
        return t.ctx.reads.find(slug);
    }

    function offerJson(slug) { return get(`/d/${slug}.json`).then((r) => r.json().offer); }

    const t = {
        network, community, sources, clock, dbPath, mod, get, events, submit, offerJson, HOUR,
        csrf: (user) => require('../../server/auth/forms').csrfToken({ formSecret: env.DEALS_FORM_SECRET }, user),
        async restart() { await stop(); await start(); },
        async close() { await stop(); await network.close(); await community.close(); await sources.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
    await start();
    return t;
}

/** JSON-LD blocks of an HTML page. */
function jsonLd(htmlText) {
    return [...htmlText.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

const robotsOf = (htmlText) => (/<meta name="robots" content="([^"]+)"/.exec(htmlText) || [])[1];

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, makeClock, jsonLd, robotsOf, HOUR };
