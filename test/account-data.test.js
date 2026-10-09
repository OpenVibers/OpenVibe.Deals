'use strict';
/**
 * ADR-033: Deals' part of an account export and of an account deletion, through the signed /internal/events route
 * with a stand-in Network. The person makes real rows through the app (a watch, an offer with its price, a vote, a
 * report, a price report on someone else's offer); the export carries only theirs, and the deletion removes what is
 * theirs alone, leaves the shared catalog without their name, keeps staff records, and confirms once.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';

/** A stand-in for Network's internal routes: the token endpoint, the export part and the deletion confirmation. */
async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_deals', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const envelope = (id, type, payload) => ({ event: { event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), actor: { type: 'service', id: 'network' }, subject: { type: 'account', id: payload.subject }, visibility: 'internal', payload }, seq: 1 });

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'deals', clientSecret: 'shh' }) });
    const [alice, bob] = ['alice', 'bob'].map((n) => t.network.addUser(n));
    const post = (body) => t.get('/internal/events', { body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, 'whsec-test') } });
    const db = t.ctx.store.db;
    const count = async (sql, args) => Number(await db.value(sql, args));
    let mine;
    let theirs;

    try {
        await check('the person\'s rows are made through the app', async () => {
            assert.strictEqual((await t.get('/watches', { as: alice, form: { kind: 'keyword', query: 'headphones' } })).status, 303);
            theirs = await t.submit(bob, { url: 'https://audio.example/nc700', title: 'Noise cancelling headphones', price: '49.99', currency: 'USD' });
            mine = await t.submit(alice, { url: 'https://shop.example/kettle', title: 'Kettle by alice', price: '20', currency: 'EUR' });
            assert.strictEqual((await t.get(`/api/v1/offers/${theirs.slug}/vote`, { method: 'PUT', as: alice, json: { value: 1 } })).status, 200);
            assert.strictEqual((await t.get(`/api/v1/offers/${mine.slug}/vote`, { method: 'PUT', as: bob, json: { value: 1 } })).status, 200);
            const obs = await t.get(`/api/v1/offers/${theirs.slug}/observations`, { as: alice, json: { price: '44.00', currency: 'USD' } });
            assert.ok(obs.status < 300, obs.text.slice(0, 300));
            const flag = await t.get(`/api/v1/offers/${theirs.slug}/flags`, { as: alice, json: { kind: 'price_wrong', reason: 'cheaper now' } });
            assert.ok(flag.status < 300, flag.text.slice(0, 300));
            await db.exec(`INSERT INTO moderation_log (action, offer_id, actor, at) VALUES ('review', $1, $2, 1)`, [theirs.id, alice.subject]);
            await db.exec(`INSERT INTO deal_flags (id, offer_id, kind, origin, reason, details, dedupe_key, created_at, updated_at)
                VALUES ('dfl_ring', $1, 'vote_ring', 'system', 'covote', $2, 'ring:test', 1, 1)`,
            [theirs.id, JSON.stringify({ signal: 'covote', voters: [alice.subject, bob.subject], shared_offers: { [bob.subject]: 3 } })]);
            assert.ok(await count('SELECT count(*) FROM watch_notifications'), 'the watch notified (a row that hangs under the watch)');
        });

        await check('an export part carries only the person\'s rows, with this service\'s token', async () => {
            const r = await post(JSON.stringify(envelope('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: EXP, subject: alice.subject })));
            assert.deepStrictEqual([r.status, r.json().outcome], [200, 'exported'], r.text);
            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.strictEqual(part.auth, 'Bearer tok_deals');
            const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
            assert.deepStrictEqual(Object.keys(files).sort(), ['offers.json', 'price-reports.json', 'profile.json', 'reports.json', 'votes.json', 'watches.json']);
            assert.deepStrictEqual(files['offers.json'].map((o) => o.title), ['Kettle by alice']);
            assert.deepStrictEqual(files['votes.json'].map((v) => v.offer_id), [theirs.id]);
            assert.ok(files['price-reports.json'].some((o) => o.price === '44.00'));
            assert.deepStrictEqual(files['watches.json'].map((w) => w.query), ['headphones']);
            assert.ok(!JSON.stringify(part.body).includes(bob.subject), 'nobody else\'s id');
            assert.ok(!JSON.stringify(part.body).includes('ip_hash'), 'no ip hash');
        });

        await check('a deletion removes what is theirs, leaves the catalog authorless, keeps staff records, and confirms once', async () => {
            const body = JSON.stringify(envelope('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: DEL, subject: alice.subject }));
            const r = await post(body);
            assert.deepStrictEqual([r.status, r.json().outcome], [200, 'erased'], r.text);
            const a = [alice.subject];
            assert.strictEqual(await count('SELECT count(*) FROM deal_watches WHERE subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM deal_votes WHERE subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM deal_votes WHERE subject = $1', [bob.subject]), 1, 'bob\'s vote on alice\'s offer stays');
            assert.strictEqual(await count('SELECT count(*) FROM deal_offers WHERE id = $1 AND submitted_by IS NULL', [mine.id]), 1, 'her offer stays, authorless');
            assert.strictEqual(await count('SELECT count(*) FROM deal_price_observations WHERE observed_by = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM deal_flags WHERE reporter = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM deal_offer_sources WHERE ref_id = $1 OR submitted_by = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM subject_projections WHERE subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM moderation_log WHERE actor = $1', a), 1, 'the staff record stays');
            const ring = JSON.parse(await db.value("SELECT details FROM deal_flags WHERE id = 'dfl_ring'"));
            assert.deepStrictEqual(ring.voters, ['deleted', bob.subject], 'her id leaves the vote-ring evidence');
            const conf = stub.calls.filter((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.strictEqual(conf.length, 1);
            assert.strictEqual(conf[0].body.erased.deal_watches, 1);
            assert.strictEqual(conf[0].body.erased.deal_votes, 1);
            assert.ok(conf[0].body.erased.watch_notifications >= 1);
            assert.strictEqual(conf[0].body.retained.moderation_log, 1);
            assert.ok(conf[0].body.retained.tombstones >= 3);

            const again = await post(body);
            assert.strictEqual(again.json().duplicate, true, 'the inbox answers a redelivery');
            assert.strictEqual(stub.calls.filter((c) => c.url.includes('/confirmations')).length, 1, 'confirmed once');
        });

        await check('the route refuses a bad signature', async () => {
            const body = JSON.stringify(envelope('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: EXP, subject: alice.subject }));
            assert.strictEqual((await t.get('/internal/events', { body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, 'whsec-wrong-secret') } })).status, 401);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
