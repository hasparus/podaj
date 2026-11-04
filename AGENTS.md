# podaj agent notes

Minimal one-shot env-var handoff (Worker + Vite UI). Do not grow MCP, capability layers, or Alchemy unless the owner asks.

## UI (Direction A · Zinc Ledger)

- Single default public key from `environments.json` (first entry); optional short hex in header — **no environments sidebar**
- Vercel-adjacent **Key | Value** table, **Add**, **Create link**; minimal chrome; success copy `Share this once.` + URL
- Env-var handoff only (not vault fields)
- User-facing copy: plain language only — no PODAJ1/ciphertext jargon in the UI (wire format stays in code/docs)

## Gate

- `pnpm check` — `tsrs` typecheck (app + key scripts) and `oxlint --type-aware`
- `pnpm test`
- Lefthook runs both on commit; do not use `git --no-verify`

## Invariants

- Ciphertext prefix `PODAJ1.` only
- KV stores ciphertext only; no private keys in git
- Product is KEY+value env vars, not login credentials
