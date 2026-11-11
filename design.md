# zinc ledger

podaj is one dense column. one recipient key in the header. no environments list and no sidebar.

## copy

Brand, headings, and short action labels stay lowercase: podaj, key, value, add, send. Body and status copy use normal sentence case: “Loading request…”, “Sent.”, and “Verified. Opening your request…”

the CLI creates the request link. the human browser only fills it and sends. no browser recipient creation, key generation, private-key picker, or decryption view.

Do not shout `PODAJ` or `KEY` in the interface. Use the vendor-neutral `VARIABLE_NAME` placeholder for env names. It is an example, not a label.

Names are labels, not shell identifiers. Allow punctuation, spaces, and sentences; require non-empty, unique names. The receiving agent interprets them.

Keep error copy short: name the limit and next action. Put configuration details under “Owner settings”. Omit missing-data caveats. Only the hosted demo suggests self-hosting. Never invent quotas, reset times, or settings.

## icons

Row actions use [pixelarticons](https://pixelarticons.com/mini/) via the `pixelarticons` package (24×24 viewBox, rendered as 12px glyphs in `currentColor`). Button hit targets are sized independently of the glyphs:

- `eye` shows a value
- `eye-off` hides it
- `trash` removes the row

the accessible names stay lowercase: show, hide, remove.

show and hide render only when that row's value is non-empty. an empty row has remove only.
