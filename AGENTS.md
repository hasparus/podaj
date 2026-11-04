# podaj agent notes

Minimal one-shot env-var handoff (Worker + Vite UI). Do not grow MCP, capability layers, or Alchemy unless the owner asks.

## Gate

- `pnpm check` — `tsrs` typecheck (app + key scripts) and `tsrs --lint`
- `pnpm test`
- Lefthook runs both on commit; do not use `git --no-verify`

## Invariants

- Ciphertext prefix `PODAJ1.` only
- KV stores ciphertext only; no private keys in git
- Product is KEY+value env vars, not login credentials
