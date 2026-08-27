# End-to-end eval

1000-byte file, up to 6 passes, seeded. Frame counts include START frames. SNR is full-band AWGN relative to the signal RMS; the demodulator's own SNR estimate (in one baud of bandwidth) is in the last column.

| scenario | preset | result | passes | pass 1 ok | frames ok / seen | rejected syncs | raw BER | bits fixed per frame | B/s | real-time factor | est. SNR dB |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| clean | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1470x | >60 |
| clean | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 41.8 | 947x | >60 |
| AWGN 10 dB | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1515x | 31.2 |
| AWGN 10 dB | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0009 | 0.5 | 41.8 | 663x | 24.7 |
| AWGN 0 dB | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0001 | 0.1 | 11.8 | 1503x | 21.0 |
| AWGN 0 dB | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0017 | 1.0 | 41.8 | 647x | 14.9 |
| AWGN -5 dB | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0001 | 0.1 | 11.8 | 1532x | 16.1 |
| AWGN -5 dB | fast | ok | 3 | 27/35 | 81/105 | 14 | 0.0148 | 12.0 | 13.9 | 500x | 10.3 |
| AWGN -10 dB | robust | ok | 2 | 34/35 | 64/70 | 9 | 0.0084 | 7.0 | 5.9 | 1412x | 11.8 |
| AWGN -10 dB | fast | FAILED | 6 | 0/35 | 0/79 | 69 | 0.1601 | 37.1 | 0.0 | 258x | 6.7 |
| TX 44.1k, RX 48k | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1691x | >60 |
| TX 44.1k, RX 48k | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 41.8 | 964x | >60 |
| TX 48k, RX 44.1k | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1606x | >60 |
| TX 48k, RX 44.1k | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 41.8 | 607x | >60 |
| TX 16k, RX 48k | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1555x | >60 |
| TX 16k, RX 48k | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 41.8 | 883x | >60 |
| drift +200 ppm | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1637x | >60 |
| drift +200 ppm | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 41.8 | 895x | >60 |
| drift -200 ppm | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1632x | >60 |
| drift -200 ppm | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 41.8 | 894x | >60 |
| quiet -40 dB, 10 dB | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1508x | 31.0 |
| quiet -40 dB, 10 dB | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0009 | 0.5 | 41.8 | 623x | 24.9 |
| clipped x10 | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1608x | >60 |
| clipped x10 | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 41.8 | 912x | >60 |
| bandpass 1-3.5k, 10 dB | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1508x | 31.2 |
| bandpass 1-3.5k, 10 dB | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0007 | 0.4 | 41.8 | 630x | 24.7 |
| echo mild, 15 dB | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0000 | 0.0 | 11.8 | 1519x | 36.3 |
| echo mild, 15 dB | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0023 | 1.4 | 41.8 | 643x | 28.7 |
| echo desk -6 dB, 15 dB | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0002 | 0.1 | 11.8 | 1522x | 35.4 |
| echo desk -6 dB, 15 dB | fast | ok | 3 | 31/35 | 76/105 | 37 | 0.0100 | 13.6 | 13.9 | 439x | 28.4 |
| echo notch 1500 Hz | robust | FAILED | 6 | 0/35 | 0/0 | 208 | 0.0000 | 0.0 | 0.0 | 770x | - |
| echo notch 1500 Hz | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0014 | 0.8 | 41.8 | 643x | 28.9 |
| 25 % frames lost | robust | ok | 5 | 30/35 | 125/125 | 0 | 0.0000 | 0.0 | 2.4 | 1582x | >60 |
| 25 % frames lost | fast | ok | 3 | 22/35 | 77/77 | 0 | 0.0000 | 0.0 | 13.9 | 812x | >60 |
| 60 ms burst per frame | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0148 | 9.0 | 11.8 | 1650x | >60 |
| 60 ms burst per frame | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0567 | 34.5 | 41.8 | 903x | >60 |
| room: mild echo, band, drift, 44.1k, 8 dB | robust | ok | 1 | 35/35 | 35/35 | 0 | 0.0004 | 0.2 | 11.8 | 1512x | 29.4 |
| room: mild echo, band, drift, 44.1k, 8 dB | fast | ok | 1 | 35/35 | 35/35 | 0 | 0.0025 | 1.5 | 41.8 | 637x | 21.7 |

36 of 38 scenario runs delivered the file byte-for-byte.

## Sensitivity

Single pass, frames ok / sent, full-band AWGN SNR in dB.

| preset | 10 dB | 5 dB | 2.5 dB | 0 dB | -2.5 dB | -5 dB | -7.5 dB | -10 dB | -12.5 dB | -15 dB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| robust | 22/22 | 22/22 | 22/22 | 22/22 | 22/22 | 22/22 | 22/22 | 21/22 | 1/22 | 0/22 |
| fast | 22/22 | 22/22 | 22/22 | 22/22 | 22/22 | 17/22 | 0/22 | 0/22 | 0/22 | 0/22 |

Full-band SNR understates what the correlators see: one baud of bandwidth at 48 kHz is 22 dB narrower than full band for robust, 16 dB for fast.

