'use strict';

/**
 * OpenVibe.Deals configuration. Every value comes from the environment (production:
 * /etc/openvibe/deals.env, see .env.example). Only environment variable NAMES appear in code and
 * docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const num = (v, def) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const json = (v, def) => { try { const p = v ? JSON.parse(v) : null; return p && typeof p === 'object' ? p : def; } catch { return def; } };
const HOUR = 60 * 60 * 1000;

/**
 * The feed sources whose imported offers may be reviewed automatically, and the retailer domain
 * each of them links to. A source that is not listed here is never auto-approved.
 */
const IMPORT_REVIEW_SOURCES = Object.freeze({
    'dealnews-daily': { retailerDomains: ['dealnews.com'] },
    'crawl-zappos-com': { retailerDomains: ['zappos.com'] },
    'crawl-footlocker-com': { retailerDomains: ['footlocker.com'] },
    'crawl-anker-com': { retailerDomains: ['anker.com'] },
    'crawl-humblebundle-com': { retailerDomains: ['humblebundle.com'] },
    'crawl-gog-com': { retailerDomains: ['gog.com'] },
    'crawl-allbirds-com': { retailerDomains: ['allbirds.com'] },
});

/** The blocked/adult terms an imported offer's title and description may not contain. */
const IMPORT_REVIEW_BLOCKED_TERMS = Object.freeze([
    'porn', 'xxx video', 'xxxvideo', 'hentai', 'nsfw', 'onlyfans', 'camgirl', 'escort service',
    'viagra', 'cialis', 'payday loan', 'free bitcoin', 'crypto giveaway', 'phishing', 'work from home scam',
]);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4840);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.deals' : `http://localhost:${port}`));

    return {
        service: 'deals',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        // Public origin: canonical URLs, feeds, sitemaps and JSON-LD are built from it.
        baseUrl,
        // The sitemaps' and /llms-full.txt's offer and product lists (every offer's and product's page view) are built
        // at most once in this window and shared (one build serves concurrent readers either way). Each crawler fetch
        // of /sitemap.xml rebuilt both: 5,000-24,000 slow queries a time on 2026-10-23. 0 = no reuse.
        sitemapTtlMs: int(env.DEALS_SITEMAP_TTL_MS, isProduction ? 10 * 60 * 1000 : 0),
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-actor limits (server/http/actor-limits.js, roadmap WS-R task 4): the API reads one caller may
        // make per minute and per hour. Writes set tighter numbers there.
        actorLimits: {
            minute: Math.max(1, int(env.DEALS_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.DEALS_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        // pgliteDir is the dev/test embedded-database directory (a test gives the spawned server its own).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.DEALS_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:deals:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server), JWKS, client-credentials tokens.
        networkUrl: trim(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'deals',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile theme',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // Signs the per-session form token (CSRF). Unset: a random per-process key.
        formSecret: env.DEALS_FORM_SECRET || '',
        // Keys the HMAC that turns a client IP into the ip_hash used by the abuse controls. Unset: a
        // random per-process key (hashes are then not comparable across restarts; /api/ready says so).
        ipHashSecret: env.DEALS_IP_HASH_SECRET || '',

        // Moderators besides staff with staff.content.moderate: usr_… subjects, comma-separated (a product role).
        moderators: list(env.DEALS_MODERATORS),

        // Freshness: an observation older than this is shown as stale, never as the price now.
        freshnessMs: num(env.DEALS_FRESHNESS_HOURS, 48) * HOUR,

        // Abuse controls (server-side; see README "Votes, hotness and abuse controls").
        abuse: {
            voteSubjectPerHour: int(env.DEALS_VOTE_LIMIT_SUBJECT_HOUR, 60),
            voteIpPerHour: int(env.DEALS_VOTE_LIMIT_IP_HOUR, 120),
            voteOfferChangesPerHour: int(env.DEALS_VOTE_LIMIT_OFFER_HOUR, 6),
            submitPerDay: int(env.DEALS_SUBMIT_LIMIT_DAY, 20),
            observePerHour: int(env.DEALS_OBSERVE_LIMIT_HOUR, 30),
            flagPerDay: int(env.DEALS_FLAG_LIMIT_DAY, 30),
            newAccountDays: num(env.DEALS_NEW_ACCOUNT_DAYS, 7),
            newAccountWeight: num(env.DEALS_NEW_ACCOUNT_WEIGHT, 0.25),
            ringIpMin: int(env.DEALS_RING_IP_MIN, 3),
            ringCovoteMin: int(env.DEALS_RING_COVOTE_MIN, 5),
            ringWindowMs: int(env.DEALS_RING_WINDOW_MIN, 10) * 60 * 1000,
            watchesPerSubject: int(env.DEALS_WATCH_LIMIT, 50),
        },

        // OpenVibe.Community: comment threads (referenced by id, never copied).
        community: {
            publicUrl: trim(env.OV_COMMUNITY_URL || 'https://openvibe.community'),
            internalUrl: trim(env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200'),
        },

        // OpenVibe.Sources: deals-category items (pull by change cursor; events only wake the pull).
        sources: {
            internalUrl: trim(env.OV_SOURCES_INTERNAL_URL || 'http://127.0.0.1:4720'),
            category: 'deals',
            enabled: env.DEALS_IMPORT !== 'off',
            intervalMs: int(env.DEALS_IMPORT_INTERVAL_MS, 5 * 60 * 1000),
            pageSize: int(env.DEALS_IMPORT_PAGE_SIZE, 100),
            maxPages: int(env.DEALS_IMPORT_MAX_PAGES, 10),
            refreshBatch: int(env.DEALS_IMPORT_REFRESH_BATCH, 50),
        },

        // The automatic review of imported offers (server/domain/import-review.js). Only a source
        // listed here is ever auto-approved, and only the retailer domains listed for it. A crawl
        // source's key names its retailer (crawl-zappos-com -> zappos.com).
        importReview: {
            enabled: env.DEALS_IMPORT_REVIEW !== 'off',
            sources: json(env.DEALS_IMPORT_REVIEW_SOURCES, IMPORT_REVIEW_SOURCES),
            // A short list (there was none before): adult terms and the spam terms an import may
            // never carry. DEALS_IMPORT_REVIEW_BLOCKED_TERMS replaces it.
            blockedTerms: env.DEALS_IMPORT_REVIEW_BLOCKED_TERMS ? list(env.DEALS_IMPORT_REVIEW_BLOCKED_TERMS) : IMPORT_REVIEW_BLOCKED_TERMS.slice(),
        },

        // OpenVibe.Events: the outbox relay runs only when EVENTS_URL and the client secret are set;
        // the webhook consumer (/internal/events) only when DEALS_EVENTS_SECRET is set.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            webhookSecrets: list(env.DEALS_EVENTS_SECRET),
        },

        // In-process worker: hotness snapshots, stated-expiry, re-indexing when freshness changes.
        worker: {
            enabled: env.DEALS_WORKER !== 'off',
            intervalMs: int(env.DEALS_WORKER_INTERVAL_MS, 10 * 60 * 1000),
            hotWindowDays: int(env.DEALS_HOT_WINDOW_DAYS, 14),
        },

        // IndexNow (openvibe-shared/indexnow): when INDEXNOW_KEY is set the key file is served at
        // /<key>.txt and an indexable deal or product page appearing, changing or disappearing pings
        // the engines. Unset (or empty) → off: nothing is mounted and nothing is sent.
        indexnowKey: String(env.INDEXNOW_KEY || '').trim(),

        // Browser origins that may call /api/v1 with a Bearer Network JWT (no cookies cross origins).
        apiCorsOrigins: list(env.API_CORS_ORIGINS || 'https://openvibe.network,https://openvibe.live,https://openvibe.community,https://openvibe.coupons'),
    };
}

module.exports = { load };
