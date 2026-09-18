/**
 * Renders a contact sheet of chosen control glyphs as one PNG, so a change to
 * the artwork can be eyeballed without installing the plugin.
 *
 * Run with: node tools/preview-glyphs.ts [glyphName ...]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { renderGlyph } from "../src/icons.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const keys = process.argv.slice(2);
if (keys.length === 0) {
	console.error("usage: node tools/preview-glyphs.ts <glyphName> [...]");
	process.exit(1);
}

const CELL = 144;
const PAD = 12;
const LABEL = 22;

const cells = keys
	.map((key, i) => {
		const inner = renderGlyph(key, "on").replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
		const x = PAD + i * (CELL + PAD);
		return `
      <g transform="translate(${x} ${PAD})">
        <rect width="${CELL}" height="${CELL}" rx="14" fill="#1b1b1b"/>
        <g transform="translate(${CELL / 2} ${CELL / 2}) scale(${CELL / 144}) translate(-72 -72)">${inner}</g>
      </g>
      <text x="${x + CELL / 2}" y="${PAD + CELL + LABEL - 6}" fill="#cfcfcf"
            font-family="Segoe UI, sans-serif" font-size="13" text-anchor="middle">${key}</text>`;
	})
	.join("");

const width = PAD + keys.length * (CELL + PAD);
const height = PAD + CELL + LABEL;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#0f0f0f"/>${cells}</svg>`;

const png = new Resvg(sheet, { fitTo: { mode: "width", value: width * 2 } }).render().asPng();
const out = path.join(ROOT, "glyph-preview.png");
writeFileSync(out, png);
console.log(`Wrote ${path.relative(ROOT, out)} (${keys.join(", ")})`);
