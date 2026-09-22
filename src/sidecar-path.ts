/**
 * Sidecar binary name inside `bin/sidecar/`.
 *
 * Windows CI publishes TeamsBridge.exe (.NET / FlaUI). macOS builds
 * TeamsBridge (Swift / AXUIElement). The Node plugin picks by platform so a
 * single plugin folder can hold both.
 */
export function sidecarFileName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "TeamsBridge.exe" : "TeamsBridge";
}
