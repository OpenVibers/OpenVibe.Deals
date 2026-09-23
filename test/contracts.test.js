'use strict';
/**
 * The proposals the lead releases in the next openvibe-contracts version are valid against the
 * released schemas, match what the code enforces and emits, and do not collide with released ids.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { check, done } = require('./helpers/boot');
const { PROPOSED } = require('../server/auth/capabilities');

const DIR = path.join(__dirname, '..', 'docs', 'capabilities-proposal');
const SRC = path.join(__dirname, '..', 'server');

function sources(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : []));
}

(async () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
    const caps = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'service-manifest-proposal.json'), 'utf8'));
    const code = sources(SRC).join('\n');

    await check('every capability proposal is a valid capabilities.capability@1 with 3+ segments, owned by deals', async () => {
        for (const c of caps) {
            const v = contracts.validate('capabilities.capability@1', c);
            assert.ok(v.valid, `${c.id}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(c.owner, 'deals');
            assert.ok(c.id.split('.').length >= 3);
            assert.strictEqual(`${c.id}.json`, files[caps.indexOf(c)]);
            assert.ok(!contracts.capabilities.get(c.id) || contracts.capabilities.get(c.id).owner === 'deals', `${c.id} collides with a released capability`);
        }
    });

    await check('the charter capabilities are all there', async () => {
        for (const id of ['deals.offer.submit', 'deals.offer.update', 'deals.offer.expire', 'deals.vote.set', 'deals.vote.remove', 'deals.watch.create', 'deals.watch.delete', 'deals.product.resolve']) assert.ok(PROPOSED.has(id), id);
    });

    await check('the proposals are exactly the capabilities the code enforces', async () => {
        assert.deepStrictEqual(caps.map((c) => c.id).sort(), [...PROPOSED].sort());
        assert.deepStrictEqual([...manifest.capabilities].sort(), [...PROPOSED].sort());
        const guarded = new Set([...code.matchAll(/guard\('([a-z.]+)'\)/g)].map((m) => m[1]));
        assert.deepStrictEqual([...guarded].sort(), [...PROPOSED].sort());
    });

    await check('the service manifest proposal is a valid registry.service-manifest@1', async () => {
        const v = contracts.validate('registry.service-manifest@1', manifest);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(manifest.id, 'deals');
        for (const c of caps) for (const e of c.events) assert.ok(manifest.eventsProduced.includes(e), `${c.id} names ${e}, missing from eventsProduced`);
    });

    await check('every event type the code emits is declared, and the charter events are all emitted', async () => {
        const emitted = new Set([...code.matchAll(/'(deals\.[a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]).filter((e) => /^deals\.(offer|vote|watch)\.(created|updated|expired|changed|matched)$/.test(e)));
        for (const e of emitted) assert.ok(manifest.eventsProduced.includes(e), e);
        for (const e of ['deals.offer.created', 'deals.offer.updated', 'deals.offer.expired', 'deals.vote.changed', 'deals.watch.matched']) assert.ok(emitted.has(e), `${e} is never emitted`);
    });

    done();
})();
