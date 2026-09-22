#!/usr/bin/env bash
#
# Builds the macOS sidecar, and signs it when a signing identity is available.
#
# Two things about the 1.10.0/1.10.1 binary made it unfit to ship, both found by
# reading the Mach-O that CI produced rather than by testing on a Mac:
#
#   arm64 only  - a thin Mach-O. The manifest declared macOS 13, which runs on
#                 Intel Macs back to 2017, so those users would have installed
#                 the plugin and got nothing. Hence --arch twice: SwiftPM emits
#                 one universal binary covering both.
#
#   ad-hoc sig  - enough to execute on Apple Silicon while the file is not
#                 quarantined, which is why a sideload worked and a Marketplace
#                 download might not. A Developer ID signature plus notarization
#                 is what makes a downloaded copy launch.
#
# Signing is optional so the build still works for anyone without the identity -
# a contributor, or CI on a fork. Unsigned output keeps SwiftPM's ad-hoc
# signature, which is fine for a sideload and not fit to publish.
#
# Signing needs, in the environment:
#   MACOS_SIGN_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"
#
# Notarization needs one of two credential sets. notarytool accepts either, and
# they authenticate the same submission:
#
#   API key            MACOS_NOTARY_KEY_PATH (.p8) + _KEY_ID + _ISSUER_ID
#   app-specific pwd   MACOS_NOTARY_APPLE_ID + _PASSWORD + _TEAM_ID
#
# The API key is the better one to end on - revocable on its own, not tied to a
# person - but it needs App Store Connect API access, which is requested
# separately from developer membership and is not granted by default. An
# app-specific password from appleid.apple.com works immediately and is a fine
# place to start.
#
# Run with: npm run build:sidecar:macos
set -euo pipefail

PACKAGE="sidecar-macos"
OUT="com.bad-duck.teamscontrol.sdPlugin/bin/sidecar"
NAME="TeamsBridge"

echo "Building $NAME for arm64 and x86_64..."
swift build -c release --arch arm64 --arch x86_64 --package-path "$PACKAGE"

BIN="$(swift build -c release --arch arm64 --arch x86_64 --package-path "$PACKAGE" --show-bin-path)/$NAME"
mkdir -p "$OUT"
cp "$BIN" "$OUT/$NAME"
chmod +x "$OUT/$NAME"

echo "Architectures:"
lipo -info "$OUT/$NAME"

# Both slices must be present. A universal binary with one slice is just a thin
# one wearing a fat header, and the failure it causes - a Mac that installs the
# plugin and does nothing - looks nothing like a build problem.
for arch in arm64 x86_64; do
	lipo -info "$OUT/$NAME" | grep -q "$arch" || { echo "error: $arch slice missing"; exit 1; }
done

if [ -z "${MACOS_SIGN_IDENTITY:-}" ]; then
	echo
	echo "No MACOS_SIGN_IDENTITY set - leaving SwiftPM's ad-hoc signature in place."
	echo "Fine for a sideload. Not fit to publish: Gatekeeper rejects an ad-hoc"
	echo "binary once it carries the quarantine attribute."
	exit 0
fi

echo
echo "Signing with: $MACOS_SIGN_IDENTITY"
# --options runtime is the hardened runtime, which notarization requires.
# --timestamp binds a trusted timestamp, so the signature outlives the
# certificate rather than expiring with it.
codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$OUT/$NAME"
codesign --verify --strict --verbose=2 "$OUT/$NAME"

if [ "${MACOS_NOTARIZE:-}" != "1" ]; then
	echo
	echo "Signed, not notarized - MACOS_NOTARIZE is not set."
	echo
	echo "Notarization is a queue at Apple, not work we do: the first submission"
	echo "from this team sat 'In Progress' for 44 minutes while the build itself"
	echo "took two. It proves nothing on a routine commit that signing has not"
	echo "already proved, so it runs when a shippable artifact is being made."
	exit 0
fi

if [ -n "${MACOS_NOTARY_KEY_PATH:-}" ]; then
	NOTARY_AUTH=(--key "$MACOS_NOTARY_KEY_PATH" --key-id "$MACOS_NOTARY_KEY_ID" --issuer "$MACOS_NOTARY_ISSUER_ID")
	NOTARY_KIND="App Store Connect API key"
elif [ -n "${MACOS_NOTARY_PASSWORD:-}" ]; then
	NOTARY_AUTH=(--apple-id "$MACOS_NOTARY_APPLE_ID" --password "$MACOS_NOTARY_PASSWORD" --team-id "$MACOS_NOTARY_TEAM_ID")
	NOTARY_KIND="app-specific password"
else
	echo
	echo "Signed but not notarized - no notary credentials in the environment."
	echo "Gatekeeper will still refuse a quarantined copy: a Developer ID"
	echo "signature alone is not enough, the ticket has to exist."
	exit 0
fi

echo
echo "Notarizing via $NOTARY_KIND..."
# notarytool takes an archive, not a loose executable. ditto rather than zip,
# because it preserves the extended attributes and the signature with them.
ZIP="$(mktemp -d)/$NAME.zip"
ditto -c -k --keepParent "$OUT/$NAME" "$ZIP"

# --timeout so a submission that never resolves fails loudly rather than
# holding the runner. Apple usually answers in single-digit minutes.
xcrun notarytool submit "$ZIP" "${NOTARY_AUTH[@]}" --wait --timeout 15m

# A ticket cannot be stapled to a bare Mach-O - only to bundles, disk images and
# archives - so there is nothing to attach here and Gatekeeper checks Apple
# online at first launch instead. That means an offline user is still blocked.
# Wrapping the helper in a .app and stapling that is the way out, and is worth
# doing before macOS is declared again.
echo
echo "Notarized. No staple: a bare Mach-O cannot hold a ticket, so first launch"
echo "is an online Gatekeeper check."
