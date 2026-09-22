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

/** Exported so the image pre-render uses exactly the same gray. */
export const UNAVAILABLE_COLOR = COLORS.unavailable;

/**
 * Colors PowerPoint Live gives its drawing tools.
 *
 * Teams shows these in color rather than monochrome, and the color is the
 * identity of the tool — a red pen is a different thing from a yellow
 * highlighter. Matching them means color can no longer also mean "active", so
 * the active tool is marked with the same bar Teams draws beneath it.
 *
 * The artwork and the color table live in src/tool-art.ts.
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

/** Centers a glyph's viewBox on the key canvas at the requested fill ratio. */
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

/**
 * Encodes an SVG for a touch-strip `pixmap`.
 *
 * Base64, not the percent-encoded form {@link toDataUri} produces. setImage
 * accepts either, so the keys never cared; a pixmap takes only base64 and
 * silently draws nothing when handed the other, with no error anywhere - the
 * strip simply stays dark while every call reports success.
 */
export function toPixmap(svg: string): string {
	if (svg.startsWith("data:")) return svg;
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** Renders a monochrome control glyph in the given tone. */
export function renderGlyph(key: string, tone: Tone): string {
	const def = CONTROL_GLYPHS[key];
	if (!def) return wrap("");

	// Fluent system icons carry no fill of their own, so the group colors them.
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

	// With no meeting, show the resting glyph grayed out.
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
 * Color each tool falls back to when Teams has not said which it is using —
 * before the first state arrives, or in a language whose color names are not
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
 * Ink colors PowerPoint Live offers, keyed by the words Teams puts in the
 * control's accessible name ("Pen: Light blue, Thickness 3").
 *
 * The names were captured from a live pen palette on 2026-09-17. Only two hex
 * values are confirmed — Red and Yellow, read out of the artwork Teams itself
 * rendered — and they are marked below. The rest are Office's usual values and
 * may be slightly off until the same trick is repeated with each color
 * selected; an unrecognized name falls back to the tool's default rather than
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
 * Resolves the color Teams reported for a tool.
 *
 * Black is nudged off true black: the keys are dark, and a genuinely black pen
 * tip on them is invisible rather than subtle.
 */
export function toolColor(control: string, reported: string | undefined): string {
	const fallback = TOOL_DEFAULT_COLOR[control] ?? "#FFFFFF";
	if (!reported) return fallback;

	// hasOwn, because the lookup key is an accessible name read out of the Teams
	// window: a plain index would resolve "constructor" to a function off the
	// prototype and hand back something that is not a color at all.
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

	// A color Teams has added since the images were built falls back to the
	// tool's own, which is always rendered.
	return (
		TOOL_IMAGES[key] ??
		TOOL_IMAGES[`${control}|${TOOL_DEFAULT_COLOR[control]}|${active ? "on" : "off"}`] ??
		TOOL_IMAGES[`${control}|unavailable`] ??
		""
	);
}

/** Fraction of the key the artwork fills when a label sits beneath it. */
const LABELED_FILL = 0.56;
/** How far the artwork lifts to make room for the label. */
const LABELED_LIFT = 16;

function escapeText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
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
 * the pill, which is the part that is recognizable at a glance.
 *
 * Teams only renders the button once you have navigated away on your own, so
 * the two states are not "can press" and "cannot press" but two different
 * facts: you are behind and can jump forward, or you are already watching live.
 * They are worded that way rather than leaving a dimmed pill to be interpreted.
 */
export function renderLive(available: boolean): string {
	if (!available) {
		return wrap(
			`<text x="${SIZE / 2}" y="${SIZE / 2 + 10}" text-anchor="middle" ` +
				`font-family="Segoe UI, system-ui, sans-serif" font-size="28" font-weight="600" ` +
				`fill="${COLORS.unavailable}">In sync</text>`
		);
	}

	const w = 112;
	const h = 44;
	const x = (SIZE - w) / 2;
	const y = 66;

	return (
		wrap(
			`<text x="${SIZE / 2}" y="52" text-anchor="middle" ` +
				`font-family="Segoe UI, system-ui, sans-serif" font-size="26" font-weight="600" ` +
				`fill="${COLORS.on}">Sync to</text>` +
				`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${LIVE_RED}"/>` +
				`<text x="${SIZE / 2}" y="${y + h / 2 + 11}" text-anchor="middle" ` +
				`font-family="Segoe UI, system-ui, sans-serif" font-size="30" font-weight="700" ` +
				`letter-spacing="1.5" fill="#FFFFFF">LIVE</text>`
		)
	);
}

export function renderLabeled(key: string, label: string, tone: Tone): string {
	const def = CONTROL_GLYPHS[key];
	if (!def) return wrap("");

	const art =
		`<g transform="translate(0 ${-LABELED_LIFT}) ${transformFor(def, LABELED_FILL)}" ` +
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

/**
 * The slide counter with the slide itself above it.
 *
 * The picture is a PNG data URI from the sidecar, already composed to the width
 * of a key, so it is embedded rather than redrawn here. It sits against the top
 * edge and the count sits under it, which is the only arrangement that leaves a
 * 16:9 slide readable on a square key.
 */
export function renderSlideCount(image: string, label: string): string {
	const art = `<image x="0" y="0" width="${SIZE}" height="${SLIDE_KEY_H}" href="${escapeText(image)}" />`;
	if (!label) return wrap(art);

	const text = escapeText(label);
	const fontSize = text.length > 5 ? 30 : 36;

	return wrap(
		art +
			`<text x="${SIZE / 2}" y="${SIZE - 26}" text-anchor="middle" ` +
			`font-family="Segoe UI, system-ui, sans-serif" font-size="${fontSize}" ` +
			`font-weight="600" fill="${COLORS["on"]}">${text}</text>`
	);
}

/** How tall a 16:9 slide is across the full width of a key. */
export const SLIDE_KEY_W = SIZE;
export const SLIDE_KEY_H = Math.round((SIZE * 9) / 16);

/** Renders a full-color reaction, dimmed when the control is unavailable. */
export function renderReaction(key: string, available: boolean): string {
	return renderEmojiGlyph(REACTION_GLYPHS[key] ?? REACTION_GLYPHS["react-like"], available);
}

/** Renders a full-color emoji used outside the reaction set, such as the hand. */
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

	const center = SIZE / 2;
	const art = `<g transform="${transformFor(def, REACTION_FILL)}">${def.body}</g>`;
	// sin(2π) is not exactly zero, so compare against the printed precision
	// rather than 0 - otherwise the final frame carries a rotate(-0.00) and no
	// longer matches the resting icon, costing an extra setImage on every press.
	const rotate = Math.abs(angle) < 0.005 ? "" : ` rotate(${angle.toFixed(2)})`;

	return wrap(
		`<g transform="translate(${center} ${(center + offsetY).toFixed(2)})${rotate} ` +
			`scale(${scale.toFixed(4)}) translate(${-center} ${-center})">${art}</g>`
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

/* ------------------------------------------------------------------------- *
 * Touch strip
 *
 * A dial's slot is 200x100 and is drawn as one image rather than assembled
 * from a built-in layout's icon-and-value slots, which put the icon hard left
 * and the number hard right and read as off-center above a dial. Everything
 * here is centered on the slot, so it sits over the dial it belongs to.
 * ------------------------------------------------------------------------- */

/** The touch strip gives every dial the same canvas, on every device. */
const STRIP_W = 200;
const STRIP_H = 100;

/** Teams' own accent, used for the slider so it reads as a Teams control. */
const STRIP_ACCENT = "#7B83EB";
const STRIP_TRACK = "#4A4A52";

function strip(body: string): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${STRIP_W}" height="${STRIP_H}" ` +
		`viewBox="0 0 ${STRIP_W} ${STRIP_H}">${body}</svg>`
	);
}

/**
 * Ink thickness, drawn the way PowerPoint Live draws it.
 *
 * A tapered wedge in the ink color over a slider, which is what the flyout
 * shows - so the dial is recognizably the same control rather than a bar chart
 * standing in for one.
 */
export function renderInkThickness(color: string, value: number, min = 1, max = 6): string {
	const x0 = 16;
	const x1 = 140;
	const span = max > min ? (clampValue(value, min, max) - min) / (max - min) : 0;
	const knobX = x0 + span * (x1 - x0);

	// Left tip is deliberately not zero-height: a true point disappears once
	// Stream Deck scales this down for the strip.
	const wedge = `16,33 168,23 168,43 16,36`;

	return strip(
		`<polygon points="${wedge}" fill="${color}" />` +
			`<rect x="${x0}" y="${64}" width="${x1 - x0}" height="5" rx="2.5" fill="${STRIP_TRACK}" />` +
			`<rect x="${x0}" y="${64}" width="${Math.max(0, knobX - x0)}" height="5" rx="2.5" fill="${STRIP_ACCENT}" />` +
			`<circle cx="${knobX.toFixed(1)}" cy="66.5" r="9" fill="${STRIP_ACCENT}" stroke="#20202A" stroke-width="1.5" />` +
			`<text x="176" y="75" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" ` +
			`font-size="26" font-weight="600" fill="#FFFFFF">${escapeText(String(Math.round(value)))}</text>`
	);
}

/**
 * The ink color, as a block of the color itself.
 *
 * A swatch says it faster than a name does, so the name is a caption under it
 * rather than the main event - and it steps down a size rather than running off
 * the slot, because "Light green" is nearly twice the width of "Red".
 */
export function renderInkColor(color: string, name: string): string {
	const text = escapeText(name);
	const size = text.length > 12 ? 16 : text.length > 9 ? 18 : 21;

	return strip(
		`<rect x="18" y="10" width="164" height="48" rx="10" fill="${color}" ` +
			`stroke="#FFFFFF" stroke-opacity="0.28" stroke-width="1.5" />` +
			(text
				? `<text x="100" y="85" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" ` +
					`font-size="${size}" font-weight="600" fill="#FFFFFF">${text}</text>`
				: "")
	);
}

/**
 * Rough width of a string at a given size, in the strip's own font.
 *
 * SVG has no way to ask, and the touch strip silently clips rather than
 * shrinking, so a caption that does not fit is simply lost - which is how
 * "that slide is scrolled out of view" ended up on screen cut in half. The
 * constant is calibrated against Segoe UI by rasterising these captions and
 * measuring the ink: the widest measured about 0.43 of the font size per
 * character, so this errs a little wide of that. `tests/icons.test.ts` renders
 * every caption the plugin can produce and fails if one overruns the slot,
 * which is what keeps the estimate honest.
 */
function textWidth(text: string, size: number): number {
	return text.length * size * 0.47;
}

/** Greedy wrap, or null when it will not fit in the lines allowed. */
function wrapText(text: string, size: number, maxWidth: number, maxLines: number): string[] | null {
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];

	const lines: string[] = [];
	let line = "";

	for (const word of words) {
		if (textWidth(word, size) > maxWidth) return null;

		const candidate = line === "" ? word : `${line} ${word}`;
		if (textWidth(candidate, size) <= maxWidth) {
			line = candidate;
			continue;
		}

		lines.push(line);
		if (lines.length >= maxLines) return null;
		line = word;
	}

	if (line !== "") lines.push(line);
	return lines.length <= maxLines ? lines : null;
}

/** The widest a caption may be before it starts touching the edge of the slot. */
const STRIP_TEXT_WIDTH = 186;

/**
 * The meeting timer: what is left of it, and how much of it that is.
 *
 * Teams publishes no total anywhere, so the bar is drawn against the longest
 * remaining time seen since the timer last went up - which is the duration in
 * every ordinary case, because a timer starts at its full length.
 *
 * The bar empties left to right, and goes red near the end rather than only
 * when it runs out, because the point of a timer on a desk is to be readable
 * without being looked at directly.
 */
/**
 * The meeting timer: what is left of it, and how much of it that is.
 *
 * Drawn to match Teams' own bar, which was captured at 10 Hz across a full
 * run and fitted rather than guessed (sidecar/probe-timer-run.ps1). Three
 * things came out of that, none of them obvious:
 *
 *   - The bar is a flat color for most of a run, not a gradient. A gradient
 *     only appears as time runs down, and only across the part still filled.
 *   - The two ends redden on different schedules. The right end - the end of
 *     the timer - starts going red at about 42% remaining, the left end at
 *     about 25%, which is what makes the gradient open up and then close again
 *     as the whole bar arrives at red.
 *   - It never snaps. At zero it flashes three times over about 2.6 seconds
 *     and then holds solid red.
 */
export function renderTimer(
	remaining: number,
	total: number,
	running: boolean,
	expired = false,
	overtime?: number
): string {
	const left = Math.max(0, remaining);
	const span = Math.max(1, total);
	const fraction = expired ? 0 : Math.max(0, Math.min(1, left / span));

	const clock = expired
		? overtime === undefined
			? ""
			: `-${hhmmss(overtime)}`
		: hhmmss(left);

	// Fitted from the capture: each end ramps from its own threshold to zero.
	const uLeft = expired ? 1 : clamp01(1 - fraction / 0.25);
	const uRight = expired ? 1 : clamp01(1 - fraction / 0.42);
	const from = mixHex(TIMER_BLUE, TIMER_RED, uLeft);
	const to = mixHex(TIMER_BLUE, TIMER_RED, uRight);

	// The clock reddens with the bar rather than switching at a threshold, so
	// the urgency arrives gradually. White at the start keeps it legible.
	const ink = expired ? TIMER_RED : running ? mixHex("#FFFFFF", TIMER_RED, uLeft) : "#A8A8B2";
	const size = clock.length > 5 ? 34 : 42;

	const x = 16;
	const width = STRIP_W - x * 2;

	// Fractional, not rounded: the bar creeps about a tenth of a pixel per
	// frame, so rounding is the difference between a smooth drain and a step
	// once a second.
	const filled = expired ? width : width * fraction;
	const filledX = x + width - filled;

	return strip(
		`<defs><linearGradient id="timerFill" x1="0" y1="0" x2="1" y2="0">` +
			`<stop offset="0" stop-color="${from}" />` +
			`<stop offset="1" stop-color="${to}" />` +
			`</linearGradient></defs>` +
			(clock
				? `<text x="100" y="${running || expired ? 52 : 48}" text-anchor="middle" ` +
					`font-family="Segoe UI, system-ui, sans-serif" font-size="${size}" font-weight="700" ` +
					`fill="${ink}">${escapeText(clock)}</text>`
				: `<text x="100" y="54" text-anchor="middle" ` +
					`font-family="Segoe UI, system-ui, sans-serif" font-size="30" font-weight="700" ` +
					`fill="#FFFFFF">TIME'S UP</text>`) +
			// The trough stays visible at zero so the bar reads as empty rather
			// than as a control that has gone away.
			`<rect x="${x}" y="64" width="${width}" height="10" rx="5" fill="#2A2A31" />` +
			(filled > 0.2
				? `<rect x="${filledX.toFixed(2)}" y="64" width="${filled.toFixed(2)}" height="10" rx="5" ` +
					`fill="url(#timerFill)" fill-opacity="${fillOpacity(running, expired, overtime).toFixed(3)}" />`
				: "") +
			(clock
				? expired
					? `<text x="100" y="92" text-anchor="middle" ` +
						`font-family="Segoe UI, system-ui, sans-serif" font-size="13" font-weight="700" ` +
						`letter-spacing="1.4" fill="#FFFFFF">TIME'S UP</text>`
					: running
						? ""
						: `<text x="100" y="92" text-anchor="middle" ` +
							`font-family="Segoe UI, system-ui, sans-serif" font-size="13" font-weight="700" ` +
							`letter-spacing="1.4" fill="#7E7E88">PAUSED</text>`
				: "")
	);
}

/**
 * How opaque the fill is.
 *
 * Teams pulses the bar three times when time runs out, about a second apart,
 * dipping to roughly a quarter and coming back, and then leaves it solid. A
 * paused bar is dimmed so it reads as not advancing.
 */
function fillOpacity(running: boolean, expired: boolean, overtime?: number): number {
	if (!expired) return running ? 1 : 0.5;
	if (overtime === undefined || overtime >= FLASH_FOR_S) return 1;

	// Starts at the dim end, which is where the capture starts too.
	const phase = Math.sin(Math.PI * overtime) ** 2;
	return FLASH_MIN + (1 - FLASH_MIN) * phase;
}

/** Teams' own timer colors, sampled from its bar. */
const TIMER_BLUE = "#7579EB";
const TIMER_RED = "#D13438";

/** How long the bar pulses once time is up, and how far down each pulse dips. */
const FLASH_FOR_S = 2.6;
const FLASH_MIN = 0.28;

function clamp01(n: number): number {
	return Math.max(0, Math.min(1, n));
}

/** Blends two #rrggbb colors; t of 0 is all `a`, 1 is all `b`. */
function mixHex(a: string, b: string, t: number): string {
	const k = clamp01(t);
	const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
	const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
	const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
	return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** m:ss, or h:mm:ss once there is an hour to show. */
function hhmmss(seconds: number): string {
	// Floored, not rounded, because that is what Teams shows: its own label
	// reads "4 min, 57 sec remaining" for anything from 4:57 to just under
	// 4:58. Rounding would put this dial a second ahead of the meeting.
	const s = Math.max(0, Math.floor(seconds));
	const mins = Math.floor(s / 60);
	const secs = s % 60;
	// Teams' timer counts in minutes, but allows an hour or more, and "62:05"
	// reads as a minute count rather than as over an hour.
	return s >= 3600
		? `${Math.floor(s / 3600)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
		: `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * The slide being dialled to: the thumbnail dimmed, with the number over it.
 *
 * Turning the dial has to say where it is going before it goes there, because
 * getting there takes Teams the better part of a second and a dial that waits
 * for that feels broken. So the picture the slot already has is dimmed and used
 * as a backdrop, and the number counts with the dial.
 *
 * The thumbnail is a PNG data URI from the sidecar, embedded rather than
 * recomposed: redrawing the slide for every click of the dial would mean a
 * capture per tick.
 */
export function renderSlideJump(image: string | undefined, slide: number, total: number): string {
	const backdrop =
		image === undefined
			? `<rect width="${STRIP_W}" height="${STRIP_H}" fill="#101014" />`
			: `<image x="0" y="0" width="${STRIP_W}" height="${STRIP_H}" ` +
				`preserveAspectRatio="xMidYMid slice" href="${escapeText(image)}" />`;

	const caption = total > 0 ? `of ${total}` : "";

	return strip(
		backdrop +
			// Dark enough that the number reads at a glance, light enough that
			// the slide underneath is still recognizable.
			`<rect width="${STRIP_W}" height="${STRIP_H}" fill="#000000" fill-opacity="0.66" />` +
			`<text x="100" y="${caption ? 58 : 66}" text-anchor="middle" ` +
			`font-family="Segoe UI, system-ui, sans-serif" font-size="46" font-weight="700" ` +
			`fill="#FFFFFF">${slide}</text>` +
			(caption
				? `<text x="100" y="82" text-anchor="middle" ` +
					`font-family="Segoe UI, system-ui, sans-serif" font-size="16" font-weight="500" ` +
					`fill="#B8B8C0">${escapeText(caption)}</text>`
				: "")
	);
}

/**
 * The next slide by name, for when there is no picture of it to show.
 *
 * Teams scrolls the filmstrip so the current slide sits at its trailing edge,
 * so a presenter moving forward never has the next slide drawn anywhere on
 * screen - there are no pixels to capture, and no amount of waiting produces
 * any. The name is in the accessibility tree either way, so the slot says what
 * is coming rather than going blank.
 *
 * Drawn as a slide rather than as a caption: a thin frame and a title, so it
 * reads as the same kind of thing as the thumbnail it stands in for.
 */
export function renderStripNext(title: string, label = "NEXT"): string {
	const text = title.trim();

	// Three lines is most of the slot, so it steps down rather than truncating
	// - a slide called "Questions?" and one called "Tea Brewing Techniques and
	// Pairings" both have to land inside the frame.
	const width = 164;
	// Fitted against the height as well as the width. Wrapping alone chose a
	// size that fitted across and then ran three lines of it up into the label
	// above, so the band below that label is part of the constraint.
	const band = 50;
	let size = 20;
	let lines: string[] | null = null;

	for (const candidate of [20, 18, 16, 14, 12]) {
		const wrapped = wrapText(text, candidate, width, 3);
		if (wrapped === null) continue;

		const height = wrapped.length * candidate + (wrapped.length - 1) * 3;
		if (height > band) continue;

		size = candidate;
		lines = wrapped;
		break;
	}
	lines ??= [text];

	const step = size + 3;
	const first = 40 + size + (band - (lines.length * size + (lines.length - 1) * 3)) / 2;
	const body = lines
		.map(
			(line, i) =>
				`<text x="100" y="${first + i * step}" text-anchor="middle" ` +
				`font-family="Segoe UI, system-ui, sans-serif" font-size="${size}" ` +
				`font-weight="600" fill="#E8E8EC">${escapeText(line)}</text>`
		)
		.join("");

	return strip(
		// A slide-shaped frame, so the slot still reads as a slide rather than
		// as an error message. Deliberately not the red Teams draws around the
		// live slide: this is the one after it.
		`<rect x="8" y="8" width="184" height="84" rx="5" fill="#1B1B1F" ` +
			`stroke="#3A3A42" stroke-width="1.5" />` +
			`<text x="100" y="30" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" ` +
			`font-size="12" font-weight="700" letter-spacing="1.6" fill="#7E7E88">${escapeText(label)}</text>` +
			body
	);
}
export function renderStripIdle(label: string, detail: string): string {
	// Stepped down and wrapped rather than trusted to fit. These captions carry
	// whatever reason the sidecar gave, so their length is not knowable here.
	let size = 18;
	let lines = wrapText(detail, size, STRIP_TEXT_WIDTH, 2);
	for (const smaller of [16, 14, 12]) {
		if (lines !== null) break;
		size = smaller;
		lines = wrapText(detail, size, STRIP_TEXT_WIDTH, 2);
	}
	lines ??= [detail];

	const two = lines.length > 1;
	const labelY = two ? 38 : 45;
	const firstY = two ? 64 : 74;

	const caption = lines
		.map(
			(line, i) =>
				`<text x="100" y="${firstY + i * (size + 4)}" text-anchor="middle" ` +
				`font-family="Segoe UI, system-ui, sans-serif" font-size="${size}" ` +
				`font-weight="400" fill="#5A5A62">${escapeText(line)}</text>`
		)
		.join("");

	return strip(
		`<text x="100" y="${labelY}" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" ` +
			`font-size="22" font-weight="600" fill="#8A8A92">${escapeText(label)}</text>` +
			caption
	);
}

function clampValue(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}
