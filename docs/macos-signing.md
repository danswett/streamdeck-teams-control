# Signing the macOS sidecar, without a Mac

Everything here is done on Windows with OpenSSL and a browser. A Mac is needed
once, at the very end, to confirm the result behaves — not to produce it.

Nothing in this file should ever be committed: the private key and the `.p12`
are a signing identity. Generate them yourself and paste them straight into
GitHub secrets. They are not passed through anything else, including an
assistant.

## Why this is needed

The binary CI produced for 1.10.1, read straight off the Mach-O:

```
arch  : arm64 only, thin Mach-O, cputype 0x0100000C
sig   : ad-hoc - identifier TeamsBridge, flags 0x20002 with the ad-hoc bit set,
        one CodeDirectory blob and no CMS blob
```

Ad-hoc signing runs on Apple Silicon while the file is not quarantined, which is
why a sideload worked and a Marketplace download may not. `tools/build-sidecar-macos.sh`
now builds both architectures; this gets it a real signature.

## 1. Private key and certificate request

OpenSSL ships with Git for Windows:

```powershell
$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
& $openssl genrsa -out developerid.key 2048
& $openssl req -new -key developerid.key -out developerid.csr `
    -subj "/emailAddress=you@example.com/CN=Bad Duck Software/C=US"
```

Keep `developerid.key`. Losing it means starting again; leaking it means
somebody else can sign as you.

## 2. Certificate from Apple

At [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list):

1. **+**, then **Developer ID Application**.
2. Upload `developerid.csr`.
3. Download the `.cer`.

**Developer ID Application**, not *Apple Development* or *Mac App Distribution*
— they are for different distribution channels and Gatekeeper treats a download
signed with them as unsigned.

## 3. Bundle into a .p12

```powershell
$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
& $openssl x509 -inform der -in developerid.cer -out developerid.pem

# Apple's intermediate, or the chain does not verify on a machine that has
# never seen your certificate.
Invoke-WebRequest https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer -OutFile AppleWWDRCAG4.cer
& $openssl x509 -inform der -in AppleWWDRCAG4.cer -out AppleWWDRCAG4.pem

# -legacy because macOS's security tool cannot read OpenSSL 3's default
# encryption. Without it the import fails with an unhelpful error.
& $openssl pkcs12 -export -legacy -out developerid.p12 `
    -inkey developerid.key -in developerid.pem -certfile AppleWWDRCAG4.pem
```

Then base64 it for the secret:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("developerid.p12")) | Set-Clipboard
```

## 4. Notary credentials

notarytool needs an App Store Connect API key, created in the browser at
[appstoreconnect.apple.com/access/integrations/api](https://appstoreconnect.apple.com/access/integrations/api):

1. **Keys**, then **+**. Access: **Developer**.
2. Download the `.p8` — Apple allows this **once**.
3. Note the **Key ID** and the **Issuer ID**.

## 5. GitHub secrets

In **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `MACOS_CERT_P12` | base64 of `developerid.p12` |
| `MACOS_CERT_PASSWORD` | the export password from step 3 |
| `MACOS_SIGN_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `MACOS_NOTARY_KEY` | contents of the `.p8`, including the BEGIN/END lines |
| `MACOS_NOTARY_KEY_ID` | Key ID from step 4 |
| `MACOS_NOTARY_ISSUER_ID` | Issuer ID from step 4 |

The exact `MACOS_SIGN_IDENTITY` string is printed by the `sidecar-macos` job's
`security find-identity` step on the first run after the certificate lands, so
add the other five, run the workflow, and copy it from the log.

Delete `developerid.p12`, `developerid.key` and the `.p8` from disk afterwards.

## 6. What CI then does

`build.yml`'s `sidecar-macos` job imports the certificate into a throwaway
keychain, builds universal, signs with the hardened runtime and a trusted
timestamp, notarizes, and prints what the binary actually is:

```
lipo -info            both slices present, or the build fails
codesign --display    the authority chain
spctl --assess        Gatekeeper's own verdict
```

Every step is skipped cleanly when the secrets are absent, so a fork still
builds.

## 7. The part that needs a Mac

Two questions CI cannot answer, both about behaviour rather than artifacts:

1. **Does Stream Deck quarantine what it extracts?** On a Mac, install the
   plugin from a downloaded `.streamDeckPlugin` and run
   `xattr -p com.apple.quarantine` against the installed helper. If nothing is
   set, Gatekeeper never gets involved and signing matters less than assumed.
   Worth checking early — it decides how much of this is load-bearing.
2. **Does the helper launch from a real install?** Not a sideload. Grant
   Accessibility to Stream Deck, quit it fully, reopen, join a meeting.

There is also a known gap worth closing before macOS is declared: a bare Mach-O
cannot have a notarization ticket stapled to it, so first launch is an online
Gatekeeper check and an offline user is still blocked. Wrapping the helper in a
minimal `.app` and stapling that fixes it.
