#!/usr/bin/env node
'use strict';
/**
 * Create Deals' OpenVibe.Events subscription for OpenVibe.Sources item changes (they only wake the
 * importer, which reads the deals change feed from its cursor; nothing is lost if this is never run).
 *
 *   node scripts/subscribe.js [--endpoint http://127.0.0.1:4840/internal/events] [--pattern 'sources.item.*']
 *
 * Reads the environment (.env or /etc/openvibe/deals.env):
 *   EVENTS_URL, OV_NETWORK_INTERNAL_URL, OV_OAUTH_CLIENT_ID, OV_OAUTH_CLIENT_SECRET  (the deals
 *   principal needs events.subscription.manage for audience openvibe.events)
 *   DEALS_EVENTS_SECRET  the delivery signing secret; the first value is handed to Events, so
 *                         generate it before running this (e.g. `openssl rand -hex 32`). Nothing
 *                         secret is printed.
 * An existing identical subscription is reported, not duplicated.
 */
require('dotenv').config();
const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };

(async () => {
    const config = load();
    const endpoint = opt('endpoint', `http://127.0.0.1:${config.port}/internal/events`);
    const pattern = opt('pattern', 'sources.item.*');
    const secret = config.events.webhookSecrets[0];
    if (!config.events.url) throw new Error('EVENTS_URL is not set');
    if (!secret || secret.length < 32) throw new Error('DEALS_EVENTS_SECRET must be set (32+ characters) before subscribing');
    if (!config.oauth.clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events',
        scope: 'events.subscription.manage',
    });
    const res = await fetch(`${config.events.url}/api/v1/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
        body: JSON.stringify({ topic_pattern: pattern, endpoint, secret }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.subscription_id) {
        console.log(`subscription exists: ${body.subscription_id} (${pattern} → ${endpoint})`);
        return;
    }
    if (!res.ok) throw new Error(`Events answered ${res.status}: ${body.code || ''} ${body.detail || ''}`.trim());
    console.log(`subscribed: ${body.id} (${pattern} → ${endpoint}). Replay history with POST /api/v1/deliveries/replay { subscription_id, from_seq }.`);
})().catch((err) => {
    console.error(`subscribe failed: ${err.message}`);
    process.exit(1);
});
