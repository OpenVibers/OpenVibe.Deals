'use strict';

/**
 * Page bodies. Every value goes through openvibe-publishing/ssr's auto-escaping `html` template;
 * only this file's own markup is raw(). Pages work without JavaScript: every action is a form.
 *
 * Wording rules: a price is always "as of <time>"; a stale one says it may no longer be available;
 * an unknown one says "not stated". Nothing here calls a price "current".
 */
const { html, raw, renderMarkdown, paginationHtml, breadcrumbsHtml } = require('openvibe-publishing/ssr');
const { AVAILABILITY_LABEL, CONDITIONS, AVAILABILITY } = require('../domain/values');
const { savingOf } = require('../domain/price-trend');
const { remindLink } = require('./remind');

const pad = (n) => String(n).padStart(2, '0');
function when(ms) {
    if (ms == null) return '';
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
function ago(ms, now) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 90) return 'just now';
    const m = Math.round(s / 60);
    if (m < 90) return `${m} minutes ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} hours ago`;
    return `${Math.round(h / 24)} days ago`;
}
/** Only http(s) links are ever rendered as links (source URLs come from other services). */
const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const timeEl = (ms) => (ms == null ? '' : html`<time datetime="${new Date(ms).toISOString()}">${when(ms)}</time>`);

function priceText(o) {
    if (!o || o.price == null) return 'Price not stated';
    return o.currency ? `${o.price} ${o.currency}` : `${o.price} (currency not stated)`;
}
function shippingText(o) {
    if (!o) return '';
    if (o.shipping != null) return `+ ${o.shipping} ${o.currency || ''} shipping`.trim();
    return o.shipping_note || '';
}

/** The stated list price and the saving, only beside the price they belong to (no styling: the site's CSS does that). */
function listPriceLine(o) {
    if (!o || o.list_price == null || o.list_price_num == null) return '';
    const saving = savingOf(o);
    if (saving.pct == null) return '';
    return html` <s class="dl-list" data-list-price="${o.list_price}">${o.list_price}${o.currency ? ` ${o.currency}` : ''}</s> <span class="dl-saving">−${saving.pct}%</span>`;
}

function freshnessBadge(f, now) {
    if (f.state === 'fresh') return html`<span class="badge fresh" data-freshness="fresh">Fresh · observed ${ago(Date.parse(f.observed_at), now)}</span>`;
    if (f.state === 'stale') return html`<span class="badge stale" data-freshness="stale">Stale · last observed ${ago(Date.parse(f.observed_at), now)} — this may no longer be available</span>`;
    return html`<span class="badge stale" data-freshness="unobserved">No observation</span>`;
}

function statusBadge(root) {
    if (root.status === 'expired') return html`<span class="badge expired">Expired</span>`;
    if (root.status === 'disabled') return html`<span class="badge expired">Removed</span>`;
    return '';
}

const csrfField = (csrf) => html`<input type="hidden" name="csrf" value="${csrf}">`;

/**
 * The attribution line a source policy can require (e.g. DealNews' feed terms): "Deal via <source>"
 * linking to the source's site. Shown wherever the offer's content appears — cards, the offer page
 * and the product comparison. The link to the source never replaces or rewrites the offer's own link.
 */
function attributionLine(a) {
    if (!a) return '';
    return html`<p class="attribution">Deal via <a href="${safeHref(a.url)}" rel="nofollow noopener">${a.text}</a></p>`;
}

/** The one-line "latest observation" block used on cards and pages. */
function latestLine(v) {
    const o = v.latest;
    // A price nobody stated is said quietly: a headline-only source (DealNews' feed) states its price in the title.
    const stated = o && o.price != null;
    return html`<p class="price-line"><strong class="price${stated ? '' : ' price-none'}" data-price="${stated ? o.price : ''}">${priceText(o)}</strong>${listPriceLine(o)}
${o && shippingText(o) ? html` <span class="meta">${shippingText(o)}</span>` : ''}
${o && o.availability ? html` · <span class="meta">${AVAILABILITY_LABEL[o.availability]}</span>` : ''}
${o ? html` <span class="meta as-of">as of ${timeEl(o.observed_at)}</span>` : ''} ${freshnessBadge(v.freshness, v.now)}</p>`;
}

/**
 * The price over time as a line the size of a word (plan: market outcome 4): the stated prices of the offer's
 * currency, oldest to newest, its lowest point marked. Nothing when there is only one price.
 */
function sparkline(t) {
    if (!t || !Array.isArray(t.points) || t.points.length < 2) return '';
    const pts = t.points.slice(-24);
    const W = 104, H = 30, P = 3;
    const lo = Math.min(...pts.map((p) => p.num)), hi = Math.max(...pts.map((p) => p.num));
    const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
    const y = (n) => (hi === lo ? H / 2 : P + ((hi - n) * (H - 2 * P)) / (hi - lo));
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.num).toFixed(1)}`).join(' ');
    const li = pts.reduce((a, p, i) => (p.num < pts[a].num ? i : a), 0);
    const last = pts.length - 1;
    const label = `Price over ${t.count} observations: ${t.first.price} to ${t.latest.price}${t.currency ? ` ${t.currency}` : ''}, lowest ${t.lowest.price}`;
    return html`<figure class="dl-spark" data-points="${pts.length}"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}"><polyline points="${line}"/><circle class="lo" cx="${x(li).toFixed(1)}" cy="${y(pts[li].num).toFixed(1)}" r="2.4"/><circle class="now${t.atLowest ? ' at-low' : ''}" cx="${x(last).toFixed(1)}" cy="${y(pts[last].num).toFixed(1)}" r="2.6"/></svg>
<figcaption>${t.atLowest ? 'Lowest seen' : html`low ${t.lowest.price}`}</figcaption></figure>`;
}

/** What the people who voted said, and the band it puts the deal in (market outcome 5). */
function bandOf(v) {
    const r = v.root;
    if (r.staff_pick) return ['pick', 'Editors\' pick'];
    if (v.tally && v.tally.up >= 5) return ['popular', 'Popular'];
    if (r.created_at && v.now - Number(r.created_at) < 24 * 3_600_000) return ['new', 'New today'];
    return null;
}
function voteLine(v, href) {
    const t = v.tally || { up: 0, down: 0 };
    const band = bandOf(v);
    const said = t.up ? `${t.up} found this useful` : 'Be the first to rate it';
    return html`<p class="dl-vote"><a href="${href}#vote" class="dl-useful${t.up ? ' has' : ''}" title="${t.up} up, ${t.down} down"><span aria-hidden="true">▲</span> ${said}</a>${band ? html` <span class="dl-band dl-band--${band[0]}">${band[1]}</span>` : ''}</p>`;
}

/** The expiry a source stated, with how precise it was; never an assumed one (market outcome 3). */
function expiryLine(r, now) {
    if (r.status === 'expired') return '';
    if (r.expires_at == null) return html`<span class="dl-ends dl-ends--unknown">Expiry unknown</span>`;
    const at = Number(r.expires_at);
    const left = at - now;
    if (left <= 0) return html`<span class="dl-ends dl-ends--past">Stated to have ended ${timeEl(at)}</span>`;
    const soon = left < 48 * 3_600_000;
    const d = new Date(at);
    // A stated time at midnight UTC is a date, not a moment: say the day.
    const day = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
    const inWords = left < 90 * 60_000 ? `${Math.max(1, Math.round(left / 60_000))} minutes` : `${Math.round(left / 3_600_000)} hours`;
    return html`<span class="dl-ends${soon ? ' dl-ends--soon' : ''}">${soon ? `Ends in ${inWords}:` : 'Ends'} <time datetime="${d.toISOString()}">${day ? when(at).slice(0, 10) : when(at)}</time>${day ? ' (a date, no time stated)' : ''}</span>`;
}

/** When the price was seen and how much sits behind it (market outcome 2), in the card's own words. */
function seenLine(v) {
    const o = v.latest;
    if (!o) return html`<p class="dl-seen"><span class="badge stale" data-freshness="unobserved">No price seen yet</span></p>`;
    const n = v.trend ? v.trend.count : 1;
    const f = v.freshness || {};
    return html`<p class="dl-seen"><span class="dl-dot dl-dot--${f.state === 'fresh' ? 'fresh' : 'stale'}" data-freshness="${f.state || 'unobserved'}" aria-hidden="true"></span>${f.state === 'stale' ? 'Last seen' : 'Price seen'} <time datetime="${new Date(Number(o.observed_at)).toISOString()}" title="${when(Number(o.observed_at))}">${ago(Number(o.observed_at), v.now)}</time>${f.state === 'stale' ? ' — it may be gone' : ''} · ${n} price${n === 1 ? '' : 's'} on record${v.root.deal_reason === 'price_drop' ? ' · lowest so far' : ''}</p>`;
}

/** The price, the was-price struck through and the saving, shipping and stock (market outcome 1). */
function priceRow(v) {
    const o = v.latest;
    const stated = o && o.price != null;
    return html`<p class="price-line"><strong class="price${stated ? '' : ' price-none'}" data-price="${stated ? o.price : ''}">${priceText(o)}</strong>${listPriceLine(o)}
${o && shippingText(o) ? html` <span class="meta">${shippingText(o)}</span>` : ''}${o && o.availability ? html` <span class="meta">· ${AVAILABILITY_LABEL[o.availability]}</span>` : ''}</p>`;
}

function offerCard(v, urls) {
    const r = v.root;
    const href = urls.offerPath(r);
    // "Remind me" for the moment the deal ends (plan L48 R3): a quiet link beside the end the card states, only when
    // the end is stated and still ahead.
    const remind = remindLink(r, { now: v.now, shop: v.store ? (v.store.name || v.store.domain) : '', url: urls.abs ? urls.abs(href) : '' });
    return html`<li class="deal-item">
<div class="deal-body">
<h2 class="deal-title"><a href="${href}">${r.title}</a> ${statusBadge(r)}</h2>
${priceRow(v)}
${seenLine(v)}
${r.status === 'expired' ? '' : html`<p class="dl-when">${expiryLine(r, v.now)}${remind ? raw(remind) : ''}</p>`}
${attributionLine(v.attribution)}
<p class="meta">${r.seller ? html`<a class="seller" href="${urls.sellerPath ? urls.sellerPath(r.seller) : '#'}">at ${r.seller}</a> · ` : ''}${v.store ? html`<a href="${urls.storePath(v.store)}">${v.store.name || v.store.domain}</a> · ` : ''}${v.product ? html`<a href="${urls.productPath(v.product)}">${v.product.name}</a> · ` : ''}posted ${timeEl(r.created_at)}${r.origin === 'import' ? ' · imported from a source' : ''}</p>
</div>
<div class="deal-side">${sparkline(v.trend)}${voteLine(v, href)}</div></li>`;
}

function offerList({ heading, intro, views, pager, urls, tabs, empty, lead }) {
    // Under the showcase the list's heading is an h2 above the sort tabs, so #deals lands on both.
    return html`${lead ? html`${raw(lead)}<h2 id="deals">${heading}</h2>` : ''}${tabs ? raw(tabs) : ''}
${lead ? '' : html`<h1>${heading}</h1>`}
${intro ? html`<p class="lede">${intro}</p>` : ''}
${views.length ? html`<ol class="deal-list">${views.map((v) => offerCard(v, urls))}</ol>` : html`<p class="empty">${empty || 'Nothing here yet.'}</p>`}
${raw(pager ? paginationHtml(pager) : '')}`;
}

function tabs(active) {
    const t = (href, label, key) => (key === active ? html`<span aria-current="page">${label}</span>` : html`<a href="${href}">${label}</a>`);
    return html`<nav class="tabs" aria-label="Sort">${t('/hot', 'Hot', 'hot')} ${t('/new', 'New', 'new')} ${t('/ending', 'Ending soon', 'ending')} ${t('/picks', 'Picks', 'picks')} <form class="inline search" action="/search" method="get" role="search"><label class="sr" for="q">Search deals</label><input id="q" name="q" type="search" placeholder="Search deals"><button type="submit">Search</button></form></nav>`.toString();
}

function observationTable(v, urls) {
    const rows = v.observations.map((o) => html`<tr${o.source_removed_at ? raw(' class="removed"') : ''}>
<td>${timeEl(o.observed_at)}</td>
<td>${o.price != null ? `${o.price} ${o.currency || '(currency not stated)'}` : html`<span class="meta">not stated</span>`}</td>
<td>${o.shipping != null ? `${o.shipping} ${o.currency || ''}` : o.shipping_note || html`<span class="meta">not stated</span>`}</td>
<td>${o.condition || html`<span class="meta">not stated</span>`}</td>
<td>${o.availability ? AVAILABILITY_LABEL[o.availability] : html`<span class="meta">not stated</span>`}</td>
<td>${sourceLabel(o)}${o.offer_id !== v.root.id ? html` <span class="meta">(merged listing)</span>` : ''}${o.source_removed_at ? html` <span class="meta">(source removed)</span>` : ''}</td>
</tr>`);
    return html`<table class="obs"><caption>Every observation, newest first. A price holds only as of its time.</caption>
<thead><tr><th scope="col">Observed</th><th scope="col">Price</th><th scope="col">Shipping</th><th scope="col">Condition</th><th scope="col">Availability</th><th scope="col">Source</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

const day = (ms) => when(ms).slice(0, 10);
const pct = (n, max) => Math.round((n / max) * 1000) / 10;

/**
 * The price over time (domain/price-trend.js) above the history table: four tiles (latest, lowest,
 * highest, change since first seen) and a step line, since a price holds until the next observation.
 * Drawn on the server, readable without JavaScript; each point names its price and time on hover,
 * and the table under it lists every observation.
 */
function priceChart(t) {
    if (!t || t.count < 2) return '';
    const cur = t.currency ? ` ${t.currency}` : '';
    const span = t.latest.at - t.first.at;
    const flat = t.highest.num === t.lowest.num;
    const x = (p, i) => (span > 0 ? (p.at - t.first.at) / span : i / (t.count - 1)) * 1000;
    const y = (n) => (flat ? 50 : 10 + ((t.highest.num - n) / (t.highest.num - t.lowest.num)) * 80);
    const pts = t.points.map((p, i) => ({ p, x: Math.round(x(p, i) * 10) / 10, y: Math.round(y(p.num) * 10) / 10 }));
    const d = pts.map((q, i) => (i === 0 ? `M${q.x} ${q.y}` : `H${q.x}V${q.y}`)).join('');
    const dot = (q, cls, label) => html`<span class="${cls}" style="left:${pct(q.x, 1000)}%;top:${q.y}%"${label ? html` title="${label}"` : ''}></span>`;
    const lowQ = pts.find((q) => q.p === t.lowest);
    const endQ = pts[pts.length - 1];
    // Hover targets name each point; past 60 points only the latest and the lowest do.
    const hits = pts.length <= 60 ? pts.map((q) => dot(q, 'pc-hit', `${q.p.price}${cur} · ${when(q.p.at)}`)) : [];
    const ch = t.change;
    const sign = ch.amount > 0 ? '+' : ch.amount < 0 ? '−' : '';
    const changeText = ch.amount === 0 ? 'No change' : `${sign}${Math.abs(ch.amount).toFixed(t.places)}${cur}`;
    const changeNote = `${ch.amount !== 0 && ch.percent != null ? `${sign}${Math.abs(ch.percent)}% ` : ''}from ${t.first.price}${cur} on ${day(t.first.at)}`;
    const summary = `Price over time${cur ? ` in${cur}` : ''}: ${t.first.price} on ${day(t.first.at)}, ${t.latest.price} on ${day(t.latest.at)}; lowest ${t.lowest.price} (${day(t.lowest.at)}), highest ${t.highest.price} (${day(t.highest.at)}), ${t.count} prices.`;
    const tile = (label, value, note, cls = '') => html`<div class="pc-tile${cls}"><dt>${label}</dt><dd><strong>${value}</strong><span class="meta">${note}</span></dd></div>`;
    return html`<figure class="pc" aria-label="Price over time">
<dl class="pc-tiles">
${tile('Latest', `${t.latest.price}${cur}`, day(t.latest.at))}
${tile('Lowest', `${t.lowest.price}${cur}`, t.atLowest ? 'the lowest we have seen' : day(t.lowest.at), t.atLowest ? ' pc-best' : '')}
${tile('Highest', `${t.highest.price}${cur}`, day(t.highest.at))}
${tile('Since first seen', changeText, changeNote)}
</dl>
<div class="pc-plot">
<div class="pc-y" aria-hidden="true">${flat ? html`<span style="top:50%">${t.latest.price}</span>` : html`<span style="top:10%">${t.highest.price}</span><span style="top:90%">${t.lowest.price}</span>`}</div>
<div class="pc-area" role="img" aria-label="${summary}">
<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">${flat ? html`<line class="pc-grid" x1="0" x2="1000" y1="50" y2="50"/>` : html`<line class="pc-grid" x1="0" x2="1000" y1="10" y2="10"/><line class="pc-grid" x1="0" x2="1000" y1="90" y2="90"/>`}<path class="pc-line" d="${d}"/></svg>
${hits}${lowQ !== endQ && !flat ? dot(lowQ, 'pc-dot pc-low', '') : ''}${dot(endQ, 'pc-dot pc-end', '')}
</div>
<div class="pc-x" aria-hidden="true"><span>${day(t.first.at)}</span><span>${day(t.latest.at)}</span></div>
</div>
<figcaption class="meta">A price holds until the next observation, and only as of its time. ${t.currency ? `Prices in other currencies are not compared.` : ''}</figcaption>
</figure>`;
}

function sourceLabel(o) {
    if (o.source_kind === 'sources_item') return html`${o.source_key || 'source'}${safeHref(o.source_url) ? html` · <a href="${safeHref(o.source_url)}" rel="nofollow noopener">item</a>` : ''}`;
    if (o.origin === 'community' && o.source_kind === 'submission') return 'the submission';
    return 'a member';
}

function comments(c) {
    if (!c || c.state === 'off') return '';
    if (c.state === 'unavailable') return html`<p class="notice">Comments are unavailable right now.</p>`;
    const list = (c.comments || []).filter((x) => !x.deleted);
    return html`${list.length ? html`<ol class="comment-list">${list.map((x) => html`<li class="comment"><p class="meta">${x.display_name || 'A member'} · ${x.created_at ? timeEl(Date.parse(x.created_at)) : ''}</p><p>${x.message}</p></li>`)}</ol>` : html`<p class="empty">No comments yet.</p>`}`;
}

function offerPage({ v, dto, viewer, csrf, myVote, comments: c, mergedComments, canEdit, isMod, notice, log, flags, urls, sourceLinks }) {
    const r = v.root;
    const signedIn = viewer.kind === 'user' && viewer.subject;
    const own = Boolean(signedIn && [r, ...v.members].some((o) => o.submitted_by === viewer.subject));
    const crumbs = [{ name: 'Deals', url: '/' }, ...(v.store ? [{ name: v.store.name || v.store.domain, url: urls.storePath(v.store) }] : []), { name: r.title }];
    // "Remind me" for the moment the deal ends (plan L48 R3), beside the page's other actions; only when the end is
    // stated and still ahead.
    const remind = remindLink(r, { now: v.now, shop: v.store ? (v.store.name || v.store.domain) : '', url: urls.abs ? urls.abs(urls.offerPath(r)) : '', action: true });
    const voteForm = signedIn && r.status !== 'disabled' ? (own ? html`<p class="meta">You posted this deal.</p>` : html`<form class="inline vote" method="post" action="${urls.offerPath(r)}/vote">${csrfField(csrf)}
<button name="value" value="up"${myVote === 1 ? raw(' aria-pressed="true"') : ''}>▲ Hot</button>
<button name="value" value="down"${myVote === -1 ? raw(' aria-pressed="true"') : ''}>▼ Cold</button>
${myVote ? html`<button name="value" value="remove">Remove my vote</button>` : ''}</form>`) : html`<p class="meta"><a href="/auth/login?next=${encodeURIComponent(urls.offerPath(r))}">Sign in</a> to vote, report a price or comment.</p>`;
    return html`${raw(breadcrumbsHtml(crumbs))}
${notice ? html`<p class="notice${notice.error ? ' error' : ''}" role="status">${notice.text}</p>` : ''}
<article class="deal" data-offer="${r.id}">
<h1>${r.title} ${statusBadge(r)}</h1>
${attributionLine(v.attribution)}
${r.status === 'expired' ? html`<p class="notice">This deal expired${r.expired_at ? html` on ${timeEl(r.expired_at)}` : ''}${r.expired_reason === 'stated_expiry' ? ' (its stated end date passed)' : ''}.</p>` : ''}
<section class="latest" aria-label="Latest observation">
${latestLine(v)}
${v.freshness.state === 'stale' ? html`<p class="notice stale-notice">This price was last observed ${timeEl(v.latest.observed_at)}. Deals shows it as history, not as the price now. If you see the deal, report what the page says below.</p>` : ''}
<p><a class="button" href="${safeHref(r.url)}" rel="nofollow noopener ugc">Go to the deal at ${v.store ? v.store.name || v.store.domain : 'the store'}</a>${remind ? raw(remind) : ''}</p>
${r.expires_at && r.status === 'active' ? html`<p class="meta">Stated end: ${timeEl(r.expires_at)}</p>` : html`<p class="meta">End date: not stated</p>`}
</section>
<section class="votes" aria-label="Votes">
<p><strong>${v.tally.up - v.tally.down > 0 ? '+' : ''}${v.tally.up - v.tally.down}</strong> <span class="meta">(${v.tally.up} hot, ${v.tally.down} cold${v.hotness ? html` · hotness ${v.hotness.hot} (${v.hotness.formula}, computed ${timeEl(v.hotness.computed_at)})` : ''})</span></p>
${voteForm}
</section>
${r.description ? html`<section class="description">${raw(renderMarkdown(r.description, { rel: 'nofollow ugc noopener' }))}</section>` : ''}
${r.ai_summary ? html`<section class="disclosure"><p><strong>AI-assisted summary</strong>${r.review_state === 'reviewed' ? ' (reviewed by a person)' : ' (not yet reviewed by a person)'}</p><p>${r.ai_summary}</p></section>` : ''}
${r.review_state === 'pending' && r.text_origin === 'imported' ? html`<p class="disclosure">This deal was imported from a source and has not been reviewed by a person yet.</p>` : ''}
<dl class="facts">
${r.seller ? html`<dt>Sold by</dt><dd>${urls.sellerPath ? html`<a href="${urls.sellerPath(r.seller)}">${r.seller}</a>` : r.seller} <span class="meta">(as the source states it)</span></dd>` : ''}
<dt>${r.seller ? 'Link goes to' : 'Store'}</dt><dd>${v.store ? html`<a href="${urls.storePath(v.store)}">${v.store.name || v.store.domain}</a>` : 'not stated'}</dd>
<dt>Product</dt><dd>${v.product ? html`<a href="${urls.productPath(v.product)}">${v.product.name}</a>` : 'not linked'}</dd>
<dt>Posted</dt><dd>${timeEl(r.created_at)} ${r.origin === 'import' ? '(imported)' : '(by a member)'}</dd>
</dl>
<h2 id="history">Price history</h2>
${priceChart(v.trend)}
${observationTable(v, urls)}
<h2 id="sources">Sources</h2>
<ul class="sources">${v.sources.map((s) => html`<li>${s.kind === 'sources_item' ? html`OpenVibe.Sources item <code>${s.ref_id}</code> from <code>${s.source_key || 'a source'}</code>${safeHref(s.url) ? html` — <a href="${safeHref(s.url)}" rel="nofollow noopener">original</a>` : ''}${s.retrieved_at ? html`, retrieved ${timeEl(s.retrieved_at)}` : ''}${s.license_note ? html` · ${s.license_note}` : ''}` : s.kind === 'submission' ? html`Submitted by a member ${timeEl(s.created_at)}` : html`Observations reported by a member`}${s.removed_at ? html` <span class="badge expired">removed: ${s.removed_reason}</span>` : ''}${s.offer_id !== r.id ? html` <span class="meta">(merged listing)</span>` : ''}</li>`)}</ul>
${v.members.length ? html`<h2>Merged listings</h2><ul>${v.members.map((m) => html`<li>${m.title} <span class="meta">(<code>${m.slug}</code>, merged ${timeEl(m.merged_at)})</span></li>`)}</ul>` : ''}
${signedIn && r.status !== 'disabled' ? html`<details class="card"><summary>Report what the deal page says now</summary>
<form method="post" action="${urls.offerPath(r)}/observe">${csrfField(csrf)}
<label for="o-price">Price</label><input id="o-price" name="price" inputmode="decimal" placeholder="19.99">
<label for="o-currency">Currency</label><input id="o-currency" name="currency" maxlength="3" placeholder="USD">
<label for="o-shipping">Shipping</label><input id="o-shipping" name="shipping" inputmode="decimal">
<label for="o-avail">Availability</label><select id="o-avail" name="availability"><option value="">not stated</option>${AVAILABILITY.map((a) => html`<option value="${a}">${AVAILABILITY_LABEL[a]}</option>`)}</select>
<label for="o-cond">Condition</label><select id="o-cond" name="condition"><option value="">not stated</option>${CONDITIONS.map((c2) => html`<option>${c2}</option>`)}</select>
<button type="submit">Record observation</button></form></details>
<details class="card"><summary>Report a problem</summary>
<form method="post" action="${urls.offerPath(r)}/flag">${csrfField(csrf)}
<label for="f-kind">Problem</label><select id="f-kind" name="kind"><option value="expired">Expired</option><option value="price_wrong">Price is wrong</option><option value="duplicate">Duplicate</option><option value="spam">Spam</option><option value="other">Other</option></select>
<label for="f-dup">Duplicate of (link or slug, for duplicates)</label><input id="f-dup" name="duplicate_of">
<label for="f-reason">Details</label><input id="f-reason" name="reason" maxlength="500">
<button type="submit">Send report</button></form></details>` : ''}
${canEdit && r.status === 'active' ? html`<form method="post" action="${urls.offerPath(r)}/expire">${csrfField(csrf)}<button type="submit">Mark expired</button></form>` : ''}
${isMod ? html`<details class="card mod"><summary>Moderation</summary>
<form method="post" action="/mod/offers/${r.slug}/merge">${csrfField(csrf)}<label for="m-into">Merge this listing into (slug or id)</label><input id="m-into" name="into" required><label for="m-r">Reason</label><input id="m-r" name="reason"><button type="submit">Merge</button></form>
${r.status !== 'disabled' ? html`<form method="post" action="/mod/offers/${r.slug}/disable">${csrfField(csrf)}<label for="d-r">Disable (reason)</label><input id="d-r" name="reason" required minlength="3"><button class="danger" type="submit">Disable</button></form>` : html`<form method="post" action="/mod/offers/${r.slug}/enable">${csrfField(csrf)}<button type="submit">Enable</button></form>`}
${r.status === 'expired' ? html`<form method="post" action="/mod/offers/${r.slug}/enable">${csrfField(csrf)}<button type="submit">Re-activate</button></form>` : ''}
${r.review_state === 'pending' ? html`<form method="post" action="/mod/offers/${r.slug}/review">${csrfField(csrf)}<button type="submit">Mark text reviewed</button></form>` : ''}
${v.members.map((m) => html`<form method="post" action="/mod/offers/${m.slug}/unmerge">${csrfField(csrf)}<button type="submit">Unmerge ${m.slug}</button></form>`)}
${flags && flags.length ? html`<h3>Flags</h3><ul>${flags.map((f) => html`<li>${f.kind} (${f.origin}, ${f.status})${f.reason ? `: ${f.reason}` : ''}</li>`)}</ul>` : ''}
${log && log.length ? html`<h3>Moderation log</h3><ol>${log.map((l) => html`<li>${timeEl(l.at)} ${l.action} ${l.offer_id} ${l.target_id ? `→ ${l.target_id}` : ''} by ${l.actor}${l.reason ? `: ${l.reason}` : ''}</li>`)}</ol>` : ''}
</details>` : ''}
<section class="comments" id="comments"><h2>Discussion</h2>
${comments(c)}
${c && c.state === 'ok' && signedIn ? html`<form method="post" action="${urls.offerPath(r)}/comments">${csrfField(csrf)}<label for="c-msg">Comment</label><textarea id="c-msg" name="message" rows="3" maxlength="4000" required></textarea><button type="submit">Comment</button></form>` : ''}
${(mergedComments || []).map((mc) => html`<h3>Discussion from the merged listing “${mc.title}”</h3>${comments(mc.comments)}`)}
</section>
<p class="meta"><a href="${urls.offerPath(r)}.json">This deal as JSON</a> · indexability: ${dto.indexability.robots}${dto.indexability.reasons.length ? ` (${dto.indexability.reasons.map((x) => x.code).join(', ')})` : ''}${sourceLinks || ''}</p>
</article>`;
}

function productPage({ pv, urls }) {
    const p = pv.product;
    const rows = pv.offers.map((v) => html`<tr>
<td><a href="${urls.offerPath(v.root)}">${v.root.title}</a> ${statusBadge(v.root)}${attributionLine(v.attribution)}</td>
<td>${v.root.seller || (v.store ? v.store.name || v.store.domain : 'not stated')}</td>
<td data-price="${v.latest && v.latest.price != null ? v.latest.price : ''}">${priceText(v.latest)}${v.latest && shippingText(v.latest) ? html` <span class="meta">${shippingText(v.latest)}</span>` : ''}</td>
<td>${v.latest ? timeEl(v.latest.observed_at) : html`<span class="meta">never observed</span>`}</td>
<td>${freshnessBadge(v.freshness, v.now)}</td>
</tr>`);
    return html`${raw(breadcrumbsHtml([{ name: 'Deals', url: '/' }, { name: p.name }]))}
<h1>${p.name}</h1>
${p.brand ? html`<p class="lede">${p.brand}</p>` : ''}
${p.description ? html`<p>${p.description}</p>` : ''}
<h2>Price comparison</h2>
${pv.offers.length ? html`<table class="compare"><caption>Each price is the latest observation of that offer, with its time. Fresh prices with a stated amount come first; stale, unknown and expired ones follow and are never ranked as if they were current.</caption>
<thead><tr><th scope="col">Offer</th><th scope="col">Store</th><th scope="col">Latest price</th><th scope="col">Observed</th><th scope="col">Freshness</th></tr></thead><tbody>${rows}</tbody></table>` : html`<p class="empty">No offers for this product yet.</p>`}
${pv.aliases.length ? html`<h2>Also known as</h2><ul class="aliases">${pv.aliases.map((a) => html`<li>${a.kind}: <code>${a.value}</code></li>`)}</ul>` : ''}
<p class="meta"><a href="${urls.productPath(p)}.json">This product as JSON</a></p>`;
}

function submitForm({ csrf, values = {}, error }) {
    const val = (k) => (values[k] == null ? '' : values[k]);
    return html`<h1>Submit a deal</h1>
<p class="lede">Link to the offer and say what you see on the page now. Leave anything you did not see empty — Deals never fills in a price, currency, shipping or availability for you.</p>
${error ? html`<p class="notice error" role="alert">${error}</p>` : ''}
<form method="post" action="/submit" class="card">${csrfField(csrf)}
<label for="s-url">Link to the offer</label><input id="s-url" name="url" type="url" required value="${val('url')}">
<label for="s-title">Title</label><input id="s-title" name="title" required minlength="3" maxlength="200" value="${val('title')}">
<label for="s-price">Price you see now</label><input id="s-price" name="price" inputmode="decimal" placeholder="19.99" value="${val('price')}">
<label for="s-currency">Currency (ISO code)</label><input id="s-currency" name="currency" maxlength="3" placeholder="USD" value="${val('currency')}">
<label for="s-ship">Shipping cost</label><input id="s-ship" name="shipping" inputmode="decimal" value="${val('shipping')}">
<label for="s-shipnote">Shipping note</label><input id="s-shipnote" name="shipping_note" maxlength="200" placeholder="free over 35" value="${val('shipping_note')}">
<label for="s-cond">Condition</label><select id="s-cond" name="condition"><option value="">not stated</option>${CONDITIONS.map((c) => html`<option${val('condition') === c ? raw(' selected') : ''}>${c}</option>`)}</select>
<label for="s-avail">Availability</label><select id="s-avail" name="availability"><option value="">not stated</option>${AVAILABILITY.map((a) => html`<option value="${a}"${val('availability') === a ? raw(' selected') : ''}>${AVAILABILITY_LABEL[a]}</option>`)}</select>
<label for="s-exp">Ends, in UTC (only if the store states it)</label><input id="s-exp" name="expires_at" type="datetime-local" value="${val('expires_at')}">
<label for="s-store">Store name (optional)</label><input id="s-store" name="store_name" maxlength="120" value="${val('store_name')}">
<label for="s-prod">Product name (optional, links price comparison)</label><input id="s-prod" name="product_name" maxlength="200" value="${val('product_name')}">
<label for="s-gtin">Product barcode / GTIN (optional)</label><input id="s-gtin" name="product_gtin" inputmode="numeric" value="${val('product_gtin')}">
<label for="s-desc">Description (Markdown)</label><textarea id="s-desc" name="description" rows="5" maxlength="4000">${val('description')}</textarea>
<button type="submit">Submit deal</button>
</form>`;
}

function watchesPage({ csrf, watches, error, notice, urls, values = {} }) {
    // Arriving from a shop's "Alert me" (/watches?kind=keyword&query=zappos.com): the form says so, filled in.
    const kindOpt = (k, label) => html`<option value="${k}"${values.kind === k ? raw(' selected') : ''}>${label}</option>`;
    return html`<h1>Watches and saved searches</h1>
<p class="lede">A watch tells you once when a new observation matches it (at most one notification per observation). A saved search never notifies. Notifications are delivered by the OpenVibe network; Deals never emails.</p>
${error ? html`<p class="notice error" role="alert">${error}</p>` : ''}
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${watches.length ? html`<ul class="watches">${watches.map((w) => html`<li><strong>${w.kind === 'search' ? 'Saved search' : w.kind === 'price_below' ? 'Price below' : w.kind === 'product' ? 'Product' : 'Keywords'}</strong>:
${w.query ? html` “${w.query}”` : ''}${w.product ? html` <a href="${w.product.url}">${w.product.name}</a>` : ''}${w.max_price ? html` under ${w.max_price} ${w.currency}` : ''}
${w.kind === 'search' ? html` · <a href="/search?q=${encodeURIComponent(w.query)}">run</a>` : html` · ${w.notifications} notifications`}
<form class="inline" method="post" action="/watches/${w.id}/delete">${csrfField(csrf)}<button type="submit">Delete</button></form></li>`)}</ul>` : html`<p class="empty">No watches yet.</p>`}
<form method="post" action="/watches" class="card">${csrfField(csrf)}
<h2>${values.query ? html`Alert me about “${values.query}”` : 'Add'}</h2>
<label for="w-kind">Kind</label><select id="w-kind" name="kind">${kindOpt('keyword', 'Keywords (notify)')}${kindOpt('price_below', 'Price below (notify)')}${kindOpt('product', 'Product (notify)')}${kindOpt('search', 'Saved search (no notifications)')}</select>
<label for="w-q">Keywords</label><input id="w-q" name="query" maxlength="200" value="${values.query || ''}">
<label for="w-p">Product (slug, for product and price watches)</label><input id="w-p" name="product">
<label for="w-max">Price below</label><input id="w-max" name="max_price" inputmode="decimal">
<label for="w-cur">Currency</label><input id="w-cur" name="currency" maxlength="3" placeholder="USD">
<button type="submit">Save</button>
</form>`;
}

function searchPage({ q, results, pager, urls, csrf, signedIn }) {
    return html`<h1>Search deals</h1>
<form action="/search" method="get" role="search"><label for="sq">Words</label><input id="sq" name="q" type="search" value="${q || ''}"><button type="submit">Search</button></form>
${q && signedIn ? html`<form method="post" action="/watches" class="inline">${csrfField(csrf)}<input type="hidden" name="kind" value="search"><input type="hidden" name="query" value="${q}"><button type="submit">Save this search</button></form>
<form method="post" action="/watches" class="inline">${csrfField(csrf)}<input type="hidden" name="kind" value="keyword"><input type="hidden" name="query" value="${q}"><button type="submit">Watch these words</button></form>` : ''}
${q ? (results.length ? html`<ol class="deal-list">${results.map((v) => offerCard(v, urls))}</ol>` : html`<p class="empty">No active deals match.</p>`) : ''}
${raw(pager ? paginationHtml(pager) : '')}`;
}

function modPage({ csrf, flags, pending, duplicates, urls }) {
    return html`<h1>Moderation</h1>
<h2>Open flags</h2>
${flags.length ? html`<ul class="flags">${flags.map((f) => html`<li><strong>${f.kind}</strong> (${f.origin}) ${f.offer ? html`<a href="${urls.offerPath(f.offer)}">${f.offer.title}</a>` : ''}${f.reason ? `: ${f.reason}` : ''}
${f.kind === 'vote_ring' ? html` <span class="meta">${f.details.signal}: ${(f.details.voters || []).join(', ')}</span>` : ''}
<form class="inline" method="post" action="/mod/flags/${f.id}/resolve">${csrfField(csrf)}<button type="submit">Resolved</button></form>
<form class="inline" method="post" action="/mod/flags/${f.id}/dismiss">${csrfField(csrf)}<button type="submit">Dismiss</button></form></li>`)}</ul>` : html`<p class="empty">No open flags.</p>`}
<h2>Waiting for a person's review (noindex until reviewed)</h2>
${pending.length ? html`<ul>${pending.map((o) => html`<li><a href="${urls.offerPath(o)}">${o.title}</a> (${o.text_origin}) <form class="inline" method="post" action="/mod/offers/${o.slug}/review">${csrfField(csrf)}<button type="submit">Mark reviewed</button></form></li>`)}</ul>` : html`<p class="empty">Nothing to review.</p>`}
<h2>Possible duplicates</h2>
${duplicates.length ? html`<ul>${duplicates.map((d) => html`<li><a href="${urls.offerPath(d.a)}">${d.a.title}</a> and <a href="${urls.offerPath(d.b)}">${d.b.title}</a>
<form class="inline" method="post" action="/mod/offers/${d.b.slug}/merge">${csrfField(csrf)}<input type="hidden" name="into" value="${d.a.slug}"><button type="submit">Merge the newer into the older</button></form></li>`)}</ul>` : html`<p class="empty">None found.</p>`}`;
}

function storePage({ st, views, pager, urls, stats = null }) {
    const n = (x) => Number(x || 0).toLocaleString('en-US');
    return html`${raw(breadcrumbsHtml([{ name: 'Deals', url: '/' }, { name: st.name || st.domain }]))}
<header class="dl-shop"><span class="dl-shop-mark" aria-hidden="true">${String(st.name || st.domain).replace(/^www\./, '').slice(0, 1).toUpperCase()}</span>
<div class="dl-shop-t"><h1>${st.name || st.domain}</h1><p class="lede"><a href="https://${st.domain}" rel="nofollow noopener">${st.domain}</a>${stats ? html` · ${n(stats.active)} active deal${Number(stats.active) === 1 ? '' : 's'} · prices seen ${n(stats.seen24)} time${Number(stats.seen24) === 1 ? '' : 's'} in 24 hours` : ''}</p></div>
<a class="dl-alert" href="/watches?kind=keyword&amp;query=${encodeURIComponent(st.domain)}">Alert me about deals here</a></header>
${views.length ? html`<ol class="deal-list">${views.map((v) => offerCard(v, urls))}</ol>` : html`<p class="empty">No deals from this store.</p>`}
${raw(pager ? paginationHtml(pager) : '')}`;
}

/** /at/:seller: deals at one shop, as their sources name it. */
function sellerPage({ seller, views: list, pager, urls, total }) {
    return html`${raw(breadcrumbsHtml([{ name: 'Deals', url: '/' }, { name: 'Shops', url: '/at' }, { name: seller }]))}
<h1>Deals at ${seller}</h1>
<p class="lede">${total} deal${total === 1 ? '' : 's'} at ${seller}, as the deal sources name the shop, newest first.</p>
${list.length ? html`<ol class="deal-list">${list.map((v) => offerCard(v, urls))}</ol>` : html`<p class="empty">No deals at this shop right now.</p>`}
${raw(pager ? paginationHtml(pager) : '')}`;
}

/** /at: every shop with deals here, most deals first. */
function sellersPage({ sellers }) {
    return html`${raw(breadcrumbsHtml([{ name: 'Deals', url: '/' }, { name: 'Shops' }]))}
<h1>Deals by shop</h1>
<p class="lede">Every shop with a deal here, as the deal sources name it, the most deals first.</p>
${sellers.length ? html`<ul class="seller-list">${sellers.map((x) => html`<li><a href="/at/${x.slug}">${x.seller}</a> <span class="meta">${x.count} deal${x.count === 1 ? '' : 's'}</span></li>`)}</ul>` : html`<p class="empty">No shops yet.</p>`}`;
}

/** /c/:category: active deals in one category, as their sources name it. */
function categoryPage({ category, views: list, pager, urls, total }) {
    return html`${raw(breadcrumbsHtml([{ name: 'Deals', url: '/' }, { name: 'Categories', url: '/c' }, { name: category }]))}
<h1>${category} deals</h1>
<p class="lede">${total} active deal${total === 1 ? '' : 's'} in ${category}, as the deal sources file them, newest first. Every price shows when it was seen.</p>
${list.length ? html`<ol class="deal-list">${list.map((v) => offerCard(v, urls))}</ol>` : html`<p class="empty">No active deals in this category right now.</p>`}
${raw(pager ? paginationHtml(pager) : '')}`;
}

/** /c: every category with active deals, most deals first. */
function categoriesPage({ categories }) {
    return html`${raw(breadcrumbsHtml([{ name: 'Deals', url: '/' }, { name: 'Categories' }]))}
<h1>Deals by category</h1>
<p class="lede">Every category with an active deal, as the deal sources name it, the most deals first.</p>
${categories.length ? html`<ul class="seller-list">${categories.map((x) => html`<li><a href="/c/${x.slug}">${x.category}</a> <span class="meta">${x.count} deal${x.count === 1 ? '' : 's'}</span></li>`)}</ul>` : html`<p class="empty">No deal has a category yet.</p>`}`;
}

function message({ heading, text, action }) {
    return html`<h1>${heading}</h1><p>${text}</p>${action ? html`<p><a href="${action.href}">${action.label}</a></p>` : ''}`;
}

module.exports = { offerList, tabs, offerPage, productPage, submitForm, watchesPage, searchPage, modPage, storePage, sellerPage, sellersPage, categoryPage, categoriesPage, message, priceText, when, ago };
