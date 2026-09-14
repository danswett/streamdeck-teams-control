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
const REACTION_FILL = 0.84;

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

/** Renders a full-colour reaction, dimmed when the control is unavailable. */
export function renderReaction(key: string, available: boolean): string {
	return renderEmojiGlyph(REACTION_GLYPHS[key] ?? REACTION_GLYPHS["react-like"], available);
}

/** Renders a full-colour emoji used outside the reaction set, such as the hand. */
export function renderEmoji(key: string, available: boolean): string {
	return renderEmojiGlyph(EMOJI_GLYPHS[key], available);
}

function renderEmojiGlyph(def: GlyphDef | undefined, available: boolean): string {
	if (!def) return wrap("");

	const art = `<g transform="${transformFor(def, REACTION_FILL)}">${def.body}</g>`;
	// Opacity is used rather than a filter so it rasterises everywhere.
	return wrap(available ? art : `<g opacity="0.25">${art}</g>`);
}
