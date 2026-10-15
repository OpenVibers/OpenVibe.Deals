'use strict';
/**
 * Crowdfunding discovery (the owner's ask: one place to find campaigns across Kickstarter, Indiegogo and the rest).
 *
 *   PLATFORMS   every platform's own search, opened at the person's words (deep links: nothing is fetched from them)
 *   pull()      the campaigns OpenVibe.Sources fetched in its `crowdfunding` category (Open Collective's public API),
 *               by change cursor (openvibe-publishing/ingest, cursor sources.crowdfunding.after); a removed item is
 *               deleted, so a takedown at the source reaches the page on the next pull
 *   list()      those campaigns, by most contributors, newest or most received, optionally matching words
 *
 * Amounts and counts are exactly what the source stated, kept with the time Sources fetched them (never "current").
 */
const { createChangeCursor, pullChanges } = require('openvibe-publishing/ingest');

const CURSOR = 'sources.crowdfunding.after';
const clean = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const intOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);

/** Where a source's campaigns live: its platform's name and the page of one campaign. */
const SOURCE_PLATFORMS = {
    'opencollective-accounts': { name: 'Open Collective', page: (f) => (f.slug ? `https://opencollective.com/${encodeURIComponent(f.slug)}` : null) },
};

/**
 * Each platform's search, checked in a browser on 2026-10-15 (a search URL that drops the words is left out).
 * `browse` is the page without words. group: what kind of money it is.
 */
const PLATFORMS = [
    { id: 'kickstarter', name: 'Kickstarter', group: 'projects', browse: 'https://www.kickstarter.com/discover', search: (q) => `https://www.kickstarter.com/discover/advanced?term=${encodeURIComponent(q)}&sort=magic` },
    { id: 'indiegogo', name: 'Indiegogo', group: 'projects', browse: 'https://www.indiegogo.com/explore/all', search: (q) => `https://www.indiegogo.com/en/projects/search?q=${encodeURIComponent(q)}` },
    { id: 'crowdsupply', name: 'Crowd Supply', group: 'projects', browse: 'https://www.crowdsupply.com/browse', search: (q) => `https://www.crowdsupply.com/search?q=${encodeURIComponent(q)}` },
    { id: 'ulule', name: 'Ulule', group: 'projects', browse: 'https://www.ulule.com/discover/', search: (q) => `https://www.ulule.com/discover/?q=${encodeURIComponent(q)}` },
    { id: 'gofundme', name: 'GoFundMe', group: 'causes', browse: 'https://www.gofundme.com/discover', search: (q) => `https://www.gofundme.com/s?q=${encodeURIComponent(q)}` },
    { id: 'opencollective', name: 'Open Collective', group: 'communities', browse: 'https://opencollective.com/discover', search: (q) => `https://opencollective.com/search?q=${encodeURIComponent(q)}` },
    { id: 'patreon', name: 'Patreon', group: 'creators', browse: 'https://www.patreon.com/explore', search: (q) => `https://www.patreon.com/explore/search?query=${encodeURIComponent(q)}` },
    { id: 'wefunder', name: 'Wefunder', group: 'invest', browse: 'https://wefunder.com/explore', search: (q) => `https://wefunder.com/explore?query=${encodeURIComponent(q)}` },
    { id: 'startengine', name: 'StartEngine', group: 'invest', browse: 'https://www.startengine.com/explore', search: (q) => `https://www.startengine.com/explore?search=${encodeURIComponent(q)}` },
];
const GROUPS = [
    { id: 'projects', title: 'Products and creative projects', note: 'Back a project for a reward: gadgets, games, films, books.' },
    { id: 'causes', title: 'Causes and people', note: 'Donations for a person, a cause or an emergency.' },
    { id: 'communities', title: 'Open source and communities', note: 'Collectives that spend in the open.' },
    { id: 'creators', title: 'Creators', note: 'Monthly memberships for people who make things.' },
    { id: 'invest', title: 'Invest in startups', note: 'Equity crowdfunding is investing: you can lose all of it. Nothing here is advice.' },
];

/** The platforms grouped, each with the link for these words (or its browse page). */
function platformLinks(q) {
    const words = clean(q, 120);
    return GROUPS.map((g) => ({ ...g, platforms: PLATFORMS.filter((p) => p.group === g.id).map((p) => ({ id: p.id, name: p.name, url: words ? p.search(words) : p.browse })) }));
}

const SORTS = {
    backers: 'backers DESC NULLS LAST, item_id',
    new: 'started_at DESC NULLS LAST, item_id',
    raised: 'raised_cents DESC NULLS LAST, item_id',
};

function createCampaigns({ store, sources, log = console }) {
    const { db } = store;
    const cursor = createChangeCursor(db, { prefix: 'deals', now: store.now });

    async function apply(item, t) {
        const platform = SOURCE_PLATFORMS[item.source_key];
        if (!platform) return 'hold';
        if (item.removed) {
            await t.query('DELETE FROM deal_campaigns WHERE item_id = $1', [item.id]);
            return 'removed';
        }
        const f = item.fields || {};
        const url = item.canonical_url || platform.page(f);
        const name = clean(item.title, 200);
        if (!url || !name) return 'hold';
        const at = store.now();
        const observed = Date.parse((item.provenance && item.provenance.retrieved_at) || '') || at;
        await t.query(`INSERT INTO deal_campaigns (item_id, source_key, platform, url, name, summary, kind, tag, currency, raised_cents, budget_cents, backers, website,
                           started_at, observed_at, first_seen_at, updated_at)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
                       ON CONFLICT (item_id) DO UPDATE SET url = excluded.url, name = excluded.name, summary = excluded.summary, kind = excluded.kind,
                           tag = excluded.tag, currency = excluded.currency, raised_cents = excluded.raised_cents, budget_cents = excluded.budget_cents,
                           backers = excluded.backers, website = excluded.website, started_at = excluded.started_at, observed_at = excluded.observed_at,
                           updated_at = excluded.updated_at`,
        [item.id, item.source_key, platform.name, url, name, clean(item.summary, 600), clean(f.account_type, 30), clean(f.tag, 60),
            /^[A-Z]{3}$/.test(String(f.raised_currency || f.currency || '')) ? String(f.raised_currency || f.currency) : null,
            intOrNull(f.raised_cents), intOrNull(f.yearly_budget_cents), intOrNull(f.backers),
            /^https?:\/\//i.test(String(f.website || '')) ? String(f.website).slice(0, 500) : null, item.published_at || null, observed, at]);
        return 'applied';
    }

    function where(q) {
        const words = clean(q, 120);
        if (!words) return { sql: '', params: [] };
        const like = `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        return { sql: 'WHERE name ILIKE $1 OR summary ILIKE $1 OR tag ILIKE $1', params: [like] };
    }

    return {
        PLATFORMS, GROUPS, platformLinks,
        async pull({ pageSize = 200, maxPages = 10 } = {}) {
            if (!sources || !sources.enabled) return { skipped: 'sources not configured' };
            try {
                return await pullChanges({ db, cursor, source: sources, apply, name: CURSOR, pageSize, maxPages });
            } catch (err) {
                log.warn('[Deals] crowdfunding pull failed:', err.message);
                return { error: err.message };
            }
        },
        async list({ q = null, sort = 'backers', limit = 24, offset = 0 } = {}) {
            const w = where(q);
            const order = SORTS[sort] || SORTS.backers;
            const n = w.params.length;
            const rows = await db.many(`SELECT * FROM deal_campaigns ${w.sql} ORDER BY ${order} LIMIT $${n + 1} OFFSET $${n + 2}`, [...w.params, limit, offset]);
            const total = Number(await db.value(`SELECT count(*) FROM deal_campaigns ${w.sql}`, w.params)) || 0;
            return { total, campaigns: rows.map((r) => ({ ...r, raised_cents: r.raised_cents == null ? null : Number(r.raised_cents), budget_cents: r.budget_cents == null ? null : Number(r.budget_cents), observed_at: Number(r.observed_at) })) };
        },
    };
}

module.exports = { createCampaigns, platformLinks, PLATFORMS, GROUPS, SORTS };
