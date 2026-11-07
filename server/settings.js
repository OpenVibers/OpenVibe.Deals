'use strict';

/**
 * Owner settings (D11) for OpenVibe.Deals: the data-source keys in `deals.data_sources`.
 *
 * The Woot developer API key is read through wootApiKey() when a Woot read is made: the value the
 * owner entered in the admin panel wins, WOOT_API_KEY is the fallback. The key is sealed by the
 * shared store under OV_CONFIG_KEKS and is write-only through
 * /internal/config/deals.data_sources/secrets/woot_api_key; summaries, history and logs carry markers.
 * Network's admin proxy reaches this namespace with `deals.config.manage`, acting for the owner
 * (X-OV-Subject); a secret change needs X-OV-Fresh: 1. The test route reads one deal from Woot and
 * answers ok or failed in one line, never echoing the key.
 */
const { createConfigStore, adminRoutes } = require('openvibe-shared/config');

const SERVICE = 'deals';
const NAMESPACE = 'deals.data_sources';
const BASE_PATH = '/internal/config';
const GROUP = 'Data sources';

const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Deals data sources',
    description: 'The accounts Deals reads deals from. A source with no key is skipped; the other sources keep working.',
    type: 'object',
    additionalProperties: false,
    properties: {
        woot_api_key: {
            type: 'string', title: 'Woot API key', 'x-group': GROUP,
            description: 'The developer key for Woot\'s own API. It lets Deals read Woot deals directly instead of crawling their pages; without it Woot is only covered by the crawler.',
            'x-owner-input': {
                group: GROUP,
                unlocks: 'Woot deals can be read from Woot\'s API, with current prices and stock instead of a page crawl.',
                get_it_at: 'https://developer.woot.com/',
                get_it_how: 'Request a developer key on the Woot developer portal and paste the key it gives you here.',
                test: true,
            },
            'x-required-for': 'Woot API deals',
        },
    },
});

const SECRETS = new Set(['woot_api_key']);
const ACTIVE = { settings: null };

function createSettings({ db, env = process.env, log = console, fetchImpl = globalThis.fetch, probes = null } = {}) {
    let store = null;
    const ready = createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA,
        classify: (key) => (SECRETS.has(key) ? 'secret' : 'internal'),
        env, log,
    }).then((s) => { store = s; return s; });

    const values = () => (store ? store.get() : {});

    function valueOf(key, envName, fallback = '') {
        const v = values()[key];
        if (v !== undefined && v !== null && v !== '') return v;
        const e = envName ? env[envName] : undefined;
        return e !== undefined && e !== null && e !== '' ? e : fallback;
    }

    /** The Woot key, read when a Woot read is made. */
    function wootApiKey() { return valueOf('woot_api_key', 'WOOT_API_KEY', ''); }

    async function test(key) {
        if (key !== 'woot_api_key') return { ok: false, detail: 'That setting has no test.' };
        const apiKey = wootApiKey();
        if (!apiKey) return { ok: false, detail: 'Woot is not configured: paste the API key first.' };
        const probe = probes && typeof probes.woot === 'function'
            ? probes.woot
            : async ({ apiKey: keyValue }) => {
                const r = await fetchImpl('https://api.woot.com/v1/deals?limit=1', { headers: { accept: 'application/json', 'x-api-key': keyValue } });
                let body = {};
                try { body = await r.json(); } catch { /* not JSON */ }
                if (!r.ok) throw new Error(`HTTP ${r.status}${body && body.message ? `: ${body.message}` : ''}`);
            };
        try {
            await probe({ apiKey });
            return { ok: true, detail: 'ok — Woot answered a one-deal read with this key.' };
        } catch (err) {
            const words = String((err && err.message) || 'the request failed').split(/\s+/).join(' ').slice(0, 160);
            return { ok: false, detail: `failed — Woot said: ${words.split(apiKey).join('[redacted]')}` };
        }
    }

    function mount(app, { guard, log: appLog = log } = {}) {
        if (!store) throw new Error('createSettings: await ready before mount()');
        const routes = adminRoutes([store], {
            basePath: BASE_PATH,
            requireAdmin: guard,
            actor: (req) => {
                const id = String(req.get('x-ov-subject') || '').trim();
                return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
            },
            requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
            log: appLog,
        });
        app.use(routes.handle);
        app.post(`${BASE_PATH}/:namespace/test/:key`, guard, async (req, res) => {
            if (req.params.namespace !== NAMESPACE) return res.status(404).json({ error: 'no such configuration namespace' });
            let key = String(req.params.key || '');
            try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
            if (!SCHEMA.properties[key]) return res.status(404).json({ error: 'no such setting' });
            try {
                const out = await test(key);
                return res.status(200).json({ ok: Boolean(out.ok), detail: String(out.detail).replace(/\s+/g, ' ').slice(0, 200) });
            } catch (err) {
                appLog.warn(`[config] ${NAMESPACE}: the test for ${key} failed: ${String((err && err.message) || err).slice(0, 160)}`);
                return res.status(200).json({ ok: false, detail: 'failed — the test did not finish. The service log has the reason.' });
            }
        });
        return routes;
    }

    return { namespace: NAMESPACE, schema: SCHEMA, ready, value: valueOf, get: values, wootApiKey, test, mount };
}

function activate(settings) { ACTIVE.settings = settings; return settings; }
function wootApiKey() {
    if (ACTIVE.settings) return ACTIVE.settings.wootApiKey();
    return process.env.WOOT_API_KEY || '';
}

module.exports = { SERVICE, NAMESPACE, SCHEMA, SECRETS, createSettings, activate, wootApiKey };
