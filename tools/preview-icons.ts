/**
 * Renders every key state into one contact sheet so the artwork can be reviewed
 * without pushing it to hardware.
 *
 * Run with: node tools/preview-icons.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import {
	REACTION_KEYS,
	REACTION_LABEL,
	renderGlyph,
	renderReaction,
	renderSimple,
	renderToggle
} from "../src/icons.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Cell = { label: string; svg: string };

const mute = (active: boolean | undefined, available: boolean): string =>
	renderToggle({
		onKey: "micOff",
		offKey: "mic",
		onTone: "danger",
		offTone: "on",
		active,
		available
	});

const camera = (active: boolean | undefined, available: boolean): string =>
	renderToggle({
		onKey: "camera",
		offKey: "cameraOff",
		onTone: "on",
		offTone: "danger",
		active,
		available
	});

const share = (active: boolean | undefined, available: boolean): string =>
	renderToggle({
		onKey: "shareStop",
		offKey: "share",
		onTone: "accent",
		offTone: "on",
		active,
		available
	});

const rows: { title: string; cells: Cell[] }[] = [
	{
		title: "Mute",
		cells: [
			{ label: "unmuted", svg: mute(false, true) },
			{ label: "MUTED", svg: mute(true, true) },
			{ label: "no meeting", svg: mute(undefined, false) }
		]
	},
	{
		title: "Camera",
		cells: [
			{ label: "on", svg: camera(true, true) },
			{ label: "OFF", svg: camera(false, true) },
			{ label: "no meeting", svg: camera(undefined, false) }
		]
	},
	{
		title: "Hand",
		cells: [
			{ label: "lowered", svg: renderGlyph("hand", "on") },
			{ label: "RAISED", svg: renderGlyph("hand", "accent") },
			{ label: "no meeting", svg: renderGlyph("hand", "unavailable") }
		]
	},
	{
		title: "Blur",
		cells: [
			{ label: "off", svg: renderGlyph("blur", "on") },
			{ label: "ON", svg: renderGlyph("blur", "accent") },
			{ label: "no meeting", svg: renderGlyph("blur", "unavailable") }
		]
	},
	{
		title: "Share",
		cells: [
			{ label: "idle", svg: share(false, true) },
			{ label: "SHARING", svg: share(true, true) },
			{ label: "no meeting", svg: share(undefined, false) }
		]
	},
	{
		title: "Chat / People / Leave",
		cells: [
			{ label: "chat", svg: renderSimple("chat", true) },
			{ label: "people", svg: renderSimple("people", true) },
			{ label: "leave", svg: renderSimple("leave", true, "danger") }
		]
	},
	{
		title: "No meeting",
		cells: [
			{ label: "chat", svg: renderSimple("chat", false) },
			{ label: "people", svg: renderSimple("people", false) },
			{ label: "leave", svg: renderSimple("leave", false, "danger") }
		]
	},
	{
		title: "Reactions",
		cells: REACTION_KEYS.map((k) => ({
			label: REACTION_LABEL[k] ?? k,
			svg: renderReaction(k, true)
		}))
	},
	{
		title: "Reactions (no meeting)",
		cells: REACTION_KEYS.map((k) => ({
			label: REACTION_LABEL[k] ?? k,
			svg: renderReaction(k, false)
		}))
	}
];

const CELL = 144;
const PAD = 16;
const LABEL = 26;
const TITLE = 200;
const COLS = Math.max(...rows.map((r) => r.cells.length));

const width = TITLE + COLS * (CELL + PAD) + PAD;
const height = PAD + rows.length * (CELL + LABEL + PAD);

let body = `<rect width="${width}" height="${height}" fill="#1B1B1B"/>`;

rows.forEach((row, ri) => {
	const y = PAD + ri * (CELL + LABEL + PAD);
	body += `<text x="${PAD}" y="${y + CELL / 2}" fill="#E6E6E6" font-family="Segoe UI, sans-serif"
		font-size="19" dominant-baseline="central">${row.title}</text>`;

	row.cells.forEach((cell, ci) => {
		const x = TITLE + ci * (CELL + PAD);
		// Key-sized tile, matching how Stream Deck presents the image.
		body += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="16" fill="#000"/>`;
		const inner = cell.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
		body += `<g transform="translate(${x},${y})">${inner}</g>`;
		body += `<text x="${x + CELL / 2}" y="${y + CELL + 17}" fill="#8A8A8A"
			font-family="Segoe UI, sans-serif" font-size="15" text-anchor="middle">${cell.label}</text>`;
	});
});

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;

const outDir = path.join(ROOT, "dist", "preview");
mkdirSync(outDir, { recursive: true });

const out = path.join(outDir, "icon-states.png");
const png = new Resvg(sheet, {
	fitTo: { mode: "width", value: width },
	font: { loadSystemFonts: true }
}).render().asPng();
writeFileSync(out, png);

console.log(`Wrote ${path.relative(ROOT, out)} (${width}x${height})`);
