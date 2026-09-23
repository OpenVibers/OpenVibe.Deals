'use strict';

/**
 * Votes — server-authoritative, one row per (offer, subject), +1 / −1, and 0 for "removed" (the row
 * is kept so a removal is history too). A person's effective vote on a merged group is their most
 * recent row in it, so a voter who voted on two offers that were later merged counts once.
 *
 * Abuse controls (all server-side, all configurable, see README):
 *   rate limits    per subject per hour, per IP hash per hour, per (subject, offer) changes per hour
 *   own offers     a person cannot vote on a deal they submitted (any listing in the group)
 *   new accounts   weight DEALS_NEW_ACCOUNT_WEIGHT (default 0.25) until there is evidence the account
 *                  is at least DEALS_NEW_ACCOUNT_DAYS old: the time embedded in its usr_ ULID (an
 *                  upper bound on the account's age, since subjects were minted when identity moved
 *                  to Network) or when Deals first saw it sign in, whichever is older. The weight is
 *                  stored with the vote, so hotness is recomputable from rows.
 *   vote rings     flags for moderators (never automatic removals):
 *                    shared_ip  ≥ DEALS_RING_IP_MIN distinct voters on one offer from one IP hash
 *                    covote     two voters who voted the same way on ≥ DEALS_RING_COVOTE_MIN offers
 *                               within DEALS_RING_WINDOW_MIN minutes of each other each time
 */
const crypto = require('crypto');
const { ApiError } = require('./util');

const DAY = 24 * 3600 * 1000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The millisecond time embedded in a usr_<ULID> subject, or null. */
function subjectTime(subject) {
    const m = /^usr_([0-9A-HJKMNP-TV-Z]{26})$/.exec(String(subject || ''));
    if (!m) return null;
    let t = 0;
    for (const c of m[1].slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(c);
    return t;
}

function createVotes({ config, store, reads, hotness, limits, flags, people, outbox }) {
    const { db } = store;
    const q = {
        upsert: db.prepare(`INSERT INTO deal_votes (offer_id, subject, value, weight, ip_hash, via, created_at, updated_at)
                            VALUES (@offer_id, @subject, @value, @weight, @ip_hash, @via, @now, @at)
                            ON CONFLICT (offer_id, subject) DO UPDATE SET value = excluded.value, weight = excluded.weight,
                                ip_hash = COALESCE(excluded.ip_hash, deal_votes.ip_hash), via = excluded.via, updated_at = excluded.updated_at`),
        lastInGroup: db.prepare('SELECT MAX(updated_at) AS t FROM deal_votes WHERE subject = ? AND offer_id IN (SELECT value FROM json_each(?))'),
        sameIp: db.prepare(`SELECT DISTINCT subject FROM deal_votes WHERE ip_hash = ? AND value <> 0 AND offer_id IN (SELECT value FROM json_each(?)) ORDER BY subject`),
        covote: db.prepare(`SELECT b.subject AS other, COUNT(DISTINCT a.offer_id) AS n
                              FROM deal_votes a JOIN deal_votes b
                                ON b.offer_id = a.offer_id AND b.subject <> a.subject AND b.value = a.value AND a.value <> 0
                               AND ABS(a.updated_at - b.updated_at) <= @win
                             WHERE a.subject = @s GROUP BY b.subject HAVING n >= @min ORDER BY b.subject`),
    };

    function weightFor(subject, now = store.now()) {
        const minted = subjectTime(subject);
        const seen = people.firstSeen(subject);
        const evidence = Math.max(minted != null ? now - minted : 0, seen != null ? now - seen : 0);
        return evidence >= config.abuse.newAccountDays * DAY ? 1 : config.abuse.newAccountWeight;
    }

    function detectRings(root, ids, subject, ipHash) {
        const raised = [];
        if (ipHash) {
            const subjects = q.sameIp.all(ipHash, JSON.stringify(ids)).map((r) => r.subject);
            if (subjects.length >= config.abuse.ringIpMin) {
                raised.push(flags.raise({
                    kind: 'vote_ring', offerId: root.id, key: `ring:ip:${root.id}:${ipHash}`, reason: 'shared_ip',
                    details: { signal: 'shared_ip', ip_hash: ipHash, voters: subjects },
                }));
            }
        }
        const partners = q.covote.all({ s: subject, win: config.abuse.ringWindowMs, min: config.abuse.ringCovoteMin });
        if (partners.length) {
            const voters = [subject, ...partners.map((p) => p.other)].sort();
            const key = `ring:covote:${crypto.createHash('sha256').update(voters.join(',')).digest('hex').slice(0, 20)}`;
            raised.push(flags.raise({
                kind: 'vote_ring', offerId: root.id, key, reason: 'covote',
                details: { signal: 'covote', voters, shared_offers: Object.fromEntries(partners.map((p) => [p.other, p.n])), window_minutes: config.abuse.ringWindowMs / 60000 },
            }));
        }
        return raised;
    }

    /** value: 1 | -1 (set) or 0 (remove). */
    function apply(viewer, idOrSlug, value, { ip = null, traceparent } = {}) {
        const subject = viewer && viewer.subject;
        if (!subject) throw new ApiError(401, 'auth.required', 'Sign in to vote');
        if (![1, -1, 0].includes(value)) throw new ApiError(422, 'request.invalid', 'value must be 1 or -1');
        const listing = reads.mustFind(idOrSlug);
        const root = reads.root(listing);
        if (root.status === 'disabled') throw new ApiError(409, 'offer.disabled', 'This deal was removed by moderators');
        const ids = reads.groupIds(root.id);
        if (ids.some((id) => { const o = reads.get(id); return o && o.submitted_by === subject; })) {
            throw new ApiError(403, 'vote.own_offer', 'You cannot vote on a deal you posted');
        }
        const ipHash = limits.ipHash(ip);
        return store.tx(() => {
            const current = reads.effectiveVotes(ids).get(subject);
            const previous = current ? current.value : 0;
            if (previous === value) return { changed: false, value, previous, tally: reads.tally(ids), root };
            limits.check('vote', subject, config.abuse.voteSubjectPerHour, 3600 * 1000, 'vote.rate_limited');
            if (ipHash) limits.check('vote_ip', ipHash, config.abuse.voteIpPerHour, 3600 * 1000, 'vote.rate_limited');
            limits.check('vote_offer', `${subject}:${root.id}`, config.abuse.voteOfferChangesPerHour, 3600 * 1000, 'vote.rate_limited');
            const now = store.now();
            const last = q.lastInGroup.get(subject, JSON.stringify(ids)).t;
            const weight = weightFor(subject, now);
            // updated_at strictly after the person's previous row in the group: "most recent" is exact.
            q.upsert.run({ offer_id: root.id, subject, value, weight, ip_hash: ipHash, via: viewer.kind === 'service' ? 'service' : 'user', now, at: last != null && last >= now ? last + 1 : now });
            limits.hit('vote', subject);
            if (ipHash) limits.hit('vote_ip', ipHash);
            limits.hit('vote_offer', `${subject}:${root.id}`);
            const snap = hotness.snapshot(root.id, 'vote', now);
            const tally = reads.tally(ids);
            outbox.emit({
                event_type: 'deals.vote.changed',
                version: 1,
                source: 'deals',
                actor: { type: 'user', id: subject },
                subject: { type: 'offer', id: root.id },
                visibility: 'internal',
                payload: {
                    offer_id: root.id, listing_id: listing.id, value, previous, weight,
                    votes: { up: tally.up, down: tally.down, up_weight: tally.upWeight, down_weight: tally.downWeight },
                    hotness: { formula: snap.formula, hot: snap.hot, score: snap.score },
                },
            }, { traceparent });
            const rings = value !== 0 ? detectRings(root, ids, subject, ipHash) : [];
            return { changed: true, value, previous, weight, tally, hotness: snap, rings, root };
        });
    }

    function mine(subject, root) {
        if (!subject || !root) return 0;
        const v = reads.effectiveVotes(reads.groupIds(root.id)).get(subject);
        return v ? v.value : 0;
    }

    return {
        set: (viewer, id, value, opts) => apply(viewer, id, Number(value), opts),
        remove: (viewer, id, opts) => apply(viewer, id, 0, opts),
        mine,
        weightFor,
    };
}

module.exports = { createVotes, subjectTime };
