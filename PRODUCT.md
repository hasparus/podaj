# podaj

## Primary flow

**CLI → human browser → CLI.** The CLI operator can be an AI or a human.

1. The CLI creates a recipient keypair locally and keeps the private key.
2. The CLI creates a request and gives the human its fill link.
3. The human fills a key/value table and clicks **send**. They never need to create a link, generate keys, or decrypt anything.
4. The browser encrypts both variable names and values with the CLI's public key before upload.
5. The CLI collects ciphertext, decrypts locally, and returns the requested variables as JSON.

## Security requirements

- Plaintext variables and recipient private keys must never be uploaded or persisted by the service. Storage holds ciphertext and minimal delivery metadata only.
- Fill, readiness, and collection permissions are separate. A fill link must not include the instance-wide API auth secret or a collection capability.
- Collection is atomic and at most once; requests expire after 2 hours by default. Response-loss semantics must be explicit.
- The shared demo has strict admission and resource limits and runs on Workers Free. Exhausting a quota causes temporary unavailability, not an automatic paid upgrade.
- A browser sender still trusts the code served by the host. Encryption at rest does not remove that trust boundary.

## Surfaces

- CLI: initiate requests and decrypt replies locally.
- Browser: fill a CLI-created request. No browser recipient wizard or private-key picker.
- Shared hosted demo and self-hosting through the Deploy to Cloudflare button use the same protocol.

## Boundaries

Environment-variable handoff, not a vault, password manager, environments dashboard, or MCP server. Handwritten application, CLI, and hook source is TypeScript; JavaScript is generated distribution output only.

Human-to-human delivery using GitHub SSH keys is specified separately in `FEATURES.md`.
