# podaj

Share environment variables once via a link. You add keys and values in the browser; the recipient opens the link with their key file and copies what they need.

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

1. Put the recipient public key in `public/environments.json` (first entry). The header shows a short id for that key.
2. Add rows, then **Create link**.
3. Share the URL. It works once.
4. Recipient opens the link, chooses **Key file**, reads the table. CLI: `pnpm decrypt` on the saved blob if you use scripts.

## What we cut

No password vault, auth profiles, MCP/CLI surfaces, or rat-stack monorepo theater — only this handoff, wrangler, vite client, and a minimal fence (`tsrs --lint`, lefthook, hook-bypass block).

See [SECURITY.md](./SECURITY.md) and [AGENTS.md](./AGENTS.md) for wire format and invariants.
