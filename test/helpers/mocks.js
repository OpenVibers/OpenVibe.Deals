'use strict';
/**
 * In-process stand-ins for Deals' neighbours, with a real RS256 key pair:
 *   Network    JWKS, /oauth/token (client_credentials → service tokens with the requested scope as
 *              capabilities), /internal/identity/resolve-batch (needs identity.subject.resolve)
 *   Community  /api/v1/comments/threads/resolve, GET thread, POST comment, PUT visibility
 *   Sources    /api/v1/items?category=deals&after= and /api/v1/items/:id (needs sources.item.read)
 * userToken()/serviceToken() mint the tokens browsers and services present to Deals.
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                handler(req, raw, json, res);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
    });
}

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const directory = new Map();   // subject → { username, display_name }
    const grants = [];
    let issuer = null;
    const srv = await listen((req, raw, json) => {
        if (req.url === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            let body = {};
            if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
            else { try { body = JSON.parse(raw); } catch { /* */ } }
            grants.push(body);
            if (body.client_secret !== 'shh') return json(401, { error: 'invalid_client' });
            if (body.grant_type === 'client_credentials') {
                let scope = body.scope;
                if (scope && typeof scope === 'object') scope = Object.values(scope).join(' ');
                const cap = String(scope || '').split(/\s+/).filter(Boolean);
                return json(200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience || 'openvibe.events'], cap }), token_type: 'Bearer', expires_in: 300 });
            }
            return json(400, { error: 'unsupported_grant_type' });
        }
        if (req.url === '/internal/identity/resolve-batch' && req.method === 'POST') {
            const token = String(req.headers.authorization || '').slice(7);
            const v = serviceAuth.verifyServiceToken(token, { publicKey: publicPem, issuer, audience: 'openvibe.network' });
            if (!v.ok || !(v.claims.cap || []).includes('identity.subject.resolve')) return json(403, { code: 'capability.denied' });
            const b = JSON.parse(raw || '{}');
            const results = {};
            for (const s of b.subject_ids || []) {
                const u = directory.get(s);
                results[s] = u ? { subject: { type: 'user', id: s }, username: u.username, display_name: u.display_name, avatar_url: null, banned: false } : null;
            }
            return json(200, { results });
        }
        return json(404, { error: 'not found' });
    });
    issuer = srv.url;
    // An app token carries its developer project and env, as Network's do (identity.service-token-claims 1.2.0).
    function signService({ sub, aud, cap, ns, actorType = 'service', extra = {} }) {
        const app = actorType === 'app' ? { project_id: 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', env: 'production' } : {};
        return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type: actorType, aud, cap, ...(ns ? { ns } : {}), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID(), ...app, ...extra }, privatePem);
    }
    /** extra.mintedAt: the time embedded in the usr_ ULID (default: long ago, i.e. an established account). */
    function addUser(username, extra = {}) {
        const subject = ids.newId('user', extra.mintedAt != null ? extra.mintedAt : Date.parse('2025-01-01T00:00:00Z'));
        const u = { subject, username, display_name: extra.display_name || username[0].toUpperCase() + username.slice(1), role: extra.role || 'user' };
        directory.set(subject, u);
        return u;
    }
    function userToken(u) {
        return jwt.sign({ sub: String(Math.floor(Math.random() * 1e6)), subject_id: u.subject, username: u.username, display_name: u.display_name, role: u.role || 'user' }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
    }
    function serviceToken(client, cap) {
        return signService({ sub: `svc:${client}`, aud: ['openvibe.deals'], cap });
    }
    return { ...srv, publicPem, grants, directory, addUser, userToken, serviceToken, signService };
}

async function startCommunity({ network }) {
    const threads = new Map();   // id → { ref, visibility, comments: [] }
    const byRef = new Map();
    const calls = [];
    let down = false;
    let seq = 0;
    const srv = await listen((req, raw, json) => {
        calls.push({ method: req.method, url: req.url, subject: req.headers['x-ov-subject'] || null, auth: Boolean(req.headers.authorization) });
        if (down) return json(503, { code: 'down' });
        const auth = () => {
            const token = String(req.headers.authorization || '').slice(7);
            const v = serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.community' });
            return v.ok ? v.claims : null;
        };
        if (req.url === '/api/v1/comments/threads/resolve' && req.method === 'POST') {
            const c = auth();
            if (!c || !(c.cap || []).includes('community.comment.write')) return json(403, { code: 'capability.denied' });
            const { ref } = JSON.parse(raw);
            const key = `${ref.service}:${ref.type}:${ref.id}`;
            if (byRef.has(key)) return json(200, { thread: { id: byRef.get(key), visibility: threads.get(byRef.get(key)).visibility }, created: false });
            const id = ++seq;
            threads.set(id, { ref, visibility: 'public', comments: [] });
            byRef.set(key, id);
            return json(201, { thread: { id, visibility: 'public' }, created: true });
        }
        let m = req.url.match(/^\/api\/v1\/comments\/threads\/(\d+)(\?.*)?$/);
        if (m && req.method === 'GET') {
            const t = threads.get(Number(m[1]));
            if (!t || t.visibility === 'hidden') return json(404, { code: 'thread.not_found' });
            return json(200, { thread: { id: Number(m[1]), visibility: t.visibility, comment_count: t.comments.length }, comments: t.comments, next_cursor: null });
        }
        m = req.url.match(/^\/api\/v1\/comments\/threads\/(\d+)\/comments$/);
        if (m && req.method === 'POST') {
            const c = auth();
            if (!c || !(c.cap || []).includes('community.comment.write')) return json(403, { code: 'capability.denied' });
            const t = threads.get(Number(m[1]));
            const body = JSON.parse(raw);
            const who = network.directory.get(req.headers['x-ov-subject']);
            const comment = { id: t.comments.length + 1, origin: 'user', display_name: who ? who.display_name : 'Someone', message: body.message, deleted: false, created_at: new Date().toISOString() };
            t.comments.push(comment);
            return json(201, { comment });
        }
        m = req.url.match(/^\/api\/v1\/comments\/threads\/(\d+)\/visibility$/);
        if (m && req.method === 'PUT') {
            const c = auth();
            if (!c || !(c.cap || []).includes('community.comment.moderate')) return json(403, { code: 'capability.denied' });
            threads.get(Number(m[1])).visibility = JSON.parse(raw).visibility;
            return json(200, { ok: true });
        }
        return json(404, { code: 'route.not_found' });
    });
    return { ...srv, threads, calls, setDown: (v) => { down = v; } };
}

async function startSources({ network }) {
    const items = [];      // full sources.item@1 views with change_seq
    let down = false;
    const calls = [];
    const srv = await listen((req, raw, json) => {
        calls.push(req.url);
        if (down) return json(503, { code: 'down' });
        const token = String(req.headers.authorization || '').slice(7);
        const v = serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.sources' });
        if (!v.ok || !(v.claims.cap || []).includes('sources.item.read')) return json(403, { code: 'capability.denied' });
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/items') {
            const after = Number(u.searchParams.get('after') || 0);
            const limit = Number(u.searchParams.get('limit') || 100);
            const cat = u.searchParams.get('category');
            const rows = items.filter((i) => i.change_seq > after && (!cat || i.category === cat)).sort((a, b) => a.change_seq - b.change_seq);
            const page = rows.slice(0, limit);
            return json(200, { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: rows.length > limit, sources: {} });
        }
        const m = u.pathname.match(/^\/api\/v1\/items\/(itm_[0-9A-Z]+)$/);
        if (m) {
            const it = items.find((i) => i.id === m[1]);
            return it ? json(200, { item: it, source: { key: it.source_key, status: 'healthy', stale: false } }) : json(404, { code: 'sources.not_found' });
        }
        return json(404, { code: 'route.not_found' });
    });
    let seq = 0;
    /** Add or replace an item (a new change_seq each time, like Sources). */
    function put(item) {
        const i = items.findIndex((x) => x.id === item.id);
        const full = { change_seq: ++seq, ...item };
        full.change_seq = seq;
        if (i >= 0) items[i] = full; else items.push(full);
        return full;
    }
    return { ...srv, items, calls, put, setDown: (v) => { down = v; } };
}

/** A sources.item@1 view as OpenVibe.Sources serves it. */
function sourceItem({ id, kind = 'offer', title = 'Something', url = 'https://shop.example/p/1', fields = {}, retrievedAt, revision = 1, removed = null, sourceKey = 'shop-jsonld', summary = null }) {
    return {
        id, source_key: sourceKey, category: 'deals', kind, identity: url, canonical_url: url, title, summary, authors: [],
        published_at: null, source_updated_at: null, fields, revision,
        provenance: {
            retrieved_at: new Date(retrievedAt).toISOString(), first_seen_at: new Date(retrievedAt).toISOString(),
            content_hash: 'a'.repeat(64), raw_body_hash: null, parser_version: 'jsonld@1', fetch_run_id: null,
            license_note: 'facts only', terms_note: 'checked', entered_by: null,
        },
        removed,
    };
}

module.exports = { startNetwork, startCommunity, startSources, sourceItem, listen };
