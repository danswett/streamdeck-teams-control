#!/usr/bin/env bash
#
# Builds the macOS sidecar as a signed, stapleable app bundle.
#
# Three things about the 1.10.0/1.10.1 binary made it unfit to ship, all found
# by reading the Mach-O that CI produced rather than by testing on a Mac:
#
#   arm64 only  - a thin Mach-O. The manifest declared macOS 13, which runs on
#                 Intel Macs back to 2017, so those users would have installed
#                 the plugin and got nothing. Hence --arch twice: SwiftPM emits
#                 one universal binary covering both.
#
#   ad-hoc sig  - enough to execute on Apple Silicon while the file is not
#                 quarantined, which is why a sideload worked and a Marketplace
#                 download might not.
#
#   loose file  - a notarization ticket cannot be stapled to a bare Mach-O,
#                 only to a bundle, a disk image or an archive. Unstapled means
#                 Gatekeeper asks Apple over the network at first launch, so an
#                 offline user is blocked. Hence the .app wrapper: the smallest
#                 bundle that can hold a ticket. LSBackgroundOnly keeps it out
#                 of the Dock, since nothing about it is user-facing.
#
# Signing is optional so the build still works for anyone without the identity.
# Unsigned output keeps SwiftPM's ad-hoc signature: fine for a sideload, not
# fit to publish.
#
# Signing needs, in the environment:
#   MACOS_SIGN_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"
#
# Notarization is opt-in with MACOS_NOTARIZE=1, because it is a queue at Apple
# rather than work we do - this team's first submission sat forty-four minutes
# while the build took two. It needs one of:
#
#   API key            MACOS_NOTARY_KEY_PATH (.p8) + _KEY_ID + _ISSUER_ID
#   app-specific pwd   MACOS_NOTARY_APPLE_ID + _PASSWORD + _TEAM_ID
#
# Run with: npm run build:sidecar:macos
set -euo pipefail

PACKAGE="sidecar-macos"
OUT="com.bad-duck.teamscontrol.sdPlugin/bin/sidecar"
NAME="TeamsBridge"
BUNDLE="$OUT/$NAME.app"

echo "Building $NAME for arm64 and x86_64..."
swift build -c release --arch arm64 --arch x86_64 --package-path "$PACKAGE"
BIN="$(swift build -c release --arch arm64 --arch x86_64 --package-path "$PACKAGE" --show-bin-path)/$NAME"

# Rebuilt from scratch: a stale Info.plist or a leftover signature inside the
# bundle would be signed over and shipped without complaint.
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS"
cp "$BIN" "$BUNDLE/Contents/MacOS/$NAME"
chmod +x "$BUNDLE/Contents/MacOS/$NAME"

VERSION="$(node -p "require('./com.bad-duck.teamscontrol.sdPlugin/manifest.json').Version")"

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.bad-duck.teamscontrol.sidecar</string>
	<key>CFBundleName</key>
	<string>$NAME</string>
	<key>CFBundleExecutable</key>
	<string>$NAME</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<!-- No Dock icon, no menu bar, no app switcher entry. This is a helper the
	     plugin spawns; a user never launches it and should never see it. -->
	<key>LSBackgroundOnly</key>
	<true/>
</dict>
</plist>
PLIST

echo "Architectures:"
lipo -info "$BUNDLE/Contents/MacOS/$NAME"

# Both slices must be present. A universal binary with one slice is a thin one
# wearing a fat header, and the failure it causes - a Mac that installs the
# plugin and does nothing - looks nothing like a build problem.
for arch in arm64 x86_64; do
	lipo -info "$BUNDLE/Contents/MacOS/$NAME" | grep -q "$arch" || { echo "error: $arch slice missing"; exit 1; }
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
# The bundle, not the inner binary: signing the bundle covers Info.plist too,
# so a tampered plist invalidates the signature. --options runtime is the
# hardened runtime, which notarization requires. --timestamp binds a trusted
# timestamp so the signature outlives the certificate rather than expiring with
# it.
codesign --force --options runtime --timestamp \
	--sign "$MACOS_SIGN_IDENTITY" "$BUNDLE"
codesign --verify --deep --strict --verbose=2 "$BUNDLE"

if [ "${MACOS_NOTARIZE:-}" != "1" ]; then
	echo
	echo "Signed, not notarized - MACOS_NOTARIZE is not set."
	echo
	echo "Notarization is a queue at Apple, not work we do: submissions from this"
	echo "team have sat 'In Progress' anywhere from 44 minutes to over 2.5 hours"
	echo "while the build itself took two. It proves nothing on a routine commit"
	echo "that signing has not already proved, so it runs when a shippable"
	echo "artifact is being made."
	exit 0
fi

if [ -n "${MACOS_NOTARY_KEY_PATH:-}" ]; then
	NOTARY_AUTH=(--key "$MACOS_NOTARY_KEY_PATH" --key-id "$MACOS_NOTARY_KEY_ID" --issuer "$MACOS_NOTARY_ISSUER_ID")
	NOTARY_KIND="App Store Connect API key"
elif [ -n "${MACOS_NOTARY_PASSWORD:-}" ]; then
	NOTARY_AUTH=(--apple-id "$MACOS_NOTARY_APPLE_ID" --password "$MACOS_NOTARY_PASSWORD" --team-id "$MACOS_NOTARY_TEAM_ID")
	NOTARY_KIND="app-specific password"
else
	echo "error: MACOS_NOTARIZE=1 but no notary credentials in the environment" >&2
	exit 1
fi

echo
echo "Notarizing via $NOTARY_KIND..."
# notarytool takes an archive, not a bundle directory. ditto rather than zip,
# because it preserves the bundle structure and the signature with it.
ZIP="$(mktemp -d)/$NAME.zip"
ditto -c -k --keepParent "$BUNDLE" "$ZIP"

# --timeout so a submission that never resolves fails loudly rather than
# holding the runner. Generous, because Apple's queue is not ours: two
# submissions on 2026-09-22 were still "In Progress" 1h44m and 2h42m after
# upload, with no incident posted on Apple's status page.
#
# Both were Accepted in the end, so this expiring does not mean the submission
# failed - only that it outlived the job. Ask before re-submitting; the message
# below says how.
if ! xcrun notarytool submit "$ZIP" "${NOTARY_AUTH[@]}" --wait --timeout 45m; then
	echo
	echo "Notarization did not complete in time."
	echo
	echo "The submission is not lost - it lives on Apple's side and carries on"
	echo "without this job. Check what became of it with the notary-status"
	echo "workflow, which runs notarytool history and log:"
	echo
	echo "  gh workflow run notary-status.yml --ref main"
	echo
	echo "If it later reports Accepted, re-run this with MACOS_NOTARIZE=1 and"
	echo "the ticket will be issued from cache rather than reprocessed."
	exit 1
fi

echo
echo "Stapling the ticket to the bundle..."
# The point of the wrapper. With the ticket attached, Gatekeeper validates
# locally and an offline machine can still launch the helper.
xcrun stapler staple "$BUNDLE"
xcrun stapler validate "$BUNDLE"

echo
echo "Gatekeeper verdict:"
spctl --assess --type execute --verbose=4 "$BUNDLE"
