'use strict';

/**
 * Imports deals-category items from OpenVibe.Sources.
 *
 * The truth is Sources' change feed (GET /api/v1/items?category=deals&after=<cursor>): the importer
 * pulls pages in change order and keeps its cursor in import_state. sources.item.* events delivered
 * to /internal/events only wake the pull early (they carry no prices), so a lost or repeated event
 * changes nothing.
 *
 * Item → offer mapping (values exactly as the source stated them; missing = null):
 *   kind offer    one offer: fields.price + fields.currency, availability / condition (schema.org
 *                 terms mapped to Deals' enums, unknown terms → null), valid_until → stated expiry,
 *                 seller → store name
 *   kind product  a product (resolved by gtin / mpn / sku / name) and one offer per stated offer
 *   kind article  (RSS/Atom) one offer with the title and link; the price is NOT parsed out of the
 *                 headline — it stays "not stated" until a structured source or a person states it
 *   other kinds   skipped
 *
 * observed_at = the item's provenance.retrieved_at (when Sources saw it). An item Deals already
 * imported produces a new observation only when its revision or its retrieved_at advanced, so
 * replays are no-ops. Two items (or a submission and an item) with the same link attach to the same
 * offer as separate sources. A removed item (takedown, licence) removes its source; an imported
 * offer left with no source is disabled.
 *
 * Imported text is third-party: review_state = pending, so the page is noindex until a person
 * reviews it.
 */
const {
    normalizeUrl, urlKey, parseAmount, SCHEMA_AVAILABILITY, SCHEMA_CONDITION, iso,
} = require('./util');

const CURSOR_KEY = 'sources.deals.after';

function createImporter({ config, store, reads, catalog, offers, indexing, sources, log = console }) {
    const { db } = store;
    const q = {
        getState: db.prepare('SELECT value FROM import_state WHERE key = ?'),
        setState: db.prepare(`INSERT INTO import_state (key, value, updated_at) VALUES (?, ?, ?)
                              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
        sourceRow: db.prepare("SELECT * FROM deal_offer_sources WHERE kind = 'sources_item' AND ref_service = 'sources' AND ref_id = ? AND ref_part = ?"),
        itemRows: db.prepare("SELECT * FROM deal_offer_sources WHERE kind = 'sources_item' AND ref_service = 'sources' AND ref_id = ? AND removed_at IS NULL"),
        bumpSource: db.prepare('UPDATE deal_offer_sources SET ref_revision = ?, retrieved_at = ?, label = COALESCE(?, label), updated_at = ? WHERE id = ?'),
        removeSource: db.prepare('UPDATE deal_offer_sources SET removed_at = ?, removed_reason = ?, updated_at = ? WHERE id = ?'),
        liveSources: db.prepare('SELECT COUNT(*) AS n FROM deal_offer_sources WHERE offer_id = ? AND removed_at IS NULL'),
        refreshDue: db.prepare(`SELECT s.ref_id, MAX(o.observed_at) AS last FROM deal_offer_sources s
                                  JOIN deal_offers f ON f.id = s.offer_id
                                  JOIN deal_price_observations o ON o.source_id = s.id
                                 WHERE s.kind = 'sources_item' AND s.removed_at IS NULL AND f.status = 'active'
                                 GROUP BY s.ref_id HAVING last < ? ORDER BY last LIMIT ?`),
    };
    let lastError = null;
    let lastRunAt = null;
    let running = null;
    let kickTimer = null;

    const cursor = () => Number((q.getState.get(CURSOR_KEY) || {}).value || 0);

    function amount(v) { try { return parseAmount(v, 'price'); } catch { return null; } }
    function currencyOf(v) { return typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null; }

    /** Stated fields → observation fields. A malformed value is null, never repaired or guessed. */
    function obsFields(f = {}) {
        const price = amount(f.price);
        return {
            price: price ? price.text : null, price_num: price ? price.num : null, currency: currencyOf(f.currency),
            shipping: null, shipping_num: null, shipping_note: null,
            condition: SCHEMA_CONDITION[f.condition] || null,
            availability: SCHEMA_AVAILABILITY[f.availability] || null,
        };
    }

    function candidates(item) {
        const f = item.fields || {};
        const stated = (t) => { const ms = t ? Date.parse(t) : NaN; return Number.isFinite(ms) ? ms : null; };
        if (item.kind === 'offer') {
            const url = normalizeUrl(f.url || item.canonical_url);
            if (!url || !item.title) return [];
            return [{ part: '', url, title: item.title, description: item.summary, obs: obsFields(f), expires_at: stated(f.valid_until), store_name: f.seller || null }];
        }
        if (item.kind === 'product') {
            if (!item.title) return [];
            const seen = new Set();
            const out = [];
            for (const o of (Array.isArray(f.offers) ? f.offers : []).slice(0, 20)) {
                const url = normalizeUrl(o.url || item.canonical_url);
                if (!url || seen.has(urlKey(url))) continue;
                seen.add(urlKey(url));
                out.push({
                    part: urlKey(url), url, title: o.seller ? `${item.title} — ${o.seller}` : item.title, description: item.summary,
                    obs: obsFields(o), expires_at: stated(o.valid_until), store_name: o.seller || null,
                    product: { name: item.title, brand: f.brand, gtin: f.gtin, mpn: f.mpn, sku: f.sku },
                });
            }
            return out;
        }
        if (item.kind === 'article' || item.kind === 'record') {
            const url = normalizeUrl(item.canonical_url);
            if (!url || !item.title) return [];
            return [{ part: '', url, title: item.title, description: item.summary, obs: obsFields({}), expires_at: null, store_name: null }];
        }
        return [];
    }

    function removeItem(item) {
        const reason = (item.removed && item.removed.reason) || 'removed at the source';
        const rows = q.itemRows.all(item.id);
        for (const s of rows) q.removeSource.run(store.now(), reason, store.now(), s.id);
        const touched = [...new Set(rows.map((s) => s.offer_id))];
        for (const id of touched) {
            const offer = reads.get(id);
            if (offer.origin === 'import' && offer.status !== 'disabled' && q.liveSources.get(id).n === 0) {
                const now = store.now();
                db.prepare("UPDATE deal_offers SET status = 'disabled', disabled_at = ?, disabled_reason = ?, disabled_by = 'svc:deals', updated_at = ? WHERE id = ?")
                    .run(now, `source item removed: ${reason}`, now, id);
                offers.logAction('disable', { offerId: id, actor: 'svc:deals', reason: `source item removed: ${reason}`, before: { status: offer.status }, after: { status: 'disabled' } });
            }
            const after = reads.get(id);
            indexing.emitOffer('deals.offer.updated', after, { actor: 'svc:deals', extra: { changed: ['sources'], source_removed: item.id } });
            indexing.reindex(after);
        }
        return touched.length ? 'removed' : 'removed:unknown';
    }

    /** One item, inside a transaction. Returns what happened (for logs and tests). */
    function importItem(item) {
        if (!item || item.category !== 'deals') return 'skipped:category';
        if (item.removed) return removeItem(item);
        const retrievedAt = Date.parse(item.provenance && item.provenance.retrieved_at);
        if (!Number.isFinite(retrievedAt)) return 'skipped:no_observation_time';
        const list = candidates(item);
        if (!list.length) return `skipped:${item.kind}`;
        const outcomes = [];
        for (const c of list) {
            const src = {
                kind: 'sources_item', ref_service: 'sources', ref_type: 'item', ref_id: item.id, ref_part: c.part, ref_revision: item.revision,
                source_key: item.source_key, url: item.canonical_url, label: item.title,
                license_note: item.provenance.license_note || null, retrieved_at: retrievedAt,
            };
            const existing = q.sourceRow.get(item.id, c.part);
            if (existing) {
                const advanced = item.revision > (existing.ref_revision || 0) || retrievedAt > (existing.retrieved_at || 0);
                if (!advanced || existing.removed_at) { outcomes.push('unchanged'); continue; }
                const origin = item.revision > (existing.ref_revision || 0) ? 'import' : 'import_refresh';
                q.bumpSource.run(Math.max(item.revision, existing.ref_revision || 0), Math.max(retrievedAt, existing.retrieved_at || 0), item.title, store.now(), existing.id);
                const obs = offers.recordObservation(existing.offer_id, existing.id, c.obs, { origin, observedAt: retrievedAt, sourceRevision: item.revision });
                const offer = reads.get(existing.offer_id);
                const changed = ['observation'];
                if (origin === 'import' && c.expires_at && offer.status === 'active' && offer.origin === 'import' && c.expires_at !== offer.expires_at) {
                    db.prepare('UPDATE deal_offers SET expires_at = ?, updated_at = ? WHERE id = ?').run(c.expires_at, store.now(), offer.id);
                    changed.push('expires_at');
                }
                // Anything else the observation moved on the offer (price, product) is named too, so consumers never miss a field.
                const after = reads.get(offer.id);
                for (const k of ['product_id', 'title', 'status']) if (after && offer && after[k] !== offer[k] && !changed.includes(k)) changed.push(k);
                indexing.emitOffer('deals.offer.updated', after, { actor: 'svc:deals', extra: { changed, observation_id: obs.id } });
                indexing.reindex(reads.get(offer.id));
                outcomes.push(origin === 'import' ? 'updated' : 'refreshed');
                continue;
            }
            let productId = null;
            if (c.product) {
                try { productId = catalog.resolve(c.product, { source: 'import', actor: 'svc:deals' }).product.id; } catch { productId = null; }
            }
            const dup = offers.findByUrl(c.url);
            if (dup) {
                const s = offers.ensureSource(dup.id, src);
                const obs = offers.recordObservation(dup.id, s.id, c.obs, { origin: 'import', observedAt: retrievedAt, sourceRevision: item.revision });
                if (productId && !dup.product_id) db.prepare('UPDATE deal_offers SET product_id = ?, updated_at = ? WHERE id = ?').run(productId, store.now(), dup.id);
                indexing.emitOffer('deals.offer.updated', reads.get(dup.id), { actor: 'svc:deals', extra: { changed: ['sources'], observation_id: obs.id } });
                indexing.reindex(reads.get(dup.id));
                outcomes.push('attached');
                continue;
            }
            offers.createImported({
                url: c.url, title: String(c.title).slice(0, 200), description: c.description, product_id: productId,
                store_name: c.store_name, expires_at: c.expires_at != null && c.expires_at > store.now() ? c.expires_at : null,
            }, src, c.obs, { observedAt: retrievedAt, sourceRevision: item.revision });
            outcomes.push('created');
        }
        return outcomes.join(',');
    }

    const importOne = db.transaction((item) => importItem(item));

    /** Pull the change feed from the cursor. Never throws; the cursor only moves past applied items. */
    async function pull() {
        if (!sources.enabled) return { skipped: 'import off' };
        if (running) return running;
        running = (async () => {
            const summary = { pages: 0, items: 0, outcomes: {} };
            try {
                for (let p = 0; p < config.sources.maxPages; p++) {
                    const after = cursor();
                    const page = await sources.items({ after, limit: config.sources.pageSize });
                    summary.pages++;
                    store.tx(() => {
                        for (const item of page.items || []) {
                            let out;
                            // Each item in its own savepoint: one unreadable item is reported, not a stuck cursor.
                            try { out = importOne(item); } catch (err) { out = 'failed'; log.warn(`[Deals] import of ${item && item.id} failed: ${err.message}`); }
                            summary.items++;
                            for (const o of out.split(',')) summary.outcomes[o] = (summary.outcomes[o] || 0) + 1;
                        }
                        if (Number.isFinite(page.next_after) && page.next_after > after) q.setState.run(CURSOR_KEY, String(page.next_after), store.now());
                    });
                    if (!page.more) break;
                }
                lastError = null;
            } catch (err) {
                lastError = err.message;
                log.warn('[Deals] Sources import failed (will retry):', err.message);
            } finally {
                lastRunAt = store.now();
                running = null;
            }
            return summary;
        })();
        return running;
    }

    /**
     * Re-confirm imported offers whose latest observation is getting old: when Sources has fetched
     * the item again (retrieved_at advanced) the unchanged item is a new observation at that time.
     * A source that has not been fetched successfully simply lets the offer go stale.
     */
    async function refresh() {
        if (!sources.enabled) return { skipped: 'import off' };
        const due = q.refreshDue.all(store.now() - config.freshnessMs / 2, config.sources.refreshBatch);
        const out = { checked: 0, outcomes: {} };
        for (const { ref_id: id } of due) {
            try {
                const data = await sources.item(id);
                out.checked++;
                const o = store.tx(() => importItem(data.item));
                for (const x of o.split(',')) out.outcomes[x] = (out.outcomes[x] || 0) + 1;
            } catch (err) {
                if (err.status === 404) continue;
                lastError = err.message;
                break;
            }
        }
        return out;
    }

    function kick(delayMs = 1000) {
        if (kickTimer) return;
        kickTimer = setTimeout(() => { kickTimer = null; pull().catch(() => {}); }, delayMs);
        kickTimer.unref();
    }

    return {
        pull, refresh, kick, importItem, cursor,
        status: () => ({ enabled: sources.enabled, cursor: cursor(), last_error: lastError, last_run_at: iso(lastRunAt) }),
    };
}

module.exports = { createImporter };
