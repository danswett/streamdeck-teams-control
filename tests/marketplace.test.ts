import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";

/**
 * Elgato's Marketplace guidelines are checked by a human at submission time,
 * and the artwork is generated, so a regression here is invisible until a
 * submission is rejected. These assert the rules that generated files can
 * quietly break.
 *
 * https://docs.elgato.com/guidelines/stream-deck/plugins/
 */

const PLUGIN_DIR = path.resolve(__dirname, "..", "com.bad-duck.teamscontrol.sdPlugin");
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

function colorsIn(file: string): string[] {
	const svg = readFileSync(file, "utf8");
	return [...svg.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0].toLowerCase());
}

const WHITE = new Set(["#fff", "#ffffff"]);

/** Rasterised at the size the action list draws, doubled for high DPI. */
const LIST_RASTER = 40;
/** Below this alpha the pixel is antialiasing fringe, not artwork. */
const INK = 16;

type Raster = { pixels: Buffer | Uint8Array; width: number; height: number };

function rasterise(file: string): Raster {
	const svg =
		path.extname(file) === ".svg"
			? readFileSync(file, "utf8")
			: // resvg only reads SVG, so a PNG is wrapped in one to be measured.
				`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
				`width="${LIST_RASTER}" height="${LIST_RASTER}" ` +
				`viewBox="0 0 ${LIST_RASTER} ${LIST_RASTER}">` +
				`<image width="${LIST_RASTER}" height="${LIST_RASTER}" xlink:href="data:image/png;base64,` +
				`${readFileSync(file).toString("base64")}"/></svg>`;

	const img = new Resvg(svg, { fitTo: { mode: "width", value: LIST_RASTER } }).render();
	return { pixels: img.pixels, width: img.width, height: img.height };
}

/**
 * Every color the icon actually puts on screen, as `#rrggbb`.
 *
 * Reading the markup is not enough on its own: it cannot see a PNG at all, and
 * an SVG can arrive at a color through a gradient or a blend rather than a
 * literal. resvg hands back premultiplied alpha, so white at 12% opacity comes
 * out as rgb(31,31,31); dividing the alpha back out is the difference between
 * reading a glyph's antialiasing as a gray ramp and reading it as the one
 * color it was drawn in.
 */
function renderedColors(file: string): string[] {
	const img = rasterise(file);
	const seen = new Set<string>();

	for (let i = 0; i < img.width * img.height; i++) {
		const a = img.pixels[i * 4 + 3];
		if (a < INK) continue;

		const hex = [0, 1, 2]
			.map((c) => Math.min(255, Math.round((img.pixels[i * 4 + c] * 255) / a)))
			.map((c) => c.toString(16).padStart(2, "0"))
			.join("");
		seen.add(`#${hex}`);
	}
	return [...seen];
}

/** Share of the canvas carrying ink. A solid background reads as ~1. */
function coverage(file: string): number {
	const img = rasterise(file);
	let inked = 0;
	for (let i = 0; i < img.width * img.height; i++) {
		if (img.pixels[i * 4 + 3] >= INK) inked++;
	}
	return inked / (img.width * img.height);
}

describe("action list icons", () => {
	/**
	 * Every action, with no exceptions.
	 *
	 * The five PowerPoint Live drawing tools used to be one: their keys show
	 * Teams' own full-color artwork, and a generic monochrome pen beside the
	 * real one reads as a different control, so the artwork went in the list
	 * too. Marketplace review sent v1.8.2 back over exactly that, so the list
	 * now uses the same Fluent glyphs as everything else and the artwork stays
	 * where the guidelines allow it - on the keys.
	 */
	const listIcons = manifest.Actions.map((a) => [a.Name, a.Icon] as const);

	it.each(listIcons)("%s is monochrome white", (_name, icon) => {
		const file = resolveImage(icon);
		expect(file, `missing icon file for ${icon}`).toBeDefined();

		// The guidelines require a white stroke on transparent; color is
		// explicitly called out as incorrect for the action list. The keys
		// themselves may be full color, which is why this checks Icon only.
		expect(colorsIn(file!).filter((c) => !WHITE.has(c))).toEqual([]);
		expect(renderedColors(file!)).toEqual(["#ffffff"]);
	});

	it.each(listIcons)("%s uses SVG so it scales to the high-DPI variant", (_name, icon) => {
		expect(resolveImage(icon)!.endsWith(".svg")).toBe(true);
	});

	it.each(listIcons)("%s draws no opaque background", (_name, icon) => {
		const file = resolveImage(icon)!;

		// A solid background is called out as incorrect. Checked as markup and
		// again as pixels, because a background need not be a <rect>.
		expect(readFileSync(file, "utf8")).not.toMatch(/<rect[^>]*width="(100%|144)"/);
		expect(coverage(file)).toBeLessThan(0.8);
	});

	it.each(listIcons)("%s actually draws something", (_name, icon) => {
		expect(coverage(resolveImage(icon)!)).toBeGreaterThan(0.01);
	});
});

describe("category", () => {
	it("has a monochrome white icon", () => {
		const file = resolveImage(manifest.CategoryIcon);
		expect(file).toBeDefined();
		expect(colorsIn(file!).filter((c) => !WHITE.has(c))).toEqual([]);
		expect(renderedColors(file!)).toEqual(["#ffffff"]);
		expect(coverage(file!)).toBeLessThan(0.8);
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

	it("declares every action the code registers, and registers every action it declares", () => {
		// The SDK throws on connect when an @action UUID is not in the manifest
		// - "manifestId was not found within the manifest" - which takes the
		// whole plugin down before a single key appears. Nothing else catches
		// it: the manifest validates, the code compiles, and the two are only
		// compared at runtime. A slide dial shipped named one thing in the
		// decorator and another in the manifest exactly this way.
		const dir = path.join("src", "actions");
		const declared = new Set<string>();
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".ts")) continue;
			const source = readFileSync(path.join(dir, file), "utf8");
			for (const m of source.matchAll(/@action\(\{\s*UUID:\s*"([^"]+)"/g)) declared.add(m[1]);
		}

		expect(declared.size, "no @action decorators found; has the layout changed?").toBeGreaterThan(0);

		const inManifest = new Set(manifest.Actions.map((a) => a.UUID));
		for (const uuid of declared) {
			expect(inManifest.has(uuid), `${uuid} is registered in code but missing from the manifest`).toBe(true);
		}
		for (const uuid of inManifest) {
			expect(declared.has(uuid), `${uuid} is in the manifest but no code registers it`).toBe(true);
		}
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

describe("property inspector descriptions", () => {
	const PLUGIN = "com.bad-duck.teamscontrol.sdPlugin";
	const manifest = JSON.parse(readFileSync(path.join(PLUGIN, "manifest.json"), "utf8")) as {
		Actions: { UUID: string; Name: string; Tooltip?: string; PropertyInspectorPath?: string }[];
	};

	// Twenty PowerPoint Live actions share one inspector, so the panel looks up
	// the clicked action here. Hand-written rather than generated: these say
	// what the key does, what its state means and when it is available, which
	// the one-line tooltip cannot.
	const generated = readFileSync(path.join(PLUGIN, "ui", "action-descriptions.js"), "utf8");
	const descriptions = JSON.parse(
		generated.slice(generated.indexOf("{"), generated.lastIndexOf("}") + 1)
	) as Record<string, string>;

	it("describes every action", () => {
		for (const action of manifest.Actions) {
			expect(descriptions[action.UUID], `no description for ${action.Name}`).toBeTruthy();
		}
	});

	it("describes nothing that is not an action", () => {
		const uuids = new Set(manifest.Actions.map((a) => a.UUID));
		for (const uuid of Object.keys(descriptions)) {
			expect(uuids.has(uuid), `${uuid} is not an action`).toBe(true);
		}
	});

	it("says more than the tooltip already does", () => {
		// The whole point of the panel text: if it only repeated the one-liner
		// from the action list it would not be worth the space.
		for (const action of manifest.Actions) {
			const description = descriptions[action.UUID];
			expect(description.length, action.Name).toBeGreaterThan(80);
			expect(description, action.Name).not.toBe(action.Tooltip?.trim());
		}
	});

	it("is loaded by every inspector that needs it", () => {
		const inspectors = new Set(
			manifest.Actions.map((a) => a.PropertyInspectorPath).filter(Boolean) as string[]
		);
		for (const rel of inspectors) {
			const html = readFileSync(path.join(PLUGIN, rel), "utf8");
			expect(html, rel).toContain("action-descriptions.js");
			expect(html, rel).toContain('id="action-description"');
			// Generated text goes in as text, not markup.
			expect(html, rel).not.toMatch(/\.innerHTML\s*=/);
		}
	});

	it("ships no debug tooling in the inspectors", () => {
		const inspectors = new Set(
			manifest.Actions.map((a) => a.PropertyInspectorPath).filter(Boolean) as string[]
		);
		for (const rel of inspectors) {
			const html = readFileSync(path.join(PLUGIN, rel), "utf8");
			expect(html, rel).not.toContain("Diagnostics");
			expect(html, rel).not.toContain("discover");
		}
	});
});

describe("action list order", () => {
	// Stream Deck lists actions in manifest order, so this is the only lever on
	// how the list reads. Grouped by the role a key needs: shared PowerPoint
	// Live keys, then attendee-only, then presenter-only. Run
	// tools/order-actions.ts after adding one.
	const manifest = JSON.parse(
		readFileSync(path.join("com.bad-duck.teamscontrol.sdPlugin", "manifest.json"), "utf8")
	) as { Actions: { Name: string }[] };

	const rank = (name: string): number =>
		name.startsWith("PPT Live:") ? 1
		: name.startsWith("PPT Attendee:") ? 2
		: name.startsWith("PPT Presenter:") ? 3
		: 0;

	it("groups the PowerPoint Live keys by role, in order", () => {
		const ranks = manifest.Actions.map((a) => rank(a.Name));
		for (let i = 1; i < ranks.length; i++) {
			expect(
				ranks[i],
				` sits after a later group`
			).toBeGreaterThanOrEqual(ranks[i - 1]);
		}
	});

	it("names every PowerPoint Live action with a role prefix", () => {
		// Anything ppt-* without one would silently sort in with the meeting
		// controls at the top.
		for (const action of manifest.Actions as { Name: string; UUID: string }[]) {
			if (!action.UUID.includes(".ppt-")) continue;
			expect(rank(action.Name), action.Name).toBeGreaterThan(0);
		}
	});
});
/**
 * The submission listing itself. The copy and the media are reviewed by a
 * human and uploaded by hand, so nothing else catches them drifting away from
 * the plugin - an earlier description advertised a zoom key long after it was
 * removed, and claimed 20 translation languages when 19 ship plus an off
 * switch. These assert Elgato's hard limits and keep the copy honest about
 * what the plugin actually does.
 *
 * https://docs.elgato.com/guidelines/products
 */
describe("the Marketplace listing", () => {
	const MARKET_DIR = path.resolve(__dirname, "..", "marketplace");
	const readme = readFileSync(path.join(MARKET_DIR, "README.md"), "utf8");

	/** Every fenced block, so the copy can be asserted where it is authored. */
	function fencedBlocks(): { lang: string; text: string }[] {
		const out: { lang: string; text: string }[] = [];
		let inFence = false;
		let lang = "";
		let buf: string[] = [];

		for (const line of readme.split(/\r?\n/)) {
			const fence = /^```(\w*)\s*$/.exec(line);
			if (fence) {
				if (!inFence) {
					inFence = true;
					lang = fence[1];
					buf = [];
				} else {
					out.push({ lang, text: buf.join("\n") });
					inFence = false;
				}
				continue;
			}
			if (inFence) buf.push(line);
		}
		return out;
	}

	const plain = fencedBlocks().filter((b) => b.lang === "");
	const name = plain.find((b) => !b.text.includes("\n"))?.text ?? "";
	const description = plain.find((b) => b.text.startsWith("Control Microsoft Teams"))?.text ?? "";
	const releaseNotes = plain.filter((b) => b !== undefined && b.text.length > 400 && b.text !== description);

	/** Reads width and height out of a PNG's IHDR, no decoder needed. */
	function pngSize(file: string): { width: number; height: number } {
		const buf = readFileSync(file);
		expect(buf.subarray(1, 4).toString("ascii"), `${file} is not a PNG`).toBe("PNG");
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}

	it("keeps the product name inside the length guidance", () => {
		expect(name).toBeTruthy();
		expect(name.length, `"${name}" is ${name.length} characters`).toBeLessThanOrEqual(30);
		expect(name).toBe(manifest.Name);
	});

	it("keeps the description within 250 and 1500 characters", () => {
		expect(description.length).toBeGreaterThanOrEqual(250);
		expect(description.length).toBeLessThanOrEqual(1500);
	});

	it("opens on a complete sentence, because 250 characters become the search snippet", () => {
		// Marketplace feeds the first 250 characters to search engines. Breaking
		// mid-clause there reads as truncated rather than as a summary.
		const opening = description.slice(0, 250);
		expect(opening).toMatch(/[a-z)]$|\.$/);
		expect(opening).not.toContain("\n\n");
	});

	it("keeps every release-notes block within 1500 characters", () => {
		expect(releaseNotes.length).toBeGreaterThan(0);
		for (const block of releaseNotes) {
			expect(block.text.length, block.text.slice(0, 40)).toBeLessThanOrEqual(1500);
		}
	});

	it("never names a control the plugin does not ship", () => {
		// Zoom shipped, was removed for not working reliably, and stayed in the
		// copy. A feature word in the listing has to correspond to an action.
		const actions = manifest.Actions.map((a) => a.Name.toLowerCase()).join(" ");
		const claims = ["zoom", "whiteboard", "breakout", "record", "transcript"];

		for (const claim of claims) {
			if (actions.includes(claim)) continue;
			expect(description.toLowerCase(), `description claims "${claim}"`).not.toContain(claim);
			for (const block of releaseNotes) {
				expect(block.text.toLowerCase(), `release notes claim "${claim}"`).not.toContain(claim);
			}
		}
	});

	it("ships an app icon, a thumbnail and at least three gallery items", () => {
		const gallery = [...readme.matchAll(/`(gallery-[\w-]+\.png)`/g)].map((m) => m[1]);
		const unique = [...new Set(gallery)];
		expect(unique.length, "Elgato requires three gallery items").toBeGreaterThanOrEqual(3);
		expect(unique.length, "Elgato allows at most ten").toBeLessThanOrEqual(10);

		for (const file of ["app-icon-288.png", "thumbnail.png", ...unique]) {
			const full = path.join(MARKET_DIR, file);
			expect(existsSync(full), `${file} is listed but missing`).toBe(true);

			const { width, height } = pngSize(full);
			if (file === "app-icon-288.png") {
				expect({ width, height }).toEqual({ width: 288, height: 288 });
			} else {
				expect({ width, height }, `${file} is ${width}x${height}`).toEqual({
					width: 1920,
					height: 960
				});
			}
		}
	});

	it("leaves no generated image behind that the listing does not use", () => {
		// A renamed gallery item used to linger in the folder, where it could be
		// uploaded by hand long after it stopped matching the plugin.
		const listed = new Set([
			"app-icon-288.png",
			"thumbnail.png",
			...[...readme.matchAll(/`(gallery-[\w-]+\.png)`/g)].map((m) => m[1])
		]);

		for (const file of readdirSync(MARKET_DIR).filter((f) => f.endsWith(".png"))) {
			expect(listed.has(file), `${file} is in marketplace/ but not in the README`).toBe(true);
		}
	});
});