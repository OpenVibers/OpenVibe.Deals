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
 * Snapshots are taken when votes change, on merge/unmerge, on creation, and by the worker for all
 * active offers at one shared `t` (so the hot list compares numbers computed at the same moment).
 */
const FORMULA = 'hot@1';
const HOUR = 3600 * 1000;

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
    const firstSeen = db.prepare('SELECT MIN(created_at) AS t FROM deal_offers WHERE id IN (SELECT value FROM json_each(?))');

    /** Inputs for a canonical offer at time t (from the database, never from a request). */
    function inputs(rootId, t) {
        const ids = reads.groupIds(rootId);
        const tally = reads.tally(ids);
        return { ids, tally, firstSeenAt: firstSeen.get(JSON.stringify(ids)).t, t };
    }

    /** Compute and store a snapshot for a canonical offer. Inside the caller's transaction. */
    function snapshot(rootId, reason, t = store.now()) {
        const { tally, firstSeenAt } = inputs(rootId, t);
        const r = formula({ upWeight: tally.upWeight, downWeight: tally.downWeight, firstSeenAt, t });
        const row = {
            offer_id: rootId, computed_at: t, formula: r.formula, up_count: tally.up, down_count: tally.down,
            up_weight: tally.upWeight, down_weight: tally.downWeight, score: r.score, hot: r.hot, first_seen_at: firstSeenAt, reason,
        };
        insert.run(row);
        return row;
    }

    /** Recompute from a stored snapshot's own inputs (the audit check). */
    function recompute(snap) {
        return formula({ upWeight: snap.up_weight, downWeight: snap.down_weight, firstSeenAt: snap.first_seen_at, t: snap.computed_at });
    }

    /** Worker: snapshot every active canonical offer created in the window, all at the same t. */
    function tick({ windowDays = 14, t = store.now() } = {}) {
        const ids = db.prepare(`SELECT id FROM deal_offers WHERE status = 'active' AND merged_into IS NULL AND created_at >= ?`).all(t - windowDays * 24 * HOUR).map((r) => r.id);
        store.tx(() => { for (const id of ids) snapshot(id, 'tick', t); });
        // Keep the latest snapshot per offer and everything from the last 7 days.
        db.prepare(`DELETE FROM deal_hotness_snapshots WHERE computed_at < ? AND id NOT IN (SELECT MAX(id) FROM deal_hotness_snapshots GROUP BY offer_id)`).run(t - 7 * 24 * HOUR);
        return ids.length;
    }

    return { snapshot, recompute, inputs, tick, formula, FORMULA };
}

module.exports = { createHotness, formula, FORMULA };
