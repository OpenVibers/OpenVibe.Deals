'use strict';
/**
 * Crowdfunding discovery (server/domain/campaigns.js, server/http/crowdfunding.js):
 *   - one search opens every platform's own search with the words (and their browse pages without words);
 *   - the campaigns come from Sources' crowdfunding category through their own cursor (the deals importer never sees
 *     them), amounts as stated with the fetch time; a removed item disappears;
 *   - sorting, matching words, the JSON twin; the page without words is indexable, a search is not.
 */
const assert = require('assert');
const { boot, check, done, robotsOf } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');
const { platformLinks } = require('../server/domain/campaigns');

const campaign = (id, { slug, name, raised, backers, created, tag = null, type = 'COLLECTIVE', summary = null, removed = null }, at) => ({
    ...sourceItem({ id, kind: 'campaign', title: name, url: null, sourceKey: 'opencollective-accounts', retrievedAt: at, removed, summary,
        fields: { slug, account_type: type, currency: 'USD', raised_cents: raised, raised_currency: 'USD', yearly_budget_cents: raised ? Math.round(raised / 4) : 0, backers, image_url: null, website: null, tag } }),
    category: 'crowdfunding', identity: slug, canonical_url: null, published_at: created,
});

(async () => {
    await check('every platform\'s own search for the words; browse pages without words', () => {
        const groups = platformLinks('solar charger');
        const all = Object.fromEntries(groups.flatMap((g) => g.platforms.map((p) => [p.id, p.url])));
        assert.strictEqual(all.kickstarter, 'https://www.kickstarter.com/discover/advanced?term=solar%20charger&sort=magic');
        assert.strictEqual(all.indiegogo, 'https://www.indiegogo.com/en/projects/search?q=solar%20charger');
        assert.strictEqual(all.gofundme, 'https://www.gofundme.com/s?q=solar%20charger');
        assert.strictEqual(all.opencollective, 'https://opencollective.com/search?q=solar%20charger');
        assert.deepStrictEqual(groups.map((g) => g.id), ['projects', 'causes', 'communities', 'creators', 'invest']);
        assert.ok(groups.find((g) => g.id === 'invest').note.includes('you can lose all of it'));
        assert.strictEqual(Object.fromEntries(platformLinks(null).flatMap((g) => g.platforms.map((p) => [p.id, p.url]))).kickstarter, 'https://www.kickstarter.com/discover');
    });

    const t = await boot();
    const at = t.clock.now();
    t.sources.put(campaign('itm_01', { slug: 'logseq', name: 'Logseq', raised: 95659957, backers: 12182, created: '2020-09-22T10:40:25.537Z', tag: 'knowledge-base', summary: 'A privacy-first platform for knowledge.' }, at));
    t.sources.put(campaign('itm_02', { slug: 'tiny-solar', name: 'Tiny Solar Charger', raised: 120000, backers: 14, created: '2026-10-14T08:00:00Z', type: 'PROJECT', summary: 'An open solar charger.' }, at));
    t.sources.put(campaign('itm_03', { slug: 'mid', name: 'Mid Collective', raised: 5000000, backers: 300, created: '2024-01-01T00:00:00Z' }, at));

    await check('the crowdfunding feed lands in its own table through its own cursor; deals never see it', async () => {
        const r = await t.ctx.campaigns.pull();
        assert.strictEqual(r.applied, 3, JSON.stringify(r));
        assert.ok(t.sources.calls.some((u) => u.includes('category=crowdfunding')));
        const offers = await t.ctx.store.db.value('SELECT count(*) FROM deal_offers');
        assert.strictEqual(Number(offers), 0, 'no offers made from campaigns');
        const { campaigns } = await t.ctx.campaigns.list();
        assert.deepStrictEqual(campaigns.map((c) => c.name), ['Logseq', 'Mid Collective', 'Tiny Solar Charger'], 'most contributors first');
        assert.strictEqual(campaigns[0].url, 'https://opencollective.com/logseq');
        assert.deepStrictEqual([campaigns[0].raised_cents, campaigns[0].backers, campaigns[0].currency, campaigns[0].observed_at], [95659957, 12182, 'USD', at]);
        assert.deepStrictEqual((await t.ctx.campaigns.list({ sort: 'new' })).campaigns.map((c) => c.name)[0], 'Tiny Solar Charger');
        assert.deepStrictEqual((await t.ctx.campaigns.list({ sort: 'raised' })).campaigns.map((c) => c.name)[0], 'Logseq');
        assert.deepStrictEqual((await t.ctx.campaigns.list({ q: 'solar' })).campaigns.map((c) => c.name), ['Tiny Solar Charger']);
        assert.deepStrictEqual((await t.ctx.campaigns.list({ q: '100%_' })).campaigns, [], 'LIKE wildcards are matched literally');
    });

    await check('the page: every platform at once, the campaigns with their amounts as of the fetch, sorting', async () => {
        const r = await t.get('/crowdfunding');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Crowdfunding, every platform at once'));
        assert.ok(r.text.includes('href="https://www.kickstarter.com/discover" rel="nofollow noopener" target="_blank"'));
        assert.ok(r.text.includes('$956,600 received to date · 12,182 contributors · $239,150 a year'), r.text.slice(r.text.indexOf('cf-campaign'), r.text.indexOf('cf-campaign') + 600));
        assert.ok(r.text.includes('href="https://opencollective.com/logseq" rel="nofollow noopener"'));
        assert.ok(r.text.includes('Open Collective · Collective · #knowledge-base'));
        assert.match(robotsOf(r.text), /^index/);
        const s = await t.get('/crowdfunding?q=solar+charger&sort=new');
        assert.ok(s.text.includes('href="https://www.kickstarter.com/discover/advanced?term=solar%20charger&amp;sort=magic"'));
        assert.ok(s.text.includes('Tiny Solar Charger') && !s.text.includes('>Logseq<'));
        assert.match(robotsOf(s.text), /noindex/);
        assert.ok(s.text.includes('href="/crowdfunding?q=solar+charger#campaigns">Most contributors</a>'));
    });

    await check('the JSON twin, and a removed item leaves', async () => {
        const j = (await t.get('/crowdfunding.json?q=logseq')).json();
        assert.deepStrictEqual([j.total, j.campaigns[0].name, j.campaigns[0].contributors, j.campaigns[0].observed_at], [1, 'Logseq', 12182, new Date(at).toISOString()]);
        assert.ok(j.platforms.some((p) => p.id === 'patreon' && p.url === 'https://www.patreon.com/explore/search?query=logseq'));
        t.sources.put(campaign('itm_01', { slug: 'logseq', name: 'Logseq', removed: { at: new Date(at).toISOString(), reason: 'takedown' } }, at));
        await t.ctx.campaigns.pull();
        assert.strictEqual((await t.ctx.campaigns.list()).total, 2);
    });

    await t.close();
    done();
})();
