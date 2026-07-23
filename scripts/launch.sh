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

echo "Launching Forkfield..."
# --no-sandbox avoids the Chromium SUID-sandbox error that is common under WSL.
exec node_modules/electron/dist/electron --no-sandbox .
