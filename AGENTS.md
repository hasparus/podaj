# podaj agent notes

Minimal one-shot env-var handoff (Worker + Vite UI). Do not grow MCP, capability layers, or Alchemy unless the owner asks.

## UI (Direction A · Zinc Ledger)

- Single default public key from `environments.json` (first entry); show sha-256 fingerprint in header — **no environments sidebar**
- Vercel-adjacent **Key | Value** table, **Add row**, **Encrypt & send**; minimal chrome
- Env-var handoff only (not vault fields)

## Gate

- `pnpm check` — `tsrs` typecheck (app + key scripts) and `oxlint --type-aware`
- `pnpm test`
- Lefthook runs both on commit; do not use `git --no-verify`

## Invariants

- Ciphertext prefix `PODAJ1.` only
- KV stores ciphertext only; no private keys in git
- Product is KEY+value env vars, not login credentials
