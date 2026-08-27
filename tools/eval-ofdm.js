#!/usr/bin/env node
// End-to-end evaluation of the OFDM engine, file to file, per scenario.
//
//   node tools/eval-ofdm.js [--md eval-ofdm.md] [--bytes 12000]
'use strict';
const fs = require('fs');
const Air = require('../air.js');
const ch = require('../test/helpers/channel.js');

const FS = 48000;
const args = process.argv.slice(2);
const mdIdx = args.indexOf('--md');
const mdPath = mdIdx >= 0 ? args[mdIdx + 1] : null;
const bIdx = args.indexOf('--bytes');
const BYTES = bIdx >= 0 ? Number(args[bIdx + 1]) : 12000;

const SCENARIOS = [
  { name: 'clean' },
  { name: 'AWGN 10 dB', fx: (f, r) => ch.awgn(f, 10, r) },
  { name: 'AWGN 5 dB', fx: (f, r) => ch.awgn(f, 5, r) },
  { name: 'AWGN 2 dB', fx: (f, r) => ch.awgn(f, 2, r) },
  { name: 'AWGN 0 dB', fx: (f, r) => ch.awgn(f, 0, r) },
  { name: 'measured room + 8 dB', fx: (f, r) => ch.awgn(ch.echoesFrac(f, FS, ch.ROOM_MEASURED), 8, r) },
  { name: 'bad room (late wall tap) + 10 dB', fx: (f, r) => ch.awgn(ch.echoesFrac(f, FS, ch.ROOM_BAD), 10, r) },
  { name: 'comb 12 dB + 8 dB', fx: (f, r) => ch.awgn(ch.comb(f, FS, 600, 12, r), 8, r) },
  { name: 'comb 20 dB + 10 dB (stretch)', stretch: true, fx: (f, r) => ch.awgn(ch.comb(f, FS, 600, 20, r), 10, r) },
  { name: 'clock +200 ppm', fx: (f, r) => ch.sfo(f, FS, 200) },
  { name: 'clock -200 ppm', fx: (f, r) => ch.sfo(f, FS, -200) },
  { name: '30 % frames lost', loss: 0.3 },
  { name: 'room + comb + 120 ppm + 8 dB', fx: (f, r) => ch.awgn(ch.comb(ch.sfo(ch.echoesFrac(f, FS, ch.ROOM_MEASURED), FS, 120), FS, 600, 12, r), 8, r) },
];

async function run(sc, seed) {
  const r = ch.rng(seed);
  const src = new Uint8Array(BYTES).map(() => r.int(256));
  const prep = await Air.prepare(src, 'eval.bin');
  const tx = new Air.Sender(prep, { session: 5 });
  const rx = new Air.Receiver(FS);
  const cap = 150;
  let sent = 0, airSamples = 0;
  const t0 = process.hrtime.bigint();
  while (!rx.result && sent < cap) {
    let f = tx.nextFrame();
    sent++;
    airSamples += f.length + 800;
    if (sc.loss && r() < sc.loss) continue;
    if (sc.fx) f = sc.fx(f, r);
    rx.push(ch.noise(800, 1e-4, r));
    rx.push(f);
  }
  const cpuMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const file = await rx.file();
  const match = file && Buffer.compare(Buffer.from(file.bytes), Buffer.from(src)) === 0;
  const airSec = airSamples / FS;
  return {
    ok: !!match, sent, stats: rx.stats,
    airSec, throughput: match ? BYTES / airSec : 0,
    rtf: airSec / (cpuMs / 1000),
  };
}

(async () => {
  const rows = [];
  console.log(`OFDM end-to-end: ${BYTES}-byte file per scenario, seeded, frame cap 150.`);
  const pad = (v, n, r) => String(v)[r ? 'padStart' : 'padEnd'](n);
  const header = `${pad('scenario', 36)} ${pad('result', 7)} ${pad('frames', 7, 1)} ${pad('sig fail', 8, 1)} ${pad('drop crc', 8, 1)} ${pad('B/s', 6, 1)} ${pad('RTF', 6, 1)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  let okCount = 0;
  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];
    const res = await run(sc, 1000 + i);
    if (res.ok) okCount++;
    rows.push({ sc, res });
    console.log(`${pad(sc.name, 36)} ${pad(res.ok ? 'ok' : 'FAILED', 7)} ${pad(res.sent, 7, 1)} ${pad(res.stats.sigFail, 8, 1)} ${pad(res.stats.dropletCrcFail, 8, 1)} ${pad(res.throughput.toFixed(0), 6, 1)} ${pad(res.rtf.toFixed(0) + 'x', 6, 1)}`);
  }
  console.log(`\n${okCount} of ${SCENARIOS.length} scenarios delivered the file byte-for-byte.`);
  if (mdPath) {
    const md = ['# OFDM end-to-end eval', '', `${BYTES}-byte file per scenario, seeded, frame cap 150. RTF = seconds of audio processed per second of CPU.`, '',
      '| scenario | result | frames | sig fails | droplet CRC fails | B/s | RTF |', '|---|---|---:|---:|---:|---:|---:|'];
    for (const { sc, res } of rows) md.push(`| ${sc.name} | ${res.ok ? 'ok' : (sc.stretch ? 'fails (stretch)' : 'FAILED')} | ${res.sent} | ${res.stats.sigFail} | ${res.stats.dropletCrcFail} | ${res.throughput.toFixed(0)} | ${res.rtf.toFixed(0)}x |`);
    md.push('', `${okCount} of ${SCENARIOS.length} scenarios delivered the file byte-for-byte.`, '');
    fs.writeFileSync(mdPath, md.join('\n'));
    console.log('wrote ' + mdPath);
  }
  const required = rows.filter((x) => !x.sc.stretch);
  process.exit(required.every((x) => x.res.ok) ? 0 : 1);
})();
