---
name: verify-podaj
description: Verify podaj's CLI → human fill-only browser → CLI handoff using existing automated gates and an isolated localhost Wrangler, compiled CLI, and agent-browser journey. Use when checking UI, Worker, CLI, or encryption changes or collecting review evidence; distinguish automated results from manual browser proof.
---

# verify-podaj

The CLI creates a fresh, memory-only recipient keypair for each `wait`, reserves a request, and prints a fill URL on stderr. The human fills that URL and clicks **send**. The browser encrypts names and values; the terminal consumes ciphertext, decrypts locally, and prints JSON on stdout. Read the [feature map](features/README.md) before choosing checks.

## Boundaries

- Verify localhost only. Never contact real Cloudflare accounts, the closed upstream host, or any deployed instance. The primary URL is not deployed and public npm availability is unverified: do not invent a hostname or use a registry CLI.
- Use synthetic values only. Never read real credential files, `.dev.vars`, existing podaj keys/config, or Wrangler OAuth state. Do not install, log in, deploy, rotate secrets, or commit as part of verification; stop if a prerequisite is missing.
- Use the existing build and tests. Handwritten application/tool source is TypeScript; do not add a parallel verification harness.

## Automated gates

From the repository root, with the already-installed **Bun 1.4.4** and dependencies, run `bun run check`, `bun run test`, and `bun run build`. Record each command, exit status, and checkout revision. Check the Bun version first; do not silently switch versions or install one.

Use these existing tests as the protocol/security evidence, not as substitutes for browser interaction:

| Gate | Evidence |
| --- | --- |
| `test/worker-runtime.test.ts` | Actual Workers HTTP/RPC/SQLite runtime, native WebSocket lifecycle, role/slot isolation, atomic fill/consume, replay 410, expiry, ciphertext-only storage, CSP and mutation rejection |
| `test/cli-lifecycle.test.ts` | Compiled CLI lifecycle against a local fixture server; ephemeral keys, exact JSON, socket-first/poll fallback, demo enrollment binding, malformed response rejection |
| `test/client-app.test.ts` | Landing page has no creation flow; edits stay local; explicit send uploads only ciphertext with write authority |
| `test/parse-route.test.ts`, `test/parse-env.test.ts`, `test/podaj1.test.ts` | Complete fragment validation, env paste, encryption/decryption |

## Isolated manual setup

This is a procedure to perform, not a claim that a browser run has happened.

1. Create a fresh private scratch directory (`mktemp -d`, `umask 077`). Record its path, repository absolute path, unique browser session, and unused loopback HTTP and inspector ports. Never reuse another run's ports, processes, or session.
2. Give every verification process a throwaway `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` under scratch. Start from `env -i`, allowlisting only required tool paths/environment plus these scratch paths; explicitly set `WRANGLER_SEND_METRICS=false`. This clears inherited `CLOUDFLARE_*`, `CF_*`, Wrangler, podaj, dotenv, and proxy credentials/settings; do not source any profile or env file. Permit loopback traffic only; stop on any attempted external access.
3. Build with the gates above. Write a temporary Wrangler JSON config **inside scratch**, not beside the repository config, and run Wrangler from scratch. Wrangler resolves local env files beside its config; this prevents reading the real repository `.dev.vars`. Do not copy that file or use `bun run dev`.
4. Derive only the following non-secret fields from `wrangler.jsonc`; replace paths with absolute repository paths. Keep bindings/migrations and compatibility date aligned with the checkout. No account IDs, remote bindings, secrets, or deployment targets:

```json
{
  "name": "podaj-local-verify",
  "main": "/ABS/REPO/src/worker.ts",
  "compatibility_date": "2025-10-11",
  "assets": { "directory": "/ABS/REPO/dist/client", "binding": "ASSETS", "run_worker_first": ["/", "/s/*", "/api/*", "/parties/*", "/authorize", "/authorize/", "/authorize.html"] },
  "durable_objects": { "bindings": [{ "name": "HANDOFF_PARTY", "class_name": "HandoffParty" }] },
  "migrations": [{ "tag": "v1-handoff-party", "new_sqlite_classes": ["HandoffParty"] }],
  "vars": { "PODAJ_MODE": "private", "MAX_HANDOFF_BYTES": "32768", "HANDOFF_TTL_SECONDS": "7200" }
}
```

5. In that sanitized environment, invoke the installed repository Wrangler binary with `dev --local --config "$SCRATCH/wrangler.json" --ip 127.0.0.1 --port "$PORT" --inspector-port "$INSPECTOR_PORT" --persist-to "$SCRATCH/state"`. Persist only local SQLite-backed Durable Object state there. Track the actual child PID/process group and logs. Never pass `--remote`.
6. Set `URL=http://127.0.0.1:$PORT`. Wait for this process to serve `/api/config` with private mode and `/` with the built SPA; verify port ownership and CSP/no-store. Readiness must not reserve or consume anything. No public recipient key file is needed.
7. From scratch, run the real compiled CLI under Node: `node "$REPO/dist/scripts/podaj.js" init --url "$URL" </dev/null`. Its config must appear only under scratch. Then run `node "$REPO/dist/scripts/podaj.js" wait PODAJ_VERIFY_A PODAJ_VERIFY_B </dev/null >"$SCRATCH/result.json" 2>"$SCRATCH/cli.stderr"` as a tracked process, with the same isolated environment. Local private mode needs no owner secret.
8. Read the browser skill's current `agent-browser` instructions. Open the exact CLI-emitted fill URL in your unique `--session`; follow [human-fill.md](features/human-fill.md), then [terminal-consume.md](features/terminal-consume.md). Never replace this journey with direct encryption/API calls.

## Evidence and cleanup

Save synthetic-only before/after screenshots, accessibility snapshots, the exact expected/actual terminal JSON comparison, command results, and redacted localhost request metadata. Prove action and outcome, not just a final screen. Do not retain raw authorization headers, full capability URLs, verifier material, private keys, SQLite dumps, or real values in shared artifacts; redact address bars too.

Keep automated and manual claims separate. Report any missing browser run, demo coverage, storage inspection, or replay evidence as unverified; failures are not permission to weaken assertions.

On success, failure, or interruption: close only your browser session, terminate and reap only your tracked CLI/Worker descendants (TERM, then KILL if needed), verify your ports are released, and delete scratch config/HOME/local SQLite state. Preserve only reviewed, redacted proof artifacts. Never kill by process name or clean another run's files.
