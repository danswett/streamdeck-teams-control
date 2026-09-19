/**
 * Contact sheet for the touch-strip artwork.
 *
 * The strip is the one surface that cannot be checked by looking at the plugin
 * without a deck being presented, so this renders the slots at their real
 * 200x100 and stacks them the way the strip does.
 *
 * Run with: node tools/preview-dials.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { INK_COLORS, renderInkColor, renderInkThickness, renderStripIdle } from "../src/icons.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "preview");

/** One dial slot, at the size the touch strip actually gives it. */
const W = 200;
const H = 100;

const rows: { label: string; svg: string }[] = [
	{ label: "thickness 1, green", svg: renderInkThickness(INK_COLORS["green"], 1) },
	{ label: "thickness 4, green", svg: renderInkThickness(INK_COLORS["green"], 4) },
	{ label: "thickness 6, red", svg: renderInkThickness(INK_COLORS["red"], 6) },
	{ label: "color red", svg: renderInkColor(INK_COLORS["red"], "Red") },
	{ label: "color light green", svg: renderInkColor(INK_COLORS["light green"], "Light green") },
	{ label: "color yellow", svg: renderInkColor(INK_COLORS["yellow"], "Yellow") },
	{ label: "idle", svg: renderStripIdle("Ink color", "no pen selected") }
];

const GAP = 12;
const LABEL = 22;
const sheetW = W + GAP * 2;
const sheetH = (H + LABEL + GAP) * rows.length + GAP;

// The strip is dark, so the sheet is too; on white these would look wrong.
let body = `<rect width="${sheetW}" height="${sheetH}" fill="#1A1A1F"/>`;
rows.forEach((row, i) => {
	const y = GAP + i * (H + LABEL + GAP);
	body +=
		`<text x="${GAP}" y="${y + 15}" font-family="Segoe UI, system-ui, sans-serif" font-size="13" ` +
		`fill="#9A9AA2">${row.label}</text>` +
		`<g transform="translate(${GAP} ${y + LABEL})">` +
		`<rect width="${W}" height="${H}" fill="#000000"/>` +
		row.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "") +
		`</g>`;
});

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}" viewBox="0 0 ${sheetW} ${sheetH}">${body}</svg>`;

mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, "dial-strips.png");
writeFileSync(file, new Resvg(sheet, { fitTo: { mode: "width", value: sheetW * 2 } }).render().asPng());
console.log(`${path.relative(ROOT, file)}  (${rows.length} slots at ${W}x${H})`);
