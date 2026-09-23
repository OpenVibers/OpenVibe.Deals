'use strict';

/**
 * Lists of canonical offers (merged listings never appear on their own; disabled ones never appear).
 *
 *   hot      active offers by their latest hotness snapshot (hot@1), newest first on ties
 *   newest   active offers by first posting time
 *   search   active (or all non-disabled, with expired) offers whose title/description contain every word
 *   store    a store's offers, expired ones included and marked
 */
const { tokens } = require('./util');

function createListings({ store }) {
    const { db } = store;
    const LATEST = 'h.id = (SELECT MAX(id) FROM deal_hotness_snapshots WHERE offer_id = o.id)';
    const q = {
        hot: db.prepare(`SELECT o.*, h.hot AS hot FROM deal_offers o LEFT JOIN deal_hotness_snapshots h ON ${LATEST}
                         WHERE o.status = 'active' AND o.merged_into IS NULL ORDER BY COALESCE(h.hot, 0) DESC, o.created_at DESC, o.rowid DESC LIMIT ? OFFSET ?`),
        newest: db.prepare(`SELECT o.* FROM deal_offers o WHERE o.status = 'active' AND o.merged_into IS NULL ORDER BY o.created_at DESC, o.rowid DESC LIMIT ? OFFSET ?`),
        countActive: db.prepare("SELECT COUNT(*) AS n FROM deal_offers WHERE status = 'active' AND merged_into IS NULL"),
        byStore: db.prepare(`SELECT * FROM deal_offers WHERE store_id = ? AND merged_into IS NULL AND status <> 'disabled' ORDER BY status = 'active' DESC, created_at DESC LIMIT ? OFFSET ?`),
        countStore: db.prepare(`SELECT COUNT(*) AS n FROM deal_offers WHERE store_id = ? AND merged_into IS NULL AND status <> 'disabled'`),
        indexable: db.prepare(`SELECT * FROM deal_offers WHERE merged_into IS NULL AND status <> 'disabled' ORDER BY created_at DESC LIMIT 50000`),
        products: db.prepare(`SELECT DISTINCT p.* FROM deal_products p JOIN deal_offers o ON o.product_id = p.id WHERE o.merged_into IS NULL AND o.status <> 'disabled' LIMIT 50000`),
        duplicates: db.prepare(`SELECT a.id AS a, b.id AS b FROM deal_offers a JOIN deal_offers b
                                  ON b.store_id = a.store_id AND b.id > a.id
                                 AND ((a.product_id IS NOT NULL AND b.product_id = a.product_id) OR lower(b.title) = lower(a.title))
                               WHERE a.merged_into IS NULL AND b.merged_into IS NULL AND a.status <> 'disabled' AND b.status <> 'disabled'
                               ORDER BY b.created_at DESC LIMIT ?`),
        pendingReview: db.prepare(`SELECT * FROM deal_offers WHERE review_state = 'pending' AND merged_into IS NULL AND status <> 'disabled' ORDER BY created_at DESC LIMIT ?`),
    };

    function search(query, { limit = 20, offset = 0, includeExpired = false } = {}) {
        const words = [...new Set(tokens(query))].slice(0, 6);
        if (!words.length) return { total: 0, rows: [] };
        const where = words.map((_, i) => `(' ' || lower(o.title) || ' ' || lower(COALESCE(o.description, '')) || ' ') LIKE @w${i}`).join(' AND ');
        const params = Object.fromEntries(words.map((w, i) => [`w${i}`, `%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`]));
        const status = includeExpired ? "o.status <> 'disabled'" : "o.status = 'active'";
        const base = `FROM deal_offers o WHERE o.merged_into IS NULL AND ${status} AND ${where.replace(/LIKE (@w\d+)/g, "LIKE $1 ESCAPE '\\'")}`;
        const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
        const rows = db.prepare(`SELECT o.* ${base} ORDER BY o.created_at DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset });
        return { total, rows, words };
    }

    return {
        hot: (limit, offset) => q.hot.all(limit, offset),
        newest: (limit, offset) => q.newest.all(limit, offset),
        countActive: () => q.countActive.get().n,
        byStore: (storeId, limit, offset) => q.byStore.all(storeId, limit, offset),
        countStore: (storeId) => q.countStore.get(storeId).n,
        indexable: () => q.indexable.all(),
        products: () => q.products.all(),
        possibleDuplicates: (limit = 50) => q.duplicates.all(limit),
        pendingReview: (limit = 50) => q.pendingReview.all(limit),
        search,
    };
}

module.exports = { createListings };
