'use strict';
// docs/GUIDE.md and docs/LAB.md are partly generated from the pages. This
// fails when a page moved on and its guide did not; `npm run guide` brings
// them back. It reads files only, no Chrome. GUIDE_CHECK=0 skips it while
// a page is mid-change and the screenshots are not worth retaking yet.
const test = require('node:test');
const assert = require('node:assert');
const guide = require('../tools/make-guide.js');

test('the guides match the code (run npm run guide if not)', { skip: process.env.GUIDE_CHECK === '0' && 'GUIDE_CHECK=0' }, () => {
  assert.deepStrictEqual(guide.check(), []);
});
