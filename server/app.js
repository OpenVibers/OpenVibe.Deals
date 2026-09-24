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
const { createAuthClient, createAuthRoutes } = require('./auth/sso');
const { createViewerResolver } = require('./auth/viewer');
const { createPeople } = require('./clients/network');
const { createCommunity } = require('./clients/community');
const { createSources } = require('./clients/sources');
const { createDealsOutbox } = require('./events/outbox');
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
const { createImporter } = require('./domain/importer');
const { createPages } = require('./http/pages');
const { createApi } = require('./http/api');
const { createDiscoveryRoutes } = require('./http/discovery');
const { createInternalRoutes } = require('./http/internal');
const { createDealsReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/** opts: config, dbPath, now (clock), fetchImpl, auth, log */
function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const store = opts.store || openStore(opts.dbPath || config.dbPath, { now: opts.now });

    const outbox = createDealsOutbox({ db: store.db, config, fetchImpl, now: store.now, log });
    const people = createPeople({ store, config, fetchImpl });
    const community = createCommunity({ store, config, fetchImpl });
    const sources = createSources({ config, fetchImpl });
    const reads = createReads({ store });
    const catalog = createCatalog({ store });
    const publication = createPublication({ config, store, reads, catalog });
    const indexing = createIndexing({ store, publication, outbox, catalog });
    const hotness = createHotness({ store, reads });
    const watches = createWatches({ config, store, reads, catalog, publication, outbox });
    const limits = createLimits({ config, store });
    const access = createAccess();
    const offers = createOffers({ config, store, reads, catalog, publication, indexing, hotness, watches, limits, access, community });
    const flags = createFlags({ config, store, reads, limits, access, publication, logAction: offers.logAction });
    const votes = createVotes({ config, store, reads, hotness, limits, flags, people, outbox });
    const listings = createListings({ store });
    const importer = createImporter({ config, store, reads, catalog, offers, indexing, sources, log });
    const auth = opts.auth || createAuthClient(config);
    const viewers = createViewerResolver({ auth, config, people });
    const worker = createWorker({ config, store, offers, hotness, indexing, listings, importer, limits, log });

    const ctx = { config, store, outbox, people, community, sources, reads, catalog, publication, indexing, hotness, watches, limits, access, offers, flags, votes, listings, importer, auth, viewers, worker };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'deals', root: path.join(__dirname, '..') });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'deals', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;

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
                connectSrc: ["'self'", 'https://openvibe.network'],
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
    const readiness = createDealsReadiness({ store, auth, outbox, importer, worker, limits, release: release.release });
    app.get('/api/ready', readiness.handler);

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createAuthRoutes(config, auth));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'deals', service: 'deals', host: 'openvibe.deals', name: 'OpenVibe.Deals', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
    }));

    // ── Events consumer, API ────────────────────────────────
    app.use(createInternalRoutes({ config, store, importer }));
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
        res.set('Cache-Control', 'private, no-store');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
