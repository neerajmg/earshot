// worker.js -- the receive engine, meant for a dedicated Worker so a
// 40-minute transfer cannot be starved by rendering. The DSP core is
// createWorkerCore(post), a pure function of messages in and messages out,
// so Node tests drive it without a Worker; the importScripts glue at the
// bottom only runs inside a real one.
//
// Messages in:  {type:'init', fs, inputRate?}
//               {type:'rate', inputRate}             (capture rate; resample here)
//               {type:'push', buf: ArrayBuffer}      (Float32 samples at inputRate)
//               {type:'file', passphrase?}           (after 'complete')
//               {type:'reset', fs?, inputRate?}
//               {type:'stats'}                       (poll while listening)
// Messages out: {type:'frame', sig, manifest, stats, progress}
//               {type:'stats', stats, progress}
//               {type:'complete', name, size, crcOk, needsPassphrase, nameHidden}
//               {type:'failed', name, size, attempts, recovering, stats}
//               {type:'file', name, bytes: ArrayBuffer} | {type:'fileError', message, needsPassphrase}
//               {type:'status', ...}
//               {type:'error', message, where}       (nothing more will arrive)

(function (root) {
  'use strict';

  function createWorkerCore(post) {
    const Air = root.Air;
    const FFT = root.FFT;
    let rx = null;
    let fs = Air.FS;
    let rs = null;                                   // capture-rate -> fs, stateful

    // A device that will not give us 48 kHz hands over 44.1 kHz (or whatever
    // it has) and the samples are resampled here, on the worker thread, by
    // one resampler for the whole capture. Per-chunk resampling truncated the
    // filter kernel at both ends of every chunk and lost a fraction of a
    // sample per chunk to rounding.
    function setRate(inputRate) {
      rs = inputRate && inputRate !== fs ? new FFT.Resampler(inputRate, fs) : null;
    }

    return async function onMessage(msg) {
      try {
        await handle(msg);
      } catch (e) {
        // A worker that throws here goes silent and the page waits forever.
        post({ type: 'error', message: (e && e.message) || String(e), where: msg && msg.type });
      }
    };

    async function handle(msg) {
      switch (msg.type) {
        case 'init':
        case 'reset':
          fs = msg.fs || Air.FS;
          setRate(msg.inputRate);
          rx = new Air.Receiver(fs, {
            onFrame: (f) => post({
              type: 'frame',
              sig: { session: f.sig.session, profile: f.sig.profile },
              manifest: f.manifest ? { name: f.manifest.name, size: f.manifest.size, flags: f.manifest.flags, winCount: f.manifest.winCount, nameHidden: !!(f.manifest.flags & Air.F_NAME_INSIDE) } : null,
              stats: f.stats,
              progress: f.progress,
            }),
            onComplete: (r) => post({
              type: 'complete',
              name: r.manifest.name,
              size: r.manifest.size,
              crcOk: r.crcOk,
              needsPassphrase: !!(r.manifest.flags & Air.F_ENCRYPTED),
              // The name is inside the ciphertext: there is nothing to call
              // this transfer until it is unlocked.
              nameHidden: !!(r.manifest.flags & Air.F_NAME_INSIDE),
            }),
            // The file arrived and its CRC-32 says it is wrong. Not a
            // completion: the receiver dropped what it had and is still
            // listening, so the page keeps the microphone open.
            onFailed: (f) => post({
              type: 'failed',
              name: f.manifest.name,
              size: f.manifest.size,
              attempts: f.attempts,
              recovering: true,
              stats: f.stats,
            }),
          });
          post({ type: 'status', ready: true, fs, inputRate: msg.inputRate || fs });
          break;
        case 'rate':
          setRate(msg.inputRate);
          post({ type: 'status', ready: !!rx, fs, inputRate: msg.inputRate || fs });
          break;
        case 'push': {
          if (!rx) break;
          const x = new Float32Array(msg.buf);
          rx.push(rs ? rs.process(x) : x);
          break;
        }
        // Frames that fail signalling never reach onFrame, so the counters
        // are the only way the page can tell "hearing the sender but not
        // decoding it" from "hearing nothing".
        case 'stats':
          if (rx) post({ type: 'stats', stats: Object.assign({}, rx.stats), progress: rx.progress() });
          break;
        case 'file':
          if (!rx) return;
          try {
            const f = await rx.file({ passphrase: msg.passphrase });
            if (f) {
              const buf = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength);
              post({ type: 'file', name: f.name, bytes: buf }, [buf]);
            } else {
              post({ type: 'fileError', message: 'transfer not complete — wait until the whole file has arrived.' });
            }
          } catch (e) {
            post({ type: 'fileError', message: e.message, needsPassphrase: !!e.needsPassphrase });
          }
          break;
      }
    }
  }

  root.createWorkerCore = createWorkerCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createWorkerCore };

  // Real Worker glue.
  if (typeof importScripts === 'function') {
    importScripts('modem.js', 'fft.js', 'chirp.js', 'fec.js', 'ofdm.js', 'fountain.js', 'air.js');
    const handle = createWorkerCore((m, transfer) => postMessage(m, transfer || []));
    // handle() catches inside the core, but a throw in the catch itself, or
    // in the glue, would still leave the page waiting for a message that
    // never comes.
    onmessage = (e) => {
      handle(e.data).catch((err) => {
        postMessage({ type: 'error', message: (err && err.message) || String(err), where: e.data && e.data.type });
      });
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
