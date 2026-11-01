'use strict';

/**
 * Lists of canonical offers (merged listings never appear on their own; disabled ones never appear).
 *
 *   hot      active offers by their latest hotness snapshot (hot@1), newest first on ties
 *   newest   active offers by first posting time
 *   search   active (or all non-disabled, with expired) offers whose title/description contain every word
 *   store    a store's offers, expired ones included and marked
 *   category active offers in one category as their source states it (migration 0007), newest first
 *   ending   active offers whose STATED end falls in a window, soonest first (an unknown end is never assumed)
 *   picks    active offers a source's editors picked (staff_pick), newest first
 *   upvoted  active offers whose latest hotness is above zero (people voted them up), hottest first
 *   under    active offers whose latest observation states a price at or below a limit in one currency
 */
const { tokens } = require('./values');

/** Search bounds: a search runs a LIKE scan per word, so a caller cannot grow the work without limit. */
const SEARCH_QUERY_MAX = 100;   // characters kept from the raw query
const SEARCH_WORDS_MAX = 5;     // words matched (every word must match, so extras only narrow); extras ignored
const SEARCH_RESULTS_MAX = 100; // rows per query, whatever the caller asks

function createListings({ store }) {
    const { db } = store;
    const LATEST = 'h.id = (SELECT MAX(id) FROM deal_hotness_snapshots WHERE offer_id = o.id)';
    const q = {
        hot: db.prepare(`SELECT o.*, h.hot AS hot FROM deal_offers o LEFT JOIN deal_hotness_snapshots h ON ${LATEST}
                         WHERE o.status = 'active' AND o.merged_into IS NULL ORDER BY COALESCE(h.hot, 0) DESC, o.created_at DESC, o.seq DESC LIMIT ? OFFSET ?`),
        newest: db.prepare(`SELECT o.* FROM deal_offers o WHERE o.status = 'active' AND o.merged_into IS NULL ORDER BY o.created_at DESC, o.seq DESC LIMIT ? OFFSET ?`),
        countActive: db.prepare("SELECT COUNT(*) AS n FROM deal_offers WHERE status = 'active' AND merged_into IS NULL"),
        byStore: db.prepare(`SELECT * FROM deal_offers WHERE store_id = ? AND merged_into IS NULL AND status <> 'disabled' ORDER BY status = 'active' DESC, created_at DESC LIMIT ? OFFSET ?`),
        countStore: db.prepare(`SELECT COUNT(*) AS n FROM deal_offers WHERE store_id = ? AND merged_into IS NULL AND status <> 'disabled'`),
        // A shop's own line (market outcome 6): how many deals are active, and how often its prices were seen today.
        storeStats: db.prepare(`SELECT (SELECT COUNT(*) FROM deal_offers WHERE store_id = ? AND merged_into IS NULL AND status = 'active') AS active,
                                       (SELECT COUNT(*) FROM deal_price_observations p JOIN deal_offers o ON o.id = p.offer_id
                                         WHERE o.store_id = ? AND p.observed_at >= ?) AS seen24`),
        // Sellers: the shop a source names (migration 0006), as stated; a seller page lists by that exact name.
        sellers: db.prepare(`SELECT seller, COUNT(*) AS n, MAX(created_at) AS latest FROM deal_offers WHERE seller IS NOT NULL AND merged_into IS NULL AND status <> 'disabled' GROUP BY seller ORDER BY n DESC, seller LIMIT 2000`),
        bySeller: db.prepare(`SELECT * FROM deal_offers WHERE seller = ? AND merged_into IS NULL AND status <> 'disabled' ORDER BY status = 'active' DESC, created_at DESC LIMIT ? OFFSET ?`),
        countSeller: db.prepare(`SELECT COUNT(*) AS n FROM deal_offers WHERE seller = ? AND merged_into IS NULL AND status <> 'disabled'`),
        indexable: db.prepare(`SELECT * FROM deal_offers WHERE merged_into IS NULL AND status <> 'disabled' ORDER BY created_at DESC LIMIT 50000`),
        products: db.prepare(`SELECT DISTINCT p.* FROM deal_products p JOIN deal_offers o ON o.product_id = p.id WHERE o.merged_into IS NULL AND o.status <> 'disabled' LIMIT 50000`),
        duplicates: db.prepare(`SELECT a.id AS a, b.id AS b FROM deal_offers a JOIN deal_offers b
                                  ON b.store_id = a.store_id AND b.id > a.id
                                 AND ((a.product_id IS NOT NULL AND b.product_id = a.product_id) OR lower(b.title) = lower(a.title))
                               WHERE a.merged_into IS NULL AND b.merged_into IS NULL AND a.status <> 'disabled' AND b.status <> 'disabled'
                               ORDER BY b.created_at DESC LIMIT ?`),
        categories: db.prepare(`SELECT category, COUNT(*) AS n, MAX(created_at) AS latest FROM deal_offers WHERE category IS NOT NULL AND status = 'active' AND merged_into IS NULL GROUP BY category ORDER BY n DESC, category LIMIT 1000`),
        byCategory: db.prepare(`SELECT * FROM deal_offers WHERE category = ? AND status = 'active' AND merged_into IS NULL ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`),
        countCategory: db.prepare(`SELECT COUNT(*) AS n FROM deal_offers WHERE category = ? AND status = 'active' AND merged_into IS NULL`),
        ending: db.prepare(`SELECT * FROM deal_offers WHERE status = 'active' AND merged_into IS NULL AND expires_at > ? AND expires_at <= ? ORDER BY expires_at, seq LIMIT ? OFFSET ?`),
        countEnding: db.prepare(`SELECT COUNT(*) AS n FROM deal_offers WHERE status = 'active' AND merged_into IS NULL AND expires_at > ? AND expires_at <= ?`),
        picks: db.prepare(`SELECT * FROM deal_offers WHERE staff_pick = true AND status = 'active' AND merged_into IS NULL ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`),
        countPicks: db.prepare(`SELECT COUNT(*) AS n FROM deal_offers WHERE staff_pick = true AND status = 'active' AND merged_into IS NULL`),
        upvoted: db.prepare(`SELECT o.*, h.hot AS hot FROM deal_offers o JOIN deal_hotness_snapshots h ON ${LATEST}
                             WHERE o.status = 'active' AND o.merged_into IS NULL AND h.hot > 0 ORDER BY h.hot DESC, o.created_at DESC, o.seq DESC LIMIT ?`),
        // The latest observation of each offer (the one a card shows), when it states a price in this currency at or below the limit.
        under: db.prepare(`SELECT o.* FROM deal_offers o JOIN deal_price_observations p ON p.id = (SELECT id FROM deal_price_observations WHERE offer_id = o.id ORDER BY observed_at DESC, seq DESC LIMIT 1)
                           WHERE o.status = 'active' AND o.merged_into IS NULL AND p.price_num IS NOT NULL AND p.price_num <= ? AND p.currency = ? AND p.observed_at > ?
                           ORDER BY o.created_at DESC, o.seq DESC LIMIT ?`),
        seenSince: db.prepare('SELECT COUNT(*) AS n FROM deal_price_observations WHERE observed_at > ?'),
        pendingReview: db.prepare(`SELECT * FROM deal_offers WHERE review_state = 'pending' AND merged_into IS NULL AND status <> 'disabled' ORDER BY created_at DESC LIMIT ?`),
    };

    async function search(query, { limit = 20, offset = 0, includeExpired = false } = {}) {
        const words = [...new Set(tokens(String(query || '').slice(0, SEARCH_QUERY_MAX)))].slice(0, SEARCH_WORDS_MAX);
        if (!words.length) return { total: 0, rows: [] };
        const take = Math.min(Math.max(1, Math.trunc(limit) || 20), SEARCH_RESULTS_MAX);
        const skip = Math.max(0, Math.trunc(offset) || 0);
        const where = words.map((_, i) => `(' ' || lower(o.title) || ' ' || lower(COALESCE(o.description, '')) || ' ') LIKE @w${i}`).join(' AND ');
        const params = Object.fromEntries(words.map((w, i) => [`w${i}`, `%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`]));
        const status = includeExpired ? "o.status <> 'disabled'" : "o.status = 'active'";
        const base = `FROM deal_offers o WHERE o.merged_into IS NULL AND ${status} AND ${where.replace(/LIKE (@w\d+)/g, "LIKE $1 ESCAPE '\\'")}`;
        const total = (await db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params)).n;
        const rows = await db.prepare(`SELECT o.* ${base} ORDER BY o.created_at DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: take, offset: skip });
        return { total, rows, words };
    }

    return {
        hot: async (limit, offset) => await q.hot.all(limit, offset),
        newest: async (limit, offset) => await q.newest.all(limit, offset),
        countActive: async () => (await q.countActive.get()).n,
        byStore: async (storeId, limit, offset) => await q.byStore.all(storeId, limit, offset),
        countStore: async (storeId) => (await q.countStore.get(storeId)).n,
        storeStats: async (storeId, now = Date.now()) => {
            const r = await q.storeStats.get(storeId, storeId, now - 24 * 3_600_000);
            return { active: Number(r.active) || 0, seen24: Number(r.seen24) || 0 };
        },
        sellers: async () => (await q.sellers.all()).map((r) => ({ seller: r.seller, slug: sellerSlug(r.seller), count: Number(r.n), latest: r.latest })),
        bySeller: async (seller, limit, offset) => await q.bySeller.all(seller, limit, offset),
        countSeller: async (seller) => (await q.countSeller.get(seller)).n,
        indexable: async () => await q.indexable.all(),
        products: async () => await q.products.all(),
        possibleDuplicates: async (limit = 50) => await q.duplicates.all(limit),
        pendingReview: async (limit = 50) => await q.pendingReview.all(limit),
        categories: async () => (await q.categories.all()).map((r) => ({ category: r.category, slug: sellerSlug(r.category), count: Number(r.n), latest: r.latest == null ? null : Number(r.latest) })),
        byCategory: async (category, limit, offset) => await q.byCategory.all(category, limit, offset),
        countCategory: async (category) => Number((await q.countCategory.get(category)).n),
        endingSoon: async (from, to, limit, offset = 0) => await q.ending.all(from, to, limit, offset),
        countEnding: async (from, to) => Number((await q.countEnding.get(from, to)).n),
        picks: async (limit, offset = 0) => await q.picks.all(limit, offset),
        countPicks: async () => Number((await q.countPicks.get()).n),
        upvoted: async (limit) => await q.upvoted.all(limit),
        under: async (max, currency, observedAfter, limit) => await q.under.all(max, currency, observedAfter, limit),
        seenSince: async (t) => Number((await q.seenSince.get(t)).n),
        search,
    };
}

/** "Best Buy" → "best-buy", "Target.com" → "target-com": a seller's address under /at/ (and a category's under /c/). */
const sellerSlug = (name) => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

module.exports = { createListings, sellerSlug };
