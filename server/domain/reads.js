'use strict';

/**
 * Read-side queries over offers and their merge groups.
 *
 * Merging never moves rows. Offer B merged into A only sets B.merged_into = A; A's group is A plus
 * every offer whose merged_into chain ends at A. Everything shown for A — observations, sources,
 * votes — is read across the group, and unmerging (clearing the pointer) gives B back exactly what
 * it had. A vote a person cast on both A and B counts once: their most recent row in the group.
 */
const { ApiError } = require('./util');

function createReads({ store }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM deal_offers WHERE id = ?'),
        bySlug: db.prepare('SELECT * FROM deal_offers WHERE slug = ?'),
        group: db.prepare(`WITH RECURSIVE g(id, depth) AS (SELECT ?, 0 UNION SELECT o.id, g.depth + 1 FROM deal_offers o JOIN g ON o.merged_into = g.id WHERE g.depth < 50)
                           SELECT id FROM g`),
        observations: db.prepare(`SELECT o.*, o.rowid AS seq, s.kind AS source_kind, s.ref_service, s.ref_type, s.ref_id, s.ref_revision, s.source_key,
                                         s.url AS source_url, s.label AS source_label, s.license_note, s.removed_at AS source_removed_at
                                    FROM deal_price_observations o JOIN deal_offer_sources s ON s.id = o.source_id
                                   WHERE o.offer_id IN (SELECT value FROM json_each(?))
                                   ORDER BY o.observed_at DESC, o.rowid DESC`),
        latest: db.prepare(`SELECT o.*, s.kind AS source_kind, s.ref_service, s.ref_id, s.source_key, s.url AS source_url, s.label AS source_label
                              FROM deal_price_observations o JOIN deal_offer_sources s ON s.id = o.source_id
                             WHERE o.offer_id IN (SELECT value FROM json_each(?)) AND s.removed_at IS NULL
                             ORDER BY o.observed_at DESC, o.rowid DESC LIMIT 1`),
        sources: db.prepare(`SELECT * FROM deal_offer_sources WHERE offer_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`),
        votes: db.prepare(`SELECT offer_id, subject, value, weight, ip_hash, updated_at, rowid AS seq FROM deal_votes
                            WHERE offer_id IN (SELECT value FROM json_each(?)) ORDER BY updated_at, rowid`),
        members: db.prepare('SELECT * FROM deal_offers WHERE merged_into = ? ORDER BY merged_at'),
        lastSnapshot: db.prepare('SELECT * FROM deal_hotness_snapshots WHERE offer_id = ? ORDER BY id DESC LIMIT 1'),
    };

    const get = (id) => (id ? q.byId.get(String(id)) : null);

    /** By id (dof_…) or slug. */
    function find(idOrSlug) {
        const s = String(idOrSlug || '');
        return s.startsWith('dof_') ? get(s) : q.bySlug.get(s) || null;
    }

    function mustFind(idOrSlug) {
        const o = find(idOrSlug);
        if (!o) throw new ApiError(404, 'offer.not_found', 'No such offer');
        return o;
    }

    /** The canonical offer a (possibly merged) offer resolves to. */
    function root(offer) {
        let cur = offer;
        for (let i = 0; cur && cur.merged_into && i < 50; i++) cur = get(cur.merged_into);
        return cur;
    }

    const groupIds = (rootId) => q.group.all(rootId).map((r) => r.id);
    const J = (list) => JSON.stringify(list);

    /** Each subject's effective vote in a group: their most recent row (0 = removed). */
    function effectiveVotes(ids) {
        const bySubject = new Map();
        for (const v of q.votes.all(J(ids))) bySubject.set(v.subject, v);
        return bySubject;
    }

    function tally(ids) {
        let up = 0, down = 0, upW = 0, downW = 0;
        for (const v of effectiveVotes(ids).values()) {
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
        observations: (ids) => q.observations.all(J(ids)),
        latestObservation: (ids) => q.latest.get(J(ids)) || null,
        sources: (ids) => q.sources.all(J(ids)),
        effectiveVotes,
        tally,
        mergedMembers: (id) => q.members.all(id),
        lastSnapshot: (id) => q.lastSnapshot.get(id) || null,
    };
}

module.exports = { createReads };
