'use strict';

/**
 * Small pure helpers: ids, slugs, URL normalisation, stated-value parsing. Nothing here guesses:
 * a value that is missing or malformed is null (or a 422), never a default.
 */
const { ids } = require('openvibe-contracts');

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

/** The identity used to find duplicates: normalised URL without scheme and without "www.". */
function urlKey(normalized) {
    if (!normalized) return null;
    return normalized.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

function domainOf(normalized) {
    try { return new URL(normalized).hostname.replace(/^www\./, ''); } catch { return null; }
}

function slugify(text, suffixFrom) {
    const base = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'deal';
    const suffix = String(suffixFrom || '').replace(/^[a-z]+_/, '').slice(-6).toLowerCase();
    return suffix ? `${base}-${suffix}` : base;
}

/**
 * A decimal amount as stated: '12', '12.5', '1,299.99'. The digits stay as the person or source
 * gave them (no rounding, no added decimals); only thousands commas and surrounding space go.
 * → { text, num } | null (blank) ; throws ApiError 422 on anything else (negative, words, symbols).
 */
function parseAmount(v, field) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
        if (!Number.isFinite(v) || v < 0) throw new ApiError(422, 'request.invalid', `${field} must be a non-negative number`);
        return { text: String(v), num: v };
    }
    const s = String(v).trim().replace(/,(?=\d{3}(\D|$))/g, '');
    if (s === '') return null;
    if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) throw new ApiError(422, 'request.invalid', `${field} must be a plain amount like 19.99 (no currency symbols)`);
    return { text: s.replace(/^0+(?=\d)/, ''), num: Number(s) };
}

function parseCurrency(v, field = 'currency') {
    if (v == null || v === '') return null;
    const s = String(v).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(s)) throw new ApiError(422, 'request.invalid', `${field} must be an ISO 4217 code such as USD or EUR`);
    return s;
}

function parseEnum(v, allowed, field) {
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    if (!allowed.includes(s)) throw new ApiError(422, 'request.invalid', `${field} must be one of ${allowed.join(', ')}`);
    return s;
}

/** An instant stated by a person or source (ISO string or epoch ms) → ms; blank → null. */
function parseInstant(v, field) {
    if (v == null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(String(v));
    if (!Number.isFinite(t)) throw new ApiError(422, 'request.invalid', `${field} must be a date`);
    return t;
}

function text(v, { field, min = 0, max = 1000, required = false } = {}) {
    const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    if (!s) {
        if (required) throw new ApiError(422, 'request.invalid', `${field} is required`);
        return null;
    }
    if (s.length < min) throw new ApiError(422, 'request.invalid', `${field} must be at least ${min} characters`);
    return s.slice(0, max);
}

/** Multi-line text (descriptions): keeps line breaks, trims, caps. */
function longText(v, max = 4000) {
    if (v == null) return null;
    const s = String(v).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    return s ? s.slice(0, max) : null;
}

/** Lower-case word tokens (letters and digits of any script). */
function tokens(s) {
    return String(s || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

module.exports = {
    ApiError, newId, CONDITIONS, AVAILABILITY, AVAILABILITY_LABEL, SCHEMA_AVAILABILITY, SCHEMA_CONDITION,
    normalizeUrl, urlKey, domainOf, slugify, parseAmount, parseCurrency, parseEnum, parseInstant, text, longText, tokens, iso,
};
