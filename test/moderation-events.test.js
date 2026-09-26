'use strict';
/**
 * deals.moderation.action (ADR-022): a moderator acting on someone else's offer or on a report goes
 * to Network's moderation audit log, from the outbox in the same transaction; the submitter acting
 * on their own offer reports nothing.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const poster = t.network.addUser('poster');
    const reporter = t.network.addUser('reporter');
    const moderation = () => t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()
        .map((r) => JSON.parse(r.envelope)).filter((e) => e.event_type === 'deals.moderation.action');
    const valid = (e) => {
        assert.strictEqual(contracts.validate('events.event-envelope@1', e).valid, true, JSON.stringify(e));
        const r = contracts.validate('deals.moderation.action@1', e.payload);
        assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
        assert.strictEqual(e.source, 'deals');
        assert.strictEqual(e.visibility, 'internal');
        assert.deepStrictEqual(e.actor, { type: 'user', id: t.mod.subject });
        assert.strictEqual(e.payload.actor_subject, t.mod.subject);
    };

    await check('the submitter editing and expiring their own offer reports nothing', async () => {
        const o = await t.submit(poster, { url: 'https://s.example/own', title: 'My own offer', price: '5', currency: 'USD' });
        assert.strictEqual((await t.get(`/api/v1/offers/${o.id}`, { method: 'PATCH', as: poster, json: { title: 'My own offer, edited' } })).status, 200);
        assert.strictEqual((await t.get(`/api/v1/offers/${o.id}/expire`, { as: poster, json: {} })).status, 200);
        assert.strictEqual(moderation().length, 0);
    });

    await check('a moderator disabling someone else\'s offer: exactly one valid event', async () => {
        const o = await t.submit(poster, { url: 'https://s.example/spam', title: 'Spammy offer', price: '1', currency: 'USD' });
        const r = await t.get(`/api/v1/offers/${o.id}/disable`, { as: t.mod, json: { reason: 'Referral spam' } });
        assert.strictEqual(r.status, 200, r.text);
        const ev = moderation();
        assert.strictEqual(ev.length, 1);
        valid(ev[0]);
        assert.deepStrictEqual(ev[0].subject, { type: 'moderation_action', id: `offer:${o.id}` });
        assert.strictEqual(ev[0].payload.action, 'offer.disabled');
        assert.deepStrictEqual(ev[0].payload.target, { type: 'offer', id: o.id, owner_subject: poster.subject });
        assert.strictEqual(ev[0].payload.reason, 'Referral spam');
        assert.deepStrictEqual(ev[0].payload.details, { previous: 'active' });
        assert.strictEqual((await t.get(`/api/v1/offers/${o.id}/disable`, { as: t.mod, json: { reason: 'Again' } })).status, 200);
        assert.strictEqual(moderation().length, 1, 'already disabled: nothing changed, nothing reported');
    });

    await check('a moderator editing someone else\'s offer: one offer.edited naming the fields, never the text', async () => {
        const o = await t.submit(poster, { url: 'https://s.example/typo', title: 'Offer with a tpyo', price: '2', currency: 'USD' });
        const n = moderation().length;
        assert.strictEqual((await t.get(`/api/v1/offers/${o.id}`, { method: 'PATCH', as: t.mod, json: { title: 'Offer with a typo' } })).status, 200);
        const ev = moderation();
        assert.strictEqual(ev.length, n + 1);
        valid(ev[n]);
        assert.strictEqual(ev[n].payload.action, 'offer.edited');
        assert.deepStrictEqual(ev[n].payload.details, { changed: ['title'] });
        assert.ok(!JSON.stringify(ev[n]).includes('Offer with a typo'));
    });

    await check('a moderator dismissing a person\'s report: one flag.dismissed with the reporter as owner', async () => {
        const o = await t.submit(poster, { url: 'https://s.example/reported', title: 'Reported offer', price: '3', currency: 'USD' });
        assert.ok((await t.get(`/api/v1/offers/${o.id}/flags`, { as: reporter, json: { kind: 'expired', reason: 'Sold out' } })).status < 300);
        const f = t.ctx.store.db.prepare('SELECT * FROM deal_flags WHERE offer_id = ?').get(o.id);
        const n = moderation().length;
        const r = await t.get(`/api/v1/flags/${f.id}/resolve`, { as: t.mod, json: { status: 'dismissed', resolution: 'Still in stock' } });
        assert.strictEqual(r.status, 200, r.text);
        const ev = moderation();
        assert.strictEqual(ev.length, n + 1);
        valid(ev[n]);
        assert.strictEqual(ev[n].payload.action, 'flag.dismissed');
        assert.deepStrictEqual(ev[n].payload.target, { type: 'flag', id: f.id, owner_subject: reporter.subject });
        assert.strictEqual(ev[n].payload.reason, 'Still in stock');
        assert.strictEqual(ev[n].payload.details.offer_id, o.id);
    });

    await t.close();
    done();
})();
