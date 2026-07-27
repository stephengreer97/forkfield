#!/usr/bin/env bash
# Forkfield launcher for WSL. Builds the Linux app and opens it on the
# Windows desktop through WSLg. Safe to run from anywhere.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Display sanity check (WSLg sets one of these on Windows 11).
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
  echo "Warning: no display detected." >&2
  echo "On Windows 11 this should work out of the box via WSLg." >&2
  echo "On Windows 10 you need an X server running and DISPLAY set." >&2
fi

# First run: install dependencies.
if [ ! -d node_modules ]; then
  echo "First run: installing dependencies (this can take a few minutes)..."
  npm install
fi

# Make sure the Electron binary is present (it is skipped in some installs).
if [ ! -x node_modules/electron/dist/electron ]; then
  echo "Fetching the Electron binary (one time)..."
  node node_modules/electron/install.js
fi

# Build the current code, then launch.
echo "Building Forkfield..."
node node_modules/electron-vite/bin/electron-vite.js build >/dev/null

LOG="$REPO/forkfield.log"
echo "Launching Forkfield in the background..."
# Append rather than truncate: a relaunch after a crash used to overwrite the
# very output that explained it. A banner separates runs.
{
  echo
  echo "===== launch $(date '+%Y-%m-%d %H:%M:%S') ====="
} >>"$LOG"
# --no-sandbox avoids the Chromium SUID-sandbox error common under WSL.
# setsid + & detaches from this terminal so the app keeps running and the
# shell prompt returns immediately. Logs go to the file above.
setsid node_modules/electron/dist/electron --no-sandbox . >>"$LOG" 2>&1 < /dev/null &
echo "Forkfield is running in the background. Logs: $LOG"
