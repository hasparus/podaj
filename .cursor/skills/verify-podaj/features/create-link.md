# Create link

The sender turns env-var rows into a URL that works once.

## Sub-features

- Header shows `podaj` and a 16-hex key id (`.key-meta`) = first 16 hex of SHA-256 over the SPKI in `/recipient.pem`. It must match the run key: `openssl pkey -pubin -in "$KEY_DIR/public.pem" -outform DER | sha256sum | cut -c1-16`.
- Rows: key input (placeholder `OPENAI_API_KEY`), value input (`type=password`), **Show**/**Hide** toggles that row's value visibility, **Remove** (disabled while only one row is left).
- **Add** appends an empty row.
- **Create link** seals the non-empty rows in the browser, POSTs to `/api/handoffs`, and shows `.status.ok` with `Share this once.` on line 1 and `<origin>/h/<32 hex>` on line 2. All values are cleared afterwards; keys stay.
- With no complete row, **Create link** shows `.status.error` `Add a key and value.` and creates nothing.
- Footer `.site-footer` explains how it works (the `HOW_IT_WORKS` constant).

## How to get to it (user POV)

Open the site root (`$URL/`). The table is right there: type a key and a value, click **Add** for more rows, then **Create link**. Copy the URL from the box under the buttons.

## Driving it with agent-browser

```bash
source "$ENV_FILE"; AB="/home/box/.local/bin/agent-browser --session $SESSION"
$AB open "$URL/"; $AB wait --text "Create link"
$AB find nth 0 'input[placeholder="OPENAI_API_KEY"]' fill PODAJ_VERIFY_A
$AB find nth 0 'input[placeholder="Value"]' fill alpha
$AB find role button click --name "Add"
$AB wait --fn 'document.querySelectorAll("input[placeholder=OPENAI_API_KEY]").length === 2'
$AB find nth 1 'input[placeholder="OPENAI_API_KEY"]' fill PODAJ_VERIFY_B
$AB find nth 1 'input[placeholder="Value"]' fill 'beta=with spaces & symbols'
$AB find role button click --name "Create link"
$AB wait ".status.ok"; $AB get text ".status.ok"
```

Or: `./scripts/journey.sh "$ENV_FILE" create-link` (evidence `01`–`03`, `handoff-url.txt`).

Proven when `.status.ok` line 1 is exactly `Share this once.`, line 2 matches `^$URL/h/[a-f0-9]{32}$`, every value input is empty, and `wrangler.log` shows `POST /api/handoffs 201`.

## Gotchas

- `.key-meta` shows up a moment after **Create link** has rendered, because the fingerprint is computed asynchronously. Wait for `.key-meta` before reading it, not for the button text.
- Foldkit re-renders on the next frame. A `get count .var-row` straight after **Add** still returns the old count, so wait with `wait --fn`.
- The send rows sit next to `.var-head` inside `.var-table`, so `.var-row:nth-of-type(n)` is off by one. Use `find nth <i> 'input[placeholder=...]'`.
- The inputs have no `<label>`; the accessible name is the placeholder (`textbox "OPENAI_API_KEY"`, `textbox "Value"`).
- A missing or non-PEM `/recipient.pem` replaces the page with `This site isn't set up yet.` or `No recipient key is configured yet.`. `launch.sh` always writes one into the run's dist. Checkouts before `1e4a267` loaded `/environments.json` (first entry's `publicKeyPem`) instead; this skill targets `recipient.pem` only.
- Don't create links on production. Its key belongs to the owner, so you couldn't open the result.
