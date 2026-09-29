'use strict';
/**
 * IndexNow (openvibe-shared/indexnow, mounted in server/app.js, pinged from server/domain/indexing.js):
 * INDEXNOW_KEY unset → the feature is off (no key route, nothing sent). With a key the key file is
 * served at /<key>.txt as text/plain and publishing an indexable deal pings the engines with the
 * deal's path and the sitemap. Drafts and noindex pages never ping.
 */
const assert = require('assert');
const { createIndexNow } = require('openvibe-shared/indexnow');
const { boot, check, done } = require('./helpers/boot');

const KEY = 'k'.repeat(32); // 8–128 hex/alphanumeric, what IndexNow's own tools generate

/** A real key file, but pingSoon records its calls instead of debouncing and POSTing. */
function spy() {
    const calls = [];
    const real = createIndexNow({ host: 'https://openvibe.deals', key: KEY, fetch: async () => ({ status: 200 }), log() {} });
    return { ...real, calls, pingSoon: (urls) => { calls.push(urls); return real.pingSoon(urls); } };
}

(async () => {
    await check('without a key: no key route, nothing sent, a submission still works', async () => {
        const t = await boot();
        try {
            assert.strictEqual(t.ctx.indexnow.enabled, false, 'IndexNow is off without INDEXNOW_KEY');
            const probe = await t.get(`/${KEY}.txt`);
            assert.strictEqual(probe.status, 404, 'no key file is mounted without a key');
            assert.strictEqual(t.ctx.indexnow.pingSoon(['https://openvibe.deals/d/x']), 0, 'nothing is queued');
            const alice = t.network.addUser('alice');
            const offer = await t.submit(alice, { url: 'https://off.example/p/1', title: 'A deal that publishes', price: '9.99', currency: 'usd' });
            assert.ok(offer && offer.id, 'a submission still publishes');
        } finally { await t.close(); }
    });

    await check('with a key: the key file answers text/plain with the key', async () => {
        const t = await boot({ env: { INDEXNOW_KEY: KEY }, indexnow: spy() });
        try {
            assert.strictEqual(t.ctx.indexnow.enabled, true);
            const r = await t.get(`/${KEY}.txt`);
            assert.strictEqual(r.status, 200, r.text);
            assert.match(r.headers.get('content-type'), /text\/plain/);
            assert.strictEqual(r.text, KEY);
            assert.strictEqual((await t.get('/not-the-key.txt')).status, 404);
        } finally { await t.close(); }
    });

    await check('a publish pings the page path and the sitemap; a draft does not', async () => {
        const inw = spy();
        const t = await boot({ env: { INDEXNOW_KEY: KEY }, indexnow: inw });
        try {
            const alice = t.network.addUser('alice');
            const offer = await t.submit(alice, { url: 'https://off.example/p/2', title: 'A published deal', price: '9.99', currency: 'usd' });
            const flat = inw.calls.flat();
            assert.ok(flat.includes(`https://openvibe.deals/d/${offer.slug}`), `pinged the deal path: ${JSON.stringify(inw.calls)}`);
            assert.ok(flat.includes('https://openvibe.deals/sitemap.xml'), 'pinged the sitemap');

            // A draft: AI-assisted text is held for review (noindex), so it never pings.
            inw.calls.length = 0;
            const r = await t.get('/api/v1/offers', {
                as: t.network.serviceToken('ai', ['deals.offer.submit']),
                headers: { 'X-OV-Subject': alice.subject, 'X-OV-Origin': 'ai' },
                json: { url: 'https://off.example/p/3', title: 'An AI draft deal', price: '4.99', currency: 'usd' },
            });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().offer.review_state, 'pending');
            assert.deepStrictEqual(inw.calls, [], 'a noindex draft is never pinged');

            // A takedown removes the page: the path is pinged again (it left the index).
            inw.calls.length = 0;
            const off = await t.get(`/mod/offers/${offer.slug}/disable`, { as: t.mod, form: { reason: 'spam listing' } });
            assert.strictEqual(off.status, 303, off.text.slice(0, 300));
            assert.ok(inw.calls.flat().includes(`https://openvibe.deals/d/${offer.slug}`), 'a page that leaves the index pings');
        } finally { await t.close(); }
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
