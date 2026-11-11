# podaj

## primary flow

**CLI → human browser → CLI.** The CLI operator can be an AI or a human.

1. The CLI creates a fresh RSA transport keypair per request and keeps its private key in memory only.
2. The CLI creates a request and gives the human its fill link.
3. The human fills a key/value table and clicks **send**. They never need to create a link, generate keys, or decrypt anything.
4. The browser encrypts both variable names and values with the CLI's public key before upload.
5. The CLI collects ciphertext, decrypts in memory, and saves the entire payload in a standard binary `.age` receipt. Requested KEY labels are hints, not filters; all fields and values are preserved.
6. Stdout reports only `{names: string[], file: absoluteAgeFilePath, identity?: localIdentityFilePath}`. `identity` is a path, never key contents. URLs/instructions remain on stderr; no plaintext values are automatically written to stdout, files, or the global environment.

## local receipts

Receipts persist after successful completion and across CLI exit in `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/inbox` (files 0600, private directories 0700). The default local identity, `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/age-identity.txt`, is generated once with mode 0600, reused, and never overwritten. It is separate from the memory-only transport keys and optional legacy `PODAJ_KEY_DIR`/`keygen` helpers.

`PODAJ_AGE_IDENTITY` selects an existing native age identity file. `PODAJ_AGE_RECIPIENT` selects a native public age recipient, takes precedence, and never loads or creates a local identity. The pinned `age-encryption` Node package needs no external age binary. There is no automatic SSH/GPG scanning or arbitrary SSH-key support.

Only explicit `podaj decrypt [--identity <file>] <file.age>` prints plaintext to stdout; it also accepts encrypted stdin. Native `age --decrypt --identity <identityPath> <file.age>` interoperates. Explicit standalone `PODAJ1.` decryption remains available. The browser/server protocol is unchanged.

## security requirements

- Plaintext variables and recipient private keys must never be uploaded or persisted by the service. Storage holds ciphertext and minimal delivery metadata only.
- Fill, readiness, and collection permissions are separate. A fill link must not include the instance-wide API auth secret or a collection capability.
- Collection is atomic and at most once; requests expire after 2 hours by default. Lost collection responses need a new request. Persistent local receipts do not guarantee crash or network-loss recovery.
- The local age identity is unencrypted and readable by its owner. Encrypted receipts avoid accidental plaintext artifacts, not a compromised user/device. No daemon or OS keychain is implemented.
- The shared demo has strict admission and resource limits and runs on Workers Free. Exhausting a quota causes temporary unavailability, not an automatic paid upgrade.
- A browser sender still trusts the code served by the host. Encryption at rest does not remove that trust boundary.

## surfaces

- CLI: initiate requests, save encrypted replies locally, and reveal plaintext only on explicit decrypt invocation.
- Browser: fill a CLI-created request. No browser recipient wizard or private-key picker.
- `npm i -g podaj`, then `podaj wait KEY...`, uses the hosted demo at `https://podaj.fyi` without setup. Optional `podaj deploy` deploys and saves the connection automatically; `podaj config` connects an existing Worker, including button deployments. Consumers need Node.js 22+, not Bun or a checkout.
- Shared hosted demo and self-hosting through the Deploy to Cloudflare button use the same protocol. Workers use `PODAJ_ACCESS=private|public`; private is the deployment default, public uses Turnstile admission.

## boundaries

Environment-variable handoff, not a vault, password manager, environments dashboard, or MCP server. Handwritten application, CLI, and hook source is TypeScript; JavaScript is generated distribution output only.

Human-to-human delivery using GitHub SSH keys is a future proposal in `FEATURES.md`, not part of local age receipt support.
