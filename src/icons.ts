/**
 * Runtime SVG icon rendering.
 *
 * Every key image is generated on the fly rather than shipped as a PNG matrix,
 * because each control needs three visual states (on / off / unavailable) and
 * Stream Deck only supports two manifest states. All artwork here is original.
 */

const SIZE = 144;

/** Visual treatment applied to a glyph. */
export type Tone = "on" | "off" | "danger" | "accent" | "unavailable";

const COLORS: Record<Tone, string> = {
	on: "#FFFFFF",
	off: "#FFFFFF",
	danger: "#F1707B",
	accent: "#FFC83D",
	unavailable: "#4C4C4C"
};

/** Key background; matches the Stream Deck key well so glyphs read cleanly. */
const BACKDROP = "#000000";

export type Glyph =
	| "mic"
	| "camera"
	| "hand"
	| "blur"
	| "share"
	| "chat"
	| "people"
	| "leave";

type GlyphDef = {
	/** Body of the glyph, drawn in the tone colour. */
	body: (c: string) => string;
	/** Where the "disabled" slash enters and exits, in user units. */
	slash?: [number, number, number, number];
};

const GLYPHS: Record<Glyph, GlyphDef> = {
	mic: {
		body: (c) => `
			<rect x="58" y="24" width="28" height="54" rx="14" fill="${c}"/>
			<path d="M42 66 Q72 104 102 66" stroke="${c}" stroke-width="9"
				fill="none" stroke-linecap="round"/>
			<path d="M72 92 V116" stroke="${c}" stroke-width="9" stroke-linecap="round"/>
			<path d="M52 118 H92" stroke="${c}" stroke-width="9" stroke-linecap="round"/>`,
		slash: [34, 28, 110, 116]
	},

	camera: {
		body: (c) => `
			<rect x="26" y="46" width="62" height="52" rx="10" fill="${c}"/>
			<path d="M94 62 L118 46 V98 L94 82 Z" fill="${c}"/>`,
		slash: [30, 34, 114, 110]
	},

	hand: {
		body: (c) => `
			<g fill="${c}">
				<rect x="49" y="46" width="11" height="42" rx="5.5"/>
				<rect x="64" y="32" width="11" height="56" rx="5.5"/>
				<rect x="79" y="38" width="11" height="50" rx="5.5"/>
				<rect x="94" y="52" width="11" height="36" rx="5.5"/>
				<path d="M47 76 h60 v14 a30 30 0 0 1 -60 0 z"/>
			</g>`
	},

	blur: {
		// Half-sharp, half-dissolved disc: the conventional "blur" motif.
		body: (c) => `
			<path d="M72 26 A46 46 0 0 0 72 118 Z" fill="${c}"/>
			<g fill="${c}">
				<circle cx="86" cy="36" r="5"/><circle cx="102" cy="48" r="5"/>
				<circle cx="110" cy="64" r="5"/><circle cx="112" cy="82" r="4"/>
				<circle cx="102" cy="97" r="4"/><circle cx="87" cy="108" r="4"/>
				<circle cx="90" cy="60" r="4"/><circle cx="94" cy="78" r="4"/>
				<circle cx="86" cy="90" r="3.5"/>
			</g>`
	},

	share: {
		body: (c) => `
			<path d="M26 40 h92 a8 8 0 0 1 8 8 v50 a8 8 0 0 1 -8 8 h-92
				a8 8 0 0 1 -8 -8 v-50 a8 8 0 0 1 8 -8 z"
				fill="none" stroke="${c}" stroke-width="9"/>
			<path d="M72 92 V58" stroke="${c}" stroke-width="9" stroke-linecap="round"/>
			<path d="M56 72 L72 56 L88 72" stroke="${c}" stroke-width="9"
				fill="none" stroke-linecap="round" stroke-linejoin="round"/>
			<path d="M54 120 H90" stroke="${c}" stroke-width="9" stroke-linecap="round"/>`
	},

	chat: {
		body: (c) => `
			<path d="M28 34 h88 a10 10 0 0 1 10 10 v44 a10 10 0 0 1 -10 10 h-46
				l-24 20 v-20 h-18 a10 10 0 0 1 -10 -10 v-44 a10 10 0 0 1 10 -10 z"
				fill="${c}"/>`
	},

	people: {
		body: (c) => `
			<g fill="${c}">
				<circle cx="56" cy="50" r="18"/>
				<path d="M24 114 a32 32 0 0 1 64 0 z"/>
				<circle cx="98" cy="56" r="14" opacity="0.85"/>
				<path d="M74 114 a26 26 0 0 1 50 0 z" opacity="0.85"/>
			</g>`
	},

	leave: {
		// Handset rotated to the classic "hang up" angle.
		body: (c) => `
			<g transform="rotate(135 72 72)">
				<path d="M40 52 c0 -10 8 -16 18 -14 l10 2 c7 1 11 7 10 14 l-1 7
					c-1 6 3 11 9 13 l16 5 c6 2 12 -1 14 -7 l3 -7 c3 -7 10 -10 17 -7
					c9 4 12 13 8 21 c-9 19 -30 28 -55 21 c-30 -8 -49 -28 -49 -48 z"
					fill="${c}"/>
			</g>`
	}
};

/** Reaction artwork, drawn as vectors so it never depends on an emoji font. */
type Palette = { face: string; ink: string; heart: string; hand: string };

const LIVE: Palette = { face: "#FFC83D", ink: "#3A2E00", heart: "#F1707B", hand: "#FFC83D" };
const DIM: Palette = { face: "#4C4C4C", ink: "#1A1A1A", heart: "#4C4C4C", hand: "#4C4C4C" };

const REACTIONS: Record<string, (p: Palette) => string> = {
	"react-like": (p) => `
		<path d="M26 64 h20 a4 4 0 0 1 4 4 v44 a4 4 0 0 1 -4 4 h-20 a6 6 0 0 1 -6 -6
			v-40 a6 6 0 0 1 6 -6 z" fill="${p.hand}"/>
		<path d="M50 64 c9 0 15 -7 17 -15 l4 -17 c2 -9 15 -8 15 3 v19 h22 c9 0 15 8 13 16
			l-8 32 c-2 9 -10 15 -19 15 h-44 z" fill="${p.hand}"/>`,

	"react-love": (p) => `
		<path d="M72 120 C38 95 20 77 20 56 C20 39 33 26 50 26 C61 26 68 32 72 40
			C76 32 83 26 94 26 C111 26 124 39 124 56 C124 77 106 95 72 120 Z" fill="${p.heart}"/>`,

	"react-applause": (p) => `
		<g fill="${p.hand}">
			<path d="M40 118 c-10 -6 -16 -18 -13 -30 l8 -30 c2 -8 14 -6 13 3 l-3 18 22 -34
				c5 -8 16 -2 12 7 l-14 26 26 -18 c8 -5 15 5 8 11 z"/>
			<path d="M104 116 c10 -6 15 -18 12 -29 l-6 -22 c-2 -8 -13 -6 -12 2 l2 13 -16 -24
				c-5 -8 -15 -2 -11 6 l10 19 -19 -13 c-7 -5 -14 4 -7 10 z" opacity="0.85"/>
		</g>
		<g stroke="${p.hand}" stroke-width="6" stroke-linecap="round" opacity="0.7">
			<path d="M70 30 V16"/><path d="M46 36 L38 24"/><path d="M96 36 L104 24"/>
		</g>`,

	"react-laugh": (p) => `
		<circle cx="72" cy="72" r="46" fill="${p.face}"/>
		<g stroke="${p.ink}" stroke-width="7" fill="none" stroke-linecap="round">
			<path d="M44 62 q10 -12 20 0"/>
			<path d="M80 62 q10 -12 20 0"/>
		</g>
		<path d="M44 82 a28 28 0 0 0 56 0 z" fill="${p.ink}"/>`,

	"react-wow": (p) => `
		<circle cx="72" cy="72" r="46" fill="${p.face}"/>
		<circle cx="55" cy="60" r="7" fill="${p.ink}"/>
		<circle cx="89" cy="60" r="7" fill="${p.ink}"/>
		<ellipse cx="72" cy="93" rx="13" ry="17" fill="${p.ink}"/>`
};

export const REACTION_KEYS = Object.keys(REACTIONS);

export const REACTION_LABEL: Record<string, string> = {
	"react-like": "Like",
	"react-love": "Love",
	"react-applause": "Applause",
	"react-laugh": "Laugh",
	"react-wow": "Wow"
};

function wrap(inner: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${inner}</svg>`;
}

/** Encodes an SVG for `setImage`; URI encoding keeps the payload small. */
export function toDataUri(svg: string): string {
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Renders a control glyph.
 *
 * `struck` draws the slash used for muted / camera-off, cut out with a
 * backdrop-coloured stroke underneath so it reads at key size.
 */
export function renderGlyph(glyph: Glyph, tone: Tone, struck = false): string {
	const def = GLYPHS[glyph];
	const color = COLORS[tone];
	let inner = def.body(color);

	if (struck && def.slash) {
		const [x1, y1, x2, y2] = def.slash;
		inner += `
			<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${BACKDROP}" stroke-width="22" stroke-linecap="round"/>
			<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${color}" stroke-width="10" stroke-linecap="round"/>`;
	}

	return wrap(inner);
}

/** Renders a reaction key, greyed out when the control is unavailable. */
export function renderReaction(key: string, available: boolean): string {
	const draw = REACTIONS[key] ?? REACTIONS["react-like"]!;
	return wrap(draw(available ? LIVE : DIM));
}

/**
 * Chooses the right image for a two-state control.
 *
 * `active` is the real Teams state (muted, camera on, hand raised...).
 * `struckWhenActive` flips which side of the toggle gets the slash: a muted mic
 * is struck when active, whereas a camera is struck when *inactive*.
 */
export function renderToggle(
	glyph: Glyph,
	available: boolean,
	active: boolean | undefined,
	struckWhenActive: boolean,
	dangerWhenStruck = true
): string {
	if (!available || active === undefined) {
		return renderGlyph(glyph, "unavailable", active === undefined ? false : active === struckWhenActive);
	}
	const struck = active === struckWhenActive;
	const tone: Tone = struck && dangerWhenStruck ? "danger" : "on";
	return renderGlyph(glyph, tone, struck);
}

/** Simple one-shot control (share, chat, people, leave). */
export function renderSimple(glyph: Glyph, available: boolean, danger = false): string {
	if (!available) return renderGlyph(glyph, "unavailable");
	return renderGlyph(glyph, danger ? "danger" : "on");
}
