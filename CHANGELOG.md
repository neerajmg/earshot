# Changelog

## Unreleased

v1.0.0 waits on one thing: a real over-the-air transfer with the OFDM engine
between two physical devices. Everything below it is gated and green.

- User guide for the product page, `docs/GUIDE.md`: a screenshot of every
  state, taken from the live page by `npm run guide`; the FSK guide moved to
  `docs/LAB.md`. `npm test` fails when either guide is behind the code.
- Product page: the file box draws as a box, the spectrogram under
  **Advanced** shows the whole 1.5–7.5 kHz band, and the time estimate
  counts the 768 bytes a frame really carries.
- Product page: **Use the sample file** for a ten-second demo, **Send
  text** to send a typed message (shown on the receiver's screen), and a
  **Speed and limits** table computed from the frame format.

## 0.9.1 — 2026-08-29

A pre-release audit — code, usability, and an end-to-end functional run — found
two receiver states a noisy room could reach and only a page reload could clear.
Those, and everything else it turned up, are fixed. `docs/experiments/qa-2026-08-28.md`
records what the audit found; each defect now has a named regression test.

Nothing about the modulation changed. The frame format did, so this release does
not interoperate with 0.9.0: the manifest magic is now `Eb`, and a droplet
carries a CRC-32 instead of a CRC-16.

Receiving
- A file that finishes with a bad CRC-32 no longer ends the transfer. The
  receiver keeps listening and says the file arrived damaged, where before it
  claimed success, stopped the microphone, and then refused to hand the file
  over.
- A droplet whose payload is corrupt but whose checksum happened to match used
  to weld a wrong answer into a window that no later droplet could lift out.
  The CRC-32 trailer makes that about 65,000 times rarer, and a poisoned window
  is now rebuilt rather than held forever.
- A manifest that does not add up is dropped instead of throwing out of the
  worker and killing every later frame with it.
- Two senders in one room no longer starve each other: the receiver latches the
  session it is following.
- Pressing Listen after a completed transfer starts a fresh one.

Sending
- Files just over a 64 kB boundary took about twice the airtime the page
  promised, because every fountain window was fed equally regardless of how many
  blocks it held. Windows are now served in proportion: 65,537 bytes went from
  171 frames to 86.
- The time estimate is quoted after compression, so a text file is no longer
  promised three times the sound it needs.

Passphrases
- The sender trimmed the passphrase and the receiver did not, so a trailing
  space — which phone keyboards add — locked the file. Neither side alters it
  now.
- The file name is encrypted with the contents. The size still is not, and the
  README says so.
- 600,000 PBKDF2 iterations, up from 210,000.
- A passphrase of only spaces is refused rather than silently sending in clear.

The page
- Says what the two devices do, and puts Receive first on a phone, where it used
  to start below the fold.
- The file picker is reachable by keyboard.
- Progress sits under the button that started it; the status no longer reads
  "about 0 s left" under a full bar.
- The receiver distinguishes silence from sound it cannot read.
- Microphone failures explain themselves instead of quoting the browser.
- Sending and listening at once on one device is refused; it decoded its own
  speaker and looked like it had worked.

## 0.9.0 — 2026-08-27

The OFDM engine, end to end, and the product page.

- Chirp acquisition (1500–5500 Hz matched filter, first-peak picking) that
  survives a 20 dB comb and −5 dB in-band noise.
- OFDM physical layer: N=1024 at 48 kHz, 116 data subcarriers, coherent QPSK
  with Zadoff-Chu channel estimation, pilot phase/gain/timing-drift tracking
  (g-h, measured against its own prediction), null-subcarrier noise floor,
  PAPR clip-and-filter.
- FEC: K=7 rate-1/2 convolutional with soft Viterbi on SNR-weighted LLRs;
  prime-stride interleaving; BER curve verified against the textbook.
- Fountain layer: systematic windowed random linear coding over GF(2), spec
  locked by golden vectors. 1 MB through 30 % frame loss, byte-perfect.
- The frame announces itself (profile, size, session, CRC), so receiving
  needs zero configuration.
- Optional AES-256-GCM passphrase; compression via CompressionStream.
- Browser: AudioWorklet capture into a Worker running the whole receive
  chain; new Send/Receive product page; the FSK instrument preserved as the
  lab page.
- CI: unit gates, two eval matrices, and headless-Chrome end-to-end with a
  fake microphone, byte-compared.

## 0.1.0 — 2026-08-26

The FSK modem: 2-FSK with Hamming(8,4), interleaving, CRC framing and a
carousel protocol; spectrogram, decision plot and frame map; verified
phone-to-laptop over the air, SHA-256-identical.
