# Features

## Primary flow: CLI → human browser → CLI

An AI or human runs the CLI to request environment variables. The CLI creates the request link and keeps the recipient's private key locally. The human opens the link, fills the form, and clicks **send**. The browser encrypts the entire variable bundle with the recipient's public key before uploading it. The CLI collects the ciphertext and decrypts it locally.

The human filling the form never needs to create a link, generate keys, or decrypt anything. Server storage holds ciphertext and minimal delivery metadata, never plaintext variable names or values or private keys.

## Next: human → human using GitHub SSH keys

**Planned, not part of the current implementation.**

I should be able to encrypt environment variables for a GitHub user such as `@fancysnake`, then send them a link and a copyable one-liner. They run the command to receive the encrypted bundle and decrypt it locally with their matching SSH private key.

### Intended experience

1. The sender chooses a GitHub handle and supplies environment variables locally.
2. Podaj resolves the recipient's public SSH keys and identifies the encryption recipient.
3. The sender's device encrypts the bundle before upload.
4. Podaj returns a one-time link and a receiving command to share.
5. The recipient runs the command; it downloads ciphertext, decrypts locally, and writes an env file.

Illustrative receiving command, not an existing CLI command:

```sh
podaj receive '<one-time-link>' --out .env.received
```

### Requirements

- Keep private keys on the recipient's device; never put them in the link, command arguments, or server storage.
- Use established encryption tooling compatible with the supported SSH key types. Do not invent a cryptographic conversion or silently treat every SSH key as RSA-OAEP-compatible.
- Make GitHub's role as the public-key source clear. Show the selected key fingerprint and account for multiple keys, rotation, and unsupported key types. A GitHub handle is not proof of who is running the receiving command; possession of the matching private key enables decryption.
- Preserve bounded retention and authorized one-time collection.
- Write received files with restrictive permissions, refuse accidental overwrite, and never execute or automatically source their contents.

### Decisions before implementation

Choose supported SSH key types and tooling, key-selection and identity-verification behavior, and support for passphrase-protected, agent-held, or hardware-backed keys. Decide how this fits the existing encrypted envelope without weakening its guarantees.
