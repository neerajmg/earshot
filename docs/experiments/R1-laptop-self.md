# R1 — Why a laptop cannot decode its own speaker (resolved)

**Question.** Is the laptop-self failure a stable comb filter (coherent OFDM would
fix it), or time-varying microphone processing (nothing would fix it)?

**Answer: neither.** The same-machine play-while-record path corrupts the audio
timeline itself, at the sample level. Measured on
`test/fixtures/rec-robust-real.wav` (MacBook Air playing `robust` FSK through its
speaker while `ffmpeg -f avfoundation` recorded the built-in mic):

- The demodulator's three genuine sync detections sit **2.696 and 3.634 frame
  lengths apart**. Continuous playback only allows integer spacings; these are
  timeline breaks.
- Frame-start alignment against the known transmission drifts by **−26 to −33
  samples** at different points in the recording: dropped samples accumulating.
- A ~30-sample drop rotates a 2100 Hz tone by ~1.44 cycles but a 1500 Hz tone by
  ~1.03 cycles — and the measured phase stability splits exactly that way
  (space/1500 Hz: 37–81° std per quarter-frame; mark/2100 Hz: 82–133°,
  i.e. scrambled).
- Payload goes to ~40 % symbol errors within 50 ms of a cleanly detected sync,
  which frequent millisecond-scale glitches explain and a static channel cannot.

**Consequences.**

1. The laptop-self case is retired as a test harness, not just as a feature. Any
   conclusion drawn from same-machine recordings (including the eight-tone-pair
   sweep in `tools/find-tones.js`) measured the broken path, not the modem.
2. This failure does **not** indict the FSK design, and it neither supports nor
   threatens the OFDM plan. Two separate devices remain the product, and the
   phone-to-laptop transfer remains the reference measurement.
3. Repeated sample drops would break any modulation, OFDM included. If a future
   in-browser capture path shows the same signature (non-integer sync spacing,
   high-tone phase scrambling), suspect the audio pipeline before the modem.

Analysis scripts: session scratch (`forensics.js`, `forensics2.js`), reproducible
against the fixtures with the sent bytes in
`test/fixtures/rec-robust-real.sent.txt` (session 5, name `small.txt`).
