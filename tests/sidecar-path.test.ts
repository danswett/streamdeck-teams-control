import { describe, expect, it } from "vitest";
import { MACOS_BUNDLE, sidecarPath } from "../src/sidecar-path";

describe("sidecarPath", () => {
	it("uses the .NET binary on Windows", () => {
		expect(sidecarPath("win32")).toBe("TeamsBridge.exe");
	});

	it("reaches inside the app bundle on macOS", () => {
		// The bundle exists so a notarization ticket has somewhere to be
		// stapled - a loose Mach-O cannot hold one, which leaves Gatekeeper
		// asking Apple over the network on first launch and an offline user
		// blocked with it. The plugin still spawns the executable directly.
		expect(sidecarPath("darwin")).toBe("TeamsBridge.app/Contents/MacOS/TeamsBridge");
	});

	it("points inside the bundle it ships", () => {
		expect(sidecarPath("darwin").startsWith(`${MACOS_BUNDLE}/`)).toBe(true);
	});

	it("names the executable last, whatever the platform", () => {
		// bin/sidecar/<this> has to resolve to something spawnable rather than
		// a directory; spawning the bundle itself fails at runtime, not here.
		for (const platform of ["win32", "darwin"] as NodeJS.Platform[]) {
			expect(sidecarPath(platform).split("/").pop()).toMatch(/^TeamsBridge(\.exe)?$/);
		}
	});
});
