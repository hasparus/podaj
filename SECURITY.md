# Security

podaj encrypts **environment variable bundles** (`{ vars: [{ key, value }] }`) in the browser and stores only `PODAJ1.` ciphertext in Cloudflare KV. Plaintext and private keys never touch the Worker.

## Cryptography

- AES-256-GCM content encryption, RSA-OAEP-256 (SHA-256) key wrap.
- Wire format: `PODAJ1.` + base64(JSON with `iv`, `ciphertext`, `wrappedKey`, `env`, `v`).

## Worker

- CSP, origin check on `POST /api/handoffs`, body size limit (`MAX_HANDOFF_BYTES`, default 32768).
- One-shot KV read then delete; 24h TTL if unread.
- Only `PODAJ1.` accepted (no `TAIENC1` / `ENVSEAL1`).

## Client

- Status text uses `textContent` only (no `innerHTML` on success paths).
- Decryption uses a local file picker; private keys are not uploaded.

## Git

- Never commit `private.pem`. Public keys only in `public/environments.json`.

Handoff URLs are capability URLs — treat links as secrets.
