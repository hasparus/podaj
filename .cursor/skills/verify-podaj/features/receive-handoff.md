# Receive handoff

The recipient opens the one-shot URL and decrypts it locally with their private key.

## Sub-features

- On load, `/h/<id>` GETs `/api/handoffs/<id>`. That read deletes the KV entry immediately, before any key is chosen.
- After the GET succeeds, a **key file** row with a `.pem` file input (`#key-file`) appears. The label's title hints `~/.local/share/podaj/private.pem`.
- Picking the matching private key renders a read-only **Key | Value** table (`.var-row-readonly`, `.cell-key`, `.cell-value`) and removes the picker.
- Picking the wrong key shows `.status.error` `That key file didn't open this handoff.`.
- The header shows only `podaj` here (no key id).

## How to get to it (user POV)

Paste the link from the sender into the browser. Click **key file** (the "Choose File" button), pick your `private.pem`, and the values appear in a table to copy.

## Driving it with agent-browser

```bash
source "$ENV_FILE"; AB="/home/box/.local/bin/agent-browser --session $SESSION"
$AB open "$(cat "$EVIDENCE/handoff-url.txt")"; $AB wait --text "key file"
$AB upload "#key-file" "$PRIVATE_PEM"
$AB wait ".var-row-readonly"
$AB eval 'JSON.stringify([...document.querySelectorAll(".var-row-readonly")].map(r=>[r.children[0].textContent,r.children[1].textContent]))'
```

Or: `./scripts/journey.sh "$ENV_FILE" receive-handoff` (evidence `04`, `05`, `05-received.json`).

Proven when the rows equal exactly what create-link sent (same order, values byte-for-byte, including spaces and `&`) and `#key-file` is no longer visible.

## Gotchas

- Opening the URL consumes it. A wrong key file, a reload, or a stray `curl` of the API burns the handoff, and you have to run create-link again.
- The "key file" `<label>` isn't bound to the input (no `for`), so `find label "key file"` fails. Use `#key-file`.
- Only the run's `$PRIVATE_PEM` works with links made on a `launch.sh` instance. Never upload `~/.local/share/podaj/private.pem` (the owner's real key).
- An older vanilla-DOM client (before `af855ec`) left the picker visible after decrypt and on used links, because `.file-row { display:flex }` beat `.hidden`. The journey's "picker gone" check catches that regression.
