'use strict';

/**
 * Deals' own values and refusals, plus the shared normalisers.
 *
 * The generic normalisers (hosts, slugs, amounts, currencies, instants, enum/text parsing, tokens,
 * iso) come from the chassis (openvibe-publishing/ingest `normalize`), which ports them byte-for-byte
 * from the five products — away is the local copy (server/domain/util.js, now unrequired). They throw
 * openvibe-publishing's PublishingError; the wrappers below rethrow Deals' ApiError so the HTTP layer
 * keeps answering the same 422 problems.
 *
 * What stays Deals' own: the refusal type, id minting, the condition/availability enums and the
 * schema.org maps (policy values), and the URL identity helpers — the chassis `normalizeUrl` strips
 * a narrower set of tracking parameters than Deals does, so Deals keeps its own (offer identity must
 * not change).
 */
const { ids } = require('openvibe-contracts');
const { normalize } = require('openvibe-publishing/ingest');

/** A refusal with a stable problem code (e.g. 404 'offer.not_found'). */
class ApiError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.extra = extra || null;
    }
}

/** The chassis throws PublishingError; Deals' callers catch ApiError by class. */
const asApiError = (fn) => (...args) => {
    try { return fn(...args); } catch (err) {
        if (err && err.name === 'PublishingError') throw new ApiError(err.status, err.code, err.message, err.extra);
        throw err;
    }
};

const newId = (prefix) => `${prefix}_${ids.ulid()}`;

const CONDITIONS = ['new', 'used', 'refurbished', 'damaged'];
const AVAILABILITY = ['in_stock', 'out_of_stock', 'preorder', 'discontinued', 'limited', 'sold_out', 'online_only', 'in_store_only'];
const AVAILABILITY_LABEL = {
    in_stock: 'In stock', out_of_stock: 'Out of stock', preorder: 'Pre-order', discontinued: 'Discontinued',
    limited: 'Limited availability', sold_out: 'Sold out', online_only: 'Online only', in_store_only: 'In store only',
};
/** schema.org terms (as OpenVibe.Sources passes them through) → our enums; anything else → null. */
const SCHEMA_AVAILABILITY = {
    InStock: 'in_stock', OutOfStock: 'out_of_stock', PreOrder: 'preorder', PreSale: 'preorder', Discontinued: 'discontinued',
    LimitedAvailability: 'limited', SoldOut: 'sold_out', OnlineOnly: 'online_only', InStoreOnly: 'in_store_only',
};
const SCHEMA_CONDITION = { NewCondition: 'new', UsedCondition: 'used', RefurbishedCondition: 'refurbished', DamagedCondition: 'damaged' };

// Tracking and affiliate parameters are not part of an offer's identity.
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|yclid|_hsenc|_hsmi|ref|ref_|tag|aff|affid|affiliate|affiliate_id|irclickid|clickid)$/i;

/** http(s) URL with the fragment and tracking parameters removed, host lower-cased, params sorted. */
function normalizeUrl(input) {
    if (input == null || input === '') return null;
    let u;
    try { u = new URL(String(input).trim()); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = '';
    for (const [k, v] of keep) u.searchParams.append(k, v);
    let s = u.toString();
    if (u.pathname.length > 1 && s.endsWith('/') && !u.search) s = s.slice(0, -1);
    return s.length <= 2048 ? s : null;
}

/**
 * An http(s) URL validated but kept exactly as the source stated it — no fragment removal, no
 * tracking-parameter stripping, no host lower-casing, no re-encoding (source policy
 * `verbatimLinks`, e.g. DealNews' feed terms). A URL Deals cannot use is null, as with normalizeUrl.
 */
function verbatimUrl(input) {
    if (input == null || input === '') return null;
    const s = String(input);
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return s.length <= 2048 ? s : null;
}

/** The identity used to find duplicates: normalised URL without scheme and without "www.". */
function urlKey(normalized) {
    if (!normalized) return null;
    return normalized.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

module.exports = {
    ApiError, newId, CONDITIONS, AVAILABILITY, AVAILABILITY_LABEL, SCHEMA_AVAILABILITY, SCHEMA_CONDITION,
    normalizeUrl, urlKey, verbatimUrl,
    domainOf: normalize.domainOf, slugify: normalize.slugify,
    parseAmount: asApiError(normalize.parseAmount), parseCurrency: asApiError(normalize.parseCurrency),
    parseEnum: asApiError(normalize.parseEnum), parseInstant: asApiError(normalize.parseInstant),
    text: asApiError(normalize.text), longText: normalize.longText, tokens: normalize.tokens, iso: normalize.iso,
};
