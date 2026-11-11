# Feature map

Canonical path: terminal `wait` → human fills CLI URL → encrypted local receipt + metadata JSON → explicit decrypt when needed. Source anchors are repository-relative; these documents are relative to this skill.

| Feature | Manual proof | Automated/source anchors |
| --- | --- | --- |
| [CLI request](cli-request.md) | Compiled CLI emits a complete fill URL; transport keys stay in memory; separate local age identity persists | `scripts/podaj.ts`, `scripts/instance.ts`, `test/cli-lifecycle.test.ts` |
| [Human fill](human-fill.md) | Only explicit **send** uploads; success clears values | `src/client/app.ts`, `src/client/parse-route.ts`, `test/client-app.test.ts` |
| [Terminal consume](terminal-consume.md) | Metadata-only stdout + private binary age receipt; explicit DUMMY decryption matches every field | `scripts/age-output.ts`, `scripts/decrypt-handoff.ts`, `scripts/wait-ready.ts`, `src/handoffs/party.ts`, `test/age-output.test.ts`, `test/cli-lifecycle.test.ts`, `test/worker-runtime.test.ts` |

Requested KEY labels are hints, not filters. All received fields and values belong in the encrypted receipt; metadata `identity` is a file path, never key contents. Network `PODAJ1.` encryption is unchanged. The local age identity is unencrypted, separate from transport RSA keys and optional legacy `PODAJ_KEY_DIR`/`keygen` helpers; no SSH/GPG scanning, daemon, or OS keychain is implemented.

The landing page only directs users to the CLI. There is no browser-created link, browser receiver, private-key picker, or destructive GET workflow. Storage is a SQLite-backed Durable Object. Subscriptions authenticate with per-handoff capabilities.

Demo enrollment is a separate `/authorize#challenge=…&recipient=…` page before reservation, not the secret-entry page. Keep localhost private-mode manual proof separate from automated demo authorization/siteverify fixtures; do not contact Turnstile or configure real demo credentials for this journey.
