# podaj

> [!NOTE]  
> I realize this is a bit silly, but not every remote agent UI has a secure secret passing tool, and one of them kept asking me for passwords and immediately screenshotting them.

One-shot environment-variable handoff: your agent creates a link in the CLI, a human fills it in the browser and clicks **send**, and the CLI saves an encrypted local receipt.

```sh
npm i -g podaj
podaj wait API_KEY
```

Requires Node.js 22+. Uses the public demo at `https://podaj.fyi` by default (no deployment or configuration needed). Approve the request in your browser, then share the fill link and keep the CLI running.

Requested names are hints, not filters: every received field is preserved, even if its name differs from what you asked for. `wait` prints metadata, never values, on stdout:

```json
{"names":["API_KEY","deployment note"],"file":"/home/you/.local/share/podaj/inbox/example.age","identity":"/home/you/.local/share/podaj/age-identity.txt"}
```

The standard binary `.age` file remains available after successful completion and CLI exit. To print its plaintext explicitly:

```sh
podaj decrypt /home/you/.local/share/podaj/inbox/example.age
# With an explicit identity (also accepts encrypted stdin when the file is omitted):
podaj decrypt --identity /path/to/identity.txt /path/to/receipt.age
# Or use native age:
age --decrypt --identity /path/to/identity.txt /path/to/receipt.age
```

Receipts live in `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/inbox` (files 0600, private directories 0700). The default `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/age-identity.txt` is generated once (0600), reused, and never overwritten. `PODAJ_AGE_IDENTITY` selects an existing native age identity file. `PODAJ_AGE_RECIPIENT` selects a native public age recipient instead, takes precedence, and never loads or creates a local identity; metadata then omits `identity`. That field is always a path, never key contents. The pinned `age-encryption` Node package needs no external `age` binary and does not scan SSH/GPG keys.

## self-hosting

```sh
podaj deploy
podaj wait API_KEY
```

`deploy` handles Cloudflare login, deploys your Worker, and saves its connection automatically. No Bun, checkout, or separate Wrangler installation is needed.

Already deployed with the button? Run `podaj config` to connect instead:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hasparus/podaj)

For non-interactive private connections, pass the Worker secret on stdin:

```sh
printf '%s\n' "$PODAJ_API_AUTH_SECRET" | podaj config --url https://<name>.workers.dev
```

Workers default to `PODAJ_ACCESS=private`, requiring `PODAJ_API_AUTH_SECRET`. `PODAJ_ACCESS=public` uses Turnstile approval and bounded admission; configure `TURNSTILE_SITE_KEY` and the `TURNSTILE_SECRET_KEY` Worker secret before enabling it. Run `podaj config --url https://podaj.fyi` to return to the demo.

**Security:** names and values are encrypted before upload. Fresh memory-only RSA transport keys are separate from your unencrypted, owner-readable local age identity. `wait` never automatically writes plaintext values to stdout, files, or the global environment. Receipts avoid accidental plaintext artifacts, not a compromised user/device. Handoffs expire after 2 hours; collection is atomic and at most once. Lost responses need a new request; receipts do not guarantee crash/network-loss recovery. Fill links never contain your instance token. Browser encryption still trusts the host's code. See [SECURITY.md](SECURITY.md).

Development only (Bun 1.4.4): `bun install`, `bun run dev`, `bun run check`, `bun run test`.
