# podaj

Share environment variables once via a link. You add keys and values in the browser; the recipient opens the link with their key file and copies what they need.

Live: **https://podaj.hasparus.workers.dev**

## How it works

Values are locked in the browser with the recipient's public key before upload. Each link works once. The server keeps only the sealed bundle and never sees plaintext or your private key.

For wire format and Worker limits, see [SECURITY.md](./SECURITY.md).

## Fence (rat-stack subset)

```bash
pnpm install
pnpm check      # tsrs typecheck + oxlint (Ultracite core, type-aware)
pnpm test
```

Pre-commit runs `pnpm check` and `pnpm test` (lefthook). Hook bypass via `git --no-verify` is blocked for agent shells (`scripts/vcs-command-policy.js`).

## Keys

```bash
pnpm keygen
```

Writes `~/.local/share/podaj/public.pem` and `private.pem` (never commit `private.pem`).

Copy the public key to `public/recipient.pem` (see `public/recipient.pem.example`).

## Develop & deploy

```bash
pnpm dev        # build client + wrangler dev
pnpm deploy     # vite build + wrangler deploy (worker `podaj`)
```

KV binding `HANDOFFS` uses namespace `podaj-handoffs` (`87bb68bfae9148e2ae1a5d6781b1e48e` in `wrangler.jsonc`).

## Usage

1. Put the recipient public key in `public/recipient.pem`. The header shows a short id for that key.
2. Add rows, then **Create link**.
3. Share the URL. It works once.
4. Recipient opens the link, chooses **Key file**, reads the table. CLI: `pnpm decrypt` on the saved blob if you use scripts.

## What we cut

No password vault, auth profiles, MCP/CLI surfaces, or rat-stack monorepo theater — only this handoff, wrangler, vite client, and a minimal fence. See [AGENTS.md](./AGENTS.md) and [PRODUCT.md](./PRODUCT.md).
