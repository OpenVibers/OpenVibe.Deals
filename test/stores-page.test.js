'use strict';
/**
 * /stores (open item 140, DEALS-LP): how a shop lists its own deals here. It explains Sources' merchant opt-in
 * (claim, proof, feed), links to it, says what Deals never does, is reachable from the shops index, and is indexable.
 *   node test/stores-page.test.js
 */
const assert = require('assert');
const { boot, check, done, robotsOf } = require('./helpers/boot');

(async () => {
    const t = await boot();

    await check('/stores explains the opt-in and links to Sources\' merchant page', async () => {
        const r = await t.get('/stores');
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.text, /<h1>List your store&#39;s deals<\/h1>|<h1>List your store's deals<\/h1>/);
        assert.match(r.text, /href="https:\/\/sources\.openvibe\.network\/merchant"/);
        assert.match(r.text, /_openvibe-sources\.&lt;your domain&gt;/, 'the DNS proof is named');
        assert.match(r.text, /robots\.txt/);
        assert.match(r.text, /What we never do/);
        assert.ok(!/noindex/.test(robotsOf(r.text) || ''), 'search engines may read it');
    });

    await check('the shops index points shops to it', async () => {
        const r = await t.get('/at');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /href="\/stores"/);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
