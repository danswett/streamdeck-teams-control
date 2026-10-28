import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { renderToggle } from "../src/icons";

describe("High fidelity music mode artwork and wiring", () => {
	it("shows on, off, unknown and unavailable without treating unknown as on", () => {
		const image = (active: boolean | undefined, available = true) => renderToggle({
			onKey: "music", offKey: "music", onTone: "accent", offTone: "on", active, available
		});
		const on = image(true);
		const off = image(false);
		const unknown = image(undefined);
		const unavailable = image(true, false);

		expect(on).toContain("#FFC83D");
		expect(off).toContain("#FFFFFF");
		expect(unknown).toBe(off);
		expect(unavailable).toContain("#4A4A4A");
		expect(on).toContain("<path");
	});

	it("ships a registered action with its own artwork and a configurable audio selector", () => {
		const root = path.resolve(__dirname, "..");
		const plugin = path.join(root, "com.bad-duck.teamscontrol.sdPlugin");
		const manifest = JSON.parse(readFileSync(path.join(plugin, "manifest.json"), "utf8"));
		const selectors = JSON.parse(readFileSync(path.join(plugin, "selectors.json"), "utf8"));
		const action = manifest.Actions.find((entry: { UUID: string }) =>
			entry.UUID === "com.bad-duck.teamscontrol.music-mode");
		expect(action).toMatchObject({
			Name: "High Fidelity Music Mode", Icon: "imgs/actions/music-mode/icon", Controllers: ["Keypad"]
		});
		expect(readFileSync(path.join(root, "src", "plugin.ts"), "utf8"))
			.toContain("registerAction(new MusicModeAction())");
		expect(selectors.controls["music-mode"]).toEqual({
			menu: "audio-button-configure", menuItemName: "^\\s*high\\s+fidelity\\s+music\\s+mode\\s*$"
		});
	});
});
