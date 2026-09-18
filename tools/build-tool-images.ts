/**
 * Pre-renders the PowerPoint Live drawing tools to PNG.
 *
 * Stream Deck draws SVG with its own renderer, and it does not handle
 * everything these illustrations use: the highlighter and eraser tips - the
 * parts that rely on gradient stop-opacity, a mask and a blur filter - came out
 * unfilled on the keys while rendering correctly everywhere else.
 *
 * resvg is a complete SVG renderer, so rasterising here means the keys show
 * exactly what Teams shows. It is also less work at runtime: a small PNG beats
 * a 10KB SVG the deck has to parse and rasterise on every repaint.
 *
 * Run with: node tools/build-tool-images.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { INK_COLORS, TOOL_DEFAULT_COLOR, UNAVAILABLE_COLOR } from "../src/icons.ts";
import { TOOL_ICONS, composeToolSvg } from "./tool-art.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Key canvas. Matches SIZE in src/icons.ts. */
const SIZE = 144;

function render(svg: string): string {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: SIZE } }).render().asPng();
	return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

/** Colours a tool can actually take. The eraser and cursor have only one. */
function colorsFor(control: string): string[] {
	if (control === "ppt-eraser" || control === "ppt-cursor") {
		return [TOOL_DEFAULT_COLOR[control] ?? "#FFFFFF"];
	}
	return [...new Set([...Object.values(INK_COLORS), TOOL_DEFAULT_COLOR[control] ?? "#FFFFFF"])];
}

const images: Record<string, string> = {};
let count = 0;

for (const [control, icon] of Object.entries(TOOL_ICONS)) {
	for (const ink of colorsFor(control)) {
		for (const active of [false, true]) {
			images[`${control}|${ink}|${active ? "on" : "off"}`] = render(composeToolSvg(icon, ink, active, SIZE));
			count++;
		}
	}
	// One greyed variant per tool; an unavailable tool has no ink colour.
	images[`${control}|unavailable`] = render(composeToolSvg(icon, UNAVAILABLE_COLOR, false, SIZE));
	count++;
	console.log(`  ${control.padEnd(18)} ${colorsFor(control).length} colour(s)`);
}

const out = {
	$comment: [
		"GENERATED FILE - do not edit. Run: node tools/build-tool-images.ts",
		"",
		"The PowerPoint Live drawing tools, rasterised from src/tool-icons.json.",
		"Stream Deck's own SVG renderer does not support everything the artwork",
		"uses - gradient stop-opacity, masks, blur filters - and rendered the",
		"highlighter and eraser tips unfilled, so the keys ship as images.",
		"",
		"Keyed '<control>|<ink hex>|<on|off>', plus '<control>|unavailable'."
	],
	size: SIZE,
	images
};

const target = path.join(ROOT, "src", "tool-images.generated.json");
const json = `${JSON.stringify(out)}\n`;
writeFileSync(target, json, "utf8");
console.log(`\nWrote ${count} images, ${(json.length / 1024 / 1024).toFixed(2)} MB`);
