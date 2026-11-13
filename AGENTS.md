# podaj agent notes

Minimal one-shot env-var handoff (Worker + Vite UI). Canonical flow: **CLI → human browser → CLI**; the CLI operator can be an AI or a human. The CLI creates the link and holds a fresh memory-only RSA transport private key for each request. The human only fills the form and clicks `send`. No browser recipient creation or private-key picker. Deploy with **wrangler** only — no Alchemy. Do not grow an MCP server unless the owner asks.

All handwritten source, CLI tools, and hooks are TypeScript. Do not add handwritten `.mjs`, `.cjs`, or `.js`; generated Node distribution output belongs under ignored `dist/`.

People deploy their own Worker (README Deploy to Cloudflare button, or `.github/workflows/deploy.yml` on a clone). Do not point agents at `podaj.hasparus.workers.dev` — that host is closed. Private request creation off localhost requires `PODAJ_API_AUTH_SECRET`; delivery uses independent per-handoff capabilities. Public demo creation uses recipient-bound approval. Readiness uses native hibernating Durable Object WebSockets.

Release CLI: `npm i -g podaj`, then `podaj wait KEY...`. With no saved connection or `PODAJ_URL`, wait uses `https://podaj.fyi`. Optional `podaj deploy` handles Cloudflare login and saves the deployed connection automatically. `podaj config` connects to an existing Worker without deploying; for non-interactive private setup use `printf '%s\n' "$PODAJ_API_AUTH_SECRET" | podaj config --url <workers.dev>`. Prefer stdin to `--token`, which lands in shell history. `podaj wait` also accepts a stdin token. Workers default to `PODAJ_ACCESS=private`; `public` uses recipient-bound Turnstile admission. There is no `init` command or `PODAJ_MODE` fallback. Upstream npm publication belongs to `.github/workflows/ci.yml` and runs only on pushed `v*` tags matching the package version. `.github/workflows/deploy.yml` deploys the demo independently on `main` pushes, version tags, and manual reruns; no npm credential or unpublished version is required for deployment. Run upstream publication/deployment mutations on CI, not locally. GitHub secrets hold management credentials and the Turnstile secret. Use checkout commands only for development, not as product onboarding. The published package runs on Node.js 22+ and ships its bin, Wrangler, Worker sources, and client build; consumers do not need Bun. Deploys stage under `~/.local/share/podaj/worker` without rewriting the installed `wrangler.jsonc`. Each wait generates a fresh memory-only RSA transport keypair; config/deploy do not need or publish recipient files. Optional standalone `keygen` refuses existing files. Connecting checks configuration and creation access before saving. Remote Worker URLs require HTTPS; HTTP is only for localhost. Setup output omits the instance token. The sender clicks `send` after filling the request. Wait remains non-interactive: URLs/instructions on stderr, metadata JSON on stdout, WebSocket first, poll only if that socket fails.

`wait KEY...` treats requested labels as hints, not filters. Preserve the entire received payload, including unexpectedly named fields, in a standard binary `.age` receipt; never automatically emit plaintext values to stdout, files, or the global environment. Stdout is `{names: string[], file: absoluteAgeFilePath, identity?: localIdentityFilePath}`; `identity` is a path, never key contents. Receipts live in `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/inbox`, files 0600 in private 0700 directories. The default local `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/age-identity.txt` is generated once (0600), reused, and never overwritten. `PODAJ_AGE_IDENTITY` selects an existing native age identity file; `PODAJ_AGE_RECIPIENT` selects a native public age recipient, takes precedence, and never loads/creates a local identity. This unencrypted local identity is separate from transport RSA keys and optional legacy `PODAJ_KEY_DIR`/`keygen` helpers. Use the pinned `age-encryption` Node package, not an external binary; no automatic SSH/GPG scanning or arbitrary SSH-key support. Explicit `podaj decrypt [--identity <file>] <file.age>` prints plaintext to stdout and also accepts encrypted stdin; native `age --decrypt --identity <identityPath> <file.age>` interoperates. Keep explicit standalone `PODAJ1.` decryption. No daemon or OS-keychain implementation. Receipts survive successful completion and CLI exit, but do not promise crash/network-loss recovery or protection from a compromised user/device.

## Cloudflare targets

- Hosted demo: account `podaj` on Workers Free, hostname `podaj.fyi`. The actual Deploy to Cloudflare button can provision `podaj/podaj`; no separate test account is required. Account `hasparus`, Worker `podaj`, is an optional button-test target, not a substitute manual CLI deployment.
- `.pi/mcp.json` provides one OAuth connection, `cloudflare-podaj`, for accounts `podaj` and `hasparus`. Select only these two accounts, not all accounts, and use explicit account IDs in API calls. Server names/descriptions do not enforce account restrictions; grant only the intended resources and permissions. Use MCP for inspection and Wrangler for deployments.
- Ignored `.cloudflare/test.env` and `.cloudflare/demo.env` hold explicit account IDs and optional account-scoped API tokens. Never put management credentials in `.dev.vars`, Worker vars, logs, or chat.
- `bun run cf:test ...` / `bun run cf:demo ...` pin Wrangler to the selected account and Worker. They allow only `whoami`, `login`, `secret list`, and explicit `secret put NAME`. Secret writes mutate the Worker and need owner approval. Missing account IDs fail closed; inherited shell API tokens are not used. Empty profile tokens use Wrangler's stored OAuth session. No deployment or secret rotation is authorized by preparing these files.
- Handoff retention defaults to 7200 seconds (2 hours), configured with `HANDOFF_TTL_SECONDS`; supported private-instance overrides are whole seconds from 60 to 86400. Changing configuration does not rewrite existing records' TTLs.

## UI (Direction A · Zinc Ledger)

- Transport recipient public key comes from the CLI-encrypted request context, authenticated by the fill link's fragment secret; its private key stays in CLI memory. Optional short fingerprint in the header — **no environments list or sidebar**
- Dense lowercase chrome: brand, headings, `key` | `value`, `add`, `send`. Body and status copy use sentence case, including `Sent.` No human-facing `create link` action. Use the vendor-neutral `VARIABLE_NAME` placeholder. See `design.md`
- Row icons from `pixelarticons` (`eye` / `eye-off` / `trash`) render as 0.875rem glyphs (14px at the default text size); button hit targets are sized independently of glyph sizing. Keep `aria-label` `show` / `hide` / `remove`. Show and hide only when the value is non-empty
- CLI stages an encrypted sender context and shares one short `/s/:id#<secret>` link. Public verification at `/authorize/:id#<secret>` returns to the same short fill URL automatically. Requested labels prefill editable rows; no terminal copy/paste or second link. Edits stay local until explicit `send`. Legacy expanded fill links remain readable.
- Browser pages never collect or decrypt handoffs. The CLI holds collection authority and decrypts locally.
- Footer on the fill page: plain-language security (see `HOW_IT_WORKS` in `src/client/user-facing.ts`)
- Env-var handoff only (not vault fields). Names are labels, not shell identifiers: allow spaces, punctuation, and sentences; require non-empty, unique names. The receiving agent interprets them.
- User-facing copy: plain language only — wire format (`PODAJ1.`) stays in code/docs for implementers

## Fence (rat-stack subset)

Aligned with [rat-stack fence](https://ratstack.sh/systems/fence) for this single package (no monorepo):

- `bun run check` — `tsrs` typecheck (app + key scripts) and type-aware `oxlint` with **Ultracite core**
- `bun run test`
- Lefthook runs both on commit; `scripts/vcs-command-policy.ts` blocks `git --no-verify` (agent hook source: `scripts/hooks/block-git-no-verify.ts`; compiled Node hook: `dist/scripts/hooks/block-git-no-verify.js`)

Foldkit client: `src/client/app.ts` (program) + `src/client/entry.ts` (Runtime boot). `@foldkit/vite-plugin` + `@foldkit/oxlint-plugin` on `src/client/**`.

## Invariants

- Variable-bundle network ciphertext uses only the `PODAJ1.` prefix; local receipts use standard binary age files. Short-link contexts use separate authenticated AES-256-GCM ciphertext bound to the handoff ID; their fragment key and all collection secrets stay off the server.
- Stored variable bundles are ciphertext only; server delivery metadata must not contain plaintext variable names or values. Local stdout metadata may list names, never values or key material. No private keys on the server or in git; only transport private keys must remain memory-only.
- Product is KEY+value env vars, not login credentials
- Envelope `env` slug is `default`; each request binds its CLI-generated recipient public key
