# podaj

> [!NOTE]  
> I realize this is a bit silly, but not every remote agent UI has a secure secret passing tool, and one of them kept asking me for passwords and immediately screenshotting them.

One-shot environment-variable handoff: your CLI creates a link, a human fills it and clicks **send**, and the CLI receives JSON.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hasparus/podaj)

Deploy your Worker, set a random `PODAJ_API_AUTH_SECRET` as a Worker secret, then connect from a checkout with Bun 1.4.4:

```sh
bun install
bun run podaj init
bun run podaj wait API_KEY
```

Choose **connect**, or **deploy** if you prefer Wrangler. Keep the CLI running and share its printed fill link. No deployed public key is needed. The hosted demo and deploy-button path still need rollout verification; use test values for now.

**Security:** names and values are encrypted before upload. Each request's private key stays in the CLI's memory; fill links contain only write authority, never your owner token. Handoffs expire after 2 hours by default. Collection is atomic and at most once: a lost collection response needs a new request. Browser encryption still trusts the host's code.

Development: `bun run dev`, `bun run check`, `bun run test`.
