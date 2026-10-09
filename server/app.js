'use strict';

/**
 * OpenVibe.Deals — Express app factory. server/index.js listens and starts the worker; tests build
 * their own instance with a temp database, an injectable clock and mock neighbours.
 *
 *   Pages (server-rendered, http/pages.js)   Discovery (robots, llms, sitemaps)   /auth/* (Network SSO)
 *   API (/api/v1, http/api.js)               /internal/events (Sources wake-ups)  /api/health, /api/ready,
 *                                                                                  /release.json, /metrics
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');

const configLib = require('./config');
const { openStore } = require('./db');
const { createSsoClient } = require('openvibe-sdk/sso');
const { createViewerResolver } = require('./auth/viewer');
const { createPeople } = require('./clients/network');
const { createCommunity } = require('./clients/community');
const { createSourcesClient } = require('openvibe-publishing/ingest');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createIndexNow } = require('openvibe-shared/indexnow');
const { createReads } = require('./domain/reads');
const { createCatalog } = require('./domain/catalog');
const { createPublication } = require('./domain/publication');
const { createIndexing } = require('./domain/indexing');
const { createHotness } = require('./domain/hotness');
const { createWatches } = require('./domain/watches');
const { createLimits } = require('./domain/limits');
const { createAccess } = require('./domain/access');
const { createOffers } = require('./domain/offers');
const { createFlags } = require('./domain/flags');
const { createVotes } = require('./domain/votes');
const { createListings } = require('./domain/listings');
const { createImporter } = require('./domain/source-items');
const { createPages } = require('./http/pages');
const { createApi } = require('./http/api');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createEvents } = require('./http/events');
const accountDataLib = require('./domain/account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { createDealsReadiness } = require('./observability');
const { createActorLimits } = require('./http/actor-limits');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');
const cache = require('openvibe-shared/cache-policy');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/** opts: config, now (clock), fetchImpl, auth, log, limitsNow (the per-actor limiter's clock, tests) */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, a script) hands in a store.
    const store = opts.store || await openStore(config, { now: opts.now, log });

    const outbox = createServiceOutbox({
        db: store.db, source: 'deals',
        eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs, now: store.now, fetch: fetchImpl, log,
    });
    const people = createPeople({ store, config, fetchImpl });
    const community = createCommunity({ store, config, fetchImpl });
    const sources = createSourcesClient({ config, fetchImpl });
    const reads = createReads({ store });
    const catalog = createCatalog({ store });
    const publication = createPublication({ config, store, reads, catalog });
    // IndexNow (openvibe-shared/indexnow): created once at boot from INDEXNOW_KEY; unset → off
    // (nothing mounted, nothing sent). The key file is served at /<key>.txt and indexing.js pings the
    // engines when an indexable deal or product page appears, changes or goes away.
    const indexnow = opts.indexnow !== undefined ? opts.indexnow : createIndexNow({
        host: config.baseUrl, key: config.indexnowKey, fetch: fetchImpl, log,
    });
    const indexing = createIndexing({ config, store, publication, outbox, catalog, indexnow });
    const hotness = createHotness({ store, reads });
    const watches = createWatches({ config, store, reads, catalog, publication, outbox });
    const limits = createLimits({ config, store });
    const access = createAccess();
    const offers = createOffers({ config, store, reads, catalog, publication, indexing, hotness, watches, limits, access, community, outbox });
    const flags = createFlags({ config, store, reads, limits, access, publication, logAction: offers.logAction, outbox });
    const votes = createVotes({ config, store, reads, hotness, limits, flags, people, outbox });
    const listings = createListings({ store });
    const importer = createImporter({ config, store, reads, catalog, offers, indexing, sources, log });
    const sso = opts.sso || createSsoClient({
        site: 'deals', baseUrl: config.baseUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri, scope: config.oauth.scope,
        networkUrl: config.networkUrl, networkInternalUrl: config.networkInternalUrl,
        issuer: config.issuer || config.networkUrl, secureCookies: config.cookies.secure, log,
    });
    const auth = opts.auth || sso;
    const jwksUrl = `${config.networkInternalUrl}/api/.well-known/jwks`;
    const viewers = createViewerResolver({ auth, config, people });
    const worker = createWorker({ config, store, offers, hotness, indexing, listings, importer, limits, log });

    // Account export and deletion (ADR-033, domain/account-data.js), pushed to Network's internal routes with this service's
    // own client-credentials token; a test injects a stand-in through opts.accountSend.
    const accountData = accountDataLib.create({ db: store.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : null);

    const ctx = { config, store, outbox, people, community, sources, reads, catalog, publication, indexing, hotness, watches, limits, access, offers, flags, votes, listings, importer, auth, viewers, worker, indexnow, accountData, accountSend };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'deals', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'deals', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;
    // Per-actor limits (http/actor-limits.js) for the API and the page forms, counted once each router
    // resolved req.viewer; the per-address limits below and the per-person abuse controls stay.
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.actorLimits = createActorLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, valkey });

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https:'],
                // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-deals', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });
    const readiness = createDealsReadiness({ store, jwksUrl, outbox, importer, worker, limits, release: release.release, valkey: ctx.valkey, log });
    app.get('/api/ready', readiness.handler);

    // GET /<key>.txt — the IndexNow key file (only when a key is configured; it serves itself).
    if (indexnow.enabled) app.use(indexnow.keyFile);

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.router(express));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'deals', service: 'deals', host: 'openvibe.deals', name: 'OpenVibe.Deals', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── Events consumer, API ────────────────────────────────
    // Never per-actor limited: Events pushes at its own pace, and a 429 would only make it retry and fall behind.
    app.use(createEvents({ config, store, importer, accountData: ctx.accountData, accountSend: ctx.accountSend }));
    app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }), createApi(ctx));

    // ── Discovery, public pages ─────────────────────────────
    app.use(createDiscoveryRoutes(ctx));
    const pages = createPages(ctx);
    const formLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
    app.use(['/submit', '/watches', '/mod', '/d/:slug/:action'], (req, res, next) => (req.method === 'POST' ? formLimit(req, res, next) : next()));
    app.use(pages.router);
    app.use((req, res) => pages.notFound(req, res));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[Deals]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
