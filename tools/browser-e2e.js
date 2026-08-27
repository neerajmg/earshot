#!/usr/bin/env node
// End-to-end through the real page in headless Chrome.
//
// Renders a file to a WAV, then either feeds it to the page as a fake
// microphone (--mic, the default) or hands it to the page's "Decode a WAV"
// input (--wav). Polls the page over the DevTools protocol until the file is
// received, pulls the received bytes back out and compares.
//
//   node tools/browser-e2e.js [robust|fast] [--mic|--wav] [--file path] [--seconds 120]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const presetName = args.find((a) => Modem.PRESETS[a]) || 'robust';
const mode = args.includes('--wav') ? 'wav' : 'mic';
const seconds = Number(opt('--seconds', 120));
const filePath = opt('--file', null);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + Math.floor(Math.random() * 100);
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modem-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const preset = Modem.PRESETS[presetName];
const bytes = filePath ? new Uint8Array(fs.readFileSync(filePath)) : new Uint8Array(600).map((_, i) => (i * 131 + 17) & 0xFF);
const sender = new Modem.Sender(bytes, filePath ? path.basename(filePath) : 'e2e.bin');
const seq = sender.passSequence();
const fsr = 48000;
const parts = [new Float32Array(fsr)];
for (const raw of seq) parts.push(DSP.modulateFrame(Modem.frameToBits(raw), preset, fsr));
parts.push(new Float32Array(fsr));
let n = 0; for (const x of parts) n += x.length;
const all = new Float32Array(n); let off = 0; for (const x of parts) { all.set(x, off); off += x.length; }
const wavPath = path.join(work, 'tx.wav');
fs.writeFileSync(wavPath, Buffer.from(DSP.wavEncode(all, fsr)));
console.log(`${presetName} via ${mode}: ${bytes.length} bytes, ${seq.length} frames, ${(n / fsr).toFixed(1)} s of audio`);

const url = 'file://' + encodeURI(path.join(root, 'index.html')) + '?preset=' + presetName + (mode === 'mic' ? '&listen' : '');
const chromeArgs = ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(work, 'profile'),
  '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (mode === 'mic') chromeArgs.push('--use-file-for-fake-audio-capture=' + wavPath);
chromeArgs.push(url);
const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
let errText = '';
chrome.stderr.on('data', (d) => { errText += d.toString(); });
const finish = (code) => {
  try { chrome.kill(); } catch (e) { /* gone */ }
  // Chrome keeps writing its profile for a moment after the kill; try a few times, then give up.
  let tries = 0;
  const rm = () => { try { fs.rmSync(work, { recursive: true, force: true }); process.exit(code); } catch (e) { if (++tries < 20) setTimeout(rm, 250); else process.exit(code); } };
  setTimeout(rm, 300);
};

(async () => {
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); page = t.find((x) => x.type === 'page'); } catch (e) { /* not up yet */ }
    if (!page) await sleep(200);
  }
  if (!page) { console.log('Chrome did not come up'); finish(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  // wait for the page's scripts
  for (let i = 0; i < 50; i++) { try { if (await evalJs('typeof modemDebug === "object"')) break; } catch (e) { /* loading */ } await sleep(200); }

  if (mode === 'wav') {
    await send('DOM.enable');
    const doc = await send('DOM.getDocument', { depth: 1 });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#rxWav' });
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [wavPath] });
  }

  const deadline = Date.now() + seconds * 1000;
  let state = null;
  while (Date.now() < deadline) {
    state = JSON.parse(await evalJs('JSON.stringify({title: document.title, mic: document.getElementById("micInfo").textContent, seen: modemDebug.rx.framesSeen, ok: modemDebug.rx.framesOk, drops: modemDebug.rx.drops, failures: modemDebug.rx.failures.length, done: !!modemDebug.rx.result})'));
    if (state.done) break;
    await sleep(500);
  }
  const consoleErrs = errText.split('\n').filter((l) => /Uncaught|TypeError|ReferenceError/.test(l));
  if (!state || !state.done) {
    console.log('not received in time:', JSON.stringify(state));
    const log = await evalJs('Array.from(document.getElementById("log").children).slice(-10).map(d => d.textContent).join("\\n")');
    console.log(log);
    consoleErrs.forEach((l) => console.log('console: ' + l));
    finish(1);
  }
  const got = new Uint8Array(JSON.parse(await evalJs('JSON.stringify(Array.from(modemDebug.rx.result.bytes))')));
  let same = got.length === bytes.length;
  for (let i = 0; same && i < got.length; i++) if (got[i] !== bytes[i]) same = false;
  console.log(`${mode === 'mic' ? state.mic : 'wav input'}`);
  console.log(`frames ok ${state.ok} / seen ${state.seen}, failures ${state.failures}, audio drops ${state.drops}, received ${got.length} bytes, identical: ${same}`);
  consoleErrs.forEach((l) => console.log('console: ' + l));
  finish(same ? 0 : 1);
})().catch((e) => { console.log('error: ' + e.message); finish(1); });
