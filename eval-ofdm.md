# OFDM end-to-end eval

12000-byte file per scenario, seeded, frame cap 150. RTF = seconds of audio processed per second of CPU.

| scenario | result | frames | sig fails | droplet CRC fails | B/s | RTF |
|---|---|---:|---:|---:|---:|---:|
| clean | ok | 16 | 0 | 0 | 360 | 65x |
| AWGN 10 dB | ok | 16 | 0 | 0 | 360 | 62x |
| AWGN 5 dB | ok | 16 | 0 | 0 | 360 | 37x |
| AWGN 2 dB | ok | 16 | 0 | 0 | 360 | 59x |
| AWGN 0 dB | ok | 18 | 0 | 2 | 320 | 61x |
| measured room + 8 dB | ok | 16 | 0 | 0 | 360 | 9x |
| bad room (late wall tap) + 10 dB | ok | 16 | 0 | 0 | 360 | 7x |
| comb 12 dB + 8 dB | ok | 16 | 0 | 0 | 360 | 44x |
| comb 20 dB + 10 dB (stretch) | fails (stretch) | 150 | 0 | 231 | 0 | 20x |
| clock +200 ppm | ok | 16 | 0 | 0 | 360 | 20x |
| clock -200 ppm | ok | 16 | 0 | 0 | 360 | 21x |
| 30 % frames lost | ok | 20 | 0 | 0 | 288 | 82x |
| room + comb + 120 ppm + 8 dB | ok | 17 | 0 | 1 | 339 | 7x |

12 of 13 scenarios delivered the file byte-for-byte.
