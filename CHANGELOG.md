# Changelog

## Unreleased

- openvibe-contracts moves from v0.79.0 to v0.97.0 (pin, lockfile and `node_modules`); nothing in the range breaks Deals, and the contracts' own service check is green. All twelve `deals.*` ids are now defined by the release, so `server/auth/capabilities.js` drops its local fallback for proposed ids and sends every check through the library's grant rule; `test/capabilities.test.js` pins that every guarded id is defined and that exact, prefix, denied and unknown ids answer as `capabilities.check()` does. README and STATUS.json name v0.97.0.
- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; robots and the canonical still come from the indexability gate's decision. Styling is unchanged.
