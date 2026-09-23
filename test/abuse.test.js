'use strict';
/**
 * Vote abuse controls are server-side: rate limits per subject, per IP hash and per offer, no
 * voting on your own deal, reduced weight for new accounts, vote-ring flags for moderators.
 */
const assert = require('assert');
const { boot, check, done, HOUR } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { DEALS_VOTE_LIMIT_SUBJECT_HOUR: '4', DEALS_VOTE_LIMIT_IP_HOUR: '5', DEALS_VOTE_LIMIT_OFFER_HOUR: '3', DEALS_SUBMIT_LIMIT_DAY: '12', DEALS_RING_IP_MIN: '3', DEALS_RING_COVOTE_MIN: '3' } });
    const poster = t.network.addUser('poster');
    const offers = [];
    for (let i = 0; i < 8; i++) offers.push(await t.submit(poster, { url: `https://s.example/${i}`, title: `Offer number ${i}`, price: '1', currency: 'USD' }));
    const vote = (u, o, value, ip) => t.get(`/api/v1/offers/${o.id}/vote`, { method: 'PUT', as: u, json: { value }, ip });

    await check('you cannot vote on a deal you posted', async () => {
        const r = await vote(poster, offers[0], 1);
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'vote.own_offer');
        const form = await t.get(`/d/${offers[0].slug}`, { as: poster });
        assert.match(form.text, /You posted this deal/);
    });

    await check('per-subject limit: the fifth vote in an hour is 429 with Retry-After; an hour later it works', async () => {
        const u = t.network.addUser('busy');
        for (let i = 0; i < 4; i++) assert.strictEqual((await vote(u, offers[i], 1, `198.51.100.${i}`)).status, 200);
        const r = await vote(u, offers[4], 1, '198.51.100.9');
        assert.strictEqual(r.status, 429);
        assert.strictEqual(r.json().code, 'vote.rate_limited');
        assert.ok(Number(r.headers.get('retry-after')) > 0);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_votes WHERE subject = ?').get(u.subject).n, 4);
        t.clock.advance(HOUR + 1000);
        assert.strictEqual((await vote(u, offers[4], 1, '198.51.100.9')).status, 200);
    });

    await check('the same limit applies to the no-JS form (one server-side window)', async () => {
        const u = t.network.addUser('formy');
        for (let i = 0; i < 4; i++) await t.get(`/d/${offers[i].slug}/vote`, { as: u, form: { value: 'up' }, ip: '192.0.2.77' });
        const r = await t.get(`/d/${offers[5].slug}/vote`, { as: u, form: { value: 'up' }, ip: '192.0.2.78' });
        assert.strictEqual(r.status, 429);
        assert.match(r.text, /Too many vote actions/);
    });

    await check('per-IP-hash limit across accounts; the raw IP is never stored', async () => {
        t.clock.advance(HOUR + 1000);
        const ip = '203.0.113.50';
        const codes = [];
        for (let i = 0; i < 6; i++) codes.push((await vote(t.network.addUser(`ipuser${i}`), offers[6], 1, ip)).status);
        assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429]);
        const dump = JSON.stringify(t.ctx.store.db.prepare('SELECT * FROM deal_votes').all()) + JSON.stringify(t.ctx.store.db.prepare('SELECT * FROM rate_events').all()) + JSON.stringify(t.ctx.store.db.prepare('SELECT * FROM deal_flags').all());
        assert.ok(!dump.includes(ip), 'no raw IP in votes, rate windows or flags');
    });

    await check('five voters from one IP hash on one offer raise ONE open shared_ip vote-ring flag', async () => {
        const flags = t.ctx.store.db.prepare("SELECT * FROM deal_flags WHERE kind = 'vote_ring' AND reason = 'shared_ip'").all();
        assert.strictEqual(flags.length, 1);
        assert.strictEqual(flags[0].status, 'open');
        assert.strictEqual(flags[0].offer_id, offers[6].id);
        assert.strictEqual(JSON.parse(flags[0].details).voters.length, 5);
    });

    await check('per-offer change limit: flipping a vote over and over is refused', async () => {
        t.clock.advance(HOUR + 1000);
        const u = t.network.addUser('flipper');
        const codes = [];
        for (const v of [1, -1, 1, -1]) codes.push((await vote(u, offers[7], v, '192.0.2.10')).status);
        assert.deepStrictEqual(codes, [200, 200, 200, 429]);
        const same = await vote(u, offers[7], 1, '192.0.2.10');
        assert.strictEqual(same.status, 200, 'repeating the current vote is a no-op, not an action');
        assert.strictEqual(same.json().changed, false);
    });

    await check('two accounts voting in lockstep on several offers raise a covote vote-ring flag', async () => {
        t.clock.advance(HOUR + 1000);
        const a = t.network.addUser('ring_a');
        const b = t.network.addUser('ring_b');
        for (let i = 0; i < 3; i++) {
            assert.strictEqual((await vote(a, offers[i], 1, `10.0.${i}.1`)).status, 200);
            t.clock.advance(60 * 1000);
            assert.strictEqual((await vote(b, offers[i], 1, `10.1.${i}.1`)).status, 200);
        }
        const flags = t.ctx.store.db.prepare("SELECT * FROM deal_flags WHERE kind = 'vote_ring' AND reason = 'covote' AND status = 'open'").all();
        assert.strictEqual(flags.length, 1);
        const d = JSON.parse(flags[0].details);
        assert.deepStrictEqual(d.voters, [a.subject, b.subject].sort());
        assert.strictEqual(flags[0].origin, 'system');
    });

    await check('vote-ring flags are for moderators: /mod and GET /api/v1/flags; nobody else sees them', async () => {
        const anon = await t.get('/mod');
        assert.strictEqual(anon.status, 303);
        const user = await t.get('/mod', { as: poster });
        assert.strictEqual(user.status, 403);
        const page = await t.get('/mod', { as: t.mod });
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /vote_ring/);
        assert.match(page.text, /covote/);
        const denied = await t.get('/api/v1/flags', { as: poster });
        assert.strictEqual(denied.status, 403);
        const api = await t.get('/api/v1/flags', { as: t.mod });
        assert.strictEqual(api.status, 200);
        assert.ok(api.json().flags.some((f) => f.kind === 'vote_ring'));
        const svc = await t.get('/api/v1/flags', { as: t.network.serviceToken('ai', ['deals.offer.submit']) });
        assert.strictEqual(svc.status, 403);
    });

    await check('a moderator resolves a flag (audited); flags never change votes by themselves', async () => {
        const f = t.ctx.store.db.prepare("SELECT * FROM deal_flags WHERE reason = 'shared_ip'").get();
        const votesBefore = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_votes').get().n;
        const r = await t.get(`/mod/flags/${f.id}/resolve`, { as: t.mod, form: { resolution: 'checked' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT status FROM deal_flags WHERE id = ?').get(f.id).status, 'resolved');
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_votes').get().n, votesBefore);
        assert.ok(t.ctx.store.db.prepare("SELECT * FROM moderation_log WHERE action = 'flag.resolve'").get());
    });

    await check('a person\'s repeated report updates their open flag instead of adding another', async () => {
        const u = t.network.addUser('reporter');
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get(`/d/${offers[1].slug}/flag`, { as: u, form: { kind: 'expired', reason: `try ${i}` } })).status, 303);
        const rows = t.ctx.store.db.prepare('SELECT * FROM deal_flags WHERE reporter = ?').all(u.subject);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].reason, 'try 2');
    });

    await check('submission limit per person per day', async () => {
        const u = t.network.addUser('spammer');
        const codes = [];
        for (let i = 0; i < 13; i++) codes.push((await t.get('/submit', { as: u, form: { url: `https://spam.example/${i}`, title: `Spam ${i}` } })).status);
        assert.strictEqual(codes.filter((c) => c === 303).length, 12);
        assert.strictEqual(codes[12], 429);
    });

    await check('forms without a valid form token are refused (CSRF)', async () => {
        const u = t.network.addUser('csrf');
        const r = await t.get(`/d/${offers[3].slug}/vote`, { as: u, form: { value: 'up', csrf: 'forged' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_votes WHERE subject = ?').get(u.subject).n, 0);
    });

    await t.close();
    done();
})();
