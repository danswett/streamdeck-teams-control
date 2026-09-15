import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Elgato's Marketplace guidelines are checked by a human at submission time,
 * and the artwork is generated, so a regression here is invisible until a
 * submission is rejected. These assert the rules that generated files can
 * quietly break.
 *
 * https://docs.elgato.com/guidelines/stream-deck/plugins/
 */

const PLUGIN_DIR = path.resolve(__dirname, "..", "com.dswett.teamscontrol.sdPlugin");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8")) as {
	UUID: string;
	Name: string;
	Category: string;
	Author: string;
	Icon: string;
	CategoryIcon: string;
	Actions: { UUID: string; Name: string; Icon: string; States?: { Image: string }[] }[];
};

/** Resolves a manifest image reference, which omits the extension. */
function resolveImage(ref: string): string | undefined {
	for (const ext of [".svg", ".png"]) {
		const candidate = path.join(PLUGIN_DIR, ref + ext);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function coloursIn(file: string): string[] {
	const svg = readFileSync(file, "utf8");
	return [...svg.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0].toLowerCase());
}

const WHITE = new Set(["#fff", "#ffffff"]);

describe("action list icons", () => {
	it.each(manifest.Actions.map((a) => [a.Name, a.Icon] as const))(
		"%s is monochrome white",
		(_name, icon) => {
			const file = resolveImage(icon);
			expect(file, `missing icon file for ${icon}`).toBeDefined();

			// The guidelines require a white stroke on transparent; colour is
			// explicitly called out as incorrect for the action list. The keys
			// themselves may be full colour, which is why this checks Icon only.
			const offending = coloursIn(file!).filter((c) => !WHITE.has(c));
			expect(offending).toEqual([]);
		}
	);

	it("uses SVG so it scales to the high-DPI variant", () => {
		for (const action of manifest.Actions) {
			expect(resolveImage(action.Icon)!.endsWith(".svg")).toBe(true);
		}
	});

	it("draws no opaque background rectangle", () => {
		// A solid background is called out as incorrect.
		for (const action of manifest.Actions) {
			const svg = readFileSync(resolveImage(action.Icon)!, "utf8");
			expect(svg).not.toMatch(/<rect[^>]*width="(100%|144)"/);
		}
	});
});

describe("category", () => {
	it("has a monochrome white icon", () => {
		const file = resolveImage(manifest.CategoryIcon);
		expect(file).toBeDefined();
		expect(coloursIn(file!).filter((c) => !WHITE.has(c))).toEqual([]);
	});

	it("does not include the author name", () => {
		// "include author names in category" is explicitly listed as incorrect.
		expect(manifest.Category.toLowerCase()).not.toContain(manifest.Author.toLowerCase());
	});
});

describe("plugin icon", () => {
	it("is a PNG with a high-DPI variant", () => {
		const base = path.join(PLUGIN_DIR, manifest.Icon);
		expect(existsSync(base + ".png"), `${manifest.Icon}.png`).toBe(true);
		expect(existsSync(base + "@2x.png"), `${manifest.Icon}@2x.png`).toBe(true);
	});
});

describe("identifiers", () => {
	it("prefixes every action UUID with the plugin UUID", () => {
		for (const action of manifest.Actions) {
			expect(action.UUID.startsWith(manifest.UUID + ".")).toBe(true);
		}
	});

	it("gives every action a distinct UUID", () => {
		const uuids = manifest.Actions.map((a) => a.UUID);
		expect(new Set(uuids).size).toBe(uuids.length);
	});

	it("keeps action names concise", () => {
		// The guidelines ask for roughly 30 characters or fewer.
		for (const action of manifest.Actions) {
			expect(action.Name.length, action.Name).toBeLessThanOrEqual(30);
		}
	});
});

describe("state images", () => {
	it("resolve to files that exist", () => {
		// A missing state image renders as a blank key with no error anywhere.
		for (const action of manifest.Actions) {
			for (const state of action.States ?? []) {
				expect(resolveImage(state.Image), `${action.Name}: ${state.Image}`).toBeDefined();
			}
		}
	});
});
