'use strict';

/**
 * The automatic review of imported offers.
 *
 * An offer imported from a configured feed source (a Sources `source_key` in the config) is checked
 * when it is imported, and the offers imported before this existed are checked by
 * scripts/backfill-import-review.js. A pass sets review_state = 'auto_approved': the offer is
 * published and indexable and records reviewed_by = 'system:import-checks'. A fail stays 'pending'
 * and the failed check's name is kept on the offer (review_failed_check), so a moderator sees why.
 *
 * The checks (the first that fails is the one that is recorded):
 *
 *   url_scheme     the link is https
 *   url_domain     the link's host is the source's retailer domain, or a subdomain of it
 *   title          the title is not empty and at most 300 characters
 *   price          the price is a positive number and states a currency
 *   expiry         the offer has not expired
 *   blocked_terms  the title and the description state none of the blocked/adult terms
 *
 * Offers people submit by hand never come here: their review flow is unchanged.
 */

const CHECKS = Object.freeze(['url_scheme', 'url_domain', 'title', 'price', 'expiry', 'blocked_terms']);

/** The retailer domains of a source, or null when the source is not configured (never auto-approved). */
function retailerDomainsFor(config, sourceKey) {
    const section = (config && config.importReview) || config || {};
    const sources = section.sources || {};
    const entry = sourceKey && Object.prototype.hasOwnProperty.call(sources, sourceKey) ? sources[sourceKey] : null;
    if (!entry) return null;
    const domains = (Array.isArray(entry) ? entry : entry.retailerDomains || []).map((d) => String(d || '').trim().toLowerCase()).filter(Boolean);
    return domains.length ? domains : null;
}

/** True when the host is the retailer domain itself or a subdomain of it. */
function hostAllowed(host, domains) {
    const h = String(host || '').toLowerCase();
    if (!h) return false;
    return (domains || []).some((d) => h === d || h.endsWith(`.${d}`));
}

/** The lower-cased title and description a blocked term is looked for in. */
function blockedIn(text, terms) {
    const hay = String(text || '').toLowerCase();
    if (!hay) return null;
    for (const term of terms || []) {
        const t = String(term || '').trim().toLowerCase();
        if (t && hay.includes(t)) return t;
    }
    return null;
}

/**
 * The checks, one by one. Returns { ok, failed } — `failed` is the name of the first check that
 * did not pass (null when everything passed).
 */
function evaluateImport(offer, { retailerDomains = [], blockedTerms = [], now = Date.now() } = {}) {
    const fail = (name) => ({ ok: false, failed: name });

    let url = null;
    try { url = new URL(String(offer.url || '')); } catch { return fail('url_scheme'); }
    if (url.protocol !== 'https:') return fail('url_scheme');
    if (!hostAllowed(url.hostname, retailerDomains)) return fail('url_domain');

    const title = String(offer.title == null ? '' : offer.title).trim();
    if (!title || title.length > 300) return fail('title');

    const price = Number(offer.price_num);
    const currency = typeof offer.currency === 'string' ? offer.currency.trim() : '';
    if (!Number.isFinite(price) || price <= 0 || !currency) return fail('price');

    const expiresAt = offer.expires_at == null ? null : Number(offer.expires_at);
    const expired = offer.status === 'expired' || (Number.isFinite(expiresAt) && expiresAt <= now);
    if (expired) return fail('expiry');

    const term = blockedIn(`${offer.title || ''} ${offer.description || ''}`, blockedTerms);
    if (term) return fail('blocked_terms');

    return { ok: true, failed: null };
}

module.exports = { CHECKS, evaluateImport, retailerDomainsFor, hostAllowed, blockedIn };
