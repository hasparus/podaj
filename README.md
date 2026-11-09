# podaj

> [!NOTE]  
> I realize this is a bit silly, but not every remote agent UI has a secure secret passing tool, and one of them kept asking me for passwords and immediately screenshotting them.

One-shot environment-variable handoff: your CLI creates a link, a human fills it and clicks **send**, and the CLI receives JSON.

```sh
npm i -g podaj
podaj wait API_KEY
```

Requires Node.js 22+. Uses the public demo at `https://podaj.fyi` by default—no deployment or configuration needed. Approve the request in your browser, then share the fill link and keep the CLI running.

## Self-hosting

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

**Security:** names and values are encrypted before upload. Each request's private key stays in CLI memory; fill links never contain your instance token. Handoffs expire after 2 hours. Collection is atomic and at most once: a lost collection response needs a new request. Browser encryption still trusts the host's code.

Development only (Bun 1.4.4): `bun install`, `bun run dev`, `bun run check`, `bun run test`.
