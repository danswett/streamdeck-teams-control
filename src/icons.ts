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
import toolImages from "./tool-images.generated.json" with { type: "json" };

/** Source viewBox plus inner SVG markup for one piece of artwork. */
export type GlyphDef = {
	viewBox: string;
	body: string;
};

const CONTROL_GLYPHS = glyphs.controls as Record<string, GlyphDef>;
const REACTION_GLYPHS = glyphs.reactions as Record<string, GlyphDef>;
const EMOJI_GLYPHS = glyphs.emoji as Record<string, GlyphDef>;

/** Pre-rendered tool artwork, keyed '<control>|<ink hex>|<on|off>'. */
const TOOL_IMAGES = toolImages.images as Record<string, string>;
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

/** Exported so the image pre-render uses exactly the same grey. */
export const UNAVAILABLE_COLOR = COLORS.unavailable;

/**
 * Colours PowerPoint Live gives its drawing tools.
 *
 * Teams shows these in colour rather than monochrome, and the colour is the
 * identity of the tool — a red pen is a different thing from a yellow
 * highlighter. Matching them means colour can no longer also mean "active", so
 * the active tool is marked with the same bar Teams draws beneath it.
 *
 * The artwork and the colour table live in src/tool-art.ts.
 */
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

/** Encodes an SVG for `setImage`, passing through anything already encoded. */
export function toDataUri(svg: string): string {
	// The drawing tools ship as pre-rendered PNG data URIs; everything else is
	// SVG built here.
	if (svg.startsWith("data:")) return svg;
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



/**
 * Colour each tool falls back to when Teams has not said which it is using —
 * before the first state arrives, or in a language whose colour names are not
 * in the table.
 */
export const TOOL_DEFAULT_COLOR: Record<string, string> = {
	"ppt-cursor": "#FFFFFF",
	"ppt-laser": "#FF3B30",
	"ppt-pen": "#FF3B30",
	"ppt-highlighter": "#FFC000",
	"ppt-eraser": "#F2A3A3"
};

/**
 * Ink colours PowerPoint Live offers, keyed by the words Teams puts in the
 * control's accessible name ("Pen: Light blue, Thickness 3").
 *
 * The names were captured from a live pen palette on 2026-09-17. Only two hex
 * values are confirmed — Red and Yellow, read out of the artwork Teams itself
 * rendered — and they are marked below. The rest are Office's usual values and
 * may be slightly off until the same trick is repeated with each colour
 * selected; an unrecognised name falls back to the tool's default rather than
 * guessing.
 */
export const INK_COLORS: Record<string, string> = {
	red: "#E3182D", // confirmed: pen and laser, captured from the DOM
	yellow: "#FFFC00", // confirmed: highlighter, captured from the DOM

	black: "#2B2B2B",
	gray: "#7F7F7F",
	grey: "#7F7F7F",
	"light gray": "#BFBFBF",
	"light grey": "#BFBFBF",
	"dark red": "#C00000",
	orange: "#E36C0A",
	"light orange": "#FFC000",
	"dark yellow": "#BF8F00",
	green: "#00B050",
	"light green": "#92D050",
	blue: "#0070C0",
	"light blue": "#00B0F0",
	purple: "#7030A0",
	"dark purple": "#5B2D8E",
	magenta: "#E3008C",
	pink: "#FF64B5",

	// Highlighter-only. Teams renders these as translucent washes rather than
	// solid ink, so they are approximated as pale tints here - a key drawn at
	// 50% alpha would just look unlit.
	"faded red": "#F1A7A7",
	"faded green": "#A8D8A8",
	"faded blue": "#A7C7E7",

	turquoise: "#00CFC8",
	aqua: "#00CFC8",
	lime: "#BAD80A",
	white: "#FFFFFF"
};

/**
 * Resolves the colour Teams reported for a tool.
 *
 * Black is nudged off true black: the keys are dark, and a genuinely black pen
 * tip on them is invisible rather than subtle.
 */
export function toolColor(control: string, reported: string | undefined): string {
	const fallback = TOOL_DEFAULT_COLOR[control] ?? "#FFFFFF";
	if (!reported) return fallback;

	// hasOwn, because the lookup key is an accessible name read out of the Teams
	// window: a plain index would resolve "constructor" to a function off the
	// prototype and hand back something that is not a colour at all.
	const key = reported.trim().toLowerCase();
	return Object.hasOwn(INK_COLORS, key) ? INK_COLORS[key] : fallback;
}

/**
 * Which podium to draw for a given presenter-view state.
 *
 * Lives here rather than with the action so it can be tested without pulling
 * the Stream Deck SDK into a unit test, and because it is the part that was
 * wrong: being backwards still produces a perfectly plausible key.
 *
 * A podium, not an eye — the eye is private viewing, which is a different
 * control entirely. Struck through while the notes pane exists and plain once
 * it is hidden, so the key shows what pressing it will do, matching the entry
 * PowerPoint Live swaps into its own Change view menu.
 */
export function presenterViewGlyph(showing: boolean): string {
	return showing ? "pptHidePresenterView" : "pptShowPresenterView";
}

/**
 * Which eye to draw for a given private-viewing state.
 *
 * Struck through while attendees may NOT move through the deck on their own,
 * matching Teams. Note this one is the state rather than the action: unlike the
 * presenter-view podium, the slash here says what is currently true.
 */
export function privateViewGlyph(enabled: boolean): string {
	return enabled ? "pptPrivateView" : "pptPrivateViewOff";
}

/**
 * Renders a PowerPoint Live drawing tool.
 *
 * The artwork is Microsoft's own, captured from the Teams DOM — gradients,
 * blur filters, blend modes and all. These are illustrations rather than
 * glyphs, which is why two earlier attempts (drawing them by hand, then
 * substituting the flat "Clay" icons from the Teams bundle) both looked wrong
 * next to the real toolbar.
 *
 * Returned as a pre-rendered PNG rather than SVG. Stream Deck's own renderer
 * does not support everything the artwork uses, and left the highlighter and
 * eraser tips unfilled; rasterising at build time with a complete renderer
 * means the key shows what Teams shows, and saves the deck the work.
 */
export function renderTool(
	control: string,
	options: { available: boolean; active: boolean; color?: string }
): string {
	const { available, active } = options;

	if (!available) return TOOL_IMAGES[`${control}|unavailable`] ?? "";

	const ink = toolColor(control, options.color);
	const key = `${control}|${ink}|${active ? "on" : "off"}`;

	// A colour Teams has added since the images were built falls back to the
	// tool's own, which is always rendered.
	return (
		TOOL_IMAGES[key] ??
		TOOL_IMAGES[`${control}|${TOOL_DEFAULT_COLOR[control]}|${active ? "on" : "off"}`] ??
		TOOL_IMAGES[`${control}|unavailable`] ??
		""
	);
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
/** Teams' live red, sampled from the "Sync to presenter" pill on 2026-09-18. */
const LIVE_RED = "#C50F1F";

/**
 * The "Sync to presenter" key.
 *
 * Teams gives this control no icon at all: it is a red LIVE pill beside the
 * words "Sync to presenter", and a capture of the button returns zero SVGs. So
 * there is no Fluent glyph to match and nothing to copy - the key reproduces
 * the pill, which is the part that is recognisable at a glance and the reason
 * the control reads as "you are behind" in the first place.
 *
 * Teams only renders the button once you have navigated away on your own, so an
 * unavailable key means you are already watching live.
 */
export function renderLive(available: boolean): string {
	const fill = available ? LIVE_RED : COLORS.unavailable;
	const ink = available ? "#FFFFFF" : "#1A1A1D";

	const w = 112;
	const h = 46;
	const x = (SIZE - w) / 2;
	const y = (SIZE - h) / 2;

	return wrap(
		`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>` +
			`<text x="${SIZE / 2}" y="${SIZE / 2 + 11}" text-anchor="middle" ` +
			`font-family="Segoe UI, system-ui, sans-serif" font-size="30" font-weight="700" ` +
			`letter-spacing="1.5" fill="${ink}">LIVE</text>`
	);
}

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
