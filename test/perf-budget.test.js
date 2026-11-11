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

// 2026-11-08: openvibe-shared v4.152.0; CI measured JS 356.6 KB raw / 85.0 KB brotli.
// 2026-11-08: openvibe-shared v4.150.0; CI measured JS 353.9 KB raw / 84.4 KB brotli.
// 2026-11-08: openvibe-shared v4.149.0; CI measured JS 352.9 KB raw / 84.2 KB brotli.
const BUDGETS = {
    htmlRawKB: 47, // 47 openvibe-shared v4.202.0 (2026-11-11: measured 46.7, raised by pin-bump from 46); 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 42.4 measured 2026-11-10: the empty home's kit empty state (the measured database is fresh); 41.1 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 40.1 with the short home's pick blocks and folds (2026-10-30); 33.2 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 29.1 with the curated front page's search, questions (FAQ + JSON-LD) and closing call (2026-10-22); 23.5 before
    htmlBrotliKB: 10.5,   // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 8.3 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 7.1 with the curated front page (6.0 before; 4.5 before the showcase)
    jsFiles: 6,   // 6: the signed-out page's passkey enhancement (2026-11-11, related-origin passkeys); 5 before it, with openvibe-shared 2.10's web-runtime.js
    jsRawKB: 394.5, // 394.5: measured 394.1 with openvibe-shared 4.197.0 (2026-11-10: the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 376.4: measured 376.3 KB raw with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 375.1: measured 367.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 3,   // 3 on the empty home (deals.css, shared showcase.css and kit.css for the empty state); 2 on every other home
    cssRawKB: 100,   // 98.7 measured 2026-11-10: kit.css on the empty home; 49.9 with 2026-11-01: category and store tiles (2026-11-01); 48.2 with the pick chips and fold rules (2026-10-30); 45.1 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 43.3 touch targets on phones (2026-10-29); 38.2 openvibe-shared 4.26.1 (hero visual); 30.4 with Shared 4.13.0 (2026-10-26: account links); 24.2 with the front page's stats, cards, chips and questions (19.0 before)
    cssBrotliKB: 21,   // 20.2 measured 2026-11-10: kit.css on the empty home; 10.1 with the pick chips and fold rules (2026-10-30); 8.1 openvibe-shared 4.26.1 (hero visual); 6.5 with Shared 4.13.0 (2026-10-26: account links); 5.4 with the front page (2026-10-22); 4.7 with the crowdfunding rules; 1.5 before showcase.css
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
