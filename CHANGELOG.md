# Changelog

## Unreleased

v1.0.0 waits on one thing: a real over-the-air transfer with the OFDM engine
between two physical devices. Everything below it is gated and green.

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
