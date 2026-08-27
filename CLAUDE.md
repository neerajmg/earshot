# Acoustic FSK modem

docs/GUIDE.md is the user guide. Its screenshots (docs/screenshots/) and the
tables between `<!-- gen:... -->` markers are generated from index.html,
app.js, diag.js, modem.js and dsp.js by `npm run guide`. `npm test` fails
while the guide is behind those five files, and a PostToolUse hook in
.claude/settings.json says so right after an edit.

After changing any of the five:

1. `npm run guide` (needs Google Chrome, takes about a minute).
2. Read the prose in docs/GUIDE.md around what changed and fix it by hand.
   The generator refreshes pictures and tables, not sentences. A new
   button or label must be described as **its visible text** or the check
   fails.
3. `npm test`.
