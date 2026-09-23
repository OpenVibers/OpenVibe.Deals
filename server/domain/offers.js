'use strict';

/**
 * Offer writes: submission, edits, observations, expiry, moderation (disable / enable / review) and
 * duplicate resolution (merge / unmerge). Every write is one SQLite transaction that also writes its
 * events (outbox), its Search documents and, for observations, its watch notifications.
 *
 * Prices are never edited in place. A price, shipping cost, condition or availability is an
 * observation row (deal_price_observations) with its source and observed_at; "the price" of an
 * offer is always "the latest observation, as of its time".
 *
 * Merge B into A: B.merged_into = A. Nothing is copied, moved or deleted, so votes, observations,
 * sources and comments all stay where they were written; A's pages read across the group. Unmerge
 * clears the pointer. Both are moderator actions, recorded in moderation_log with the vote tallies
 * before and after.
 */
const {
    ApiError, newId, normalizeUrl, urlKey, domainOf, slugify, parseAmount, parseCurrency, parseEnum, parseInstant,
    text, longText, CONDITIONS, AVAILABILITY,
} = require('./util');

const FUTURE_SKEW_MS = 5 * 60 * 1000;

function actorOf(viewer) {
    if (!viewer) return null;
    if (viewer.kind === 'service') return viewer.subject || viewer.service;
    return viewer.subject || null;
}

function createOffers(deps) {
    const { config, store, reads, catalog, publication, indexing, hotness, watches, limits, access, community = null } = deps;
    const { db } = store;
    const q = {
        byUrl: db.prepare("SELECT * FROM deal_offers WHERE url_norm = ? AND status <> 'disabled' ORDER BY created_at LIMIT 1"),
        insertOffer: db.prepare(`INSERT INTO deal_offers (id, slug, title, description, url, url_norm, store_id, product_id, category, origin, submitted_by,
                                     text_origin, review_state, ai_summary, status, expires_at, created_at, updated_at)
                                 VALUES (@id, @slug, @title, @description, @url, @url_norm, @store_id, @product_id, @category, @origin, @submitted_by,
                                     @text_origin, @review_state, @ai_summary, 'active', @expires_at, @now, @now)`),
        insertSource: db.prepare(`INSERT INTO deal_offer_sources (id, offer_id, kind, ref_service, ref_type, ref_id, ref_part, ref_revision, source_key, url, label,
                                      license_note, submitted_by, retrieved_at, created_at, updated_at)
                                  VALUES (@id, @offer_id, @kind, @ref_service, @ref_type, @ref_id, @ref_part, @ref_revision, @source_key, @url, @label,
                                      @license_note, @submitted_by, @retrieved_at, @now, @now)`),
        sourceByRef: db.prepare('SELECT * FROM deal_offer_sources WHERE kind = ? AND ref_service = ? AND ref_id = ? AND ref_part = ?'),
        insertObs: db.prepare(`INSERT INTO deal_price_observations (id, offer_id, source_id, observed_at, recorded_at, price, price_num, currency, shipping,
                                   shipping_num, shipping_note, condition, availability, origin, observed_by, source_revision, note)
                               VALUES (@id, @offer_id, @source_id, @observed_at, @recorded_at, @price, @price_num, @currency, @shipping,
                                   @shipping_num, @shipping_note, @condition, @availability, @origin, @observed_by, @source_revision, @note)`),
        obs: db.prepare('SELECT * FROM deal_price_observations WHERE id = ?'),
        log: db.prepare('INSERT INTO moderation_log (action, offer_id, target_id, actor, reason, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        logFor: db.prepare(`SELECT * FROM moderation_log WHERE offer_id IN (SELECT value FROM json_each(?)) OR target_id IN (SELECT value FROM json_each(?)) ORDER BY id`),
        dueExpiry: db.prepare("SELECT * FROM deal_offers WHERE status = 'active' AND merged_into IS NULL AND expires_at IS NOT NULL AND expires_at <= ?"),
    };

    // ── helpers ─────────────────────────────────────────────

    /** Stated observation fields. A price needs its currency; nothing is defaulted. */
    function parseObservation(input = {}) {
        const price = parseAmount(input.price, 'price');
        const shipping = parseAmount(input.shipping, 'shipping');
        const currency = parseCurrency(input.currency);
        if ((price || shipping) && !currency) throw new ApiError(422, 'request.invalid', 'a price or shipping cost needs its currency (e.g. USD); Deals never assumes one');
        return {
            price: price ? price.text : null, price_num: price ? price.num : null,
            currency,
            shipping: shipping ? shipping.text : null, shipping_num: shipping ? shipping.num : null,
            shipping_note: text(input.shipping_note, { field: 'shipping_note', max: 200 }),
            condition: parseEnum(input.condition, CONDITIONS, 'condition'),
            availability: parseEnum(input.availability, AVAILABILITY, 'availability'),
            note: text(input.note, { field: 'note', max: 300 }),
        };
    }

    function logAction(action, { offerId = null, targetId = null, actor, reason = null, before = null, after = null }) {
        q.log.run(action, offerId, targetId, actor || 'svc:deals', reason, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, store.now());
    }

    function ensureSource(offerId, s) {
        const part = s.ref_part || '';
        const existing = q.sourceByRef.get(s.kind, s.ref_service, s.ref_id, part);
        if (existing) return existing;
        const row = {
            id: newId('dos'), offer_id: offerId, kind: s.kind, ref_service: s.ref_service, ref_type: s.ref_type, ref_id: s.ref_id, ref_part: part,
            ref_revision: s.ref_revision == null ? null : s.ref_revision, source_key: s.source_key || null, url: s.url || null, label: s.label || null,
            license_note: s.license_note || null, submitted_by: s.submitted_by || null, retrieved_at: s.retrieved_at == null ? null : s.retrieved_at, now: store.now(),
        };
        q.insertSource.run(row);
        return q.sourceByRef.get(s.kind, s.ref_service, s.ref_id, part);
    }

    /** Insert one observation and run the watch matcher. Inside the caller's transaction. */
    function recordObservation(offerId, sourceId, fields, { origin, observedBy = null, observedAt, sourceRevision = null }) {
        const now = store.now();
        if (!Number.isFinite(observedAt)) throw new ApiError(422, 'request.invalid', 'an observation needs the time it was observed');
        if (observedAt > now + FUTURE_SKEW_MS) throw new ApiError(422, 'request.invalid', 'observed_at is in the future');
        const row = {
            id: newId('dpo'), offer_id: offerId, source_id: sourceId, observed_at: Math.min(observedAt, now), recorded_at: now,
            price: fields.price, price_num: fields.price_num, currency: fields.currency, shipping: fields.shipping, shipping_num: fields.shipping_num,
            shipping_note: fields.shipping_note || null, condition: fields.condition || null, availability: fields.availability || null,
            origin, observed_by: observedBy, source_revision: sourceRevision, note: fields.note || null,
        };
        q.insertObs.run(row);
        const obs = q.obs.get(row.id);
        watches.onObservation(obs);
        return obs;
    }

    function insertOffer(f) {
        const id = newId('dof');
        q.insertOffer.run({
            id, slug: slugify(f.title, id), title: f.title, description: f.description || null, url: f.url, url_norm: urlKey(f.url),
            store_id: f.store_id || null, product_id: f.product_id || null, category: f.category || null, origin: f.origin,
            submitted_by: f.submitted_by || null, text_origin: f.text_origin || 'human', review_state: f.review_state || 'not_required',
            ai_summary: f.ai_summary || null, expires_at: f.expires_at == null ? null : f.expires_at, now: store.now(),
        });
        return reads.get(id);
    }

    const findByUrl = (url) => { const hit = q.byUrl.get(urlKey(url)); return hit ? reads.root(hit) : null; };

    function mustRoot(idOrSlug) { return reads.root(reads.mustFind(idOrSlug)); }

    function tallies(root) { return reads.tally(reads.groupIds(root.id)); }

    // ── submission ──────────────────────────────────────────

    function submit(viewer, input = {}, { ip = null, traceparent } = {}) {
        const subject = viewer && viewer.subject;
        if (!subject) throw new ApiError(401, 'auth.required', 'Sign in to submit a deal');
        const url = normalizeUrl(input.url);
        if (!url) throw new ApiError(422, 'request.invalid', 'url must be an http(s) link to the offer');
        const title = text(input.title, { field: 'title', min: 3, max: 200, required: true });
        const description = longText(input.description, 4000);
        const obs = parseObservation(input);
        const expiresAt = parseInstant(input.expires_at, 'expires_at');
        if (expiresAt != null && expiresAt <= store.now()) throw new ApiError(422, 'request.invalid', 'expires_at is already in the past');
        const ai = viewer.kind === 'service' && viewer.origin === 'ai';
        return store.tx(() => {
            limits.check('submit', subject, config.abuse.submitPerDay, 24 * 3600 * 1000, 'submit.rate_limited');
            const dup = findByUrl(url);
            if (dup) throw new ApiError(409, 'offer.duplicate', 'This link has already been posted', { existing: { id: dup.id, slug: dup.slug, url: publication.abs(publication.offerPath(dup)) } });
            const st = catalog.ensureStore(domainOf(url), text(input.store_name, { max: 120 }));
            let product = null;
            const p = input.product && typeof input.product === 'object' ? input.product : null;
            if (input.product_slug) {
                product = catalog.productBySlug(input.product_slug);
                if (!product) throw new ApiError(404, 'product.not_found', 'No such product');
            } else if (p && (p.name || p.gtin || p.mpn || p.sku)) {
                product = catalog.resolve(p, { source: 'community', actor: subject }).product;
            }
            const offer = insertOffer({
                title, description, url, store_id: st ? st.id : null, product_id: product ? product.id : null,
                category: text(input.category, { max: 60 }), origin: 'community', submitted_by: subject,
                text_origin: ai ? 'ai' : 'human', review_state: ai ? 'pending' : 'not_required', expires_at: expiresAt,
            });
            const src = ensureSource(offer.id, { kind: 'submission', ref_service: 'deals', ref_type: 'submission', ref_id: offer.id, url, submitted_by: subject });
            limits.hit('submit', subject);
            if (ip) limits.hit('submit_ip', ip);
            hotness.snapshot(offer.id, 'create');
            recordObservation(offer.id, src.id, obs, { origin: 'community', observedBy: subject, observedAt: store.now() });
            indexing.emitOffer('deals.offer.created', offer, { actor: subject, traceparent });
            indexing.reindex(reads.get(offer.id));
            return { offer: reads.get(offer.id), created: true };
        });
    }

    /** Created by the Sources importer (no person); text is third-party and waits for review. */
    function createImported(f, source, obsFields, { observedAt, sourceRevision }) {
        const st = catalog.ensureStore(domainOf(f.url), f.store_name || null);
        const offer = insertOffer({
            title: f.title, description: f.description, url: f.url, store_id: st ? st.id : null, product_id: f.product_id || null,
            category: f.category || null, origin: 'import', submitted_by: null, text_origin: 'imported', review_state: 'pending',
            expires_at: f.expires_at == null ? null : f.expires_at,
        });
        const src = ensureSource(offer.id, source);
        hotness.snapshot(offer.id, 'create');
        recordObservation(offer.id, src.id, obsFields, { origin: 'import', observedAt, sourceRevision });
        indexing.emitOffer('deals.offer.created', offer, { actor: 'svc:deals', extra: { imported_from: { service: 'sources', type: 'item', id: source.ref_id } } });
        indexing.reindex(reads.get(offer.id));
        return reads.get(offer.id);
    }

    // ── edits and observations ──────────────────────────────

    function update(viewer, idOrSlug, input = {}, { traceparent } = {}) {
        const root = mustRoot(idOrSlug);
        const actor = actorOf(viewer);
        if (!access.canEdit(viewer, root)) throw new ApiError(403, 'offer.forbidden', 'Only the person who submitted this deal or a moderator can edit it');
        if (root.status === 'disabled') throw new ApiError(409, 'offer.disabled', 'This deal was removed by moderators');
        const changes = {};
        if (input.title !== undefined) changes.title = text(input.title, { field: 'title', min: 3, max: 200, required: true });
        if (input.description !== undefined) changes.description = longText(input.description, 4000);
        if (input.category !== undefined) changes.category = text(input.category, { max: 60 });
        if (input.expires_at !== undefined) {
            const t = parseInstant(input.expires_at, 'expires_at');
            if (t != null && t <= store.now()) throw new ApiError(422, 'request.invalid', 'expires_at is already in the past (expire the deal instead)');
            changes.expires_at = t;
        }
        const ai = viewer.kind === 'service' && viewer.origin === 'ai';
        if (input.ai_summary !== undefined) {
            if (!ai) throw new ApiError(422, 'request.invalid', 'ai_summary is written only by OpenVibe.AI (X-OV-Origin: ai)');
            changes.ai_summary = longText(input.ai_summary, 2000);
            changes.review_state = 'pending';
        } else if (ai && (changes.title || changes.description)) {
            changes.text_origin = 'ai';
            changes.review_state = 'pending';
        }
        return store.tx(() => {
            if (input.product_slug !== undefined || input.product !== undefined) {
                if (!input.product_slug && !input.product) changes.product_id = null;
                else if (input.product_slug) {
                    const p = catalog.productBySlug(input.product_slug);
                    if (!p) throw new ApiError(404, 'product.not_found', 'No such product');
                    changes.product_id = p.id;
                } else changes.product_id = catalog.resolve(input.product, { source: 'community', actor }).product.id;
            }
            const keys = Object.keys(changes);
            if (!keys.length) return { offer: root, changed: false };
            const oldProduct = root.product_id;
            db.prepare(`UPDATE deal_offers SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...changes, now: store.now(), id: root.id });
            const after = reads.get(root.id);
            indexing.emitOffer('deals.offer.updated', after, { actor, extra: { changed: keys }, traceparent });
            indexing.reindex(after);
            if (oldProduct && oldProduct !== after.product_id) indexing.indexProduct(catalog.product(oldProduct));
            return { offer: after, changed: true };
        });
    }

    /** A person (or a service acting for one) reports what they see at the link right now. */
    function observe(viewer, idOrSlug, input = {}, { ip = null, traceparent } = {}) {
        const subject = viewer && viewer.subject;
        if (!subject) throw new ApiError(401, 'auth.required', 'Sign in to report a price');
        const root = mustRoot(idOrSlug);
        if (root.status === 'disabled') throw new ApiError(409, 'offer.disabled', 'This deal was removed by moderators');
        const fields = parseObservation(input);
        if (fields.price == null && fields.shipping == null && !fields.availability && !fields.condition) {
            throw new ApiError(422, 'request.invalid', 'state at least a price, shipping cost, availability or condition');
        }
        let observedAt = store.now();
        if (viewer.kind === 'service' && input.observed_at != null) observedAt = parseInstant(input.observed_at, 'observed_at');
        return store.tx(() => {
            limits.check('observe', subject, config.abuse.observePerHour, 3600 * 1000, 'observe.rate_limited');
            const src = ensureSource(root.id, { kind: 'community', ref_service: 'deals', ref_type: 'observer', ref_id: subject, ref_part: root.id, url: root.url, submitted_by: subject });
            const obs = recordObservation(root.id, src.id, fields, { origin: 'community', observedBy: subject, observedAt });
            limits.hit('observe', subject);
            if (ip) limits.hit('observe_ip', ip);
            db.prepare('UPDATE deal_offers SET updated_at = ? WHERE id = ?').run(store.now(), root.id);
            indexing.emitOffer('deals.offer.updated', root, { actor: subject, extra: { changed: ['observation'], observation_id: obs.id }, traceparent });
            indexing.reindex(reads.get(root.id));
            return { offer: reads.get(root.id), observation: obs };
        });
    }

    // ── expiry and moderation ───────────────────────────────

    function expireRow(root, { actor, reason, traceparent }) {
        const now = store.now();
        db.prepare("UPDATE deal_offers SET status = 'expired', expired_at = ?, expired_reason = ?, updated_at = ? WHERE id = ?").run(now, reason, now, root.id);
        logAction('expire', { offerId: root.id, actor: actor || 'svc:deals', reason, before: { status: root.status }, after: { status: 'expired' } });
        const after = reads.get(root.id);
        indexing.emitOffer('deals.offer.expired', after, { actor, extra: { reason }, traceparent });
        indexing.reindex(after);
        return after;
    }

    function expire(viewer, idOrSlug, { reason } = {}, { traceparent } = {}) {
        const root = mustRoot(idOrSlug);
        if (!access.canEdit(viewer, root)) throw new ApiError(403, 'offer.forbidden', 'Only the person who submitted this deal or a moderator can mark it expired');
        if (root.status !== 'active') throw new ApiError(409, 'offer.not_active', `This deal is ${root.status}`);
        const why = access.isStaff(viewer) ? `moderator${reason ? `: ${text(reason, { max: 200 })}` : ''}` : 'submitter';
        return store.tx(() => expireRow(root, { actor: actorOf(viewer), reason: why, traceparent }));
    }

    /** Worker: offers whose STATED expiry has passed. Unknown expiry is never assumed. */
    function expireDue() {
        const due = q.dueExpiry.all(store.now());
        store.tx(() => { for (const o of due) expireRow(o, { actor: null, reason: 'stated_expiry' }); });
        return due.length;
    }

    function requireStaff(viewer, cap) {
        if (!access.isModerator(viewer, cap)) throw new ApiError(403, 'moderation.forbidden', 'Moderators only');
    }

    function disable(viewer, idOrSlug, { reason } = {}, { traceparent } = {}) {
        requireStaff(viewer, 'deals.offer.moderate');
        const root = mustRoot(idOrSlug);
        const why = text(reason, { field: 'reason', min: 3, max: 300, required: true });
        if (root.status === 'disabled') return { offer: root, changed: false };
        const out = store.tx(() => {
            const now = store.now();
            db.prepare("UPDATE deal_offers SET status = 'disabled', disabled_at = ?, disabled_reason = ?, disabled_by = ?, updated_at = ? WHERE id = ?").run(now, why, actorOf(viewer), now, root.id);
            logAction('disable', { offerId: root.id, actor: actorOf(viewer), reason: why, before: { status: root.status }, after: { status: 'disabled' } });
            const after = reads.get(root.id);
            indexing.emitOffer('deals.offer.updated', after, { actor: actorOf(viewer), extra: { changed: ['status'], moderation: 'disabled' }, traceparent });
            indexing.reindex(after);
            return { offer: after, changed: true };
        });
        threadVisibility(out.offer, 'hidden');
        return out;
    }

    /** After commit, best effort: a disabled offer's Community thread is hidden, and shown again on enable. */
    function threadVisibility(offer, visibility) {
        if (community && community.enabled) community.setThreadVisibility(offer, visibility).catch(() => {});
    }

    function enable(viewer, idOrSlug, { reason } = {}, { traceparent } = {}) {
        requireStaff(viewer, 'deals.offer.moderate');
        const root = mustRoot(idOrSlug);
        if (root.status === 'active') return { offer: root, changed: false };
        const wasDisabled = root.status === 'disabled';
        const out = store.tx(() => {
            const now = store.now();
            const keepExpiry = root.expires_at != null && root.expires_at > now ? root.expires_at : null;
            db.prepare(`UPDATE deal_offers SET status = 'active', disabled_at = NULL, disabled_reason = NULL, disabled_by = NULL,
                        expired_at = NULL, expired_reason = NULL, expires_at = ?, updated_at = ? WHERE id = ?`).run(keepExpiry, now, root.id);
            logAction('enable', { offerId: root.id, actor: actorOf(viewer), reason: text(reason, { max: 300 }), before: { status: root.status, disabled_reason: root.disabled_reason, expired_reason: root.expired_reason, expires_at: root.expires_at }, after: { status: 'active', expires_at: keepExpiry } });
            const after = reads.get(root.id);
            indexing.emitOffer('deals.offer.updated', after, { actor: actorOf(viewer), extra: { changed: ['status'], moderation: 'enabled' }, traceparent });
            indexing.reindex(after);
            return { offer: after, changed: true };
        });
        if (wasDisabled) threadVisibility(out.offer, 'public');
        return out;
    }

    /** A person confirms imported or AI-assisted text (only a usr_ subject can review). */
    function review(viewer, idOrSlug, { note } = {}, { traceparent } = {}) {
        requireStaff(viewer, 'deals.offer.moderate');
        const reviewer = viewer.subject;
        if (!reviewer) throw new ApiError(403, 'review.person_required', 'A review is recorded for a person (usr_…), never for a service');
        const root = mustRoot(idOrSlug);
        if (root.review_state !== 'pending') return { offer: root, changed: false };
        return store.tx(() => {
            const now = store.now();
            db.prepare("UPDATE deal_offers SET review_state = 'reviewed', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?").run(reviewer, now, now, root.id);
            logAction('review', { offerId: root.id, actor: reviewer, reason: text(note, { max: 300 }), before: { review_state: 'pending' }, after: { review_state: 'reviewed' } });
            const after = reads.get(root.id);
            indexing.emitOffer('deals.offer.updated', after, { actor: reviewer, extra: { changed: ['review_state'] }, traceparent });
            indexing.reindex(after);
            return { offer: after, changed: true };
        });
    }

    function merge(viewer, idOrSlug, intoIdOrSlug, { reason } = {}, { traceparent } = {}) {
        requireStaff(viewer, 'deals.offer.merge');
        const dup = reads.mustFind(idOrSlug);
        const target = reads.root(reads.mustFind(intoIdOrSlug));
        if (dup.merged_into) throw new ApiError(409, 'offer.already_merged', 'This offer is already merged; unmerge it first');
        if (reads.groupIds(dup.id).includes(target.id)) throw new ApiError(409, 'offer.merge_cycle', 'Cannot merge an offer into itself or into an offer merged into it');
        const actor = actorOf(viewer);
        return store.tx(() => {
            const before = { target: tallies(target), duplicate: tallies(dup) };
            const now = store.now();
            db.prepare('UPDATE deal_offers SET merged_into = ?, merged_at = ?, merged_by = ?, updated_at = ? WHERE id = ?').run(target.id, now, actor, now, dup.id);
            const after = { target: tallies(target) };
            logAction('merge', { offerId: dup.id, targetId: target.id, actor, reason: text(reason, { max: 300 }), before, after });
            hotness.snapshot(target.id, 'merge');
            indexing.emitOffer('deals.offer.updated', target, { actor, extra: { changed: ['merged'], merged_offer_id: dup.id }, traceparent });
            indexing.indexOffer(reads.get(dup.id));
            indexing.reindex(reads.get(target.id));
            if (dup.product_id && dup.product_id !== target.product_id) indexing.indexProduct(catalog.product(dup.product_id));
            return { offer: reads.get(target.id), merged: reads.get(dup.id), before, after };
        });
    }

    function unmerge(viewer, idOrSlug, { reason } = {}, { traceparent } = {}) {
        requireStaff(viewer, 'deals.offer.merge');
        const dup = reads.mustFind(idOrSlug);
        if (!dup.merged_into) throw new ApiError(409, 'offer.not_merged', 'This offer is not merged');
        const parentRoot = reads.root(dup);
        const actor = actorOf(viewer);
        return store.tx(() => {
            const before = { target: tallies(parentRoot) };
            const now = store.now();
            db.prepare('UPDATE deal_offers SET merged_into = NULL, merged_at = NULL, merged_by = NULL, updated_at = ? WHERE id = ?').run(now, dup.id);
            const restored = reads.get(dup.id);
            const after = { target: tallies(parentRoot), duplicate: tallies(restored) };
            logAction('unmerge', { offerId: dup.id, targetId: parentRoot.id, actor, reason: text(reason, { max: 300 }), before, after });
            hotness.snapshot(parentRoot.id, 'unmerge');
            hotness.snapshot(restored.id, 'unmerge');
            indexing.emitOffer('deals.offer.updated', parentRoot, { actor, extra: { changed: ['unmerged'], unmerged_offer_id: dup.id }, traceparent });
            indexing.emitOffer('deals.offer.updated', restored, { actor, extra: { changed: ['unmerged'], unmerged_from: parentRoot.id }, traceparent });
            indexing.reindex(reads.get(parentRoot.id));
            indexing.reindex(restored);
            return { offer: restored, from: reads.get(parentRoot.id), before, after };
        });
    }

    function moderationLog(root) {
        const ids = JSON.stringify(reads.groupIds(root.id));
        return q.logFor.all(ids, ids);
    }

    return {
        submit, createImported, update, observe, expire, expireDue, disable, enable, review, merge, unmerge,
        recordObservation, ensureSource, parseObservation, findByUrl, moderationLog, logAction, actorOf,
    };
}

module.exports = { createOffers, actorOf };
