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

# Apple's intermediate and root, or the chain does not verify on a machine that
# has never seen your certificate. For a Developer ID certificate the
# intermediate is DeveloperIDG2CA - not AppleWWDRCA, which signs a different
# family. Check the issuer on your own certificate if unsure:
#   openssl x509 -inform der -in developerid.cer -noout -issuer
Invoke-WebRequest https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -OutFile DeveloperIDG2CA.cer
Invoke-WebRequest https://www.apple.com/appleca/AppleIncRootCertificate.cer -OutFile AppleRoot.cer
& $openssl x509 -inform der -in DeveloperIDG2CA.cer -out chain.pem
& $openssl x509 -inform der -in AppleRoot.cer >> chain.pem

# 3DES rather than OpenSSL 3's default AES, because macOS's security tool
# cannot read the latter and fails on import with an unhelpful error.
#
# The usual advice is -legacy, which does the same thing. It does not work with
# the OpenSSL that ships with Git for Windows: that build has no legacy
# provider module, and fails with "unable to load provider legacy". Naming the
# algorithms avoids the provider entirely - PBE-SHA1-3DES is in the default
# provider, RC2 (which -legacy also selects) is not.
& $openssl pkcs12 -export -out developerid.p12 `
    -inkey developerid.key -in developerid.pem -certfile chain.pem `
    -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
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
keychain, builds a universal binary, wraps it in `TeamsBridge.app`, signs the
bundle with the hardened runtime and a trusted timestamp, and prints what the
artifact actually is:

```
lipo -info            both slices present, or the build fails
codesign --display    the authority chain
stapler validate      whether a ticket is attached
spctl --assess        Gatekeeper's own verdict
```

Every step is skipped cleanly when the secrets are absent, so a fork still
builds.

**Notarization is opt-in**, via the `notarize` input on a manual run. It is a
queue at Apple rather than work we do — this team's submissions have sat
`In Progress` anywhere from 44 minutes to over 2½ hours while the build itself
took two — and it proves nothing on a routine commit that signing has not
already proved. Sign on every push, notarize when producing something
shippable.

Expect a normal run of about a minute, and a notarizing one to be unpredictable.

### When the queue outlasts the job

**A submission outlives the job that made it.** Two on 2026-09-22 outran their
own timeouts and were recorded as failed builds, yet both were Accepted by
Apple — `Ready for distribution`, `issues: null`, with the ticket covering the
`x86_64` and `arm64` slices alike. A timeout here says nothing about whether
the binary is good.

So ask before re-submitting:

```
gh workflow run notary-status.yml --ref main -f submission=<id>
```

It runs `notarytool history` (blank input lists recent submissions and their
current status) and, given an id, `notarytool info` plus the full log — which
names the offending binary and reason when something genuinely is wrong.

If it reports Accepted, re-run the build with notarization on. Apple issues the
ticket from cache for a cdhash it has already approved, so a rebuild of the
same source skips the queue outright: the run on 2026-09-23 went from
`Notarizing via App Store Connect API key...` to `Accepted` in **22 seconds**,
then stapled and passed `spctl` as `source=Notarized Developer ID`.

## 7. The part that needs a Mac

Two questions CI cannot answer, both about behaviour rather than artifacts:

1. **Does Stream Deck quarantine what it extracts?** On a Mac, install the
   plugin from a downloaded `.streamDeckPlugin` and run
   `xattr -p com.apple.quarantine` against the installed helper. If nothing is
   set, Gatekeeper never gets involved and the whole signing chain matters less
   than assumed. Worth checking early — it tells you how load-bearing any of
   this is.
2. **Does the helper launch from a real install?** Not a sideload. Grant
   Accessibility to Stream Deck, quit it fully, reopen, join a meeting.

The stapling gap is closed: the helper ships as `TeamsBridge.app` so a
notarization ticket has somewhere to live, and Gatekeeper can validate locally
rather than asking Apple over the network at first launch.
