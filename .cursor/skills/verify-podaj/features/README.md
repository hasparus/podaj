# Feature map

Canonical path: terminal `wait` → human fills CLI URL → terminal JSON. Source anchors are repository-relative; these documents are relative to this skill.

| Feature | Manual proof | Automated/source anchors |
| --- | --- | --- |
| [CLI request](cli-request.md) | Compiled CLI emits a complete fill URL; no persisted keypair | `scripts/podaj.ts`, `scripts/instance.ts`, `test/cli-lifecycle.test.ts` |
| [Human fill](human-fill.md) | Only explicit **send** uploads; success clears values | `src/client/app.ts`, `src/client/parse-route.ts`, `test/client-app.test.ts` |
| [Terminal consume](terminal-consume.md) | Exact JSON on stdout; terminal exits successfully | `scripts/wait-ready.ts`, `src/handoffs/party.ts`, `test/worker-runtime.test.ts` |

The landing page only directs users to the CLI. There is no browser-created link, browser receiver, private-key picker, or destructive GET workflow. Storage is a SQLite-backed Durable Object. Subscriptions authenticate with per-handoff capabilities.

Demo enrollment is a separate `/authorize#challenge=…&recipient=…` page before reservation, not the secret-entry page. Keep localhost private-mode manual proof separate from automated demo authorization/siteverify fixtures; do not contact Turnstile or configure real demo credentials for this journey.
