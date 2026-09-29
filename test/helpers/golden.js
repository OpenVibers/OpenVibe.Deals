'use strict';
/**
 * The ingest golden fixture (T9 J4): a deterministic OpenVibe.Sources deals feed and the canonical
 * projection of the domain rows it produces (deal_offers + deal_price_observations +
 * deal_offer_sources, and the product a product item resolves to). The same fixture and the same
 * projection run before and after the chassis conversion, so test/chassis.test.js can compare the
 * projection to test/fixtures/ingest-golden.json (captured from the pre-conversion code). Volatile
 * values (ids, slugs, timestamps) are excluded or mapped to stable source keys, so only domain
 * meaning is compared.
 */
const { sourceItem } = require('./mocks');

const HOUR = 3600 * 1000;

/** Add the fixture's items to the Sources mock (same order and fields as the capture run). → reports */
function feedDeals(t) {
    const T0 = t.clock.now();
    t.sources.put(sourceItem({
        id: 'itm_01K5GOLDEN00000000000A1', title: 'Espresso machine', url: 'https://coffee.example/espresso', retrievedAt: T0 - HOUR,
        fields: { price: '249.00', currency: 'EUR', availability: 'InStock', condition: 'RefurbishedCondition', valid_until: '2026-10-01', seller: 'Coffee Shop' },
    }));
    t.sources.put(sourceItem({
        id: 'itm_01K5GOLDEN00000000000A2', kind: 'product', title: 'Acme Kettle 2000', url: 'https://kettles.example/acme-2000', retrievedAt: T0,
        fields: { brand: 'Acme', gtin: '4006381333931', offers: [
            { price: '39.99', currency: 'USD', availability: 'InStock', url: 'https://kettles.example/acme-2000?utm_source=feed', seller: 'Kettles' },
            { price: null, currency: null, availability: 'OutOfStock', url: 'https://market.example/acme-2000', seller: 'Market' },
        ] },
    }));
    t.sources.put(sourceItem({
        id: 'itm_01K5GOLDEN00000000000A3', kind: 'article', title: 'Weekend sale on garden tools', url: 'https://news.example/garden', retrievedAt: T0,
    }));
    return { espresso: 'itm_01K5GOLDEN00000000000A1', product: 'itm_01K5GOLDEN00000000000A2', article: 'itm_01K5GOLDEN00000000000A3' };
}

/** A revision upstream (new price) and a removal, applied by a second pull. */
function reviseDeals(t) {
    const T1 = t.clock.now() + 2 * HOUR;
    t.clock.set(T1);
    t.sources.put(sourceItem({
        id: 'itm_01K5GOLDEN00000000000A1', title: 'Espresso machine', url: 'https://coffee.example/espresso', retrievedAt: T1, revision: 2,
        fields: { price: '229.00', currency: 'EUR', availability: 'LimitedAvailability', seller: 'Coffee Shop' },
    }));
    const garden = t.sources.items.find((i) => i.id === 'itm_01K5GOLDEN00000000000A3');
    t.sources.put({ ...garden, removed: { at: new Date(T1).toISOString(), reason: 'licence withdrawn' } });
}

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** The canonical projection of the domain rows. Deterministic in everything but ids/time. → { offers } */
async function project(t) {
    const db = t.ctx.store.db;
    const offers = await db.prepare('SELECT * FROM deal_offers ORDER BY url').all();
    const out = [];
    for (const o of offers) {
        const product = o.product_id ? await db.prepare('SELECT * FROM deal_products WHERE id = ?').get(o.product_id) : null;
        const obs = await db.prepare('SELECT * FROM deal_price_observations WHERE offer_id = ? ORDER BY observed_at, seq').all(o.id);
        const srcs = await db.prepare('SELECT * FROM deal_offer_sources WHERE offer_id = ? ORDER BY ref_id, ref_part, id').all(o.id);
        out.push({
            url: o.url, title: o.title, description: o.description, status: o.status, origin: o.origin,
            review_state: o.review_state, text_origin: o.text_origin, category: o.category,
            expires_at: o.expires_at, disabled_reason: o.disabled_reason || null,
            product: product ? { name: product.name, brand: product.brand, category: product.category } : null,
            observations: obs.map((x) => ({
                price: x.price, currency: x.currency, shipping: x.shipping, condition: x.condition,
                availability: x.availability, origin: x.origin, observed_at: x.observed_at, source_revision: x.source_revision,
            })),
            sources: srcs.map((s) => ({
                kind: s.kind, ref_id: s.ref_id, ref_part: s.ref_part, ref_revision: s.ref_revision,
                source_key: s.source_key, url: s.url, label: s.label, retrieved_at: s.retrieved_at,
                removed_at: s.removed_at, removed_reason: s.removed_reason,
            })),
        });
    }
    return { offers: out };
}

module.exports = { feedDeals, reviseDeals, project, parse };
