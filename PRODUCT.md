# podaj

Share environment variables once via a link. Senders fill a Key | Value table in the browser; recipients open the link with their key file.

## Users

- Operator configuring the hosted instance (recipient public key in `public/recipient.pem`)
- Sender creating a one-time link
- Recipient opening `/h/{id}` and reading vars locally

## Non-goals

Password vault, multi-environment picker, MCP server, a shared public instance. Each operator deploys their own Worker. Agents use `pnpm podaj`.

## Security story (user-facing)

Values are encrypted in the browser with the recipient public key before upload. Each link works once. The database (Workers KV) stores only the sealed bundle. Plaintext and the private key stay in the browser. Details for implementers: [SECURITY.md](./SECURITY.md).
