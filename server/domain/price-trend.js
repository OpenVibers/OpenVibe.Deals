'use strict';
/**
 * A deal's price over time, from its observations (reads.observations: newest first), and the rule
 * that selects a crawled offer as a deal.
 *
 * Only stated prices count, only in the currency of the latest stated price (a listing seen in two
 * currencies is never compared across them: nothing is converted), and never from a removed source.
 * Prices stay the text the source stated; the numbers only order and measure them.
 *
 *   priceTrend(observations) → null (no stated price) or
 *     { currency, count, points: [{ at, num, price }] oldest first,
 *       first, lowest, highest: { at, num, price },
 *       latest: { at, num, price, list_price, list_price_num, saving_num, saving_pct },
 *       change: { amount, percent } | null (one price only),
 *       atLowest: the latest price is the lowest seen (with two or more prices that differ) }
 *
 * The offer page draws it (render/views.js priceChart) and the JSON twin and API carry it as
 * price_trend (publication.js trendDto). A list price (Sources jsonld@2) is shown only beside the
 * price it belongs to; saving_num and saving_pct are null when the observation states none.
 *
 * isDeal(observations, watchHit) → 'list_price' | 'price_drop' | 'watch' | null, the one reason a
 * crawled offer is selected as a deal (see the comment on the function).
 */

const decimals = (s) => { const m = /\.(\d+)$/.exec(String(s)); return m ? m[1].length : 0; };

/** The saving a stated list price represents against its price: { num, pct }, both null when none. */
function savingOf(o) {
    // A raw observation row names its numbers `price_num` / `list_price_num`; a trend point names
    // the price `num`. Text is accepted too, for a caller that built an observation by hand.
    const rawList = o && (o.list_price_num != null ? o.list_price_num : o.list_price);
    const rawPrice = o && (o.price_num != null ? o.price_num : o.num != null ? o.num : o.price);
    const list = rawList != null ? Number(rawList) : NaN;
    const price = rawPrice != null ? Number(rawPrice) : NaN;
    if (!Number.isFinite(list) || !Number.isFinite(price) || list <= price) return { num: null, pct: null };
    const places = Math.max(decimals(o.list_price != null ? o.list_price : list), decimals(o.price != null ? o.price : price));
    return {
        num: Number((list - price).toFixed(places)),
        // A whole number, rounded down; the epsilon only absorbs binary floating-point noise at an exact whole percent.
        pct: Math.floor(((list - price) / list) * 100 + 1e-9),
    };
}

/** The four list-price fields an observation DTO carries; all null when it states no usable list price. */
function listPriceFields(o) {
    const saving = savingOf(o);
    return {
        list_price: o && o.list_price != null ? o.list_price : null,
        list_price_num: o && o.list_price_num != null ? Number(o.list_price_num) : null,
        saving_num: saving.num,
        saving_pct: saving.pct,
    };
}

function priceTrend(observations) {
    const stated = (observations || []).filter((o) => o.price != null && o.price_num != null && Number.isFinite(Number(o.price_num)) && !o.source_removed_at);
    const ref = stated.find((o) => o.currency) || stated[0];
    if (!ref) return null;
    const rows = stated.filter((o) => (o.currency || null) === (ref.currency || null));
    const points = rows.map((o) => ({ at: Number(o.observed_at), num: Number(o.price_num), price: o.price })).reverse();
    const first = points[0];
    // rows are newest first, so its first row is the latest point (points is oldest first).
    const latest = { ...points[points.length - 1], ...listPriceFields(rows[0]) };
    // Ties go to the earliest time: "lowest since" is when it was first that low.
    const lowest = points.reduce((a, p) => (p.num < a.num ? p : a));
    const highest = points.reduce((a, p) => (p.num > a.num ? p : a));
    const places = Math.max(decimals(first.price), decimals(latest.price));
    const change = points.length > 1 ? {
        amount: Number((latest.num - first.num).toFixed(places)),
        percent: first.num > 0 ? Math.round(((latest.num - first.num) / first.num) * 100) : null,
    } : null;
    return {
        currency: ref.currency || null,
        count: points.length,
        points,
        first, latest, lowest, highest,
        change,
        places,
        atLowest: points.length > 1 && lowest.num < highest.num && latest.num <= lowest.num,
    };
}

/**
 * A crawled offer is a deal for exactly one of three reasons, in this order:
 *   list_price   the page states a list price at least 5% above the price (floor of the saving);
 *   price_drop   the latest price is the lowest seen, or lower than the previous observation;
 *   watch        a person's price_below watch matches (watches.js keeps the matching).
 * → the reason, or null when none applies. Newest-first observations, as reads.observations returns.
 */
function isDeal(observations, watchHit = false) {
    // The stored rows always carry the numbers; fill them in from the stated text for a hand-built list.
    const stated = (observations || []).map((o) => ({ ...o, price_num: o && o.price_num != null ? o.price_num : o && o.price, list_price_num: o && o.list_price_num != null ? o.list_price_num : o && o.list_price }));
    const t = priceTrend(stated);
    if (t) {
        if (t.latest.saving_pct != null && t.latest.saving_pct >= 5) return 'list_price';
        const previous = t.points.length > 1 ? t.points[t.points.length - 2] : null;
        if (t.atLowest || (previous && t.latest.num < previous.num)) return 'price_drop';
    }
    return watchHit ? 'watch' : null;
}

module.exports = { priceTrend, isDeal, savingOf, listPriceFields };
