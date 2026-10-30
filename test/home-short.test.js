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

        await check('the home is two pick blocks: a chip per section, the first picked, every section in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            for (const key of ['deals', 'browse']) {
                const start = page.indexOf(`<div class="pick" id="pick-${key}">`);
                const next = page.indexOf('<div class="pick" id="pick-', start + 10);
                const block = page.slice(start, next > 0 ? next : start + 20000);
                assert.ok(block.startsWith(`<div class="pick" id="pick-${key}">`), `the ${key} block is on the home`);
                const chips = [...block.matchAll(/<input type="radio" name="pick-[a-z]+" id="pk-[a-z]+-([a-z-]+)" value="\1"( checked)?><label for="pk-[a-z]+-\1">([^<]+)<\/label>/g)];
                assert.ok(chips.length >= 1, `a chip per section (${chips.length})`);
                assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), [chips[0][1]], 'the first section is picked');
                // Every section stays in the page, with the id its chip picks.
                const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z-]+)">/g)].map((m) => m[1]);
                assert.deepStrictEqual(panes, chips.map((m) => m[1]), 'every section is in the page, one per chip');
            }
            // Nothing was removed: every section of the home is still in the page.
            for (const title of ['Editors', 'Just in', 'Browse by category', 'Shop by store', 'Questions and answers']) {
                assert.ok(page.includes(title), `${title} is on the page`);
            }
        });

        await check('the CSS guard: the chips are hidden and the sections all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick:has\(#pk-deals-d-picks:checked\) #d-picks\{display:block\}/, 'the rule that shows the picked section');
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'deals.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick \.pick-pane \{ display: none; \}/, 'the sections are hidden on a phone');
        });

        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['hm-faq', 'hm-network', 'hm-shipped']) {
                assert.ok(page.includes(`<details class="hm-fold hm-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(page.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
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
