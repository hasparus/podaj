# One-shot gone

A link works exactly once; every later open says so and offers nothing to decrypt.

## Sub-features

- UI: a second open of `/h/<id>` shows `.status.error` `This link was already used or expired.` and no **Key file** picker.
- API: `GET /api/handoffs/<id>` returns `410 {"error":"gone"}` after the first read. The same applies to ids that were never issued and to entries past their 24h `expirationTtl`.
- Malformed ids (not 32 lowercase hex) never reach the API route. The SPA treats them as the send page, and the API returns `404 not found`.

## How to get to it (user POV)

Open the same link a second time, or have anyone else open it after you did. The page just says it was already used.

## Driving it with agent-browser

```bash
source "$ENV_FILE"; AB="/home/box/.local/bin/agent-browser --session $SESSION"
url=$(cat "$EVIDENCE/handoff-url.txt")
$AB open "$url"; $AB wait ".status.error"; $AB get text ".status.error"
$AB eval '!!document.querySelector("#key-file")'        # false
curl -s -w ' %{http_code}\n' "$URL/api/handoffs/${url##*/}"   # {"error":"gone"} 410
```

Or: `./scripts/journey.sh "$ENV_FILE" one-shot-gone` (evidence `06`, `07-api-second-get.json`).

Proven when the UI message matches exactly, the picker is absent, and the API returns `410`. Run it only after receive-handoff has consumed the link. Otherwise the check proves nothing, and your own GET is the first read.

## Gotchas

- Don't prove "gone" by curling twice: the first curl is the consuming read and skips the UI. Consume the link through receive-handoff, then check here.
- The 24h TTL path can't be checked quickly with local KV. Only the delete-on-read path is mapped.
- The doctor's `410` on a random id proves the KV binding answers, not that one-shot delete works. Only this journey proves that.
