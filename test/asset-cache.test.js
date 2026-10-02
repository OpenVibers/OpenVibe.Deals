'use strict';
/**
 * Static-asset caching (openvibe-shared/cache-policy, used by the express.static setHeaders in
 * server/app.js): a URL whose `?v=` equals the render layout's assetVersion for that file is
 * content-addressed and immutable for a year; anything else — a wrong hash or no `?v=` at all —
 * is a short public window with a day of stale-while-revalidate.
 */
const assert = require('assert');
const { assetVersion } = require('../server/render/layout');
const { boot, check, done } = require('./helpers/boot');

const ASSET = 'css/deals.css';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=300, stale-while-revalidate=86400';

(async () => {
    const t = await boot();
    try {
        await check('the current ?v=<assetVersion> is served immutable for a year', async () => {
            const r = await t.get(`/${ASSET}?v=${assetVersion(ASSET)}`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), IMMUTABLE);
        });

        await check('a wrong-but-hex ?v= and no ?v= get the short public window', async () => {
            for (const suffix of ['?v=deadbeefdeadbeef', '']) {
                const r = await t.get(`/${ASSET}${suffix}`);
                assert.strictEqual(r.status, 200, suffix || 'no ?v=');
                assert.strictEqual(r.headers.get('cache-control'), SHORT, suffix || 'no ?v=');
            }
        });
    } finally {
        await t.close();
    }
    done();
})();
