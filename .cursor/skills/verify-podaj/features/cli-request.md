# CLI request

- Start the compiled `dist/scripts/podaj.js` under the isolated environment described in [SKILL.md](../SKILL.md). Do not use an installed/global/npm CLI.
- `config --url "$URL"` saves only URL/token config under scratch; it does not require a recipient key file.
- Each `wait` generates a new RSA-2048 keypair in memory and reserves with its public key. Do not run keygen or write a private key to disk for this flow.
- stderr lists requested keys and exactly one fill URL: `$URL/s/<32-lowercase-hex-id>#write=<64-lowercase-hex>&recipient=<base64url-SPKI>`.
- Validate the URL origin and fragment shape without publishing capabilities. Recipient fingerprint must match the CLI's request key, not an untrusted server substitution.
- The sender receives only write authority and the public recipient key. Read/subscribe capabilities and the private key remain with the CLI; no owner credential belongs in the browser.
- Before **send**, stdout has no JSON and the process remains waiting. Afterward, verify exact JSON and exit status as described in [terminal-consume.md](terminal-consume.md).
- Inspect only scratch HOME/config for accidental key persistence. Rely on `test/cli-lifecycle.test.ts` for fresh-key identity, response validation, auth redaction, socket fallback, and demo request-key binding.
- If demo enrollment is required, the CLI first emits a separate authorization URL. Approval is not secret entry; the verifier never goes to the browser. This private-localhost journey does not prove live demo enrollment.
