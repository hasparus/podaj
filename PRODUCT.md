# podaj

Share environment variables once via a link. Senders fill a Key | Value table in the browser; recipients open the link with their key file.

## Users

- Operator configuring the hosted instance (recipient public key in `public/recipient.pem`)
- Sender creating a one-time link
- Recipient opening `/h/{id}` and reading vars locally

## Non-goals

Password vault, multi-environment picker, MCP servers, monorepo rat-stack apps (Foldkit/Alchemy/XState).

## Security story (user-facing)

Values are encrypted in the browser with the recipient public key before upload. Each link works once. The server never sees plaintext or the private key. Details for implementers: [SECURITY.md](./SECURITY.md).
