'use strict';
/**
 * Every deal carries the network's one Share button (openvibe-shared 4.114.0): one [data-ov-share-sheet] beside
 * "Go to the deal" and "Remind me", with the deal's canonical address, its title and its summary. The navbar loads
 * the sheet on the first press.
 */
const assert = require('assert');
const { boot } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('alice');
        const offer = await t.submit(alice, { url: 'https://shop.example/headphones', title: 'Studio headphones', price: '49.99', currency: 'USD' });
        const r = await t.get(`/d/${offer.slug}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.strictEqual((r.text.match(/data-ov-share-sheet/g) || []).length, 1, 'one Share button');
        assert.ok(r.text.includes(`data-url="https://openvibe.deals/d/${offer.slug}"`), 'the deal address');
        assert.ok(r.text.includes('data-title="Studio headphones"'), 'its title');
        console.log('deals share sheet ok');
    } finally {
        await t.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
