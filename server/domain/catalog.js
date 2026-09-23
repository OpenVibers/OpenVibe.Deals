'use strict';

/**
 * Store and product records.
 *
 *   Stores are keyed by domain (from the offer link). A store has a name only when a person or a
 *   source stated one; otherwise it is shown as its domain.
 *   Products resolve through aliases (gtin, mpn, sku, exact name, url): resolve() returns the one
 *   product an alias names, or creates a product when allowed. Two products that turn out to be the
 *   same are left to moderators (Deals does not auto-merge products).
 */
const { ApiError, newId, slugify, text, longText } = require('./util');

const ALIAS_KINDS = ['gtin', 'mpn', 'sku', 'url', 'name'];
const normAlias = (kind, v) => {
    const s = String(v || '').trim();
    if (!s) return null;
    if (kind === 'gtin') { const d = s.replace(/[\s-]/g, ''); return /^\d{8,14}$/.test(d) ? d.padStart(14, '0') : null; }
    if (kind === 'name') return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').slice(0, 300);
    return s.toLowerCase().replace(/\s+/g, '').slice(0, 300);
};

function createCatalog({ store }) {
    const { db } = store;
    const q = {
        storeByDomain: db.prepare('SELECT * FROM deal_stores WHERE domain = ?'),
        storeById: db.prepare('SELECT * FROM deal_stores WHERE id = ?'),
        insertStore: db.prepare('INSERT INTO deal_stores (id, domain, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
        nameStore: db.prepare('UPDATE deal_stores SET name = ?, updated_at = ? WHERE id = ? AND name IS NULL'),
        productById: db.prepare('SELECT * FROM deal_products WHERE id = ?'),
        productBySlug: db.prepare('SELECT * FROM deal_products WHERE slug = ?'),
        insertProduct: db.prepare(`INSERT INTO deal_products (id, slug, name, brand, category, description, created_by, created_at, updated_at)
                                   VALUES (@id, @slug, @name, @brand, @category, @description, @created_by, @now, @now)`),
        alias: db.prepare('SELECT * FROM deal_product_aliases WHERE kind = ? AND value_norm = ?'),
        insertAlias: db.prepare(`INSERT OR IGNORE INTO deal_product_aliases (id, product_id, kind, value, value_norm, source, created_by, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        aliases: db.prepare('SELECT kind, value, source, created_at FROM deal_product_aliases WHERE product_id = ? ORDER BY kind, value'),
    };

    function ensureStore(domain, name = null) {
        if (!domain) return null;
        const existing = q.storeByDomain.get(domain);
        if (existing) {
            if (name && !existing.name) q.nameStore.run(String(name).slice(0, 120), store.now(), existing.id);
            return q.storeByDomain.get(domain);
        }
        const id = newId('dst');
        q.insertStore.run(id, domain, name ? String(name).slice(0, 120) : null, store.now(), store.now());
        return q.storeById.get(id);
    }

    function storeLabel(s) { return s ? (s.name || s.domain) : null; }

    /**
     * Find the product any given alias names; create one (with every alias given) when none does and
     * `create` is true. Aliases that already point at a different product are left alone (conflict
     * reported in `conflicts`), never re-pointed silently.
     * input: { name, brand, category, description, gtin, mpn, sku, url }, source, actor
     */
    function resolve(input, { source = 'community', actor = null, create = true } = {}) {
        const given = ALIAS_KINDS.map((kind) => ({ kind, value: input[kind], norm: normAlias(kind, input[kind]) })).filter((a) => a.norm);
        if (input.gtin && !normAlias('gtin', input.gtin)) throw new ApiError(422, 'request.invalid', 'gtin must be 8 to 14 digits');
        let product = null;
        for (const a of given) {
            const hit = q.alias.get(a.kind, a.norm);
            if (hit) { product = q.productById.get(hit.product_id); break; }
        }
        let created = false;
        if (!product) {
            if (!create) return { product: null, created: false, conflicts: [] };
            const name = text(input.name, { field: 'product name', min: 2, max: 200, required: true });
            const id = newId('dpr');
            q.insertProduct.run({
                id, slug: slugify(name, id), name, brand: text(input.brand, { max: 120 }), category: text(input.category, { max: 60 }),
                description: longText(input.description, 2000), created_by: actor, now: store.now(),
            });
            product = q.productById.get(id);
            created = true;
        }
        const conflicts = [];
        for (const a of given) {
            const hit = q.alias.get(a.kind, a.norm);
            if (hit && hit.product_id !== product.id) { conflicts.push({ kind: a.kind, value: a.value, product_id: hit.product_id }); continue; }
            if (!hit) q.insertAlias.run(newId('dpa'), product.id, a.kind, String(a.value).trim().slice(0, 300), a.norm, source, actor, store.now());
        }
        return { product, created, conflicts };
    }

    return {
        ensureStore,
        storeLabel,
        store: (id) => (id ? q.storeById.get(id) : null),
        storeByDomain: (d) => q.storeByDomain.get(String(d || '').toLowerCase()),
        product: (id) => (id ? q.productById.get(id) : null),
        productBySlug: (slug) => q.productBySlug.get(String(slug || '')),
        aliases: (productId) => q.aliases.all(productId),
        resolve,
        normAlias,
    };
}

module.exports = { createCatalog, ALIAS_KINDS };
