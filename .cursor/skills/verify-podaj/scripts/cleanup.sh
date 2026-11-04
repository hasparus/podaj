#!/usr/bin/env bash
# Tear down what launch.sh started. Keeps evidence. Usage: scripts/cleanup.sh /tmp/podaj-verify-<RUN_ID>/env
set -uo pipefail
ENV_FILE="${1:?usage: cleanup.sh <run env file>}"
# shellcheck disable=SC1090
source "$ENV_FILE"
AB="${AGENT_BROWSER:-/home/box/.local/bin/agent-browser}"
"$AB" --session "$SESSION" close >/dev/null 2>&1 || true
if kill -0 "$PID" 2>/dev/null; then
  kill -TERM -- "-$PID" 2>/dev/null || true   # whole process group we created with setsid (bun -> wrangler -> workerd)
  for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -KILL -- "-$PID" 2>/dev/null || true
fi
cp "$RUN_DIR/wrangler.log" "$EVIDENCE/wrangler.log" 2>/dev/null || true
case "$RUN_DIR" in /tmp/podaj-verify-?*) rm -rf "$RUN_DIR" ;; esac
echo "cleaned $RUN_DIR; evidence kept at $EVIDENCE"
ls -1 "$EVIDENCE"
