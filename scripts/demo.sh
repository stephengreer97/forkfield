#!/usr/bin/env bash
# Build Forkfield, launch it in automation mode, run the scripted demo tour,
# and stitch the captured frames into demo.gif. Requires ImageMagick (convert).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

FRAMES="${1:-/tmp/forkfield-demo/frames}"
OUT="${2:-$REPO/demo.gif}"
rm -rf "$FRAMES"; mkdir -p "$FRAMES"

echo "Building..."
node node_modules/electron-vite/bin/electron-vite.js build >/dev/null

echo "Launching in debug mode (CDP on :9222)..."
FORKFIELD_DEBUG=1 FORKFIELD_DEBUG_DIR="${FORKFIELD_DEBUG_DIR:-$HOME}" \
  node_modules/electron/dist/electron --no-sandbox \
  --remote-debugging-port=9222 --remote-allow-origins='*' . >/tmp/forkfield-demo.log 2>&1 &
EPID=$!
trap 'kill $EPID 2>/dev/null || true' EXIT

for i in $(seq 1 40); do
  curl -s http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
  sleep 0.5
done

echo "Driving the tour..."
node scripts/drive.mjs "$FRAMES"

echo "Encoding..."
FFBIN="${FFMPEG:-ffmpeg}"
MP4="${OUT%.gif}.mp4"
# Real per-frame timing from the screencast manifest, sped up 1.7x, resampled
# to a smooth constant 30fps.
"$FFBIN" -y -f concat -safe 0 -i "$FRAMES/frames.txt" \
  -vf "setpts=PTS/1.7,fps=30,format=yuv420p,pad=ceil(iw/2)*2:ceil(ih/2)*2" \
  -c:v libx264 -crf 22 -preset slow -movflags +faststart "$MP4" >/dev/null 2>&1
echo "Wrote $MP4 ($(du -h "$MP4" | cut -f1))"
