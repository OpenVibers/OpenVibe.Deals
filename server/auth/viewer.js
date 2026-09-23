'use strict';

/**
 * Who is calling, resolved once per request into `req.viewer`:
 *
 *   { kind: 'anonymous', subject: null, staff: false }
 *   { kind: 'user', subject: 'usr_…'|null, staff, user, token }
 *       A browser with the Network user JWT (ov_token cookie or Bearer). The subject comes from the
 *       token's subject_id claim. Role admin or global_mod, or a subject in DEALS_MODERATORS, makes
 *       the viewer a moderator (staff). X-OV-* headers are ignored for browsers.
 *   { kind: 'service', service: 'svc:ai', claims, subject: 'usr_…'|null, origin: 'user'|'ai' }
 *       A first-party service with a Network client-credentials token for audience openvibe.deals.
 *       X-OV-Subject names the person it acts for; X-OV-Origin: ai marks AI output (OpenVibe.AI's
 *       deals.enrich_deal), which is disclosed and noindex until a person reviews it.
 *
 * Identity never comes from a request body or query. A request presenting a service token is judged
 * on that token alone: a bad one is refused (problem+json), never downgraded to anonymous.
 */
const contracts = require('openvibe-contracts');
const { extractToken, claimsToUser, decodeJwtPayload } = require('./sso');
const { checkCapability } = require('./capabilities');

const { ids, serviceAuth, http } = contracts;
const STAFF_ROLES = new Set(['admin', 'global_mod']);
const PRINCIPAL_SUB = /^(svc|app|mod):/;
const AUDIENCE = 'openvibe.deals';

class ViewerError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

const ANONYMOUS = Object.freeze({ kind: 'anonymous', subject: null, staff: false, origin: 'user' });

function createViewerResolver({ auth, config, people }) {
    const moderators = new Set(config.moderators || []);

    async function fromServiceToken(req, token) {
        const publicKey = await auth.ensureKey();
        if (!publicKey) throw new ViewerError(503, 'identity.unavailable', 'the Network signing key is not loaded yet');
        const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkUrl, audience: AUDIENCE });
        if (!r.ok) throw new ViewerError(401, r.code, r.reason);
        const originHeader = req.get('x-ov-origin');
        if (originHeader && originHeader !== 'ai' && originHeader !== 'user') throw new ViewerError(400, 'request.invalid_origin', 'X-OV-Origin must be "ai" or "user"');
        const subjectHeader = req.get('x-ov-subject');
        let subject = null;
        if (subjectHeader) {
            if (!ids.isSubjectId('user', subjectHeader)) throw new ViewerError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id');
            subject = subjectHeader;
        }
        return { kind: 'service', service: r.claims.sub, claims: r.claims, subject, origin: originHeader === 'ai' ? 'ai' : 'user', staff: false };
    }

    async function fromUserToken(token) {
        const claims = await auth.verify(token);
        if (!claims || (typeof claims.sub === 'string' && PRINCIPAL_SUB.test(claims.sub))) return null;
        const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        if (subject && people) { try { people.rememberClaims(subject, claims); } catch { /* display cache only */ } }
        const staff = STAFF_ROLES.has(claims.role) || Boolean(subject && moderators.has(subject));
        return { kind: 'user', subject, staff, origin: 'user', user: claimsToUser(claims), token };
    }

    /** opts.services=false (pages) treats a service token as no identity: pages are for browsers. */
    async function resolve(req, opts = {}) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            const payload = decodeJwtPayload(token);
            if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
                if (opts.services === false) return ANONYMOUS;
                return fromServiceToken(req, token);
            }
        }
        const token = extractToken(req);
        if (!token) return ANONYMOUS;
        return (await fromUserToken(token)) || ANONYMOUS;
    }

    function middleware(opts = {}) {
        return async (req, res, next) => {
            try {
                req.viewer = await resolve(req, opts);
                next();
            } catch (err) {
                if (!(err instanceof ViewerError)) return next(err);
                http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            }
        };
    }

    return { resolve, middleware };
}

/**
 * Route guard: a service token must hold `cap`; browsers and anonymous callers pass here and are
 * judged by the domain (signed in, submitter, moderator).
 */
function guard(cap) {
    return (req, res, next) => {
        const v = req.viewer;
        if (!v || v.kind !== 'service') return next();
        const c = checkCapability(v.claims, cap);
        if (c.allowed) return next();
        return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx: req.ov });
    };
}

module.exports = { createViewerResolver, guard, ANONYMOUS, ViewerError, STAFF_ROLES };
