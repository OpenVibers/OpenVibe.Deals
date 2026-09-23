'use strict';

/**
 * Who a subject is, for display (submitters, voters, moderators).
 *
 * Deals stores people as Network subject ids (usr_…) only. Names come from the signed-in member's
 * own token claims and, for everyone else, from the Network's resolve-batch endpoint
 * (capability identity.subject.resolve, a client-credentials token for audience openvibe.network).
 * They are cached in subject_projections; the cache is never authority, and an unresolvable
 * subject is shown as "a member", never as a made-up name.
 */
const { serviceAuth, ids } = require('openvibe-contracts');

const TTL_MS = 6 * 60 * 60 * 1000;
const WAIT_MS = 2500;

function createPeople({ store, config, fetchImpl = globalThis.fetch }) {
    const { db } = store;
    const enabled = Boolean(config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'identity.subject.resolve', fetchImpl,
    }) : null;
    const q = {
        get: db.prepare('SELECT * FROM subject_projections WHERE subject = ?'),
        byUsername: db.prepare('SELECT * FROM subject_projections WHERE username = ? ORDER BY refreshed_at DESC LIMIT 1'),
        put: db.prepare(`INSERT INTO subject_projections (subject, username, display_name, avatar_url, refreshed_at) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT (subject) DO UPDATE SET username = excluded.username, display_name = excluded.display_name,
                         avatar_url = excluded.avatar_url, refreshed_at = excluded.refreshed_at`),
        seen: db.prepare('UPDATE subject_projections SET first_seen_at = ? WHERE subject = ? AND first_seen_at IS NULL'),
        firstSeen: db.prepare('SELECT first_seen_at FROM subject_projections WHERE subject = ?'),
    };
    const absAvatar = (u) => (!u ? null : /^https?:\/\//i.test(u) ? u : `${config.networkUrl}${u.startsWith('/') ? '' : '/'}${u}`);

    function remember(subject, p) {
        if (!ids.isSubjectId('user', subject) || !p) return;
        q.put.run(subject, p.username ? String(p.username).toLowerCase() : null, p.display_name || p.username || null, absAvatar(p.avatar_url), store.now());
    }

    async function resolve(subjects) {
        if (!tokens || !subjects.length) return;
        const res = await fetchImpl(`${config.networkInternalUrl}/internal/identity/resolve-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify({ subject_ids: subjects.slice(0, 500) }),
            signal: AbortSignal.timeout(8000),
        });
        if (res.status === 401) tokens.invalidate && tokens.invalidate();
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || typeof data.results !== 'object') throw new Error(`resolve-batch answered ${res.status}`);
        for (const s of subjects) if (data.results[s]) remember(s, data.results[s]);
    }

    const shape = (row, subject) => (row
        ? { subject: row.subject, username: row.username, name: row.display_name || row.username || 'a member', avatarUrl: row.avatar_url, known: Boolean(row.username || row.display_name) }
        : { subject, username: null, name: 'a member', avatarUrl: null, known: false });

    return {
        enabled,
        /** From a verified sign-in: the member's own claims are a fresh projection. */
        rememberClaims(subject, claims) { remember(subject, claims); q.seen.run(store.now(), subject); },

        /** When Deals first saw this person signed in (abuse controls: account age evidence), or null. */
        firstSeen(subject) { const r = q.firstSeen.get(subject); return r ? r.first_seen_at : null; },

        /** Map subject → { name, username, avatarUrl, known }. Missing entries are fetched (bounded wait). */
        async many(subjects) {
            const list = [...new Set((subjects || []).filter((s) => ids.isSubjectId('user', s)))];
            const missing = list.filter((s) => { const r = q.get.get(s); return !r || store.now() - r.refreshed_at > TTL_MS; });
            if (missing.length && tokens) {
                let timer;
                await Promise.race([
                    resolve(missing).catch((err) => console.warn('[Deals] identity resolve failed:', err.message)),
                    new Promise((r) => { timer = setTimeout(r, WAIT_MS); }),
                ]);
                clearTimeout(timer);
            }
            return new Map(list.map((s) => [s, shape(q.get.get(s), s)]));
        },

        async one(subject) { return (await this.many([subject])).get(subject) || shape(null, subject); },

        /** The subject a username belongs to, from people Deals has seen. */
        byUsername(username) {
            const row = q.byUsername.get(String(username || '').toLowerCase());
            return row ? shape(row, row.subject) : null;
        },

        cached: (subject) => shape(q.get.get(subject), subject),
    };
}

module.exports = { createPeople };
