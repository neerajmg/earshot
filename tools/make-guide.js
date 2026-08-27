#!/usr/bin/env node
// Keeps docs/GUIDE.md in step with the page.
//
// The guide is hand-written prose plus two kinds of generated content: the
// screenshots in docs/screenshots/, taken from the real page in headless
// Chrome, and the tables between <!-- gen:NAME --> and <!-- /gen:NAME -->
// markers, computed from modem.js, dsp.js, app.js and lab.html. A manifest
// records which sources the screenshots were taken from, so `--check` can
// tell when the page changed and the pictures did not.
//
//   node tools/make-guide.js            screenshots and tables (needs Chrome, about a minute)
//   node tools/make-guide.js --text     tables only, no Chrome
//   node tools/make-guide.js --check    exit 1 and say why if the guide is behind the code
//   node tools/make-guide.js --hook     the same check as a Claude Code PostToolUse hook
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');
const ch = require('../test/helpers/channel.js');

const root = path.resolve(__dirname, '..');
const GUIDE = path.join(root, 'docs', 'GUIDE.md');
const SHOTS = path.join(root, 'docs', 'screenshots');
const MANIFEST = path.join(SHOTS, 'manifest.json');
// Anything a user can see or hear comes from these five files.
const PRODUCT = ['lab.html', 'app.js', 'diag.js', 'modem.js', 'dsp.js'];
function findChrome() {
  const { execSync } = require('child_process');
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execSync('command -v ' + name, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch (e) { /* keep looking */ }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const CHROME = findChrome();
const PRESET = 'robust';
// What the fake microphone hears: the transfer at about -36 dBFS with white noise 40 dB under it,
// roughly a laptop half a metre away in a quiet room. Full scale with no noise reads SNR 155 dB
// and paints the spectrogram solid, which is arithmetic, not a room.
const MIC_GAIN = 0.03;
const MIC_SNR_DB = 40;
const VIEW = { width: 1280, height: 1120 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ text blocks

function read(name) { return fs.readFileSync(path.join(root, name), 'utf8'); }

function sourceHash() {
  const h = crypto.createHash('sha256');
  for (const f of PRODUCT) { h.update(f); h.update('\0'); h.update(read(f)); h.update('\0'); }
  return h.digest('hex').slice(0, 16);
}

function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(2) + ' MB'; }

// Pulls one number out of a source file by regex. Fails loudly, so a renamed
// constant breaks `npm test` instead of leaving a stale number in the guide.
function grab(file, re, what) {
  const m = read(file).match(re);
  if (!m) throw new Error(`could not find ${what} in ${file}; update tools/make-guide.js`);
  return m[1];
}

function passTime(preset, bytes) {
  const n = new Modem.Sender(new Uint8Array(bytes), 'x', { session: 0 }).passSequence().length;
  return { frames: n, seconds: n * DSP.frameDuration(preset) };
}

function renderBlocks() {
  const rows = [];
  rows.push('| preset | baud | tones | one frame | 1 kB, one pass | 10 kB, one pass | payload rate |');
  rows.push('|---|---:|---|---:|---:|---:|---:|');
  for (const k of Object.keys(Modem.PRESETS)) {
    const p = Modem.PRESETS[k];
    const one = passTime(p, 1024), ten = passTime(p, 10240);
    rows.push(`| \`${p.name}\` | ${p.baud} | ${p.spaceHz} / ${p.markHz} Hz | ${DSP.frameDuration(p).toFixed(2)} s | ${fmtTime(one.seconds)} (${one.frames} frames) | ${fmtTime(ten.seconds)} | ${(10240 / ten.seconds).toFixed(0)} B/s |`);
  }
  const presets = rows.join('\n');

  const maxBytes = 0xFFFF * Modem.FRAME.DATA;                       // seq is two bytes in the frame header
  const recSec = Number(grab('app.js', /const REC_MAX_SEC = (\d+)/, 'REC_MAX_SEC'));
  const wavCap = grab('app.js', /total \* 2 > (\d+e\d+)/, 'the WAV size cap');
  const passes = read('lab.html').match(/id="passes" value="(\d+)" min="(\d+)" max="(\d+)"/);
  if (!passes) throw new Error('could not find the Passes input in lab.html; update tools/make-guide.js');
  const level = read('lab.html').match(/id="amp" min="([\d.]+)" max="([\d.]+)" step="[\d.]+" value="([\d.]+)"/);
  if (!level) throw new Error('could not find the Level slider in lab.html; update tools/make-guide.js');
  const limits = [
    `- Largest file: ${maxBytes.toLocaleString('en-US')} bytes (${fmtBytes(maxBytes)}), ${Modem.FRAME.DATA} bytes per frame and a two-byte frame number.`,
    `- **Passes**: ${passes[2]} to ${passes[3]}, default ${passes[1]}; or **until stopped**.`,
    `- **Level**: ${level[1]} to ${level[2]}, default ${level[3]}.`,
    `- **record mic to WAV** stops itself after ${recSec / 60} minutes.`,
    `- **Download WAV** refuses to render more than ${Number(wavCap) / 1e6} MB; use fewer passes or 16 kHz.`,
    `- Frame: ${Modem.PREAMBLE_SYMBOLS} preamble + ${Modem.SYNC_BITS.length} sync + ${Modem.FRAME.BITS} payload symbols; ${Modem.FRAME.RAW} bytes become ${Modem.FRAME.CODED} through Hamming(8,4); CRC-16 per frame, CRC-32 per file.`,
  ].join('\n');

  return { presets, limits };
}

function applyBlocks(text, blocks) {
  for (const name of Object.keys(blocks)) {
    const re = new RegExp(`(<!-- gen:${name} -->)[\\s\\S]*?(<!-- /gen:${name} -->)`);
    if (!re.test(text)) throw new Error(`docs/GUIDE.md has no <!-- gen:${name} --> block`);
    text = text.replace(re, `$1\n${blocks[name]}\n$2`);
  }
  return text;
}

function strip(html) { return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

// Every button and labelled control on the page, by the text a user sees.
function controlLabels() {
  const html = read('lab.html');
  const out = new Set();
  for (const m of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)) out.add(strip(m[1]));
  // A label's own words, not the options of the menu inside it.
  for (const m of html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)) out.add(strip(m[1].replace(/<select[\s\S]*?<\/select>/g, '')));
  return [...out].filter(Boolean);
}

function screenshotRefs(text) {
  return [...text.matchAll(/\]\((screenshots\/[^)]+\.png)\)/g)].map((m) => m[1]);
}

// Returns a list of problems; empty means the guide matches the code.
function check() {
  const problems = [];
  if (!fs.existsSync(GUIDE)) return ['docs/GUIDE.md is missing'];
  const text = fs.readFileSync(GUIDE, 'utf8');
  let blocks;
  try { blocks = renderBlocks(); } catch (e) { return [e.message]; }
  for (const name of Object.keys(blocks)) {
    const re = new RegExp(`<!-- gen:${name} -->\\n([\\s\\S]*?)\\n<!-- /gen:${name} -->`);
    const m = text.match(re);
    if (!m) problems.push(`docs/GUIDE.md has no <!-- gen:${name} --> block`);
    else if (m[1] !== blocks[name]) problems.push(`the ${name} table in docs/GUIDE.md is behind the code`);
  }
  const refs = screenshotRefs(text);
  for (const r of refs) if (!fs.existsSync(path.join(root, 'docs', r))) problems.push(`docs/${r} is missing`);
  if (!fs.existsSync(MANIFEST)) problems.push('docs/screenshots/manifest.json is missing: the screenshots have not been generated');
  else {
    const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (man.sourceHash !== sourceHash()) problems.push(`the screenshots were taken from older sources (${man.sourceHash}, now ${sourceHash()})`);
    for (const f of man.files || []) if (!refs.includes('screenshots/' + f)) problems.push(`docs/screenshots/${f} is generated but the guide does not show it`);
    for (const r of refs) if (!(man.files || []).includes(r.replace('screenshots/', ''))) problems.push(`docs/${r} is not in the manifest; is it generated?`);
  }
  for (const label of controlLabels()) if (!text.includes(`**${label}**`)) problems.push(`the control "${label}" is on the page but not in docs/GUIDE.md (write it as **${label}**)`);
  return problems;
}

// ------------------------------------------------------------ the sample transfer

const SAMPLE_NAME = 'notes.txt';
const SAMPLE_TEXT = `Acoustic modem test note

This file crosses the room as sound. The sender plays it as two
alternating tones; the microphone on the other laptop hears them, and
the page there rebuilds the bytes and checks them against a CRC-32
before it lets you download the result.

Frames that fail on the first pass are picked up on the next one; the
receiver keeps what it has and waits for the rest.

If you can read this on the other laptop, the transfer worked.
`;
const SESSION = 7;   // fixed, so the log lines in the screenshots do not change between runs

function renderTransfer(preset, fs, pass, leadSec) {
  const bytes = new Uint8Array(Buffer.from(SAMPLE_TEXT));
  const seq = new Modem.Sender(bytes, SAMPLE_NAME, { session: SESSION }).passSequence();
  const parts = [new Float32Array(Math.round(leadSec * fs))];
  for (const raw of seq) parts.push(DSP.modulateFrame(Modem.frameToBits(raw, pass), preset, fs));
  parts.push(new Float32Array(fs));
  return { signal: ch.concat(parts), frames: seq.length };
}

function countOk(signal, preset, fs) {
  let ok = 0, seen = 0;
  const demod = new DSP.Demodulator(preset, fs, {
    onSync: () => {},
    onFrame: (f) => { seen++; const p = Modem.parseFrame(Modem.bitsToFrame(f.bits).raw); if (p.crcOk) ok++; return p.crcOk; },
  });
  for (let off = 0; off < signal.length; off += 4096) demod.push(signal.subarray(off, Math.min(signal.length, off + 4096)));
  return { ok, seen };
}

// A transfer bad enough to show red frames but not so bad that nothing
// decodes. Searched, not fixed, so the picture stays meaningful if the
// demodulator gets better or worse.
function noisyTransfer(preset, fs) {
  const clean = renderTransfer(preset, fs, 0, 0.5);
  for (const snr of [-8, -9, -10, -11, -12, -13, -14]) {
    const noisy = ch.awgn(clean.signal, snr, ch.rng(5));
    const r = countOk(noisy, preset, fs);
    if (r.ok >= 3 && r.ok <= clean.frames - 3) return { signal: noisy, snr, ok: r.ok, frames: clean.frames };
  }
  const noisy = ch.awgn(clean.signal, -11, ch.rng(5));
  return { signal: noisy, snr: -11, ...countOk(noisy, preset, fs), frames: clean.frames };
}

// ------------------------------------------------------------ Chrome

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wav': 'audio/wav' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const p = path.join(dir, u === '/' ? 'lab.html' : u);
      if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
      res.end(fs.readFileSync(p));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function withChrome(opts, fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modem-guide-'));
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=0',
    '--user-data-dir=' + path.join(work, 'profile'), `--window-size=${VIEW.width},${VIEW.height}`,
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (opts.micWav) args.push('--use-file-for-fake-audio-capture=' + opts.micWav + '%noloop');
  args.push('about:blank');
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let errText = '';
  chrome.stderr.on('data', (d) => { errText += d.toString(); });
  try {
    const m = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Chrome did not come up')), 20000);
      chrome.stderr.on('data', (d) => { const mm = errText.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (mm) { clearTimeout(t); resolve(mm[1]); } });
    });
    const port = new URL(m).port;
    let page = null;
    for (let i = 0; i < 50 && !page; i++) {
      try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = t.find((x) => x.type === 'page'); } catch (e) { /* not up yet */ }
      if (!page) await sleep(200);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = (msg) => { const d = JSON.parse(msg.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const view = { ...VIEW };
    const cdp = {
      // The page grows (the log, the idle spectrogram); keep the whole of it inside the viewport so clips never fall off the bottom.
      async fitViewport() {
        const h = await cdp.eval('document.documentElement.scrollHeight');
        if (h > view.height) { view.height = h; await cdp.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(300); }
      },
      send: (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
      async eval(expression) {
        const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description);
        return r.result && r.result.result ? r.result.result.value : undefined;
      },
      async until(expression, seconds, what) {
        const deadline = Date.now() + seconds * 1000;
        while (Date.now() < deadline) { if (await cdp.eval(expression)) return; await sleep(250); }
        throw new Error(`gave up waiting for ${what || expression}`);
      },
      async click(id) { await cdp.eval(`document.getElementById(${JSON.stringify(id)}).click(); 1`); },
      async setFile(id, file) {
        await cdp.send('DOM.enable');
        const doc = await cdp.send('DOM.getDocument', { depth: 1 });
        const q = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#' + id });
        await cdp.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [file] });
      },
      // Screenshot of one element, in page pixels. The viewport is tall enough
      // that nothing scrolls, so element coordinates are page coordinates.
      async shot(selector, name) {
        await cdp.fitViewport();
        await sleep(250);                                                    // let the 30 fps drawing loop catch up
        const b = await cdp.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 } });
        fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64'));
        console.log(`  ${name}  ${Math.round(b.w)}x${Math.round(b.h)}`);
        return name;
      },
      errors: () => errText.split('\n').filter((l) => /Uncaught|TypeError|ReferenceError/.test(l)),
    };
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: opts.url });
    await cdp.until('typeof modemDebug === "object"', 15, 'the page scripts');
    await sleep(300);
    return await fn(cdp);
  } finally {
    try { chrome.kill(); } catch (e) { /* gone */ }
    await sleep(300);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* Chrome still writing its profile; the OS cleans tmp */ }
  }
}

async function capture() {
  if (!fs.existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}; set CHROME=/path/to/chrome`);
  const preset = Modem.PRESETS[PRESET];
  const fsr = 48000;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modem-guide-files-'));
  const samplePath = path.join(work, SAMPLE_NAME);
  fs.writeFileSync(samplePath, SAMPLE_TEXT);
  const clean = renderTransfer(preset, fsr, 0, 3);
  const micWav = path.join(work, 'mic.wav');
  fs.writeFileSync(micWav, Buffer.from(DSP.wavEncode(ch.awgn(ch.gain(clean.signal, MIC_GAIN), MIC_SNR_DB, ch.rng(3)), fsr)));
  const noisy = noisyTransfer(preset, fsr);
  const noisyName = `${SAMPLE_NAME}.${PRESET}.noisy.wav`;
  const noisyPath = path.join(work, noisyName);
  // Scaled to a 0.9 peak: otherwise the noise clips in the 16-bit file and the level meter says CLIP, which is a different problem.
  const peak = noisy.signal.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  fs.writeFileSync(noisyPath, Buffer.from(DSP.wavEncode(ch.gain(noisy.signal, 0.9 / peak), fsr)));
  console.log(`${SAMPLE_NAME}: ${Buffer.byteLength(SAMPLE_TEXT)} bytes, ${clean.frames} frames per pass on ${PRESET}; noisy copy at ${noisy.snr} dB decodes ${noisy.ok} of ${noisy.frames} frames`);

  const { srv, port } = await serve(root);
  const url = `http://localhost:${port}/?preset=${PRESET}`;
  const files = [];
  const errors = [];
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    console.log('static states');
    await withChrome({ url }, async (cdp) => {
      files.push(await cdp.shot('body', 'page.png'));
      await cdp.setFile('txFile', samplePath);
      await cdp.until(`document.getElementById('txFileInfo').textContent.startsWith(${JSON.stringify(SAMPLE_NAME)})`, 10, 'the file to load');
      files.push(await cdp.shot('#tx', 'send-ready.png'));
      await cdp.click('loopback');
      await cdp.until('!!modemDebug.rx.result', 30, 'the loopback to finish');
      await cdp.until(`document.getElementById('log').textContent.includes('loopback done')`, 10, 'the loopback log line');
      files.push(await cdp.shot('#rx', 'loopback.png'));
      await cdp.click('reset');
      await cdp.setFile('rxWav', noisyPath);
      await cdp.until(`document.getElementById('log').textContent.includes('WAV done')`, 60, 'the noisy WAV to decode');
      files.push(await cdp.shot('#rx', 'receive-noisy.png'));
      errors.push(...cdp.errors());
    });
    console.log('live microphone (a fake one, fed the rendered transfer in real time)');
    await withChrome({ url, micWav }, async (cdp) => {
      await cdp.click('listen');
      await cdp.until(`document.getElementById('micInfo').textContent.startsWith('mic:')`, 10, 'the microphone');
      await cdp.until('modemDebug.rx.framesOk >= 5', 90, 'five good frames');
      files.push(await cdp.shot('#rx', 'receive-listening.png'));
      files.push(await cdp.shot('#rx .stats', 'stats.png'));
      files.push(await cdp.shot('#spec', 'spectrogram.png'));
      files.push(await cdp.shot('#env', 'decision.png'));
      await cdp.until('!!modemDebug.rx.result', 120, 'the file to complete');
      files.push(await cdp.shot('#rx', 'receive-done.png'));
      console.log('  ' + await cdp.eval(`document.getElementById('micInfo').textContent`));
      console.log('  ' + await cdp.eval(`document.getElementById('rxResult').textContent`));
      errors.push(...cdp.errors());
    });
  } finally {
    srv.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png') && !files.includes(f)) { fs.unlinkSync(path.join(SHOTS, f)); console.log(`  removed stale ${f}`); }
  for (const e of errors) console.log('page error: ' + e);
  if (errors.length) throw new Error('the page threw while being screenshotted; see above');
  fs.writeFileSync(MANIFEST, JSON.stringify({
    sourceHash: sourceHash(), sources: PRODUCT, files, preset: PRESET, viewport: VIEW,
    sample: { name: SAMPLE_NAME, bytes: Buffer.byteLength(SAMPLE_TEXT), frames: clean.frames },
    noisy: { snrDb: noisy.snr, framesOk: noisy.ok, frames: noisy.frames },
  }, null, 2) + '\n');
}

// ------------------------------------------------------------ main

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--hook')) {
    let input = '';
    try { input = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin */ }
    let file = '';
    try { file = (JSON.parse(input).tool_input || {}).file_path || ''; } catch (e) { /* not JSON */ }
    if (!file || path.dirname(path.resolve(file)) !== root || !PRODUCT.includes(path.basename(file))) return;
    const problems = check();
    if (!problems.length) return;
    process.stderr.write(`docs/GUIDE.md is behind ${path.basename(file)}: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}. ` +
      'Before finishing, run `npm run guide` to refresh the screenshots and tables, and fix the prose in docs/GUIDE.md by hand if the change is visible to a user.\n');
    process.exit(2);
  }
  if (args.includes('--check')) {
    const problems = check();
    if (!problems.length) { console.log('docs/GUIDE.md matches the code'); return; }
    for (const p of problems) console.log('- ' + p);
    console.log('run `npm run guide`, then check the prose around whatever changed');
    process.exit(1);
  }
  if (!args.includes('--text')) await capture();
  const text = applyBlocks(fs.readFileSync(GUIDE, 'utf8'), renderBlocks());
  fs.writeFileSync(GUIDE, text);
  const problems = check();
  if (problems.length) { for (const p of problems) console.log('- ' + p); process.exit(1); }
  console.log('docs/GUIDE.md is up to date');
}

module.exports = { check, renderBlocks, controlLabels, sourceHash, PRODUCT };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
