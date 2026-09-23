'use strict';
/**
 * Server-rendered pages useful without JavaScript; expiry and moderation reach pages, feeds,
 * sitemaps and Search; discovery artifacts; caching; operations endpoints. No seed deals.
 */
const assert = require('assert');
const { boot, check, done, robotsOf, jsonLd, HOUR } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const [alice, bob] = ['alice', 'bob'].map((n) => t.network.addUser(n));
    let deal, timed;

    await check('the site starts empty: no seed deals, an honest empty page that is noindex', async () => {
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM deal_offers').get().n, 0);
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /No deals have been posted yet/);
        assert.strictEqual(robotsOf(r.text), 'noindex, follow');
        assert.match(r.headers.get('cache-control'), /public, max-age=60/);
    });

    await check('/submit: sign-in first; then a plain form with a form token; a forged token is refused', async () => {
        const anon = await t.get('/submit');
        assert.match(anon.text, /Sign in with your OpenVibe account/);
        const page = await t.get('/submit', { as: alice });
        assert.match(page.text, /<form method="post" action="\/submit"/);
        assert.match(page.text, /name="csrf" value="[^"]+"/);
        assert.match(page.headers.get('cache-control'), /private, no-store/);
        const forged = await t.get('/submit', { as: alice, form: { url: 'https://x.example/', title: 'Nope', csrf: 'x' } });
        assert.strictEqual(forged.status, 403);
        const anonPost = await t.get('/submit', { form: { url: 'https://x.example/', title: 'Nope' } });
        assert.strictEqual(anonPost.status, 303);
        assert.match(anonPost.headers.get('location'), /^\/auth\/login/);
    });

    await check('a submitted deal page: price as of its time, history, sources, store, votes, JSON twin, JSON-LD, breadcrumbs', async () => {
        deal = await t.submit(alice, { url: 'https://gadgets.example/drone?ref=abc', title: 'Mini drone with camera', price: '79.00', currency: 'USD', shipping: '4.99', condition: 'new', availability: 'in_stock', description: 'Folding **mini** drone.', store_name: 'Gadgets Inc' });
        assert.strictEqual(deal.url, 'https://gadgets.example/drone', 'tracking parameter stripped');
        const r = await t.get(`/d/${deal.slug}`);
        assert.strictEqual(r.status, 200);
        for (const re of [/Mini drone with camera/, /79.00 USD/, /\+ 4.99 USD shipping/, /Price history/, /Submitted by a member/, /Gadgets Inc/, /<strong>mini<\/strong>/, /\.json"/, /Sign in<\/a> to vote/]) assert.match(r.text, re);
        assert.match(r.text, /rel="nofollow noopener ugc"/);
        const types = jsonLd(r.text).map((x) => x['@type']);
        assert.deepStrictEqual(types, ['Product', 'BreadcrumbList']);
        const ld = jsonLd(r.text)[0].offers[0];
        assert.deepStrictEqual([ld.price, ld.priceCurrency, ld.itemCondition, ld.seller.name], ['79.00', 'USD', 'https://schema.org/NewCondition', 'Gadgets Inc']);
        assert.strictEqual(ld.shippingDetails.shippingRate.value, '4.99');
        assert.match(r.text, /<link rel="canonical" href="https:\/\/openvibe.deals\/d\//);
        const json = await t.get(`/d/${deal.slug}.json`);
        assert.strictEqual(json.status, 200);
        assert.strictEqual(json.json().offer.store.name, 'Gadgets Inc');
    });

    await check('vote and comment with forms only; comments are Community\'s thread, referenced', async () => {
        const v = await t.get(`/d/${deal.slug}/vote`, { as: bob, form: { value: 'up' } });
        assert.strictEqual(v.status, 303);
        const c = await t.get(`/d/${deal.slug}/comments`, { as: bob, form: { message: 'Bought one, works.' } });
        assert.strictEqual(c.status, 303);
        const r = await t.get(`/d/${deal.slug}`, { as: bob });
        assert.match(r.text, /aria-pressed="true">▲ Hot/);
        assert.match(r.text, /Bought one, works./);
        assert.match(r.headers.get('cache-control'), /private, no-store/);
        const thread = [...t.community.threads.values()][0];
        assert.deepStrictEqual(thread.ref, { service: 'deals', type: 'offer', id: deal.id, label: 'Mini drone with camera' });
        const cols = t.ctx.store.db.prepare("SELECT name FROM pragma_table_info('deal_offer_discussion_refs')").all().map((x) => x.name).join(',');
        assert.doesNotMatch(cols, /message|body|text/);
        t.community.setDown(true);
        const down = await t.get(`/d/${deal.slug}`);
        assert.match(down.text, /Comments are unavailable right now/);
        t.community.setDown(false);
    });

    await check('product, store and search pages', async () => {
        const p = await t.submit(alice, { url: 'https://gadgets.example/drone-pro', title: 'Drone Pro', price: '199', currency: 'USD', product_name: 'SkyCam Drone Pro' });
        const prod = t.ctx.catalog.product(p.product_id);
        const pr = await t.get(`/p/${prod.slug}`);
        assert.strictEqual(pr.status, 200);
        assert.match(pr.text, /Price comparison/);
        assert.match(pr.text, /199 USD/);
        const st = await t.get('/s/gadgets.example');
        assert.strictEqual(st.status, 200);
        assert.match(st.text, /Mini drone with camera/);
        const s = await t.get('/search?q=drone+camera');
        assert.strictEqual(s.status, 200);
        assert.match(s.text, /Mini drone with camera/);
        assert.doesNotMatch(s.text, /Drone Pro<\/a>/);
        assert.strictEqual(robotsOf(s.text), 'noindex, nofollow');
        assert.strictEqual((await t.get('/p/nope')).status, 404);
    });

    await check('the submitter marks it expired: badge, noindex (expired), deals.offer.expired, out of lists and sitemaps', async () => {
        const other = await t.get(`/d/${deal.slug}/expire`, { as: bob, form: {} });
        assert.strictEqual(other.status, 403, 'only the submitter or a moderator');
        const r = await t.get(`/d/${deal.slug}/expire`, { as: alice, form: {} });
        assert.strictEqual(r.status, 303);
        const page = await t.get(`/d/${deal.slug}`);
        assert.match(page.text, /This deal expired/);
        assert.strictEqual(robotsOf(page.text), 'noindex, follow');
        const e = t.events('deals.offer.expired');
        assert.strictEqual(e.length, 1);
        assert.strictEqual(e[0].payload.reason, 'submitter');
        assert.ok(!(await t.get('/')).text.includes(deal.slug));
        assert.ok(!(await t.get('/sitemaps/offers.xml')).text.includes(deal.slug));
    });

    await check('a stated end time expires the deal on the worker tick; an unknown end never expires by itself', async () => {
        timed = await t.submit(alice, { url: 'https://gadgets.example/flash', title: 'Flash sale earbuds', price: '15', currency: 'USD', expires_at: '2026-09-22T14:00' });
        const open = await t.submit(alice, { url: 'https://gadgets.example/open', title: 'Open-ended cable deal', price: '3', currency: 'USD' });
        assert.match((await t.get(`/d/${open.slug}`)).text, /End date: not stated/);
        t.clock.advance(3 * HOUR);
        await t.ctx.worker.tick();
        assert.strictEqual(t.ctx.reads.get(timed.id).status, 'expired');
        assert.strictEqual(t.ctx.reads.get(timed.id).expired_reason, 'stated_expiry');
        assert.strictEqual(t.ctx.reads.get(open.id).status, 'active');
        t.clock.advance(30 * 24 * HOUR);
        await t.ctx.worker.tick();
        assert.strictEqual(t.ctx.reads.get(open.id).status, 'active', 'stale, but never assumed expired');
    });

    await check('moderators disable a deal: 410, out of feeds, sitemaps and Search; enable brings it back', async () => {
        const target = t.ctx.store.db.prepare("SELECT * FROM deal_offers WHERE title = 'Drone Pro'").get();
        await t.get(`/d/${target.slug}`);
        const thread = [...t.community.threads.values()].find((x) => x.ref.id === target.id);
        assert.ok(thread, 'the page resolved its Community thread');
        const r = await t.get(`/mod/offers/${target.slug}/disable`, { as: t.mod, form: { reason: 'misleading' } });
        assert.strictEqual(r.status, 303);
        await new Promise((ok) => setTimeout(ok, 100));
        assert.strictEqual(thread.visibility, 'hidden', 'the disabled deal\'s discussion is hidden too');
        assert.strictEqual((await t.get(`/d/${target.slug}`)).status, 410);
        assert.strictEqual((await t.get(`/d/${target.slug}.json`)).status, 410);
        assert.ok(!(await t.get('/feed.xml')).text.includes(target.slug));
        assert.ok(t.events('deals.index_document.deleted').some((e) => e.payload.id === target.id));
        const en = await t.get(`/mod/offers/${target.slug}/enable`, { as: t.mod, form: {} });
        assert.strictEqual(en.status, 303);
        assert.strictEqual((await t.get(`/d/${target.slug}`)).status, 200);
        await new Promise((ok) => setTimeout(ok, 100));
        assert.strictEqual(thread.visibility, 'public');
        const log = t.ctx.store.db.prepare('SELECT action FROM moderation_log WHERE offer_id = ? ORDER BY id').all(target.id).map((x) => x.action);
        assert.deepStrictEqual(log, ['disable', 'enable']);
    });

    await check('feeds (RSS, Atom, JSON Feed) carry "as of" times and stable ids', async () => {
        const fresh = await t.submit(bob, { url: 'https://books.example/novel', title: 'Hardcover novel', price: '12.50', currency: 'GBP' });
        const rss = await t.get('/feed.xml');
        assert.match(rss.headers.get('content-type'), /rss\+xml/);
        assert.match(rss.text, new RegExp(`<guid isPermaLink="false">deals:offer:${fresh.id}</guid>`));
        assert.match(rss.text, /12.50 GBP as of 2026-/);
        const atom = await t.get('/atom.xml');
        assert.match(atom.text, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
        const jf = (await t.get('/feed.json')).json();
        assert.ok(jf.items.some((i) => i.id === `deals:offer:${fresh.id}`));
    });

    await check('robots.txt, llms.txt and the sitemap index; sitemaps list only indexable deals', async () => {
        const robots = await t.get('/robots.txt');
        assert.match(robots.text, /Sitemap: https:\/\/openvibe.deals\/sitemap.xml/);
        assert.match(robots.text, /Disallow: \/api\//);
        assert.match(robots.text, /as of/);
        const llms = await t.get('/llms.txt');
        assert.match(llms.text, /OpenVibe.Deals/);
        assert.match(llms.text, /never 0/);
        const idx = await t.get('/sitemap.xml');
        assert.match(idx.text, /sitemaps\/offers.xml/);
        assert.match(idx.text, /sitemaps\/products.xml/);
        const offers = await t.get('/sitemaps/offers.xml');
        const fresh = t.ctx.store.db.prepare("SELECT slug FROM deal_offers WHERE title = 'Hardcover novel'").get().slug;
        assert.ok(offers.text.includes(fresh));
        assert.ok(!offers.text.includes(timed.slug), 'expired');
        assert.ok(!offers.text.includes(deal.slug), 'expired');
    });

    await check('operations: health, readiness, release.json, metrics (loopback), legal pages', async () => {
        assert.strictEqual((await t.get('/api/health')).json().service, 'openvibe-deals');
        const ready = await t.get('/api/ready');
        assert.strictEqual(ready.status, 200);
        const rj = ready.json();
        assert.strictEqual(rj.checks.db.status, 'ok');
        assert.ok(rj.checks.events_relay, 'relay state reported');
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'deals');
        const m = await t.get('/metrics');
        assert.strictEqual(m.status, 200);
        assert.match(m.text, /http_requests_total|openvibe_/);
        assert.strictEqual((await t.get('/terms')).status, 200);
        assert.strictEqual((await t.get('/nope/nope')).status, 404);
    });

    await t.close();
    done();
})();
