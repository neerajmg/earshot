# Acoustic FSK modem

Send a file from one laptop to another using only the speaker on one side and
the microphone on the other. Everything runs in the browser from plain files:
no build step, no dependencies, nothing to install. Node is used only to run
the tests.

You can hear the whole thing: a 2-FSK signal at 300 baud sounds like an old
modem handshake that never ends. The receiver page shows a spectrogram, the
decision variable the slicer works on, and a log of every frame.

If you only want to move a file, read [docs/GUIDE.md](docs/GUIDE.md): it walks
through a transfer with screenshots of the page and is regenerated from the
code by `npm run guide`, so it always matches the page you have.

## Quick start

On both laptops, copy this folder over (AirDrop is fine) and serve it:

    cd "Modem file transfer"
    python3 -m http.server 8000

Open http://localhost:8000 in Chrome. The receiver needs `localhost` or
`https` for the microphone; the sender does not and can open `index.html`
straight from disk.

1. Pick the same preset on both pages (start with `robust`).
2. Receiver: **Start listening**. Allow the microphone. Check the line under
   the buttons says `AEC false NS false AGC false`.
3. Sender: choose a file, set **Passes** to 3, **Play**.
4. Put the laptops about half a metre apart, speaker volume around 40 to 60 %.
5. When the receiver has every frame and the file CRC-32 matches, **Download
   file** lights up.

Speeds:

| preset | baud | tones (Hz)  | payload rate | 1 kB takes  |
|--------|------|-------------|--------------|-------------|
| robust | 300  | 1500 / 2100 | ~13 B/s      | ~1.3 min    |
| fast   | 1200 | 2400 / 3600 | ~48 B/s      | ~20 s       |

That is per pass. Three passes of a 10 kB file on `robust` is close to 40
minutes, so try small files first, or use `fast` in a quiet room.

## Testing without a second laptop

- **Digital loopback**: the sender modulates and feeds the receiver code
  directly. No audio. Proves the framing, coding and demodulator on this
  page.
- **Download WAV** then **Decode a WAV instead**: the same thing through a
  file. The 16 kHz export is small and still carries both tones.
- **Acoustic self-test**: start listening, then play the exported WAV from a
  terminal with `afplay file.wav`. The laptop hears its own speaker. If the
  log shows frames going by but nothing decodes, the browser is probably
  cancelling its own output: see Troubleshooting.
- **Without a browser at all**: `tools/acoustic-selftest.sh robust` renders
  a file, plays it with `afplay`, records the mic with `ffmpeg`, decodes the
  recording and compares. Check the speakers are the current output device
  and not muted first; headphones make the test silent.

  On the machine this was written on, a laptop listening to its **own**
  speaker does not decode, though every other path does. The tones arrive
  cleanly and the preamble is found; the sync word behind it is not.
  `node tools/find-tones.js` plays real frames on eight tone pairs and reports
  which ones decode, and none of them did, so it is not the choice of tones.
  Two separate devices work fine, so this is specific to a machine hearing
  itself. docs/GUIDE.md has the measurements.
- Sample rate mismatch: the header has an **Audio rate** selector. Receive at
  48000 and send at 44100 (or the reverse) and it must still work.

## Tests

    node --test

The suite covers the codes (CRC, Hamming, interleaver), framing, the modulator,
the demodulator through a simulated channel (noise, gain, clipping, DC,
sample-rate mismatch, clock drift, band limiting, dropouts, room echo), and the
carousel protocol. All random choices are seeded, so a failure reproduces.

To turn a real recording into a regression test, tick **record mic to WAV**
on the receiver during a transfer, download it into `test/fixtures/`, and add
a test that decodes it and asserts the number of frames you expect.
`node tools/decode-wav.js recording.wav robust` prints what the decoder makes
of any WAV, sync by sync; `node tools/make-wav.js file out.wav fast 2`
renders a transmission without the browser.

## Evaluation

    node tools/eval.js                 # simulated channel matrix, both presets
    node tools/eval.js --md results.md # same, also written as Markdown
    node tools/browser-e2e.js robust --mic   # the real page in headless Chrome, WAV as fake mic
    node tools/browser-e2e.js fast --wav     # same page, through the "Decode a WAV" input

`tools/eval.js` runs a 1000-byte file through sender, modulator, channel,
demodulator and receiver for every scenario (noise levels, sample-rate
mismatch, clock drift, band limiting, clipping, room echo, dropouts, bursts,
and a combined "room") and reports passes needed, frames ok, raw bit error
rate, bits fixed per frame, throughput and how many times faster than real
time the demodulator ran. The current numbers are in
[eval-results.md](eval-results.md). `tools/browser-e2e.js` drives the actual
page over the DevTools protocol and compares the received bytes.

## Over the air, two devices

Confirmed working: a phone playing a rendered WAV, a MacBook Air a short
distance away running the receive page. A 148-byte file arrived complete and
its SHA-256 matched the original.

    SNR 31.3 dB, tone balance +2.4 dB, sync correlation 0.68
    12 of 14 frames passed CRC, 0 audio drops, 5 of 5 data frames recovered

Two frames failed and the carousel's second pass replaced them, which is what
the repeated passes are for. A phone is the easiest second device: render a
WAV (**Download WAV**, or `node tools/make-wav.js file out.wav robust 2`),
send it to the phone, start the receiver, and play it. `npm run listen` does
the receiving side in a terminal instead of the browser.

## Troubleshooting

- **Nothing decodes on the same laptop.** Chrome's echo canceller removes the
  page's own output from the mic. The page asks for it to be off and prints
  what it got. Also set the macOS mic mode (Control Center, while the mic is
  live) to *Standard*, not *Voice Isolation*. Two separate laptops do not
  have this problem.
- **Tone balance is far from 0 dB.** Room reflections can cancel one tone at
  the mic position. Move either laptop 10 cm. The receiver compensates up to
  a point by measuring the preamble, but a 20 dB notch is too much.
- **Sync correlation is low or syncs are missed.** Too loud (clipping shows
  in the level meter) or too quiet, or the two pages have different presets.
- **Audio drops count goes up.** The receiver tab must stay in the foreground;
  background tabs get throttled. Keep the laptop awake (`caffeinate -d`).
- **Works on `robust`, fails on `fast`.** Expected in a lively room. A strong
  early reflection at 1200 baud smears symbols into each other and the
  Hamming code cannot keep up. More passes help, since each pass scrambles
  the bits differently; otherwise move closer or use `robust`.

## How it works

Sender: bytes are cut into 32-byte chunks, each wrapped in a 38-byte frame
(`type | seq | len | data | crc16`), pushed through Hamming(8,4) to 76 bytes,
interleaved so a burst of errors on the air lands one bit per codeword, and
sent as 608 symbols after a 32-symbol `0101…` preamble and a 32-bit sync word.
Tones are continuous-phase, whole cycles per symbol, and the gap between
frames lets the room go quiet. A START frame carrying name, size, frame count
and the file's CRC-32 is repeated every 16 data frames and again at the end.
The whole sequence repeats for as many passes as you ask. Each pass XORs the
air bits with a different fixed pseudo-random sequence (four of them, the
first all zeros): errors caused by room echo depend on the symbol pattern,
and without this the same frames would fail on every pass. The receiver
tries all four and keeps the one whose CRC passes.

Receiver: two one-symbol correlators track the energy at each tone. Their
normalised difference `d` is compared to the 64-symbol preamble+sync
template; a peak means a frame is here, and its position gives symbol timing
to a sixteenth of a symbol. The preamble sets the slicing threshold, the sync
word is re-checked, and the 64 known symbols also train a two-tap decision
feedback equaliser (how much of the last two symbols still rings in the
room), used only when it beats the plain threshold on those symbols. Then
the 608 payload symbols are sliced, deinterleaved and Hamming-decoded.
Frames that pass CRC-16 go into the receiver's map, and missing ones fill in
on later passes. Done when the map is full and CRC-32 matches.

Frequencies and durations are defined in Hz and seconds, never in samples, so
a 44.1 kHz sender and a 48 kHz receiver agree without either knowing.

## Files

    index.html   the page
    modem.js     CRC, Hamming(8,4), interleaver, framing, presets, Sender/Receiver
    dsp.js       modulator, demodulator, WAV read/write
    diag.js      spectrogram, decision plot, frame map, log, level meter
    app.js       Web Audio glue and buttons
    test/        node --test suite and the simulated channel
    tools/       make-wav.js, decode-wav.js, acoustic-selftest.sh, make-guide.js
    docs/        GUIDE.md and its screenshots, kept current by tools/make-guide.js

`modem.js` and `dsp.js` have no DOM dependency; Node `require`s them for the
tests. Each is a classic script exposing one global, because ES modules do not
load from `file://` in Chrome.

## Tuning

All knobs live at the top of `dsp.js`:

- `CORR_THRESHOLD` (0.5): template correlation needed to declare a sync.
  Lower catches weaker signals and more false alarms; CRC-16 filters those.
- `MAX_SYNC_ERRORS` (4 of 32): how sloppy a sync word may be.
- `CONFIRM_SYMBOLS` (3): how long to wait for a better peak before trusting
  one. The template has sidelobes of 0.53 two symbols either side of the
  peak, so this must be more than 2.
- `MIN_COVERAGE` (0.75) / `MIN_COVERAGE_LEVEL` (0.25): a candidate sync must
  have signal under at least three quarters of the template, so the tail of
  a frame followed by silence does not score on a few lucky symbols.
- `DFE_TAPS` (2): how many previous symbols the per-frame equaliser looks
  back at. In simulation two taps take the fast preset from about half the
  frames to most of them under a strong desk reflection.
- `NOISE_BLOCK_SEC` / `NOISE_HISTORY_SEC`: the noise floor is the quietest
  20 ms block of the last half second.

Presets are in `modem.js`. A preset is valid only if both tones and their
difference are multiples of the baud rate; the file refuses to load otherwise.
