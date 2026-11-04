# podaj agent notes

Minimal one-shot env-var handoff (Worker + Vite UI). Do not grow MCP, capability layers, or Alchemy unless the owner asks.

## UI (Direction A · Zinc Ledger)

- Single recipient public key at `public/recipient.pem` (copy from `recipient.pem.example`); optional short hex in header — **no environments list or sidebar**
- Vercel-adjacent **Key | Value** table, **Add**, **Create link**; minimal chrome; success copy `Share this once.` + URL
- Footer on send/receive: plain-language security (see `HOW_IT_WORKS` in `src/client/user-facing.ts`)
- Env-var handoff only (not vault fields)
- User-facing copy: plain language only — wire format (`PODAJ1.`) stays in code/docs for implementers

## Fence (rat-stack subset)

Aligned with [rat-stack fence](https://ratstack.sh/systems/fence) for this single package (no monorepo):

- `pnpm check` — `tsrs` typecheck (app + key scripts) and type-aware `oxlint` with **Ultracite core**
- `pnpm test`
- Lefthook runs both on commit; `scripts/vcs-command-policy.js` blocks `git --no-verify` (agent hook uses `scripts/hooks/block-git-no-verify.mjs`)

Foldkit client: `src/client/app.ts` (program) + `src/client/entry.ts` (Runtime boot). `@foldkit/vite-plugin` + `@foldkit/oxlint-plugin` on `src/client/**`.

## Invariants

- Ciphertext prefix `PODAJ1.` only
- KV stores ciphertext only; no private keys in git
- Product is KEY+value env vars, not login credentials
- Envelope `env` slug is `default` for the single recipient key
