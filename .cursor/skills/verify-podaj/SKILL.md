---
name: verify-podaj
description: Launch an isolated local podaj (Vite client + wrangler dev Worker with local KV and throwaway keys), drive the browser UI with agent-browser like a user (create link, open /h/:id, key file, one-shot gone), and capture screenshots, ARIA snapshots, a video and API status codes as evidence. Use before claiming any podaj UI, Worker or crypto change works, and when a PR needs screenshots or video for review.
---

# verify-podaj

podaj is a one-shot env-var handoff: the sender adds `key | value` rows and clicks **create link**; the browser seals them with the public key in `/recipient.pem` and POSTs to the Worker (`POST /api/handoffs` -> KV, 24h TTL). Agents can `POST /api/handoffs/reserve` and send `/s/<id>#writeToken` for fill-then-share. The recipient opens `/h/<32 hex>`, picks their private key with **key file**, and reads the table. `GET /api/handoffs/:id` deletes on read, so the second open returns `410`.

Primary surface: the browser SPA (`src/client/app.ts`, Foldkit; entry `src/client/entry.ts`). Secondary: `bun run podaj keygen` and `bun run podaj decrypt` (CLI, `scripts/`), and the Worker API (`src/worker.ts`). Feature map: [`features/README.md`](features/README.md).

All paths below are relative to this skill directory (`.cursor/skills/verify-podaj/`) unless they start with `/`.

## Launch

```bash
ENV_FILE=$(./scripts/launch.sh)          # or ./scripts/launch.sh my-run-id
source "$ENV_FILE"; echo "$URL"           # e.g. http://127.0.0.1:37147
```

`scripts/launch.sh` does what `bun run dev` does (`vite build && wrangler dev`) with every piece of state moved into `/tmp/podaj-verify-$RUN_ID/`:

1. `bun install --frozen-lockfile` if `node_modules` is missing.
2. Throwaway RSA-4096 keypair via the repo's own `scripts/keygen.mjs` with `HOME` redirected -> `$RUN_DIR/home/.local/share/podaj/{public,private}.pem`.
3. `vite build --outDir $RUN_DIR/dist`, then copies the throwaway public key to `$RUN_DIR/dist/recipient.pem`. The repo's `public/recipient.pem`, `dist/` and `.wrangler/` are never touched.
4. `wrangler dev --ip 127.0.0.1 --port <free> --inspector-port <free> --assets $RUN_DIR/dist --persist-to $RUN_DIR/state` in its own process group (`setsid`). KV is wrangler's local simulator in `$RUN_DIR/state`, so nothing reaches the production `podaj-handoffs` namespace.
5. Ready = `/recipient.pem` returns a `BEGIN PUBLIC KEY` and `/` returns the SPA shell (`id="app"`) within 60s. Otherwise it prints the tail of `$RUN_DIR/wrangler.log` and exits 1.

It prints the env file path. That file holds `RUN_ID RUN_DIR REPO PORT URL PID KEY_DIR PRIVATE_PEM EVIDENCE SESSION GIT_REV`; every other helper takes it as `$1`. Two runs can coexist (distinct ports, dirs, browser sessions). Set `PODAJ_PORT=8787` to pin the port.

Teardown is [Cleanup](#cleanup).

## Doctor

```bash
./scripts/doctor.sh "$ENV_FILE"     # exit 0 = worth driving
```

Read-only; it creates no handoffs. Checks: wrangler pid alive; the listening port belongs to our process group; `GET /` is 200; CSP on the Worker path `/h/<random>`; served `/recipient.pem` equals this run's throwaway key; `GET /api/handoffs/<random never-issued id>` is `410` (KV binding works); cross-origin `POST /api/handoffs` is `403`; the build's git rev equals the checkout's current rev (else relaunch, because the dist is stale).

`run_worker_first` is on, so `/` goes through the Worker and should send CSP. Do not request `https://podaj.hasparus.workers.dev` — that host is closed.

## Drive

Harness: `agent-browser` 0.41.2 at `/home/box/.local/bin/agent-browser` (Chrome for Testing, headless). Always pass `--session "$SESSION"` (from the env file) so you never take over another agent's browser.

One command runs the mapped journeys and asserts each end state:

```bash
./scripts/journey.sh "$ENV_FILE"                   # all: create-link -> receive-handoff -> one-shot-gone, plus journey.webm
./scripts/journey.sh "$ENV_FILE" create-link       # just one; later features read $EVIDENCE/handoff-url.txt
```

Non-zero exit with `FAIL: <reason>` means the app did not meet the expectation. Do not loosen the check; report it.

Hand-driving (same handles the script uses):

```bash
AB="/home/box/.local/bin/agent-browser --session $SESSION"
$AB open "$URL/"; $AB wait --text "create link"
$AB snapshot -i                                     # textbox "OPENAI_API_KEY", textbox "value", button add/create link; show/remove are aria-labels
$AB find nth 0 'input[placeholder="OPENAI_API_KEY"]' fill FOO
$AB find nth 0 'input[placeholder="value"]' fill bar
$AB find role button click --name "add"
$AB wait --fn 'document.querySelectorAll("input[placeholder=OPENAI_API_KEY]").length === 2'
$AB find role button click --name "create link"
$AB wait ".status.ok"; $AB get text ".status.ok"    # "share this once.\nhttp://127.0.0.1:<port>/h/<32 hex>"
$AB open "$URL/h/<id>"; $AB wait --text "key file"
$AB upload "#key-file" "$PRIVATE_PEM"; $AB wait ".var-row-readonly"
```

Stable handles, from `src/client/app.ts`:

| What | Handle |
| --- | --- |
| Brand / key id | `.brand` text `podaj` (CSS shows it uppercase); `.key-meta` = first 16 hex of SHA-256 over the recipient SPKI |
| Send rows | `input[placeholder="OPENAI_API_KEY"]` (key), `input[placeholder="value"]` (value, `type=password` until show); index rows with `find nth <i>` |
| Row buttons | `.row-actions` -> `button[aria-label="show"]` or `hide` only when the value is non-empty; `button[aria-label="remove"]` (disabled when one row) |
| Toolbar | role button `add`, role button `create link` |
| Status | `.status.ok` (success) / `.status.error` (message from `src/client/user-facing.ts`) |
| Receive | `#key-file` (file input; the "key file" label is not bound to it, so `find label` does not work), `.var-row-readonly > .cell-key / .cell-value` |
| Footer | `.site-footer` = `HOW_IT_WORKS` in `src/client/user-facing.ts` |

Foldkit renders on the next frame. After any click, wait on the DOM you expect (`wait --fn`, `wait <selector>`), never on a fixed sleep or an immediate `get count`.

API-only checks (no browser): `curl -s -o /dev/null -w '%{http_code}' "$URL/api/handoffs/<id>"`. Never GET a live handoff id with curl before the UI opens it, because that read consumes it.

Do not drive `https://podaj.hasparus.workers.dev`. That deployment is closed on purpose. Proofs stay on the local wrangler from `launch.sh`.

## Evidence

Everything lands in `evidence/<RUN_ID>/` inside this skill dir (gitignored by `.gitignore`; attach files to the PR rather than committing them). It survives cleanup.

| File | Proves |
| --- | --- |
| `01-send-empty.png` | send page with header key id and footer |
| `02-send-filled.png`, `.aria.txt` | the action: two rows filled, row 2 revealed |
| `03-link-created.png`, `.aria.txt`, `03-status.txt`, `handoff-url.txt` | resulting state: `share this once.` + one-shot URL; values cleared |
| `04-receive-keyfile.png` | recipient view before the key is picked |
| `05-receive-values.png`, `.aria.txt`, `05-received.json` | decrypted rows, compared exactly with what was sent |
| `06-second-open-gone.png`, `.aria.txt`, `06-second-open.txt` | second open shows `This link was already used or expired.` and no picker |
| `07-api-second-get.json` | side effect: KV entry deleted (`{"error":"gone"}` + `410`) |
| `journey.webm` | video of the whole `all` run |
| `wrangler.log` | Worker request log (copied in by cleanup) |

Proof standards:

- Go through the real user path: type into the inputs, click the buttons, upload the key file. Don't call `seal`/`open` or POST sealed blobs yourself to stand in for the UI.
- Capture the action and the state it produced, not just the last screen.
- Check side effects next to the pixels: `410` from the API after the receive, the header key id against the run's `public.pem`, and the received values against the sent values.
- No mocks. Local wrangler KV is the real binding implementation; the production boundary is only the KV namespace id.

## Cleanup

```bash
./scripts/cleanup.sh "$ENV_FILE"
```

It closes the `$SESSION` browser, sends TERM and then KILL to the process group launch started (`kill -- -$PID`, never by process name), copies `wrangler.log` into evidence, and deletes `/tmp/podaj-verify-$RUN_ID` (throwaway keys, dist, KV state). It then lists the evidence dir to show the proof survived. Run it after every failed attempt too. Afterwards `ss -ltn | grep ":$PORT "` should print nothing.

## Helpers

All of these are executable, live in `scripts/`, and take the env file printed by launch:

| Script | Invocation | Does |
| --- | --- | --- |
| `launch.sh` | `ENV_FILE=$(./scripts/launch.sh [RUN_ID])` | isolated build + wrangler dev + throwaway keys; prints env file |
| `doctor.sh` | `./scripts/doctor.sh "$ENV_FILE"` | read-only readiness check, exit 0/1 |
| `journey.sh` | `./scripts/journey.sh "$ENV_FILE" [create-link\|receive-handoff\|one-shot-gone\|all]` | drives the UI, writes evidence, asserts end states |
| `cleanup.sh` | `./scripts/cleanup.sh "$ENV_FILE"` | teardown, keeps evidence |

Full proof in one line:

```bash
ENV_FILE=$(./scripts/launch.sh) && ./scripts/doctor.sh "$ENV_FILE" && ./scripts/journey.sh "$ENV_FILE"; ./scripts/cleanup.sh "$ENV_FILE"
```

Run `/maintain-verification-skill` when routes, labels or selectors change (Foldkit view in `src/client/app.ts`).
