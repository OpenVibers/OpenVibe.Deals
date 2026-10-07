'use strict';

/**
 * Per-source policy for imported offers: which links must be kept exactly as the source stated them,
 * how the source is attributed, and whether its content may reach a browser extension.
 *
 * A source that hands Deals a feed with terms gets an entry here, explicitly, keyed by the
 * OpenVibe.Sources `source_key` (the key Sources labels each item with, e.g. `dealnews-daily`).
 * Sources' `license_note` / `terms_note` are prose and are never parsed: a source with no entry gets
 * today's default — links normalised (tracking and affiliate parameters stripped) and no attribution.
 *
 * DealNews' feed terms (https://www.dealnews.com/pages/rss.html) allow public use of their feeds only
 * (1) without removing or adding content within the feed display, (2) without modifying the links or
 * referral codes, (3) with attribution to DealNews as text (e.g. "DealNews") or with their 88x31 logo,
 * and (4) never inside a browser extension. `dealnews-daily` therefore keeps its links verbatim, is
 * attributed wherever the offer appears, and is kept out of the API a browser extension could read.
 */

const POLICIES = Object.freeze({
    'dealnews-daily': Object.freeze({
        verbatimLinks: true,
        attribution: Object.freeze({ text: 'DealNews', url: 'https://www.dealnews.com/' }),
        // Terms (4): the feed may never be used inside a browser extension.
        noExtension: true,
    }),
});

/** The policy for a Sources `source_key`, or null (today's default: normalise the link, no attribution). */
const policyFor = (sourceKey) => (sourceKey && Object.prototype.hasOwnProperty.call(POLICIES, sourceKey) ? POLICIES[sourceKey] : null);

/** True when the source's links must be stored and shown exactly as received. */
function keepsLinksVerbatim(sourceKey) {
    const p = policyFor(sourceKey);
    return Boolean(p && p.verbatimLinks);
}

/** True when the source's content must not reach a browser extension. */
function excludesExtension(sourceKey) {
    const p = policyFor(sourceKey);
    return Boolean(p && p.noExtension);
}

/** The attribution for a set of source rows ({ source_key, … }): the first whose policy names one. */
function attributionOf(sources) {
    for (const s of sources || []) {
        const p = policyFor(s && s.source_key);
        if (p && p.attribution) return { text: p.attribution.text, url: p.attribution.url };
    }
    return null;
}

/** True when any of the offer's sources forbids its content in a browser extension. */
function hidesFromExtension(sources) {
    return (sources || []).some((s) => excludesExtension(s && s.source_key));
}

module.exports = { POLICIES, policyFor, keepsLinksVerbatim, excludesExtension, attributionOf, hidesFromExtension };
