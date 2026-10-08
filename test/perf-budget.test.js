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
    htmlRawKB: 25,   // measured 23.5 (fresh database, 2026-10-07; 17.2 before the showcase hero and features)
    htmlBrotliKB: 6.5,   // 6.0 (4.5 before the showcase)
    jsFiles: 5,   // 5 (openvibe-shared 2.10's shell adds web-runtime.js)
    jsRawKB: 250,   // 239.1 (212.2 before web-runtime.js)
    jsBrotliKB: 60,   // 56.3 (49.9 before web-runtime.js)
    cssFiles: 2,   // 2 (deals.css, openvibe-shared showcase.css)
    cssRawKB: 21,   // 19.0 with the deal cards
    cssBrotliKB: 4.6,   // 4.1 (1.5 before showcase.css)
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
