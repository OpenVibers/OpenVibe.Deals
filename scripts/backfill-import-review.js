#!/usr/bin/env node
'use strict';

/**
 * The automatic review of the offers imported before it existed (server/domain/import-review.js).
 *
 * The same checks the importer runs now, over the offers still waiting for a person's review:
 * an offer from a configured feed source passes when its link is https and points at that source's
 * retailer domain, its title is present and short, its price is a positive number with a currency,
 * it has not expired and it states no blocked term. A pass sets review_state = 'auto_approved'
 * (published, indexable, reviewed by 'system:import-checks'); a fail stays pending with the failed
 * check's name on the offer.
 *
 *   node scripts/backfill-import-review.js --dry-run      # counts only, nothing is written
 *   node scripts/backfill-import-review.js                 # in batches of 500
 *   node scripts/backfill-import-review.js --batch-size 500 --limit 1000 --no-reindex
 *
 * It prints counts only (passed, failed per check) — never an offer's content. It is idempotent:
 * an offer that passed is not pending any more, and an offer that failed is checked again and
 * fails the same way.
 */

const configLib = require('../server/config');
const { openStore } = require('../server/db');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createReads } = require('../server/domain/reads');
const { createCatalog } = require('../server/domain/catalog');
const { createPublication } = require('../server/domain/publication');
const { createIndexing } = require('../server/domain/indexing');
const { evaluateImport, retailerDomainsFor, CHECKS } = require('../server/domain/import-review');

const AUTO_REVIEWER = 'system:import-checks';

function arg(name, def) {
    const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return def;
    if (hit.includes('=')) return hit.split('=').slice(1).join('=');
    const next = process.argv[process.argv.indexOf(hit) + 1];
    return next && !next.startsWith('--') ? next : true;
}

const BATCH = Math.max(1, parseInt(arg('batch-size', 500), 10) || 500);
const LIMIT = arg('limit', null) ? Math.max(0, parseInt(arg('limit', 0), 10) || 0) : null;
const DRY = Boolean(arg('dry-run', false));
const REINDEX = !arg('no-reindex', false);

const BATCH_SQL = `SELECT f.id, f.title, f.description, f.url, f.expires_at, f.status, s.source_key, o.price_num, o.currency
  FROM deal_offers f
  JOIN LATERAL (SELECT source_key FROM deal_offer_sources WHERE offer_id = f.id AND kind = 'sources_item' AND removed_at IS NULL ORDER BY id LIMIT 1) s ON TRUE
  LEFT JOIN LATERAL (SELECT price_num, currency FROM deal_price_observations WHERE offer_id = f.id ORDER BY observed_at DESC, seq DESC LIMIT 1) o ON TRUE
 WHERE f.origin = 'import' AND f.review_state = 'pending' AND f.id > ?
 ORDER BY f.id
 LIMIT ?`;

(async () => {
    const config = configLib.load();
    if (!config.importReview || !config.importReview.enabled) {
        console.log(JSON.stringify({ error: 'the automatic review is off (DEALS_IMPORT_REVIEW=off)' }));
        process.exit(1);
    }
    const log = { log() {}, warn: (...a) => console.error(...a), error: (...a) => console.error(...a) };
    const store = await openStore(config, { log });
    const outbox = createServiceOutbox({
        db: store.db, source: 'deals', eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs, now: store.now, log,
    });
    const reads = createReads({ store });
    const catalog = createCatalog({ store });
    const publication = createPublication({ config, store, reads, catalog });
    const indexing = createIndexing({ config, store, publication, outbox, catalog, indexnow: null });

    const counts = { scanned: 0, passed: 0, failed: 0, skipped_source: 0, reindexed: 0 };
    counts.failed_by_check = Object.fromEntries(CHECKS.map((c) => [c, 0]));
    let cursor = '';
    const now = () => store.now();

    try {
        for (;;) {
            const rows = await store.db.prepare(BATCH_SQL).all(cursor, BATCH);
            if (!rows.length) break;
            for (const row of rows) {
                cursor = row.id;
                counts.scanned++;
                const domains = retailerDomainsFor(config.importReview, row.source_key);
                if (!domains) { counts.skipped_source++; continue; }
                const result = evaluateImport({
                    url: row.url, title: row.title, description: row.description,
                    price_num: row.price_num, currency: row.currency,
                    expires_at: row.expires_at, status: row.status,
                }, { retailerDomains: domains, blockedTerms: config.importReview.blockedTerms, now: now() });
                if (result.ok) {
                    counts.passed++;
                    if (!DRY) {
                        await store.tx(async () => {
                            const at = now();
                            await store.db.prepare("UPDATE deal_offers SET review_state = 'auto_approved', reviewed_by = ?, reviewed_at = ?, review_failed_check = NULL, updated_at = ? WHERE id = ? AND review_state = 'pending'")
                                .run(AUTO_REVIEWER, at, at, row.id);
                            await store.db.prepare('INSERT INTO moderation_log (action, offer_id, target_id, actor, reason, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                                .run('auto_review', row.id, null, AUTO_REVIEWER, 'the import checks passed', JSON.stringify({ review_state: 'pending' }), JSON.stringify({ review_state: 'auto_approved' }), at);
                            if (REINDEX) { await indexing.indexOffer(await reads.get(row.id)); counts.reindexed++; }
                        });
                    }
                } else {
                    counts.failed++;
                    counts.failed_by_check[result.failed] = (counts.failed_by_check[result.failed] || 0) + 1;
                    if (!DRY) {
                        await store.tx(async () => {
                            await store.db.prepare("UPDATE deal_offers SET review_failed_check = ?, updated_at = ? WHERE id = ? AND review_state = 'pending'").run(result.failed, now(), row.id);
                        });
                    }
                }
                if (LIMIT && counts.scanned >= LIMIT) { cursor = '￿'; break; }
            }
            if (LIMIT && counts.scanned >= LIMIT) break;
        }
    } finally {
        if (outbox.stop) await outbox.stop();
        await store.close();
    }
    console.log(JSON.stringify({ dry_run: DRY, batch_size: BATCH, ...counts }));
    process.exit(0);
})().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
