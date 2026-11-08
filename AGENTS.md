# podaj agent notes

Minimal one-shot env-var handoff (Worker + Vite UI). Canonical flow: **CLI → human browser → CLI**; the CLI operator can be an AI or a human. The CLI creates the link and owns the recipient private key. The human only fills the form and clicks `send`. No browser recipient creation or private-key picker. Deploy with **wrangler** only — no Alchemy. Do not grow an MCP server unless the owner asks.

All handwritten source, CLI tools, and hooks are TypeScript. Do not add handwritten `.mjs`, `.cjs`, or `.js`; generated Node distribution output belongs under ignored `dist/`.

People deploy their own Worker (README Deploy to Cloudflare button, or `.github/workflows/deploy.yml` on a clone). Do not point agents at `podaj.hasparus.workers.dev` — that host is closed. Private request creation off localhost requires `PODAJ_API_AUTH_SECRET`; delivery uses independent per-handoff capabilities. Public demo creation uses recipient-bound approval. Readiness uses native hibernating Durable Object WebSockets.

Agent CLI: `printf '%s\n' "$PODAJ_API_AUTH_SECRET" | podaj init --url <workers.dev>` when the operator already used the README deploy button (`--token` still works, but the value lands in shell history), or `podaj init --deploy` when `wrangler login` is already done. `podaj wait` accepts the same stdin token. A terminal with no flags prompts (connect, or deploy and wait on Cloudflare login). Then `podaj wait KEY...`. The sender clicks `send` after filling the request. `wait` stays non-interactive: fill link on stderr, JSON on stdout, WebSocket first, poll only if that socket fails. Use `bun run podaj` from a checkout until the public npm release is verified. The package ships its bin, wrangler, and client build. Deploys stage under `~/.local/share/podaj/worker` and do not rewrite the installed `wrangler.jsonc`. Each `wait` generates a fresh memory-only recipient keypair; init/deploy do not need or publish recipient files. Optional standalone `keygen` refuses existing files. Connecting checks configuration and creation access before saving. Remote Worker URLs must use HTTPS; HTTP is only for localhost. Init output omits the instance token.

## Cloudflare targets

- Hosted demo: account `podaj` on Workers Free. Deploy-button test: existing account `hasparus`, Worker `podaj`. The latter tests the button path, not a substitute manual CLI deployment.
- `.pi/mcp.json` provides one OAuth connection, `cloudflare-podaj`, for accounts `podaj` and `hasparus`. Select only these two accounts, not all accounts, and use explicit account IDs in API calls. Server names/descriptions do not enforce account restrictions; grant only the intended resources and permissions. Use MCP for inspection and Wrangler for deployments.
- Ignored `.cloudflare/test.env` and `.cloudflare/demo.env` hold explicit account IDs and optional account-scoped API tokens. Never put management credentials in `.dev.vars`, Worker vars, logs, or chat.
- `bun run cf:test ...` / `bun run cf:demo ...` pin Wrangler to the selected account and Worker. They allow only `whoami`, `login`, `secret list`, and explicit `secret put NAME`. Secret writes mutate the Worker and need owner approval. Missing account IDs fail closed; inherited shell API tokens are not used. Empty profile tokens use Wrangler's stored OAuth session. No deployment or secret rotation is authorized by preparing these files.
- Handoff retention defaults to 7200 seconds (2 hours), configured with `HANDOFF_TTL_SECONDS`; supported private-instance overrides are whole seconds from 60 to 86400. Changing configuration does not rewrite existing records' TTLs.

## UI (Direction A · Zinc Ledger)

- Recipient public key comes from the CLI-created fill link; private key stays in the CLI. Optional short fingerprint in the header — **no environments list or sidebar**
- Dense lowercase chrome: `key` | `value`, `add`, `send`; success copy `sent.` No human-facing `create link` action. See `design.md`
- Row icons from `pixelarticons` (`eye` / `eye-off` / `trash`), `aria-label` `show` / `hide` / `remove`. Show and hide only when the value is non-empty
- CLI **reserve** flow (`/s/:id#write=<capability>&recipient=<base64url-SPKI>` → fill → explicit `send`); edits stay local until sent
- Browser pages never collect or decrypt handoffs. The CLI holds collection authority and decrypts locally.
- Footer on the fill page: plain-language security (see `HOW_IT_WORKS` in `src/client/user-facing.ts`)
- Env-var handoff only (not vault fields)
- User-facing copy: plain language only — wire format (`PODAJ1.`) stays in code/docs for implementers

## Fence (rat-stack subset)

Aligned with [rat-stack fence](https://ratstack.sh/systems/fence) for this single package (no monorepo):

- `bun run check` — `tsrs` typecheck (app + key scripts) and type-aware `oxlint` with **Ultracite core**
- `bun run test`
- Lefthook runs both on commit; `scripts/vcs-command-policy.ts` blocks `git --no-verify` (agent hook source: `scripts/hooks/block-git-no-verify.ts`; compiled Node hook: `dist/scripts/hooks/block-git-no-verify.js`)

Foldkit client: `src/client/app.ts` (program) + `src/client/entry.ts` (Runtime boot). `@foldkit/vite-plugin` + `@foldkit/oxlint-plugin` on `src/client/**`.

## Invariants

- Ciphertext prefix `PODAJ1.` only
- Stored variable bundles are ciphertext only; delivery metadata must not contain plaintext variable names or values. No recipient private keys on the server or in git.
- Product is KEY+value env vars, not login credentials
- Envelope `env` slug is `default`; each request binds its CLI-generated recipient public key
