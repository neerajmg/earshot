// earshot.js -- the product page. Moves bytes between the UI, the Web Audio
// graph, and the worker; all signal processing lives in the worker (receive)
// or air.js (send). No DSP here.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {};
  for (const id of ['drop', 'file', 'dropText', 'fileInfo', 'txPass', 'send', 'stopSend', 'txProgress', 'txStatus',
    'sample', 'txText', 'sendText', 'benchmarks',
    'listen', 'stopListen', 'rxProgress', 'rxStatus', 'result', 'resultName', 'resultText', 'passRow', 'rxPass', 'unlock', 'save',
    'resultStatus', 'advanced', 'engineInfo', 'spec', 'log']) ui[id] = $(id);

  const log = new Diag.Log(ui.log, 250);
  const spec = new Diag.Spectrogram(ui.spec, { maxHz: 8000 });
  const specDraw = { draw: () => { if (ui.advanced.open) spec.draw(); } };
  Diag.loop([specDraw], 10);

  const FS = 48000;
  const FRAME_SEC = (1920 + Air.GUARD + 75 * 1280 + 32 + Air.GAP) / FS;
  const MAX_BYTES = 2 * 1048576;

  // One formula for every estimate on the page, so the numbers cannot drift
  // from the code: three 256-byte droplets (768 bytes) per 2.07 s frame,
  // plus two spare frames.
  function framesFor(bytes) { return Math.ceil((Math.ceil(bytes / Fountain.BLOCK) || 1) / Air.DROPLETS_PER_FRAME) + 2; }
  function secondsFor(bytes) { return framesFor(bytes) * FRAME_SEC + 1; }

  const SAMPLE_TEXT = [
    'Hello from earshot.',
    '',
    'This message left one device as sound and arrived on another through the air:',
    'a 40 ms chirp so the receiver could find the start, then OFDM symbols on 116',
    'subcarriers between 1.5 and 7.5 kHz, protected by a convolutional code and a',
    'fountain code so a lost frame costs time, not the file.',
    '',
    'If you can read this, the whole chain worked. Sample check digits: 31415926535.',
    '',
  ].join('\n');
  const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(2) + ' MB');
  const fmtTime = (s) => { s = Math.max(0, Math.round(s)); return s < 90 ? s + ' s' : Math.round(s / 60) + ' min'; };

  let ctx = null;
  async function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { ctx = new AC({ sampleRate: FS }); } catch (e) { ctx = new AC(); }
    }
    if (ctx.state !== 'running') await ctx.resume();
    ui.engineInfo.textContent = `audio ${ctx.sampleRate} Hz` + (ctx.sampleRate !== FS ? ` (resampling to ${FS})` : '');
    return ctx;
  }

  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
      else if (!on && wake) { await wake.release(); wake = null; }
    } catch (e) { /* fine */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) log.add('page hidden - audio may be throttled', 'bad'); });

  // ------------------------------------------------------------------ send

  const tx = { file: null, sender: null, playing: false, done: 0, sources: new Set(), nextTime: 0, startedAt: 0, estFrames: 0, timer: null };

  function pickFile(f) {
    if (!f) return;
    if (f.size > MAX_BYTES) { ui.fileInfo.innerHTML = '<span class="bad">Over 2 MB — at the speed of sound through air that is hours. Smaller, please.</span>'; return; }
    tx.file = f;
    ui.dropText.innerHTML = '📄 ' + f.name + '<br><span class="hint">tap to change</span>';
    ui.fileInfo.textContent = `${fmtBytes(f.size)} — ${framesFor(f.size)} frames, about ${fmtTime(secondsFor(f.size))} of sound; less if it compresses.`;
    ui.send.disabled = false;
  }

  ui.sample.addEventListener('click', () => {
    pickFile(new File([new TextEncoder().encode(SAMPLE_TEXT)], 'earshot-sample.txt', { type: 'text/plain' }));
  });

  // The benchmark table, from the same formula as the live estimate.
  (function fillBenchmarks() {
    const rows = [[1024, '1 kB'], [10 * 1024, '10 kB'], [100 * 1024, '100 kB'], [500 * 1024, '500 kB'], [1048576, '1 MB'], [MAX_BYTES, '2 MB (max)']];
    const tb = ui.benchmarks.querySelector('tbody');
    for (const [bytes, label] of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${label}</td><td>${framesFor(bytes)}</td><td>${fmtTime(secondsFor(bytes))}</td>`;
      tb.appendChild(tr);
    }
  })();
  ui.file.addEventListener('change', () => pickFile(ui.file.files[0]));
  ui.drop.addEventListener('dragover', (e) => { e.preventDefault(); ui.drop.classList.add('hover'); });
  ui.drop.addEventListener('dragleave', () => ui.drop.classList.remove('hover'));
  ui.drop.addEventListener('drop', (e) => { e.preventDefault(); ui.drop.classList.remove('hover'); pickFile(e.dataTransfer.files[0]); });

  async function startSend() {
    const c = await ensureCtx();
    ui.send.disabled = true;
    ui.txStatus.textContent = 'preparing…';
    const bytes = new Uint8Array(await tx.file.arrayBuffer());
    const pass = ui.txPass.value.trim();
    const prep = await Air.prepare(bytes, tx.file.name, pass ? { passphrase: pass } : undefined);
    tx.sender = new Air.Sender(prep);
    const blocks = Math.ceil(prep.payload.length / Fountain.BLOCK) || 1;
    tx.estFrames = Math.ceil(blocks / Air.DROPLETS_PER_FRAME) + 2;
    tx.playing = true; tx.done = 0;
    tx.startedAt = c.currentTime;
    tx.nextTime = c.currentTime + 0.2;
    ui.send.style.display = 'none'; ui.stopSend.style.display = '';
    ui.txProgress.style.display = ''; ui.txProgress.value = 0;
    keepAwake(true);
    log.add(`sending ${tx.file.name}: ${fmtBytes(bytes.length)} -> ${fmtBytes(prep.payload.length)} on air` + (prep.flags & 2 ? ', encrypted' : ''), 'info');
    pump();
    tx.timer = setInterval(() => { pump(); txProgress(); }, 300);
  }

  function pump() {
    if (!tx.playing) return;
    while (tx.sources.size < 3) {
      let samples = tx.sender.nextFrame();
      if (ctx.sampleRate !== FS) samples = FFT.sincResample(samples, FS, ctx.sampleRate);
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination);
      if (tx.nextTime < ctx.currentTime) tx.nextTime = ctx.currentTime + 0.05;
      src.start(tx.nextTime);
      tx.nextTime += buf.duration;
      tx.sources.add(src);
      src.onended = () => { tx.sources.delete(src); tx.done++; pump(); };
    }
  }

  function txProgress() {
    if (!tx.playing) return;
    ui.txProgress.value = Math.min(1, tx.done / tx.estFrames);
    const extra = tx.done > tx.estFrames ? ' — keep going until the receiver has it' : '';
    ui.txStatus.textContent = `frame ${tx.done}, about ${fmtTime((tx.estFrames - tx.done) * FRAME_SEC)} left${extra}`;
  }

  function stopSend() {
    tx.playing = false;
    clearInterval(tx.timer);
    for (const s of tx.sources) { s.onended = null; try { s.stop(); } catch (e) { /* stopped */ } }
    tx.sources.clear();
    ui.send.style.display = ''; ui.send.disabled = !tx.file;
    ui.stopSend.style.display = 'none';
    ui.txStatus.textContent = `stopped after ${tx.done} frames`;
    keepAwake(false);
  }
  ui.send.addEventListener('click', () => startSend().catch((e) => { ui.txStatus.textContent = e.message; ui.send.disabled = false; }));
  ui.stopSend.addEventListener('click', stopSend);

  // A typed message travels as a small text file named message.txt; the
  // receiver shows text files inline.
  ui.sendText.addEventListener('click', () => {
    const text = ui.txText.value;
    if (!text.trim()) { ui.txStatus.textContent = 'type something first.'; return; }
    tx.file = new File([new TextEncoder().encode(text)], 'message.txt', { type: 'text/plain' });
    ui.dropText.innerHTML = '💬 message.txt<br><span class="hint">from the text box</span>';
    ui.fileInfo.textContent = `${fmtBytes(tx.file.size)} — ${framesFor(tx.file.size)} frames, about ${fmtTime(secondsFor(tx.file.size))} of sound.`;
    startSend().catch((e) => { ui.txStatus.textContent = e.message; ui.send.disabled = false; });
  });

  // --------------------------------------------------------------- receive

  const rx = { worker: null, stream: null, node: null, proc: null, mute: null, listening: false, lastQuanta: 0, drops: 0, fileBytes: null, fileName: null, complete: null };

  function ensureWorker() {
    if (rx.worker) return rx.worker;
    rx.worker = new Worker('worker.js');
    rx.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'frame') {
        ui.rxProgress.style.display = '';
        ui.rxProgress.value = m.progress;
        if (m.manifest) ui.rxStatus.textContent = `${m.manifest.name}: ${Math.round(m.progress * 100)} % of ${fmtBytes(m.manifest.size)}`;
        log.add(`frame ok (${m.stats.droplets} droplets, ${m.stats.dropletCrcFail} bad)`);
      } else if (m.type === 'complete') {
        rx.complete = m;
        ui.result.classList.add('show');
        ui.resultName.textContent = `📄 ${m.name} — ${fmtBytes(m.size)}`;
        ui.rxStatus.textContent = 'received.';
        if (m.needsPassphrase) { ui.passRow.style.display = ''; ui.resultStatus.textContent = 'encrypted by the sender.'; }
        else rx.worker.postMessage({ type: 'file' });
        stopListen();
      } else if (m.type === 'file') {
        rx.fileBytes = new Uint8Array(m.bytes);
        rx.fileName = m.name;
        ui.passRow.style.display = 'none';
        ui.save.style.display = '';
        ui.resultStatus.innerHTML = '<span class="ok">ready to save.</span>';
        // short text shows inline - that is the whole point of "send a text"
        if (/\.(txt|md|json|csv)$/i.test(m.name || '') && rx.fileBytes.length <= 8192) {
          try {
            ui.resultText.textContent = new TextDecoder('utf-8', { fatal: true }).decode(rx.fileBytes);
            ui.resultText.style.display = '';
          } catch (e) { ui.resultText.style.display = 'none'; }
        } else {
          ui.resultText.style.display = 'none';
        }
        if (window.__autosave) saveFile();
      } else if (m.type === 'fileError') {
        ui.resultStatus.innerHTML = `<span class="bad">${m.message}</span>`;
        if (m.needsPassphrase) ui.passRow.style.display = '';
      }
    };
    rx.worker.postMessage({ type: 'init', fs: FS });
    return rx.worker;
  }

  async function startListen() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      ui.rxStatus.textContent = 'microphone needs HTTPS — open the published page.';
      return;
    }
    const c = await ensureCtx();
    ensureWorker();
    rx.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    const st = rx.stream.getAudioTracks()[0].getSettings ? rx.stream.getAudioTracks()[0].getSettings() : {};
    ui.engineInfo.textContent = `audio ${c.sampleRate} Hz | mic AEC ${st.echoCancellation} NS ${st.noiseSuppression} AGC ${st.autoGainControl}`;
    const src = c.createMediaStreamSource(rx.stream);
    const feed = (chunk, quanta) => {
      if (quanta !== undefined) {
        if (rx.lastQuanta && quanta - rx.lastQuanta > 40) { rx.drops++; log.add('audio gap', 'bad'); }
        rx.lastQuanta = quanta;
      }
      spec.push(chunk);
      let out = chunk;
      if (c.sampleRate !== FS) out = FFT.sincResample(chunk, c.sampleRate, FS);
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      rx.worker.postMessage({ type: 'push', buf }, [buf]);
    };
    let worklet = false;
    try {
      await c.audioWorklet.addModule('capture-worklet.js');
      rx.node = new AudioWorkletNode(c, 'capture');
      rx.node.port.onmessage = (e) => feed(new Float32Array(e.data.buf), e.data.quanta);
      rx.mute = c.createGain(); rx.mute.gain.value = 0;
      src.connect(rx.node); rx.node.connect(rx.mute); rx.mute.connect(c.destination);
      worklet = true;
    } catch (e) {
      rx.proc = c.createScriptProcessor(4096, 1, 1);
      rx.mute = c.createGain(); rx.mute.gain.value = 0;
      src.connect(rx.proc); rx.proc.connect(rx.mute); rx.mute.connect(c.destination);
      rx.proc.onaudioprocess = (ev) => feed(new Float32Array(ev.inputBuffer.getChannelData(0)));
    }
    rx.srcNode = src;
    rx.listening = true;
    spec.reset(c.sampleRate);
    spec.setTones([1500, 7500]);
    ui.listen.style.display = 'none'; ui.stopListen.style.display = '';
    ui.rxStatus.textContent = 'listening… start the sender on the other device.';
    log.add(`listening (${worklet ? 'worklet' : 'script processor'})`, 'info');
    keepAwake(true);
  }

  function stopListen() {
    if (rx.node) { rx.node.port.onmessage = null; rx.node.disconnect(); rx.node = null; }
    if (rx.proc) { rx.proc.onaudioprocess = null; rx.proc.disconnect(); rx.proc = null; }
    if (rx.srcNode) { rx.srcNode.disconnect(); rx.srcNode = null; }
    if (rx.mute) { rx.mute.disconnect(); rx.mute = null; }
    if (rx.stream) { rx.stream.getTracks().forEach((t) => t.stop()); rx.stream = null; }
    rx.listening = false;
    ui.listen.style.display = ''; ui.stopListen.style.display = 'none';
    keepAwake(false);
  }
  ui.listen.addEventListener('click', () => startListen().catch((e) => { ui.rxStatus.textContent = e.message; }));
  ui.stopListen.addEventListener('click', () => { stopListen(); ui.rxStatus.textContent = 'stopped.'; });
  ui.unlock.addEventListener('click', () => { rx.worker.postMessage({ type: 'file', passphrase: ui.rxPass.value }); });

  async function saveFile() {
    if (!rx.fileBytes) return;
    const file = new File([rx.fileBytes], rx.fileName || 'received.bin', { type: 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { /* fall through to download */ }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  ui.save.addEventListener('click', saveFile);

  // -------------------------------------------------------------- harness

  window.earshotDebug = { tx, rx, get fileBytes() { return rx.fileBytes; } };

  const params = new URLSearchParams(location.search);
  if (params.has('listen')) startListen().catch((e) => { ui.rxStatus.textContent = e.message; });

  if (params.has('selftest')) {
    (async () => {
      const el = document.createElement('div');
      el.id = 'selftest';
      document.body.appendChild(el);
      let stage = 'start';
      try {
        const bytes = new Uint8Array(700).map((_, i) => (i * 131 + 17) & 0xFF);
        stage = 'prepare';
        const prep = await Air.prepare(bytes, 'selftest.bin');
        stage = 'transfer';
        const sender = new Air.Sender(prep, { session: 6 });
        const recv = new Air.Receiver(FS);
        let n = 0;
        while (!recv.result && n++ < 10) { recv.push(new Float32Array(600)); recv.push(sender.nextFrame()); }
        stage = 'file';
        const f = await recv.file();
        const ok = f && f.bytes.length === bytes.length && f.bytes.every((v, i) => v === bytes[i]);
        document.title = 'SELFTEST ' + (ok ? 'PASS' : 'FAIL');
        el.textContent = document.title + ' | flags ' + prep.flags + ' | frames ' + n + ' | ' + JSON.stringify(recv.stats);
      } catch (e) {
        document.title = 'SELFTEST FAIL';
        el.textContent = 'SELFTEST FAIL at ' + stage + ': ' + e.message;
      }
    })();
  }
})();
