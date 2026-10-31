'use strict';

/**
 * The front page (/): what OpenVibe.Deals is for, then sections of real deals, shops, categories and campaigns, then
 * how it works and the questions people ask. Every section is built from rows the page passes; a section with nothing
 * to show renders nothing (never an empty shell or a "coming soon").
 *
 * Wording rules (as in views.js): a price is always shown with the time it was seen; a stale one says it may be gone;
 * an unknown one says "not stated". Nothing here calls a price "current". A source's required attribution
 * ("via DealNews") is on every card that shows its deal.
 */
const { html, raw } = require('openvibe-publishing/ssr');
const showcase = require('openvibe-shared/showcase');
const { ago, when, priceText } = require('./views');
const { campaignCard } = require('../http/crowdfunding');
const { pickBlock, foldBlock } = require('./short');

const count = (n) => Number(n).toLocaleString('en-US');
const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

/** "$59.00" for a stated price in a known currency; views' wording otherwise. */
function money(o) {
    if (!o || o.price == null || !o.currency) return null;
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: o.currency }).format(Number(o.price)); } catch { return null; }
}

/** "in 5 hours" / "in 3 days" until a stated end. */
function until(ms, now) {
    const h = Math.max(0, (ms - now) / 3600000);
    if (h < 1) return 'within the hour';
    if (h < 36) return `in ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
    const d = Math.round(h / 24);
    return `in ${d} day${d === 1 ? '' : 's'}`;
}

const timeAgo = (ms, now) => html`<time datetime="${new Date(ms).toISOString()}" title="${when(ms)}">${ago(ms, now)}</time>`;

/** When the card's price was seen: fresh, stale (may be gone) or never. */
function seenBadge(v) {
    const f = v.freshness;
    if (f.state === 'fresh') return html`<span class="badge fresh" data-freshness="fresh">seen ${timeAgo(v.latest.observed_at, v.now)}</span>`;
    if (f.state === 'stale') return html`<span class="badge stale" data-freshness="stale">last seen ${timeAgo(v.latest.observed_at, v.now)}, may be gone</span>`;
    return html`<span class="badge stale" data-freshness="unobserved">no price seen yet</span>`;
}

/** One deal as a card (publication.cardView). */
function card(v, urls, { ends = false } = {}) {
    const r = v.root;
    const o = v.latest;
    const shown = money(o);
    const price = shown
        ? html`<strong class="price" data-price="${o.price}">${shown}</strong>`
        : o && o.price != null ? html`<strong class="price" data-price="${o.price}">${priceText(o)}</strong>` : html`<span class="price price-none">Price not stated</span>`;
    // An aggregator's own domain (the store of a verbatim DealNews link) is not "where it is sold": the seller is.
    const where = r.seller ? html`at <a href="${urls.sellerPath(r.seller)}">${r.seller}</a>`
        : v.store && !v.attribution ? html`at <a href="${urls.storePath(v.store)}">${v.store.name || v.store.domain}</a>` : '';
    const via = v.attribution ? html`via <a href="${safeHref(v.attribution.url)}" rel="nofollow noopener">${v.attribution.text}</a>` : '';
    return html`<li class="hm-card">
<h3><a href="${urls.offerPath(r)}">${r.title}</a></h3>
<p class="hm-price">${price} ${seenBadge(v)}</p>
${ends && r.expires_at ? html`<p class="hm-ends">Ends <time datetime="${new Date(r.expires_at).toISOString()}" title="${when(r.expires_at)}">${until(r.expires_at, v.now)}</time> <span class="meta">(as the source states it)</span></p>` : ''}
${where || via ? html`<p class="meta hm-where">${where}${where && via ? ' · ' : ''}${via}</p>` : ''}
</li>`;
}

/** A titled section with an optional "see all" link; nothing when it has no body. */
function section({ id, title, lede, more, body }) {
    if (!body) return '';
    return html`<section class="hm-sec" aria-labelledby="${id}">
<div class="hm-head"><h2 id="${id}">${title}</h2>${more ? html`<a class="hm-more" href="${more.href}">${more.label}<span aria-hidden="true"> →</span></a>` : ''}</div>
${lede ? html`<p class="hm-lede">${lede}</p>` : ''}
${raw(String(body))}
</section>`;
}

const cards = (list, urls, opts) => (list.length ? html`<ol class="hm-cards">${list.map((v) => card(v, urls, opts))}</ol>` : '');

/** Chips: [{ label, href, n }] → a wrapped list of links with their counts. */
function chips(list, noun) {
    if (!list.length) return '';
    return html`<ul class="hm-chips">${list.map((x) => html`<li><a href="${x.href}">${x.label}<span class="hm-n"><span class="sr">: </span>${count(x.n)}<span class="sr"> ${x.n === 1 ? noun : `${noun}s`}</span></span></a></li>`)}</ul>`;
}

/** The numbers under the hero, each a link to the list it counts. Zero counts are left out. */
function stats(items) {
    const shown = items.filter((x) => x.n > 0);
    if (!shown.length) return '';
    return html`<ul class="hm-stats" aria-label="OpenVibe.Deals in numbers">${shown.map((x) => html`<li><a href="${x.href}"><b>${count(x.n)}</b><span>${x.label}</span></a></li>`)}</ul>`;
}

/** Questions people ask, answered from how the site works (also the page's FAQPage JSON-LD). */
function faqItems({ freshnessHours }) {
    return [
        { q: 'Where do the deals come from?', a: 'Two places: DealNews, whose editors publish deals in a public feed that OpenVibe.Sources reads every hour, and people who post deals here with their OpenVibe account. Every deal page lists its sources and links to the original.' },
        { q: 'Is the price still right?', a: `Every price is an observation with the time it was seen. When the newest one is more than ${freshnessHours} hours old, the deal is marked stale and its price is shown as history, not as the price now. Check the store's page before you buy, and if it changed, report what you see on the deal's page.` },
        { q: 'Why does a deal say "Price not stated"?', a: 'Some deals are store-wide sales with no single price, and Deals never reads a price out of a headline. It shows a price only when a source or a person states one.' },
        { q: 'Do you change the store links?', a: 'Links people post are cleaned of tracking and affiliate tags. Links from DealNews are kept exactly as DealNews publishes them, as its feed terms require, and each of its deals says "via DealNews".' },
        { q: 'How do watches work?', a: 'Sign in, then watch some words, a product or a price limit. When a new price matches, you get one notification through your OpenVibe account. A saved search runs again whenever you open it and never notifies.' },
        { q: 'What does it cost?', a: 'Nothing. Anyone can read the deals; posting, voting, comments and watches need a free OpenVibe account.' },
    ];
}

function faqJsonLd(items) {
    return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) };
}

/**
 * d: { stats: { active, shops, seenDay, endingWeek, categories, campaigns }, picks, upvoted, latest, ending, under,
 *      underLimit: { amount, currency }, categories: [{ category, slug, count }], sellers: [{ seller, slug, count }],
 *      campaigns: [row], freshnessHours, empty }
 * (card lists are publication.cardView results)
 */
function homePage(d, urls) {
    const hero = html`<section class="sc-hero sc-split hm-hero"><div class="sc-hero-main">
<p class="sc-eyebrow">OpenVibe.Deals</p>
<h1>Today's deals,<span class="sc-accent"> with the time every price was seen</span></h1>
<p class="sc-hero-lede">Deals from DealNews' editors and from the OpenVibe community, by shop, category and end date. Every price says when it was seen, and an old one says it may be gone.</p>
<form class="hm-search" action="/search" method="get" role="search"><label class="sr" for="hm-q">Search deals</label><input id="hm-q" name="q" type="search" maxlength="100" placeholder="Search deals, like air fryer or lululemon"><button type="submit">Search</button></form>
<div class="sc-actions"><a class="sc-btn sc-primary" href="/new">See the newest deals</a><a class="sc-btn" href="/submit">Post a deal</a></div>
</div>
<div class="sc-hero-aside">${stats([
        { n: d.stats.active, label: 'active deals', href: '/new' },
        { n: d.stats.shops, label: 'shops', href: '/at' },
        { n: d.stats.seenDay, label: 'prices seen in the last 24 hours', href: '/new' },
        { n: d.stats.endingWeek, label: 'ending in the next 7 days', href: '/ending' },
        { n: d.stats.categories, label: 'categories', href: '/c' },
        { n: d.stats.campaigns, label: 'crowdfunding campaigns tracked', href: '/crowdfunding' },
    ])}</div></section>`;

    const shopLinks = d.sellers.slice(0, 18).map((x) => ({ label: x.seller, href: `/at/${x.slug}`, n: x.count }));
    const catLinks = d.categories.slice(0, 24).map((x) => ({ label: x.category, href: `/c/${x.slug}`, n: x.count }));
    let under = null;
    try { under = d.underLimit ? new Intl.NumberFormat('en-US', { style: 'currency', currency: d.underLimit.currency, maximumFractionDigits: 0 }).format(d.underLimit.amount) : null; } catch { under = null; }

    // The home's two pick blocks, one at a time on a phone (the owner's short-pages rule, 2026-10-30): the chips pick
    // one of the sections and every section stays in the page for crawlers.
    const dealPanes = [
        { id: 'd-picks', label: 'Picks', html: section({ id: 'hm-picks', title: 'Editors\' picks', lede: 'Deals DealNews\' editors marked as their picks, newest first.', more: { href: '/picks', label: 'All picks' }, body: cards(d.picks, urls) }) },
        { id: 'd-hot', label: 'Hot', html: section({ id: 'hm-hot', title: 'Hot right now', lede: 'Voted up by people on OpenVibe, hottest first.', more: { href: '/hot', label: 'All hot deals' }, body: cards(d.upvoted, urls) }) },
        { id: 'd-new', label: 'Just in', html: section({ id: 'hm-new', title: 'Just in', lede: 'The newest deals from every source.', more: { href: '/new', label: 'All new deals' }, body: cards(d.latest, urls) }) },
        { id: 'd-ending', label: 'Ending soon', html: section({ id: 'hm-ending', title: 'Ending soon', lede: 'Deals whose stated end is in the next seven days, soonest first.', more: { href: '/ending', label: 'Everything ending soon' }, body: cards(d.ending, urls, { ends: true }) }) },
        { id: 'd-under', label: `Under ${under || 'the limit'}`, html: under ? section({ id: 'hm-under', title: `Under ${under}`, lede: `Deals with a stated price of ${under} or less, seen in the last ${d.freshnessHours} hours.`, body: cards(d.under, urls) }) : '' },
    ];
    const browsePanes = [
        { id: 'd-categories', label: 'Categories', html: section({ id: 'hm-categories', title: 'Browse by category', lede: 'Categories as each deal\'s source names them, the most deals first.', more: { href: '/c', label: 'All categories' }, body: chips(catLinks, 'deal') }) },
        { id: 'd-shops', label: 'Shops', html: section({ id: 'hm-shops', title: 'Shop by store', lede: 'Where the deals are sold, as their sources name the shop.', more: { href: '/at', label: `All ${count(d.sellers.length)} shops` }, body: chips(shopLinks, 'deal') }) },
        { id: 'd-crowdfunding', label: 'Crowdfunding', html: section({ id: 'hm-crowdfunding', title: 'Crowdfunding', lede: 'Open-source and community campaigns from Open Collective with what they received, plus one search across Kickstarter, Indiegogo, GoFundMe and more.', more: { href: '/crowdfunding', label: 'Search crowdfunding' }, body: d.campaigns.length ? html`<ol class="cf-grid hm-cf">${d.campaigns.map(campaignCard)}</ol>` : '' }) },
    ];

    return html`${hero}
${d.empty ? html`<p class="empty hm-empty">No deals have been posted yet. <a href="/submit">Submit the first one</a>.</p>` : ''}
${raw(pickBlock({ key: 'deals', label: 'The deals', head: 'The deals', panes: dealPanes }))}
${raw(pickBlock({ key: 'browse', label: 'Ways to browse', head: 'Ways to browse', panes: browsePanes }))}
<details class="hm-fold" open><summary>How it works<span>prices, votes, shops, watches</span></summary>${raw(showcase.features({
        lede: 'A deal is a link, a title and every price anyone saw for it, each with its source and time.',
        items: [
            { icon: 'ov:history', title: 'Prices with their time', text: 'Each deal keeps every price it was seen at, newest first, each with its source. Nothing is called current without a fresh one.', href: '/new' },
            { icon: 'ov:check', title: 'Votes decide what is hot', text: 'One vote per person, counted on the server. A deal page shows its hotness with the formula and the inputs.', href: '/hot' },
            { icon: 'ov:search', title: 'By shop and category', text: 'Every deal is filed under the shop that sells it and the category its source gives it.', href: '/at' },
            { icon: 'ov:bell', title: 'Watches and saved searches', text: 'Watch words, a product or a price limit for new prices that match, or save a search to run again.', href: '/watches' },
        ],
    }))}</details>
${raw(foldBlock({
        id: 'hm-faq',
        head: '<h2 id="hm-faq-h">Questions and answers</h2>',
        html: html`<section class="hm-sec" aria-labelledby="hm-faq-h"><div class="hm-head"><h2>Questions and answers</h2></div><div class="hm-faq">${d.faq.map((x) => html`<details><summary>${x.q}</summary><p>${x.a}</p></details>`)}</div></section>`,
    }))}
${raw(foldBlock({
        id: 'hm-network',
        head: '<h2 id="hm-network-h">Part of OpenVibe</h2>',
        html: showcase.network({ service: 'deals' }),
    }))}`;
}

/**
 * The rules that show the picked pane of the home's two pick blocks: one per pane, written for this page.
 */
function paneRules(d) {
    const ids = (panes) => panes.filter((p) => p.html).map((p) => p.id);
    const under = (() => { try { return d.underLimit ? new Intl.NumberFormat('en-US', { style: 'currency', currency: d.underLimit.currency, maximumFractionDigits: 0 }).format(d.underLimit.amount) : null; } catch { return null; } })();
    const dealIds = ['d-picks', 'd-hot', 'd-new', 'd-ending', under ? 'd-under' : null].filter(Boolean);
    const browseIds = ['d-categories', 'd-shops', 'd-crowdfunding'];
    return '';
}

module.exports = { homePage, paneRules, faqItems, faqJsonLd, card, money };
