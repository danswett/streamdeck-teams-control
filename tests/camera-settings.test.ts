import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cameraArgument, type CameraPreference } from "../src/camera-settings";

describe("per-camera video preferences", () => {
	it("groups each camera's preferences into its own initially collapsed section", () => {
		const html = readFileSync(new URL("../com.bad-duck.teamscontrol.sdPlugin/ui/camera-select.html", import.meta.url), "utf8");
		const sections = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
		expect(sections).toHaveLength(2);
		for (const [index, section] of sections.entries()) {
			expect(section[1]).not.toMatch(/\bopen\b/);
			expect(section[2]).toContain("<summary>Advanced Settings</summary>");
			const controls = /<div class="camera-preference-controls">([\s\S]*?)<\/div>/.exec(section[2]!);
			expect(controls).not.toBeNull();
			expect(controls![1]).not.toContain("<summary");
			const labels = [...controls![1]!.matchAll(/<label for="([^"]+)">/g)];
			expect(labels).toHaveLength(3);
			for (const label of labels) expect(controls![1]).toContain(`<sdpi-select id="${label[1]}"`);
			const settings = [...section[2]!.matchAll(/setting="([^"]+)"/g)].map((match) => match[1]);
			expect(settings).toEqual(index === 0
				? ["mirror", "softFocus", "brightness"]
				: ["secondMirror", "secondSoftFocus", "secondBrightness"]);
		}
		expect(sections[1]![1]).toContain('id="second-preferences"');
		expect(sections[1]![1]).toContain('style="display: none"');
	});

	it("keeps the original single-camera protocol for existing settings", () => {
		expect(cameraArgument({}, false)).toBeUndefined();
		expect(cameraArgument({ cameraId: "@device:sw:camera" }, false)).toBe("@device:sw:camera");
		expect(cameraArgument({ cameraId: "one", mirror: "unchanged" }, false)).toBe("one");
	});

	it("keeps the original swap protocol without preferences", () => {
		expect(cameraArgument({ cameraId: "one", secondCameraId: "two" }, true)).toBe('["one","two"]');
		expect(cameraArgument({}, true)).toBe('["",""]');
	});

	it.each(["on", "off"] satisfies CameraPreference[])("includes each single-camera preference set to %s", (value) => {
		const arg = cameraArgument({ cameraId: "one", mirror: value, softFocus: value, brightness: value }, false);
		expect(JSON.parse(arg!)).toEqual({ cameras: [{
			id: "one", mirror: value, softFocus: value, brightness: value
		}] });
	});

	it("keeps opposite preferences associated with the correct swap camera", () => {
		const arg = cameraArgument({
			cameraId: "one", secondCameraId: "two",
			mirror: "on", softFocus: "off", brightness: "on",
			secondMirror: "off", secondSoftFocus: "on", secondBrightness: "off"
		}, true);
		expect(JSON.parse(arg!)).toEqual({ cameras: [
			{ id: "one", mirror: "on", softFocus: "off", brightness: "on" },
			{ id: "two", mirror: "off", softFocus: "on", brightness: "off" }
		] });
	});

	it("ignores hidden second-camera preferences on a single-camera button", () => {
		expect(cameraArgument({ cameraId: "one", secondMirror: "on" }, false)).toBe("one");
	});

	it("defaults unset preferences to unchanged when only one is managed", () => {
		expect(JSON.parse(cameraArgument({ cameraId: "one", brightness: "off" }, false)!)).toEqual({
			cameras: [{ id: "one", mirror: "unchanged", softFocus: "unchanged", brightness: "off" }]
		});
	});
});
