/**
 * Renders every icon state into one contact sheet so the artwork can be
 * reviewed without pushing it to hardware.
 *
 * Run with: node tools/preview-icons.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import {
	REACTION_KEYS,
	renderGlyph,
	renderReaction,
	renderSimple,
	renderToggle
} from "../src/icons.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Cell = { label: string; svg: string };

const rows: { title: string; cells: Cell[] }[] = [
	{
		title: "Mute",
		cells: [
			{ label: "unmuted", svg: renderToggle("mic", true, false, true, true) },
			{ label: "MUTED", svg: renderToggle("mic", true, true, true, true) },
			{ label: "no meeting", svg: renderToggle("mic", false, undefined, true, true) }
		]
	},
	{
		title: "Camera",
		cells: [
			{ label: "on", svg: renderToggle("camera", true, true, false, true) },
			{ label: "OFF", svg: renderToggle("camera", true, false, false, true) },
			{ label: "no meeting", svg: renderToggle("camera", false, undefined, false, true) }
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
			{ label: "idle", svg: renderGlyph("share", "on") },
			{ label: "SHARING", svg: renderGlyph("share", "accent") },
			{ label: "no meeting", svg: renderGlyph("share", "unavailable") }
		]
	},
	{
		title: "Chat / People / Leave",
		cells: [
			{ label: "chat", svg: renderSimple("chat", true) },
			{ label: "people", svg: renderSimple("people", true) },
			{ label: "leave", svg: renderSimple("leave", true, true) }
		]
	},
	{
		title: "Dimmed",
		cells: [
			{ label: "chat", svg: renderSimple("chat", false) },
			{ label: "people", svg: renderSimple("people", false) },
			{ label: "leave", svg: renderSimple("leave", false, true) }
		]
	},
	{
		title: "Reactions",
		cells: REACTION_KEYS.map((k) => ({
			label: k.replace("react-", ""),
			svg: renderReaction(k, true)
		}))
	},
	{
		title: "Reactions (dimmed)",
		cells: REACTION_KEYS.map((k) => ({
			label: k.replace("react-", ""),
			svg: renderReaction(k, false)
		}))
	}
];

const CELL = 144;
const PAD = 16;
const LABEL = 26;
const TITLE = 150;
const COLS = Math.max(...rows.map((r) => r.cells.length));

const width = TITLE + COLS * (CELL + PAD) + PAD;
const height = PAD + rows.length * (CELL + LABEL + PAD);

let body = `<rect width="${width}" height="${height}" fill="#202020"/>`;

rows.forEach((row, ri) => {
	const y = PAD + ri * (CELL + LABEL + PAD);
	body += `<text x="${PAD}" y="${y + CELL / 2}" fill="#DDD" font-family="Segoe UI, sans-serif"
		font-size="20" dominant-baseline="central">${row.title}</text>`;

	row.cells.forEach((cell, ci) => {
		const x = TITLE + ci * (CELL + PAD);
		// Key-sized black tile, matching how Stream Deck presents the image.
		body += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="14" fill="#000"/>`;
		const inner = cell.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
		body += `<g transform="translate(${x},${y})">${inner}</g>`;
		body += `<text x="${x + CELL / 2}" y="${y + CELL + 17}" fill="#999"
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
