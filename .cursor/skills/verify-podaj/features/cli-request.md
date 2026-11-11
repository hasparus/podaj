# CLI request

- Start the compiled `dist/scripts/podaj.js` under the isolated environment described in [SKILL.md](../SKILL.md). Do not use an installed/global/npm CLI.
- `config --url "$URL"` saves only URL/token config under scratch; it does not require a recipient key file.
- Each `wait` generates a new RSA-2048 transport keypair in memory and reserves with its public key. Do not run legacy `keygen` or persist transport private keys. A separate native age identity is intentionally persisted locally for receipts; it is not a request transport key or a `PODAJ_KEY_DIR` key.
- stderr lists requested keys and exactly one fill URL: `$URL/s/<32-lowercase-hex-id>#write=<64-lowercase-hex>&recipient=<base64url-SPKI>`.
- Validate the URL origin and fragment shape without publishing capabilities. Recipient fingerprint must match the CLI's request key, not an untrusted server substitution.
- The sender receives only write authority and the public recipient key. Read/subscribe capabilities and the private key remain with the CLI; no owner credential belongs in the browser.
- Before **send**, stdout has no JSON and the process remains waiting. Afterward, verify metadata JSON, the encrypted receipt, explicit DUMMY decryption, modes, and exit status as described in [terminal-consume.md](terminal-consume.md).
- Inspect only scratch HOME/config/data. Require `${XDG_DATA_HOME}/podaj/inbox` and the private podaj data directory to be 0700, receipt files 0600, and default `${XDG_DATA_HOME}/podaj/age-identity.txt` 0600. The default identity is generated once, reused across waits, and never overwritten; compare hashes privately, not key contents in shared proof. No RSA transport `private.pem` should appear.
- Check override cases with synthetic native age fixtures only: `PODAJ_AGE_IDENTITY` selects an existing identity file; `PODAJ_AGE_RECIPIENT` is a public recipient string, takes precedence even with both set, and must not load or create an identity. Require `identity` in metadata to be a path for identity-backed runs and absent for public-recipient runs. The pinned `age-encryption` package needs no external binary; do not scan SSH/GPG files or assume arbitrary SSH keys work.
- Rely on `test/cli-lifecycle.test.ts` and `test/age-output.test.ts` for isolated lifecycle, identity, mode, and output checks; report which cases actually ran.
- If demo enrollment is required, the CLI first emits a separate authorization URL. Approval is not secret entry; the verifier never goes to the browser. This private-localhost journey does not prove live demo enrollment.
