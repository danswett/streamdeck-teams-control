import { describe, expect, it } from "vitest";
import { directModeConfigPath } from "../src/direct-mode-config";

describe("Direct mode user configuration", () => {
	it("lives outside the protected production package", () => {
		expect(directModeConfigPath(
			"C:\\Plugins\\com.bad-duck.teamscontrol.sdPlugin", "win32", "C:\\UserData"
		)).toBe("C:\\UserData\\com.bad-duck.teamscontrol\\direct-mode.json");
	});

	it("does not share production consent with a preview plugin", () => {
		const production = directModeConfigPath(
			"C:\\Plugins\\com.bad-duck.teamscontrol.sdPlugin", "win32", "C:\\UserData");
		const preview = directModeConfigPath(
			"C:\\Plugins\\com.bad-duck.teamscontrol-webcam-preview.sdPlugin", "win32", "C:\\UserData");
		expect(preview).toBe("C:\\UserData\\com.bad-duck.teamscontrol-webcam-preview\\direct-mode.json");
		expect(preview).not.toBe(production);
	});

	it("does not pass Windows-only settings to the macOS sidecar", () => {
		expect(directModeConfigPath("plugin.sdPlugin", "darwin", "C:\\UserData")).toBeUndefined();
	});
});
