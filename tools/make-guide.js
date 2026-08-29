#!/usr/bin/env node
// Keeps the user guides in step with the pages.
//
// Two guides, two pages:
//   docs/GUIDE.md  the product page, index.html (earshot, the OFDM engine)
//   docs/LAB.md    the lab page, lab.html (the original FSK modem)
//
// Each guide is hand-written prose plus two kinds of generated content: the
// screenshots in docs/screenshots/<target>/, taken from the real page in
// headless Chrome, and the tables between <!-- gen:NAME --> and
// <!-- /gen:NAME --> markers, computed from the code. A manifest beside the
// screenshots records which sources they were taken from, so `--check` can
// tell when the page changed and the pictures did not.
//
//   node tools/make-guide.js [product|lab|all]   screenshots and tables (needs Chrome; about two minutes for both)
//   node tools/make-guide.js --text              tables only, no Chrome
//   node tools/make-guide.js --check             exit 1 and say why if a guide is behind the code
//   node tools/make-guide.js --hook              the same check as a Claude Code PostToolUse hook
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');
const Air = require('../air.js');
const Ofdm = require('../ofdm.js');
const Fec = require('../fec.js');
const Fountain = require('../fountain.js');
const Chirp = require('../chirp.js');
const ch = require('../test/helpers/channel.js');

const root = path.resolve(__dirname, '..');
const DOCS = path.join(root, 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const { execSync } = require('child_process');
  const fs = require('fs');
  if (process.env.CHROME) return process.env.CHROME;
  const win = process.platform === 'win32';
  const which = win ? 'where ' : 'command -v ';
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'msedge']) {
    try {
      const hit = execSync(which + name, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
      if (hit) return hit;
    } catch (e) { /* keep looking */ }
  }
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) { try { if (fs.existsSync(p)) return p; } catch (e) { /* next */ } }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const CHROME = findChrome();
const VIEW = { width: 1280, height: 1120 };
const PHONE = { width: 390, height: 844 };

// What the fake microphone hears: the transfer at about -36 dBFS with white
// noise 40 dB under it, roughly a device half a metre away in a quiet room.
// Full scale with no noise reads like arithmetic, not a room: the lab page
// says SNR 155 dB and paints its spectrogram solid.
const MIC_GAIN = 0.03;
const MIC_SNR_DB = 40;

// ------------------------------------------------------------ helpers

function read(name) { return fs.readFileSync(path.join(root, name), 'utf8'); }
function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(2) + ' MB'; }

// Pulls one number out of a source file by regex. Fails loudly, so a renamed
// constant breaks `npm test` instead of leaving a stale number in a guide.
function grab(file, re, what) {
  const m = read(file).match(re);
  if (!m) throw new Error(`could not find ${what} in ${file}; update tools/make-guide.js`);
  return m;
}

function hashOf(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) { h.update(f); h.update('\0'); h.update(read(f)); h.update('\0'); }
  return h.digest('hex').slice(0, 16);
}

function strip(html) { return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

// Every button, label and disclosure on a page, by the words a user sees.
// A leading emoji is dropped ("🎙 Listen" is written as **Listen**), a
// label stops at its first line break, and the options of a menu inside a
// label are not the label.
function controlLabels(page) {
  const html = read(page);
  const out = new Set();
  const add = (s) => { const t = strip(s).replace(/^[^\p{L}\p{N}]+/u, ''); if (t) out.add(t); };
  for (const m of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)) add(m[1]);
  for (const m of html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)) add(m[1].split(/<br\s*\/?>/)[0].replace(/<select[\s\S]*?<\/select>/g, ''));
  for (const m of html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)) add(m[1]);
  return [...out];
}

function screenshotRefs(text) {
  return [...text.matchAll(/\]\((screenshots\/[^)]+\.png)\)/g)].map((m) => m[1]);
}

// ------------------------------------------------------------ product: text

// The sender's own frame, so the guide's timings come from what actually plays.
function productFrameSec() {
  const payload = new Uint8Array(1024).map((_, i) => (i * 131 + 17) & 0xFF);
  const prep = { name: 'x', flags: 0, payload, windows: Fountain.makeWindows(payload),
    manifest: Air.packManifest({ flags: 0, winCount: 1, size: payload.length, crc32: Modem.crc32(payload), name: 'x' }) };
  return new Air.Sender(prep, { session: 0 }).nextFrame().length / Air.FS;
}

function productBlocks() {
  const frameSec = productFrameSec();
  const perFrame = Fountain.BLOCK * Air.DROPLETS_PER_FRAME;
  const frames = Air.framesFor;                       // what the sender's progress bar counts to
  const rows = ['| file | frames | sound |', '|---|---:|---:|'];
  for (const [label, bytes] of [['a note, a key, a config', 2048], ['a small document', 30 * 1024], ['a photo', 300 * 1024], ['the 2 MB ceiling', 2 * 1048576]]) {
    rows.push(`| ${label} (${fmtBytes(bytes)}) | ${frames(bytes)} | ${fmtTime(frames(bytes) * frameSec)} |`);
  }
  rows.push('');
  rows.push(`One frame is ${frameSec.toFixed(2)} s of sound and carries ${perFrame} bytes of the file, ${Math.round(perFrame / frameSec)} bytes per second. The table is for a file that does not compress and a transfer that loses nothing; text usually compresses two to three times, and every lost frame adds one more.`);
  const timing = rows.join('\n');

  const cap = Number(grab('earshot.js', /(?:MAX_BYTES = |f\.size > )(\d+) \* 1048576/, 'the file size cap')[1]);
  const nameBytes = Number(grab('air.js', /NAME_BYTES = (\d+)/, 'the file name limit')[1]);
  const gzipGain = Number(grab('air.js', /z\.length < bytes\.length \* ([\d.]+)/, 'the compression rule')[1]);
  const iters = Number(grab('air.js', /PBKDF2_ITERS = (\d+)/, 'PBKDF2_ITERS')[1]);
  const keyBits = Number(grab('air.js', /name: 'AES-GCM', length: (\d+)/, 'the AES key length')[1]);
  const logLines = Number(grab('earshot.js', /new Diag\.Log\(ui\.log, (\d+)\)/, 'the log length')[1]);
  const limits = [
    `- Files up to ${cap} MB (${(cap * 1048576).toLocaleString('en-US')} bytes). Bigger ones are refused before anything plays.`,
    `- File names travel as up to ${nameBytes} bytes of UTF-8; a longer name is trimmed to fit, on a character boundary and keeping its extension. With a passphrase the name travels inside the ciphertext, under the same limit.`,
    `- Compression is gzip, used only when it saves at least ${Math.round((1 - gzipGain) * 100)} %; the log line under **Advanced** shows the size before and after.`,
    `- Passphrase: AES-${keyBits}-GCM, key derived from the passphrase with PBKDF2-SHA-256 over ${iters.toLocaleString('en-US')} iterations, fresh salt and nonce per transfer. A wrong passphrase is detected, not silently decrypted to garbage.`,
    `- Audio runs at ${Air.FS} Hz. A device that cannot is resampled, and **Advanced** says so.`,
    `- The log under **Advanced** keeps the last ${logLines} lines.`,
  ].join('\n');

  const chirp = grab('chirp.js', /f0: (\d+), f1: (\d+), durSec: ([\d.]+)/, 'the chirp parameters');
  const manifestBytes = Number(grab('air.js', /MANIFEST_BYTES = (\d+)/, 'MANIFEST_BYTES')[1]);
  const dropletBytes = Air.DROPLET_BYTES;
  const binHz = Air.FS / Ofdm.P.N;
  const engine = [
    `- ${Ofdm.P.N}-point FFT at ${Air.FS} Hz: subcarriers ${binHz} Hz apart, bins ${Ofdm.P.binLo} to ${Ofdm.P.binHi} (${Ofdm.P.binLo * binHz} to ${Math.round(Ofdm.P.binHi * binHz)} Hz). ${Ofdm.P.data.length} carry data as QPSK, ${Ofdm.P.pilots.length} are pilots that track the two devices' clocks, ${Ofdm.P.nulls.length} stay silent so the noise floor is measured every symbol.`,
    `- ${Air.FS / Ofdm.P.symbolLen} symbols per second: ${Ofdm.P.N} samples plus a ${Ofdm.P.cp}-sample cyclic prefix, so echoes up to ${(Ofdm.P.cp / Air.FS * 1000).toFixed(1)} ms late do no harm.`,
    `- A frame: a ${Math.round(Number(chirp[3]) * 1000)} ms chirp (${chirp[1]} to ${chirp[2]} Hz) that the receiver finds with a matched filter, a ${Math.round(Air.GUARD / Air.FS * 1000)} ms guard, one channel-estimation symbol, ${Ofdm.P.sigSymbols} signalling symbols that say what the frame is, ${Air.SYM_COUNT} data symbols, and a ${Math.round(Air.GAP / Air.FS * 1000)} ms gap: ${frameSec.toFixed(2)} s.`,
    `- Coding: K=${Fec.K} rate-1/2 convolutional, soft-decision Viterbi, each bit weighted by its subcarrier's SNR so a dead frequency counts as unknown rather than wrong. ${Air.FRAME_BYTES} bytes come out of a frame: a ${manifestBytes}-byte manifest (name, size, checksum, flags) and ${Air.DROPLETS_PER_FRAME} droplets of ${dropletBytes} bytes.`,
    `- Fountain: the file is cut into ${Fountain.BLOCK}-byte blocks and windows of ${Fountain.WINDOW} blocks (${Fountain.BLOCK * Fountain.WINDOW / 1024} kB). Droplets are blocks, then random combinations of blocks; any enough of them rebuild a window, so a lost frame costs time, never a pass.`,
  ].join('\n');

  return { timing, limits, engine };
}

// ------------------------------------------------------------ lab: text

function passTime(preset, bytes) {
  const n = new Modem.Sender(new Uint8Array(bytes), 'x', { session: 0 }).passSequence().length;
  return { frames: n, seconds: n * DSP.frameDuration(preset) };
}

function labBlocks() {
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
  const recSec = Number(grab('app.js', /const REC_MAX_SEC = (\d+)/, 'REC_MAX_SEC')[1]);
  const wavCap = grab('app.js', /total \* 2 > (\d+e\d+)/, 'the WAV size cap')[1];
  const passes = grab('lab.html', /id="passes" value="(\d+)" min="(\d+)" max="(\d+)"/, 'the Passes input');
  const level = grab('lab.html', /id="amp" min="([\d.]+)" max="([\d.]+)" step="[\d.]+" value="([\d.]+)"/, 'the Level slider');
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

// ------------------------------------------------------------ targets

const TARGETS = {
  product: {
    guide: 'docs/GUIDE.md', shots: 'docs/screenshots/product', page: 'index.html',
    ready: 'typeof earshotDebug === "object"',
    // Anything a user of the product page can see or hear comes from these.
    sources: ['index.html', 'earshot.js', 'worker.js', 'capture-worklet.js', 'air.js', 'ofdm.js', 'chirp.js', 'fec.js', 'fountain.js', 'fft.js', 'diag.js', 'modem.js'],
    blocks: productBlocks,
  },
  lab: {
    guide: 'docs/LAB.md', shots: 'docs/screenshots/lab', page: 'lab.html',
    ready: 'typeof modemDebug === "object"',
    sources: ['lab.html', 'app.js', 'diag.js', 'modem.js', 'dsp.js'],
    blocks: labBlocks,
  },
};
for (const [name, t] of Object.entries(TARGETS)) { t.name = name; t.manifest = path.join(t.shots, 'manifest.json'); }

function applyBlocks(text, blocks, guide) {
  for (const name of Object.keys(blocks)) {
    const re = new RegExp(`(<!-- gen:${name} -->)[\\s\\S]*?(<!-- /gen:${name} -->)`);
    if (!re.test(text)) throw new Error(`${guide} has no <!-- gen:${name} --> block`);
    text = text.replace(re, `$1\n${blocks[name]}\n$2`);
  }
  return text;
}

// Returns a list of problems for one target; empty means its guide matches the code.
function checkTarget(t) {
  const problems = [];
  if (!fs.existsSync(path.join(root, t.guide))) return [`${t.guide} is missing`];
  const text = read(t.guide);
  let blocks;
  try { blocks = t.blocks(); } catch (e) { return [e.message]; }
  for (const name of Object.keys(blocks)) {
    const m = text.match(new RegExp(`<!-- gen:${name} -->\\n([\\s\\S]*?)\\n<!-- /gen:${name} -->`));
    if (!m) problems.push(`${t.guide} has no <!-- gen:${name} --> block`);
    else if (m[1] !== blocks[name]) problems.push(`the ${name} table in ${t.guide} is behind the code`);
  }
  const sub = path.relative(DOCS, path.join(root, t.shots)) + '/';
  const refs = screenshotRefs(text);
  for (const r of refs) if (!fs.existsSync(path.join(DOCS, r))) problems.push(`docs/${r} is missing`);
  const own = refs.filter((r) => r.startsWith(sub)).map((r) => r.slice(sub.length));
  const manifestPath = path.join(root, t.manifest);
  if (!fs.existsSync(manifestPath)) problems.push(`${t.manifest} is missing: the ${t.name} screenshots have not been generated`);
  else {
    const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const now = hashOf(t.sources);
    if (man.sourceHash !== now) problems.push(`the ${t.name} screenshots were taken from older sources (${man.sourceHash}, now ${now})`);
    if (JSON.stringify(man.sources) !== JSON.stringify(t.sources)) problems.push(`the ${t.name} manifest lists different sources than tools/make-guide.js watches`);
    for (const f of man.files || []) if (!own.includes(f)) problems.push(`${t.shots}/${f} is generated but ${t.guide} does not show it`);
    for (const f of own) if (!(man.files || []).includes(f)) problems.push(`${t.shots}/${f} is not in the manifest; is it generated?`);
  }
  for (const label of controlLabels(t.page)) if (!text.includes(`**${label}**`)) problems.push(`the control "${label}" is on ${t.page} but not in ${t.guide} (write it as **${label}**)`);
  return problems;
}

function check(names) {
  const out = [];
  for (const n of names || Object.keys(TARGETS)) out.push(...checkTarget(TARGETS[n]));
  return out;
}

// ------------------------------------------------------------ Chrome

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wav': 'audio/wav', '.json': 'application/json', '.svg': 'image/svg+xml' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const p = path.join(dir, u === '/' ? 'index.html' : u);
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
      chrome.stderr.on('data', () => { const mm = errText.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (mm) { clearTimeout(t); resolve(mm[1]); } });
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
    const view = { ...VIEW, deviceScaleFactor: 1, mobile: false };
    const cdp = {
      send: (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
      async eval(expression) {
        const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description);
        return r.result && r.result.result ? r.result.result.value : undefined;
      },
      async until(expression, seconds, what) {
        const deadline = Date.now() + seconds * 1000;
        while (Date.now() < deadline) { if (await cdp.eval(expression)) return true; await sleep(250); }
        if (what === null) return false;                                     // caller copes
        throw new Error(`gave up waiting for ${what || expression}`);
      },
      async click(elId) { await cdp.eval(`document.getElementById(${JSON.stringify(elId)}).click(); 1`); },
      async setFile(elId, file) {
        await cdp.send('DOM.enable');
        const doc = await cdp.send('DOM.getDocument', { depth: 1 });
        const q = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#' + elId });
        await cdp.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [file] });
      },
      async viewport(v) {
        Object.assign(view, v);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.deviceScaleFactor, mobile: view.mobile });
      },
      // The page grows (the log, an idle canvas); keep the whole of it inside
      // the viewport so element clips never fall off the bottom.
      async fitViewport() {
        const h = await cdp.eval('document.documentElement.scrollHeight');
        if (h > view.height) { await cdp.viewport({ height: h }); await sleep(300); }
      },
      async open(url) {
        await cdp.send('Page.navigate', { url });
        await cdp.until(opts.ready, 15, 'the page scripts');
        await sleep(300);
      },
      // Screenshot of one element, in page pixels.
      async shot(selector, name) {
        await cdp.fitViewport();
        await sleep(250);                                                    // let the drawing loop catch up
        const b = await cdp.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 } });
        fs.writeFileSync(path.join(opts.shots, name), Buffer.from(r.result.data, 'base64'));
        console.log(`  ${name}  ${Math.round(b.w * view.deviceScaleFactor)}x${Math.round(b.h * view.deviceScaleFactor)}`);
        return name;
      },
      errors: () => errText.split('\n').filter((l) => /Uncaught|TypeError|ReferenceError/.test(l)),
    };
    await cdp.viewport({});
    await cdp.send('Page.enable');
    await cdp.open(opts.url);
    return await fn(cdp);
  } finally {
    try { chrome.kill(); } catch (e) { /* gone */ }
    await sleep(300);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* Chrome still writing its profile; the OS cleans tmp */ }
  }
}

function micWavOf(signal, file) {
  fs.writeFileSync(file, Buffer.from(DSP.wavEncode(ch.awgn(ch.gain(signal, MIC_GAIN), MIC_SNR_DB, ch.rng(3)), Air.FS)));
}

// ------------------------------------------------------------ product: screenshots

// A deterministic CSV: 300 sensor readings, about 14 kB, compresses to a
// few frames. Text is the honest case for a file sent by sound.
function productSample() {
  let s = 12345;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const lines = ['time,sensor,temp_c,rh_pct,pressure_hpa,battery_v'];
  for (let i = 0; i < 300; i++) {
    const h = String(Math.floor(i / 12)).padStart(2, '0'), m = String((i % 12) * 5).padStart(2, '0');
    lines.push(`2026-08-27T${h}:${m}:00,node-${(i % 7) + 1},${(19 + rnd() * 9).toFixed(1)},${Math.round(35 + rnd() * 40)},${(1005 + rnd() * 14).toFixed(1)},${(3.6 + rnd() * 0.5).toFixed(2)}`);
  }
  return { name: 'readings.csv', text: lines.join('\n') + '\n', passphrase: 'otter' };
}

const MESSAGE_TEXT = 'Meet at the north gate at six. Bring the blue folder.';

// The same transfer under enough white noise that droplets fail their CRC and
// the progress bar stalls: what a marginal room looks like on this page.
// Searched, not fixed, so the picture stays meaningful as the engine changes.
function productNoisy(prep, frames) {
  for (const snr of [-2, -4, -6, -8, -10]) {
    const sender = new Air.Sender(prep, { session: 10 });
    const parts = [new Float32Array(3 * Air.FS)];
    for (let i = 0; i < frames + 8; i++) parts.push(sender.nextFrame());
    parts.push(new Float32Array(Air.FS));
    const signal = ch.awgn(ch.concat(parts), snr, ch.rng(7));
    const rx = new Air.Receiver(Air.FS);
    for (let off = 0; off < signal.length; off += 4096) rx.push(signal.subarray(off, Math.min(signal.length, off + 4096)));
    if (rx.stats.dropletCrcFail >= 3 && rx.stats.droplets >= 3) return { signal, snr, stats: rx.stats, complete: !!rx.result };
  }
  return null;
}

async function captureProduct(t, work, port, shots) {
  const sample = productSample();
  const samplePath = path.join(work, sample.name);
  fs.writeFileSync(samplePath, sample.text);
  const bigPath = path.join(work, 'big.bin');
  fs.writeFileSync(bigPath, Buffer.alloc(2200000));
  const bytes = new Uint8Array(Buffer.from(sample.text));
  const prep = await Air.prepare(bytes, sample.name, { passphrase: sample.passphrase });
  const sender = new Air.Sender(prep, { session: 9 });
  const blocks = Math.ceil(prep.payload.length / Fountain.BLOCK);
  const frames = Math.ceil(blocks / Air.DROPLETS_PER_FRAME) + 2;
  const parts = [new Float32Array(3 * Air.FS)];
  for (let i = 0; i < frames; i++) parts.push(sender.nextFrame());
  parts.push(new Float32Array(Air.FS));
  const micWav = path.join(work, 'mic-product.wav');
  micWavOf(ch.concat(parts), micWav);
  const noisy = productNoisy(prep, frames);
  const noisyWav = path.join(work, 'mic-product-noisy.wav');
  if (noisy) micWavOf(noisy.signal, noisyWav);
  // A typed message: what "Send text" puts on the air, unencrypted, so the
  // receiver shows it inline the moment it lands.
  const msgPrep = await Air.prepare(new Uint8Array(Buffer.from(MESSAGE_TEXT)), 'message.txt');
  const msgSender = new Air.Sender(msgPrep, { session: 11 });
  const msgFrames = Math.ceil(Math.ceil(msgPrep.payload.length / Fountain.BLOCK) / Air.DROPLETS_PER_FRAME) + 2;
  const msgParts = [new Float32Array(3 * Air.FS)];
  for (let i = 0; i < msgFrames; i++) msgParts.push(msgSender.nextFrame());
  msgParts.push(new Float32Array(Air.FS));
  const messageWav = path.join(work, 'mic-product-message.wav');
  micWavOf(ch.concat(msgParts), messageWav);
  console.log(`${sample.name}: ${bytes.length} bytes, ${prep.payload.length} on air (compressed, encrypted), ${blocks} blocks, ${frames} frames` +
    (noisy ? `; noisy copy at ${noisy.snr} dB: ${noisy.stats.droplets} droplets, ${noisy.stats.dropletCrcFail} failed CRC, ${noisy.complete ? 'complete' : 'incomplete'}` : '; no noise level produced failed droplets'));

  const url = `http://localhost:${port}/index.html`;
  const files = [], errors = [];
  console.log('product page, static states');
  await withChrome({ url, ready: t.ready, shots }, async (cdp) => {
    files.push(await cdp.shot('body', 'page.png'));
    await cdp.setFile('file', bigPath);
    await cdp.until(`document.getElementById('fileInfo').textContent.startsWith('Over')`, 10, 'the size refusal');
    files.push(await cdp.shot('#sendCard', 'too-big.png'));
    await cdp.setFile('file', samplePath);
    await cdp.until(`document.getElementById('dropText').textContent.includes(${JSON.stringify(sample.name)})`, 10, 'the file to load');
    files.push(await cdp.shot('#sendCard', 'send-picked.png'));
    await cdp.eval(`document.getElementById('txPass').value = ${JSON.stringify(sample.passphrase)}; 1`);
    await cdp.click('send');
    await cdp.until('earshotDebug.tx.done >= 2', 12, null);                 // headless audio may not advance; the status line still shows
    files.push(await cdp.shot('#sendCard', 'sending.png'));
    await cdp.click('stopSend');
    await cdp.eval(`document.getElementById('advanced').open = true; 1`);
    files.push(await cdp.shot('#advanced', 'advanced-sending.png'));
    // A fresh page for the sample file, the table and a typed message, so no
    // progress bar from the send above lingers in the pictures.
    await cdp.open(url);
    await cdp.click('sample');
    await cdp.until(`document.getElementById('dropText').textContent.includes('earshot-sample.txt')`, 10, 'the sample file');
    files.push(await cdp.shot('#sendCard', 'sample-file.png'));
    await cdp.eval(`document.querySelector('#sendCard details.speed').open = true; 1`);
    files.push(await cdp.shot('#sendCard', 'speed-and-limits.png'));
    await cdp.eval(`document.querySelector('#sendCard details.speed').open = false; document.getElementById('txText').value = ${JSON.stringify(MESSAGE_TEXT)}; 1`);
    await cdp.click('sendText');
    await cdp.until('earshotDebug.tx.done >= 1', 12, null);
    files.push(await cdp.shot('#sendCard', 'send-text.png'));
    await cdp.click('stopSend');
    errors.push(...cdp.errors());
    // The same page on a phone.
    await cdp.viewport({ ...PHONE, deviceScaleFactor: 2, mobile: true });
    await cdp.open(url);
    files.push(await cdp.shot('body', 'phone.png'));
  });
  console.log('product page, receiving (a fake microphone fed the rendered transfer in real time)');
  await withChrome({ url, ready: t.ready, shots, micWav }, async (cdp) => {
    await cdp.click('listen');
    await cdp.until(`document.getElementById('rxStatus').textContent.toLowerCase().startsWith('listening')`, 10, 'the microphone');
    files.push(await cdp.shot('#recvCard', 'listening.png'));
    await cdp.until(`(() => { const p = document.getElementById('rxProgress'); return p.style.display !== 'none' && p.value >= 0.2 && p.value < 0.95; })()`, 60, 'the transfer to be part way');
    files.push(await cdp.shot('#recvCard', 'receiving.png'));
    await cdp.eval(`document.getElementById('advanced').open = true; 1`);
    await sleep(800);
    files.push(await cdp.shot('#advanced', 'advanced.png'));
    await cdp.until('!!earshotDebug.rx.complete', 60, 'the transfer to complete');
    await cdp.until(`document.getElementById('passRow').style.display !== 'none'`, 10, 'the passphrase prompt');
    files.push(await cdp.shot('#recvCard', 'received-locked.png'));
    await cdp.eval(`document.getElementById('rxPass').value = 'wrong'; 1`);
    await cdp.click('unlock');
    await cdp.until(`document.getElementById('resultStatus').textContent.toLowerCase().startsWith('wrong passphrase')`, 10, 'the wrong-passphrase message');
    files.push(await cdp.shot('#recvCard', 'wrong-passphrase.png'));
    await cdp.eval(`document.getElementById('rxPass').value = ${JSON.stringify(sample.passphrase)}; 1`);
    await cdp.click('unlock');
    await cdp.until('!!earshotDebug.fileBytes', 10, 'the file to unlock');
    files.push(await cdp.shot('#recvCard', 'received.png'));
    console.log('  ' + await cdp.eval(`document.getElementById('engineInfo').textContent`));
    console.log('  ' + await cdp.eval(`document.getElementById('resultName').textContent + ' | ' + document.getElementById('resultStatus').textContent`));
    const same = await cdp.eval(`(() => { const b = earshotDebug.fileBytes; return b.length === ${bytes.length}; })()`);
    if (!same) throw new Error('the product page received a different number of bytes than were sent');
    errors.push(...cdp.errors());
  });
  console.log('product page, receiving a typed message');
  await withChrome({ url, ready: t.ready, shots, micWav: messageWav }, async (cdp) => {
    await cdp.click('listen');
    await cdp.until(`document.getElementById('rxStatus').textContent.toLowerCase().startsWith('listening')`, 10, 'the microphone');
    await cdp.until('!!earshotDebug.fileBytes', 60, 'the message to arrive');
    await cdp.until(`document.getElementById('resultText').style.display !== 'none'`, 10, 'the message to show inline');
    files.push(await cdp.shot('#recvCard', 'received-text.png'));
    const shown = await cdp.eval(`document.getElementById('resultText').textContent`);
    if (shown !== MESSAGE_TEXT) throw new Error('the receiver showed a different message than was sent');
    errors.push(...cdp.errors());
  });
  if (noisy) {
    console.log('product page, receiving through noise');
    await withChrome({ url, ready: t.ready, shots, micWav: noisyWav }, async (cdp) => {
      await cdp.click('listen');
      await cdp.until(`document.getElementById('rxStatus').textContent.toLowerCase().startsWith('listening')`, 10, 'the microphone');
      await cdp.until(`/\\d+ droplets?, [1-9]\\d* rejected/.test(document.getElementById('log').textContent) && document.getElementById('rxProgress').value > 0`, 75, null);
      files.push(await cdp.shot('#recvCard', 'receiving-noisy.png'));
      await cdp.eval(`document.getElementById('advanced').open = true; 1`);
      await sleep(800);
      files.push(await cdp.shot('#advanced', 'advanced-noisy.png'));
      errors.push(...cdp.errors());
    });
  }
  return { files, errors, manifest: { sample: { name: sample.name, bytes: bytes.length, onAir: prep.payload.length, frames },
    message: { bytes: Buffer.byteLength(MESSAGE_TEXT), onAir: msgPrep.payload.length, frames: msgFrames },
    noisy: noisy ? { snrDb: noisy.snr, droplets: noisy.stats.droplets, dropletCrcFail: noisy.stats.dropletCrcFail, complete: noisy.complete } : null } };
}

// ------------------------------------------------------------ lab: screenshots

const LAB_PRESET = 'robust';
const LAB_SAMPLE_NAME = 'notes.txt';
const LAB_SAMPLE_TEXT = `Acoustic modem test note

This file crosses the room as sound. The sender plays it as two
alternating tones; the microphone on the other laptop hears them, and
the page there rebuilds the bytes and checks them against a CRC-32
before it lets you download the result.

Frames that fail on the first pass are picked up on the next one; the
receiver keeps what it has and waits for the rest.

If you can read this on the other laptop, the transfer worked.
`;
const LAB_SESSION = 7;   // fixed, so the log lines in the screenshots do not change between runs

function labTransfer(preset, fs, pass, leadSec) {
  const bytes = new Uint8Array(Buffer.from(LAB_SAMPLE_TEXT));
  const seq = new Modem.Sender(bytes, LAB_SAMPLE_NAME, { session: LAB_SESSION }).passSequence();
  const parts = [new Float32Array(Math.round(leadSec * fs))];
  for (const raw of seq) parts.push(DSP.modulateFrame(Modem.frameToBits(raw, pass), preset, fs));
  parts.push(new Float32Array(fs));
  return { signal: ch.concat(parts), frames: seq.length };
}

function labCountOk(signal, preset, fs) {
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
function labNoisyTransfer(preset, fs) {
  const clean = labTransfer(preset, fs, 0, 0.5);
  for (const snr of [-8, -9, -10, -11, -12, -13, -14]) {
    const noisy = ch.awgn(clean.signal, snr, ch.rng(5));
    const r = labCountOk(noisy, preset, fs);
    if (r.ok >= 3 && r.ok <= clean.frames - 3) return { signal: noisy, snr, ok: r.ok, frames: clean.frames };
  }
  const noisy = ch.awgn(clean.signal, -11, ch.rng(5));
  return { signal: noisy, snr: -11, ...labCountOk(noisy, preset, fs), frames: clean.frames };
}

async function captureLab(t, work, port, shots) {
  const preset = Modem.PRESETS[LAB_PRESET];
  const fsr = 48000;
  const samplePath = path.join(work, LAB_SAMPLE_NAME);
  fs.writeFileSync(samplePath, LAB_SAMPLE_TEXT);
  const clean = labTransfer(preset, fsr, 0, 3);
  const micWav = path.join(work, 'mic-lab.wav');
  micWavOf(clean.signal, micWav);
  const noisy = labNoisyTransfer(preset, fsr);
  const noisyPath = path.join(work, `${LAB_SAMPLE_NAME}.${LAB_PRESET}.noisy.wav`);
  // Scaled to a 0.9 peak: otherwise the noise clips in the 16-bit file and the level meter says CLIP, which is a different problem.
  const peak = noisy.signal.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  fs.writeFileSync(noisyPath, Buffer.from(DSP.wavEncode(ch.gain(noisy.signal, 0.9 / peak), fsr)));
  console.log(`${LAB_SAMPLE_NAME}: ${Buffer.byteLength(LAB_SAMPLE_TEXT)} bytes, ${clean.frames} frames per pass on ${LAB_PRESET}; noisy copy at ${noisy.snr} dB decodes ${noisy.ok} of ${noisy.frames} frames`);

  const url = `http://localhost:${port}/lab.html?preset=${LAB_PRESET}`;
  const files = [], errors = [];
  console.log('lab page, static states');
  await withChrome({ url, ready: t.ready, shots }, async (cdp) => {
    files.push(await cdp.shot('body', 'page.png'));
    await cdp.setFile('txFile', samplePath);
    await cdp.until(`document.getElementById('txFileInfo').textContent.startsWith(${JSON.stringify(LAB_SAMPLE_NAME)})`, 10, 'the file to load');
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
  console.log('lab page, live microphone (a fake one, fed the rendered transfer in real time)');
  await withChrome({ url, ready: t.ready, shots, micWav }, async (cdp) => {
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
  return { files, errors, manifest: { preset: LAB_PRESET, sample: { name: LAB_SAMPLE_NAME, bytes: Buffer.byteLength(LAB_SAMPLE_TEXT), frames: clean.frames }, noisy: { snrDb: noisy.snr, framesOk: noisy.ok, frames: noisy.frames } } };
}

// ------------------------------------------------------------ main

async function capture(t) {
  if (!fs.existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}; set CHROME=/path/to/chrome`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modem-guide-files-'));
  const shots = path.join(root, t.shots);
  fs.mkdirSync(shots, { recursive: true });
  const { srv, port } = await serve(root);
  let result;
  try {
    result = await (t.name === 'product' ? captureProduct : captureLab)(t, work, port, shots);
  } finally {
    srv.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  for (const f of fs.readdirSync(shots)) if (f.endsWith('.png') && !result.files.includes(f)) { fs.unlinkSync(path.join(shots, f)); console.log(`  removed stale ${f}`); }
  for (const e of result.errors) console.log('page error: ' + e);
  if (result.errors.length) throw new Error(`${t.page} threw while being screenshotted; see above`);
  fs.writeFileSync(path.join(root, t.manifest), JSON.stringify({
    target: t.name, page: t.page, sourceHash: hashOf(t.sources), sources: t.sources, files: result.files, viewport: VIEW, ...result.manifest,
  }, null, 2) + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const names = Object.keys(TARGETS).filter((n) => args.includes(n));
  const chosen = names.length ? names : Object.keys(TARGETS);

  if (args.includes('--hook')) {
    let input = '';
    try { input = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin */ }
    let file = '';
    try { file = (JSON.parse(input).tool_input || {}).file_path || ''; } catch (e) { /* not JSON */ }
    if (!file || path.dirname(path.resolve(file)) !== root) return;
    const hit = Object.values(TARGETS).filter((t) => t.sources.includes(path.basename(file)));
    if (!hit.length) return;
    const problems = check(hit.map((t) => t.name));
    if (!problems.length) return;
    const guides = hit.map((t) => t.guide).join(' and ');
    process.stderr.write(`${guides} is behind ${path.basename(file)}: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}. ` +
      `Before finishing, run \`npm run guide${hit.length === 1 ? ' ' + hit[0].name : ''}\` to refresh the screenshots and tables, and fix the prose by hand if the change is visible to a user.\n`);
    process.exit(2);
  }
  if (args.includes('--check')) {
    const problems = check(chosen);
    if (!problems.length) { console.log(`${chosen.map((n) => TARGETS[n].guide).join(' and ')} match the code`); return; }
    for (const p of problems) console.log('- ' + p);
    console.log('run `npm run guide`, then check the prose around whatever changed');
    process.exit(1);
  }
  for (const n of chosen) {
    const t = TARGETS[n];
    if (!args.includes('--text')) await capture(t);
    fs.writeFileSync(path.join(root, t.guide), applyBlocks(read(t.guide), t.blocks(), t.guide));
  }
  const problems = check(chosen);
  if (problems.length) { for (const p of problems) console.log('- ' + p); process.exit(1); }
  console.log(`${chosen.map((n) => TARGETS[n].guide).join(' and ')} up to date`);
}

module.exports = { check, controlLabels, TARGETS, hashOf };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
