'use strict';

/**
 * Hotness — computed only on the server, from stored rows, with one documented formula.
 *
 *   hot@1(upWeight, downWeight, firstSeenAt, t):
 *       score    = upWeight − downWeight                       (weighted votes, 4 decimals)
 *       ageHours = max(0, (t − firstSeenAt) / 3 600 000)
 *       hot      = round6( score / (ageHours + 2) ^ 1.5 )
 *
 *   upWeight / downWeight: the sum of the weights of each voter's effective vote across the offer's
 *   merge group (a voter counts once; weight 1, or DEALS_NEW_ACCOUNT_WEIGHT for accounts new to
 *   Deals, recorded when the vote was cast). firstSeenAt: the earliest created_at in the group.
 *   t: the snapshot time (explicit; there is no hidden clock).
 *
 * The same inputs always give the same number (pure function, fixed rounding). Every snapshot
 * stores all of its inputs, so anyone can recompute it (GET /api/v1/offers/:id/hotness).
 * Snapshots are taken when votes change, on merge/unmerge, on creation, and by the worker for the
 * active offers whose hot is not 0, at one shared `t` (so the hot list compares numbers computed at the
 * same moment). An offer with no net vote has score 0 and so hot 0 at every age: a tick would only
 * write the same 0 again (5.5M rows a day once imports made 40,000 offers, 2026-11-02).
 */
const FORMULA = 'hot@1';
const HOUR = 3600 * 1000;
// How long a tick's snapshots stay (their latest per offer always stays): two hours, about twelve ticks.
const TICK_KEEP_HOURS = 2;

function round(x, places) {
    const f = 10 ** places;
    return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f;
}

function formula({ upWeight, downWeight, firstSeenAt, t }) {
    for (const [k, v] of Object.entries({ upWeight, downWeight, firstSeenAt, t })) {
        if (!Number.isFinite(v)) throw new TypeError(`hot@1 needs a finite ${k}`);
    }
    const score = round(upWeight - downWeight, 4);
    const ageHours = Math.max(0, (t - firstSeenAt) / HOUR);
    const hot = round(score / Math.pow(ageHours + 2, 1.5), 6);
    return { formula: FORMULA, score, hot, ageHours: round(ageHours, 4) };
}

function createHotness({ store, reads }) {
    const { db } = store;
    const insert = db.prepare(`INSERT INTO deal_hotness_snapshots (offer_id, computed_at, formula, up_count, down_count, up_weight, down_weight, score, hot, first_seen_at, reason)
                               VALUES (@offer_id, @computed_at, @formula, @up_count, @down_count, @up_weight, @down_weight, @score, @hot, @first_seen_at, @reason)`);
    const firstSeen = db.prepare('SELECT MIN(created_at) AS t FROM deal_offers WHERE id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))');
    // The offer carries its latest hot (migration 0010), so the lists sort on one indexed column.
    const latest = db.prepare('UPDATE deal_offers SET hot_latest = ? WHERE id = ?');

    /** Inputs for a canonical offer at time t (from the database, never from a request). */
    async function inputs(rootId, t) {
        const ids = await reads.groupIds(rootId);
        const tally = await reads.tally(ids);
        return { ids, tally, firstSeenAt: (await firstSeen.get(JSON.stringify(ids))).t, t };
    }

    /** Compute and store a snapshot for a canonical offer. Inside the caller's transaction. */
    async function snapshot(rootId, reason, t = store.now()) {
        const { tally, firstSeenAt } = await inputs(rootId, t);
        const r = formula({ upWeight: tally.upWeight, downWeight: tally.downWeight, firstSeenAt, t });
        const row = {
            offer_id: rootId, computed_at: t, formula: r.formula, up_count: tally.up, down_count: tally.down,
            up_weight: tally.upWeight, down_weight: tally.downWeight, score: r.score, hot: r.hot, first_seen_at: firstSeenAt, reason,
        };
        await insert.run(row);
        await latest.run(row.hot, rootId);
        return row;
    }

    /** Recompute from a stored snapshot's own inputs (the audit check). */
    function recompute(snap) {
        return formula({ upWeight: snap.up_weight, downWeight: snap.down_weight, firstSeenAt: snap.first_seen_at, t: snap.computed_at });
    }

    /**
     * Worker: snapshot the active canonical offers created in the window whose hot can change with time, all at the
     * same t. Hot is score / (age + 2)^1.5, so it moves with age only when the score is not 0; an offer whose latest
     * hot is 0 (no net vote) stays 0 until a vote, which takes its own snapshot. An offer with no snapshot yet is
     * included, so it gets one.
     */
    async function tick({ windowDays = 14, t = store.now() } = {}) {
        const ids = (await db.prepare(`SELECT id FROM deal_offers WHERE status = 'active' AND merged_into IS NULL AND created_at >= ?
                                         AND (hot_latest IS NULL OR hot_latest <> 0)`).all(t - windowDays * 24 * HOUR)).map((r) => r.id);
        await store.tx(async () => { for (const id of ids) await snapshot(id, 'tick', t); });
        // Keep the latest snapshot per offer, every snapshot a vote, merge or creation made in the last 7 days, and the
        // worker's own tick snapshots of the last two hours. A tick re-snapshots every active offer: about 2,700 on
        // 2026-10-23, 39,547 on 2026-11-02, when a day of ticks was 4.2M rows (1.5 GB) and the old delete
        // (NOT IN (SELECT MAX(id) … GROUP BY offer_id)) took 1.2 s each run. A snapshot goes only when a newer one of
        // the same offer exists, asked of the (offer_id, id) index; old ticks come in order from deal_hotness_old_ticks
        // (migration 0011). Up to 100,000 rows a tick: more than a tick writes, so a backlog drains.
        await db.prepare(`DELETE FROM deal_hotness_snapshots WHERE id IN (
            SELECT s.id FROM deal_hotness_snapshots s
             WHERE s.reason = 'tick' AND s.computed_at < ?
               AND EXISTS (SELECT 1 FROM deal_hotness_snapshots n WHERE n.offer_id = s.offer_id AND n.id > s.id)
             ORDER BY s.computed_at LIMIT 100000)`).run(t - TICK_KEEP_HOURS * HOUR);
        await db.prepare(`DELETE FROM deal_hotness_snapshots WHERE id IN (
            SELECT s.id FROM deal_hotness_snapshots s
             WHERE s.reason <> 'tick' AND s.computed_at < ?
               AND EXISTS (SELECT 1 FROM deal_hotness_snapshots n WHERE n.offer_id = s.offer_id AND n.id > s.id)
             LIMIT 20000)`).run(t - 7 * 24 * HOUR);
        return ids.length;
    }

    return { snapshot, recompute, inputs, tick, formula, FORMULA };
}

module.exports = { createHotness, formula, FORMULA };
