# features

## primary flow: CLI → human browser → CLI

An AI or human runs the CLI to request environment variables. The CLI creates the request link with fresh memory-only RSA transport keys. The human opens the link, fills the form, and clicks **send**. The browser encrypts the entire variable bundle with the recipient's public key before uploading it. The CLI collects ciphertext, decrypts it in memory, and saves the entire payload in a standard binary `.age` receipt. Requested KEY labels are hints, not filters: unexpectedly named fields and all values are preserved. Stdout contains only `{names: string[], file: absoluteAgeFilePath, identity?: localIdentityFilePath}`, with a path rather than key contents. URLs/instructions stay on stderr; no plaintext values are automatically written to stdout, files, or the global environment.

The human filling the form never needs to create a link, generate keys, or decrypt anything. Server storage holds ciphertext and minimal delivery metadata, never plaintext variable names or values or private keys.

## local age receipts

Receipts survive successful completion and CLI exit in `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/inbox` (files 0600, private directories 0700). The default `${XDG_DATA_HOME:-$HOME/.local/share}/podaj/age-identity.txt` is generated once (0600), reused, and never overwritten. `PODAJ_AGE_IDENTITY` selects an existing native age identity file; `PODAJ_AGE_RECIPIENT` selects a native public age recipient, takes precedence, and never loads or creates a local identity. The pinned `age-encryption` Node package needs no external age binary.

Explicit `podaj decrypt [--identity <file>] <file.age>` prints plaintext to stdout, also accepts encrypted stdin, and interoperates with `age --decrypt --identity <identityPath> <file.age>`. Standalone `PODAJ1.` decryption remains supported; the browser/server protocol is unchanged. The local age identity is separate from transport RSA keys and legacy `PODAJ_KEY_DIR`/`keygen` helpers. It is unencrypted and readable by its owner: encrypted receipts avoid accidental plaintext artifacts, not a compromised user/device. There is no daemon, OS keychain, automatic SSH/GPG scanning, or arbitrary SSH-key support. At-most-once collection does not guarantee crash or network-loss recovery.

## next: human → human using GitHub SSH keys

**Planned, not implemented. This is separate from local age receipts.**

I should be able to encrypt environment variables for a GitHub user such as `@fancysnake`, then send them a link and a copyable one-liner. They run the command to receive the encrypted bundle and decrypt it locally with their matching SSH private key.

### intended experience

1. The sender chooses a GitHub handle and supplies environment variables locally.
2. podaj resolves the recipient's public SSH keys and identifies the encryption recipient.
3. The sender's device encrypts the bundle before upload.
4. podaj returns a one-time link and a receiving command to share.
5. The recipient runs the command; it downloads ciphertext, decrypts locally, and writes an env file.

Illustrative receiving command, not an existing CLI command:

```sh
podaj receive '<one-time-link>' --out .env.received
```

### requirements

- Keep private keys on the recipient's device; never put them in the link, command arguments, or server storage.
- Use established encryption tooling compatible with the supported SSH key types. Do not invent a cryptographic conversion or silently treat every SSH key as RSA-OAEP-compatible.
- Make GitHub's role as the public-key source clear. Show the selected key fingerprint and account for multiple keys, rotation, and unsupported key types. A GitHub handle is not proof of who is running the receiving command; possession of the matching private key enables decryption.
- Preserve bounded retention and authorized one-time collection.
- Write received files with restrictive permissions, refuse accidental overwrite, and never execute or automatically source their contents.

### decisions before implementation

Choose supported SSH key types and tooling, key-selection and identity-verification behavior, and support for passphrase-protected, agent-held, or hardware-backed keys. Decide how this fits the existing encrypted envelope without weakening its guarantees.
