// worker.js -- the receive engine, meant for a dedicated Worker so a
// 40-minute transfer cannot be starved by rendering. The DSP core is
// createWorkerCore(post), a pure function of messages in and messages out,
// so Node tests drive it without a Worker; the importScripts glue at the
// bottom only runs inside a real one.
//
// Messages in:  {type:'init', fs}
//               {type:'push', buf: ArrayBuffer}      (Float32 samples)
//               {type:'file', passphrase?}           (after 'complete')
//               {type:'reset'}
// Messages out: {type:'frame', sig, manifest, stats, progress}
//               {type:'complete', name, size, needsPassphrase}
//               {type:'file', name, bytes: ArrayBuffer} | {type:'fileError', message, needsPassphrase}
//               {type:'status', ...}

(function (root) {
  'use strict';

  function createWorkerCore(post) {
    const Air = root.Air;
    let rx = null;

    return async function onMessage(msg) {
      switch (msg.type) {
        case 'init':
        case 'reset':
          rx = new Air.Receiver(msg.fs || Air.FS, {
            onFrame: (f) => post({
              type: 'frame',
              sig: { session: f.sig.session, profile: f.sig.profile },
              manifest: f.manifest ? { name: f.manifest.name, size: f.manifest.size, flags: f.manifest.flags, winCount: f.manifest.winCount } : null,
              stats: f.stats,
              progress: f.progress,
            }),
            onComplete: (r) => post({
              type: 'complete',
              name: r.manifest.name,
              size: r.manifest.size,
              crcOk: r.crcOk,
              needsPassphrase: !!(r.manifest.flags & 2),
            }),
          });
          post({ type: 'status', ready: true, fs: msg.fs || Air.FS });
          break;
        case 'push':
          if (rx) rx.push(new Float32Array(msg.buf));
          break;
        case 'file':
          if (!rx) return;
          try {
            const f = await rx.file({ passphrase: msg.passphrase });
            if (f) {
              const buf = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength);
              post({ type: 'file', name: f.name, bytes: buf }, [buf]);
            } else {
              post({ type: 'fileError', message: 'transfer not complete' });
            }
          } catch (e) {
            post({ type: 'fileError', message: e.message, needsPassphrase: !!e.needsPassphrase });
          }
          break;
      }
    };
  }

  root.createWorkerCore = createWorkerCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createWorkerCore };

  // Real Worker glue.
  if (typeof importScripts === 'function') {
    importScripts('modem.js', 'fft.js', 'chirp.js', 'ofdm.js', 'fec.js', 'fountain.js', 'air.js');
    const handle = createWorkerCore((m, transfer) => postMessage(m, transfer || []));
    onmessage = (e) => { handle(e.data); };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
