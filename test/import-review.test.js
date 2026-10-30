'use strict';
/**
 * The automatic review of imported offers (server/domain/import-review.js): an offer imported from a
 * configured feed source is checked when it is imported, and a hand-submitted offer keeps today's
 * review flow.
 */
const assert = require('assert');
const { boot, check, done, robotsOf } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');
const { evaluateImport } = require('../server/domain/import-review');

const RETAILER = 'https://www.zappos.com';

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const byUrl = async (u) => await t.ctx.store.db.prepare('SELECT * FROM deal_offers WHERE url = ?').get(u);
    let n = 0;
    const item = (over) => sourceItem({
        id: `itm_01K5AAAAAAAAAAAAAAAAAAAAA${String(++n).padStart(2, '0')}`,
        sourceKey: 'crawl-zappos-com', title: 'MSI Vigor GK30 gaming keyboard', url: `${RETAILER}/p/${n}`,
        retrievedAt: t.clock.now(), fields: { price: '35.00', currency: 'USD' }, ...over,
    });

    await check('an import from a configured source passes the checks: it is published, indexable and reviewed by the system', async () => {
        t.sources.put(item({}));
        await t.ctx.importer.pull();
        const offer = await byUrl(`${RETAILER}/p/1`);
        assert.strictEqual(offer.review_state, 'auto_approved');
        assert.strictEqual(offer.reviewed_by, 'system:import-checks');
        assert.ok(offer.reviewed_at >= t.clock.now(), 'the time of the review is recorded');
        assert.strictEqual(offer.review_failed_check, null);
        const json = await t.offerJson(offer.slug);
        assert.strictEqual(json.indexability.indexable, true);
        assert.notStrictEqual(robotsOf((await t.get(`/d/${offer.slug}`)).text), 'noindex, follow');
        const doc = (await t.events('deals.index_document.upserted')).filter((e) => e.payload.id === offer.id).pop().payload;
        assert.strictEqual(doc.indexability.decision, 'index');
    });

    await check('the url_scheme check fails: a link that is not https stays pending', async () => {
        t.sources.put(item({ url: 'http://www.zappos.com/p/http' }));
        await t.ctx.importer.pull();
        const offer = await byUrl('http://www.zappos.com/p/http');
        assert.strictEqual(offer.review_state, 'pending');
        assert.strictEqual(offer.review_failed_check, 'url_scheme');
        assert.strictEqual(offer.reviewed_by, null);
    });

    await check('the url_domain check fails: a link outside the retailer domain stays pending', async () => {
        t.sources.put(item({ url: 'https://other-shop.example/p/other' }));
        await t.ctx.importer.pull();
        const offer = await byUrl('https://other-shop.example/p/other');
        assert.strictEqual(offer.review_state, 'pending');
        assert.strictEqual(offer.review_failed_check, 'url_domain');
    });

    await check('the title check fails: an empty title or one over 300 characters is not published', async () => {
        const base = { url: 'https://www.zappos.com/p/title', price_num: 35, currency: 'USD' };
        assert.strictEqual(evaluateImport({ ...base, title: '   ' }, { retailerDomains: ['zappos.com'] }).failed, 'title');
        assert.strictEqual(evaluateImport({ ...base, title: 'x'.repeat(301) }, { retailerDomains: ['zappos.com'] }).failed, 'title');
        assert.strictEqual(evaluateImport({ ...base, title: 'x'.repeat(300) }, { retailerDomains: ['zappos.com'] }).failed, null);
    });

    await check('the price check fails: a price that is missing, not positive or without a currency stays pending', async () => {
        t.sources.put(item({ url: `${RETAILER}/p/noprice`, fields: { price: null, currency: null } }));
        await t.ctx.importer.pull();
        const offer = await byUrl(`${RETAILER}/p/noprice`);
        assert.strictEqual(offer.review_state, 'pending');
        assert.strictEqual(offer.review_failed_check, 'price');
        assert.strictEqual(evaluateImport({ url: 'https://www.zappos.com/p/x', title: 'A thing', price_num: 0, currency: 'USD' }, { retailerDomains: ['zappos.com'] }).failed, 'price');
        assert.strictEqual(evaluateImport({ url: 'https://www.zappos.com/p/x', title: 'A thing', price_num: 10, currency: null }, { retailerDomains: ['zappos.com'] }).failed, 'price');
    });

    await check('the expiry check fails: an offer that has expired is not published', async () => {
        const base = { url: 'https://www.zappos.com/p/exp', title: 'A thing', price_num: 10, currency: 'USD' };
        assert.strictEqual(evaluateImport({ ...base, status: 'expired' }, { retailerDomains: ['zappos.com'] }).failed, 'expiry');
        assert.strictEqual(evaluateImport({ ...base, expires_at: 1000 }, { retailerDomains: ['zappos.com'], now: 2000 }).failed, 'expiry');
        assert.strictEqual(evaluateImport({ ...base, expires_at: 3000 }, { retailerDomains: ['zappos.com'], now: 2000 }).failed, null);
    });

    await check('the blocked_terms check fails: a title that states a blocked term stays pending', async () => {
        t.sources.put(item({ url: `${RETAILER}/p/blocked`, title: 'Free porn video download' }));
        await t.ctx.importer.pull();
        const offer = await byUrl(`${RETAILER}/p/blocked`);
        assert.strictEqual(offer.review_state, 'pending');
        assert.strictEqual(offer.review_failed_check, 'blocked_terms');
    });

    await check('a source that is not configured is never auto-approved', async () => {
        t.sources.put(item({ url: `${RETAILER}/p/unconfigured`, sourceKey: 'shop-jsonld' }));
        await t.ctx.importer.pull();
        const offer = await byUrl(`${RETAILER}/p/unconfigured`);
        assert.strictEqual(offer.review_state, 'pending');
        assert.strictEqual(offer.review_failed_check, null);
    });

    await check('a hand-submitted offer keeps today\'s review flow: no automatic review', async () => {
        const offer = await t.submit(alice, { title: 'A keyboard I found', url: 'https://shop.example/p/mine', price: '20.00', currency: 'USD' });
        assert.strictEqual(offer.review_state, 'not_required');
        assert.strictEqual(offer.reviewed_by, null);
        const json = await t.offerJson(offer.slug);
        assert.strictEqual(json.indexability.indexable, true);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
