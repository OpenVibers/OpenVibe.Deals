'use strict';
// The Markdown twins of openvibe.deals' public pages (openvibe-shared/agent-layer), rendered by the same
// view builders the routes use (createPages().publicViews + render/layout.js's renderPage), so a twin
// cannot drift from its page. Anonymous only: no vote, edit or moderation controls are ever rendered here.
const { renderPage } = require('./render/layout');

function createAgentPages(ctx, publicViews) {
    const views = publicViews || require('./http/pages').createPages(ctx).publicViews;
    const twin = (page, path) => (page ? { html: renderPage({ ...page, config: ctx.config, path, viewer: { kind: 'anonymous' } }) } : null);
    const pageOf = (query) => { const n = parseInt(query && query.get('page'), 10); return Number.isInteger(n) && n > 0 ? n : 1; };

    async function renderPublicPage(path, { query } = {}) {
        if (path === '/') return twin(await views.home(), path);
        if (path === '/updates') return twin(views.updates(), path);
        const list = { '/hot': 'hot', '/new': 'new', '/ending': 'ending', '/picks': 'picks' }[path];
        if (list) return twin(await views.list(list, pageOf(query)), path);
        if (path === '/at') return twin(await views.sellers(), path);
        if (path === '/c') return twin(await views.categories(), path);
        let m = /^\/d\/([^/]+)$/.exec(path);
        if (m) return twin(await views.offer(decodeURIComponent(m[1])), path);
        m = /^\/p\/([^/]+)$/.exec(path);
        if (m) {
            const out = await views.product(decodeURIComponent(m[1]));
            return twin(out && out.page, path);
        }
        m = /^\/s\/([^/]+)$/.exec(path);
        if (m) return twin(await views.store(decodeURIComponent(m[1]), pageOf(query)), path);
        m = /^\/at\/([^/]+)$/.exec(path);
        if (m) return twin(await views.seller(decodeURIComponent(m[1]), pageOf(query)), path);
        m = /^\/c\/([^/]+)$/.exec(path);
        if (m) return twin(await views.category(decodeURIComponent(m[1]), pageOf(query)), path);
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
