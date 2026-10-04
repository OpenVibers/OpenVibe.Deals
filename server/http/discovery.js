'use strict';

/**
 * Crawl and machine-readability artifacts (roadmap §32.4/§32.5):
 *
 *   GET /robots.txt             sitemap location + explicit automated-consumer policy
 *   GET /llms.txt               orientation for language models
 *   GET /llms-full.txt          the same header plus a short summary of every indexable deal (never
 *                               the full source text)
 *   GET /sitemap.xml            sitemap index over the sections below
 *   GET /sitemaps/offers.xml    offers the gate calls indexable RIGHT NOW (fresh observation, not
 *                               expired, reviewed where review is needed); lastmod = the latest
 *                               observation or edit, never "now"
 *   GET /sitemaps/products.xml  product pages with at least one fresh offer
 *
 * Built from the database on every request, never from the viewer. Stale, expired, disabled,
 * merged and unreviewed offers never appear.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const sharedSeo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { SITE_SUMMARY } = require('../render/layout');

function createDiscoveryRoutes({ config, store, publication, listings }) {
    const router = express.Router();
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const xml = (res, body) => res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(body);
    /** A short, whitespace-collapsed summary; the full source text is never included. */
    const brief = (value, max = 200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

    async function offerEntries() {
        return Promise.all((await listings.indexable()).map(async (o) => {
            const v = await publication.offerView(o);
            return { offer: o, view: v, loc: abs(publication.offerPath(o)), lastmod: v.latest ? Math.max(v.latest.observed_at, o.updated_at) : o.updated_at, decision: v.decision };
        }));
    }
    async function productEntries() {
        return Promise.all((await listings.products()).map(async (p) => {
            const pv = await publication.productView(p);
            return { loc: abs(publication.productPath(p)), lastmod: pv.freshestObservedAt || undefined, decision: pv.decision };
        }));
    }

    router.get('/robots.txt', (_req, res) => {
        const body = [
            '# openvibe.deals automated-consumer policy: search engines and AI crawlers are welcome to read',
            '# public deal, product and store pages, feeds and sitemaps. Prices are observations with times;',
            '# read the "as of" time and the JSON twin (<deal URL>.json) rather than assuming a price is current.',
            '# Forms, sign-in, moderation and the API are not for crawling. Pages decide their own',
            '# indexability (meta robots / X-Robots-Tag): stale or expired deals are noindex. A Disallow is not a noindex.',
            sharedSeo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/submit', '/watches', '/mod', '/search', '/auth/', '/api/', '/internal/'] }),
        ].join('\n');
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(body);
    });

    router.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Deals',
            summary: SITE_SUMMARY,
            details: 'A price on this site is an observation: it has a source and an observed_at time, and it is only claimed "as of" that time. Offers whose latest observation is older than the freshness window are marked stale and are noindex; expired offers are noindex; a price nobody stated is shown as "not stated" and omitted from structured data (never 0). Every deal page has a JSON twin at <deal URL>.json with the full observation history, sources, votes and indexability reasons. Imported and AI-assisted text is noindex until a person reviews it.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'Hot deals', url: abs('/') }, { title: 'New deals', url: abs('/new') }, { title: 'Sitemap', url: abs('/sitemap.xml') },
                ] },
                { title: 'Feeds', links: [{ title: 'RSS', url: abs('/feed.xml') }, { title: 'Atom', url: abs('/atom.xml') }, { title: 'JSON Feed', url: abs('/feed.json') }] },
                { title: 'Data', links: [
                    { title: 'Deal JSON', url: abs('/new'), note: 'append .json to any deal URL (/d/<slug>.json)' },
                    { title: 'Product JSON', url: abs('/sitemaps/products.xml'), note: 'append .json to any product URL (/p/<slug>.json)' },
                ] },
            ],
        }));
    });

    router.get('/llms-full.txt', async (_req, res) => {
        // The sitemap's gate (indexable RIGHT NOW), each entry as a short summary — the full source
        // text behind an imported deal is never included, and neither is an observation we cannot state.
        const entries = await offerEntries();
        const pages = [];
        for (const e of entries) {
            if (!e.decision.indexable) continue;
            const v = e.view;
            const price = v.latest ? `${v.latest.price} ${v.latest.currency}` : '';
            const text = [brief(v.root.description), price, v.store ? `at ${v.store.name || v.store.domain}` : ''].filter(Boolean).join(' ');
            pages.push({ title: v.root.title, url: e.loc, text });
        }
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsFull({
            site: 'OpenVibe.Deals',
            summary: SITE_SUMMARY,
            base: config.baseUrl,
            maxBytes: 512 * 1024,
            sections: [{ title: 'Deals', pages }],
        }));
    });

    router.get('/sitemap.xml', async (_req, res) => {
        const o = (await offerEntries()).filter((e) => e.decision.indexable).map((e) => e.lastmod);
        const p = (await productEntries()).filter((e) => e.decision.indexable).map((e) => e.lastmod).filter(Boolean);
        const iso = (list) => (list.length ? { lastmod: new Date(Math.max(...list)).toISOString() } : {});
        xml(res, seo.sitemapIndex([{ loc: abs('/sitemaps/offers.xml'), ...iso(o) }, { loc: abs('/sitemaps/products.xml'), ...iso(p) }]));
    });

    router.get('/sitemaps/offers.xml', async (_req, res) => xml(res, seo.sitemap(await offerEntries()).files[0]));
    router.get('/sitemaps/products.xml', async (_req, res) => xml(res, seo.sitemap(await productEntries()).files[0]));

    return router;
}

module.exports = { createDiscoveryRoutes };
