# podaj

Pass things securely to your remote bots — one-shot encrypted handoffs on Cloudflare Workers.

Encrypt credentials in the browser with an environment public key (`PODAJ1.` ciphertext only), store a single-use blob in KV, and decrypt locally with the matching private key.

Live worker: **https://podaj.hasparus.workers.dev**

## Stack

- Cloudflare Worker (`podaj`) + KV
- Hono API, static UI (Vite)
- AES-256-GCM + RSA-OAEP-256 (`PODAJ1.` format)

See [SECURITY.md](./SECURITY.md) for CSP, origin checks, size limits, and key handling.

## Quick start

```bash
npm install
npm run keygen
```

Keys are written to `~/.local/share/podaj/` (`public.pem`, `private.pem`). **Never commit `private.pem`.**

Copy the public key into `public/environments.json` (start from `public/environments.json.example`):

```bash
node -e "
const fs=require('fs');const os=require('os');const path=require('path');
const pem=fs.readFileSync(path.join(os.homedir(),'.local/share/podaj/public.pem'),'utf8');
const envs=[{slug:'default',name:'Default',description:'Primary handoff target',publicKeyPem:pem}];
fs.writeFileSync('public/environments.json', JSON.stringify(envs, null, 2));
"
```

## KV namespace

Create a KV namespace and set its id in `wrangler.jsonc`:

```bash
npx wrangler kv namespace create HANDOFFS
# replace REPLACE_AFTER_kv_namespace_create in wrangler.jsonc with the returned id
```

## Develop

```bash
npm run build
npx wrangler dev
```

## Deploy

```bash
npm run deploy
```

This runs `vite build` then `wrangler deploy` for the **`podaj`** worker (default URL: `https://podaj.hasparus.workers.dev`).

Ensure you are logged in (`npx wrangler login`) and that `wrangler.jsonc` has a real KV namespace id.

## Usage

1. Open the app, pick an **Environment** (GitHub/Vercel-style sidebar).
2. Fill auth profile, login URL, username, password → **encrypt & send**.
3. Share the one-time `/h/{id}` link with the recipient.
4. Recipient opens the link, selects `~/.local/share/podaj/private.pem`, and decrypts in the browser.

## Environments UI

Each environment in `public/environments.json` maps a human name to an RSA public key. Add multiple entries for staging/production targets; the sidebar switches active encryption keys without redeploying Worker code (redeploy after editing the JSON).

## License

MIT
