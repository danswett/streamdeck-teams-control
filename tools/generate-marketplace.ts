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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import {
	REACTION_KEYS,
	renderEmoji,
	renderGlyph,
	renderReaction,
	renderSimple,
	renderToggle
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

const mute = (active: boolean, available = true): string =>
	renderToggle({ onKey: "micOff", offKey: "mic", onTone: "danger", offTone: "on", active, available });

const camera = (active: boolean, available = true): string =>
	renderToggle({ onKey: "camera", offKey: "cameraOff", onTone: "on", offTone: "danger", active, available });

const share = (active: boolean, available = true): string =>
	renderToggle({ onKey: "shareStop", offKey: "share", onTone: "accent", offTone: "on", active, available });

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
		text-anchor="middle">Live state on every key</text>`;

	body += row(
		[
			{ svg: mute(true) },
			{ svg: camera(false) },
			{ svg: renderEmoji("hand", true) },
			{ svg: renderReaction("react-like", true) },
			{ svg: renderGlyph("blur", "accent") },
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

	body += row(
		[
			{ svg: mute(false), caption: "unmuted" },
			{ svg: camera(true), caption: "camera on" },
			{ svg: share(false), caption: "not sharing" },
			{ svg: renderGlyph("blur", "on"), caption: "blur off" }
		],
		290,
		170,
		60,
		W
	);

	body += row(
		[
			{ svg: mute(true), caption: "muted" },
			{ svg: camera(false), caption: "camera off" },
			{ svg: share(true), caption: "sharing" },
			{ svg: renderGlyph("blur", "accent"), caption: "blur on" }
		],
		580,
		170,
		60,
		W
	);

	return canvas(W, H, body);
}

/** The full action set, so the listing shows the scope at a glance. */
function galleryActions(): string {
	let body = `<text x="${W / 2}" y="170" fill="${TEXT}" font-family="${FONT}" font-size="60"
		font-weight="600" text-anchor="middle">Thirteen actions</text>`;

	body += row(
		[
			{ svg: mute(true), caption: "Mute" },
			{ svg: camera(false), caption: "Camera" },
			{ svg: renderEmoji("hand", true), caption: "Raise hand" },
			{ svg: renderGlyph("blur", "accent"), caption: "Blur" },
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
			{ svg: renderGlyph("blur", "unavailable") },
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
write("gallery-2-actions.png", galleryActions(), W);
write("gallery-3-no-meeting.png", galleryIdle(), W);

console.log("Done.");
