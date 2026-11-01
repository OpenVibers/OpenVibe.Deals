'use strict';
/**
 * "Remind me" on a deal's end (plan L48 R3): the link to openvibe.today/remind on the deal's own page and on the cards
 * that show the end, with the right title, time and page — and no link at all once the end has passed.
 */
const assert = require('assert');

const { boot, check, done } = require('./helpers/boot');

/** Every "Remind me" link on a page, as the URL it points at. */
function remindLinks(html) {
    return [...String(html).matchAll(/href="(https:\/\/openvibe\.today\/remind\?[^"]+)"/g)]
        .map((m) => m[1].replace(/&amp;/g, '&'));
}
const query = (href) => Object.fromEntries(new URL(href.replace(/&amp;/g, '&')).searchParams);

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');

    await check('a deal that ends later links to Today\'s "Remind me" on its page and on the cards', async () => {
        const offer = await t.submit(alice, {
            url: 'https://shop.example/steam-deck', title: 'Steam Deck OLED 512GB', price: '549.00', currency: 'USD',
            seller: 'Corner Shop', expires_at: '2026-09-25T18:00',
        });
        const slug = offer.slug;

        const page = await t.get(`/d/${slug}`);
        const links = remindLinks(page.text);
        assert.ok(links.length, 'the deal\'s own page has a "Remind me" link');
        const q = query(links[0]);
        assert.strictEqual(q.at, '2026-09-25T18:00:00.000Z', 'the end itself, in UTC');
        assert.strictEqual(q.url, `https://openvibe.deals/d/${slug}`, 'the deal\'s canonical page');
        assert.strictEqual(q.from, 'openvibe.deals');
        assert.ok(q.title.includes('Steam Deck OLED 512GB'), q.title);
        assert.ok(q.title.endsWith(' ends'), q.title);

        const listing = await t.get('/hot');
        const cardLink = remindLinks(listing.text).find((h) => query(h).url === `https://openvibe.deals/d/${slug}`);
        assert.ok(cardLink, 'the listing card has the link too');

        const home = await t.get('/');
        const homeLink = remindLinks(home.text).find((h) => query(h).url === `https://openvibe.deals/d/${slug}`);
        assert.ok(homeLink, 'the front page\'s card has the link too');
        assert.strictEqual(query(homeLink).at, '2026-09-25T18:00:00.000Z');
    });

    await check('a deal with no stated end has no "Remind me" link', async () => {
        const offer = await t.submit(alice, { url: 'https://shop.example/kettle', title: 'Kettle', price: '20.00', currency: 'EUR' });
        const page = await t.get(`/d/${offer.slug}`);
        assert.strictEqual(remindLinks(page.text).length, 0, 'no link without an end');
    });

    await check('a deal that has ended has no "Remind me" link', async () => {
        const offer = await t.submit(alice, {
            url: 'https://shop.example/lamp', title: 'Reading lamp', price: '30.00', currency: 'EUR',
            expires_at: '2026-09-25T18:00',
        });
        // The end moves into the past: nobody may be reminded for a deal that is over.
        await t.ctx.store.db.prepare('UPDATE deal_offers SET expires_at = ? WHERE id = ?').run(t.clock.now() - 60_000, offer.id);
        const page = await t.get(`/d/${offer.slug}`);
        assert.strictEqual(remindLinks(page.text).length, 0, 'no link once the end has passed');
    });

    await t.close();
    done();
})();
