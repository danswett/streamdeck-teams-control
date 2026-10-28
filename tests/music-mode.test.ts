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
			Name: "High Fidelity Music Mode", Icon: "imgs/actions/music-mode/icon", Controllers: ["Keypad"],
			PropertyInspectorPath: "ui/music-mode.html"
		});
		expect(readFileSync(path.join(root, "src", "plugin.ts"), "utf8"))
			.toContain("registerAction(new MusicModeAction())");
		expect(selectors.controls["music-mode"]).toEqual({
			menu: "audio-button-configure", menuItemName: "^\\s*high\\s+fidelity\\s+music\\s+mode\\s*$"
		});
	});

	it("keeps music settings concise without removing other actions' shared profile control", () => {
		const plugin = path.resolve(__dirname, "..", "com.bad-duck.teamscontrol.sdPlugin");
		const html = readFileSync(path.join(plugin, "ui", "music-mode.html"), "utf8");
		const descriptionsJs = readFileSync(path.join(plugin, "ui", "action-descriptions.js"), "utf8");
		const descriptions = JSON.parse(
			descriptionsJs.slice(descriptionsJs.indexOf("{"), descriptionsJs.lastIndexOf("}") + 1)
		) as Record<string, string>;
		const description = descriptions["com.bad-duck.teamscontrol.music-mode"];

		expect(description).toContain("Manual changes update the key while Teams' audio options are open.");
		expect(description).not.toMatch(/never opens menus|last observed|hidden changes|studio environments|selectors\.json/);
		expect(html).toContain("action-descriptions.js");
		expect(html).toContain('id="action-description"');
		expect(html).not.toMatch(/sdpi-item|sdpi-checkbox|pptAutoProfile|mirrors the matching|Follow the meeting|Moves the deck/);
		expect(readFileSync(path.join(plugin, "ui", "default.html"), "utf8")).toContain('setting="pptAutoProfile"');
	});
});
