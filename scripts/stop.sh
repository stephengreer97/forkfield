#!/usr/bin/env bash
# Stops Forkfield cleanly.
#
# Always signal the whole process group, never individual processes. Chromium
# forks the renderer, GPU and network services from a zygote; killing those
# children while the parent lives leaves it retrying launches until it aborts
# with "GPU process isn't usable. Goodbye." A `pkill -f` on the absolute path
# hits exactly the children and misses the parent, because launch.sh starts the
# parent with a relative one.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$REPO/.forkfield.pid"

pid=""
if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  # A recycled PID belonging to something else must not be signalled.
  if [ -n "$pid" ] && ! grep -qa 'electron' "/proc/$pid/cmdline" 2>/dev/null; then
    pid=""
  fi
fi

# No usable pidfile (older launch, or started by hand): find the parent by its
# relative command line, which only the launcher's process uses.
if [ -z "$pid" ]; then
  pid="$(pgrep -f 'node_modules/electron/dist/electron --no-sandbox \.$' | head -1 || true)"
fi

if [ -z "$pid" ]; then
  echo "Forkfield is not running."
  rm -f "$PIDFILE"
  exit 0
fi

pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
if [ -z "$pgid" ]; then
  echo "Forkfield process $pid vanished."
  rm -f "$PIDFILE"
  exit 0
fi

echo "Stopping Forkfield (pid $pid, group $pgid)..."
kill -TERM -- "-$pgid" 2>/dev/null || true

# Give it a few seconds to save the canvas and exit.
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done

if kill -0 "$pid" 2>/dev/null; then
  echo "Still running after 10s; sending KILL."
  kill -KILL -- "-$pgid" 2>/dev/null || true
  sleep 1
fi

rm -f "$PIDFILE"
echo "Forkfield stopped."
