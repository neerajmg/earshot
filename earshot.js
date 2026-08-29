// earshot.js -- the product page. Moves bytes between the UI, the Web Audio
// graph, and the worker; all signal processing lives in the worker (receive)
// or air.js (send). The only arithmetic here is a level meter's worth of RMS,
// which is what tells "listening" apart from "nothing is happening".

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {};
  for (const id of ['drop', 'file', 'dropText', 'fileInfo', 'txPass', 'send', 'stopSend', 'txProgress', 'txStatus',
    'sample', 'txText', 'sendText', 'benchmarks', 'txPassNote', 'sendingHint',
    'listen', 'stopListen', 'rxProgress', 'rxStatus', 'result', 'resultName', 'resultText', 'passRow', 'rxPass', 'unlock', 'save',
    'resultStatus', 'advanced', 'engineInfo', 'spec', 'log']) ui[id] = $(id);

  const log = new Diag.Log(ui.log, 250);
  const spec = new Diag.Spectrogram(ui.spec, { maxHz: 8000 });
  const specDraw = { draw: () => { if (ui.advanced.open) spec.draw(); } };
  Diag.loop([specDraw], 10);

  const FS = 48000;
  const FRAME_SEC = Air.FRAME_SEC;
  const MAX_BYTES = 2 * 1048576;

  // One formula for every estimate on the page, and it lives in air.js beside
  // the frame it describes, so the numbers cannot drift from the code. The
  // extra second is the lead-in before the first frame plays.
  const framesFor = (bytes) => Air.framesFor(bytes);
  function secondsFor(bytes) { return Air.secondsFor(bytes) + 1; }

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

  // Every status line goes through this. What it prints is data - a file name
  // that arrived over the air, a browser's error string - so it is written as
  // text and never as markup. #txStatus, #rxStatus and #resultStatus are
  // aria-live, and a screen reader reads them out on every write, so an
  // unchanged line is not written again.
  function say(el, text, cls) {
    const had = el.firstElementChild ? el.firstElementChild.className : '';
    if (el.textContent === text && had === (cls || '')) return;
    el.textContent = '';
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    el.appendChild(s);
  }
  const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  // Neither passphrase box is ever trimmed - trimming changes the secret.
  // This only asks whether what was typed is nothing but whitespace.
  const blank = (v) => v !== '' && String(v).trim() === '';

  // A passphrase is never trimmed on either side - trimming changes the
  // secret, and a phone keyboard adds a trailing space readily. Say what is
  // there instead and let the person decide.
  // Zero-width and other invisible characters ride along in text pasted from
  // a chat app. They change the key and show nothing, so the two people
  // compare passphrases that look identical and never agree.
  const INVISIBLE = /[\u200B-\u200D\u2060\u00AD\uFEFF]/;

  function spaceEdges(v) {
    if (!v) return '';
    if (INVISIBLE.test(v)) return 'contains an invisible character, probably from copy and paste';
    const lead = /^\s/.test(v), trail = /\s$/.test(v);
    return lead && trail ? 'starts and ends with a space' : lead ? 'starts with a space' : trail ? 'ends with a space' : '';
  }

  let ctx = null;
  // On iOS a page's audio starts in an "ambient" session, and ambient audio
  // is silenced by the ring/silent switch. Web Audio then produces nothing
  // at all: the transfer plays perfectly and the room hears silence. Saying
  // what the audio is for moves it out of ambient. 'playback' is the one
  // that survives the switch; 'play-and-record' is what the microphone
  // needs. earshot never does both at once on one device, so the role picks
  // the type.
  let sessionType = null;
  function claimAudio(role) {
    const want = role === 'listen' ? 'play-and-record' : 'playback';
    try {
      if (navigator.audioSession) { navigator.audioSession.type = want; sessionType = want; return; }
    } catch (e) { /* fall through to the older trick */ }
    sessionType = null;
    // Safari before 16.4 has no audioSession. An <audio> element does play
    // through the silent switch, and starting one promotes the session so
    // Web Audio is heard too. It must start inside the user's gesture.
    if (role !== 'listen') unmute();
  }

  // A tenth of a second of silence, as a real WAV. An <audio> element needs
  // actual samples: a zero-length data chunk ends immediately and never
  // loops, which is the whole point here.
  function silentWavUrl() {
    const n = 4410, bytes = 44 + n * 2;
    const b = new ArrayBuffer(bytes), v = new DataView(b);
    const tag = (o, t) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    tag(0, 'RIFF'); v.setUint32(4, bytes - 8, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  }

  let unmuter = null;
  function unmute() {
    try {
      if (!unmuter) {
        unmuter = new Audio(silentWavUrl());
        unmuter.loop = true;
        unmuter.setAttribute('playsinline', '');
        unmuter.volume = 0.01;
      }
      const p = unmuter.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* nothing more to try */ }
  }

  async function ensureCtx(role) {
    claimAudio(role);
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { ctx = new AC({ sampleRate: FS }); } catch (e) { ctx = new AC(); }
    }
    if (ctx.state !== 'running') await ctx.resume();
    ui.engineInfo.textContent = `audio ${ctx.sampleRate} Hz` + (ctx.sampleRate !== FS ? ` (resampling to ${FS})` : '')
      + ` | session ${sessionType || 'not settable on this browser'} | ${ctx.state}`;
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

  const tx = { file: null, sender: null, playing: false, starting: false, done: 0, sources: new Set(), queue: [], rs: null, nextTime: 0, estFrames: 0, timer: null, quote: 0 };

  // The drop zone's own markup, kept so a rejected file can put it back.
  const dropDefault = ui.dropText.cloneNode(true);
  function resetDropText() { ui.dropText.replaceChildren(...dropDefault.cloneNode(true).childNodes); }

  function showPicked(icon, name, hint) {
    ui.dropText.textContent = '';
    const i = document.createElement('span');
    i.setAttribute('aria-hidden', 'true');
    i.textContent = icon;
    ui.dropText.append(i, ' ' + name);                 // a file name is text, not markup
    ui.dropText.appendChild(document.createElement('br'));
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = hint;
    ui.dropText.appendChild(h);
  }

  // Nothing is selected and nothing can be sent: the state a refused file
  // must leave behind, or the old file goes out under the refusal.
  function clearFile(message) {
    tx.file = null;
    ui.file.value = '';
    ui.send.disabled = true;
    resetDropText();
    if (message) say(ui.fileInfo, message, 'bad');
    else ui.fileInfo.textContent = '';
  }

  function pickFile(f) {
    if (!f) return;
    if (tx.playing || tx.starting) return;             // a send owns the file until it stops
    if (f.size > MAX_BYTES) { clearFile('Over 2 MB — sound is too slow for a file that big. Send something smaller, or zip it first.'); return; }
    tx.file = f;
    showPicked('📄', f.name, 'Choose a different file');
    ui.fileInfo.textContent = `${fmtBytes(f.size)} — working out how long that takes…`;
    ui.send.disabled = false;
    quoteFile();
  }

  // What the transfer will really cost. Air.estimate compresses exactly as
  // Air.prepare will, so the number here is the number that plays; the page
  // used to quote the raw size and promise three times the airtime a text
  // file needs. It is async, and the passphrase changes the answer, so a
  // token drops the answer to a file that is no longer the chosen one.
  async function quoteFile() {
    if (!tx.file) return;
    const f = tx.file, token = ++tx.quote;
    try {
      const pass = ui.txPass.value;
      const est = await Air.estimate(new Uint8Array(await f.arrayBuffer()),
        pass && !blank(pass) ? { passphrase: pass, name: f.name } : undefined);
      if (token !== tx.quote || tx.file !== f) return;
      ui.fileInfo.textContent = `${fmtBytes(f.size)} — about ${fmtTime(est.seconds + 1)} of sound`
        + (est.gzipped ? ` (${fmtBytes(est.bytes)} on air after compression).` : '.');
    } catch (e) {
      if (token !== tx.quote || tx.file !== f) return;
      ui.fileInfo.textContent = `${fmtBytes(f.size)} — about ${fmtTime(secondsFor(f.size))} of sound; less if it compresses.`;
    }
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
      tr.innerHTML = `<td>${label}</td><td>${fmtTime(secondsFor(bytes))}</td>`;
      tb.appendChild(tr);
    }
  })();
  // Where the note goes is the page's business; if the page has no room for
  // one, the send status carries it.
  const txNote = ui.txPassNote || ui.txStatus;
  ui.txPass.addEventListener('input', () => {
    const edge = spaceEdges(ui.txPass.value);
    if (blank(ui.txPass.value)) {
      say(txNote, 'That passphrase is only spaces. Clear the field to send without one.', 'bad');
    } else if (edge) {
      say(txNote, `This passphrase ${edge}. It is used exactly as typed, so the other device needs that space too.`, 'bad');
    } else {
      txNote.textContent = '';
    }
    quoteFile();                                       // encryption changes the airtime
  });
  ui.file.addEventListener('change', () => pickFile(ui.file.files[0]));
  ui.drop.addEventListener('dragover', (e) => { e.preventDefault(); ui.drop.classList.add('hover'); });
  ui.drop.addEventListener('dragleave', () => ui.drop.classList.remove('hover'));
  ui.drop.addEventListener('drop', (e) => { e.preventDefault(); ui.drop.classList.remove('hover'); pickFile(e.dataTransfer.files[0]); });

  // Everything that would start a second transmission, or change what is
  // being sent, is off while sound is in the air.
  function sendBusy(busy) {
    ui.sample.disabled = busy;
    ui.file.disabled = busy;
    ui.txText.disabled = busy;
    ui.sendText.disabled = busy;
    ui.txPass.disabled = busy;
    // A class, not inline styles: index.html's .busy rule owns what busy
    // looks like, and inline pointer-events fought .drop:focus-within.
    ui.drop.classList.toggle('busy', busy);
    document.body.classList.toggle('sending', busy);
  }

  // The passphrase field belongs to the file group; a typed message is sent
  // plain, which is what its placeholder says.
  async function startSend(opts) {
    // The guard and the disabling both happen before the first await: two
    // quick clicks would otherwise both get through and put two senders,
    // and two timers, on the air at once.
    if (tx.playing || tx.starting) return;
    if (!tx.file) { say(ui.txStatus, 'Choose a file first.', 'bad'); return; }
    if (rx.listening || rx.starting) {
      say(ui.txStatus, 'This device is listening, so it would hear its own speaker. Stop listening here and listen on the other device.', 'bad');
      return;
    }
    // Exactly what was typed: trimming here would encrypt under one string
    // while the person on the other device types another.
    const pass = (opts && opts.plain) ? '' : ui.txPass.value;
    if (blank(pass)) {
      say(ui.txStatus, 'That passphrase is only spaces. Clear the field to send without one, or type a passphrase you can repeat to the other person.', 'bad');
      return;
    }
    tx.starting = true;
    ui.send.disabled = true;
    sendBusy(true);
    say(ui.txStatus, 'Getting the file ready…');
    try {
      const c = await ensureCtx('send');
      const bytes = new Uint8Array(await tx.file.arrayBuffer());
      const prep = await Air.prepare(bytes, tx.file.name, pass ? { passphrase: pass } : undefined);
      tx.sender = new Air.Sender(prep);
      tx.estFrames = framesFor(prep.payload.length);
      // One resampler for the whole transmission, not one per frame: it
      // carries the fractional phase and the filter tail across frame
      // boundaries, so a 44.1 kHz output hears the same stream a 48 kHz one
      // would, resampled once.
      tx.rs = c.sampleRate !== FS ? new FFT.Resampler(FS, c.sampleRate) : null;
      tx.queue = [];
      tx.playing = true; tx.done = 0;
      tx.nextTime = c.currentTime + 0.2;
      ui.send.style.display = 'none'; ui.stopSend.style.display = '';
      ui.txProgress.style.display = ''; ui.txProgress.value = 0;
      keepAwake(true);
      log.add(`sending ${tx.file.name}: ${fmtBytes(bytes.length)} -> ${fmtBytes(prep.payload.length)} on air` + (prep.flags & Air.F_ENCRYPTED ? ', encrypted' : ''), 'info');
      prerender();
      schedule();
      clearInterval(tx.timer);
      tx.timer = setInterval(() => { prerender(); schedule(); txProgress(); }, 300);
      txProgress();
    } catch (e) {
      tx.playing = false;
      clearInterval(tx.timer); tx.timer = null;
      tx.queue.length = 0; tx.rs = null;
      sendBusy(false);
      ui.send.style.display = ''; ui.stopSend.style.display = 'none';
      ui.send.disabled = !tx.file;
      ui.txProgress.style.display = 'none';
      say(ui.txStatus, sentence(e.message) || 'Could not start sending.', 'bad');
      log.add('send failed: ' + (e && e.message), 'bad');
    } finally {
      tx.starting = false;
    }
  }

  // Modulating a frame costs milliseconds and resampling it more. Both used
  // to happen inside src.onended, on the UI thread, every 2 s. Now they
  // happen on the 300 ms timer, ahead of the frame being needed, and the
  // ended callback only hands the next prepared buffer to the audio graph.
  function renderFrame() {
    let samples = tx.sender.nextFrame();
    if (tx.rs) samples = tx.rs.process(samples);
    if (!samples.length) return;
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.copyToChannel(samples, 0);
    tx.queue.push(buf);
  }

  function prerender() {
    if (!tx.playing) return;
    while (tx.queue.length + tx.sources.size < 3) {
      const before = tx.queue.length;
      renderFrame();
      if (tx.queue.length === before) return;
    }
  }

  function schedule() {
    if (!tx.playing) return;
    while (tx.sources.size < 3) {
      if (!tx.queue.length) {                          // underrun: a late frame beats a gap
        const before = tx.queue.length;
        renderFrame();
        if (tx.queue.length === before) return;
      }
      const buf = tx.queue.shift();
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination);
      if (tx.nextTime < ctx.currentTime) tx.nextTime = ctx.currentTime + 0.05;
      src.start(tx.nextTime);
      tx.nextTime += buf.duration;
      tx.sources.add(src);
      src.onended = () => { tx.sources.delete(src); tx.done++; schedule(); };
    }
  }

  function txProgress() {
    if (!tx.playing) return;
    if (tx.done < tx.estFrames) {
      ui.txProgress.value = tx.done / tx.estFrames;
      say(ui.txStatus, `Sending — ${Math.round(100 * tx.done / tx.estFrames)} %, about ${fmtTime((tx.estFrames - tx.done) * FRAME_SEC)} left. Keep both devices still.`);
      return;
    }
    // Past the estimate there is nothing left to measure: a lossy room needs
    // more sound than the formula, and only the receiver knows when it has
    // enough. A bar with no value says exactly that.
    ui.txProgress.removeAttribute('value');
    say(ui.txStatus, 'Still sending — keep going until the other device says it has the file, then press Stop sending.');
  }

  function stopSend() {
    tx.playing = false;
    clearInterval(tx.timer); tx.timer = null;
    for (const s of tx.sources) { s.onended = null; try { s.stop(); } catch (e) { /* stopped */ } }
    tx.sources.clear();
    tx.queue.length = 0;
    tx.rs = null;
    sendBusy(false);
    ui.send.style.display = ''; ui.send.disabled = !tx.file;
    ui.stopSend.style.display = 'none';
    ui.txProgress.value = Math.min(1, tx.done / (tx.estFrames || 1));
    say(ui.txStatus, `Stopped after ${fmtTime(tx.done * FRAME_SEC)} of sound.`);
    keepAwake(false);
  }
  ui.send.addEventListener('click', () => { startSend(); });
  // Enter in the passphrase field does what the button under it does.
  ui.txPass.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ui.send.disabled) { e.preventDefault(); ui.send.click(); } });
  ui.stopSend.addEventListener('click', stopSend);

  // A typed message travels as a small text file named message.txt; the
  // receiver shows text files inline.
  ui.sendText.addEventListener('click', () => {
    if (tx.playing || tx.starting) { say(ui.txStatus, 'Already sending — press Stop sending first.', 'bad'); return; }
    const text = ui.txText.value;
    if (!text.trim()) { say(ui.txStatus, 'Type a message first.', 'bad'); return; }
    // A typed message goes out unencrypted, by design. Dropping a typed
    // passphrase without a word would be the worst of both.
    if (ui.txPass.value !== '') {
      say(ui.txStatus, 'A message is sent without a passphrase. Clear the passphrase field to send this message, or save the text as a file and use Start sending.', 'bad');
      return;
    }
    tx.file = new File([new TextEncoder().encode(text)], 'message.txt', { type: 'text/plain' });
    showPicked('💬', 'message.txt', 'from the message box');
    ui.fileInfo.textContent = `${fmtBytes(tx.file.size)} — about ${fmtTime(secondsFor(tx.file.size))} of sound.`;
    startSend({ plain: true });
  });

  // --------------------------------------------------------------- receive

  const rx = {
    worker: null, stream: null, node: null, srcNode: null, proc: null, mute: null,
    listening: false, starting: false, cancelled: false,
    lastQuanta: 0, drops: 0,
    fileBytes: null, fileName: null, lastPass: '', stats: null,
    complete: null,                                    // last good completion; tools/make-guide.js waits on it
    receiving: false, damaged: false, locked: false, progress: 0,
    sumSq: 0, samples: 0, level: 0, lastSound: 0,
    droplets: 0, dropletCrcFail: 0, seenFrames: 0, seenOk: 0, roughFrames: 0,
    hintTimer: null,
  };

  const RX_SOUND = 0.01;                               // RMS that counts as "something is playing", about -40 dBFS
  const RX_QUIET_MS = 10000;                           // silence the page is willing to sit through without saying so

  // Nothing downstream of here can recover on its own, so say what broke
  // instead of sitting on "Listening…" forever, and drop the worker so the
  // next Listen builds a fresh one.
  function receiverFailed(text) {
    log.add(text, 'bad');
    say(ui.rxStatus, text + ' — reload the page and try again.', 'bad');
    stopListen();
    if (rx.worker) { try { rx.worker.terminate(); } catch (e) { /* already gone */ } rx.worker = null; }
  }

  function ensureWorker() {
    if (rx.worker) return rx.worker;
    rx.worker = new Worker('worker.js');
    rx.worker.onerror = (e) => receiverFailed('The receiver failed to start: ' + ((e && e.message) || 'worker.js did not load'));
    rx.worker.onmessageerror = () => receiverFailed('The receiver sent something the page could not read');
    rx.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'frame') onFrame(m);
      else if (m.type === 'stats') onStats(m);
      else if (m.type === 'complete') onComplete(m);
      else if (m.type === 'failed') onFailed(m);
      else if (m.type === 'file') onFile(m);
      else if (m.type === 'error') receiverFailed('The receiver stopped: ' + m.message);
      else if (m.type === 'fileError') {
        // A stray space is the likeliest reason a passphrase both people
        // believe in still fails, so say so rather than trimming it away.
        const edge = /wrong passphrase/i.test(m.message) ? spaceEdges(rx.lastPass) : '';
        say(ui.resultStatus, sentence(m.message) + (edge ? ` What you typed ${edge}, and it is used exactly as typed.` : ''), 'bad');
        if (m.needsPassphrase) ui.passRow.style.display = '';
      }
    };
    rx.worker.postMessage({ type: 'init', fs: FS });
    return rx.worker;
  }

  // A second transfer into the same page: the worker still holds the first
  // file's manifest and a full set of droplets, so without this a repeat of
  // the same file sits at 100 % and never completes.
  function resetReceive() {
    ensureWorker().postMessage({ type: 'reset', fs: FS });
    rx.fileBytes = null; rx.fileName = null; rx.complete = null; rx.lastPass = '';
    rx.receiving = false; rx.damaged = false; rx.progress = 0;
    rx.droplets = 0; rx.dropletCrcFail = 0; rx.seenFrames = 0; rx.seenOk = 0; rx.roughFrames = 0;
    rx.sumSq = 0; rx.samples = 0; rx.lastSound = Date.now();
    ui.result.classList.remove('show');
    ui.resultName.textContent = '';
    ui.resultStatus.textContent = '';
    ui.resultText.textContent = ''; ui.resultText.style.display = 'none';
    ui.passRow.style.display = 'none'; ui.rxPass.value = '';
    ui.save.style.display = 'none';
    ui.rxProgress.value = 0; ui.rxProgress.style.display = 'none';
  }

  function onFrame(m) {
    rx.receiving = true;
    // A damaged assembly used to latch until a reset or a success, which
    // silenced the progress line and every "nothing heard" hint for the
    // rest of the session. The rebuild starts from nothing, so progress
    // going forwards again is the signal that it is under way.
    if (rx.damaged && m.progress > rx.progress) rx.damaged = false;
    rx.progress = m.progress;
    ui.rxProgress.style.display = '';
    ui.rxProgress.value = m.progress;
    if (!rx.damaged && !rx.fileBytes) {
      // The manifest's size is what travels - compressed, encrypted - not the
      // size of the file that comes out, so it is not shown as one. With a
      // passphrase the name is inside the ciphertext, so there is none yet.
      const what = m.manifest && m.manifest.nameHidden ? 'an encrypted file'
        : (m.manifest && m.manifest.name) || 'a file';
      say(ui.rxStatus, `Receiving ${what} — ${Math.round(m.progress * 100)} %`);
    }
    // The worker's counters are running totals; the log is per frame.
    const got = m.stats.droplets - rx.droplets;
    const bad = m.stats.dropletCrcFail - rx.dropletCrcFail;
    rx.droplets = m.stats.droplets; rx.dropletCrcFail = m.stats.dropletCrcFail;
    rx.seenFrames = m.stats.frames; rx.seenOk = m.stats.framesOk;
    rx.stats = m.stats;                                // tools/browser-e2e.js polls these
    rx.roughFrames = 0;
    log.add(got > 0
      ? `frame decoded — ${got} droplet${got === 1 ? '' : 's'}${bad ? `, ${bad} rejected` : ''}`
      : `frame decoded but nothing usable in it${bad ? ` — ${bad} droplets rejected` : ''}`,
    got > 0 ? undefined : 'bad');
  }

  // Frames the worker saw but could not use never reach onFrame, so the page
  // asks for the counters once a second. Frames climbing while good frames do
  // not is the sender being audible but unreadable.
  function onStats(m) {
    rx.stats = m.stats;                                // tools/browser-e2e.js polls these
    const newFrames = m.stats.frames - rx.seenFrames;
    const newOk = m.stats.framesOk - rx.seenOk;
    rx.seenFrames = m.stats.frames; rx.seenOk = m.stats.framesOk;
    if (newOk > 0) rx.roughFrames = 0;
    else if (newFrames > 0) rx.roughFrames += newFrames;
  }

  // air.js only calls onComplete when the file's CRC-32 checks out; a
  // failure arrives as 'failed' below. The crcOk test stays as a backstop
  // against an older worker.
  function onComplete(m) {
    if (m.crcOk === false) { onFailed(m); return; }
    rx.damaged = false;
    rx.complete = m;
    ui.result.classList.add('show');
    ui.resultName.textContent = `📄 ${m.nameHidden ? 'Encrypted file' : (m.name || 'Received file')}`;
    say(ui.rxStatus, 'The whole file arrived.', 'ok');
    if (m.needsPassphrase) {
      ui.passRow.style.display = '';
      ui.resultStatus.textContent = m.nameHidden
        ? 'The sender set a passphrase, and the file name is inside too. Type it to open the file.'
        : 'The sender set a passphrase. Type it to open the file.';
      ui.rxPass.focus();
    } else rx.worker.postMessage({ type: 'file' });
    stopListen();
  }

  // The whole file arrived and its CRC-32 says it is wrong. air.js threw the
  // windows away and is still listening, so the microphone stays open and
  // the sender's next pass can repair it.
  function onFailed(m) {
    rx.damaged = true;
    rx.progress = 0;
    ui.rxProgress.value = 0;
    say(ui.rxStatus, 'That arrived damaged — still listening. Leave the sender running and the missing pieces will come.', 'bad');
    log.add(`rebuilt file failed its checksum (attempt ${m.attempts || 1}) - windows dropped, still listening`, 'bad');
  }

  function onFile(m) {
    rx.fileBytes = new Uint8Array(m.bytes);
    rx.fileName = m.name;
    rx.locked = false;                                 // open now, not merely arrived
    ui.passRow.style.display = 'none';
    ui.save.style.display = '';
    // Only now is the real size known: what travelled was compressed and
    // possibly encrypted.
    ui.resultName.textContent = `📄 ${m.name || 'Received file'} — ${fmtBytes(rx.fileBytes.length)}`;
    say(ui.resultStatus, 'Ready to save.', 'ok');
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
  }

  // What a microphone failure means, in words someone can act on. The raw
  // browser string goes to the log instead.
  function micMessage(e) {
    switch (e && e.name) {
      case 'NotAllowedError':
        return 'The microphone is blocked for this page. Allow it — the padlock in the address bar — then press Listen again.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No microphone was found. Connect one, or choose one in the system sound settings, then press Listen again.';
      case 'NotReadableError':
        return 'Another app or tab is holding the microphone. Close it, then press Listen again.';
      case 'SecurityError':
      case 'InsecureContext':
        return 'The microphone needs a secure page. Open https://neerajmg.github.io/earshot/ on both devices rather than a local copy.';
      case 'AbortError':
        return 'The microphone closed before it opened. Press Listen again.';
      default:
        return `The microphone would not open (${(e && e.message) || 'no reason given'}). Check the browser's sound settings, then press Listen again.`;
    }
  }

  // Three things the receiver can say for itself, once a second, without
  // waiting for a frame to decode: it is quiet, it can hear the room, or it
  // can hear the sender and cannot read it.
  function rxTick() {
    if (!rx.listening) return;
    const rms = rx.samples ? Math.sqrt(rx.sumSq / rx.samples) : 0;
    rx.sumSq = 0; rx.samples = 0;
    rx.level = rms;
    const now = Date.now();
    if (rms > RX_SOUND) rx.lastSound = now;
    if (rx.worker) rx.worker.postMessage({ type: 'stats' });
    if (rx.damaged || rx.fileBytes || ui.passRow.style.display !== 'none') return;   // the result line owns the status
    const quiet = now - rx.lastSound;
    if (rx.receiving) {
      if (quiet > RX_QUIET_MS) say(ui.rxStatus, `${Math.round(rx.progress * 100)} % of the way there, but nothing heard for ${Math.round(quiet / 1000)} s — is the sender still playing?`);
      return;                                          // otherwise the frames own the status
    }
    if (quiet > RX_QUIET_MS) say(ui.rxStatus, `Listening — silence for ${Math.round(quiet / 1000)} s. Start the sender on the other device and turn its volume up.`);
    else if (rx.roughFrames >= 2) say(ui.rxStatus, 'Listening — the sender is audible but too rough to read. Move the devices closer, turn the volume up, quieten the room.');
    else if (rms > RX_SOUND) say(ui.rxStatus, 'Listening — sound is reaching the microphone, but nothing from earshot yet.');
    else say(ui.rxStatus, 'Listening… start the sender on the other device.');
  }

  async function startListen() {
    // Both guards are set before the first await. A second click while a
    // permission prompt is open would otherwise open a second stream, leave
    // the first running, and interleave two feeds into one Receiver.
    if (rx.listening || rx.starting) return;
    if (tx.playing || tx.starting) {
      say(ui.rxStatus, 'This device is sending, and it would only hear itself. Listen on the other device.', 'bad');
      return;
    }
    rx.starting = true;
    rx.cancelled = false;
    ui.listen.style.display = 'none'; ui.stopListen.style.display = '';
    say(ui.rxStatus, 'Asking for the microphone…');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const e = new Error('no microphone API on this page');
        e.name = 'InsecureContext';
        throw e;
      }
      const c = await ensureCtx('listen');
      // Keep a file that has arrived but is still locked. Mistyping a
      // passphrase and pressing Listen again is the natural recovery, and
      // it used to destroy the bytes: the sender then had to send the whole
      // file a second time.
      if (rx.locked && !rx.fileBytes) {
        say(ui.rxStatus, 'Still listening. The file that already arrived is kept — type its passphrase whenever you like.');
      } else {
        resetReceive();
      }
      // The worker resamples, with one resampler for the whole capture, so
      // the UI thread never touches the samples and no chunk boundary
      // truncates a filter kernel.
      rx.worker.postMessage({ type: 'rate', inputRate: c.sampleRate });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      if (rx.cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }   // Stop was pressed while the prompt was open
      rx.stream = stream;
      const st = stream.getAudioTracks()[0].getSettings ? stream.getAudioTracks()[0].getSettings() : {};
      ui.engineInfo.textContent = `audio ${c.sampleRate} Hz | mic AEC ${st.echoCancellation} NS ${st.noiseSuppression} AGC ${st.autoGainControl}`;
      const src = c.createMediaStreamSource(stream);
      const feed = (chunk, quanta) => {
        if (quanta !== undefined) {
          if (rx.lastQuanta && quanta - rx.lastQuanta > 40) { rx.drops++; log.add('audio gap', 'bad'); }
          rx.lastQuanta = quanta;
        }
        // One multiply-add per sample, read once a second: enough to tell a
        // silent room from a loud one, and cheap enough not to matter.
        let s = 0;
        for (let i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i];
        rx.sumSq += s; rx.samples += chunk.length;
        if (ui.advanced.open) spec.push(chunk);         // 48 000 columns a second, invisible while Advanced is shut
        const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
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
      rx.lastSound = Date.now();
      spec.reset(c.sampleRate);
      spec.setTones([1500, 7500]);
      clearInterval(rx.hintTimer);
      rx.hintTimer = setInterval(rxTick, 1000);
      say(ui.rxStatus, 'Listening… start the sender on the other device.');
      log.add(`listening (${worklet ? 'worklet' : 'script processor'})`, 'info');
      keepAwake(true);
    } catch (e) {
      stopListen();
      say(ui.rxStatus, micMessage(e), 'bad');
      log.add(`microphone: ${(e && e.name) || 'error'} - ${e && e.message}`, 'bad');
    } finally {
      rx.starting = false;
    }
  }

  function stopListen() {
    rx.cancelled = true;                               // a getUserMedia still in flight throws its stream away
    clearInterval(rx.hintTimer); rx.hintTimer = null;
    if (rx.node) { rx.node.port.onmessage = null; rx.node.disconnect(); rx.node = null; }
    if (rx.proc) { rx.proc.onaudioprocess = null; rx.proc.disconnect(); rx.proc = null; }
    if (rx.srcNode) { rx.srcNode.disconnect(); rx.srcNode = null; }
    if (rx.mute) { rx.mute.disconnect(); rx.mute = null; }
    if (rx.stream) { rx.stream.getTracks().forEach((t) => t.stop()); rx.stream = null; }
    rx.listening = false;
    ui.listen.style.display = ''; ui.stopListen.style.display = 'none';
    keepAwake(false);
  }
  ui.listen.addEventListener('click', () => { startListen(); });
  ui.stopListen.addEventListener('click', () => { stopListen(); say(ui.rxStatus, 'Stopped listening.'); });
  // Untrimmed, like the sender: the secret is what was typed.
  ui.unlock.addEventListener('click', () => {
    rx.lastPass = ui.rxPass.value;
    if (rx.worker) rx.worker.postMessage({ type: 'file', passphrase: rx.lastPass });
  });
  ui.rxPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ui.unlock.click(); } });

  async function saveFile() {
    if (!rx.fileBytes) return;
    const file = new File([rx.fileBytes], rx.fileName || 'received.bin', { type: 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        say(ui.resultStatus, `Handed to whatever you picked. ${file.name} is still here if you need it again.`, 'ok');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') { say(ui.resultStatus, 'Sharing cancelled — the file is still here.'); return; }
        log.add('share failed: ' + (e && e.message) + ' - falling back to a download', 'bad');
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say(ui.resultStatus, `Saved as ${file.name} — look wherever this browser puts downloads.`, 'ok');
  }
  ui.save.addEventListener('click', saveFile);

  // -------------------------------------------------------------- harness

  window.earshotDebug = { tx, rx, get fileBytes() { return rx.fileBytes; } };

  const params = new URLSearchParams(location.search);
  if (params.has('listen')) startListen();

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
