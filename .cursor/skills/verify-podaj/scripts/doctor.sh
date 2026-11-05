#!/usr/bin/env bash
# Read-only health check for a launched instance. Usage: scripts/doctor.sh /tmp/podaj-verify-<RUN_ID>/env
# Exit 0 = worth driving. Creates no handoffs (GETs a random never-issued id, expects 410).
set -uo pipefail
ENV_FILE="${1:?usage: doctor.sh <run env file>}"
# shellcheck disable=SC1090
source "$ENV_FILE"
fail=0
ok()  { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

kill -0 "$PID" 2>/dev/null && ok "wrangler pid $PID alive" || bad "wrangler pid $PID not running"
owner=$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ -n "$owner" ] && [ "$(ps -o pgid= -p "$owner" | tr -d ' ')" = "$PID" ]; then ok "port $PORT owned by our process group"; else bad "port $PORT not owned by our wrangler (owner pid: ${owner:-none})"; fi

hdrs=$(curl -sS -D - -o /dev/null "$URL/")
echo "$hdrs" | grep -qi '^HTTP/1.1 200' && ok "GET / 200" || bad "GET / not 200"
warn() { printf 'WARN %s\n' "$*"; }
# Exact asset hits (/, /recipient.pem, /assets/*) are served by the assets layer without running
# src/worker.ts, so wrangler dev omits the Worker's CSP there. SPA fallbacks (/h/:id) go through the Worker.
echo "$hdrs" | grep -qi "^content-security-policy:" && ok "CSP on /" || warn "no CSP on / (asset served without the Worker; compare: curl -sI https://podaj.hasparus.workers.dev/)"
curl -sS -D - -o /dev/null "$URL/h/$(openssl rand -hex 16)" | grep -qi "^content-security-policy: default-src 'self'" && ok "CSP on /h/:id (Worker path)" || bad "CSP missing on /h/:id"

served=$(curl -fsS "$URL/recipient.pem" | sha256sum | cut -c1-16)
mine=$(sha256sum < "$KEY_DIR/public.pem" | cut -c1-16)
[ "$served" = "$mine" ] && ok "served /recipient.pem is this run's throwaway key" || bad "served recipient.pem ($served) != run key ($mine)"

code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/handoffs/$(openssl rand -hex 16)")
[ "$code" = 410 ] && ok "unknown handoff id -> 410 (KV binding works)" || bad "unknown handoff id -> $code (want 410)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' "$URL/api/handoffs")
[ "$code" = 403 ] && ok "cross-origin POST -> 403" || bad "cross-origin POST -> $code (want 403)"

now="$(git -C "$REPO" rev-parse --short HEAD)$(git -C "$REPO" diff --quiet HEAD || echo -dirty)"
[ "$now" = "$GIT_REV" ] && ok "build matches checkout ($GIT_REV)" || bad "build is from $GIT_REV, checkout is now $now: relaunch"
exit $fail
