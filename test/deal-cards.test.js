'use strict';
/**
 * The deal card and the shop page (market outcomes 1-6): the price with the was-price struck through and the saving;
 * when the price was seen and how many prices sit behind it; the stated expiry with its precision or "Expiry
 * unknown"; the price over time as a sparkline once there are two; what the votes count and the band; and a shop's
 * own line: active deals, prices seen in 24 hours, and an alert prefilled for it.
 */
const assert = require('assert');
const { boot, check, done, HOUR } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const [alice, bob, cara] = ['alice', 'bob', 'cara'].map((n) => t.network.addUser(n));
    const db = t.ctx.store.db;
    let a, b;
    const card = (html, title) => {
        const i = html.indexOf(`>${title}</a>`);
        assert.ok(i > 0, `a card for ${title}`);
        return html.slice(html.lastIndexOf('<li class="deal-item">', i), html.indexOf('</li>', i));
    };

    await check('one price: the price, when it was seen, one price on record, expiry unknown, no sparkline', async () => {
        a = await t.submit(alice, { url: 'https://shop.example/headphones', title: 'Studio headphones', price: '49.99', currency: 'USD', availability: 'in_stock' });
        const c = card((await t.get('/s/shop.example')).text, 'Studio headphones');
        assert.match(c, /<strong class="price" data-price="49.99">49.99 USD<\/strong>/);
        assert.match(c, /Price seen <time datetime="[^"]+" title="[^"]+">just now<\/time> · 1 price on record/);
        assert.match(c, /data-freshness="fresh"/);
        assert.match(c, /<span class="dl-ends dl-ends--unknown">Expiry unknown<\/span>/, 'never an assumed expiry');
        assert.doesNotMatch(c, /dl-spark/, 'one price is not a line');
        assert.match(c, /Be the first to rate it/);
        assert.match(c, /dl-band--new">New today/);
    });

    await check('more prices, a stated list price, a stated end, votes: the whole card', async () => {
        for (const [h, price] of [[2, '45.00'], [4, '39.99']]) {
            t.clock.advance(h * HOUR);
            const r = await t.get(`/d/${a.slug}/observe`, { as: bob, form: { price, currency: 'USD', csrf: t.csrf(bob) } });
            assert.ok([200, 303].includes(r.status), `observe ${r.status}: ${r.text.slice(0, 200)}`);
        }
        await db.prepare("UPDATE deal_price_observations SET list_price = '59.99', list_price_num = 59.99 WHERE offer_id = ? AND price = '39.99'").run(a.id);
        await db.prepare('UPDATE deal_offers SET expires_at = ? WHERE id = ?').run(t.clock.now() + 30 * HOUR, a.id);
        for (const u of [bob, cara]) await t.get(`/d/${a.slug}/vote`, { as: u, form: { value: 'up', csrf: t.csrf(u) } });
        const c = card((await t.get('/s/shop.example')).text, 'Studio headphones');
        assert.match(c, /<s class="dl-list" data-list-price="59.99">59.99 USD<\/s> <span class="dl-saving">−33%<\/span>/, 'the was-price and the saving');
        assert.match(c, /· 3 prices on record/);
        assert.match(c, /<figure class="dl-spark" data-points="3"><svg [^>]*role="img" aria-label="Price over 3 observations: 49.99 to 39.99 USD, lowest 39.99">/);
        assert.match(c, /<figcaption>Lowest seen<\/figcaption>/, 'the latest is the lowest');
        assert.match(c, /<span class="dl-ends dl-ends--soon">Ends in 30 hours: <time datetime=/, 'a stated end, soon');
        assert.match(c, /2 found this useful/, 'the vote says what it counts');
        t.clock.advance(25 * HOUR);
        await db.prepare('UPDATE deal_offers SET expires_at = ? WHERE id = ?').run(Date.UTC(2027, 0, 15), a.id);
        const later = card((await t.get('/s/shop.example')).text, 'Studio headphones');
        assert.match(later, /Ends <time datetime="2027-01-15T00:00:00.000Z">2027-01-15<\/time> \(a date, no time stated\)/, 'a date is said as a date');
        assert.doesNotMatch(later, /New today/);
    });

    await check('the band of an editors\' pick', async () => {
        b = await t.submit(alice, { url: 'https://shop.example/lamp', title: 'Desk lamp', price: '20.00', currency: 'USD' });
        await db.prepare('UPDATE deal_offers SET staff_pick = true WHERE id = ?').run(b.id);
        assert.match(card((await t.get('/s/shop.example')).text, 'Desk lamp'), /dl-band--pick">Editors&#39; pick|dl-band--pick">Editors' pick/);
    });

    await check('the shop: its line, its active deals, prices seen in 24 hours, an alert prefilled for it', async () => {
        const r = await t.get('/s/shop.example');
        assert.match(r.text, /<header class="dl-shop">/);
        assert.match(r.text, /<a href="https:\/\/shop\.example" rel="nofollow noopener">shop\.example<\/a> · 2 active deals · prices seen \d+ times? in 24 hours/);
        assert.match(r.text, /<a class="dl-alert" href="\/watches\?kind=keyword&amp;query=shop\.example">Alert me about deals here<\/a>/);
        const w = await t.get('/watches?kind=keyword&query=shop.example', { as: alice });
        assert.match(w.text, /<h2>Alert me about “shop\.example”<\/h2>/);
        assert.match(w.text, /<option value="keyword" selected>/);
        assert.match(w.text, /<input id="w-q" name="query" maxlength="200" value="shop\.example">/);
        const odd = await t.get('/watches?kind=evil&query=%3Cb%3Ex%3C%2Fb%3E', { as: alice });
        assert.match(odd.text, /<option value="keyword" selected>/, 'an unknown kind is a keyword watch');
        assert.ok(!odd.text.includes('<b>x</b>'), 'the words are text');
    });

    await done(t);
})();
