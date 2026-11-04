# Security

podaj encrypts **environment variable bundles** (`{ vars: [{ key, value }] }`) in the browser and stores only sealed blobs on the Worker. Plaintext and private keys never touch the Worker.

## Cryptography

- AES-256-GCM content encryption, RSA-OAEP-256 (SHA-256) key wrap.
- Wire format: `PODAJ1.` + base64(JSON with `iv`, `ciphertext`, `wrappedKey`, `env`, `v`). Envelope `env` is `default` for the single recipient key.

## Worker

- CSP, origin check on `POST /api/handoffs`, body size limit (`MAX_HANDOFF_BYTES`, default 32768).
- One-shot read then delete; 24h TTL if unread.
- Only `PODAJ1.` accepted (no legacy prefixes).

## Client

- Status text uses `textContent` only (no `innerHTML` on success paths).
- Decryption uses a local file picker; private keys are not uploaded.

## Git

- Never commit `private.pem`. Deploy-time recipient key: `public/recipient.pem` (gitignored; use `recipient.pem.example` as template).

Handoff URLs are capability URLs — treat links as secrets.
