# podaj

Share environment variables once via a link. You add keys and values in the browser; the recipient opens the link with their key file and copies what they need.

Deploy it to **your** Cloudflare account. There is no shared podaj. The old upstream URL is closed.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hasparus/podaj)

The button clones this repo into your Git account, provisions the KV namespace and the PartyServer Durable Object, and turns on Workers Builds so later pushes deploy themselves.

## After the button

1. `pnpm keygen` writes `~/.local/share/podaj/public.pem` and `private.pem`. Never commit the private key.
2. Copy the public key to `public/recipient.pem` and push. Workers Builds redeploys.
3. Set an instance token (dashboard secret, or `npx wrangler secret put PODAJ_TOKEN`).
4. Open your `*.workers.dev` URL and enter that token once. It stays in this browser for the tab session.

Anyone without the token gets nothing: the API and the ready WebSocket stay shut, and localhost is the only open host (for `pnpm dev`).

Manual path, if you clone instead of using the button:

```bash
pnpm install
npx wrangler login
npx wrangler kv namespace create podaj-handoffs
```

Put the new namespace id in `wrangler.jsonc` (`HANDOFFS`). The committed id is a placeholder so a fork does not bind someone else's namespace. Then `pnpm deploy`.

GitHub Actions on a **clone** (not this upstream repo) deploys `main` when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set. See [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml).

## How it works

Values are locked in the browser with the recipient's public key before upload. Each link works once. The database keeps only the sealed bundle. Plaintext and your private key never leave the browser.

For wire format and Worker limits, see [SECURITY.md](./SECURITY.md).

## Fence

```bash
pnpm install
pnpm check      # tsrs typecheck + oxlint (Ultracite core, type-aware)
pnpm test
```

Pre-commit runs `pnpm check` and `pnpm test` (lefthook). Hook bypass via `git --no-verify` is blocked for agent shells (`scripts/vcs-command-policy.js`).

## Develop

```bash
pnpm dev        # build client + wrangler dev (localhost needs no token)
pnpm deploy     # vite build + wrangler deploy
```

## CLI

```bash
pnpm podaj keygen
pnpm podaj reserve "$PODAJ_URL"          # PODAJ_TOKEN required off localhost
pnpm podaj wait <handoff-id> "$PODAJ_URL"
pnpm podaj decrypt                       # PODAJ1 blob on stdin, private key on disk
```

`reserve` returns `sendUrl` (open, paste vars — **autosaves**) and `receiveUrl` (one-shot pickup). The write secret stays in the `sendUrl` hash until upload.

`wait` listens on `wss://…/parties/handoff-party/<id>`. It polls `GET /api/handoffs/<id>/status` only if that socket never opens or drops first. The compose page also fires a `podaj:ready` browser event when upload finishes.

## Usage

1. Put the recipient public key in `public/recipient.pem`. The header shows a short id for that key.
2. Enter the instance token if this is not localhost.
3. Add rows (or paste a `.env`), then **create link**.
4. Send the recipient URL. It works once.
5. Recipient opens the link, chooses **key file**, reads the table.

## What we cut

No password vault, auth profiles, or MCP server — only this handoff, a small CLI, wrangler, and a vite client. See [AGENTS.md](./AGENTS.md) and [PRODUCT.md](./PRODUCT.md).
