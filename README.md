# 🔊 earshot

**Send a file to the device next to you — with sound.**
No install, no network, no pairing, no account. Two devices, a speaker, a microphone.

**→ [neerajmg.github.io/earshot](https://neerajmg.github.io/earshot/)**

1. Open the page on both devices.
2. Press **Listen** on the receiving one.
3. Pick a file and press **Start sending** on the other. Keep them still, close, and the pages in front.

The receiver hears the transmission, reassembles the file, checks it, and offers
it to save. If you set a passphrase, only someone who knows it can open what
arrives.

The [user guide](docs/GUIDE.md) walks through a transfer with a screenshot of
every step. It is regenerated from the page, so it matches what you see.

## Honest numbers

Sound through air is a narrow channel. earshot moves roughly **350–500 bytes per
second** at desk range:

| size | takes about |
|---|---|
| a note, a key, a config (2 kB) | 10 s |
| a small document (30 kB) | 1–2 min |
| a photo (300 kB) | 12–18 min |
| the 2 MB ceiling | over an hour |

Text, JSON and code compress on the way out, often 3× smaller. Photos and
archives don't. Both devices must sit still — a hand-held phone Doppler-shifts
the signal — and quiet helps.

**Privacy is physics here: sound is a broadcast.** Anyone within earshot running
this same page receives what you send. The passphrase option (AES-256-GCM, key
derived from what you type) is there for exactly that reason.

## How it works

The sender plays OFDM — 116 QPSK subcarriers between 1.5 and 7.5 kHz, 37.5
symbols a second — announced by a 40 ms chirp that a matched filter can find
even when the room's acoustics notch out a third of the band. Each frame
carries a convolutional codeword (K=7, soft-decision Viterbi, log-likelihoods
weighted by per-subcarrier SNR so a dead frequency counts as an erasure, not a
vote). Inside ride three fountain-code droplets: random GF(2) combinations of
the file's blocks, so *any* enough droplets rebuild the file and a lost frame
costs nothing but time. A manifest in every frame means a receiver that joins
late still knows what's coming. Pilot tones track clock drift between the two
devices' unsynchronized audio clocks; four deliberately silent subcarriers
measure the noise floor every 27 ms.

The repository also contains the project's first modem — a 2-FSK build with
spectrograms, decision plots and a frame map — preserved intact as
[the lab page](https://neerajmg.github.io/earshot/lab.html), documented in
[docs/LAB.md](docs/LAB.md). The measurements that shaped the OFDM design
are in [docs/experiments/](docs/experiments/), and per-scenario results in
[eval-ofdm.md](eval-ofdm.md) and [eval-results.md](eval-results.md).

## Development

Plain files, no build step, no dependencies. Node runs the tests.

```
npm test                     # ~107 tests: DSP, codes, fountain, protocol, end-to-end
npm run eval                 # FSK engine through the simulated channel
node tools/eval-ofdm.js      # OFDM engine, file-to-file, per scenario
npm run e2e                  # the real pages in headless Chrome, byte-compared
EARSHOT_SLOW=1 npm test      # adds 1 MB through 30 % loss
npm run serve                # local http://localhost:8000
```

| file | role |
|---|---|
| `index.html`, `earshot.js` | the product page |
| `worker.js`, `capture-worklet.js` | receive engine off the main thread |
| `air.js` | frames ⇄ files: manifest, compression, encryption, droplets |
| `ofdm.js`, `chirp.js`, `fec.js`, `fountain.js`, `fft.js` | the OFDM physical layer |
| `lab.html`, `app.js`, `dsp.js`, `diag.js`, `modem.js` | the FSK lab, preserved |
| `test/`, `tools/` | gates for every claim above |
| `docs/`, `tools/make-guide.js` | the user guides, screenshots taken from the real pages; `npm test` fails when they lag |

Every scenario in the eval tables is a seeded, reproducible test. The
simulated channel includes white noise, comb filtering, fractional-delay
multipath matched to measured rooms, clipping, and sample-rate offset between
sender and receiver.

MIT. Bug reports and recordings of transfers that failed are equally welcome —
tick nothing, just save the WAV the receiver can record and open an issue.
