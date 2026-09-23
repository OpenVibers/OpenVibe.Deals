'use strict';

/**
 * Crawl and machine-readability artifacts (roadmap §32.4/§32.5):
 *
 *   GET /robots.txt             sitemap location + explicit automated-consumer policy
 *   GET /llms.txt               orientation for language models
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

function createDiscoveryRoutes({ config, store, publication, listings }) {
    const router = express.Router();
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const xml = (res, body) => res.type('application/xml').set('Cache-Control', 'public, max-age=300').send(body);

    function offerEntries() {
        return listings.indexable().map((o) => {
            const v = publication.offerView(o);
            return { loc: abs(publication.offerPath(o)), lastmod: v.latest ? Math.max(v.latest.observed_at, o.updated_at) : o.updated_at, decision: v.decision };
        });
    }
    function productEntries() {
        return listings.products().map((p) => {
            const pv = publication.productView(p);
            return { loc: abs(publication.productPath(p)), lastmod: pv.freshestObservedAt || undefined, decision: pv.decision };
        });
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
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(body);
    });

    router.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(sharedSeo.llmsTxt({
            name: 'OpenVibe.Deals',
            summary: 'Deals submitted and voted on by the OpenVibe community or imported from registered sources, with the source and observation time of every price.',
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

    router.get('/sitemap.xml', (_req, res) => {
        const o = offerEntries().filter((e) => e.decision.indexable).map((e) => e.lastmod);
        const p = productEntries().filter((e) => e.decision.indexable).map((e) => e.lastmod).filter(Boolean);
        const iso = (list) => (list.length ? { lastmod: new Date(Math.max(...list)).toISOString() } : {});
        xml(res, seo.sitemapIndex([{ loc: abs('/sitemaps/offers.xml'), ...iso(o) }, { loc: abs('/sitemaps/products.xml'), ...iso(p) }]));
    });

    router.get('/sitemaps/offers.xml', (_req, res) => xml(res, seo.sitemap(offerEntries()).files[0]));
    router.get('/sitemaps/products.xml', (_req, res) => xml(res, seo.sitemap(productEntries()).files[0]));

    return router;
}

module.exports = { createDiscoveryRoutes };
