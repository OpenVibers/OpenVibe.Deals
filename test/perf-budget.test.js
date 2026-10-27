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
    htmlRawKB: 38,   // 33.2 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 29.1 with the curated front page's search, questions (FAQ + JSON-LD) and closing call (2026-10-22); 23.5 before
    htmlBrotliKB: 10,   // 8.3 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 7.1 with the curated front page (6.0 before; 4.5 before the showcase)
    jsFiles: 5,   // 5 (openvibe-shared 2.10's shell adds web-runtime.js)
    jsRawKB: 278,   // 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 263.4 with shared 4.11.0's seasonal navbar; 254.1 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 239.1 (212.2 before web-runtime.js)
    jsBrotliKB: 69,   // 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 61.7 with shared 4.11.0's seasonal navbar; 56.3 (49.9 before web-runtime.js)
    cssFiles: 2,   // 2 (deals.css, openvibe-shared showcase.css)
    cssRawKB: 35,   // 30.4 with Shared 4.13.0 (2026-10-26: account links); 24.2 with the front page's stats, cards, chips and questions (19.0 before)
    cssBrotliKB: 8,   // 6.5 with Shared 4.13.0 (2026-10-26: account links); 5.4 with the front page (2026-10-22); 4.7 with the crowdfunding rules; 1.5 before showcase.css
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
