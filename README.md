# podaj

One-shot encrypted handoffs for **environment variables** (KEY + secret value) to your remote agents.

Encrypt in the browser with an environment public key (`PODAJ1.` only), store ciphertext once in Cloudflare KV, share the link, decrypt locally with the matching private key.

Live: **https://podaj.hasparus.workers.dev**

## Fence (local gate)

```bash
pnpm install
pnpm check      # tsrs typecheck + oxlint (type-aware via tsrs-lint)
pnpm test       # PODAJ1 roundtrip
```

Pre-commit runs `pnpm check` and `pnpm test` (lefthook). Hook bypass via `git --no-verify` is blocked for agent shells.

## Keys

```bash
pnpm keygen
```

Writes `~/.local/share/podaj/public.pem` and `private.pem` (never commit `private.pem`).

Copy the public key into `public/environments.json` (see `public/environments.json.example`).

## Develop & deploy

```bash
pnpm dev        # build client + wrangler dev
pnpm deploy     # vite build + wrangler deploy (worker `podaj`)
```

KV binding `HANDOFFS` uses namespace `podaj-handoffs` (`87bb68bfae9148e2ae1a5d6781b1e48e` in `wrangler.jsonc`).

## Usage

1. Pick an **Environment** in the sidebar (one or many in `environments.json`).
2. Add KEY + value rows → **Encrypt & send**.
3. Share the one-time `/h/{id}` link.
4. Recipient opens the link, selects `private.pem`, sees decrypted vars (or `pnpm decrypt` on the PODAJ1 blob).

## What we cut

No password vault, auth profiles, MCP/CLI surfaces, or rat-stack monorepo theater — only this handoff, wrangler, vite client, and a minimal fence (`tsrs --lint`, lefthook, hook-bypass block).

See [SECURITY.md](./SECURITY.md).
