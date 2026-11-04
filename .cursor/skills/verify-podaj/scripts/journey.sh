#!/usr/bin/env bash
# Drive podaj through the browser like a user and capture evidence.
# Usage: scripts/journey.sh <run env file> [create-link|receive-handoff|one-shot-gone|all]
#   create-link      -> fills 2 rows, Create link, saves the one-shot URL to $EVIDENCE/handoff-url.txt
#   receive-handoff  -> opens that URL in a fresh tab, picks the run's private key via "Key file", checks values
#   one-shot-gone    -> opens the same URL again (UI) and GETs the API (curl), expects "already used" / 410
#   all (default)    -> the three in order (each later step needs the earlier one), plus journey.webm video
# Fails loudly (non-zero) on any unmet expectation. Never weaken an expectation to make it pass.
set -euo pipefail
ENV_FILE="${1:?usage: journey.sh <run env file> [feature]}"; WHAT="${2:-all}"
# shellcheck disable=SC1090
source "$ENV_FILE"
AB="${AGENT_BROWSER:-/home/box/.local/bin/agent-browser}"
ab() { "$AB" --session "$SESSION" "$@"; }
shot() { ab screenshot "$EVIDENCE/$1.png" >/dev/null; echo "shot $EVIDENCE/$1.png"; }
snap() { ab snapshot -c > "$EVIDENCE/$1.aria.txt"; }
die() { echo "FAIL: $*" >&2; exit 1; }
picker_shown() { [ "$(ab eval '(e => !!e && e.offsetParent !== null)(document.querySelector("#key-file"))')" = true ]; }
mkdir -p "$EVIDENCE"
KEY1=PODAJ_VERIFY_A; VAL1="alpha-$RUN_ID"; KEY2=PODAJ_VERIFY_B; VAL2="beta=with spaces & symbols"

create_link() {
  ab open "$URL/" >/dev/null
  ab wait --text "Create link" >/dev/null
  want=$(openssl pkey -pubin -in "$KEY_DIR/public.pem" -outform DER | sha256sum | cut -c1-16)
  ab wait .key-meta >/dev/null || die "header key id never appeared"   # fingerprint is computed async after first paint
  [ "$(ab get text .key-meta)" = "$want" ] || die "header fingerprint != run key ($want)"
  shot 01-send-empty
  # Foldkit renders on the next frame: always wait for the DOM to catch up after a click.
  ab find nth 0 'input[placeholder="OPENAI_API_KEY"]' fill "$KEY1" >/dev/null
  ab find nth 0 'input[placeholder="Value"]' fill "$VAL1" >/dev/null
  ab find role button click --name "Add" >/dev/null
  ab wait --fn 'document.querySelectorAll("input[placeholder=OPENAI_API_KEY]").length === 2' >/dev/null || die "Add did not create a second row"
  ab find nth 1 'input[placeholder="OPENAI_API_KEY"]' fill "$KEY2" >/dev/null
  ab find nth 1 'input[placeholder="Value"]' fill "$VAL2" >/dev/null
  ab find nth 1 '.row-actions button:first-child' click >/dev/null   # row 2 "Show"
  ab wait --fn 'document.querySelectorAll("input[placeholder=Value]")[1].type === "text"' >/dev/null || die "Show did not reveal row 2"
  shot 02-send-filled
  snap 02-send-filled
  ab find role button click --name "Create link" >/dev/null
  ab wait ".status.ok" >/dev/null || die "no .status.ok after Create link: $(ab get text .status 2>/dev/null)"
  status=$(ab get text .status.ok)
  printf '%s\n' "$status" > "$EVIDENCE/03-status.txt"
  [ "$(printf '%s\n' "$status" | head -1)" = "Share this once." ] || die "status copy: $status"
  url=$(printf '%s\n' "$status" | grep -Eo "$URL/h/[a-f0-9]{32}") || die "no one-shot URL in status"
  echo "$url" > "$EVIDENCE/handoff-url.txt"
  ab wait --fn '[...document.querySelectorAll("input[placeholder=Value]")].every(i => i.value === "")' >/dev/null || die "values not cleared after send"
  shot 03-link-created
  snap 03-link-created
  echo "create-link ok: $url"
}

receive_handoff() {
  url=$(cat "$EVIDENCE/handoff-url.txt")
  ab open "$url" >/dev/null
  ab wait --text "Key file" >/dev/null
  shot 04-receive-keyfile
  ab upload "#key-file" "$PRIVATE_PEM" >/dev/null
  ab wait ".var-row-readonly" >/dev/null || die "table did not appear: $(ab get text .status 2>/dev/null)"
  got=$(ab eval 'JSON.stringify([...document.querySelectorAll(".var-row-readonly")].map(r=>[r.children[0].textContent,r.children[1].textContent]))')
  echo "$got" > "$EVIDENCE/05-received.json"
  exp=$(python3 -c 'import json,sys;print(json.dumps(json.dumps([[sys.argv[1],sys.argv[2]],[sys.argv[3],sys.argv[4]]],separators=(",",":"))))' "$KEY1" "$VAL1" "$KEY2" "$VAL2")
  [ "$got" = "$exp" ] || die "received $got, expected $exp"
  shot 05-receive-values
  snap 05-receive-values
  ! picker_shown || die "Key file picker still visible after values were shown"
  echo "receive-handoff ok"
}

one_shot_gone() {
  url=$(cat "$EVIDENCE/handoff-url.txt"); id=${url##*/}
  ab open "$url" >/dev/null
  ab wait ".status.error" >/dev/null || die "second open showed no error"
  msg=$(ab get text .status.error); echo "$msg" > "$EVIDENCE/06-second-open.txt"
  [ "$msg" = "This link was already used or expired." ] || die "second open said: $msg"
  shot 06-second-open-gone
  snap 06-second-open-gone
  code=$(curl -s -o "$EVIDENCE/07-api-second-get.json" -w '%{http_code}' "$URL/api/handoffs/$id")
  echo "$code" >> "$EVIDENCE/07-api-second-get.json"
  [ "$code" = 410 ] || die "API second GET -> $code (want 410)"
  ! picker_shown || die "Key file picker still offered on a used link (API did return 410)"
  echo "one-shot-gone ok (UI error + API 410)"
}

case "$WHAT" in
  create-link) create_link ;;
  receive-handoff) receive_handoff ;;
  one-shot-gone) one_shot_gone ;;
  all)
    ab open "$URL/" >/dev/null
    ab record start "$EVIDENCE/journey.webm" >/dev/null
    trap 'ab record stop >/dev/null 2>&1 || true' EXIT
    create_link; receive_handoff; one_shot_gone ;;
  *) die "unknown feature $WHAT" ;;
esac
