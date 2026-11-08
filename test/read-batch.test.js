'use strict';
/**
 * A list of offers reads each offer's latest observation and latest hotness snapshot once, not once per offer.
 *
 * On 2026-11-08 the two per-offer reads were 2.1 M and 3.5 M calls a day (324 s and 251 s of DB time,
 * pg_stat_statements, `reads.lastSnapshot` and `reads.latestObservation`), repeated by every page that renders
 * offers. They are now one statement per turn: a page of six offers is one query of each, and each view still
 * carries its own offer's latest observation and snapshot.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const db = t.ctx.store.db;
    const poster = t.network.addUser('poster');

    const offers = [];
    for (let i = 0; i < 6; i++) {
        offers.push(await t.submit(poster, { url: `https://batch.example/${i}`, title: `Batch offer ${i}`, price: String(10 + i), currency: 'USD' }));
    }
    // A snapshot of its own for each offer (snapshot() also writes the offer's hot_latest).
    for (const [i, o] of offers.entries()) await t.ctx.hotness.snapshot(o.id, 'tick', t.clock.now() + i);

    const seen = { latest: 0, snapshots: 0 };
    const query = db.query.bind(db);
    db.query = (text, values) => {
        if (/DISTINCT ON \(o\.offer_id\)/.test(text)) seen.latest++;
        else if (/DISTINCT ON \(offer_id\)/.test(text)) seen.snapshots++;
        return query(text, values);
    };
    let views;
    try {
        views = await Promise.all(offers.map((o) => t.ctx.publication.offerView(o)));
    } finally {
        db.query = query;
    }

    await check('a page of six offers reads latest observations and snapshots once each', async () => {
        assert.strictEqual(seen.latest, 1, 'one latest-observation query for the page');
        assert.strictEqual(seen.snapshots, 1, 'one snapshot query for the page');
    });

    await check('each view still carries its own latest observation and snapshot', async () => {
        for (const [i, v] of views.entries()) {
            assert.strictEqual(v.root.id, offers[i].id);
            assert.strictEqual(v.latest.offer_id, offers[i].id);
            assert.strictEqual(v.latest.price_num, 10 + i);
            assert.strictEqual(v.hotness.offer_id, offers[i].id);
        }
    });

    await check('the batched answer is the row the old one-per-offer query returned', async () => {
        const id = offers[2].id;
        const batched = await t.ctx.reads.latestObservation([id]);
        const direct = await db.prepare(`SELECT o.*, s.kind AS source_kind, s.ref_service, s.ref_id, s.source_key, s.url AS source_url, s.label AS source_label
                                           FROM deal_price_observations o JOIN deal_offer_sources s ON s.id = o.source_id
                                          WHERE o.offer_id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb)) AND s.removed_at IS NULL
                                          ORDER BY o.observed_at DESC, o.seq DESC LIMIT 1`).get(JSON.stringify([id]));
        assert.deepStrictEqual(batched, direct);
        const snap = await t.ctx.reads.lastSnapshot(id);
        const directSnap = await db.prepare('SELECT * FROM deal_hotness_snapshots WHERE offer_id = ? ORDER BY id DESC LIMIT 1').get(id);
        assert.deepStrictEqual(snap, directSnap);
    });

    await t.close();
    done();
})();
