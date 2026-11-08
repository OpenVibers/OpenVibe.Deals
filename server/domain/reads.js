'use strict';

/**
 * Read-side queries over offers and their merge groups.
 *
 * Merging never moves rows. Offer B merged into A only sets B.merged_into = A; A's group is A plus
 * every offer whose merged_into chain ends at A. Everything shown for A — observations, sources,
 * votes — is read across the group, and unmerging (clearing the pointer) gives B back exactly what
 * it had. A vote a person cast on both A and B counts once: their most recent row in the group.
 */
const { ApiError } = require('./values');

function createReads({ store }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM deal_offers WHERE id = ?'),
        bySlug: db.prepare('SELECT * FROM deal_offers WHERE slug = ?'),
        group: db.prepare(`WITH RECURSIVE g(id, depth) AS (SELECT ?::text COLLATE "C", 0 UNION SELECT o.id, g.depth + 1 FROM deal_offers o JOIN g ON o.merged_into = g.id WHERE g.depth < 50)
                           SELECT id FROM g`),
        observations: db.prepare(`SELECT o.*, s.kind AS source_kind, s.ref_service, s.ref_type, s.ref_id, s.ref_revision, s.source_key,
                                         s.url AS source_url, s.label AS source_label, s.license_note, s.removed_at AS source_removed_at
                                    FROM deal_price_observations o JOIN deal_offer_sources s ON s.id = o.source_id
                                   WHERE o.offer_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))
                                   ORDER BY o.observed_at DESC, o.seq DESC`),
        latest: db.prepare(`SELECT o.*, s.kind AS source_kind, s.ref_service, s.ref_id, s.source_key, s.url AS source_url, s.label AS source_label
                              FROM deal_price_observations o JOIN deal_offer_sources s ON s.id = o.source_id
                             WHERE o.offer_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) AND s.removed_at IS NULL
                             ORDER BY o.observed_at DESC, o.seq DESC LIMIT 1`),
        sources: db.prepare(`SELECT * FROM deal_offer_sources WHERE offer_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) ORDER BY created_at, seq`),
        votes: db.prepare(`SELECT offer_id, subject, value, weight, ip_hash, updated_at, seq FROM deal_votes
                            WHERE offer_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) ORDER BY updated_at, seq`),
        members: db.prepare('SELECT * FROM deal_offers WHERE merged_into = ? ORDER BY merged_at'),
        lastSnapshot: db.prepare('SELECT * FROM deal_hotness_snapshots WHERE offer_id = ? ORDER BY id DESC LIMIT 1'),
        // The batched forms: one statement for every offer of a page instead of one per offer.
        latestByOffer: db.prepare(`SELECT DISTINCT ON (o.offer_id) o.*, s.kind AS source_kind, s.ref_service, s.ref_id, s.source_key, s.url AS source_url, s.label AS source_label
                                      FROM deal_price_observations o JOIN deal_offer_sources s ON s.id = o.source_id
                                     WHERE o.offer_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) AND s.removed_at IS NULL
                                     ORDER BY o.offer_id, o.observed_at DESC, o.seq DESC`),
        lastSnapshots: db.prepare(`SELECT DISTINCT ON (offer_id) * FROM deal_hotness_snapshots
                                    WHERE offer_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))
                                    ORDER BY offer_id, id DESC`),
    };

    const get = async (id) => (id ? await q.byId.get(String(id)) : null);

    /** By id (dof_…) or slug. */
    async function find(idOrSlug) {
        const s = String(idOrSlug || '');
        return s.startsWith('dof_') ? await get(s) : await q.bySlug.get(s) || null;
    }

    async function mustFind(idOrSlug) {
        const o = await find(idOrSlug);
        if (!o) throw new ApiError(404, 'offer.not_found', 'No such offer');
        return o;
    }

    /** The canonical offer a (possibly merged) offer resolves to. */
    async function root(offer) {
        let cur = offer;
        for (let i = 0; cur && cur.merged_into && i < 50; i++) cur = await get(cur.merged_into);
        return cur;
    }

    const groupIds = async (rootId) => (await q.group.all(rootId)).map((r) => r.id);
    const J = (list) => JSON.stringify(list);

    /** Each subject's effective vote in a group: their most recent row (0 = removed). */
    async function effectiveVotes(ids) {
        const bySubject = new Map();
        for (const v of await q.votes.all(J(ids))) bySubject.set(v.subject, v);
        return bySubject;
    }

    /**
     * One per-offer read per page, not per offer. Everything that renders a list (a page of 25, forty cards, a product's
     * offers, the sitemap's eight-entry waves) asks latestObservation/lastSnapshot once per offer; the calls made in the
     * same turn share one statement. On 2026-11-08 the two reads were 2.1 M and 3.5 M calls a day (324 s and 251 s of DB
     * time, pg_stat_statements) because each page repeated them per offer. Inside a transaction the read stays direct:
     * a batch belongs to the caller's turn and must never run on another caller's connection.
     */
    function coalesce(readOne, load, keyOf, answer) {
        if (!db.inTransaction || typeof db.inTransaction !== 'function') return readOne;
        let pending = null;
        let scheduled = false;
        const flush = async () => {
            scheduled = false;
            const batch = pending; pending = null;
            try {
                const rows = await load([...batch.values()].map((w) => w.arg));
                for (const w of batch.values()) w.resolve(answer(w.arg, rows));
            } catch (err) {
                for (const w of batch.values()) w.reject(err);
            }
        };
        return (arg) => {
            if (db.inTransaction()) return readOne(arg);
            const key = keyOf(arg);
            if (!pending) pending = new Map();
            const hit = pending.get(key);
            if (hit) return hit.promise;
            let w;
            const promise = new Promise((resolve, reject) => { w = { arg, resolve, reject, promise: null }; });
            w.promise = promise;
            pending.set(key, w);
            if (!scheduled) { scheduled = true; setImmediate(flush); }
            return promise;
        };
    }

    /** The latest observation of each offer in one query, then the group's newest of those (the old LIMIT 1 read). */
    const latestObservation = coalesce(
        async (ids) => await q.latest.get(J(ids)) || null,
        async (lists) => {
            const ids = [...new Set(lists.flat())];
            if (!ids.length) return new Map();
            return new Map((await q.latestByOffer.all(J(ids))).map((o) => [o.offer_id, o]));
        },
        (ids) => JSON.stringify(ids),
        (ids, byOffer) => {
            let best = null;
            for (const id of ids) {
                const o = byOffer.get(id);
                if (o && (!best || o.observed_at > best.observed_at || (o.observed_at === best.observed_at && o.seq > best.seq))) best = o;
            }
            return best || null;
        },
    );

    /** Each root's latest snapshot in one query. A group shares its root's snapshots, exactly as before. */
    const lastSnapshot = coalesce(
        async (id) => await q.lastSnapshot.get(id) || null,
        async (ids) => new Map((await q.lastSnapshots.all(J([...new Set(ids)]))).map((s) => [s.offer_id, s])),
        (id) => String(id),
        (id, byOffer) => byOffer.get(id) || null,
    );

    async function tally(ids) {
        let up = 0, down = 0, upW = 0, downW = 0;
        for (const v of (await effectiveVotes(ids)).values()) {
            if (v.value === 1) { up++; upW += v.weight; } else if (v.value === -1) { down++; downW += v.weight; }
        }
        const r4 = (x) => Math.round(x * 10000) / 10000;
        return { up, down, upWeight: r4(upW), downWeight: r4(downW) };
    }

    return {
        get,
        find,
        mustFind,
        root,
        groupIds,
        observations: async (ids) => await q.observations.all(J(ids)),
        sources: async (ids) => await q.sources.all(J(ids)),
        effectiveVotes,
        tally,
        mergedMembers: async (id) => await q.members.all(id),
        latestObservation,
        lastSnapshot,
    };
}

module.exports = { createReads };
