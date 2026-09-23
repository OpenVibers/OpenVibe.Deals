'use strict';

/**
 * Capability checks for service tokens (audience openvibe.deals), including the ids Deals
 * introduces before the contracts library knows them.
 *
 * openvibe-contracts' capabilities.check() answers capability.unknown for an id that is not in its
 * manifests yet. Deals' ids are proposed in docs/capabilities-proposal/ for the next contracts
 * release; until then a grant is decided locally with the library's own matching rule (the exact
 * id, or a `prefix.*` grant covering it). An id the library does know always goes through the
 * library, so the day the release lands nothing changes here.
 *
 * Browsers (Network user JWTs) are never judged by capabilities: they are judged by the domain
 * (signed in, submitter, moderator). A service token is judged by its capability AND, for actions a
 * person takes, by the person it acts for (X-OV-Subject).
 */
const { capabilities } = require('openvibe-contracts');

const CAPABILITIES = Object.freeze({
    OFFER_SUBMIT: 'deals.offer.submit',
    OFFER_UPDATE: 'deals.offer.update',       // edit text, record an observation
    OFFER_EXPIRE: 'deals.offer.expire',
    OFFER_MERGE: 'deals.offer.merge',         // duplicate resolution: merge / unmerge (moderation)
    OFFER_MODERATE: 'deals.offer.moderate',   // disable / enable / review / flag queue
    VOTE_SET: 'deals.vote.set',
    VOTE_REMOVE: 'deals.vote.remove',
    WATCH_CREATE: 'deals.watch.create',
    WATCH_READ: 'deals.watch.read',
    WATCH_DELETE: 'deals.watch.delete',
    PRODUCT_RESOLVE: 'deals.product.resolve',
    FLAG_CREATE: 'deals.flag.create',
});
const PROPOSED = new Set(Object.values(CAPABILITIES));

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, PROPOSED, checkCapability };
