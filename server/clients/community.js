'use strict';

/**
 * Comments are OpenVibe.Community threads, referenced — never copied. An offer's thread is the one
 * Community resolves for EntityRef { service: 'deals', type: 'offer', id } (openvibe-publishing/
 * discussion stores only the thread id, in deal_offer_discussion_refs). Pages read the thread from
 * Community on render, so moderation and deletion there are always what readers see; a failure is
 * shown as "comments are unavailable", never as an empty or invented thread. A merged offer keeps
 * its own thread; the canonical offer's page shows it under "discussion from merged listings".
 *
 * Calls with Deals' service token (audience openvibe.community):
 *   community.comment.write     resolve a thread; comment as the signed-in member (X-OV-Subject)
 *   community.comment.moderate  (optional) hide the thread of an offer moderators disabled
 */
const { serviceAuth, http } = require('openvibe-contracts');
const { createDiscussionClient } = require('openvibe-publishing/discussion');

function createCommunity({ store, config, fetchImpl = globalThis.fetch }) {
    const base = config.community.internalUrl;
    const enabled = Boolean(config.oauth.clientSecret && base);
    const tokenClient = (scope) => serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.community', scope, fetchImpl,
    });
    const writeTokens = enabled ? tokenClient('community.comment.write') : null;
    const modTokens = enabled ? tokenClient('community.comment.moderate') : null;
    const discussion = enabled ? createDiscussionClient({ communityUrl: base, tokenClient: writeTokens, fetchImpl }) : null;

    const refFor = (offer, label) => ({ service: 'deals', type: 'offer', id: offer.id, ...(label ? { label: String(label).slice(0, 200) } : {}) });

    async function call(method, path, { tokens, subject, body, ctx, timeoutMs = 4000 } = {}) {
        const headers = { Accept: 'application/json', ...(ctx ? http.outboundHeaders(ctx) : {}) };
        if (tokens) Object.assign(headers, await tokens.authHeaders());
        if (subject) headers['X-OV-Subject'] = subject;
        if (body) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
        const data = await res.json().catch(() => null);
        if (res.status === 401 && tokens && tokens.invalidate) tokens.invalidate();
        if (!res.ok) {
            const err = new Error((data && (data.detail || data.error)) || `Community answered ${res.status}`);
            err.status = res.status;
            err.code = data && data.code;
            throw err;
        }
        return data;
    }

    return {
        enabled,
        publicUrl: config.community.publicUrl,

        /** The stored thread id (no network call), or null. */
        knownThread(offer) { const k = store.discussion.get(offer.id); return k ? k.threadId : null; },

        /** The stored thread id, or resolve it once through Community. */
        async threadFor(offer, label, ctx) {
            const known = store.discussion.get(offer.id);
            if (known) return known.threadId;
            if (!discussion) return null;
            const out = await store.discussion.threadFor(offer.id, refFor(offer, label), { client: discussion, traceparent: ctx && ctx.traceparent, requestId: ctx && ctx.requestId });
            return out.threadId;
        },

        /** { thread, comments, next_cursor } read as an anonymous visitor (public data only). */
        async readThread(threadId, { after, ctx } = {}) {
            const qs = after ? `?after=${encodeURIComponent(after)}` : '';
            return call('GET', `/api/v1/comments/threads/${encodeURIComponent(threadId)}${qs}`, { ctx });
        },

        /** Comment as the signed-in member. */
        async comment(threadId, subject, { message, parentId } = {}, ctx) {
            if (!writeTokens) { const e = new Error('comments are not configured'); e.status = 503; throw e; }
            return call('POST', `/api/v1/comments/threads/${encodeURIComponent(threadId)}/comments`, {
                tokens: writeTokens, subject, body: { message, ...(parentId ? { parent_id: parentId } : {}) }, ctx,
            });
        },

        /**
         * Best effort: hide an offer's thread when moderators disable it, show it again when enabled. Needs community.comment.moderate.
         */
        async setThreadVisibility(offer, visibility, ctx) {
            const known = store.discussion.get(offer.id);
            if (!known || !modTokens) return false;
            try {
                await call('PUT', `/api/v1/comments/threads/${encodeURIComponent(known.threadId)}/visibility`, { tokens: modTokens, body: { visibility }, ctx });
                return true;
            } catch (err) {
                console.warn(`[Deals] could not set the comment thread of ${offer.id} to ${visibility}: ${err.message}`);
                return false;
            }
        },
    };
}

module.exports = { createCommunity };
