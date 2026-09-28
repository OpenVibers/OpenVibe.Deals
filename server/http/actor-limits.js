'use strict';

/**
 * Per-actor rate limits on /api/v1 and the page forms (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The per-address limits in app.js (/api/v1 240 a minute, form posts 60, sign-in) and the per-person
 * abuse controls (domain/limits.js: votes an hour, submissions and flags a day, observations an hour,
 * kept in SQLite) stay and keep deciding what is recorded. These cap requests, refused ones included,
 * by who makes them, once req.viewer is resolved (auth/viewer.js):
 *
 *   a person                        user:usr_… (their own token or cookie, named by a service in
 *                                   X-OV-Subject, or an app's on_behalf_of)
 *   a first-party service relaying  ip:<address> of the signed-out visitor it forwards (X-Forwarded-For)
 *     a signed-out visitor
 *   a service or app acting as      its principal (svc:ai for deals.enrich_deal, app:app_…)
 *     itself
 *   a signed-out caller             ip:<address>
 *
 * A first-party service reading for itself (no person, no visitor) is not counted on reads: its
 * pages speak for all its visitors, and the per-address limit already bounds it. Past a limit the
 * route answers 429 problem+json `rate_limited` with Retry-After before it does any work (before the
 * body is read); the refusal is logged once and counted in deals_rate_limited_total{limit,window}. API
 * reads get DEALS_LIMITS_MINUTE / DEALS_LIMITS_HOUR (120 and 3000); every write has its own number
 * below, shared by the API route and the page form that do the same thing. Counters live in this
 * process: a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, sign-in, the signed Events
 * deliveries at /internal/events (Sources wake-ups: Events pushes at its own pace, and a 429 would only
 * make it retry and fall behind), and the pages and feeds people read.
 */
const { createActorLimiter, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;
const LOOPBACK = /^(::1$|127\.|::ffff:127\.)/;

/** A first-party service that forwards the address of the signed-out visitor it acts for. */
function relaysVisitor(req) {
    const v = req.viewer;
    return !!(v && v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service)) && req.get('x-forwarded-for') && req.ip && !LOOPBACK.test(req.ip));
}

function actor(req) {
    const v = req.viewer;
    if (!v || v.kind === 'anonymous') return defaultActor(req);
    if (v.subject) return `user:${v.subject}`;
    if (v.kind === 'service') return relaysVisitor(req) ? `ip:${req.ip}` : v.service;
    return defaultActor(req);
}

/** A first-party service reading for itself: no person, no visitor. */
function serviceItself(req) {
    const v = req.viewer;
    return !!(v && v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service)) && !relaysVisitor(req));
}

/**
 * The writes, each with its numbers per caller (a minute, an hour). A page form and the API route that
 * do the same thing share one budget.
 */
const BUDGETS = {
    // Each cap sits above the per-person abuse control for the same action, so a person inside that
    // control is never refused here; the difference is room for refused retries.
    // Submitting a deal (20 a day per person decide): 30 a minute, 120 an hour.
    'deals.offer.submit': { minute: 30, hour: 120 },
    // Editing or expiring a deal: a submitter or moderator saves a form now and then.
    'deals.offer.update': { minute: 30, hour: 300 },
    // A price observation (30 an hour per person decide): 40 a minute, 200 an hour.
    'deals.offer.observe': { minute: 40, hour: 200 },
    // Votes (60 an hour per person, 120 per address and 6 changes an hour per deal decide): setting and
    // removing share one budget, 60 a minute and 600 an hour.
    'deals.vote': { minute: 60, hour: 600 },
    // Flags (30 a day per person decide): 30 a minute, 120 an hour.
    'deals.flag.create': { minute: 30, hour: 120 },
    // Moderators merging, unmerging, disabling, enabling, reviewing and resolving flags work through queues.
    'deals.offer.moderate': { minute: 60, hour: 600 },
    // Resolving (and maybe creating) a product from its aliases: one per imported or enriched item.
    'deals.product.resolve': { minute: 60, hour: 1200 },
    // Price watches (50 per person at most): created and removed by hand.
    'deals.watch': { minute: 30, hour: 300 },
    // A comment goes to OpenVibe.Community in the person's name (Community allows 20 a minute).
    'deals.comment.create': { minute: 20, hour: 300 },
};

/**
 * limits(name, own) middleware for one app, plus limits.reads(name) (the defaults on every GET/HEAD,
 * a first-party service reading for itself not counted) and limits.budget(name) (one of BUDGETS).
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'deals_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.actorLimits.minute, hour: config.actorLimits.hour },
        actor,
        now,
        onLimited(e) {
            // The actor is a subject id, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && !serviceItself(req) ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createActorLimits, actor, serviceItself, BUDGETS };
