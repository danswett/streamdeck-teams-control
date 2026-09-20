import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderLabeled, renderTool } from "../src/icons.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node tools/preview-tools.ts <outputDir>");
mkdirSync(out, { recursive: true });

const cases: [string, string][] = [
	["cursor", renderTool("ppt-cursor", { available: true, active: false })],
	["cursor-active", renderTool("ppt-cursor", { available: true, active: true })],
	["laser-orange", renderTool("ppt-laser", { available: true, active: true, color: "Light orange" })],
	["laser-red", renderTool("ppt-laser", { available: true, active: false, color: "Red" })],
	["pen-lightblue", renderTool("ppt-pen", { available: true, active: false, color: "Light blue" })],
	["pen-green", renderTool("ppt-pen", { available: true, active: true, color: "Green" })],
	["highlighter-magenta", renderTool("ppt-highlighter", { available: true, active: false, color: "Magenta" })],
	["highlighter-yellow", renderTool("ppt-highlighter", { available: true, active: true, color: "Dark yellow" })],
	["eraser", renderTool("ppt-eraser", { available: true, active: false })],
	["eraser-active", renderTool("ppt-eraser", { available: true, active: true })],
	["pen-unavailable", renderTool("ppt-pen", { available: false, active: false })],
	["counter", renderLabeled("pptSlide", "16/17", "on")]
];

for (const [name, svg] of cases) {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: 144 } }).render().asPng();
	writeFileSync(path.join(out, `${name}.png`), png);
	console.log(`  ${name}.png`);
}

// One contact sheet so every key can be judged side by side.
const cols = 4;
const cell = 144;
const rows = Math.ceil(cases.length / cols);
const tiles = cases
	.map(([, svg], i) => {
		const x = (i % cols) * cell;
		const y = Math.floor(i / cols) * cell;
		const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
		return `<g transform="translate(${x} ${y})">${inner}</g>`;
	})
	.join("");

const sheet =
	`<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell}" ` +
	`viewBox="0 0 ${cols * cell} ${rows * cell}">` +
	`<rect width="100%" height="100%" fill="#1A1A1A"/>${tiles}</svg>`;

writeFileSync(
	path.join(out, "contact-sheet.png"),
	new Resvg(sheet, { fitTo: { mode: "width", value: cols * cell } }).render().asPng()
);
console.log("  contact-sheet.png");

