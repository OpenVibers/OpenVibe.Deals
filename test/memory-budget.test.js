'use strict';
/**
 * What the sitemap cache holds, measured (server/http/discovery.js, server/domain/publication.js).
 *
 * The offer and product lists behind /sitemap.xml, /sitemap-<n>.xml and /llms-full.txt are reused for
 * DEALS_SITEMAP_TTL_MS. They used to be the full page views (every observation, source, vote tally and member of every
 * offer): about 6.7 KB an offer, so production's 50,000-offer catalog kept ~340 MB for ten minutes and a rebuild held a
 * second copy (667 MB resident, 2 GB peak on 2026-11-07). They are now compact index entries (~0.6 KB an offer).
 *
 * Budgets (a 2,500-offer, 1,200-product fixture): the heap after boot plus a built sitemap cache plus one Sources
 * import must grow no more than HEAP_GROWTH_MAX over the heap right after boot, and stay under HEAP_MAX overall.
 *   - the compact cache for this fixture is ~3 MB, and one import of 50 items adds bookkeeping, not a catalog;
 *   - 12 MB leaves room for V8's arenas and an unrelated allocation or two, while the old full-view cache measured
 *     12.8 MB at 2,000 offers (~16 MB at this size), so it fails this test;
 *   - HEAP_MAX catches a runaway leak of hundreds of megabytes on a fresh process.
 * Raising a budget is a decision to state in the commit.
 */
const assert = require('assert');
const v8 = require('v8');
const vm = require('vm');
const { boot, check, done } = require('./helpers/boot');
const { sourceItem } = require('./helpers/mocks');

const OFFERS = 2500;
const PRODUCTS = 1200;
const IMPORT_ITEMS = 50;
const HEAP_GROWTH_MAX = 12 * 1024 * 1024;
const HEAP_MAX = 200 * 1024 * 1024;

v8.setFlagsFromString('--expose-gc');
const gc = typeof global.gc === 'function' ? global.gc : vm.runInNewContext('gc');
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** The fixture: a catalog of the shape production has (offers with a store, a product for most, one fresh observation). */
async function seed(db, now) {
    await db.prepare(`INSERT INTO deal_stores (id, domain, name, created_at, updated_at)
                      SELECT 'dst_' || g, 'shop' || g || '.test', 'Shop ' || g, ?, ? FROM generate_series(1, 10) g`).run(now, now);
    await db.prepare(`INSERT INTO deal_products (id, slug, name, brand, category, description, created_by, created_at, updated_at)
                      SELECT 'dpr_' || g, 'product-' || g, 'Product ' || g, 'Brand', 'cat', 'A product description', NULL, ?, ?
                        FROM generate_series(1, ${PRODUCTS}) g`).run(now, now);
    await db.prepare(`INSERT INTO deal_offers (id, slug, title, description, url, url_norm, store_id, product_id, category, origin,
                                               text_origin, review_state, status, created_at, updated_at)
                      SELECT 'dof_' || g, 'deal-' || g, 'A deal title ' || g,
                             'A deal description that is long enough to summarise: item ' || g || ' at a shop.',
                             'https://shop' || (g % 10 + 1) || '.test/p/' || g, 'https://shop' || (g % 10 + 1) || '.test/p/' || g,
                             'dst_' || (g % 10 + 1), CASE WHEN g <= ${PRODUCTS} THEN 'dpr_' || g END, 'cat',
                             'community', 'human', 'not_required', 'active', ?::bigint - g * 1000, ?::bigint - g * 1000
                        FROM generate_series(1, ${OFFERS}) g`).run(now, now);
    await db.prepare(`INSERT INTO deal_offer_sources (id, offer_id, kind, ref_service, ref_type, ref_id, created_at, updated_at)
                      SELECT 'dos_' || g, 'dof_' || g, 'submission', 'deals', 'submission', 'sub-' || g, ?, ?
                        FROM generate_series(1, ${OFFERS}) g`).run(now, now);
    await db.prepare(`INSERT INTO deal_price_observations (id, offer_id, source_id, observed_at, recorded_at, price, price_num, currency, origin)
                      SELECT 'dpo_' || g, 'dof_' || g, 'dos_' || g, ?, ?, '19.99', 19.99, 'USD', 'community'
                        FROM generate_series(1, ${OFFERS}) g`).run(now - 3600_000, now - 3600_000);
}

(async () => {
    // DEALS_SITEMAP_TTL_MS is what keeps the build: without it every read rebuilds and nothing is retained (and the
    // leak this test guards against could not show). The worker is off in boot(); the import runs by hand.
    const t = await boot({ env: { DEALS_SITEMAP_TTL_MS: '600000' } });
    try {
        await check('a 2,500-offer catalog: the sitemap cache and one import stay well inside the heap budget', async () => {
            const now = t.clock.now();
            await seed(t.ctx.store.db, now);
            const atBoot = heap();
            assert.ok(atBoot < HEAP_MAX, `heap after boot is ${mb(atBoot)}, over ${mb(HEAP_MAX)}`);

            for (const path of ['/sitemap.xml', '/sitemap-0.xml', '/llms-full.txt']) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, path);
            }
            const built = heap();

            for (let i = 0; i < IMPORT_ITEMS; i++) {
                t.sources.put(sourceItem({
                    id: `itm_MEM${String(i).padStart(21, '0')}`,
                    title: `Imported deal ${i}`,
                    url: `https://imported.example/p/${i}`,
                    retrievedAt: now,
                    fields: { price: '9.99', currency: 'USD', availability: 'InStock' },
                }));
            }
            const pulled = await t.ctx.importer.pull();
            assert.strictEqual(pulled.items, IMPORT_ITEMS);
            const after = heap();

            const grew = after - atBoot;
            assert.ok(grew <= HEAP_GROWTH_MAX, `heap grew ${mb(grew)} from boot to after the sitemaps and the import (${mb(atBoot)} -> ${mb(built)} -> ${mb(after)}); budget ${mb(HEAP_GROWTH_MAX)}`);
            assert.ok(after < HEAP_MAX, `heap after the import is ${mb(after)}, over ${mb(HEAP_MAX)}`);
            console.log(`  heap after boot ${mb(atBoot)}, sitemap cache ${mb(built - atBoot)}, after ${IMPORT_ITEMS} imported items ${mb(after)}`);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
