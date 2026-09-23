'use strict';
/**
 * /api/v1: one capability per route for service tokens, X-OV-Subject for the acting person,
 * problem+json errors with request ids, AI-assisted text held for review, and every event and
 * Search document valid against the released contracts.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const [alice, bob] = ['alice', 'bob'].map((n) => t.network.addUser(n));
    const svc = (caps, client = 'ai') => t.network.serviceToken(client, caps);
    let offer;

    await check('a service token without the route\'s capability is refused (problem+json, legacy error field, request id)', async () => {
        const r = await t.get('/api/v1/offers', { as: svc(['deals.vote.set']), headers: { 'X-OV-Subject': alice.subject, 'X-OpenVibe-Request-Id': 'req-abc-123' }, json: { url: 'https://a.example/', title: 'Hello' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.headers.get('content-type'), /application\/problem\+json/);
        const body = r.json();
        assert.strictEqual(body.code, 'capability.denied');
        assert.ok(body.error, 'legacy error field');
        assert.strictEqual(r.headers.get('x-openvibe-request-id'), 'req-abc-123');
    });

    await check('a bad service token is refused, never downgraded to anonymous', async () => {
        const forged = t.network.signService({ sub: 'svc:ai', aud: ['openvibe.other'], cap: ['deals.offer.submit'] });
        const r = await t.get('/api/v1/offers', { as: forged, json: { url: 'https://a.example/', title: 'Hello' } });
        assert.strictEqual(r.status, 401);
    });

    await check('a service must name the person it acts for', async () => {
        const r = await t.get('/api/v1/offers', { as: svc(['deals.offer.submit']), json: { url: 'https://a.example/', title: 'Hello' } });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.json().code, 'subject.required');
    });

    await check('submit via API for a person; the answer is the full offer with its first observation', async () => {
        const r = await t.get('/api/v1/offers', { as: svc(['deals.offer.submit'], 'live'), headers: { 'X-OV-Subject': alice.subject }, json: { url: 'https://apps.example/game', title: 'Game bundle', price: '9.99', currency: 'usd', availability: 'online_only' } });
        assert.strictEqual(r.status, 201, r.text);
        offer = r.json().offer;
        assert.strictEqual(offer.submitted_by, alice.subject);
        assert.strictEqual(offer.latest_observation.currency, 'USD');
        assert.strictEqual(offer.latest_observation.availability, 'online_only');
        assert.strictEqual(offer.observations.length, 1);
        const dup = await t.get('/api/v1/offers', { as: alice, json: { url: 'https://apps.example/game?utm_medium=x', title: 'Again' } });
        assert.strictEqual(dup.status, 409);
        assert.strictEqual(dup.json().code, 'offer.duplicate');
        assert.strictEqual(dup.json().existing.id, offer.id);
    });

    await check('AI-assisted text (X-OV-Origin: ai) is disclosed and noindex until a person reviews it', async () => {
        const ai = svc(['deals.offer.update']);
        const denied = await t.get(`/api/v1/offers/${offer.id}`, { method: 'PATCH', as: ai, headers: { 'X-OV-Subject': bob.subject, 'X-OV-Origin': 'ai' }, json: { ai_summary: 'x' } });
        assert.strictEqual(denied.status, 403, 'bob did not submit it');
        const r = await t.get(`/api/v1/offers/${offer.id}`, { method: 'PATCH', as: ai, headers: { 'X-OV-Subject': alice.subject, 'X-OV-Origin': 'ai' }, json: { ai_summary: 'A bundle of five indie games.' } });
        assert.strictEqual(r.status, 200, r.text);
        const o = r.json().offer;
        assert.strictEqual(o.review_state, 'pending');
        assert.strictEqual(o.indexability.indexable, false);
        const page = await t.get(`/d/${o.slug}`);
        assert.match(page.text, /AI-assisted summary<\/strong> \(not yet reviewed by a person\)/);
        const human = await t.get(`/api/v1/offers/${offer.id}`, { method: 'PATCH', as: alice, json: { ai_summary: 'fake' } });
        assert.strictEqual(human.status, 422, 'only OpenVibe.AI writes ai_summary');
        const svcReview = await t.get(`/api/v1/offers/${offer.id}/review`, { as: svc(['deals.offer.moderate'], 'mod-bot'), json: {} });
        assert.strictEqual(svcReview.status, 403, 'a review is recorded for a person, not a service');
        const rev = await t.get(`/api/v1/offers/${offer.id}/review`, { as: t.mod, json: {} });
        assert.strictEqual(rev.status, 200);
        assert.strictEqual(rev.json().offer.review_state, 'reviewed');
        assert.strictEqual(rev.json().offer.indexability.indexable, true);
    });

    await check('votes over the API: set, change, remove; server-computed counts', async () => {
        const put = await t.get(`/api/v1/offers/${offer.slug}/vote`, { method: 'PUT', as: svc(['deals.vote.set'], 'live'), headers: { 'X-OV-Subject': bob.subject }, json: { value: 1 } });
        assert.strictEqual(put.status, 200, put.text);
        assert.deepStrictEqual(put.json().votes.up, 1);
        const bad = await t.get(`/api/v1/offers/${offer.slug}/vote`, { method: 'PUT', as: bob, json: { value: 5 } });
        assert.strictEqual(bad.status, 422);
        const del = await t.get(`/api/v1/offers/${offer.slug}/vote`, { method: 'DELETE', as: bob });
        assert.strictEqual(del.status, 200);
        assert.deepStrictEqual([del.json().votes.up, del.json().previous, del.json().changed], [0, 1, true]);
        const noCap = await t.get(`/api/v1/offers/${offer.slug}/vote`, { method: 'DELETE', as: svc(['deals.vote.set'], 'live'), headers: { 'X-OV-Subject': bob.subject } });
        assert.strictEqual(noCap.status, 403, 'removing needs deals.vote.remove');
    });

    await check('products/resolve finds by alias, creates only when asked, reports alias conflicts', async () => {
        const tok = svc(['deals.product.resolve'], 'reviews');
        const a = await t.get('/api/v1/products/resolve', { as: tok, json: { name: 'Pixel Watch 3', gtin: '0840244706326', mpn: 'GA05785' } });
        assert.strictEqual(a.status, 201);
        const again = await t.get('/api/v1/products/resolve', { as: tok, json: { gtin: '840244706326' } });
        assert.deepStrictEqual([again.status, again.json().product.id, again.json().created], [200, a.json().product.id, false]);
        const miss = await t.get('/api/v1/products/resolve', { as: tok, json: { mpn: 'NOPE', create: false } });
        assert.strictEqual(miss.status, 404);
        const other = await t.get('/api/v1/products/resolve', { as: tok, json: { name: 'Pixel Watch 3 LTE', mpn: 'GA05785X' } });
        const conflict = await t.get('/api/v1/products/resolve', { as: tok, json: { name: 'Pixel Watch 3 LTE', gtin: '0840244706326' } });
        assert.strictEqual(conflict.json().product.id, a.json().product.id, 'the gtin wins, it already names a product');
        assert.ok(other.json().product.id !== a.json().product.id);
        const pub = await t.get(`/api/v1/products/${a.json().product.slug}`);
        assert.strictEqual(pub.status, 200);
    });

    await check('merge via API needs deals.offer.merge; a moderator grant is the decision for a service', async () => {
        const second = (await t.get('/api/v1/offers', { as: bob, json: { url: 'https://apps.example/game-bundle', title: 'Game bundle (same)' } })).json().offer;
        const no = await t.get(`/api/v1/offers/${second.id}/merge`, { as: svc(['deals.offer.moderate'], 'mod-bot'), json: { into: offer.id } });
        assert.strictEqual(no.status, 403);
        const user = await t.get(`/api/v1/offers/${second.id}/merge`, { as: bob, json: { into: offer.id } });
        assert.strictEqual(user.status, 403);
        const yes = await t.get(`/api/v1/offers/${second.id}/merge`, { as: svc(['deals.offer.merge'], 'mod-bot'), json: { into: offer.id, reason: 'same bundle' } });
        assert.strictEqual(yes.status, 200, yes.text);
        assert.deepStrictEqual(yes.json().offer.merged_from.map((m) => m.id), [second.id]);
        const merged = await t.get(`/api/v1/offers/${second.id}`);
        assert.strictEqual(merged.json().offer.id, offer.id, 'a merged id answers with its canonical offer');
    });

    await check('flags via API: one open report per person and offer', async () => {
        const tok = svc(['deals.flag.create'], 'live');
        const a = await t.get(`/api/v1/offers/${offer.id}/flags`, { as: tok, headers: { 'X-OV-Subject': bob.subject }, json: { kind: 'price_wrong', reason: 'now 12.99' } });
        assert.strictEqual(a.status, 201);
        const b = await t.get(`/api/v1/offers/${offer.id}/flags`, { as: tok, headers: { 'X-OV-Subject': bob.subject }, json: { kind: 'price_wrong' } });
        assert.deepStrictEqual([b.status, b.json().created], [200, false]);
        const bad = await t.get(`/api/v1/offers/${offer.id}/flags`, { as: tok, headers: { 'X-OV-Subject': bob.subject }, json: { kind: 'hate' } });
        assert.strictEqual(bad.status, 422);
    });

    await check('API responses are private and noindex; unknown routes are problem 404', async () => {
        const r = await t.get(`/api/v1/offers/${offer.id}`);
        assert.match(r.headers.get('cache-control'), /private, no-store/);
        assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex');
        const nf = await t.get('/api/v1/nope');
        assert.strictEqual(nf.status, 404);
        assert.strictEqual(nf.json().code, 'route.not_found');
        assert.strictEqual((await t.get('/api/v1/offers/dof_01K5NOPE0000000000000000000')).json().code, 'offer.not_found');
    });

    await check('every event validates as events.event-envelope@1; every Search document as search.index-document@1', async () => {
        const all = t.events();
        assert.ok(all.length > 10);
        const types = new Set();
        for (const e of all) {
            types.add(e.event_type);
            const v = contracts.validate('events.event-envelope@1', e);
            assert.ok(v.valid, `${e.event_type}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(e.source, 'deals');
            if (e.event_type === 'deals.index_document.upserted') {
                const d = contracts.validate('search.index-document@1', { ...e.payload });
                assert.ok(d.valid, JSON.stringify(d.errors));
                assert.strictEqual(e.visibility, 'internal');
            }
        }
        for (const x of ['deals.offer.created', 'deals.offer.updated', 'deals.vote.changed', 'deals.index_document.upserted', 'deals.index_document.deleted']) assert.ok(types.has(x), x);
        const votes = all.filter((e) => e.event_type === 'deals.vote.changed');
        assert.ok(votes.every((e) => e.visibility === 'internal'), 'who voted is not public');
    });

    await t.close();
    done();
})();
