'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-publishing/layout (openvibe-shared/shell
 * page()) and is complete without JavaScript:
 *   - <head>: title, description, canonical and robots from the indexability gate's decision
 *     (there is no default that makes a page indexable), Open Graph/Twitter, JSON-LD, prev/next,
 *     feed links, the shared app icon, the site stylesheet and the boost marker
 *   - the OpenVibe Frame: theme-loader, web runtime, navbar and footer from the Network
 *     (progressive), a <noscript> navigation bar and the server-rendered shared footer
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const layout = require('openvibe-publishing/layout');
const frame = require('openvibe-shared/frame');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Deals';
// One site summary, shared by /llms.txt, /llms-full.txt and the home page's ai-summary.
const SITE_SUMMARY = 'Deals submitted and voted on by the OpenVibe community or imported from registered sources, with the source and observation time of every price.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV_LINKS = [
    { label: 'Hot', href: '/' },
    { label: 'New', href: '/new' },
    { label: 'Submit', href: '/submit', icon: 'fa-plus' },
    { label: 'Watches', href: '/watches', icon: 'fa-bell' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, decision (required), canonical, type ('website'|'article'), image,
 *    jsonLd [], feeds [{ type, href, title }], body (HTML), viewer, config, prev, next, bodyClass,
 *    summary (one-line AI summary → ai-summary meta + WebPage JSON-LD), facts, updated, url
 */
function renderPage(o) {
    if (!o.decision) throw new TypeError('renderPage needs the gate decision');
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const loginNext = encodeURIComponent(o.path || '/');
    const nav = {
        service: 'deals',
        apiBase: NETWORK_URL,
        links: NAV_LINKS,
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: (viewer.staff ? [{ label: 'Moderation', href: '/mod', icon: 'fa-shield' }] : []) };
    const footer = { service: 'deals', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
    const account = signedIn
        ? `${viewer.staff ? '<a href="/mod">Moderation</a> · ' : ''}<a href="/watches">Watches</a> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    return layout.renderDocument({
        site: 'deals',
        siteName: SITE_NAME,
        lang: o.lang,
        title: o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME,
        description: o.description || 'Deals submitted and voted on by the community, with source, price and freshness always shown.',
        canonical: o.canonical,
        decision: o.decision,
        summary: o.summary,
        facts: o.facts,
        updated: o.updated,
        url: o.url,
        type: o.type || 'website',
        image: o.image,
        jsonLd: o.jsonLd,
        feeds: o.feeds,
        prev: o.prev,
        next: o.next,
        navbar: nav,
        footer,
        navLinks: NAV_LINKS.map(({ label, href }) => ({ label, href })),
        home: '/',
        css: asset('css/deals.css'),
        release: RELEASE,
        account,
        body: o.body,
        shipped: o.path === '/' ? frame.shipped({ service: 'deals', title: `Recently shipped on ${SITE_NAME}` }) : '',
        bodyClass: o.bodyClass,
    });
}

module.exports = { renderPage, asset, assetVersion, setRelease, SITE_NAME, SITE_SUMMARY, NETWORK_URL };
