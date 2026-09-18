import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import {
	INK_COLORS,
	presenterViewGlyph,
	privateViewGlyph,
	REACTION_KEYS,
	renderEmoji,
	renderEmojiFrame,
	renderGlyph,
	renderHandFrame,
	renderReaction,
	renderReactionFrame,
	renderSimple,
	renderToggle,
	renderTool,
	toDataUri,
	toolColor
} from "../src/icons";

/** Stream Deck rejects anything that is not a well-formed image. */
function expectSvg(svg: string): void {
	expect(svg.startsWith("<svg")).toBe(true);
	expect(svg.endsWith("</svg>")).toBe(true);
	expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
	// Unbalanced groups render as a blank key rather than an error.
	expect((svg.match(/<g[\s>]/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
}

/**
 * Alpha sampler over a rasterised glyph: "is there ink at this point", whatever
 * tone it was drawn in.
 *
 * Cached, and warmed up before the suite runs. Rasterising is native work that
 * pays a one-off initialisation on first use - font enumeration especially -
 * and on a cold CI runner that alone blew vitest's 5s default timeout, failing
 * whichever geometry test happened to go first.
 */
const RASTER_SIZE = 288;
const samplerCache = new Map<string, (x: number, y: number) => number>();

function sampler(key: string): (x: number, y: number) => number {
	const cached = samplerCache.get(key);
	if (cached) return cached;

	const img = new Resvg(renderGlyph(key, "on"), {
		fitTo: { mode: "width", value: RASTER_SIZE }
	}).render();
	const px = img.pixels;
	const at = (fx: number, fy: number): number =>
		px[(Math.round(fy * img.height) * img.width + Math.round(fx * img.width)) * 4 + 3];

	samplerCache.set(key, at);
	return at;
}

// Generous, because it is paying for native start-up rather than for the work
// itself; every test after it samples a cached raster.
beforeAll(() => {
	sampler("pptContrast");
}, 120_000);


/** Strongest ink found along a line, so a test need not know exact coordinates. */
function maxAlong(
	at: (x: number, y: number) => number,
	axis: "x" | "y",
	fixed: number,
	from: number,
	to: number
): number {
	let max = 0;
	for (let v = from; v <= to; v += 0.004) {
		max = Math.max(max, axis === "x" ? at(v, fixed) : at(fixed, v));
	}
	return max;
}

describe("toDataUri", () => {
	it("produces a data URI setImage accepts", () => {
		const uri = toDataUri("<svg/>");

		expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
		// Raw '#' would truncate the URI at the first colour literal.
		expect(uri).not.toContain("#");
	});

	it("encodes colour literals rather than leaving them raw", () => {
		expect(toDataUri('<svg fill="#ff0000"/>')).toContain("%23ff0000");
	});
});

describe("renderToggle", () => {
	it("draws a different glyph for each side", () => {
		const on = renderToggle({ onKey: "mic", offKey: "mic-off", active: true, available: true });
		const off = renderToggle({ onKey: "mic", offKey: "mic-off", active: false, available: true });

		expectSvg(on);
		expectSvg(off);
		expect(on).not.toBe(off);
	});

	it("dims the key when the control is unavailable", () => {
		const available = renderToggle({ onKey: "mic", offKey: "mic-off", active: true, available: true });
		const dimmed = renderToggle({ onKey: "mic", offKey: "mic-off", active: true, available: false });

		expectSvg(dimmed);
		expect(dimmed).not.toBe(available);
	});

	it("falls back to the resting glyph when state could not be read", () => {
		// Teams hides the toolbar while a flyout is open; the key must still draw.
		const unknown = renderToggle({ onKey: "mic", offKey: "mic-off", active: undefined, available: true });

		expectSvg(unknown);
		expect(unknown.length).toBeGreaterThan(64);
	});

	it("keeps the off glyph while unavailable if that was the last known state", () => {
		const offUnavailable = renderToggle({ onKey: "mic", offKey: "mic-off", active: false, available: false });
		const onUnavailable = renderToggle({ onKey: "mic", offKey: "mic-off", active: true, available: false });

		expect(offUnavailable).not.toBe(onUnavailable);
	});

	it("returns valid, empty artwork for a glyph that does not exist", () => {
		const svg = renderToggle({ onKey: "nope", offKey: "nope", active: true, available: true });
		expectSvg(svg);
	});
});

describe("renderSimple", () => {
	it("dims when unavailable", () => {
		expect(renderSimple("chat", true)).not.toBe(renderSimple("chat", false));
	});
});

describe("reactions", () => {
	it("ships all five reactions", () => {
		expect(REACTION_KEYS).toHaveLength(5);
	});

	it("renders every reaction as valid artwork", () => {
		for (const key of REACTION_KEYS) {
			const svg = renderReaction(key, true);
			expectSvg(svg);
			// A missing glyph would silently fall back to an empty wrapper.
			expect(svg.length).toBeGreaterThan(128);
		}
	});

	it("gives each reaction distinct artwork", () => {
		const rendered = new Set(REACTION_KEYS.map((k) => renderReaction(k, true)));
		expect(rendered.size).toBe(REACTION_KEYS.length);
	});

	it("dims an unavailable reaction", () => {
		const key = REACTION_KEYS[0]!;
		expect(renderReaction(key, false)).toContain("opacity");
		expect(renderReaction(key, true)).not.toBe(renderReaction(key, false));
	});

	it("renders the raise-hand emoji", () => {
		const svg = renderEmoji("hand", true);
		expectSvg(svg);
		expect(svg.length).toBeGreaterThan(128);
	});
});

describe("press animation", () => {
	it("returns to the resting pose on the final frame", () => {
		// The last frame has to match the static icon or the key ends up crooked.
		const first = renderEmojiFrame("hand", 0);
		const last = renderEmojiFrame("hand", 1);

		expect(last).toBe(first);
	});

	it("moves at the midpoint", () => {
		expect(renderEmojiFrame("hand", 0.5)).not.toBe(renderEmojiFrame("hand", 0));
	});

	it("is deterministic, so unchanged frames can be cached", () => {
		expect(renderEmojiFrame("hand", 0.3)).toBe(renderEmojiFrame("hand", 0.3));
	});

	it("clamps progress outside 0..1 instead of flying off the key", () => {
		expect(renderEmojiFrame("hand", -5)).toBe(renderEmojiFrame("hand", 0));
		expect(renderEmojiFrame("hand", 5)).toBe(renderEmojiFrame("hand", 1));
	});

	it("produces valid artwork across the whole sweep", () => {
		for (let p = 0; p <= 1.0001; p += 0.1) {
			expectSvg(renderReactionFrame(REACTION_KEYS[0]!, p));
		}
	});

	it("lifts the hand vertically without wobbling it", () => {
		// The hand was deliberately changed to move straight up.
		const mid = renderHandFrame(0.5);

		expectSvg(mid);
		expect(mid).not.toContain("rotate(");
	});

	it("wobbles a reaction, unlike the hand", () => {
		const mid = renderReactionFrame(REACTION_KEYS[0]!, 0.25);
		expect(mid).toContain("rotate(");
	});

	it("returns valid empty artwork for an unknown key", () => {
		expectSvg(renderEmojiFrame("does-not-exist", 0.5));
	});
});

describe("ink colours", () => {
	// The sidecar reads a colour name off the Teams palette and the plugin turns
	// it into ink. A name the sidecar can report but the plugin does not know
	// renders in the tool's default colour instead, silently showing the wrong
	// ink - so the two lists have to agree.
	const selectors = JSON.parse(
		readFileSync("com.bad-duck.teamscontrol.sdPlugin/selectors.json", "utf8")
	) as { powerPointLive: { inkColorNames: string[] } };

	it("renders every colour the sidecar can report", () => {
		for (const name of selectors.powerPointLive.inkColorNames) {
			expect(INK_COLORS[name.toLowerCase()], `no ink for "${name}"`).toBeDefined();
		}
	});

	it("covers all three palettes, which differ from each other", () => {
		// Pen-only, highlighter-only and laser-only names respectively.
		for (const name of ["Magenta", "Faded blue", "Light orange"]) {
			expect(selectors.powerPointLive.inkColorNames).toContain(name);
		}
	});

	it("gives each colour distinct artwork", () => {
		const green = renderTool("ppt-pen", { available: true, active: true, color: "Light green" });
		const red = renderTool("ppt-pen", { available: true, active: true, color: "Red" });
		expect(green).not.toBe(red);
	});

	it("falls back rather than throwing on a colour Teams has since added", () => {
		expect(toolColor("ppt-pen", "Chartreuse Sparkle")).toBe(toolColor("ppt-pen", undefined));
	});
});

describe("PowerPoint Live glyph geometry", () => {
	// These three were all wrong in a way that looks fine in isolation and only
	// shows up beside the real toolbar: the contrast circle filled the wrong
	// half, the grid was solid where PowerPoint Live draws outlines, and refresh
	// had one arrow where it has two. Geometry, not eyeballing, so a future
	// icon swap cannot quietly reintroduce any of them.

	it("fills the left half of the contrast circle, as PowerPoint Live does", () => {
		const at = sampler("pptContrast");
		expect(at(0.42, 0.5)).toBeGreaterThan(200);
		expect(at(0.58, 0.5)).toBeLessThan(60);
	});

	it("keeps the outline on the unfilled half, so it reads as a circle", () => {
		const at = sampler("pptContrast");
		let ring = 0;
		for (let x = 0.58; x < 0.95; x += 0.005) ring = Math.max(ring, at(x, 0.5));
		expect(ring).toBeGreaterThan(150);
	});

	/** Strongest ink found along a line, so a test need not know exact coordinates. */
	function maxAlong(
		at: (x: number, y: number) => number,
		axis: "x" | "y",
		fixed: number,
		from: number,
		to: number
	): number {
		let max = 0;
		for (let v = from; v <= to; v += 0.004) {
			max = Math.max(max, axis === "x" ? at(v, fixed) : at(fixed, v));
		}
		return max;
	}

	it("draws the grid as outlined squares rather than solid ones", () => {
		const at = sampler("pptGrid");
		// Hollow centres...
		expect(at(0.31, 0.31)).toBeLessThan(60);
		expect(at(0.69, 0.69)).toBeLessThan(60);
		// ...but only right if the edges above and below them are drawn.
		expect(maxAlong(at, "y", 0.31, 0.15, 0.28)).toBeGreaterThan(200);
		expect(maxAlong(at, "y", 0.31, 0.34, 0.47)).toBeGreaterThan(200);
	});

	it("fills the grid squares once grid view is open, as Teams does on hover", () => {
		const at = sampler("pptGridOn");
		expect(at(0.31, 0.31)).toBeGreaterThan(200);
		expect(at(0.69, 0.69)).toBeGreaterThan(200);
	});

	it("draws refresh with two arrows, so both sides of the circle carry ink", () => {
		const at = sampler("pptRefresh");
		expect(maxAlong(at, "x", 0.5, 0.1, 0.35)).toBeGreaterThan(200);
		expect(maxAlong(at, "x", 0.5, 0.65, 0.9)).toBeGreaterThan(200);
		// Open in the middle: a single thick arrow would fill it.
		expect(at(0.5, 0.5)).toBeLessThan(60);
	});
});

describe("presenter view key", () => {
	// Reported as "backwards": the slash was appearing while presenter view was
	// hidden, and in accent yellow rather than white. PowerPoint Live strikes
	// the podium through while the view is SHOWING, because that is what
	// pressing it will do. A podium, not an eye - the eye is private viewing.
	it("strikes the podium through while presenter view is showing", () => {
		expect(presenterViewGlyph(true)).toBe("pptHidePresenterView");
	});

	it("shows a plain podium once presenter view is hidden", () => {
		expect(presenterViewGlyph(false)).toBe("pptShowPresenterView");
	});

	it("actually draws a slash on one and not the other", () => {
		// The slash runs corner to corner, clear of the podium itself.
		const ink = (key: string) => {
			const at = sampler(key);
			return Math.max(
				maxAlong(at, "x", 0.18, 0.12, 0.3),
				maxAlong(at, "x", 0.78, 0.7, 0.88)
			);
		};

		expect(ink("pptHidePresenterView")).toBeGreaterThan(200);
		expect(ink("pptShowPresenterView")).toBeLessThan(60);
	});
});

describe("private view key", () => {
	// The eye is struck through while attendees may NOT move through the deck
	// on their own. Unlike the presenter-view podium, the slash here is the
	// state rather than the action.
	it("strikes the eye through while private viewing is disabled", () => {
		expect(privateViewGlyph(false)).toBe("pptPrivateViewOff");
	});

	it("shows a plain eye while private viewing is enabled", () => {
		expect(privateViewGlyph(true)).toBe("pptPrivateView");
	});

	it("actually draws a slash on the disabled one and not the enabled one", () => {
		// Same diagonal as the presenter-view pair, clear of the eye itself.
		const ink = (key: string) => {
			const at = sampler(key);
			return Math.max(
				maxAlong(at, "x", 0.18, 0.12, 0.3),
				maxAlong(at, "x", 0.78, 0.7, 0.88)
			);
		};

		expect(ink("pptPrivateViewOff")).toBeGreaterThan(200);
		expect(ink("pptPrivateView")).toBeLessThan(60);
	});
});