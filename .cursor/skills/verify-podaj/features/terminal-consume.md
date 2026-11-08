# Terminal consume and one-shot semantics

- After browser **send**, the CLI receives readiness over its capability-authenticated WebSocket; only socket failure enables status polling. Status/navigation/GET/HEAD do not consume.
- Only `POST /api/handoffs/:id/consume` with that request's read Bearer capability collects ciphertext. The terminal validates recipient identity and decrypts locally with its memory-only key.
- Require exit 0 and stdout JSON exactly equal to `{"PODAJ_VERIFY_A":"synthetic-alpha","PODAJ_VERIFY_B":"synthetic beta=with spaces & symbols"}` (compare parsed objects, not whitespace). Prompts/link belong on stderr, never mixed into JSON.
- Inspect only the run's local SQLite if storage proof is needed: pending → ready ciphertext → consumed with ciphertext removed. No plaintext names/values, raw capabilities, owner token, or private key may be stored. Hashes/metadata are expected; do not publish a raw dump.
- A same-read-capability consume replay returns **410**. Atomic consume and the authenticated replay are proven by `test/worker-runtime.test.ts`; a random-token 401, random-ID check, or reopened fill page proves neither.
- Do not instrument the CLI to expose its hidden read capability for manual replay. Report runtime-test replay evidence separately from the compiled-CLI/browser journey.
- Fill is single-assignment: concurrent/repeated PUTs cannot overwrite/resurrect a handoff (409); only one concurrent consume wins. Runtime tests also prove cross-role/cross-slot rejection and native socket close/release.
- Default retention is 7200 seconds; private supported overrides are whole seconds 60–86400. Use existing expiry/runtime tests rather than sleeping for hours or changing the verification instance's protocol.
