# podaj

Share environment variables once via a link. You add keys and values in the browser; the recipient opens the link with their key file and copies what they need.

Deploy it to **your** Cloudflare account. There is no shared podaj. The old upstream URL is closed.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hasparus/podaj)

The button clones this repo into your Git account, provisions the KV namespace and the PartyServer Durable Object, and turns on Workers Builds so later pushes deploy themselves.

## From a checkout

One command does the rest: a new recipient keypair, a Worker in your Cloudflare account, and `~/.config/podaj/config.json` (`url` + `token`).

```bash
bun install
bunx wrangler login
bun run podaj init
```

Anyone without the token gets nothing: the API and the ready WebSocket stay shut, and localhost is the only open host (for `bun run dev`). The fill link `podaj wait` prints already carries the token in the URL fragment, so the browser stores it for that tab.

GitHub Actions on a **clone** (not this upstream repo) deploys `main` when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set. See [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml).

## How it works

Values are locked in the browser with the recipient's public key before upload. Each link works once. The database keeps only the sealed bundle. Plaintext and your private key never leave the browser.

For wire format and Worker limits, see [SECURITY.md](./SECURITY.md).

## Fence

```bash
bun install
bun run check      # tsrs typecheck + oxlint (Ultracite core, type-aware)
bun run test
```

Pre-commit runs `bun run check` and `bun run test` (lefthook). Hook bypass via `git --no-verify` is blocked for agent shells (`scripts/vcs-command-policy.js`).

## Develop

```bash
bun run dev        # build client + wrangler dev (localhost needs no token)
bun run deploy     # vite build + wrangler deploy
```

## CLI

```bash
bun run podaj init
bun run podaj wait OPENAI_API_KEY ANTHROPIC_API_KEY
bun run podaj decrypt                 # PODAJ1 blob on stdin
```

`init` writes `~/.local/share/podaj/{public,private}.pem`, deploys, and saves the global config.

`wait` reserves a compose link, prints it, and blocks on the handoff WebSocket (status poll only if that socket drops). When the page has uploaded, it reads the one-shot bundle, decrypts with the local private key, and prints JSON for the keys you named. Omit the names to print every pasted key.

## Usage

1. Put the recipient public key in `public/recipient.pem`. The header shows a short id for that key.
2. Enter the instance token if this is not localhost.
3. Add rows (or paste a `.env`), then **create link**.
4. Send the recipient URL. It works once.
5. Recipient opens the link, chooses **key file**, reads the table.

## What we cut

No password vault, auth profiles, or MCP server — only this handoff, a small CLI, wrangler, and a vite client. See [AGENTS.md](./AGENTS.md) and [PRODUCT.md](./PRODUCT.md).
