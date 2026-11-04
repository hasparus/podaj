# podaj

Pronounced /ˈpɔdaj/.

Share environment variables once via a link. You add keys and values in the browser; the recipient opens the link with their key file and copies what they need.

Deploy it to **your** Cloudflare account. There is no shared podaj. The old upstream URL is closed.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hasparus/podaj)

The button clones this repo into your Git account, provisions the KV namespace and the PartyServer Durable Object, and turns on Workers Builds so later pushes deploy themselves.

## Use it

The button is the path to take. After that Worker exists:

```bash
npm install -g podaj
podaj init
```

The registry name is `podaj`. From a checkout of this repo, `npm install -g .` installs the same bin.

`podaj init` in a terminal asks whether to connect to the Worker you already deployed, or deploy a new one. Connecting asks for the workers.dev URL and the instance token. If the Worker has no token yet, the CLI logs you into Cloudflare in the browser (`wrangler login`) and stores one. Deploying does the same login wait, generates a recipient key, and deploys from this package without editing the installed files. Config lands in `~/.config/podaj/config.json`.

From a checkout, `bun run podaj init` is the same command.

Agents skip the prompts:

```bash
printf '%s\n' "$PODAJ_TOKEN" | podaj init --url https://<name>.workers.dev
podaj init --deploy
podaj wait IMPORTANT_SECRET_KEY
```

The piped value stays out of shell history. `podaj wait` reads a piped token the same way, then `PODAJ_TOKEN`, then the config file.

`--deploy` requires an existing `wrangler login`. The first run creates a KV namespace and stores its id in the config. Later deploys reuse that id.

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
podaj init
podaj wait IMPORTANT_SECRET_KEY
podaj decrypt                 # PODAJ1 blob on stdin
```

`init` writes `~/.local/share/podaj/{public,private}.pem` when it deploys (and when you connect and no key exists yet). A deploy also copies that public key into the staged Worker assets. Connecting keeps the key you already have, because the deployed site encrypts to it.

`wait` reserves a compose link, prints it, and blocks on the handoff WebSocket (status poll only if that socket drops). When the page has uploaded, it reads the one-shot bundle, decrypts with the local private key, and prints JSON for the keys you named. Omit the names to print every pasted key.

## Usage

1. Put the recipient public key in `public/recipient.pem`. The header shows a short id for that key.
2. Enter the instance token if this is not localhost.
3. Add rows (or paste a `.env`), then **create link**.
4. Send the recipient URL. It works once.
5. Recipient opens the link, chooses **key file**, reads the table.

## What we cut

No password vault, auth profiles, or MCP server — only this handoff, a small CLI, wrangler, and a vite client. See [AGENTS.md](./AGENTS.md) and [PRODUCT.md](./PRODUCT.md).
