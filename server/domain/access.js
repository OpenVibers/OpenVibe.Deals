'use strict';

/**
 * Who may do what (the domain's decisions; routes only check capabilities of service tokens).
 *
 *   moderators   staff with staff.content.moderate (the contracts staff map), or a subject in DEALS_MODERATORS; a
 *                service token is a moderator only for the moderation capability it holds
 *                (deals.offer.moderate / deals.offer.merge) — the grant is the decision
 *   editors      the person who submitted an offer (or a service acting for them), and moderators
 */
const { checkCapability } = require('../auth/capabilities');

function createAccess() {
    const isStaff = (viewer) => Boolean(viewer && viewer.kind === 'user' && viewer.staff);

    function isModerator(viewer, cap = 'deals.offer.moderate') {
        if (!viewer) return false;
        if (viewer.kind === 'user') return Boolean(viewer.staff);
        if (viewer.kind === 'service') return checkCapability(viewer.claims, cap).allowed;
        return false;
    }

    function canEdit(viewer, root) {
        if (!viewer || viewer.kind === 'anonymous') return false;
        if (isModerator(viewer)) return true;
        return Boolean(viewer.subject && root.submitted_by && viewer.subject === root.submitted_by);
    }

    return { isStaff, isModerator, canEdit };
}

module.exports = { createAccess };
