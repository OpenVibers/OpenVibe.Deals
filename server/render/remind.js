'use strict';

/**
 * "Remind me" on a deal's end (plan L48 R3): a link to openvibe.today/remind that sets a one-off reminder for the
 * moment the deal ends. The person signs in there, picks how long before, and it reaches them in the bell and as a
 * push on every OpenVibe site.
 *
 * The link is only there when the end is stated and still ahead: a deal with no end, or one that has ended, gets
 * none. The instant is the end itself, in UTC.
 */
const kit = require('openvibe-shared/kit');

const HOST = 'openvibe.deals';
const REMIND = 'https://openvibe.today/remind';

/** The moment a deal ends, in UTC, or null when no end is stated. */
function endsAt(offer) {
    const raw = offer && offer.expires_at;
    if (raw == null || raw === '') return null;
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The reminder's title: the deal's own name, the shop it is at, and that it ends. */
function remindTitle(offer, shop = '') {
    const name = String(offer && offer.title ? offer.title : '').trim();
    const where = String(shop || '').trim();
    return where ? `${name} at ${where} ends` : `${name} ends`;
}

/** Today's "Remind me" link for this deal, or '' when there is nothing to remind about. */
function remindLink(offer, { now = Date.now(), shop = '', url = '', action = false } = {}) {
    const at = endsAt(offer);
    if (!at || Date.parse(at) <= now) return '';
    const query = new URLSearchParams({ title: remindTitle(offer, shop), at, url, from: HOST });
    const href = `${REMIND}?${query}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const cls = action ? 'remind remind-action' : 'remind';
    return `<a class="${cls}" href="${href}">${kit.icon('bell', { size: 16 })}<span>Remind me</span></a>`;
}

module.exports = { endsAt, remindTitle, remindLink, HOST, REMIND };
