/**
 * Renders category-icon candidates for review.
 *
 * Run with: node tools/preview-category.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYS = path.join(ROOT, "node_modules", "@fluentui", "svg-icons", "icons");

const CANDIDATES = [
	"people_team_28_filled",
	"meet_now_28_filled",
	"video_person_28_filled",
	"video_chat_28_filled",
	"call_28_filled",
	"presenter_28_filled",
	"people_community_28_filled",
	"headset_28_filled",
	"emoji_28_filled"
];

const CELL = 96;
const PAD = 14;
const LABEL = 22;
const COLS = 3;

function inner(file: string): { viewBox: string; body: string } {
	const svg = readFileSync(path.join(SYS, `${file}.svg`), "utf8");
	const viewBox = /viewBox="([^"]+)"/.exec(svg)![1]!;
	const body = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
	return { viewBox, body };
}

const rows = Math.ceil(CANDIDATES.length / COLS);
const width = PAD + COLS * (CELL + PAD);
const height = PAD + rows * (CELL + LABEL + PAD);

let body = `<rect width="${width}" height="${height}" fill="#2B2B2B"/>`;

CANDIDATES.forEach((name, i) => {
	const col = i % COLS;
	const row = Math.floor(i / COLS);
	const x = PAD + col * (CELL + PAD);
	const y = PAD + row * (CELL + LABEL + PAD);

	const { viewBox, body: art } = inner(name);
	const [minX, minY, w, h] = viewBox.split(/\s+/).map(Number) as [number, number, number, number];
	const scale = (CELL * 0.62) / Math.max(w, h);
	const ox = x + (CELL - w * scale) / 2 - minX * scale;
	const oy = y + (CELL - h * scale) / 2 - minY * scale;

	body += `<circle cx="${x + CELL / 2}" cy="${y + CELL / 2}" r="${CELL / 2 - 4}" fill="#3A3A3A"/>`;
	body += `<g transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${scale.toFixed(4)})" fill="#FFFFFF">${art}</g>`;
	body += `<text x="${x + CELL / 2}" y="${y + CELL + 15}" fill="#AAA" font-family="Segoe UI, sans-serif"
		font-size="11" text-anchor="middle">${name.replace("_28_filled", "")}</text>`;
});

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;

const outDir = path.join(ROOT, "dist", "preview");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "category-candidates.png");
writeFileSync(out, new Resvg(sheet, { fitTo: { mode: "width", value: width * 2 }, font: { loadSystemFonts: true } }).render().asPng());
console.log(`Wrote ${path.relative(ROOT, out)}`);
