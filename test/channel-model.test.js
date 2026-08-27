'use strict';
// The channel model has to be trustworthy before any OFDM claim made
// through it means anything.
const test = require('node:test');
const assert = require('node:assert');
const ch = require('./helpers/channel.js');

const FS = 48000;
function tone(n, f, amp) { return new Float32Array(n).map((_, i) => (amp || 1) * Math.sin(2 * Math.PI * f * i / FS)); }
function powerAt(x, fs, f, from, to) {
  const w = 2 * Math.PI * f / fs, coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0, n = 0;
  for (let i = from; i < to; i++) { s0 = x[i] + coeff * s1 - s2; s2 = s1; s1 = s0; n++; }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n) * 4;
}
const db = (p) => 10 * Math.log10(p + 1e-20);

test('a notch cuts its own frequency by the asked depth and spares a neighbour', () => {
  const x = tone(FS, 2100, 0.5);
  const y = ch.notches(x, FS, [[2100, 25, 8]]);
  const cut = db(powerAt(y, FS, 2100, 2000, FS - 2000)) - db(powerAt(x, FS, 2100, 2000, FS - 2000));
  assert.ok(cut < -22 && cut > -28, 'notch depth ' + cut.toFixed(1) + ' dB');
  const z = ch.notches(tone(FS, 1500, 0.5), FS, [[2100, 25, 8]]);
  const spare = db(powerAt(z, FS, 1500, 2000, FS - 2000)) - db(powerAt(tone(FS, 1500, 0.5), FS, 1500, 2000, FS - 2000));
  assert.ok(spare > -2, 'neighbour lost ' + spare.toFixed(1) + ' dB');
});

test('a comb notches the grid frequencies', () => {
  const f = 2400;                                    // on a 600 Hz grid
  const x = tone(FS, f, 0.5);
  const y = ch.comb(x, FS, 600, 20);
  const cut = db(powerAt(y, FS, f, 2000, FS - 2000)) - db(powerAt(x, FS, f, 2000, FS - 2000));
  assert.ok(cut < -15, 'comb cut ' + cut.toFixed(1) + ' dB');
});

test('fractional-delay echoes place energy at non-integer sample offsets', () => {
  // A single -6 dB tap at 1.3 ms: the echo of an impulse must appear
  // centred at 62.4 samples, which integer-tap echoes cannot represent.
  const x = new Float32Array(4096); x[100] = 1;
  const y = ch.echoesFrac(x, FS, [[0.0013, -6]]);
  let peakI = 0, peakV = 0;
  for (let i = 120; i < 200; i++) if (Math.abs(y[i]) > peakV) { peakV = Math.abs(y[i]); peakI = i; }
  assert.ok(peakI === 162 || peakI === 163, 'echo peak at ' + peakI);
  // energy split across the two neighbouring samples proves the fraction
  assert.ok(Math.abs(y[162]) > 0.2 && Math.abs(y[163]) > 0.2, `y[162]=${y[162].toFixed(2)} y[163]=${y[163].toFixed(2)}`);
});

test('the measured room set decays about 20 dB within 6 ms', () => {
  const x = new Float32Array(FS); x[1000] = 1;
  const y = ch.echoesFrac(x, FS, ch.ROOM_MEASURED);
  const win = Math.round(0.001 * FS);
  const eAt = (ms) => {
    const s = 1000 + Math.round(ms * FS / 1000);
    let p = 0;
    for (let i = s; i < s + win; i++) p += y[i] * y[i];
    return db(p);
  };
  const drop = eAt(6) - eAt(0);
  assert.ok(drop < -18, '6 ms decay ' + drop.toFixed(1) + ' dB');
  // and the bad room still carries real energy past a 5.33 ms prefix
  const z = ch.echoesFrac(x, FS, ch.ROOM_BAD);
  let late = 0;
  for (let i = 1000 + Math.round(0.00533 * FS); i < 1000 + Math.round(0.014 * FS); i++) late += z[i] * z[i];
  assert.ok(db(late) > -20, 'late energy ' + db(late).toFixed(1) + ' dB');
});

test('sfo stretches time by exactly the ppm asked for', () => {
  const x = tone(FS, 1000, 0.5);
  const y = ch.sfo(x, FS, 200);
  const expected = Math.floor(x.length / (1 + 200e-6));
  assert.ok(Math.abs(y.length - expected) <= 1, `${y.length} vs ${expected}`);
  // A 0.2 Hz shift is not resolvable over a 0.9 s window (0.5 dB of
  // coherence loss), so the frequency check uses 5000 ppm: 1000 Hz must
  // come out at 1005 Hz, and 4.5 cycles of drift separates that cleanly.
  const z = ch.sfo(tone(FS, 1000, 0.5), FS, 5000);
  const p0 = powerAt(z, FS, 1005, 2000, z.length - 2000);
  const p1 = powerAt(z, FS, 1000, 2000, z.length - 2000);
  assert.ok(db(p0) - db(p1) > 10, 'offset tone not dominant: ' + (db(p0) - db(p1)).toFixed(1) + ' dB');
});
