'use strict';
/**
 * The page shell (server/render/layout.js): the document is openvibe-publishing/layout's
 * (openvibe-shared/shell page()): one title, the canonical and robots from the gate's decision, the
 * JSON-LD, feeds, the site stylesheet, the boost marker, the Frame and the footer's init.
 */
const assert = require('assert');
const { boot, check, done, robotsOf } = require('./helpers/boot');
const { renderPage } = require('../server/render/layout');

const count = (html, re) => (html.match(re) || []).length;
const split = (html) => ({ head: html.slice(0, html.indexOf('</head>')), body: html.slice(html.indexOf('</head>')) });

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');

    await check('a page needs the gate decision: there is no default that makes it indexable', async () => {
        assert.throws(() => renderPage({ title: 'x', body: '', config: { baseUrl: 'https://openvibe.deals' } }), TypeError);
    });

    await check('a deal page: one title, canonical, robots from the decision, JSON-LD, stylesheet, boost marker, Frame and footer', async () => {
        const deal = await t.submit(alice, { url: 'https://gadgets.example/drone', title: 'Mini drone with camera', price: '79.00', currency: 'USD', availability: 'in_stock' });
        const r = await t.get(`/d/${deal.slug}`);
        assert.strictEqual(r.status, 200);
        const { head, body } = split(r.text);
        assert.strictEqual(count(r.text, /<title>/g), 1, 'exactly one <title>');
        assert.ok(head.includes('<title>Mini drone with camera · OpenVibe.Deals</title>'), 'the composed title');
        assert.ok(head.includes(`<link rel="canonical" href="https://openvibe.deals/d/${deal.slug}">`), 'the canonical');
        assert.strictEqual(count(head, /<meta name="robots"/g), 1, 'one robots meta');
        assert.strictEqual(robotsOf(r.text), 'index, follow', 'robots from the decision');
        assert.ok(count(head, /<script type="application\/ld\+json">/g) >= 1, 'JSON-LD');
        assert.ok(/<link rel="stylesheet" href="\/css\/deals\.css\?v=[0-9a-f]+">/.test(head), 'the deals stylesheet');
        assert.ok(/<meta name="ov-boost" content="deals@[^"]+">/.test(head), 'the boost marker');
        assert.ok(head.includes('data-main="#main"'), 'the boost script');
        assert.ok(head.includes('<meta charset="utf-8">') && head.includes('<meta name="viewport"'), 'charset and viewport');
        assert.ok(head.includes('property="og:title"') && head.includes('name="twitter:card"'), 'Open Graph and Twitter tags');
        assert.ok(body.includes('<div id="navbar-mount"></div>'), 'the navbar mount');
        assert.ok(body.includes('<nav aria-label="Site"'), 'the noscript navigation');
        assert.ok(body.includes('href="/watches"'), 'the site links in the noscript navigation');
        assert.ok(body.includes('<main id="main" class="page">'), 'the swappable <main>');
        assert.ok(body.includes('id="ov-footer"'), 'the server-rendered footer');
        assert.ok(body.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), 'the footer is initialised');
        assert.ok(body.includes('"loginUrl":"/auth/login?next={path}"'), 'the navbar sign-in returns to the current page');
    });

    await check('the home page carries the feed links, one title and robots from the decision', async () => {
        const r = await t.get('/');
        const { head } = split(r.text);
        assert.strictEqual(count(head, /<title>/g), 1);
        assert.ok(head.includes('<link rel="canonical" href="https://openvibe.deals/">'));
        assert.strictEqual(robotsOf(r.text), 'index, follow');
        assert.ok(head.includes('<link rel="alternate" type="application/rss+xml" href="/feed.xml"'), 'RSS feed link');
        assert.ok(head.includes('<link rel="alternate" type="application/atom+xml" href="/atom.xml"'), 'Atom feed link');
        assert.ok(head.includes('<link rel="alternate" type="application/feed+json" href="/feed.json"'), 'JSON feed link');
        assert.ok(count(head, /<script type="application\/ld\+json">/g) >= 1, 'JSON-LD');
    });

    await t.close();
    done();
})();
