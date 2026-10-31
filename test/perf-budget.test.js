'use strict';
// Size budgets for openvibe.deals' home page (openvibe-shared/perf-budget): the server as it runs (a
// fresh database), measured without a browser. Budgets sit a little above today's measurement; raising
// one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

const BUDGETS = {
    htmlRawKB: 42,   // 41.1 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 40.1 with the short home's pick blocks and folds (2026-10-30); 33.2 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 29.1 with the curated front page's search, questions (FAQ + JSON-LD) and closing call (2026-10-22); 23.5 before
    htmlBrotliKB: 10,   // 8.3 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 7.1 with the curated front page (6.0 before; 4.5 before the showcase)
    jsFiles: 5,   // 5 (openvibe-shared 2.10's shell adds web-runtime.js)
    jsRawKB: 326,   // 324.8 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 323.2 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 321.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 318.1 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 315.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 307.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 300.5 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 293 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 263.4 with shared 4.11.0's seasonal navbar; 254.1 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 239.1 (212.2 before web-runtime.js)
    jsBrotliKB: 80,   // 79.5 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 78.2 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 56.3 (49.9 before web-runtime.js)
    cssFiles: 2,   // 2 (deals.css, openvibe-shared showcase.css)
    cssRawKB: 49,   // 48.2 with the pick chips and fold rules (2026-10-30); 45.1 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 43.3 touch targets on phones (2026-10-29); 38.2 openvibe-shared 4.26.1 (hero visual); 30.4 with Shared 4.13.0 (2026-10-26: account links); 24.2 with the front page's stats, cards, chips and questions (19.0 before)
    cssBrotliKB: 11,   // 10.1 with the pick chips and fold rules (2026-10-30); 8.1 openvibe-shared 4.26.1 (hero visual); 6.5 with Shared 4.13.0 (2026-10-26: account links); 5.4 with the front page (2026-10-22); 4.7 with the crowdfunding rules; 1.5 before showcase.css
    externalFiles: 1,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '',
            DEALS_PGLITE_DIR: pgliteDir, DEALS_WORKER: 'off', DEALS_IMPORT: 'off',
            OV_SOURCES_INTERNAL_URL: '', EVENTS_URL: '', INDEXNOW_KEY: '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (DEALS_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
