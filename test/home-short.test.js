'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the home's sections are two pick blocks, a row of
 * chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script for the
 * chips; every section stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    try {
        // A deal, so the home has something to show in its pick blocks.
        await t.submit(alice, { url: 'https://coffee.example/espresso', title: 'Espresso machine', price: '249.00', currency: 'EUR', category: 'Kitchen', seller: 'Coffee Shop' });
        await t.submit(alice, { url: 'https://kettles.example/acme-2000', title: 'Acme Kettle 2000', price: '39.99', currency: 'USD', category: 'Kitchen', seller: 'Coffee Shop' });
        // The form does not take a category or a seller, so the browse block's own rows are set here.
        await t.ctx.store.db.prepare("UPDATE deal_offers SET category = 'Kitchen', seller = 'Coffee Shop', staff_pick = true WHERE id = (SELECT id FROM deal_offers ORDER BY seq DESC LIMIT 1)").run();
        await t.ctx.store.db.prepare("UPDATE deal_offers SET category = 'Kitchen', seller = 'Coffee Shop' WHERE id = (SELECT id FROM deal_offers ORDER BY seq ASC LIMIT 1)").run();

        await check('the home shows every section: no chip row, every section in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            assert.ok(!page.includes('pick-deals') && !page.includes('pick-browse'), 'the pick blocks are gone');
            for (const title of ['Editors', 'Just in', 'Browse by category', 'Shop by store', 'Questions and answers']) {
                assert.ok(page.includes(title), `${title} is on the page`);
            }
        });

        await check('nothing hides a chip or a section on a phone', async () => {
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'deals.css'), 'utf8');
            assert.ok(!/\.hm-chips > li:nth-child\(n\+11\) \{ display: none/.test(css), 'no chip is hidden');
            const page = (await t.get('/')).text;
            assert.ok(!page.includes('@supports selector(:has(*)){@media (max-width:640px){.pick:has'), 'no pick rule is written for the home');
        });

        await check('the parts a reader rarely needs are folds that start open on every screen', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['hm-faq', 'hm-network', 'hm-shipped']) {
                assert.ok(page.includes(`<details class="hm-fold hm-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(!page.includes(`document.getElementById("${id}")`), `${id} is never closed by script`);
            }
            // The content of the folds stays in the page.
            assert.match(page, /Where do the deals come from\?/);
            assert.match(page, /Part of OpenVibe/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
