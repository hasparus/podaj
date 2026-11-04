# Security

podaj encrypts **environment variable bundles** (`{ vars: [{ key, value }] }`) in the browser and stores only sealed blobs in Workers KV. The Worker writes and deletes those rows. Plaintext and private keys never touch the Worker or KV.

## Cryptography

- AES-256-GCM content encryption, RSA-OAEP-256 (SHA-256) key wrap.
- Wire format: `PODAJ1.` + base64(JSON with `iv`, `ciphertext`, `wrappedKey`, `env`, `v`). Envelope `env` is `default` for the single recipient key.

## Worker

- CSP, origin check on API writes, body size limit (`MAX_HANDOFF_BYTES`, default 32768).
- Each deployment is private. Off localhost, `PODAJ_TOKEN` (Worker secret) must match `Authorization: Bearer`. The browser keeps that token in `sessionStorage` after you type it. The upstream host `podaj.hasparus.workers.dev` always answers 404.
- One-shot read then delete; 24h TTL if unread.
- Only `PODAJ1.` accepted (no legacy prefixes).
- Optional `POST /api/handoffs/reserve` creates a pending slot; `PUT /api/handoffs/:id` with `writeToken` fills it. Write tokens are hashed in KV; prefer `sendUrl` with the token in the URL fragment. `GET /api/handoffs/:id/status` reports `pending` | `ready` | `gone` without consuming the handoff.
- Agents may subscribe on `WebSocket /parties/handoff-party/:id` (PartyServer, same bearer token) for a `{ "type": "ready" }` push. Payloads never include sealed env data, only the pickup URL. `podaj wait` uses that socket, and polls status only when the socket cannot stay open.

## Client

- Status text uses `textContent` only (no `innerHTML` on success paths).
- Decryption uses a local file picker; private keys are not uploaded.

## Git

- Never commit `private.pem`. Deploy-time recipient key: `public/recipient.pem` (gitignored; use `recipient.pem.example` as template).

Handoff URLs are capability URLs — treat links as secrets.
