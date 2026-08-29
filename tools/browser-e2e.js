#!/usr/bin/env node
// End-to-end through the real page in headless Chrome.
//
// Renders a file to a WAV, then either feeds it to the page as a fake
// microphone (--mic, the default) or hands it to the page's "Decode a WAV"
// input (--wav). Polls the page over the DevTools protocol until the file is
// received, pulls the received bytes back out and compares.
//
// It serves the site tools/stage-site.js stages, not the repository root, so
// a file the deploy would leave out fails here rather than on the live page.
//
//   node tools/browser-e2e.js [robust|fast] [--mic|--wav] [--file path] [--seconds 120]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');

const Air = require('../air.js');
const { stage } = require('./stage-site.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const presetName = args.find((a) => Modem.PRESETS[a]) || 'robust';
const engine = args.includes('--ofdm') ? 'ofdm' : 'fsk';
const mode = args.includes('--wav') ? 'wav' : 'mic';
const seconds = Number(opt('--seconds', 120));
const filePath = opt('--file', null);
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
const PORT = 9333 + Math.floor(Math.random() * 100);
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modem-e2e-'));
const site = path.join(work, 'site');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const preset = Modem.PRESETS[presetName];
const bytes = filePath ? new Uint8Array(fs.readFileSync(filePath)) : new Uint8Array(600).map((_, i) => (i * 131 + 17) & 0xFF);
const fsr = 48000;
const wavPath = path.join(work, 'tx.wav');
let frameCount = 0;

async function buildWav() {
  const parts = [new Float32Array(fsr)];
  if (engine === 'ofdm') {
    const prep = await Air.prepare(bytes, filePath ? path.basename(filePath) : 'e2e.bin');
    const sender = new Air.Sender(prep, { session: 8 });
    frameCount = Air.framesFor(prep.payload.length);
    for (let i = 0; i < frameCount; i++) parts.push(sender.nextFrame());
  } else {
    const sender = new Modem.Sender(bytes, filePath ? path.basename(filePath) : 'e2e.bin');
    const seq = sender.passSequence();
    frameCount = seq.length;
    for (const raw of seq) parts.push(DSP.modulateFrame(Modem.frameToBits(raw), preset, fsr));
  }
  parts.push(new Float32Array(fsr));
  let n = 0; for (const x of parts) n += x.length;
  const all = new Float32Array(n); let off = 0; for (const x of parts) { all.set(x, off); off += x.length; }
  fs.writeFileSync(wavPath, Buffer.from(DSP.wavEncode(all, fsr)));
  console.log(`${engine === 'ofdm' ? 'ofdm' : presetName} via ${mode}: ${bytes.length} bytes, ${frameCount} frames, ${(n / fsr).toFixed(1)} s of audio`);
}

// The pages need a real origin: workers and worklets do not load from
// file://. A throwaway static server over the staged site does it -- the same
// bytes the deploy publishes, so a missing module breaks the test.
let server = null, port = 0;
function serveSite() {
  const http = require('http');
  const staged = stage(site);
  if (staged.problems.length) {
    staged.problems.forEach((m) => console.log(m));
    finish(1);
    return new Promise(() => { /* finish() is on its way out */ });
  }
  console.log(`staged ${staged.files.length} files, ${staged.refs.length} local references resolve`);
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const p = path.join(site, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      try {
        const data = fs.readFileSync(p.endsWith('/') ? p + 'index.html' : p);
        const type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.html') ? 'text/html'
          : p.endsWith('.json') ? 'application/json' : p.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(data);
      } catch (e) { res.writeHead(404); res.end(); }
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

let chrome = null, errText = '';
async function launchChrome() {
  await buildWav();
  await serveSite();
  const target = engine === 'ofdm'
    ? `http://127.0.0.1:${port}/index.html?listen`
    : `http://127.0.0.1:${port}/lab.html?preset=${presetName}` + (mode === 'mic' ? '&listen' : '');
  const chromeArgs = ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(work, 'profile'),
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (mode === 'mic') chromeArgs.push('--use-file-for-fake-audio-capture=' + wavPath);
  chromeArgs.push(target);
  chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', (d) => { errText += d.toString(); });
}
const finish = (code) => {
  try { if (server) server.close(); } catch (e) { /* gone */ }
  try { chrome.kill(); } catch (e) { /* gone */ }
  // Chrome keeps writing its profile for a moment after the kill; try a few times, then give up.
  let tries = 0;
  const rm = () => { try { fs.rmSync(work, { recursive: true, force: true }); process.exit(code); } catch (e) { if (++tries < 20) setTimeout(rm, 250); else process.exit(code); } };
  setTimeout(rm, 300);
};

(async () => {
  await launchChrome();
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); page = t.find((x) => x.type === 'page'); } catch (e) { /* not up yet */ }
    if (!page) await sleep(200);
  }
  if (!page) { console.log('Chrome did not come up'); finish(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  // Console errors and uncaught exceptions come over the protocol. Chrome's
  // stderr only carries them with --enable-logging, and even then not the
  // page's own console.error; this sees both, and reports them.
  const consoleErrs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === 'Runtime.exceptionThrown') {
      const e = d.params.exceptionDetails;
      consoleErrs.push((e.exception && e.exception.description) || e.text);
    } else if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'assert')) {
      consoleErrs.push(d.params.args.map((a) => a.description || a.value).join(' '));
    } else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
      consoleErrs.push(d.params.entry.text + (d.params.entry.url ? ' (' + d.params.entry.url + ')' : ''));
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Log.enable');
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  // wait for the page's scripts -- each page has its own debug handle, and
  // waiting for the other one's burned the whole 10 s before every OFDM run
  const ready = engine === 'ofdm' ? 'typeof earshotDebug === "object"' : 'typeof modemDebug === "object"';
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { up = await evalJs(ready); } catch (e) { /* loading */ } if (!up) await sleep(200); }
  if (!up) { console.log('the page never defined ' + ready); finish(1); }

  if (mode === 'wav') {
    await send('DOM.enable');
    const doc = await send('DOM.getDocument', { depth: 1 });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#rxWav' });
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [wavPath] });
  }

  const deadline = Date.now() + seconds * 1000;
  let state = null;
  const expr = engine === 'ofdm'
    ? 'JSON.stringify({title: document.title, mic: document.getElementById("rxStatus").textContent, seen: (earshotDebug.rx.stats||{}).frames||0, ok: (earshotDebug.rx.stats||{}).framesOk||0, drops: earshotDebug.rx.drops, failures: (earshotDebug.rx.stats||{}).sigFail||0, done: !!earshotDebug.fileBytes})'
    : 'JSON.stringify({title: document.title, mic: document.getElementById("micInfo").textContent, seen: modemDebug.rx.framesSeen, ok: modemDebug.rx.framesOk, drops: modemDebug.rx.drops, failures: modemDebug.rx.failures.length, done: !!modemDebug.rx.result})';
  while (Date.now() < deadline) {
    try { state = JSON.parse(await evalJs(expr)); } catch (e) { await sleep(500); continue; }
    if (state.done) break;
    await sleep(500);
  }
  for (const l of errText.split('\n')) if (/Uncaught|TypeError|ReferenceError/.test(l)) consoleErrs.push(l.trim());
  if (!state || !state.done) {
    console.log('not received in time:', JSON.stringify(state));
    const log = await evalJs('Array.from(document.getElementById("log").children).slice(-10).map(d => d.textContent).join("\\n")');
    console.log(log);
    consoleErrs.forEach((l) => console.log('console: ' + l));
    finish(1);
  }
  const got = new Uint8Array(JSON.parse(await evalJs(engine === 'ofdm'
    ? 'JSON.stringify(Array.from(earshotDebug.fileBytes))'
    : 'JSON.stringify(Array.from(modemDebug.rx.result.bytes))')));
  let same = got.length === bytes.length;
  for (let i = 0; same && i < got.length; i++) if (got[i] !== bytes[i]) same = false;
  console.log(`${mode === 'mic' ? state.mic : 'wav input'}`);
  console.log(`frames ok ${state.ok} / seen ${state.seen}, failures ${state.failures}, audio drops ${state.drops}, received ${got.length} bytes, identical: ${same}`);
  consoleErrs.forEach((l) => console.log('console: ' + l));
  finish(same ? 0 : 1);
})().catch((e) => { console.log('error: ' + e.message); finish(1); });
