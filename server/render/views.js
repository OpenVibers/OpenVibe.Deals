'use strict';

/**
 * Page bodies. Every value goes through openvibe-publishing/ssr's auto-escaping `html` template;
 * only this file's own markup is raw(). Pages work without JavaScript: every action is a form.
 *
 * Wording rules: a price is always "as of <time>"; a stale one says it may no longer be available;
 * an unknown one says "not stated". Nothing here calls a price "current".
 */
const { html, raw, renderMarkdown, paginationHtml, breadcrumbsHtml } = require('openvibe-publishing/ssr');
const { AVAILABILITY_LABEL, CONDITIONS, AVAILABILITY } = require('../domain/util');

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

/** The one-line "latest observation" block used on cards and pages. */
function latestLine(v) {
    const o = v.latest;
    return html`<p class="price-line"><strong class="price" data-price="${o && o.price != null ? o.price : ''}">${priceText(o)}</strong>
${o && shippingText(o) ? html` <span class="meta">${shippingText(o)}</span>` : ''}
${o && o.availability ? html` · <span class="meta">${AVAILABILITY_LABEL[o.availability]}</span>` : ''}
${o ? html` <span class="meta as-of">as of ${timeEl(o.observed_at)}</span>` : ''} ${freshnessBadge(v.freshness, v.now)}</p>`;
}

function offerCard(v, urls) {
    const r = v.root;
    const score = v.tally.up - v.tally.down;
    return html`<li class="deal-item">
<div class="score" title="${v.tally.up} up, ${v.tally.down} down">${score > 0 ? `+${score}` : score}</div>
<div class="deal-body">
<h2 class="deal-title"><a href="${urls.offerPath(r)}">${r.title}</a> ${statusBadge(r)}</h2>
${latestLine(v)}
<p class="meta">${v.store ? html`<a href="${urls.storePath(v.store)}">${v.store.name || v.store.domain}</a> · ` : ''}${v.product ? html`<a href="${urls.productPath(v.product)}">${v.product.name}</a> · ` : ''}posted ${timeEl(r.created_at)}${r.origin === 'import' ? ' · imported from a source' : ''}</p>
</div></li>`;
}

function offerList({ heading, intro, views, pager, urls, tabs, empty }) {
    return html`${tabs ? raw(tabs) : ''}
<h1>${heading}</h1>
${intro ? html`<p class="lede">${intro}</p>` : ''}
${views.length ? html`<ol class="deal-list">${views.map((v) => offerCard(v, urls))}</ol>` : html`<p class="empty">${empty || 'Nothing here yet.'}</p>`}
${raw(pager ? paginationHtml(pager) : '')}`;
}

function tabs(active) {
    const t = (href, label, key) => (key === active ? html`<span aria-current="page">${label}</span>` : html`<a href="${href}">${label}</a>`);
    return html`<nav class="tabs" aria-label="Sort">${t('/', 'Hot', 'hot')} ${t('/new', 'New', 'new')} <form class="inline search" action="/search" method="get" role="search"><label class="sr" for="q">Search deals</label><input id="q" name="q" type="search" placeholder="Search deals"><button type="submit">Search</button></form></nav>`.toString();
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
    const voteForm = signedIn && r.status !== 'disabled' ? (own ? html`<p class="meta">You posted this deal.</p>` : html`<form class="inline vote" method="post" action="${urls.offerPath(r)}/vote">${csrfField(csrf)}
<button name="value" value="up"${myVote === 1 ? raw(' aria-pressed="true"') : ''}>▲ Hot</button>
<button name="value" value="down"${myVote === -1 ? raw(' aria-pressed="true"') : ''}>▼ Cold</button>
${myVote ? html`<button name="value" value="remove">Remove my vote</button>` : ''}</form>`) : html`<p class="meta"><a href="/auth/login?next=${encodeURIComponent(urls.offerPath(r))}">Sign in</a> to vote, report a price or comment.</p>`;
    return html`${raw(breadcrumbsHtml(crumbs))}
${notice ? html`<p class="notice${notice.error ? ' error' : ''}" role="status">${notice.text}</p>` : ''}
<article class="deal" data-offer="${r.id}">
<h1>${r.title} ${statusBadge(r)}</h1>
${r.status === 'expired' ? html`<p class="notice">This deal expired${r.expired_at ? html` on ${timeEl(r.expired_at)}` : ''}${r.expired_reason === 'stated_expiry' ? ' (its stated end date passed)' : ''}.</p>` : ''}
<section class="latest" aria-label="Latest observation">
${latestLine(v)}
${v.freshness.state === 'stale' ? html`<p class="notice stale-notice">This price was last observed ${timeEl(v.latest.observed_at)}. Deals shows it as history, not as the price now. If you see the deal, report what the page says below.</p>` : ''}
<p><a class="button" href="${safeHref(r.url)}" rel="nofollow noopener ugc">Go to the deal at ${v.store ? v.store.name || v.store.domain : 'the store'}</a></p>
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
<dt>Store</dt><dd>${v.store ? html`<a href="${urls.storePath(v.store)}">${v.store.name || v.store.domain}</a>` : 'not stated'}</dd>
<dt>Product</dt><dd>${v.product ? html`<a href="${urls.productPath(v.product)}">${v.product.name}</a>` : 'not linked'}</dd>
<dt>Posted</dt><dd>${timeEl(r.created_at)} ${r.origin === 'import' ? '(imported)' : '(by a member)'}</dd>
</dl>
<h2 id="history">Price history</h2>
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
<td><a href="${urls.offerPath(v.root)}">${v.root.title}</a> ${statusBadge(v.root)}</td>
<td>${v.store ? v.store.name || v.store.domain : 'not stated'}</td>
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

function watchesPage({ csrf, watches, error, notice, urls }) {
    return html`<h1>Watches and saved searches</h1>
<p class="lede">A watch tells you once when a new observation matches it (at most one notification per observation). A saved search never notifies. Notifications are delivered by the OpenVibe network; Deals never emails.</p>
${error ? html`<p class="notice error" role="alert">${error}</p>` : ''}
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${watches.length ? html`<ul class="watches">${watches.map((w) => html`<li><strong>${w.kind === 'search' ? 'Saved search' : w.kind === 'price_below' ? 'Price below' : w.kind === 'product' ? 'Product' : 'Keywords'}</strong>:
${w.query ? html` “${w.query}”` : ''}${w.product ? html` <a href="${w.product.url}">${w.product.name}</a>` : ''}${w.max_price ? html` under ${w.max_price} ${w.currency}` : ''}
${w.kind === 'search' ? html` · <a href="/search?q=${encodeURIComponent(w.query)}">run</a>` : html` · ${w.notifications} notifications`}
<form class="inline" method="post" action="/watches/${w.id}/delete">${csrfField(csrf)}<button type="submit">Delete</button></form></li>`)}</ul>` : html`<p class="empty">No watches yet.</p>`}
<form method="post" action="/watches" class="card">${csrfField(csrf)}
<h2>Add</h2>
<label for="w-kind">Kind</label><select id="w-kind" name="kind"><option value="keyword">Keywords (notify)</option><option value="price_below">Price below (notify)</option><option value="product">Product (notify)</option><option value="search">Saved search (no notifications)</option></select>
<label for="w-q">Keywords</label><input id="w-q" name="query" maxlength="200">
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

function storePage({ st, views, pager, urls }) {
    return html`${raw(breadcrumbsHtml([{ name: 'Deals', url: '/' }, { name: st.name || st.domain }]))}
<h1>${st.name || st.domain}</h1>
<p class="lede">Deals at <code>${st.domain}</code>.</p>
${views.length ? html`<ol class="deal-list">${views.map((v) => offerCard(v, urls))}</ol>` : html`<p class="empty">No deals from this store.</p>`}
${raw(pager ? paginationHtml(pager) : '')}`;
}

function message({ heading, text, action }) {
    return html`<h1>${heading}</h1><p>${text}</p>${action ? html`<p><a href="${action.href}">${action.label}</a></p>` : ''}`;
}

module.exports = { offerList, tabs, offerPage, productPage, submitForm, watchesPage, searchPage, modPage, storePage, message, priceText, when };
