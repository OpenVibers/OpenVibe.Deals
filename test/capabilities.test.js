'use strict';
/**
 * The deals.* capabilities are released by openvibe-contracts, so the service guards delegate to
 * the library's grant rule rather than deciding a proposed id locally (the fallback that existed
 * while the ids were only proposals). These pin that: every guarded id is defined by the installed
 * contracts and by the deals service manifest, and checkCapability agrees with capabilities.check
 * for an exact grant, a prefix grant, no grant, and an id the contracts do not define.
 */
const assert = require('assert');
const { capabilities, services } = require('openvibe-contracts');
const { checkCapability, CAPABILITIES } = require('../server/auth/capabilities');
const { check, done } = require('./helpers/boot');

const GRANTED = { cap: ['deals.offer.submit'], sub: 'svc:community' };

(async () => {
    await check('every guarded capability is defined by the installed contracts and the deals manifest', async () => {
        const manifest = services.get('deals');
        assert.ok(manifest, 'openvibe-contracts defines the deals service manifest');
        assert.deepStrictEqual([...manifest.capabilities].sort(), Object.values(CAPABILITIES).sort());
        for (const id of Object.values(CAPABILITIES)) {
            const cap = capabilities.get(id);
            assert.ok(cap, `${id} is defined by openvibe-contracts`);
            assert.strictEqual(cap.owner, 'deals', `${id} is owned by deals`);
        }
    });

    await check('checkCapability follows the contracts grant rule (exact, prefix, denied, unknown)', async () => {
        // An exact grant and a `prefix.*` grant the library's matching rule accepts.
        assert.deepStrictEqual(checkCapability(GRANTED, 'deals.offer.submit'), { allowed: true, code: null, reason: null });
        assert.deepStrictEqual(checkCapability({ cap: ['deals.*'] }, 'deals.offer.submit'), { allowed: true, code: null, reason: null });
        // A grant of a sibling capability, or no cap at all, is denied with the library's code.
        assert.strictEqual(checkCapability({ cap: ['deals.offer.update'] }, 'deals.offer.submit').code, 'capability.denied');
        assert.strictEqual(checkCapability(null, 'deals.offer.submit').code, 'capability.denied');
        // An id the contracts do not define still answers capability.unknown — the guard delegates,
        // it never decides an unknown id on its own.
        assert.strictEqual(checkCapability({ cap: ['deals.*'] }, 'deals.not.a.capability').code, 'capability.unknown');
    });

    done();
})();
