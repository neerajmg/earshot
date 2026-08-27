#!/usr/bin/env node
// Listens on the microphone for a transmission and writes the file out.
//
// A terminal alternative to the receive page, for when the sound is coming
// from another device (a phone playing a rendered WAV, say) and you just want
// the answer. Needs ffmpeg.
//
//   node tools/listen.js [robust|fast] [--seconds 120] [--out received.bin] [--keep rec.wav]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');

const FFT = require('../fft.js');
const Air = require('../air.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ofdm = args.includes('--ofdm');
const passphrase = opt('--pass', undefined);
const preset = Modem.PRESETS[args.find((a) => Modem.PRESETS[a]) || 'robust'];
const seconds = Number(opt('--seconds', 120));
const outPath = opt('--out', null);
const keepPath = opt('--keep', null);
const FSR = 48000;

let mic = process.env.MIC_INDEX;
if (!mic) {
  const list = execFileSync('sh', ['-c', 'ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 || true']).toString();
  const m = list.match(/\[(\d+)\] (?:MacBook.*Microphone|Built-in Microphone)/);
  if (!m) { console.error('could not find the built-in microphone; set MIC_INDEX. Devices:\n' + list); process.exit(2); }
  mic = m[1];
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modem-listen-'));
const rec = path.join(work, 'rec.wav');
console.log(ofdm
  ? `listening on mic :${mic} for ${seconds} s, engine ofdm (1500-7500 Hz)`
  : `listening on mic :${mic} for ${seconds} s, preset ${preset.name} (${preset.spaceHz}/${preset.markHz} Hz at ${preset.baud} baud)`);
console.log('play the WAV on the other device now; Ctrl-C stops early\n');

// ffmpeg writes the WAV as it goes; we decode it once it stops.
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', ':' + mic,
  '-t', String(seconds), '-ac', '1', '-ar', String(FSR), '-sample_fmt', 's16', rec], { stdio: 'inherit' });

let done = false;
function finish() {
  if (done) return;
  done = true;
  setTimeout(() => {
    let buf;
    try { buf = fs.readFileSync(rec); } catch (e) { console.error('nothing was recorded'); process.exit(1); }
    const wav = DSP.wavDecode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    let peak = 0; for (const v of wav.samples) if (Math.abs(v) > peak) peak = Math.abs(v);
    console.log(`\nheard ${(wav.samples.length / wav.fs).toFixed(1)} s, peak ${peak.toFixed(3)}`);
    if (peak < 0.005) console.log('almost silent: is the other device actually playing, and loud enough?');
    if (ofdm) {
      (async () => {
        let x = wav.samples;
        if (wav.fs !== Air.FS) x = FFT.sincResample(x, wav.fs, Air.FS);
        const arx = new Air.Receiver(Air.FS, {
          onFrame: (f) => console.log(`frame: droplets ${f.stats.droplets}, bad ${f.stats.dropletCrcFail}` +
            (f.manifest ? `, ${f.manifest.name} ${(f.progress * 100).toFixed(0)} %` : ', no manifest yet')),
        });
        for (let o = 0; o < x.length; o += 4096) arx.push(x.subarray(o, Math.min(x.length, o + 4096)));
        console.log('stats:', JSON.stringify(arx.stats));
        if (keepPath) { fs.copyFileSync(rec, keepPath); console.log('recording kept as ' + keepPath); }
        if (!arx.result) { console.log('transfer incomplete'); fs.rmSync(work, { recursive: true, force: true }); process.exit(1); }
        console.log(`complete: ${arx.result.manifest.name}, CRC ${arx.result.crcOk ? 'ok' : 'BAD'}` + (arx.needsPassphrase() ? ', encrypted' : ''));
        try {
          const f = await arx.file({ passphrase });
          const dest = outPath || f.name || 'received.bin';
          fs.writeFileSync(dest, f.bytes);
          console.log('wrote ' + dest + ' (' + f.bytes.length + ' bytes)');
          const text = Buffer.from(f.bytes).toString('utf8');
          if (!/[\x00-\x08\x0E-\x1F]/.test(text)) console.log('\n--- contents ---\n' + text);
          fs.rmSync(work, { recursive: true, force: true });
          process.exit(0);
        } catch (e) {
          console.log(e.message);
          fs.rmSync(work, { recursive: true, force: true });
          process.exit(1);
        }
      })();
      return;
    }
    const rx = new Modem.Receiver();
    const demod = new DSP.Demodulator(preset, wav.fs, {
      onSync: (s) => console.log(`${(s.t0 / wav.fs).toFixed(2).padStart(7)} s  sync  corr ${s.corr.toFixed(2)}  sync errors ${s.syncErrors}  SNR ${s.snrDb.toFixed(1)} dB  balance ${s.balanceDb.toFixed(1)} dB`),
      onFrame: (f) => {
        const d = Modem.bitsToFrame(f.bits);
        const r = rx.accept(d.raw);
        const ok = r.kind !== 'crcfail' && r.kind !== 'bad';
        console.log(`${(f.t0 / wav.fs).toFixed(2).padStart(7)} s  frame ${r.kind}${r.seq !== undefined ? ' ' + r.seq : ''}  fixed ${d.corrected}  uncorrectable ${d.uncorrectable}`);
        return ok;
      },
    });
    for (let o = 0; o < wav.samples.length; o += 4096) demod.push(wav.samples.subarray(o, Math.min(wav.samples.length, o + 4096)));
    console.log(`\nsyncs ${demod.stats.syncs}, rejected ${demod.stats.falseSyncs}, frames ${demod.stats.frames}, ok ${demod.stats.framesOk}`);
    if (keepPath) { fs.copyFileSync(rec, keepPath); console.log('recording kept as ' + keepPath); }
    if (rx.meta) {
      const got = rx.assemble();
      console.log(`file ${rx.meta.name}: ${rx.meta.totalFrames - rx.missing()} / ${rx.meta.totalFrames} frames, CRC-32 ${got.crcOk ? 'ok' : 'not matching'}`);
      if (got.crcOk) {
        const dest = outPath || rx.meta.name || 'received.bin';
        fs.writeFileSync(dest, got.bytes);
        console.log('wrote ' + dest);
        const text = Buffer.from(got.bytes).toString('utf8');
        if (!/[\x00-\x08\x0E-\x1F]/.test(text)) console.log('\n--- contents ---\n' + text);
      }
    } else {
      console.log('no START frame seen');
    }
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(rx.isComplete() ? 0 : 1);
  }, 600);
}
ff.on('exit', finish);
process.on('SIGINT', () => { try { process.kill(ff.pid, 'SIGKILL'); } catch (e) { /* gone */ } });
