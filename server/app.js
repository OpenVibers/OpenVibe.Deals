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
const { createSharing } = require('./sharing');
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
const settingsLib = require('./settings');
const { verifyServiceToken } = require('openvibe-sdk/auth');
const accountDataLib = require('./domain/account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { createDealsReadiness } = require('./observability');
const { createActorLimits } = require('./http/actor-limits');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');
const cache = require('openvibe-shared/cache-policy');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

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
    // The one sharing system (design 2026-11-06): a watch is its owner's until the Share sheet says otherwise.
    const sharing = opts.sharing || createSharing({ db: store.db, config, fetchImpl, log });
    const watches = createWatches({ config, store, reads, catalog, publication, outbox, sharing });
    const limits = createLimits({ config, store });
    const access = createAccess();
    const offers = createOffers({ config, store, reads, catalog, publication, indexing, hotness, watches, limits, access, community, outbox });
    const flags = createFlags({ config, store, reads, limits, access, publication, logAction: offers.logAction, outbox });
    const votes = createVotes({ config, store, reads, hotness, limits, flags, people, outbox });
    const listings = createListings({ store });
    const importer = createImporter({ config, store, reads, catalog, offers, indexing, sources, log });
    // Crowdfunding discovery (domain/campaigns.js): Sources' crowdfunding items through the same chassis, its own cursor.
    const campaigns = require('./domain/campaigns').createCampaigns({
        store, log, sources: config.sources.enabled ? createSourcesClient({ config: { ...config, sources: { ...config.sources, category: 'crowdfunding' } }, fetchImpl }) : null,
    });
    const sso = opts.sso || createSsoClient({
        site: 'deals', baseUrl: config.baseUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri, scope: config.oauth.scope,
        networkUrl: config.networkUrl, networkInternalUrl: config.networkInternalUrl,
        issuer: config.issuer || config.networkUrl, secureCookies: config.cookies.secure, relatedPasskeys: true, log,
    });
    const auth = opts.auth || sso;
    const jwksUrl = `${config.networkInternalUrl}/api/.well-known/jwks`;
    const viewers = createViewerResolver({ auth, config, people });
    const worker = createWorker({ config, store, offers, hotness, indexing, listings, importer, campaigns, limits, log });

    // Account export and deletion (ADR-033, domain/account-data.js), pushed to Network's internal routes with this service's
    // own client-credentials token; a test injects a stand-in through opts.accountSend.
    const accountData = accountDataLib.create({ db: store.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : null);

    // D11 owner settings (deals.data_sources): created before the app mounts /internal/config. A failure leaves
    // Deals serving (the Woot key falls back to the environment) and says why in the log.
    let settings = null;
    if (opts.settings) settings = opts.settings;
    else {
        try {
            const made = settingsLib.createSettings({ db: store.db, env: opts.env || process.env, log });
            await made.ready;
            settings = settingsLib.activate(made);
        } catch (err) {
            log.warn('[OpenVibe.Deals] owner settings unavailable, the data-source keys fall back to the environment:', err && err.message);
        }
    }

    const ctx = { config, store, settings, outbox, people, community, sources, reads, catalog, publication, indexing, hotness, watches, sharing, limits, access, offers, flags, votes, listings, importer, campaigns, auth, viewers, worker, indexnow, accountData, accountSend };

    const app = express();
    // GET /openapi.json (SEO-3): this service's public API as OpenAPI 3.1, generated from the contracts
    // (openvibe-contracts); the operations they mark internal-only are left out.
    app.get('/openapi.json', (_req, res) => {
        const doc = require('openvibe-contracts').openapi.document('deals');
        if (!doc) return res.status(404).type('text/plain').send('No API document.');
        const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
        const paths = {};
        for (const [p, item] of Object.entries(doc.paths || {})) {
            const kept = {};
            for (const [k, op] of Object.entries(item || {})) {
                if (!METHODS.has(k)) { kept[k] = op; continue; }
                const vis = [].concat((op && op['x-openvibe-visibility']) || []);
                if (vis.length && vis.every((v) => v === 'internal')) continue;
                kept[k] = op;
            }
            if (Object.keys(kept).some((k) => METHODS.has(k))) paths[p] = kept;
        }
        res.set('Cache-Control', 'public, max-age=3600').set('Access-Control-Allow-Origin', '*').json({ ...doc, paths });
    });
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'deals', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'deals', release: release.release });
    app.locals.metrics = metrics.registry;
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each flush, stored in this service's telemetry_samples table; /shared, health, readiness and /metrics make
    // none. server/index.js flushes it every minute and on stop, and keeps the table to 14 days.
    ctx.telemetry = createHttpTelemetry({ service: 'deals', sink: opts.telemetrySink || createPgTelemetrySink({ db: store.db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    app.use(ctx.telemetry.middleware());
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
                // Cloudflare Web Analytics: the edge injects its beacon into every page (as on Wiki and Live).
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https:'],
                // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                // The navbar's Messages count asks Chat (openvibe-shared 4.130.0).
                connectSrc: ["'self'", 'https://openvibe.chat', 'https://openvibe.network', 'https://openvibe.events', 'https://cloudflareinsights.com'],
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
    // /auth/me is the navbar's who-is-signed-in read on every page, so it is not counted with sign-ins: 60 page views in 15 minutes made a signed-in visitor look signed out.
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, skip: (req) => req.path === '/me', standardHeaders: true, legacyHeaders: false }));
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

    // ── D11 owner settings (openvibe-shared/config): Network's admin proxy, acting for the owner, reads and
    // writes deals.data_sources (the Woot API key). Loopback only, guarded by deals.config.manage; a secret change
    // needs X-OV-Fresh: 1, and the test route reads one deal without echoing the key.
    if (settings) {
        const configGuard = async (req, res, next) => {
            if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) {
                return res.status(404).json({ code: 'deals.not_found', error: 'no such route' });
            }
            const header = String(req.headers.authorization || '');
            if (!header.startsWith('Bearer ')) return res.status(401).json({ code: 'token.missing', error: 'a service token is required' });
            const r = await verifyServiceToken(header.slice(7).trim(), {
                jwks: `${config.networkInternalUrl}/api/.well-known/jwks`, issuer: config.networkUrl, audience: 'openvibe.deals',
                contracts: require('openvibe-contracts'),
            });
            if (!r.ok) return res.status(r.code === 'token.unavailable' ? 503 : 401).json({ code: r.code, error: r.reason || 'the token does not verify' });
            const contracts = require('openvibe-contracts');
            const decision = contracts.capabilities.check(r.claims, 'deals.config.manage');
            const granted = decision.allowed || contracts.capabilities.grants(r.claims.cap, 'deals.config.manage');
            if (!granted) return res.status(403).json({ code: 'capability.denied', error: 'deals.config.manage is not granted' });
            req.principal = { sub: r.claims.sub, cap: r.claims.cap, jti: r.claims.jti };
            return next();
        };
        app.use('/internal/config', express.json({ limit: '64kb' }));
        settings.mount(app, { guard: configGuard, log });
    }
    // ── /api/v1/watch/:id/share — the one Share sheet's API (openvibe-sdk/share) ──
    // GET/PUT .../share, .../share/requests, .../share/transfer[/accept|decline|cancel], GET /api/v1/share/people
    // and /api/v1/shared-with-me. Access is still decided by canView on every read path; the router answers only
    // its own paths.
    {
        const shareApi = express.Router();
        shareApi.use(ctx.viewers.middleware());
        shareApi.use(ctx.sharing.shares.router({
            service: 'deals',
            authenticate: (req) => ctx.sharing.shareViewer(req.viewer),
            describe: ctx.sharing.describe,
        }));
        const SHARE_PATH = /^\/api\/v1\/(?:shared-with-me$|share\/people$|[^/]+\/[^/]+\/share(?:\/|$))/;
        app.use((req, res, next) => (SHARE_PATH.test(req.path) ? shareApi(req, res, next) : next()));
    }
    // Expire members and transfers and send queued share events/notifications. Unref'd: it never holds a test open.
    if (opts.startSharingWorker !== false) {
        const timer = setInterval(() => { ctx.sharing.work().catch(() => { /* logged inside */ }); }, 15_000);
        if (timer.unref) timer.unref();
        app.locals.sharingTimer = timer;
    }
    app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }), createApi(ctx));

    // ── Discovery, public pages ─────────────────────────────
    app.use(createDiscoveryRoutes(ctx));
    const pages = createPages(ctx);
    // The worker keeps the shared page builds (the front page and /hot's first page) warm before
    // their windows close, so no visitor fills them (server/worker.js); it stays off in tests and
    // restore drills with DEALS_WORKER=off.
    ctx.worker.warm(pages.warm);
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json and the Markdown twins of the public
    // pages. The pages themselves keep their own routes — a signed-in visitor's vote buttons and account bar are
    // theirs — so only the manifest and twin requests reach this mount; the pages advertise the twin themselves.
    const agentLayer = express();
    require('openvibe-shared/agent-layer').mount(agentLayer, {
        descriptor: require('./agent-descriptor'),
        render: require('./agent-pages').createAgentPages(ctx, pages.publicViews).renderPublicPage,
    });
    app.use((req, res, next) => {
        const twin = req.path.endsWith('.md') || req.query.format === 'markdown' || String(req.headers.accept || '').includes('text/markdown');
        if (req.path !== '/.well-known/agent.json' && !twin) return next();
        return agentLayer(req, res, next);
    });
    const formLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
    app.use(['/submit', '/watches', '/mod', '/d/:slug/:action'], (req, res, next) => (req.method === 'POST' ? formLimit(req, res, next) : next()));
    app.use(require('./http/crowdfunding').createCrowdfundingRoutes(ctx));
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
