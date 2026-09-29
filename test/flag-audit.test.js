'use strict';
/**
 * A moderator's decision and its moderation_log audit row are one transaction. flags.resolve must
 * await logAction, not leave the write floating: the decision must not return before the audit row
 * is in, and an audit write that fails must fail the decision (rolling the resolve back), not be
 * swallowed as an unhandled rejection.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { createFlags } = require('../server/domain/flags');

/** The flags domain with just enough store to resolve one open flag; logAction is the observed part. */
function harness({ logAction }) {
    const flag = { id: 'dfl_1', offer_id: 'dor_1', kind: 'spam', origin: 'user', reporter: 'usr_r', reason: null, details: '{}' };
    let status = 'open';
    const store = {
        db: {
            prepare: () => ({
                get: async (id) => (String(id) === flag.id ? { ...flag, status } : undefined),
                run: async () => { status = 'resolved'; return { rowCount: 1 }; },
                all: async () => [],
            }),
        },
        tx: async (fn) => await fn(),
        now: () => 1700000000000,
    };
    return createFlags({ config: {}, store, reads: {}, limits: {}, access: { isModerator: () => true }, publication: {}, logAction });
}

const moderator = { subject: 'usr_mod', kind: 'user' };

(async () => {
    await check('resolving a flag awaits its moderation_log audit write inside the transaction', async () => {
        let wrote = null;
        const flags = harness({ logAction: async (action) => { await new Promise((r) => setImmediate(r)); wrote = action; } });
        const out = await flags.resolve(moderator, 'dfl_1', { status: 'resolved', resolution: 'checked' });
        assert.strictEqual(out.changed, true);
        assert.strictEqual(wrote, 'flag.resolve', 'logAction must finish before resolve() returns');
    });

    await check('an audit write that fails fails the moderator decision instead of being swallowed', async () => {
        const failure = new Error('moderation_log is unavailable');
        const flags = harness({ logAction: () => { const p = Promise.reject(failure); p.catch(() => {}); return p; } });
        await assert.rejects(() => flags.resolve(moderator, 'dfl_1', { status: 'dismissed', resolution: 'nope' }), /moderation_log is unavailable/);
    });

    done();
})();
