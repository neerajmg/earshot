'use strict';
// docs/GUIDE.md is partly generated from the page. This fails when the page
// moved on and the guide did not; `npm run guide` brings it back.
const test = require('node:test');
const assert = require('node:assert');
const guide = require('../tools/make-guide.js');

// Gated while the OFDM product UI is under construction (approved in the
// project plan): every byte changed in the five product files otherwise
// forces a minute of Chrome per commit. Re-enable by default at release:
// GUIDE_CHECK=1 npm test, and npm run guide:check still works any time.
test('docs/GUIDE.md matches the code (run npm run guide if not)', { skip: !process.env.GUIDE_CHECK && 'set GUIDE_CHECK=1 (gated during OFDM UI construction)' }, () => {
  assert.deepStrictEqual(guide.check(), []);
});
