'use strict';
/**
 * A deal's price over time, from its observations (reads.observations: newest first).
 *
 * Only stated prices count, only in the currency of the latest stated price (a listing seen in two
 * currencies is never compared across them: nothing is converted), and never from a removed source.
 * Prices stay the text the source stated; the numbers only order and measure them.
 *
 *   priceTrend(observations) → null (no stated price) or
 *     { currency, count, points: [{ at, num, price }] oldest first,
 *       first, latest, lowest, highest: { at, num, price },
 *       change: { amount, percent } | null (one price only),
 *       atLowest: the latest price is the lowest seen (with two or more prices that differ) }
 *
 * The offer page draws it (render/views.js priceChart) and the JSON twin and API carry it as
 * price_trend (publication.js trendDto).
 */

const decimals = (s) => { const m = /\.(\d+)$/.exec(String(s)); return m ? m[1].length : 0; };

function priceTrend(observations) {
    const stated = (observations || []).filter((o) => o.price != null && o.price_num != null && Number.isFinite(Number(o.price_num)) && !o.source_removed_at);
    const ref = stated.find((o) => o.currency) || stated[0];
    if (!ref) return null;
    const points = stated.filter((o) => (o.currency || null) === (ref.currency || null))
        .map((o) => ({ at: Number(o.observed_at), num: Number(o.price_num), price: o.price }))
        .reverse();
    const first = points[0];
    const latest = points[points.length - 1];
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

module.exports = { priceTrend };
