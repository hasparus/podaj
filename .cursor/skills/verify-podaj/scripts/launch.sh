#!/usr/bin/env bash
# Launch an isolated local podaj (vite build + wrangler dev) for verification.
# Usage: scripts/launch.sh [RUN_ID]   -> prints the path of the run env file.
# Isolation: own port, own inspector port, own dist dir, own KV state, own throwaway keys.
# Never touches ~/.local/share/podaj, public/recipient.pem, dist/ or .wrangler/ in the repo.
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(git -C "$SKILL_DIR" rev-parse --show-toplevel)"
RUN_ID="${1:-${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}}"
RUN_DIR="/tmp/podaj-verify-$RUN_ID"
EVIDENCE="$SKILL_DIR/evidence/$RUN_ID"
mkdir -p "$RUN_DIR/home" "$RUN_DIR/state" "$EVIDENCE"

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
PORT="${PODAJ_PORT:-$(free_port)}"
INSPECTOR_PORT="$(free_port)"

cd "$REPO"
[ -d node_modules ] || pnpm install --frozen-lockfile >"$RUN_DIR/install.log" 2>&1

# Throwaway recipient keypair via the repo's own keygen, with HOME redirected.
HOME="$RUN_DIR/home" node scripts/keygen.mjs >/dev/null
KEY_DIR="$RUN_DIR/home/.local/share/podaj"

# Same two steps as `pnpm dev`, but into a private dist dir.
pnpm exec vite build --outDir "$RUN_DIR/dist" --emptyOutDir >"$RUN_DIR/build.log" 2>&1
cp "$KEY_DIR/public.pem" "$RUN_DIR/dist/recipient.pem"

setsid nohup pnpm exec wrangler dev \
  --ip 127.0.0.1 --port "$PORT" --inspector-port "$INSPECTOR_PORT" \
  --assets "$RUN_DIR/dist" --persist-to "$RUN_DIR/state" \
  --show-interactive-dev-session=false --log-level info \
  >"$RUN_DIR/wrangler.log" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$RUN_DIR/wrangler.pid"

cat > "$RUN_DIR/env" <<ENV
RUN_ID=$RUN_ID
RUN_DIR=$RUN_DIR
REPO=$REPO
PORT=$PORT
URL=http://127.0.0.1:$PORT
PID=$PID
KEY_DIR=$KEY_DIR
PRIVATE_PEM=$KEY_DIR/private.pem
EVIDENCE=$EVIDENCE
SESSION=podaj-verify-$RUN_ID
GIT_REV=$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)
ENV

# Ready = the SPA shell AND the recipient key are served by our worker.
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/recipient.pem" 2>/dev/null | grep -q "BEGIN PUBLIC KEY" \
     && curl -fsS "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q 'id="app"'; then
    echo "$RUN_DIR/env"; exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then echo "wrangler exited; see $RUN_DIR/wrangler.log" >&2; tail -30 "$RUN_DIR/wrangler.log" >&2; exit 1; fi
  sleep 1
done
echo "not ready after 60s; see $RUN_DIR/wrangler.log" >&2; exit 1
