# Human fill, explicit send

Open only the complete CLI-emitted `/s/:id#write=…&recipient=…` URL for secret entry. Do not construct fragments, navigate to a receive page, upload keys, or create a reservation in the browser.

1. Use a unique `agent-browser --session "$SESSION"`; take an interactive snapshot and use its current refs or accessible labels `key` / `value`. Wait for recipient validation and configured limits to load.
2. Fill `PODAJ_VERIFY_A=DUMMY-alpha`; click **add** and fill `PODAJ_VERIFY_B=DUMMY beta=with spaces & symbols`, then add `deployment note=DUMMY-unexpected`. The third name was not requested and is deliberately not a shell identifier: requested labels are hints, not filters. Values start masked. Exercise **show**, **hide**, **remove**, and .env paste with synthetic rows if relevant; restore these three rows before sending. Keep values masked or redact them in shared screenshots/snapshots.
3. Assert edits/reveal/paste/navigation have not uploaded a handoff: inspect localhost request metadata and the still-waiting CLI. Loading may GET `/api/config`; typing must not PUT. Refs can change after Foldkit renders: wait for expected DOM state, not a fixed sleep.
4. Click **send** once. Expect a single `PUT /api/handoffs/:id` carrying write Bearer authority and JSON `{sealed: "PODAJ1.…"}`. Both names and values are encrypted before HTTP; no HTTP plaintext payload or private keys are permitted. Keep capture synthetic and redact authority; do not retain visible plaintext values or key material in shared proof.
5. Wait for `.status.ok` containing `Sent.`; values clear and form controls lock. Capture the result, compare terminal metadata, and explicitly decrypt the local receipt to compare all three fields; the browser never displays decrypted received values or a new share link.

Negative checks: incomplete fragment cannot load/send; empty/unfinished rows or duplicate names show errors without PUT; non-empty unique labels may contain spaces, punctuation, or sentences; oversize encrypted payload is rejected before upload. Use `test/client-app.test.ts` and route tests for exact cases, not invented selectors.

No plaintext names/values, private keys, owner secret, read token, or subscribe token may appear in HTTP request bodies from this page. The public key/write capability are intentionally in the URL fragment, not its query or path.
