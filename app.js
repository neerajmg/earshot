// app.js -- browser glue. Audio in and out, buttons, and the receive pipeline.
//
// Nothing here does signal processing; that is dsp.js. Nothing here parses
// frames; that is modem.js. This file moves samples between the Web Audio
// API and those two, and keeps the page up to date.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {};
  for (const id of ['preset', 'rate', 'ctxinfo', 'banner',
    'txFile', 'txFileInfo', 'passes', 'forever', 'amp', 'play', 'stop', 'loopback', 'wav', 'wavRate', 'txProgress', 'txStatus',
    'listen', 'stopListen', 'reset', 'record', 'dlRec', 'rxWav', 'micInfo',
    'sSnr', 'sBal', 'sCorr', 'sFrames', 'sFix', 'sDrops', 'rxFileInfo', 'rxProgress', 'dlResult', 'rxResult', 'log']) ui[id] = $(id);

  const log = new Diag.Log(ui.log);
  const spec = new Diag.Spectrogram($('spec'));
  const plot = new Diag.DecisionPlot($('env'), 3);
  const map = new Diag.FrameMap($('map'));
  const meter = new Diag.LevelMeter($('level'));
  Diag.loop([spec, plot, map, meter], 30);

  function preset() { return Modem.PRESETS[ui.preset.value] || Modem.PRESETS.robust; }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(2) + ' MB'; }
  function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (!window.isSecureContext || !navigator.mediaDevices) {
    ui.banner.style.display = 'block';
    ui.banner.textContent = 'The microphone needs a secure context. Serve this folder with "python3 -m http.server 8000" and open http://localhost:8000. Sending, digital loopback and WAV decoding work from here anyway.';
  }

  // ------------------------------------------------------------ audio context

  let ctx = null;
  async function getContext() {
    const want = ui.rate.value ? Number(ui.rate.value) : 0;
    if (ctx && want && ctx.sampleRate !== want) { await ctx.close(); ctx = null; }
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC(want ? { sampleRate: want } : undefined);
    }
    if (ctx.state !== 'running') await ctx.resume();
    ui.ctxinfo.textContent = 'audio ' + ctx.sampleRate + ' Hz, ' + ctx.state;
    return ctx;
  }

  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      } else if (!on && wake) { await wake.release(); wake = null; }
    } catch (e) { /* not available; caffeinate -d does the same */ }
  }

  function download(data, name, type) {
    const blob = new Blob([data], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // -------------------------------------------------------------------- TX

  const tx = { file: null, sender: null, seq: [], playing: false, done: false, sources: new Set(), nextTime: 0, index: 0, pass: 0, passes: 1, sent: 0, timer: null, startedAt: 0, preset: null, amp: 0.5 };

  ui.txFile.addEventListener('change', async () => {
    const f = ui.txFile.files[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length > 0xFFFF * Modem.FRAME.DATA) { log.add('file too big: max ' + fmtBytes(0xFFFF * Modem.FRAME.DATA), 'bad'); return; }
    setTxFile(f.name, bytes);
  });
  ui.preset.addEventListener('change', describeTxFile);

  function setTxFile(name, bytes) {
    tx.file = { name, bytes };
    describeTxFile();
    ui.play.disabled = ui.loopback.disabled = ui.wav.disabled = false;
  }

  function describeTxFile() {
    if (!tx.file) return;
    const p = preset();
    const n = new Modem.Sender(tx.file.bytes, tx.file.name, { session: 0 }).passSequence().length;
    const frames = Math.ceil(tx.file.bytes.length / Modem.FRAME.DATA);
    ui.txFileInfo.textContent = `${tx.file.name}: ${fmtBytes(tx.file.bytes.length)}, ${frames} data frames, ${n} frames per pass, ${fmtTime(n * DSP.frameDuration(p))} per pass at ${p.baud} baud`;
  }

  async function play() {
    const c = await getContext();
    tx.sender = new Modem.Sender(tx.file.bytes, tx.file.name);
    tx.seq = tx.sender.passSequence();
    tx.passes = ui.forever.checked ? Infinity : Math.max(1, Number(ui.passes.value) || 1);
    tx.preset = preset();
    tx.amp = Number(ui.amp.value);
    tx.index = 0; tx.pass = 0; tx.sent = 0; tx.done = false; tx.playing = true;
    tx.startedAt = c.currentTime;
    tx.nextTime = c.currentTime + 0.2;
    ui.play.disabled = true; ui.stop.disabled = false; ui.loopback.disabled = true;
    keepAwake(true);
    log.add(`TX: ${tx.file.name}, session ${tx.sender.session}, ${tx.seq.length} frames per pass, ${tx.passes === Infinity ? 'endless' : tx.passes} pass(es), ${tx.preset.name} at ${c.sampleRate} Hz`, 'info');
    pump();
    tx.timer = setInterval(() => { pump(); txProgress(); }, 250);
  }

  // Keeps up to three frames scheduled ahead. Frames are rendered one at a
  // time, so a long transfer never needs a huge buffer.
  function pump() {
    if (!tx.playing) return;
    while (!tx.done && tx.sources.size < 3) {
      if (tx.index >= tx.seq.length) {
        tx.pass++; tx.index = 0;
        if (tx.pass >= tx.passes) { tx.done = true; break; }
      }
      const raw = tx.seq[tx.index++];
      const samples = DSP.modulateFrame(Modem.frameToBits(raw, tx.pass), tx.preset, ctx.sampleRate, { amplitude: tx.amp });
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      if (tx.nextTime < ctx.currentTime) tx.nextTime = ctx.currentTime + 0.05;   // fell behind (tab throttled)
      src.start(tx.nextTime);
      tx.nextTime += buf.duration;
      tx.sources.add(src);
      src.onended = () => { tx.sources.delete(src); tx.sent++; pump(); };
    }
    if (tx.done && tx.sources.size === 0) finishTx('done');
  }

  function txProgress() {
    if (!tx.playing) return;
    const total = tx.seq.length * tx.passes;
    const elapsed = ctx.currentTime - tx.startedAt;
    ui.txProgress.value = total === Infinity ? 0 : tx.sent / total;
    const eta = tx.sent > 0 && total !== Infinity ? (total - tx.sent) * (elapsed / tx.sent) : NaN;
    ui.txStatus.textContent = `pass ${tx.pass + 1}${tx.passes === Infinity ? '' : ' / ' + tx.passes}, frame ${Math.min(tx.index, tx.seq.length)} / ${tx.seq.length}, ${fmtTime(elapsed)} elapsed` + (isNaN(eta) ? '' : `, about ${fmtTime(eta)} left`);
  }

  function finishTx(why) {
    tx.playing = false;
    clearInterval(tx.timer);
    for (const s of tx.sources) { s.onended = null; try { s.stop(); } catch (e) { /* already stopped */ } }
    tx.sources.clear();
    ui.play.disabled = false; ui.stop.disabled = true; ui.loopback.disabled = false;
    ui.txProgress.value = why === 'done' ? 1 : ui.txProgress.value;
    ui.txStatus.textContent = why === 'done' ? `done: ${tx.sent} frames sent` : `stopped after ${tx.sent} frames`;
    keepAwake(false);
    log.add('TX ' + why, 'info');
  }

  ui.play.addEventListener('click', () => play().catch((e) => log.add('play: ' + e.message, 'bad')));
  ui.stop.addEventListener('click', () => finishTx('stopped'));

  // Renders the whole transmission to a 16-bit WAV. Useful for playing from
  // another device or for feeding the receiver offline.
  function downloadWav() {
    const fs = Number(ui.wavRate.value);
    const p = preset(), amp = Number(ui.amp.value);
    const sender = new Modem.Sender(tx.file.bytes, tx.file.name);
    const seq = sender.passSequence();
    const passes = ui.forever.checked ? 1 : Math.max(1, Number(ui.passes.value) || 1);
    const perFrame = Math.round(DSP.SYMBOLS_PER_FRAME * fs / p.baud) + Math.round(p.gapSec * fs);
    const total = perFrame * seq.length * passes;
    if (total * 2 > 400e6) { log.add('that WAV would be over 400 MB; use fewer passes or 16 kHz', 'bad'); return; }
    const out = new Int16Array(total);
    let off = 0;
    for (let pass = 0; pass < passes; pass++) {
      for (const raw of seq) {
        const s = DSP.modulateFrame(Modem.frameToBits(raw, pass), p, fs, { amplitude: amp });
        for (let i = 0; i < s.length; i++) out[off + i] = Math.round(s[i] * 32767);
        off += s.length;
      }
    }
    download(DSP.wavEncode(out, fs), tx.file.name + '.' + p.name + '.' + fs + '.wav', 'audio/wav');
    log.add(`WAV: ${fmtBytes(total * 2)}, ${fmtTime(total / fs)}, ${passes} pass(es), session ${sender.session}`, 'info');
  }
  ui.wav.addEventListener('click', downloadWav);

  // Modulates and feeds the receiver directly, no audio. Proves the code path.
  async function loopback() {
    const fs = 48000;
    const p = preset();
    ui.loopback.disabled = true; ui.play.disabled = true;
    if (rx.active === 'mic') stopListen();
    rxReset();
    rxStart({ fs, source: 'loopback', preset: p });
    const sender = new Modem.Sender(tx.file.bytes, tx.file.name);
    const seq = sender.passSequence();
    for (let i = 0; i < seq.length && rx.active === 'loopback'; i++) {
      feed(DSP.modulateFrame(Modem.frameToBits(seq[i]), p, fs, { amplitude: Number(ui.amp.value) }));
      await sleep(0);
    }
    log.add('loopback done', 'info');
    rx.active = null;
    ui.loopback.disabled = false; ui.play.disabled = false;
  }
  ui.loopback.addEventListener('click', () => loopback().catch((e) => log.add('loopback: ' + e.message, 'bad')));

  // -------------------------------------------------------------------- RX

  const rx = {
    active: null, fs: 0, preset: null, demod: null, receiver: new Modem.Receiver(),
    stream: null, srcNode: null, proc: null, mute: null, lastTime: null, drops: 0,
    recording: false, chunks: [], recSamples: 0, recFs: 0,
    framesSeen: 0, framesOk: 0, result: null, crcMismatchLogged: false,
    failures: [],                                    // last 100 bad frames, for the console
  };

  function rxStart(opts) {
    rx.fs = opts.fs;
    rx.active = opts.source;
    rx.preset = opts.preset || preset();
    rx.demod = new DSP.Demodulator(rx.preset, opts.fs, { onSync, onFrame });
    rx.lastTime = null; rx.drops = 0;
    plot.setDemod(rx.demod);
    spec.reset(opts.fs);
    spec.setTones([rx.preset.spaceHz, rx.preset.markHz]);
    ui.sDrops.textContent = '0';
    log.add(`RX ${opts.source}: ${rx.preset.name}, ${rx.preset.baud} baud, ${rx.preset.spaceHz}/${rx.preset.markHz} Hz, ${opts.fs} Hz`, 'info');
  }

  function feed(chunk) {
    meter.push(chunk);
    spec.push(chunk);
    if (rx.recording) record(chunk);
    rx.demod.push(chunk);
  }

  function onSync(s) {
    ui.sSnr.textContent = s.snrDb.toFixed(1);
    ui.sBal.textContent = (s.balanceDb >= 0 ? '+' : '') + s.balanceDb.toFixed(1);
    ui.sCorr.textContent = s.corr.toFixed(2);
    const hint = Math.abs(s.balanceDb) > 12 ? '  (one tone is much weaker: move the laptop a little)' : '';
    log.add(`sync ${(s.t0 / rx.fs).toFixed(2)} s: corr ${s.corr.toFixed(2)}, sync errors ${s.syncErrors}, SNR ${s.snrDb.toFixed(1)} dB, balance ${s.balanceDb.toFixed(1)} dB${hint}`);
  }

  function onFrame(f) {
    const d = Modem.bitsToFrame(f.bits);
    const res = rx.receiver.accept(d.raw);
    const ok = res.kind !== 'crcfail' && res.kind !== 'bad';
    rx.framesSeen++;
    if (ok) rx.framesOk++;
    else {
      rx.failures.push({ t: f.t0 / rx.fs, kind: res.kind, corrected: d.corrected, uncorrectable: d.uncorrectable, syncErrors: f.syncErrors, corr: f.corr, margin: f.softMargin, snrDb: f.snrDb });
      if (rx.failures.length > 100) rx.failures.shift();
    }
    rx.demod.lastBias = f.bias;
    ui.sFrames.textContent = rx.framesOk + ' / ' + rx.framesSeen;
    ui.sFix.textContent = d.corrected + (d.uncorrectable ? ' +' + d.uncorrectable + ' bad' : '') + (d.scrambler ? ' (pass ' + (d.scrambler + 1) + ')' : '');
    const t = (f.t0 / rx.fs).toFixed(2) + ' s';
    const fix = d.corrected ? `, ${d.corrected} bits fixed` : '';
    const total = rx.receiver.meta ? rx.receiver.meta.totalFrames : '?';
    switch (res.kind) {
      case 'crcfail': log.add(`frame ${t}: CRC fail (${d.corrected} fixed, ${d.uncorrectable} uncorrectable, margin ${f.softMargin.toFixed(2)})`, 'bad'); break;
      case 'bad': log.add(`frame ${t}: unknown type or seq out of range`, 'bad'); break;
      case 'start': log.add(res.dup ? `START again (session ${res.session})${fix}` : `START: ${res.meta.name}, ${fmtBytes(res.meta.size)}, ${res.meta.totalFrames} frames, session ${res.session}${fix}`, 'ok'); break;
      case 'data': log.add(`frame ${res.seq + 1} / ${total} ok${fix}`, 'ok'); break;
      case 'dup': log.add(`frame ${res.seq + 1} / ${total} again${fix}`); break;
      case 'replaced': log.add(`frame ${res.seq + 1} replaced with different bytes; CRC-32 decides`, 'bad'); break;
      case 'buffered': log.add(`frame ${res.seq + 1} of session ${res.session} kept, no START yet${fix}`); break;
    }
    updateRxProgress();
    return ok;
  }

  function updateRxProgress() {
    const r = rx.receiver;
    if (!r.meta) return;
    const have = r.have();
    const n = have.filter(Boolean).length;
    map.update(have);
    ui.rxProgress.value = r.meta.totalFrames ? n / r.meta.totalFrames : 1;
    ui.rxFileInfo.textContent = `${r.meta.name}: ${fmtBytes(r.meta.size)}, ${n} / ${r.meta.totalFrames} frames`;
    if (r.isComplete() && !rx.result) {
      rx.result = r.assemble();
      ui.dlResult.disabled = false;
      ui.rxResult.textContent = `${rx.result.name}, ${fmtBytes(rx.result.bytes.length)}, CRC-32 ok`;
      log.add(`complete: ${rx.result.name}, ${rx.result.bytes.length} bytes, CRC-32 ok`, 'ok');
      document.title = 'received ' + rx.result.name;
    } else if (!r.isComplete() && r.missing() === 0 && !rx.crcMismatchLogged) {
      rx.crcMismatchLogged = true;
      log.add('all frames present but the file CRC-32 does not match; waiting for repeats', 'bad');
    }
  }

  function rxReset() {
    rx.receiver.reset();
    rx.result = null; rx.crcMismatchLogged = false;
    rx.framesSeen = 0; rx.framesOk = 0;
    map.update([]);
    ui.rxProgress.value = 0;
    ui.rxFileInfo.textContent = 'waiting for a START frame';
    ui.rxResult.textContent = '';
    ui.dlResult.disabled = true;
    ui.sFrames.textContent = '0 / 0';
    ui.sFix.textContent = ui.sSnr.textContent = ui.sBal.textContent = ui.sCorr.textContent = '–';
  }
  ui.reset.addEventListener('click', () => { rxReset(); log.add('receiver reset', 'info'); });

  ui.dlResult.addEventListener('click', () => { if (rx.result) download(rx.result.bytes, rx.result.name || 'received.bin'); });

  // Microphone.
  async function listen() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      log.add('no getUserMedia here: open the page via http://localhost or https', 'bad');
      return;
    }
    const c = await getContext();
    try {
      rx.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) { log.add('microphone: ' + e.message, 'bad'); return; }
    const track = rx.stream.getAudioTracks()[0];
    const st = track.getSettings ? track.getSettings() : {};
    ui.micInfo.textContent = `mic: ${track.label || 'unknown'} | AEC ${st.echoCancellation} NS ${st.noiseSuppression} AGC ${st.autoGainControl} | ${st.sampleRate || '?'} Hz into a ${c.sampleRate} Hz context`;
    if (st.echoCancellation || st.noiseSuppression || st.autoGainControl) {
      log.add('the browser kept some mic processing on; same-laptop tests may fail, two laptops are usually fine', 'bad');
    }
    rxStart({ fs: c.sampleRate, source: 'mic' });
    rx.srcNode = c.createMediaStreamSource(rx.stream);
    rx.proc = c.createScriptProcessor(4096, 1, 1);
    rx.mute = c.createGain();
    rx.mute.gain.value = 0;                        // Chrome needs the processor wired to the output to run it
    rx.srcNode.connect(rx.proc);
    rx.proc.connect(rx.mute);
    rx.mute.connect(c.destination);
    rx.proc.onaudioprocess = (e) => {
      const chunk = new Float32Array(e.inputBuffer.getChannelData(0));   // copy: the buffer is reused
      if (rx.lastTime !== null && e.playbackTime - rx.lastTime > e.inputBuffer.duration * 1.5) {
        rx.drops++;
        ui.sDrops.textContent = String(rx.drops);
      }
      rx.lastTime = e.playbackTime;
      feed(chunk);
    };
    ui.listen.disabled = true; ui.stopListen.disabled = false;
    keepAwake(true);
  }

  function stopListen() {
    if (rx.proc) { rx.proc.onaudioprocess = null; rx.proc.disconnect(); }
    if (rx.srcNode) rx.srcNode.disconnect();
    if (rx.mute) rx.mute.disconnect();
    if (rx.stream) rx.stream.getTracks().forEach((t) => t.stop());
    rx.proc = rx.srcNode = rx.mute = rx.stream = null;
    if (rx.active === 'mic') rx.active = null;
    ui.listen.disabled = false; ui.stopListen.disabled = true;
    ui.micInfo.textContent = 'mic off';
    keepAwake(false);
    log.add('mic stopped', 'info');
  }

  ui.listen.addEventListener('click', () => listen().catch((e) => log.add('listen: ' + e.message, 'bad')));
  ui.stopListen.addEventListener('click', stopListen);

  // Recording what the mic heard, for offline replay and for test fixtures.
  const REC_MAX_SEC = 600;
  function record(chunk) {
    if (rx.recSamples + chunk.length > REC_MAX_SEC * rx.fs) {
      rx.recording = false; ui.record.checked = false;
      log.add('recording stopped at ' + REC_MAX_SEC / 60 + ' minutes', 'info');
      return;
    }
    rx.chunks.push(chunk);
    rx.recSamples += chunk.length;
    ui.dlRec.disabled = false;
  }
  ui.record.addEventListener('change', () => {
    rx.recording = ui.record.checked;
    if (rx.recording) { rx.chunks = []; rx.recSamples = 0; rx.recFs = rx.fs || 48000; ui.dlRec.disabled = true; log.add('recording', 'info'); }
  });
  ui.dlRec.addEventListener('click', () => {
    const all = new Float32Array(rx.recSamples);
    let off = 0;
    for (const c of rx.chunks) { all.set(c, off); off += c.length; }
    download(DSP.wavEncode(all, rx.recFs), 'mic-' + rx.recFs + '.wav', 'audio/wav');
  });

  // Offline path: decode a WAV file at its own sample rate.
  ui.rxWav.addEventListener('change', async () => {
    const f = ui.rxWav.files[0];
    if (!f) return;
    let wav;
    try { wav = DSP.wavDecode(await f.arrayBuffer()); } catch (e) { log.add('WAV: ' + e.message, 'bad'); return; }
    if (rx.active === 'mic') stopListen();
    rxStart({ fs: wav.fs, source: `wav ${f.name} (${wav.channels} ch, ${wav.bits} bit, ${fmtTime(wav.samples.length / wav.fs)})` });
    const step = 4096;
    for (let off = 0, i = 0; off < wav.samples.length && rx.active; off += step, i++) {
      feed(wav.samples.subarray(off, Math.min(wav.samples.length, off + step)));
      if (i % 32 === 0) await sleep(0);
    }
    log.add('WAV done', 'info');
    rx.active = null;
    ui.rxWav.value = '';
  });

  // ---------------------------------------------------------------- self-test

  // ?listen starts the microphone on load, for headless runs with a fake
  // capture device. ?selftest runs a digital loopback of a generated file and
  // reports in the title, so a headless browser can check the in-page pipeline.
  const params = new URLSearchParams(location.search);
  if (params.get('preset') && Modem.PRESETS[params.get('preset')]) ui.preset.value = params.get('preset');
  window.modemDebug = { tx, rx, meter, spec, plot };   // poke at state from the console
  if (location.search.includes('listen')) {
    listen().catch((e) => log.add('listen: ' + e.message, 'bad'));
  }
  if (location.search.includes('selftest')) {
    const bytes = new Uint8Array(700).map((_, i) => (i * 31 + 7) & 0xFF);
    setTxFile('selftest.bin', bytes);
    loopback().then(() => {
      const r = rx.result;
      let ok = !!r && r.crcOk && r.bytes.length === bytes.length;
      if (ok) for (let i = 0; i < bytes.length; i++) if (r.bytes[i] !== bytes[i]) { ok = false; break; }
      document.title = 'SELFTEST ' + (ok ? 'PASS' : 'FAIL');
      const el = document.createElement('div');
      el.id = 'selftest'; el.textContent = document.title;
      document.body.appendChild(el);
    });
  }
})();
