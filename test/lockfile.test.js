'use strict';
/**
 * Every codeload GitHub tarball pin is installed as-is by `npm ci`, so its lock entry must keep an
 * integrity and point at the same tag package.json pins. A hand-edited bump can drop the integrity
 * (it happened to openvibe-publishing v1.2.0); without this the tarball is accepted unchecked.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers/boot');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

(async () => {
    await check('every codeload GitHub tarball pin has a lock entry with sha512 integrity and the same resolved URL', async () => {
        const pins = { ...pkg.dependencies, ...pkg.devDependencies };
        const tarballs = Object.entries(pins).filter(([, spec]) => /^https:\/\/codeload\.github\.com\//.test(spec));
        assert.ok(tarballs.length > 0, 'expected at least one codeload tarball pin');
        for (const [name, spec] of tarballs) {
            const entry = lock.packages[`node_modules/${name}`];
            assert.ok(entry, `package-lock.json has no entry for ${name}`);
            assert.strictEqual(entry.resolved, spec, `${name}: package.json and package-lock.json disagree on the tag`);
            assert.match(entry.integrity || '', /^sha512-[A-Za-z0-9+/]+=*$/, `${name}: lock entry has no sha512 integrity`);
        }
    });
    done();
})();
