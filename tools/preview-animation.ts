/**
 * Renders the press animation as a filmstrip so the motion can be checked
 * without pushing it to hardware.
 *
 * Run with: node tools/preview-animation.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { renderReactionFrame } from "../src/icons.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const KEY = "react-like";
const FRAMES = 12;
const CELL = 110;
const PAD = 8;

const width = PAD + FRAMES * (CELL + PAD);
const height = PAD * 2 + CELL + 20;

let body = `<rect width="${width}" height="${height}" fill="#1B1B1B"/>`;

for (let i = 0; i < FRAMES; i++) {
	const t = i / (FRAMES - 1);
	const x = PAD + i * (CELL + PAD);
	const y = PAD;

	body += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="12" fill="#000"/>`;
	const svg = renderReactionFrame(KEY, t)
		.replace(/^<svg[^>]*>/, "")
		.replace(/<\/svg>$/, "");
	// Key art is authored on a 144 canvas; scale it into the filmstrip cell.
	body += `<g transform="translate(${x} ${y}) scale(${(CELL / 144).toFixed(4)})">${svg}</g>`;
	body += `<text x="${x + CELL / 2}" y="${y + CELL + 14}" fill="#888"
		font-family="Segoe UI, sans-serif" font-size="11" text-anchor="middle">${t.toFixed(2)}</text>`;
}

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;

const outDir = path.join(ROOT, "dist", "preview");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "reaction-animation.png");
writeFileSync(
	out,
	new Resvg(sheet, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: true } })
		.render()
		.asPng()
);
console.log(`Wrote ${path.relative(ROOT, out)} (${width}x${height})`);
