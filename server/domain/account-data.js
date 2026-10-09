'use strict';

/**
 * Account export and deletion → Deals (ADR-033; openvibe-sdk/account-data). What Deals holds about a person:
 *
 *   their own, deleted whole       watches and saved searches (with the notifications they produced), votes (with the
 *                                  ip hash they were cast with), the name cache (subject_projections) and their
 *                                  rate-limit windows
 *   shared catalog, made authorless  offers they submitted, prices they reported, products and aliases they added,
 *                                  reports they filed: other people's votes, watches and price history hang under them,
 *                                  so the rows stay and the person's id becomes NULL. An observer source row is keyed by
 *                                  the person (ref_id), so that key becomes deleted:<row id>; a vote-ring flag's
 *                                  evidence (details.voters) names them as 'deleted'.
 *   kept                           moderation_log: a staff member's merges, expiries and reviews stay attributed, for
 *                                  accountability (counted as retained)
 *
 * The export carries the person's own rows and what they contributed; no secret or other person's data is stored in
 * any of these tables. Staff-only columns (who reviewed, disabled or merged an offer) are made authorless and not
 * exported as the person's contributions.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const anonymize = { anonymize: {} };

const TABLES = [
    { table: 'subject_projections', subject: 'subject', file: 'profile.json', columns: ['subject', 'username', 'display_name', 'first_seen_at', 'refreshed_at'], order: 'refreshed_at' },
    { table: 'deal_votes', subject: 'subject', file: 'votes.json', columns: ['offer_id', 'value', 'via', 'created_at', 'updated_at'] },
    { table: 'deal_offers', subject: 'submitted_by', file: 'offers.json', columns: ['id', 'slug', 'title', 'description', 'url', 'store_id', 'product_id', 'category', 'status', 'expires_at', 'created_at', 'updated_at'], erase: anonymize },
    { table: 'deal_offers', subject: 'reviewed_by', file: null, erase: anonymize },
    { table: 'deal_offers', subject: 'disabled_by', file: null, erase: anonymize },
    { table: 'deal_offers', subject: 'merged_by', file: null, erase: anonymize },
    { table: 'deal_offer_sources', subject: 'submitted_by', file: null, erase: anonymize },
    { table: 'deal_price_observations', subject: 'observed_by', file: 'price-reports.json', columns: ['id', 'offer_id', 'observed_at', 'price', 'currency', 'shipping', 'shipping_note', 'condition', 'availability', 'note'], order: 'observed_at', erase: anonymize },
    { table: 'deal_products', subject: 'created_by', file: 'products.json', columns: ['id', 'slug', 'name', 'brand', 'category', 'description', 'created_at'], erase: anonymize },
    { table: 'deal_product_aliases', subject: 'created_by', file: null, erase: anonymize },
    { table: 'deal_flags', subject: 'reporter', file: 'reports.json', columns: ['id', 'offer_id', 'kind', 'reason', 'status', 'created_at'], erase: anonymize },
    { table: 'deal_flags', subject: 'resolved_by', file: null, erase: anonymize },
    { table: 'moderation_log', subject: 'actor', file: null, erase: { keep: 'staff moderation actions stay attributed for accountability' } },
    { table: 'rate_events', subject: 'key', file: null },
];

/** Watches go here, not in TABLES: their notifications reference them, so those are deleted first. */
async function extraExport(db, subject) {
    const rows = await db.many(`SELECT id, kind, query, product_id, max_price, currency, notify, label, created_at, deleted_at
        FROM deal_watches WHERE subject = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    return rows.length ? [{ name: 'watches.json', content: rows }] : [];
}

async function extraErase(t, subjects, counts) {
    counts.add(counts.erased, 'watch_notifications', await t.exec(`DELETE FROM watch_notifications
        WHERE watch_id IN (SELECT id FROM deal_watches WHERE subject = ANY($1::text[]))`, [subjects]));
    counts.add(counts.erased, 'deal_watches', await t.exec('DELETE FROM deal_watches WHERE subject = ANY($1::text[])', [subjects]));
    // An observer source is keyed by the person (UNIQUE (kind, ref_service, ref_id, ref_part)): the key becomes the row's own.
    counts.add(counts.retained, 'tombstones', await t.exec(`UPDATE deal_offer_sources SET ref_id = 'deleted:' || id
        WHERE ref_type = 'observer' AND ref_id = ANY($1::text[])`, [subjects]));
    // A vote-ring flag names its voters as evidence (details.voters, details.shared_offers): the person's votes are gone,
    // so their id leaves the evidence too and the flag stays for moderators.
    const flagged = await t.many(`SELECT id, details FROM deal_flags WHERE kind = 'vote_ring'
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) s WHERE deal_flags.details LIKE '%' || s || '%')`, [subjects]);
    for (const f of flagged) {
        let d;
        try { d = JSON.parse(f.details || '{}'); } catch { continue; }
        if (Array.isArray(d.voters)) d.voters = d.voters.map((v) => (subjects.includes(v) ? 'deleted' : v));
        if (d.shared_offers && typeof d.shared_offers === 'object') for (const s of subjects) delete d.shared_offers[s];
        counts.add(counts.retained, 'tombstones', await t.exec('UPDATE deal_flags SET details = $1 WHERE id = $2', [JSON.stringify(d), f.id]));
    }
}

/** The account-data handle for Deals' database (server/db.js, store.db). */
function create({ db, log = console } = {}) {
    return createAccountData({
        db, service: 'deals', tables: TABLES, extraExport, extraErase, log,
        note: 'Offers, price reports, products and reports you contributed stay in the shared catalog without your name.',
    });
}

module.exports = { create, TABLES, TOPICS };
