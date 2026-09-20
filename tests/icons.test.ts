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
	renderLive,
	renderReaction,
	renderReactionFrame,
	renderSimple,
	renderSlideCount,
	renderSlideJump,
	renderStripIdle,
	renderStripNext,
	renderTimer,
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
 * pays a one-off initialization on first use - font enumeration especially -
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
		// Raw '#' would truncate the URI at the first color literal.
		expect(uri).not.toContain("#");
	});

	it("encodes color literals rather than leaving them raw", () => {
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

describe("ink colors", () => {
	// The sidecar reads a color name off the Teams palette and the plugin turns
	// it into ink. A name the sidecar can report but the plugin does not know
	// renders in the tool's default color instead, silently showing the wrong
	// ink - so the two lists have to agree.
	const selectors = JSON.parse(
		readFileSync("com.bad-duck.teamscontrol.sdPlugin/selectors.json", "utf8")
	) as { powerPointLive: { inkColorNames: string[] } };

	it("renders every color the sidecar can report", () => {
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

	it("gives each color distinct artwork", () => {
		const green = renderTool("ppt-pen", { available: true, active: true, color: "Light green" });
		const red = renderTool("ppt-pen", { available: true, active: true, color: "Red" });
		expect(green).not.toBe(red);
	});

	it("falls back rather than throwing on a color Teams has since added", () => {
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
		// Hollow centers...
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
/**
 * "Sync to presenter" is the one key drawn from scratch rather than from
 * Fluent. Teams gives the control no icon at all - a capture of the button
 * returns zero SVGs, because it is a red LIVE pill beside the words - so there
 * is nothing to path-match and nothing upstream to keep it honest.
 */
describe("the live pill", () => {
	// Sampled from the live attendee toolbar on 2026-09-18, 691 pixels of it.
	const TEAMS_LIVE_RED = "#C50F1F";

	it("uses the red Teams actually draws", () => {
		expect(renderLive(true).toUpperCase()).toContain(TEAMS_LIVE_RED);
	});

	it("says what to do, not just LIVE", () => {
		// "LIVE" alone names the state rather than the action. The key says both:
		// what pressing it does, and the badge Teams shows for being behind.
		expect(renderLive(true)).toContain(">Sync to<");
		expect(renderLive(true)).toContain(">LIVE<");
	});

	it("says you are already live instead of dimming the pill", () => {
		// The button only exists once you have navigated away on your own, so the
		// two states are different facts, not enabled and disabled. A grayed-out
		// pill would leave that to be interpreted; the words do not.
		const dim = renderLive(false);
		expect(dim).toContain(">In sync<");
		expect(dim).not.toContain(">LIVE<");
		expect(dim.toUpperCase()).not.toContain(TEAMS_LIVE_RED);
	});

	it("is a pill rather than a square", () => {
		const rx = /<rect[^>]*\brx="([\d.]+)"[^>]*height="(\d+)"/.exec(renderLive(true))
			?? /<rect[^>]*height="(\d+)"[^>]*\brx="([\d.]+)"/.exec(renderLive(true));
		expect(rx, "no rounded rect found").toBeTruthy();
		const svg = renderLive(true);
		const height = Number(/height="(\d+)"[^>]*rx=/.exec(svg)?.[1] ?? /rx="[\d.]+"[^>]*height="(\d+)"/.exec(svg)?.[1]);
		const radius = Number(/rx="([\d.]+)"/.exec(svg)?.[1]);
		expect(radius).toBeCloseTo(height / 2, 1);
	});
});
/* ------------------------------------------------------------------------- *
 * Touch-strip captions
 *
 * The strip clips rather than shrinking, and says nothing when it does, so a
 * caption that does not fit is silently lost. renderStripIdle wraps and steps
 * the size down to avoid that, but it does so against an *estimate* of how wide
 * the text will be - SVG offers no way to ask. These tests rasterise the real
 * thing and measure the ink, which is the only way to know the estimate is
 * still right.
 * ------------------------------------------------------------------------- */

/** Every caption the plugin can put on a dial slot. */
const CAPTIONS: [string, string][] = [
	["Current slide", "turn on in settings"],
	["Next slide", "turn on in settings"],
	["Current slide", "waiting for the slide"],
	["Next slide", "waiting for the slide"],
	["Current slide", "no deck"],
	["Next slide", "no deck"],
	["End of show", "no slide after this one"],
	["Next slide", "presenter view is closed"],
	["Next slide", "scrolled out of view"],
	["Next slide", "no slide selected"],
	["Next slide", "slide has no size"],
	["Next slide", "could not measure it"],
	["Next slide", "could not capture it"],
	["Current slide", "no slide is being shown"],
	["Current slide", "not in a meeting"],
	// Not produced any more, but it is the one that actually shipped clipped,
	// so it stays as the case that must never regress.
	["Next slide", "that slide is scrolled out of view"]
];

/** The bounding box of everything drawn, in slot pixels. */
function inkBox(
	svg: string,
	width = 200
): { left: number; right: number; top: number; bottom: number } {
	// Rasterised at the size the artwork is actually shown at, so the numbers
	// are in its own coordinates: a 144px key measured on a 200px canvas reads
	// 1.39x too wide and fails a bounds check it actually passes.
	const img = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();
	const px = img.pixels;

	let left = img.width;
	let right = -1;
	let top = img.height;
	let bottom = -1;

	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			const i = (y * img.width + x) * 4;
			// The slot is drawn on a near-black card, so ink is anything
			// appreciably brighter than the background it sits on.
			if (px[i] < 70 && px[i + 1] < 70 && px[i + 2] < 70) continue;
			if (x < left) left = x;
			if (x > right) right = x;
			if (y < top) top = y;
			if (y > bottom) bottom = y;
		}
	}

	return { left, right, top, bottom };
}

describe("touch-strip captions", () => {
	it.each(CAPTIONS)("fits %s / %s inside the slot", (label, detail) => {
		const svg = renderStripIdle(label, detail);
		expectSvg(svg);

		const box = inkBox(svg);
		expect(box.right).toBeGreaterThan(0);

		// A slot is 200x100. Anything touching an edge has been cut off.
		expect(box.left).toBeGreaterThanOrEqual(1);
		expect(box.right).toBeLessThanOrEqual(198);
		expect(box.top).toBeGreaterThanOrEqual(1);
		expect(box.bottom).toBeLessThanOrEqual(98);
	});

	it("keeps a long caption on two lines rather than shrinking it away", () => {
		const svg = renderStripIdle("Next slide", "that slide is scrolled out of view");

		// Three text nodes: the label, then the caption split over two lines.
		expect((svg.match(/<text/g) ?? []).length).toBe(3);
	});

	it("leaves a caption that already fits on one line", () => {
		const svg = renderStripIdle("Next slide", "scrolled out of view");
		expect((svg.match(/<text/g) ?? []).length).toBe(2);
	});
});

describe("next-slide title cards", () => {
	// Real slide names from the test deck, plus the shapes that break layout:
	// one word, one very long word, and a title that needs all three lines.
	const TITLES = [
		"Tea Temperature",
		"Conclusion",
		"Questions?",
		"Welcome to Blissful Brews",
		"Hibiscus Flower and Lavender Tea",
		"Tea Brewing Techniques and Pairings",
		"Internationalisation",
		"A",
		"Q4 FY26 Revenue Attainment by Segment and Region"
	];

	it.each(TITLES)("fits %s inside the slot", (title) => {
		const svg = renderStripNext(title);
		expectSvg(svg);

		const box = inkBox(svg);
		expect(box.right).toBeGreaterThan(0);
		expect(box.left).toBeGreaterThanOrEqual(1);
		expect(box.right).toBeLessThanOrEqual(198);
		expect(box.top).toBeGreaterThanOrEqual(1);
		expect(box.bottom).toBeLessThanOrEqual(98);
	});

	it("keeps the title clear of the label above it", () => {
		// Three lines at the largest size used to run up into "NEXT".
		const svg = renderStripNext("Tea Brewing Techniques and Pairings");
		const ys = [...svg.matchAll(/<text[^>]*y="([\d.]+)"/g)].map((m) => Number(m[1]));

		// First is the label; every title line sits below it with room to spare.
		const [label, ...body] = ys;
		expect(body.length).toBeGreaterThan(1);
		for (const y of body) expect(y).toBeGreaterThan(label + 8);
	});

	it("says whose slide it is", () => {
		expect(renderStripNext("Conclusion")).toContain(">NEXT<");
		expect(renderStripNext("Conclusion", "NOW")).toContain(">NOW<");
	});
});

describe("dialling to a slide", () => {
	// A 1x1 PNG is enough: what matters is that it is embedded rather than
	// dropped, not what it looks like.
	const PNG =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

	it("embeds the thumbnail it was given", () => {
		const svg = renderSlideJump(PNG, 7, 14);
		expectSvg(svg);
		expect(svg).toContain("<image");
		expect(svg).toContain(PNG);
	});

	it("still draws without one", () => {
		const svg = renderSlideJump(undefined, 7, 14);
		expectSvg(svg);
		expect(svg).not.toContain("<image");
	});

	it("shows where the dial is pointing", () => {
		const svg = renderSlideJump(PNG, 7, 14);
		expect(svg).toContain(">7<");
		expect(svg).toContain(">of 14<");
	});

	it("leaves the total off when it is not known", () => {
		const svg = renderSlideJump(PNG, 7, 0);
		expect(svg).toContain(">7<");
		expect(svg).not.toContain("of 0");
	});

	it("keeps the number inside the slot at every slide number", () => {
		for (const n of [1, 9, 14, 99, 140]) {
			const box = inkBox(renderSlideJump(undefined, n, 140));
			expect(box.left).toBeGreaterThanOrEqual(1);
			expect(box.right).toBeLessThanOrEqual(198);
			expect(box.bottom).toBeLessThanOrEqual(98);
		}
	});
});

describe("slide counter with the slide on it", () => {
	const PNG =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

	it("embeds the slide and shows the count", () => {
		const svg = renderSlideCount(PNG, "8/14");
		expectSvg(svg);
		expect(svg).toContain("<image");
		expect(svg).toContain(PNG);
		expect(svg).toContain(">8/14<");
	});

	it("keeps the slide clear of the count", () => {
		// A 16:9 slide across a square key leaves the lower third for the
		// number; overlapping them made both unreadable.
		const svg = renderSlideCount(PNG, "8/14");
		const imageH = Number(/<image[^>]*height="(\d+)"/.exec(svg)?.[1]);
		const textY = Number(/<text[^>]*y="(\d+)"/.exec(svg)?.[1]);
		const fontSize = Number(/<text[^>]*font-size="(\d+)"/.exec(svg)?.[1]);

		expect(imageH).toBe(81);
		expect(textY - fontSize).toBeGreaterThan(imageH);
	});

	it("steps the count down when the deck is long", () => {
		const short = /font-size="(\d+)"/.exec(renderSlideCount(PNG, "8/14"))?.[1];
		const long = /font-size="(\d+)"/.exec(renderSlideCount(PNG, "12/199"))?.[1];
		expect(Number(long)).toBeLessThan(Number(short));
	});

	it("draws the slide alone when there is no count yet", () => {
		const svg = renderSlideCount(PNG, "");
		expectSvg(svg);
		expect(svg).not.toContain("<text");
	});

	it("keeps every count inside the key", () => {
		for (const label of ["1/9", "8/14", "12/199", "199/199"]) {
			const box = inkBox(renderSlideCount(PNG, label), 144);
			expect(box.left).toBeGreaterThanOrEqual(0);
			expect(box.right).toBeLessThanOrEqual(143);
			expect(box.bottom).toBeLessThanOrEqual(143);
		}
	});
});

describe("the meeting timer", () => {
	/** The two rects: the trough first, then the fill if there is any. */
	function bars(svg: string): { x: number; w: number }[] {
		return [...svg.matchAll(/<rect x="(-?[\d.]+)"[^>]*width="([\d.]+)"/g)].map((m) => ({
			x: Number(m[1]),
			w: Number(m[2])
		}));
	}

	it("drains left to right", () => {
		// The fill is anchored to the right, so as time runs down its right edge
		// stays put and its left edge walks rightwards. Anchoring it to the left
		// drains the other way and reads as time being added.
		const [, full] = bars(renderTimer(300, 300, true));
		const [, half] = bars(renderTimer(150, 300, true));
		const [, nearlyGone] = bars(renderTimer(15, 300, true));

		const rightEdge = (b: { x: number; w: number }): number => b.x + b.w;
		expect(rightEdge(half)).toBe(rightEdge(full));
		expect(rightEdge(nearlyGone)).toBe(rightEdge(full));

		expect(half.x).toBeGreaterThan(full.x);
		expect(nearlyGone.x).toBeGreaterThan(half.x);
	});

	it("keeps the fill inside the trough at both ends", () => {
		for (const left of [300, 299, 150, 1, 0]) {
			const [trough, fill] = bars(renderTimer(left, 300, true));
			if (!fill) continue;
			expect(fill.x).toBeGreaterThanOrEqual(trough.x);
			expect(fill.x + fill.w).toBeLessThanOrEqual(trough.x + trough.w);
		}
	});

	it("leaves the trough alone when the time is up", () => {
		const svg = renderTimer(0, 300, true);
		expect(bars(svg)).toHaveLength(1);
		expect(svg).toContain(">0:00<");
	});

	it("says when it is paused, and only then", () => {
		expect(renderTimer(150, 300, false)).toContain(">PAUSED<");
		expect(renderTimer(150, 300, true)).not.toContain(">PAUSED<");
	});

	it("spells out an hour rather than counting past sixty minutes", () => {
		expect(renderTimer(3725, 3900, true)).toContain(">1:02:05<");
		expect(renderTimer(3599, 3900, true)).toContain(">59:59<");
	});

	it("keeps every reading inside the slot", () => {
		for (const [left, total] of [
			[300, 300],
			[150, 300],
			[0, 300],
			[3725, 3900],
			[35999, 36000]
		]) {
			const box = inkBox(renderTimer(left, total, true));
			expect(box.left).toBeGreaterThanOrEqual(1);
			expect(box.right).toBeLessThanOrEqual(198);
			expect(box.bottom).toBeLessThanOrEqual(98);
		}
	});
});

describe("the timer when time is up", () => {
	it("fills the whole bar and says so", () => {
		const svg = renderTimer(0, 300, true, true, 4);
		expectSvg(svg);
		expect(svg).toContain("TIME'S UP");

		// Two rects: the trough, and a fill covering it exactly.
		const rects = [...svg.matchAll(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/g)].map((m) => ({
			x: Number(m[1]),
			w: Number(m[2])
		}));
		expect(rects).toHaveLength(2);
		expect(rects[1].x).toBe(rects[0].x);
		expect(rects[1].w).toBe(rects[0].w);
	});

	it("counts the overtime negative when it watched it run out", () => {
		expect(renderTimer(0, 300, true, true, 4)).toContain(">-0:04<");
		expect(renderTimer(0, 300, true, true, 75)).toContain(">-1:15<");
	});

	it("shows no number when it did not see it run out", () => {
		// Teams pins the accessible name at "0 sec remaining" once time is up,
		// so a dial that arrives mid-overtime has nothing to count from and
		// must not invent one.
		const svg = renderTimer(0, 300, true, true, undefined);
		expect(svg).not.toMatch(/>-?\d+:\d\d</);
		expect(svg).toContain("TIME'S UP");
	});

	it("is red rather than gradient", () => {
		const svg = renderTimer(0, 300, true, true, 4);
		expect(svg).toContain("#D13438");
		expect(svg).not.toContain("url(#timerFill)");
	});
});

describe("the timer bar's paint", () => {
	it("sweeps Teams' own two colors across the fill", () => {
		// Scaled to the fill, not the trough, so a stub still shows the whole
		// sweep - which is what Teams does.
		const svg = renderTimer(200, 300, true);
		expect(svg).toContain("url(#timerFill)");
		expect(svg).toContain("#7478E8");
		expect(svg).toContain("#A05998");
	});

	it("goes solid red near the end", () => {
		const svg = renderTimer(20, 300, true);
		expect(svg).toContain("#D13438");
		expect(svg).not.toContain('fill="url(#timerFill)"');
	});

	it("dims the fill while paused rather than recoloring it", () => {
		const svg = renderTimer(200, 300, false);
		expect(svg).toContain("url(#timerFill)");
		expect(svg).toMatch(/fill-opacity="0\.5"/);
	});
});
