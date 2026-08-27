'use strict';
// docs/GUIDE.md is partly generated from the page. This fails when the page
// moved on and the guide did not; `npm run guide` brings it back.
const test = require('node:test');
const assert = require('node:assert');
const guide = require('../tools/make-guide.js');

test('the guides match the code (run npm run guide if not)', () => {
  assert.deepStrictEqual(guide.check(), []);
});
