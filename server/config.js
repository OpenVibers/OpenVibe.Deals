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
const HOUR = 60 * 60 * 1000;

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
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        dbPath: env.DEALS_DB_PATH || './data/deals.db',

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

        // Moderators besides Network admins and global mods: usr_… subjects, comma-separated.
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
            enabled: env.DEALS_IMPORT !== 'off',
            intervalMs: int(env.DEALS_IMPORT_INTERVAL_MS, 5 * 60 * 1000),
            pageSize: int(env.DEALS_IMPORT_PAGE_SIZE, 100),
            maxPages: int(env.DEALS_IMPORT_MAX_PAGES, 10),
            refreshBatch: int(env.DEALS_IMPORT_REFRESH_BATCH, 50),
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

        // Browser origins that may call /api/v1 with a Bearer Network JWT (no cookies cross origins).
        apiCorsOrigins: list(env.API_CORS_ORIGINS || 'https://openvibe.network,https://openvibe.live,https://openvibe.community,https://openvibe.coupons'),
    };
}

module.exports = { load };
