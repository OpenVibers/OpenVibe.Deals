'use strict';

/**
 * Capability checks for service tokens (audience openvibe.deals). The deals.* ids this service
 * introduces are defined by the installed openvibe-contracts, so a grant is decided by the library's
 * own matching rule (the exact id, or a `prefix.*` grant covering it). CAPABILITIES keeps the ids in
 * one place for the guards, the proposal documents and the tests.
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

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, checkCapability };
