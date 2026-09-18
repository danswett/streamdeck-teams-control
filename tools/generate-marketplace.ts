/**
 * Renders the images Marketplace requires for a submission.
 *
 * Elgato asks for an app icon at 288x288, a thumbnail at 1920x960, and at least
 * three gallery items at 1920x960, all PNG. Generating them from the same glyph
 * set the keys use means the listing always shows the artwork that actually
 * ships, rather than a screenshot that silently goes stale.
 *
 * Run with: node tools/generate-marketplace.ts
 * https://docs.elgato.com/guidelines/products
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import {
	REACTION_KEYS,
	renderEmoji,
	renderGlyph,
	renderLabelled,
	renderLive,
	renderReaction,
	renderSimple,
	renderToggle,
	renderTool
} from "../src/icons.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Committed rather than written to dist/: these are submission deliverables
// that get reviewed and reused, not build output.
const OUT = path.join(ROOT, "marketplace");

const BG = "#141416";
const KEY_BG = "#000000";
const TEXT = "#F2F2F2";
const MUTED = "#9A9AA2";
const ACCENT = "#5059C9";
const FONT = "Segoe UI, Segoe UI Variable, sans-serif";

// Tones must match src/actions/controls.ts exactly, or the listing shows
// artwork the plugin never renders. Mute and camera stay white in both states
// because the slashed glyph already carries the meaning.
const mute = (active: boolean, available = true): string =>
	renderToggle({ onKey: "micOff", offKey: "mic", onTone: "on", offTone: "on", active, available });

const camera = (active: boolean, available = true): string =>
	renderToggle({ onKey: "camera", offKey: "cameraOff", onTone: "on", offTone: "on", active, available });

// Share is the one control that does tint: accent while sharing.
const share = (active: boolean, available = true): string =>
	renderToggle({ onKey: "shareStop", offKey: "share", onTone: "accent", offTone: "on", active, available });

// Blur has no reported state - the sidecar returns availability only - so it is
// always drawn white, exactly as BlurAction does.
const blur = (available = true): string => renderGlyph("blur", available ? "on" : "unavailable");

// Drawing tools ship as PNG artwork rather than monochrome glyphs, so the
// helper the keys use hands back a data URI instead of an SVG document. Wrap it
// so it can sit in the same layout as every other key.
const tool = (control: string, active: boolean, available = true): string => {
	const art = renderTool(control, { available, active });
	if (!art.startsWith("data:")) return art;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
		`<image href="${art}" x="0" y="0" width="144" height="144"/></svg>`
	);
};

/** Strips the wrapper so a key SVG can be nested inside a larger document. */
function inner(svg: string): string {
	return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
}

/** Draws one Stream Deck key: a rounded black tile with the artwork on top. */
function key(x: number, y: number, size: number, svg: string, caption?: string): string {
	const scale = size / 144;
	let out = `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size * 0.14}" fill="${KEY_BG}"/>`;
	out += `<g transform="translate(${x},${y}) scale(${scale})">${inner(svg)}</g>`;
	if (caption) {
		out += `<text x="${x + size / 2}" y="${y + size + 34}" fill="${MUTED}" font-family="${FONT}"
			font-size="24" text-anchor="middle">${caption}</text>`;
	}
	return out;
}

/** Lays a row of keys out centred on the canvas. */
function row(keys: { svg: string; caption?: string }[], y: number, size: number, gap: number, width: number): string {
	const total = keys.length * size + (keys.length - 1) * gap;
	const startX = (width - total) / 2;
	return keys
		.map((k, i) => key(startX + i * (size + gap), y, size, k.svg, k.caption))
		.join("");
}

function canvas(width: number, height: number, body: string): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
		`<rect width="${width}" height="${height}" fill="${BG}"/>${body}</svg>`
	);
}

function write(name: string, svg: string, width: number): void {
	const png = new Resvg(svg, {
		fitTo: { mode: "width", value: width },
		font: { loadSystemFonts: true }
	})
		.render()
		.asPng();

	const file = path.join(OUT, name);
	writeFileSync(file, png);
	console.log(`  ${path.relative(ROOT, file)}`);
}

const W = 1920;
const H = 960;

// ---------------------------------------------------------------- app icon
// The guidelines ask for the product to be the focus. A single microphone
// reads as a generic audio plugin, so this shows what the product actually is:
// meeting controls sitting on keys.
function appIcon(): string {
	const S = 288;
	const pad = 30;
	const cell = (S - pad * 2 - 16) / 2;
	const art = [mute(true), camera(false), renderEmoji("hand", true), renderReaction("react-like", true)];

	let body = `<rect width="${S}" height="${S}" rx="64" fill="${ACCENT}"/>`;
	art.forEach((svg, i) => {
		const x = pad + (i % 2) * (cell + 16);
		const y = pad + Math.floor(i / 2) * (cell + 16);
		body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="${cell * 0.16}" fill="#1A1A1D"/>`;
		body += `<g transform="translate(${x},${y}) scale(${cell / 144})">${inner(svg)}</g>`;
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${body}</svg>`;
}

// --------------------------------------------------------------- thumbnail
function thumbnail(): string {
	let body = `<text x="${W / 2}" y="250" fill="${TEXT}" font-family="${FONT}" font-size="86"
		font-weight="600" text-anchor="middle">Teams Meeting Controls</text>`;
	body += `<text x="${W / 2}" y="320" fill="${MUTED}" font-family="${FONT}" font-size="36"
		text-anchor="middle">Meetings and PowerPoint Live, with live state on every key</text>`;

	body += row(
		[
			{ svg: mute(true) },
			{ svg: camera(false) },
			{ svg: renderEmoji("hand", true) },
			{ svg: renderReaction("react-like", true) },
			{ svg: renderLabelled("pptSlide", "12/40", "on") },
			{ svg: tool("ppt-laser", true) },
			{ svg: renderSimple("leave", true, "danger") }
		],
		440,
		190,
		36,
		W
	);

	body += `<text x="${W / 2}" y="810" fill="${MUTED}" font-family="${FONT}" font-size="30"
		text-anchor="middle">Works while Teams is in the background &#183; Never sends keystrokes</text>`;

	return canvas(W, H, body);
}

// ----------------------------------------------------------------- gallery
/** Keys mirror Teams, so the artwork changes with the meeting. */
function galleryState(): string {
	let body = `<text x="${W / 2}" y="170" fill="${TEXT}" font-family="${FONT}" font-size="60"
		font-weight="600" text-anchor="middle">Every key mirrors Teams</text>`;

	// Only the three controls that actually report a state belong here; blur
	// reports availability only, so pairing it would promise something the
	// plugin cannot show.
	body += row(
		[
			{ svg: mute(false), caption: "unmuted" },
			{ svg: camera(true), caption: "camera on" },
			{ svg: share(false), caption: "not sharing" }
		],
		290,
		170,
		80,
		W
	);

	body += row(
		[
			{ svg: mute(true), caption: "muted" },
			{ svg: camera(false), caption: "camera off" },
			{ svg: share(true), caption: "sharing" }
		],
		580,
		170,
		80,
		W
	);

	return canvas(W, H, body);
}

/** The meeting action set, so the listing shows the scope at a glance. */
function galleryActions(): string {
	let body = `<text x="${W / 2}" y="170" fill="${TEXT}" font-family="${FONT}" font-size="60"
		font-weight="600" text-anchor="middle">Meeting controls</text>`;

	body += row(
		[
			{ svg: mute(true), caption: "Mute" },
			{ svg: camera(false), caption: "Camera" },
			{ svg: renderEmoji("hand", true), caption: "Raise hand" },
			{ svg: blur(), caption: "Blur" },
			{ svg: share(false), caption: "Share" },
			{ svg: renderSimple("chat", true), caption: "Chat" },
			{ svg: renderSimple("people", true), caption: "People" }
		],
		290,
		150,
		40,
		W
	);

	const reactionCaptions = ["Like", "Love", "Applause", "Laugh", "Wow"];
	body += row(
		REACTION_KEYS.map((k, i) => ({ svg: renderReaction(k, true), caption: reactionCaptions[i] })).concat([
			{ svg: renderSimple("leave", true, "danger"), caption: "Leave" }
		]),
		580,
		150,
		40,
		W
	);

	return canvas(W, H, body);
}

/** Presenting a deck: the tools that only a presenter sees. */
function galleryPresenting(): string {
	let body = `<text x="${W / 2}" y="160" fill="${TEXT}" font-family="${FONT}" font-size="60"
		font-weight="600" text-anchor="middle">Presenting a deck</text>`;

	body += row(
		[
			{ svg: tool("ppt-cursor", true), caption: "Cursor" },
			{ svg: tool("ppt-laser", false), caption: "Laser" },
			{ svg: tool("ppt-pen", false), caption: "Pen" },
			{ svg: tool("ppt-highlighter", false), caption: "Highlighter" },
			{ svg: tool("ppt-eraser", false), caption: "Eraser" }
		],
		270,
		150,
		46,
		W
	);

	body += row(
		[
			{ svg: renderSimple("pptPrev", true), caption: "Previous" },
			{ svg: renderLabelled("pptSlide", "12/40", "on"), caption: "Slide" },
			{ svg: renderSimple("pptNext", true), caption: "Next" },
			{ svg: renderSimple("pptRefresh", true), caption: "Present latest" },
			{ svg: renderSimple("pptStopPresenting", true, "danger"), caption: "Stop sharing" }
		],
		560,
		150,
		46,
		W
	);

	body += `<text x="${W / 2}" y="810" fill="${MUTED}" font-family="${FONT}" font-size="34"
		text-anchor="middle">Ink keys show the colour picked in Teams</text>`;

	return canvas(W, H, body);
}

/** Watching someone else's deck, at your own pace. */
function galleryWatching(): string {
	let body = `<text x="${W / 2}" y="160" fill="${TEXT}" font-family="${FONT}" font-size="60"
		font-weight="600" text-anchor="middle">Watching a deck</text>`;

	body += row(
		[
			{ svg: renderSimple("pptPrev", true), caption: "Previous" },
			{ svg: renderSimple("pptNext", true), caption: "Next" },
			{ svg: renderLive(true), caption: "Back in sync" },
			{ svg: renderSimple("pptGrid", true), caption: "Grid view" }
		],
		270,
		150,
		56,
		W
	);

	body += row(
		[
			{ svg: renderSimple("pptTranslate", true), caption: "Translate" },
			{ svg: renderSimple("pptContrast", true), caption: "High contrast" },
			{ svg: renderSimple("pptCopilot", true), caption: "Ask Copilot" },
			{ svg: renderSimple("pptTakeControl", true), caption: "Take control" }
		],
		560,
		150,
		56,
		W
	);

	body += `<text x="${W / 2}" y="810" fill="${MUTED}" font-family="${FONT}" font-size="34"
		text-anchor="middle">Move at your own pace without changing anyone else's view</text>`;

	return canvas(W, H, body);
}

/**
 * The profiles, which are the reason the deck is never showing the wrong half
 * of the plugin. Kept to three labelled groups rather than prose, because the
 * guidelines ask for minimal text on a gallery item.
 */
function galleryProfiles(): string {
	let body = `<text x="${W / 2}" y="160" fill="${TEXT}" font-family="${FONT}" font-size="60"
		font-weight="600" text-anchor="middle">The deck follows the meeting</text>`;

	const groups: { label: string; keys: string[] }[] = [
		{ label: "In a meeting", keys: ["mute", "camera", "hand"] },
		{ label: "Watching a deck", keys: ["pptPrev", "pptNext", "pptSync"] },
		{ label: "Presenting", keys: ["pptPen", "pptSlide", "pptStopPresenting"] }
	];

	const size = 132;
	const gap = 18;
	const groupWidth = 3 * size + 2 * gap;
	const spread = (W - groups.length * groupWidth) / (groups.length + 1);

	groups.forEach((group, gi) => {
		const x0 = spread + gi * (groupWidth + spread);

		group.keys.forEach((k, ki) => {
			const x = x0 + ki * (size + gap);
			let svg: string;
			if (k === "mute") svg = mute(true);
			else if (k === "camera") svg = camera(false);
			else if (k === "hand") svg = renderEmoji("hand", true);
			else if (k === "pptPen") svg = tool("ppt-pen", true);
			else if (k === "pptSlide") svg = renderLabelled("pptSlide", "12/40", "on");
			else if (k === "pptSync") svg = renderLive(true);
			else svg = renderSimple(k, true, k === "pptStopPresenting" ? "danger" : "on");
			body += key(x, 400, size, svg);
		});

		body += `<text x="${x0 + groupWidth / 2}" y="610" fill="${TEXT}" font-family="${FONT}"
			font-size="32" text-anchor="middle">${group.label}</text>`;

		if (gi < groups.length - 1) {
			const ax = x0 + groupWidth + spread / 2;
			body += `<path d="M ${ax - 26} 466 L ${ax + 18} 466 M ${ax + 4} 452 L ${ax + 20} 466 L ${ax + 4} 480"
				stroke="${ACCENT}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
		}
	});

	body += `<text x="${W / 2}" y="810" fill="${MUTED}" font-family="${FONT}" font-size="34"
		text-anchor="middle">Switches itself, and switches back</text>`;

	return canvas(W, H, body);
}

/** Keys dim when there is no meeting, which is the other half of "live state". */
function galleryIdle(): string {
	let body = `<text x="${W / 2}" y="200" fill="${TEXT}" font-family="${FONT}" font-size="60"
		font-weight="600" text-anchor="middle">Dimmed when there is no meeting</text>`;

	body += row(
		[
			{ svg: mute(false, false) },
			{ svg: camera(true, false) },
			{ svg: renderEmoji("hand", false) },
			{ svg: renderReaction("react-like", false) },
			{ svg: blur(false) },
			{ svg: renderSimple("leave", false, "danger") }
		],
		380,
		170,
		46,
		W
	);

	body += `<text x="${W / 2}" y="720" fill="${MUTED}" font-family="${FONT}" font-size="34"
		text-anchor="middle">Nothing to press by mistake</text>`;

	return canvas(W, H, body);
}

mkdirSync(OUT, { recursive: true });
console.log("Generating Marketplace media...");

write("app-icon-288.png", appIcon(), 288);
write("thumbnail.png", thumbnail(), W);
write("gallery-1-live-state.png", galleryState(), W);
write("gallery-2-meeting-controls.png", galleryActions(), W);
write("gallery-3-presenting.png", galleryPresenting(), W);
write("gallery-4-watching.png", galleryWatching(), W);
write("gallery-5-profiles.png", galleryProfiles(), W);
write("gallery-6-no-meeting.png", galleryIdle(), W);

// Renamed as the set grew past the original three; without this the old files
// sit in the folder and a submission can pick up a gallery item that no longer
// matches anything the plugin does.
for (const stale of ["gallery-2-actions.png", "gallery-3-no-meeting.png"]) {
	const file = path.join(OUT, stale);
	if (existsSync(file)) {
		rmSync(file);
		console.log(`  removed stale ${stale}`);
	}
}

console.log("Done.");
