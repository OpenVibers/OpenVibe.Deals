'use strict';
/**
 * T9 J4: Deals runs on the openvibe-publishing 1.1.0 chassis. This proves the conversion:
 *   - the local copies the brief's §7 lists are gone (nothing under server/ requires them);
 *   - a dry-run ingest from the captured Sources fixture produces the same domain rows as the
 *     pre-conversion code (test/fixtures/ingest-golden.json, captured before the change);
 *   - the Search document validates against search.index-document@1, with its provenance and
 *     visibility;
 *   - the outbox row and the state change share the caller's transaction (a rollback drops both).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { feedDeals, reviseDeals, project } = require('./helpers/golden');

const ROOT = path.join(__dirname, '..');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ingest-golden.json'), 'utf8'));

// The brief's §7 deletion list for Deals (plus the Sources client, which the chassis' ingest entry
// point replaces): the chassis (openvibe-publishing/ingest and /publication) owns their code now.
// The harness denies rm, so the files may remain on disk; they must not be required by any live
// server file.
const DELETED = ['server/domain/importer.js', 'server/domain/util.js', 'server/http/internal.js', 'server/clients/sources.js']
    .map((f) => path.join(ROOT, f));

function jsFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) jsFiles(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}
function relativeRequires(file) {
    const src = fs.readFileSync(file, 'utf8');
    return [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).filter((s) => s.startsWith('.'));
}

(async () => {
    await check('the local chassis copies are gone: no live server file requires them', () => {
        const gone = new Set(DELETED);
        for (const file of jsFiles(path.join(ROOT, 'server'))) {
            if (gone.has(file)) continue;   // the (undeletable) files themselves
            for (const spec of relativeRequires(file)) {
                let resolved;
                try { resolved = require.resolve(path.resolve(path.dirname(file), spec)); } catch { continue; }
                assert.ok(!gone.has(resolved), `${path.relative(ROOT, file)} still requires ${spec}`);
            }
        }
        // ...and the chassis entry points are the ones the app uses.
        assert.match(fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8'), /openvibe-publishing\/ingest/);
        assert.match(fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8'), /\.\/domain\/source-items/);
        assert.match(fs.readFileSync(path.join(ROOT, 'server', 'domain', 'indexing.js'), 'utf8'), /openvibe-publishing\/publication/);
    });

    const t = await boot();
    feedDeals(t);
    await t.ctx.importer.pull();
    reviseDeals(t);
    await t.ctx.importer.pull();

    await check('a dry-run ingest from the captured Sources fixture produces the same domain rows as before', async () => {
        assert.deepStrictEqual(await project(t), GOLDEN);
    });

    await check('the Search document validates against search.index-document@1, with its provenance and visibility', async () => {
        const espresso = await t.ctx.store.db.prepare('SELECT * FROM deal_offers WHERE url = ?').get('https://coffee.example/espresso');
        const r = await t.get(`/mod/offers/${espresso.slug}/review`, { as: t.mod, form: {} });
        assert.strictEqual(r.status, 303, r.text.slice(0, 200));
        const doc = (await t.events('deals.index_document.upserted')).filter((e) => e.payload.id === espresso.id).pop().payload;
        const v = contracts.validate('search.index-document@1', doc);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(doc.visibility, 'public');
        assert.strictEqual(doc.indexability.decision, 'index');
        assert.deepStrictEqual(doc.provenance.filter((p) => p.service === 'sources').map((p) => p.id), ['itm_01K5GOLDEN00000000000A1']);
    });

    await check('the outbox row and the state change share the caller\'s transaction (a rollback drops both)', async () => {
        const offer = await t.ctx.store.db.prepare("SELECT * FROM deal_offers WHERE url = 'https://coffee.example/espresso'").get();
        const row = async () => await t.ctx.store.db.prepare('SELECT title FROM deal_offers WHERE id = ?').get(offer.id);
        const outboxCount = async () => (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get()).n;
        const before = await outboxCount();
        await assert.rejects(t.ctx.store.db.tx(async () => {
            await t.ctx.store.db.prepare('UPDATE deal_offers SET title = ? WHERE id = ?').run('Rolled back title', offer.id);
            await t.ctx.indexing.indexOffer(await t.ctx.reads.get(offer.id));
            throw new Error('rollback: the outbox row and the state change must not survive together');
        }));
        assert.strictEqual(await outboxCount(), before, 'no outbox row survives the rollback');
        assert.strictEqual((await row()).title, offer.title, 'the state change rolled back with it');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
