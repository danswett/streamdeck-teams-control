/**
 * Where the sidecar lives inside `bin/sidecar/`, per platform.
 *
 * Windows ships a bare `TeamsBridge.exe` (.NET / FlaUI). macOS ships a `.app`
 * bundle (Swift / AXUIElement) and runs the executable inside it, which looks
 * like ceremony for a process that draws no window and is never launched by a
 * user. It is not:
 *
 * A notarization ticket can only be stapled to a bundle, a disk image or an
 * archive - never to a loose Mach-O. Without a staple Gatekeeper has to ask
 * Apple over the network the first time the helper runs, so a user who is
 * offline, or behind something that blocks Apple's notary service, is blocked
 * with it. The smallest possible bundle gives the ticket somewhere to live and
 * makes the check local.
 *
 * LSBackgroundOnly in the bundle's Info.plist keeps it out of the Dock and the
 * app switcher, so the wrapper stays invisible.
 */
export function sidecarPath(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return "TeamsBridge.exe";
	return "TeamsBridge.app/Contents/MacOS/TeamsBridge";
}

/** The bundle itself: what gets signed, notarized and stapled. */
export const MACOS_BUNDLE = "TeamsBridge.app";
