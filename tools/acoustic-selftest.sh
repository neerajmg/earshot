#!/bin/sh
# One-laptop acoustic test with no browser: renders a file to a WAV, plays it
# through the speakers with afplay while ffmpeg records the microphone, then
# decodes the recording. Needs ffmpeg (brew install ffmpeg).
#
#   tools/acoustic-selftest.sh [robust|fast] [file]
#
# Make sure the speakers, not headphones, are the output device, and that
# the output is not muted. Pick the mic with MIC_INDEX (see the device list
# ffmpeg prints on failure).
set -e

# macOS only: it uses afplay and ffmpeg's avfoundation input. On Linux or
# Windows, use the portable path instead - play the WAV with any player and
# run the listener in another terminal:
#   node tools/make-wav.js FILE /tmp/tx.wav robust 1
#   node tools/listen.js --ofdm --seconds 90     # in one terminal
#   ffplay -nodisp -autoexit /tmp/tx.wav          # in another
if [ "$(uname -s)" != "Darwin" ]; then
  echo "this script is macOS only; see the comment at the top for the portable path" >&2
  exit 2
fi
PRESET=${1:-robust}
FILE=${2:-README.md}
MIC_INDEX=${MIC_INDEX:-}
cd "$(dirname "$0")/.."
TMP=${TMPDIR:-/tmp}/modem-selftest
mkdir -p "$TMP"
node tools/make-wav.js "$FILE" "$TMP/tx.wav" "$PRESET" 1
DUR=$(python3 -c "import wave; w=wave.open('$TMP/tx.wav'); print(int(w.getnframes()/w.getframerate())+4)")
if [ -z "$MIC_INDEX" ]; then
  MIC_INDEX=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | grep -E '\[[0-9]+\] (MacBook.*Microphone|Built-in Microphone)' | sed -E 's/.*\[([0-9]+)\].*/\1/' | head -1)
fi
if [ -z "$MIC_INDEX" ]; then
  echo "could not find the built-in microphone; set MIC_INDEX from this list:"
  ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | grep -E '^\[AVFoundation.*\] \[[0-9]+\]'
  exit 2
fi
echo "recording ${DUR}s from mic :$MIC_INDEX, playing $TMP/tx.wav"
ffmpeg -hide_banner -loglevel error -y -f avfoundation -i ":$MIC_INDEX" -t "$DUR" -ac 1 -ar 48000 -sample_fmt s16 "$TMP/rec.wav" &
FF=$!
sleep 1.5
afplay "$TMP/tx.wav"
sleep 2
# ffmpeg's capture thread sometimes ignores SIGTERM; give it a moment, then insist.
kill $FF 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 $FF 2>/dev/null || break; sleep 0.5; done
kill -9 $FF 2>/dev/null || true
sleep 0.5
node tools/decode-wav.js "$TMP/rec.wav" "$PRESET" --out "$TMP/received.bin"
cmp "$FILE" "$TMP/received.bin" && echo "received file is identical to $FILE"
