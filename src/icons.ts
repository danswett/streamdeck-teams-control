/**
 * Key artwork.
 *
 * Every image is generated at runtime rather than shipped as a PNG matrix,
 * because each control needs three visual states (on / off / unavailable) and
 * Stream Deck only supports two manifest states.
 *
 * The glyphs come from Microsoft's MIT-licensed Fluent sets (see
 * src/glyphs.generated.ts), which are the same icons Teams renders, so the keys
 * match the app without copying any proprietary artwork.
 */
import glyphs from "./glyphs.generated.json" with { type: "json" };

/** Source viewBox plus inner SVG markup for one piece of artwork. */
export type GlyphDef = {
	viewBox: string;
	body: string;
};

const CONTROL_GLYPHS = glyphs.controls as Record<string, GlyphDef>;
const REACTION_GLYPHS = glyphs.reactions as Record<string, GlyphDef>;
const EMOJI_GLYPHS = glyphs.emoji as Record<string, GlyphDef>;

/** Stream Deck key canvas. 144px is the high-DPI size; it scales down cleanly. */
const SIZE = 144;

/** Visual treatment applied to a monochrome control glyph. */
export type Tone = "on" | "danger" | "accent" | "unavailable";

const COLORS: Record<Tone, string> = {
	on: "#FFFFFF",
	danger: "#F1707B",
	accent: "#FFC83D",
	unavailable: "#4A4A4A"
};

/** Fraction of the key the artwork fills. */
const CONTROL_FILL = 0.80;
/** Left a little headroom so the press animation can grow without clipping. */
const REACTION_FILL = 0.78;

export const REACTION_KEYS = Object.keys(REACTION_GLYPHS);

export const REACTION_LABEL: Record<string, string> = {
	"react-like": "Like",
	"react-love": "Love",
	"react-applause": "Applause",
	"react-laugh": "Laugh",
	"react-wow": "Wow"
};

/** Centres a glyph's viewBox on the key canvas at the requested fill ratio. */
function transformFor(def: GlyphDef, fill: number): string {
	const [minX, minY, width, height] = def.viewBox.split(/\s+/).map(Number) as [
		number,
		number,
		number,
		number
	];

	const extent = Math.max(width, height);
	const scale = (SIZE * fill) / extent;
	const offsetX = (SIZE - width * scale) / 2 - minX * scale;
	const offsetY = (SIZE - height * scale) / 2 - minY * scale;

	return `translate(${offsetX.toFixed(3)} ${offsetY.toFixed(3)}) scale(${scale.toFixed(5)})`;
}

function wrap(inner: string): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" ` +
		`viewBox="0 0 ${SIZE} ${SIZE}">${inner}</svg>`
	);
}

/** Encodes an SVG for `setImage`. */
export function toDataUri(svg: string): string {
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Renders a monochrome control glyph in the given tone. */
export function renderGlyph(key: string, tone: Tone): string {
	const def = CONTROL_GLYPHS[key];
	if (!def) return wrap("");

	// Fluent system icons carry no fill of their own, so the group colours them.
	return wrap(
		`<g transform="${transformFor(def, CONTROL_FILL)}" fill="${COLORS[tone]}">${def.body}</g>`
	);
}

type ToggleOptions = {
	/** Glyph shown when the state is active. */
	onKey: string;
	/** Glyph shown when the state is inactive. */
	offKey: string;
	/** Real Teams state; undefined when it could not be read. */
	active: boolean | undefined;
	available: boolean;
	/** Tone for the active side. */
	onTone?: Tone;
	/** Tone for the inactive side. */
	offTone?: Tone;
};

/**
 * Renders a two-state control. Teams supplies distinct glyphs for each side
 * (a muted mic really is a different icon), so no slash is drawn on top.
 */
export function renderToggle(opts: ToggleOptions): string {
	const { onKey, offKey, active, available } = opts;

	// With no meeting, show the resting glyph greyed out.
	if (!available) return renderGlyph(active === false ? offKey : onKey, "unavailable");

	if (active === undefined) return renderGlyph(onKey, "on");
	return active
		? renderGlyph(onKey, opts.onTone ?? "on")
		: renderGlyph(offKey, opts.offTone ?? "danger");
}

/** Renders a single-glyph control such as chat, people or leave. */
export function renderSimple(key: string, available: boolean, tone: Tone = "on"): string {
	return renderGlyph(key, available ? tone : "unavailable");
}

/** Fraction of the key the artwork fills when a label sits beneath it. */
const LABELLED_FILL = 0.56;
/** How far the artwork lifts to make room for the label. */
const LABELLED_LIFT = 16;

function escapeText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Renders a glyph with a short label beneath it.
 *
 * Used for the slide counter, where the useful information is a value rather
 * than a state. Stream Deck's own title field is deliberately not used: it
 * cannot be driven from plugin state without fighting whatever the user typed,
 * and it renders under, not inside, the image.
 */
export function renderLabelled(key: string, label: string, tone: Tone): string {
	const def = CONTROL_GLYPHS[key];
	if (!def) return wrap("");

	const art =
		`<g transform="translate(0 ${-LABELLED_LIFT}) ${transformFor(def, LABELLED_FILL)}" ` +
		`fill="${COLORS[tone]}">${def.body}</g>`;

	if (!label) return wrap(art);

	// Long labels would otherwise run off the key, so the glyph's own font size
	// steps down once there are more than five characters ("12/199").
	const text = escapeText(label);
	const fontSize = text.length > 5 ? 28 : 34;

	return wrap(
		`${art}<text x="${SIZE / 2}" y="${SIZE - 22}" text-anchor="middle" ` +
			`font-family="Segoe UI, system-ui, sans-serif" font-size="${fontSize}" ` +
			`font-weight="600" fill="${COLORS[tone]}">${text}</text>`
	);
}

/** Renders a full-colour reaction, dimmed when the control is unavailable. */
export function renderReaction(key: string, available: boolean): string {
	return renderEmojiGlyph(REACTION_GLYPHS[key] ?? REACTION_GLYPHS["react-like"], available);
}

/** Renders a full-colour emoji used outside the reaction set, such as the hand. */
export function renderEmoji(key: string, available: boolean): string {
	return renderEmojiGlyph(EMOJI_GLYPHS[key], available);
}

/**
 * One frame of a key press animation.
 *
 * `progress` runs 0 to 1. Stream Deck cannot play animated images — `setImage`
 * rejects GIF — so movement has to be driven frame by frame.
 *
 * A single sine arch drives every property: it peaks halfway through and
 * returns exactly to rest at the end, so the final frame matches the static
 * icon and no easing table is needed. The defaults are capped so the artwork
 * grows without clipping at the key edge.
 */
export function renderEmojiFrame(
	key: string,
	progress: number,
	options: { pop?: number; lift?: number; tilt?: number } = {}
): string {
	const def = REACTION_GLYPHS[key] ?? EMOJI_GLYPHS[key];
	if (!def) return wrap("");

	const { pop = 0.2, lift = -6, tilt = 9 } = options;

	const t = Math.min(Math.max(progress, 0), 1);
	const arch = Math.sin(Math.PI * t);
	const scale = 1 + pop * arch;
	const offsetY = lift * arch;
	const angle = tilt === 0 ? 0 : tilt * Math.sin(2 * Math.PI * t);

	const centre = SIZE / 2;
	const art = `<g transform="${transformFor(def, REACTION_FILL)}">${def.body}</g>`;
	// sin(2π) is not exactly zero, so compare against the printed precision
	// rather than 0 - otherwise the final frame carries a rotate(-0.00) and no
	// longer matches the resting icon, costing an extra setImage on every press.
	const rotate = Math.abs(angle) < 0.005 ? "" : ` rotate(${angle.toFixed(2)})`;

	return wrap(
		`<g transform="translate(${centre} ${(centre + offsetY).toFixed(2)})${rotate} ` +
			`scale(${scale.toFixed(4)}) translate(${-centre} ${-centre})">${art}</g>`
	);
}

/** Press animation for a reaction: a pop with a little wobble. */
export function renderReactionFrame(key: string, progress: number): string {
	return renderEmojiFrame(key, progress);
}

/** Press animation for raise hand: lifts straight up, no wobble. */
export function renderHandFrame(progress: number): string {
	return renderEmojiFrame("hand", progress, { pop: 0.08, lift: -12, tilt: 0 });
}

function renderEmojiGlyph(def: GlyphDef | undefined, available: boolean): string {
	if (!def) return wrap("");

	const art = `<g transform="${transformFor(def, REACTION_FILL)}">${def.body}</g>`;
	// Opacity is used rather than a filter so it rasterises everywhere.
	return wrap(available ? art : `<g opacity="0.25">${art}</g>`);
}
