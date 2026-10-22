'use strict';
/**
 * Crowdfunding discovery on openvibe.deals (server/domain/campaigns.js):
 *
 *   GET /crowdfunding?q=&sort=      every platform's search at once for your words, and the campaigns OpenVibe.Sources
 *                                   collected (Open Collective), by contributors, newest or most received
 *   GET /crowdfunding.json?q=&sort= the same as data (CORS *)
 *
 * The page without words is indexable (the platform list is ours); a search is noindex. Amounts are "as of" when
 * Sources fetched them. Campaign links leave with rel="nofollow noopener".
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const cache = require('openvibe-shared/cache-policy');
const ssr = require('openvibe-publishing/ssr');
const { renderPage } = require('../render/layout');

const { html, raw, paginationHtml } = ssr;
const PER_PAGE = 24;
const SORT_LABEL = { backers: 'Most contributors', new: 'Newest', raised: 'Most received' };

const pad = (n) => String(n).padStart(2, '0');
const day = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
function money(cents, currency) {
    if (cents == null || !currency) return null;
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100); } catch { return null; }
}
const count = (n) => Number(n).toLocaleString('en-US');
const KIND = { COLLECTIVE: 'Collective', PROJECT: 'Project', FUND: 'Fund' };

function campaignCard(c) {
    const raised = money(c.raised_cents, c.currency);
    const budget = c.budget_cents ? money(c.budget_cents, c.currency) : null;
    const facts = [raised ? `${raised} received to date` : null, c.backers ? `${count(c.backers)} contributor${c.backers === 1 ? '' : 's'}` : null, budget ? `${budget} a year` : null].filter(Boolean);
    return html`<li class="card cf-campaign">
<h3><a href="${c.url}" rel="nofollow noopener">${c.name}</a></h3>
<p class="meta">${c.platform}${c.kind && KIND[c.kind] ? html` · ${KIND[c.kind]}` : ''}${c.tag ? html` · #${c.tag}` : ''}</p>
${c.summary ? html`<p>${c.summary.length > 220 ? `${c.summary.slice(0, 217)}…` : c.summary}</p>` : ''}
${facts.length ? html`<p class="meta">${facts.join(' · ')} <span class="cf-asof">(as of ${day(c.observed_at)})</span></p>` : ''}
</li>`;
}

/** /crowdfunding with these words, sort and page (defaults left out). */
function pageUrl({ q, sort, page }) {
    const s = new URLSearchParams({ ...(q ? { q } : {}), ...(sort && sort !== 'backers' ? { sort } : {}), ...(page > 1 ? { page: String(page) } : {}) }).toString();
    return s ? `/crowdfunding?${s}` : '/crowdfunding';
}

function body({ q, sort, groups, list, pager }) {
    const tab = (key) => (key === sort ? html`<span aria-current="page">${SORT_LABEL[key]}</span>` : html`<a href="${pageUrl({ q, sort: key })}#campaigns">${SORT_LABEL[key]}</a>`);
    return String(html`<header class="cf-head"><h1>Crowdfunding, every platform at once</h1>
<p class="lede">Type what you are looking for once and open it on Kickstarter, Indiegogo, GoFundMe, Open Collective and the rest, then see the open-source and community campaigns OpenVibe tracks itself.</p>
<form class="search cf-search" action="/crowdfunding" method="get" role="search"><label class="sr" for="cf-q">What are you looking for?</label><input id="cf-q" name="q" type="search" value="${q || ''}" placeholder="e.g. solar charger, board game, open source" maxlength="120"><button type="submit">Search everywhere</button></form></header>
<section aria-labelledby="h-platforms"><h2 id="h-platforms">${q ? html`“${q}” on every platform` : 'The platforms'}</h2>
<div class="cf-groups">${groups.map((g) => html`<div class="card cf-group"><h3>${g.title}</h3><p class="meta">${g.note}</p><ul class="cf-links">${g.platforms.map((p) => html`<li><a class="button" href="${p.url}" rel="nofollow noopener" target="_blank">${p.name}</a></li>`)}</ul></div>`)}</div>
<p class="meta">Each link opens that site's own ${q ? 'search' : 'listings'}; OpenVibe reads nothing from them.</p></section>
<section aria-labelledby="h-campaigns" id="campaigns"><h2 id="h-campaigns">${q ? html`Campaigns OpenVibe tracks matching “${q}”` : 'Campaigns OpenVibe tracks'}</h2>
<p class="meta">From Open Collective's public data, refreshed every six hours. Amounts are what it stated when fetched.</p>
<nav class="tabs" aria-label="Sort">${['backers', 'new', 'raised'].map((k) => html`${tab(k)} `)}</nav>
${list.campaigns.length ? html`<ol class="cf-grid">${list.campaigns.map(campaignCard)}</ol>` : html`<p class="empty">${q ? 'None of the campaigns OpenVibe tracks match those words; try the platforms above.' : 'No campaigns collected yet.'}</p>`}
${raw(paginationHtml(pager))}</section>`);
}

function createCrowdfundingRoutes(ctx) {
    const { config, store, campaigns, viewers } = ctx;
    const router = express.Router();
    router.use(['/crowdfunding', '/crowdfunding.json'], viewers.middleware({ services: false }));
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    function params(req) {
        const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
        const sort = SORT_LABEL[req.query.sort] ? String(req.query.sort) : 'backers';
        const n = parseInt(req.query.page, 10);
        return { q, sort, page: Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 1 };
    }

    router.get('/crowdfunding.json', wrap(async (req, res) => {
        const { q, sort, page } = params(req);
        const list = await campaigns.list({ q, sort, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
        res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
        res.set('Access-Control-Allow-Origin', '*');
        res.set('X-Robots-Tag', 'noindex');
        res.json({
            q, sort, page, total: list.total,
            platforms: campaigns.platformLinks(q).flatMap((g) => g.platforms.map((p) => ({ ...p, group: g.id }))),
            campaigns: list.campaigns.map((c) => ({
                name: c.name, url: c.url, platform: c.platform, kind: c.kind, tag: c.tag, summary: c.summary, currency: c.currency,
                raised_cents: c.raised_cents, yearly_budget_cents: c.budget_cents, contributors: c.backers, started_at: c.started_at,
                observed_at: new Date(c.observed_at).toISOString(),
            })),
        });
    }));

    router.get('/crowdfunding', wrap(async (req, res) => {
        const { q, sort, page } = params(req);
        const list = await campaigns.list({ q, sort, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
        const pager = ssr.paginate({ page, perPage: PER_PAGE, total: list.total, href: (p) => pageUrl({ q, sort, page: p }) });
        const indexable = !q && sort === 'backers' && pager.page === 1;
        const decision = seo.evaluate({
            state: indexable ? 'published' : 'draft', visibility: indexable ? 'public' : 'private',
            canonicalUrl: seo.canonicalUrl(config.baseUrl, '/crowdfunding'), wordCount: 0,
        }, { policy: { minWords: 0 }, now: store.now() });
        res.vary('Cookie');
        res.vary('Authorization');
        res.set('Cache-Control', req.viewer.kind === 'anonymous' ? cache.htmlHeaders({ maxAge: 60 }) : cache.htmlHeaders({ private: true }));
        if (decision.robots !== 'index, follow') res.set('X-Robots-Tag', decision.robots);
        res.status(200).type('html').send(renderPage({
            title: q ? `“${q}” on every crowdfunding site` : 'Crowdfunding, every platform at once',
            description: 'Search Kickstarter, Indiegogo, GoFundMe, Open Collective, Crowd Supply, Patreon and more at once, and browse open-source and community campaigns with what they have raised.',
            decision, canonical: seo.canonicalUrl(config.baseUrl, '/crowdfunding'),
            prev: pager.prev ? pager.prev.href : null, next: pager.next ? pager.next.href : null,
            body: body({ q, sort, groups: campaigns.platformLinks(q), list, pager }),
            viewer: req.viewer, config, path: req.originalUrl,
        }));
    }));

    return router;
}

module.exports = { createCrowdfundingRoutes, campaignCard };
