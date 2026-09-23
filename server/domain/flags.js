'use strict';

/**
 * Flags: reports from people (expired, wrong price, spam, duplicate, other) and system flags
 * (vote_ring) for moderators. At most one OPEN flag per dedupe key: a person reporting the same
 * offer twice, or the detector seeing the same ring again, updates the open flag instead of adding
 * noise. Flags never change an offer by themselves; a moderator decides (expire, disable, merge,
 * dismiss).
 */
const { ApiError, newId, text, iso } = require('./util');

const USER_KINDS = ['expired', 'price_wrong', 'spam', 'duplicate', 'other'];

function createFlags({ config, store, reads, limits, access, publication, logAction }) {
    const { db } = store;
    const q = {
        get: db.prepare('SELECT * FROM deal_flags WHERE id = ?'),
        openByKey: db.prepare("SELECT * FROM deal_flags WHERE dedupe_key = ? AND status = 'open'"),
        insert: db.prepare(`INSERT INTO deal_flags (id, offer_id, kind, origin, reporter, reason, details, dedupe_key, status, created_at, updated_at)
                            VALUES (@id, @offer_id, @kind, @origin, @reporter, @reason, @details, @dedupe_key, 'open', @now, @now)`),
        touch: db.prepare('UPDATE deal_flags SET details = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?'),
        list: db.prepare('SELECT * FROM deal_flags WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
        forOffer: db.prepare('SELECT * FROM deal_flags WHERE offer_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC'),
        resolve: db.prepare('UPDATE deal_flags SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ?, updated_at = ? WHERE id = ?'),
    };

    /** A person's report. */
    function report(viewer, idOrSlug, input = {}, { ip = null } = {}) {
        const subject = viewer && viewer.subject;
        if (!subject) throw new ApiError(401, 'auth.required', 'Sign in to report a deal');
        const root = reads.root(reads.mustFind(idOrSlug));
        const kind = String(input.kind || '');
        if (!USER_KINDS.includes(kind)) throw new ApiError(422, 'request.invalid', `kind must be one of ${USER_KINDS.join(', ')}`);
        const reason = text(input.reason, { field: 'reason', max: 500 });
        let details = {};
        if (kind === 'duplicate') {
            const other = input.duplicate_of ? reads.find(String(input.duplicate_of).trim().replace(/^.*\/d\//, '').replace(/(\.json)?([?#].*)?$/, '')) : null;
            if (!other) throw new ApiError(422, 'request.invalid', 'duplicate_of must name the other deal (id or slug)');
            details = { duplicate_of: reads.root(other).id };
        }
        return store.tx(() => {
            const key = `user:${subject}:${root.id}`;
            const open = q.openByKey.get(key);
            if (open) {
                q.touch.run(JSON.stringify({ ...JSON.parse(open.details || '{}'), ...details, kind }), reason, store.now(), open.id);
                return { flag: q.get.get(open.id), created: false };
            }
            limits.check('flag', subject, config.abuse.flagPerDay, 24 * 3600 * 1000, 'flag.rate_limited');
            const id = newId('dfl');
            q.insert.run({ id, offer_id: root.id, kind, origin: 'user', reporter: subject, reason, details: JSON.stringify(details), dedupe_key: key, now: store.now() });
            limits.hit('flag', subject);
            if (ip) limits.hit('flag_ip', ip);
            return { flag: q.get.get(id), created: true };
        });
    }

    /** A system flag (inside the caller's transaction): opened once per key, details refreshed. */
    function raise({ kind, offerId, key, reason, details }) {
        const open = q.openByKey.get(key);
        if (open) { q.touch.run(JSON.stringify(details || {}), reason || null, store.now(), open.id); return { flag: q.get.get(open.id), created: false }; }
        const id = newId('dfl');
        q.insert.run({ id, offer_id: offerId, kind, origin: 'system', reporter: null, reason: reason || null, details: JSON.stringify(details || {}), dedupe_key: key, now: store.now() });
        return { flag: q.get.get(id), created: true };
    }

    function resolve(viewer, flagId, { status = 'resolved', resolution } = {}) {
        if (!access.isModerator(viewer, 'deals.offer.moderate')) throw new ApiError(403, 'moderation.forbidden', 'Moderators only');
        if (!['resolved', 'dismissed'].includes(status)) throw new ApiError(422, 'request.invalid', 'status must be resolved or dismissed');
        const f = q.get.get(String(flagId || ''));
        if (!f) throw new ApiError(404, 'flag.not_found', 'No such flag');
        if (f.status !== 'open') return { flag: f, changed: false };
        const actor = viewer.subject || viewer.service;
        return store.tx(() => {
            q.resolve.run(status, actor, store.now(), text(resolution, { max: 300 }), store.now(), f.id);
            logAction(`flag.${status === 'resolved' ? 'resolve' : 'dismiss'}`, { offerId: f.offer_id, actor, reason: resolution || null, before: { flag: f.id, status: 'open' }, after: { status } });
            return { flag: q.get.get(f.id), changed: true };
        });
    }

    function dto(f) {
        const offer = f.offer_id ? reads.get(f.offer_id) : null;
        return {
            id: f.id, kind: f.kind, origin: f.origin, reporter: f.reporter, reason: f.reason, status: f.status,
            details: JSON.parse(f.details || '{}'), created_at: iso(f.created_at), updated_at: iso(f.updated_at),
            resolved_by: f.resolved_by, resolved_at: iso(f.resolved_at), resolution: f.resolution,
            offer: offer ? { id: offer.id, slug: offer.slug, title: offer.title, url: publication.abs(publication.offerPath(offer)) } : null,
        };
    }

    return {
        report, raise, resolve, dto, USER_KINDS,
        list: ({ status = 'open', limit = 100, offset = 0 } = {}) => q.list.all(status, limit, offset),
        forOffer: (ids) => q.forOffer.all(JSON.stringify(ids)),
    };
}

module.exports = { createFlags, USER_KINDS };
