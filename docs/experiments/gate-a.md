# Gate A — device measurements

Running record of the Phase 0 experiments the OFDM design depends on.
Method: https://neerajmg.github.io/earshot/checks/

## MacBook Air, Chrome 151, 2026-08-27

- **48 kHz**: requested 48000 -> got 48000 (running); requested 44100 -> got
  44100; default rate 48000. The forced-rate design holds here.
- **Same-machine play+record band** (browser path, AEC off): flat within about
  +-12 dB from 500 Hz to 9.75 kHz; worst in-band dip -12 dB at 1750 Hz; hard
  rolloff only at 10 kHz (-31.9 dB). Second, independent confirmation of the
  R1 verdict: the laptop-self decode failure was never a comb-filtered
  channel - the browser measures a healthy one where the ffmpeg path
  measured garbage.
- **Capture settings honoured**: echoCancellation, noiseSuppression,
  autoGainControl, voiceIsolation all false; 48 kHz, 16-bit, 2.7 ms latency.
- **Pipeline soak** (AudioWorklet -> Worker doing four 1024-point FFTs plus a
  Viterbi-sized loop per 4096-sample chunk), sampled at 1m14s: capture gaps 0,
  worker max 5.8 ms against an 85 ms budget, backlog 0. The reported
  "38 missing quanta" was a measurement artifact - 101 ms of worklet spin-up
  counted from the button press; the baseline is fixed to first-chunk arrival
  in the current page.

## Still to run

- The same three checks on a phone (the constrained device), plus one full
  40-minute soak there.
- PAPR: OFDM-shaped burst vs FSK burst at equal peak, phone speaker,
  compare received in-band SNR.
- Per-subcarrier SNR in two more rooms (the 12.3 dB figure has one data
  point).
- iOS: does opening the microphone while playing duck the output?
