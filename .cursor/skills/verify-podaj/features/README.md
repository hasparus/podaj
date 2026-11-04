# podaj feature map

User-facing features of the podaj SPA, each driven through `scripts/journey.sh` or by hand with agent-browser (see `../SKILL.md` Drive). A proof that touches one feature isn't a proof for the others.

| Feature | File | Entry point | Journey |
| --- | --- | --- | --- |
| Create a one-shot link | [create-link.md](create-link.md) | `/` | `journey.sh "$ENV_FILE" create-link` |
| Open a handoff with a key file | [receive-handoff.md](receive-handoff.md) | `/h/<id>` | `journey.sh "$ENV_FILE" receive-handoff` |
| Link is gone after one open | [one-shot-gone.md](one-shot-gone.md) | `/h/<id>` again, `GET /api/handoffs/<id>` | `journey.sh "$ENV_FILE" one-shot-gone` |

`receive-handoff` and `one-shot-gone` consume the URL that `create-link` wrote to `$EVIDENCE/handoff-url.txt`. Run them in that order, or run `all`.

Not mapped yet: the CLI (`podaj init`, including `--url` with `PODAJ_TOKEN` on stdin and `--deploy`; `podaj wait KEY`; `podaj decrypt` with `PODAJ_KEY_DIR=<dir>` reading a `PODAJ1.` blob on stdin) and the error copy in `src/client/user-facing.ts`, such as "Add a key and value." and "That key file didn't open this handoff.".
