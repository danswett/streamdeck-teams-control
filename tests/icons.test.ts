import { describe, expect, it } from "vitest";
import {
	REACTION_KEYS,
	renderEmoji,
	renderEmojiFrame,
	renderHandFrame,
	renderReaction,
	renderReactionFrame,
	renderSimple,
	renderToggle,
	toDataUri
} from "../src/icons";

/** Stream Deck rejects anything that is not a well-formed image. */
function expectSvg(svg: string): void {
	expect(svg.startsWith("<svg")).toBe(true);
	expect(svg.endsWith("</svg>")).toBe(true);
	expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
	// Unbalanced groups render as a blank key rather than an error.
	expect((svg.match(/<g[\s>]/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
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
