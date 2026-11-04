# podaj agent notes

Minimal one-shot env-var handoff (Worker + Vite UI). Do not grow MCP, capability layers, or Alchemy unless the owner asks.

## UI (frozen)

Do **not** invent or ship a new visual direction until the owner picks one letter from the Impeccable 4-up:

- **A** Zinc Ledger
- **B** Paper Seal
- **C** Void Console
- **D** Split Envelope

Until then: keep the current functional UI (structure/behavior only). Fence, tsrs, worker, crypto, and scripts may still change; avoid CSS/layout/visual polish passes.

## Gate

- `pnpm check` — `tsrs` typecheck (app + key scripts) and `oxlint --type-aware`
- `pnpm test`
- Lefthook runs both on commit; do not use `git --no-verify`

## Invariants

- Ciphertext prefix `PODAJ1.` only
- KV stores ciphertext only; no private keys in git
- Product is KEY+value env vars, not login credentials
