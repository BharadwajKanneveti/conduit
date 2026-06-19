# Signing the Windows installer

Unsigned installers trigger a Windows SmartScreen warning ("Windows protected
your PC"). Removing it requires an **authenticode code-signing certificate** from
a trusted CA. There is no free way to make SmartScreen trust an installer; a
self-signed certificate does not help end users.

## Options

| Option | Cost | Notes |
|---|---|---|
| **Azure Trusted Signing** | ~$10/month | Cheapest real option. Cloud-based, no cert file to manage. Requires an Azure account and identity verification; orgs need 3+ years of history (individuals are eligible). Builds SmartScreen reputation immediately on a trusted root. |
| **OV certificate** (Sectigo, DigiCert, etc.) | ~$100–400/year | Standard cert. SmartScreen reputation builds over time/downloads, so early downloads may still warn briefly. Usually requires a hardware token (or cloud HSM) now. |
| **EV certificate** | ~$300–600/year | Instant SmartScreen reputation, no warning from day one. Hardware token required. |
| **Ship unsigned (interim)** | free | Fine for an early beta. Users click "More info → Run anyway". Document the bypass in release notes. |

For a pre-launch beta with no budget, shipping unsigned and documenting the
bypass is the pragmatic choice. Reputation also accrues as more people run it.

## Wiring it up (once you have a cert)

Tauri signs during `tauri build` when Windows signing is configured.

**Installed cert (thumbprint):** add to `src-tauri/tauri.conf.json` under
`bundle`:

```json
"windows": {
  "certificateThumbprint": "YOUR_CERT_THUMBPRINT",
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com"
}
```

**Azure Trusted Signing (or any custom signer):** use a sign command instead
(Tauri 2.1+):

```json
"windows": {
  "signCommand": "trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1"
}
```

Get an installed cert's thumbprint with:

```powershell
Get-ChildItem Cert:\CurrentUser\My | Format-List Subject, Thumbprint
```

Keep secrets out of the repo: in CI, store the thumbprint / Azure credentials as
encrypted secrets and inject them into the build.

## SmartScreen bypass (for the unsigned beta)

Include this in release notes so users aren't scared off:

> Windows may show "Windows protected your PC" because the installer isn't code
> signed yet. Click **More info → Run anyway** to continue. Signing is coming.
