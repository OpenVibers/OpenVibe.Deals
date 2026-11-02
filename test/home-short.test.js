'use strict';
/**
 * The home on a phone (the owner's rule, 2026-10-31: never hide content to shorten): the home's sections are two pick
 * blocks, every section is shown, stacked, with its own heading, and the chips are a row of links that jump to a
 * section. The parts a reader rarely needs are folds.
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

        await check('the home is two pick blocks: a link per section, every section in the page and showing', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            for (const key of ['deals', 'browse']) {
                const start = page.indexOf(`<div class="pick" id="pick-${key}">`);
                const next = page.indexOf('<div class="pick" id="pick-', start + 10);
                const block = page.slice(start, next > 0 ? next : start + 20000);
                assert.ok(block.startsWith(`<div class="pick" id="pick-${key}">`), `the ${key} block is on the home`);
                assert.ok(!/<input type="radio"/.test(block), `no radio in the ${key} block`);
                assert.match(block, /<nav class="pick-row" aria-label="[^"]+">/, `the ${key} chips are a nav of links`);
                const chips = [...block.matchAll(/<a class="pick-chip" href="#([a-z-]+)">[^<]+<\/a>/g)];
                assert.ok(chips.length >= 1, `a link per section (${chips.length})`);
                // Every section is in the page, and every link points at one of them.
                const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z-]+)">/g)].map((m) => m[1]);
                assert.deepStrictEqual(panes, chips.map((m) => m[1]), 'every section is in the page, one per link');
            }
            // Nothing was removed: every section of the home is still in the page.
            for (const title of ['Editors', 'Just in', 'Browse by category', 'Shop by store', 'Questions and answers']) {
                assert.ok(page.includes(title), `${title} is on the page`);
            }
        });

        await check('the CSS shows every pane on a phone; the chips are links, not a picker', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.ok(!page.includes('.pick:has('), 'no inline rule picks a section');
            assert.ok(!page.includes('pk-deals'), 'no radio ids on the page');
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'deals.css'), 'utf8');
            assert.match(css, /\.pick-head, \.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@media \(max-width: 640px\) \{/, 'the phone rules are under 640 px');
            assert.match(css, /\.pick-row \{ display: flex/, 'the chips are a row on a phone');
            assert.match(css, /\.pick-chip \{[^}]*min-height: 44px/, 'a chip is a 44 px link target');
            assert.ok(!/\.pick[^{}]*\.pick-pane[^{}]*\{[^}]*display:\s*none/.test(css), 'no rule hides a pane');
            assert.ok(!/:target/.test(css), 'no :target pane rule');
            assert.ok(!/\.pick[^{}]*\.pick-pane[^{}]*h2[^{}]*\{[^}]*display:\s*none/.test(css), 'a pane keeps its heading on a phone');
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
