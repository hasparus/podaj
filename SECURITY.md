# security

## boundary

The CLI generates a fresh memory-only RSA-2048 transport keypair for each request. Only its public key leaves the process. The human's browser encrypts the entire `{ vars: [{ key, value }] }` bundle before upload with AES-256-GCM and RSA-OAEP/SHA-256 key wrapping. The CLI decrypts locally. Browser code and extensions remain trusted; a malicious host can serve code that reads plaintext.

Variable bundles use the network ciphertext prefix `PODAJ1.`; local receipts use standard binary age files. The separate encrypted request context described below does not change variable-envelope encryption. Version 1 envelopes contain `iv`, `ciphertext`, `wrappedKey`, `env: "default"`, and `v: 1`. Environment-variable names are inside the encrypted payload, not server metadata.

## local receipts and keys

After collection, `wait` decrypts the transport payload in memory and encrypts the entire payload into a local `.age` file. Requested labels are hints, not filters; no received fields or values are discarded. Automatic stdout is only `{names: string[], file: absoluteAgeFilePath, identity?: localIdentityFilePath}`. The identity field is a path, never key contents. URLs/instructions remain on stderr; plaintext values are never automatically written to stdout, files, or the global environment.

Receipts are stored in `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/inbox`, files 0600 in private 0700 directories. The default `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/age-identity.txt` is generated once with mode 0600, reused, and never overwritten. `PODAJ_AGE_IDENTITY` selects an existing native age identity file. `PODAJ_AGE_RECIPIENT` selects a native public age recipient, takes precedence, and never loads or creates a local identity; stdout then omits `identity`. No SSH/GPG key scanning or arbitrary SSH-key compatibility is provided by the bundled Node implementation. The pinned `age-encryption` package needs no external age binary.

The local age identity is separate from request transport keys and optional legacy `PODAJ_KEY_DIR`/`keygen` helpers. It is unencrypted and readable by the owning user. Encrypted receipts reduce accidental plaintext artifacts; they do not defeat a compromised user or device. There is no daemon or OS-keychain implementation. Protect the identity: losing it can make receipts unreadable.

Explicit `podaj decrypt [--identity <file>] <file.age>` prints plaintext to stdout and also accepts encrypted stdin. Native `age --decrypt --identity <identityPath> <file.age>` interoperates. Explicit standalone `PODAJ1.` decryption remains supported.

## authority and persistence

One fixed SQLite Durable Object stores encrypted variable bundles and request contexts, recipient fingerprints, capability hashes, expiry/state, and bounded admission counters. No plaintext variables, recipient private keys, raw handoff capabilities, or raw admission verifiers are stored. IP admission counters use daily hashes and are not a guarantee of anonymity. Admission counters expire after two days; credentials expire after two hours.

Write, read, and subscribe capabilities are independent random 256-bit values. New fill URLs are `/s/:id#<secret>`: the path identifies an encrypted request context, and the fragment holds its independent, random 256-bit AES key. The CLI encrypts the recipient public key, write capability, requested labels, and optional public-admission challenge with AES-256-GCM using a fresh 96-bit nonce. Associated data binds the context version and handoff ID, so ciphertext modification or cross-ID substitution fails authentication. The fragment key never enters HTTP requests; read/subscribe capabilities, admission verifiers, and transport private keys never enter the context. Legacy expanded fill links and the published two-field authorization flow remain supported for older CLIs. Every operation checks its own slot/role. Write authority and approved demo credentials are checked before processing request bodies and rechecked transactionally when committing changes.

State changes are atomic: `pending → ready → consumed`. Cleanup is armed before allocating records or charging quotas, so a scheduling failure cannot hide a committed reservation. Fill and collection acknowledgements do not depend on post-commit cleanup. Only `POST /api/handoffs/:id/consume` collects; GET, status, and navigation never consume. Consumption removes both the variable ciphertext and encrypted request context. Concurrent fills and collections have one winner; consumed slots cannot be refilled.

Default retention is two hours from reservation, restarted only by the first successful fill. A fill never shortens an existing deadline. Private `HANDOFF_TTL_SECONDS` overrides accept whole seconds from 60 through 86400. Demo retention is capped at two hours. Configuration changes do not rewrite existing record expiry. Alarms clean expired rows, but authorization checks expiry independently of alarms.

## short-link drafts

The CLI stages an encrypted context before public verification. Context staging does not reserve a handoff or grant collection authority. Staging binds the context to a hash of its future write capability; activation requires a live draft with that hash and extends context expiry to the handoff expiry. Missing or expired drafts fail without spending reservation quota. A successful fill extends both expiries. Unreserved drafts expire after three minutes. Encoded contexts are bounded to 32 KiB; staging is capped at 500/day, ten/IP/minute, and 200 live unreserved drafts. Active contexts are additionally bounded by the handoff limit. Duplicate IDs cannot overwrite contexts, including across reservations. Expiry is checked on reads and cleaned by alarms.

The browser fetches ciphertext by ID, decrypts locally, and prefills editable labels. On public instances it automatically visits `/authorize/:id` for verification, then returns to the same short fill link without a terminal round trip. Writer-only `/api/handoffs/:id/writable` reports only whether the write capability is authorized; it exposes neither ciphertext nor collection/readiness capabilities.

## admission and resource limits

Workers default to `PODAJ_ACCESS=private`; private creation requires `PODAJ_API_AUTH_SECRET` off localhost. It is an application credential, not a Cloudflare management token or encryption key. It never reaches the human's browser. Config files are atomically replaced with mode 0600 inside a private directory; saved credentials are not reused for a different `PODAJ_URL` origin.

`PODAJ_ACCESS=public` requires a verified, recipient-bound credential for handoff reservation, including on the hosted demo. Encrypted drafts can be staged before verification under separate limits. Private staging requires the instance credential. Turnstile runs only on authorization pages, away from entered variable values and transport private keys. The authorization page can decrypt the sender context; its scripts remain within the trusted browser-code boundary. Siteverify must confirm the hostname, `podaj-admission` action, and `SHA256(challenge + "." + recipientFingerprint)` cdata. The browser sees a challenge, never its verifier. Missing verification settings or the rate-limit binding refuse new admission; existing scoped delivery capabilities do not require working captcha configuration.

Limits: 200 reservations/day and live slots, five reservations/credential/day, 32 KiB demo ciphertext, 500 verification attempts/day, ten attempts/IP/minute, and 200 approvals/day. The transport limiter admits 60 requests/IP/minute. Native hibernating sockets are capped at 20 globally, two/slot, and ten minutes each; socket expiry falls back to polling rather than declaring a live handoff gone. HTTP bodies have byte limits, strict JSON/envelope validation, and a ten-second read deadline.

API/document responses use no-store, origin checks, framing restrictions, and route-specific CSP. Third-party scripts are forbidden on the fill page. Static assets bypass the Worker with strict headers. Routine Worker tracing is disabled. `podaj.hasparus.workers.dev` is blocked.

The hosted demo is intended for Workers Free: quota exhaustion means temporary unavailability, not an automatic paid upgrade. Application counters do not replace platform quotas or an operator's responsibility to avoid enabling paid services.

## delivery limits and verification

At-most-once collection cannot recover a lost response. Consumption also precedes transport decryption and local receipt completion; request a new handoff on failure. A receipt persists after successful completion and CLI exit, but does not guarantee recovery from crashes or network loss. Missing requested labels do not cause fields to be filtered or discarded. A lost PUT acknowledgement may leave the browser unable to confirm an already completed send. Links remain bearer capabilities: share only with the intended human.

Local tests cover actual workerd HTTP/RPC/SQLite, authorization scopes, races, expiry, quota transactions, native socket closure, streaming limits, CLI transport-key custody, and encrypted local receipt handling. Siteverify replies are controlled in tests; live Turnstile, the deploy button, and hosted deployment still require rollout verification. This is not a security certification.
