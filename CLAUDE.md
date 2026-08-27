# earshot

Two user guides, both partly generated from the pages by `npm run guide`
(`tools/make-guide.js`, needs Google Chrome, about three minutes for both):

- `docs/GUIDE.md` covers the product page. Sources: index.html, earshot.js,
  worker.js, capture-worklet.js, air.js, ofdm.js, chirp.js, fec.js,
  fountain.js, fft.js, diag.js, modem.js. Screenshots in
  docs/screenshots/product/.
- `docs/LAB.md` covers the lab page. Sources: lab.html, app.js, diag.js,
  modem.js, dsp.js. Screenshots in docs/screenshots/lab/.

`npm test` fails while a guide is behind its sources, and a PostToolUse hook
in .claude/settings.json says so right after an edit.

After changing any source file:

1. `npm run guide product` or `npm run guide lab` (or plain `npm run guide`
   for both).
2. Read the prose in the guide around what changed and fix it by hand. The
   generator refreshes screenshots and the tables between `<!-- gen:... -->`
   markers, not sentences. A new button, label or disclosure must be
   described as **its visible text** or the check fails.
3. `npm test`.
