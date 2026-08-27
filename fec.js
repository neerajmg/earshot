// fec.js -- convolutional coding for the OFDM engine.
//
// K=7, generators (133,171) octal, rate 1/2, tail-terminated, decoded by
// soft-input Viterbi. The one line that matters downstream: log-likelihoods
// are weighted by per-subcarrier SNR before they get here, so a comb null
// arrives as an erasure (LLR ~ 0) and this code shrugs off 25 % of those.
//
// Exposes one global, `Fec`.

(function (root) {
  'use strict';

  const K = 7, STATES = 64;
  const G1 = 0o133, G2 = 0o171;

  const parity = (v) => {
    v ^= v >> 4; v ^= v >> 2; v ^= v >> 1;
    return v & 1;
  };

  // Precomputed transitions: for state s (six most recent bits, newest at
  // bit 5) and input b, the register is (b<<6)|s with the newest bit at the
  // generator's MSB tap.
  const OUT1 = new Uint8Array(STATES * 2), OUT2 = new Uint8Array(STATES * 2), NEXT = new Uint8Array(STATES * 2);
  for (let s = 0; s < STATES; s++) {
    for (let b = 0; b < 2; b++) {
      const full = (b << 6) | s;
      OUT1[s * 2 + b] = parity(full & G1);
      OUT2[s * 2 + b] = parity(full & G2);
      NEXT[s * 2 + b] = full >> 1;
    }
  }

  // info bits (0/1) -> coded bits, two per input bit plus 2*(K-1) tail bits.
  function encode(bits) {
    const n = bits.length;
    const out = new Uint8Array(2 * (n + K - 1));
    let s = 0;
    for (let i = 0; i < n + K - 1; i++) {
      const b = i < n ? bits[i] & 1 : 0;             // tail: flush to state 0
      out[2 * i] = OUT1[s * 2 + b];
      out[2 * i + 1] = OUT2[s * 2 + b];
      s = NEXT[s * 2 + b];
    }
    return out;
  }

  // Soft-decision Viterbi. llrs[i] > 0 means "coded bit i is probably 0";
  // magnitude is confidence; 0 is an erasure. Returns the info bits.
  function decode(llrs, nInfo) {
    const steps = nInfo + K - 1;
    if (llrs.length < 2 * steps) throw new Error('llrs too short: ' + llrs.length + ' for ' + nInfo + ' info bits');
    const NEG = -1e30;
    let pm = new Float64Array(STATES).fill(NEG);
    let next = new Float64Array(STATES);
    pm[0] = 0;
    const decisions = new Uint8Array(steps * STATES);
    for (let t = 0; t < steps; t++) {
      next.fill(NEG);
      const l1 = llrs[2 * t], l2 = llrs[2 * t + 1];
      for (let s = 0; s < STATES; s++) {
        const base = pm[s];
        if (base === NEG) continue;
        const maxB = t < nInfo ? 1 : 0;              // tail is known zeros
        for (let b = 0; b <= maxB; b++) {
          const m = base
            + (OUT1[s * 2 + b] ? -l1 : l1)
            + (OUT2[s * 2 + b] ? -l2 : l2);
          const ns = NEXT[s * 2 + b];
          if (m > next[ns]) {
            next[ns] = m;
            decisions[t * STATES + ns] = (s << 1) | b;   // predecessor and bit
          }
        }
      }
      const tmp = pm; pm = next; next = tmp;
    }
    // tail-terminated: end in state 0
    const out = new Uint8Array(nInfo);
    let s = 0;
    for (let t = steps - 1; t >= 0; t--) {
      const d = decisions[t * STATES + s];
      const b = d & 1;
      if (t < nInfo) out[t] = b;
      s = d >> 1;
    }
    return out;
  }

  // Prime-stride interleaver over a length-L coded frame. 971 is prime, so
  // any L not divisible by it gives a bijection that puts consecutive coded
  // bits far apart in both the subcarrier and the symbol dimension.
  function interleaveMap(L) {
    let stride = 971;
    while (L % stride === 0) stride += 2;            // keep it a bijection
    const map = new Uint32Array(L);
    for (let i = 0; i < L; i++) map[i] = (i * stride) % L;
    return map;
  }

  function interleave(arr, map) {
    const out = new arr.constructor(arr.length);
    for (let i = 0; i < arr.length; i++) out[map[i]] = arr[i];
    return out;
  }

  function deinterleave(arr, map) {
    const out = new arr.constructor(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[map[i]];
    return out;
  }

  const Fec = { K, encode, decode, interleaveMap, interleave, deinterleave };
  root.Fec = Fec;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fec;
})(typeof globalThis !== 'undefined' ? globalThis : this);
