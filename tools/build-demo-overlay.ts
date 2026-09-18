/*
 * Builds the Stream Deck overlay for the recorded demo.
 *
 * Reads the state the sidecar actually emitted while the screen was being
 * recorded, and draws the deck from it. Nothing here is animated to match the
 * footage: if the key in the overlay changes, it is because the plugin
 * reported that change at that moment.
 *
 * Run with:
 *   node tools/build-demo-overlay.ts <captureDir> [outDir]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Resvg } from "@resvg/resvg-js";

import {
	renderGlyph,
	renderLabelled,
	renderSimple,
	renderToggle,
	renderTool
} from "../src/icons.ts";

const CAPTURE = path.resolve(process.argv[2] ?? "");
const OUT = path.resolve(process.argv[3] ?? path.join(CAPTURE, "overlay"));
if (!existsSync(CAPTURE)) {
	console.error("usage: node tools/build-demo-overlay.ts <captureDir> [outDir]");
	process.exit(1);
}

const FPS = 30;
// Windows PowerShell writes UTF-8 with a BOM, which JSON.parse rejects
// outright. Both capture files come from there.
const readText = (p: string) => readFileSync(p, "utf8").replace(/^\uFEFF/, "");
const meta = JSON.parse(readText(path.join(CAPTURE, "meta.json"))) as {
	startUtc: string;
	seconds: number;
};
const t0 = Date.parse(meta.startUtc);

type Snap = {
	at: number;
	inMeeting: boolean;
	states: Record<string, boolean>;
	context: Record<string, string>;
};

const snaps: Snap[] = [];
for (const line of readText(path.join(CAPTURE, "states.jsonl")).split(/\r?\n/)) {
	const tab = line.indexOf("\t");
	if (tab < 0) continue;
	let j: any;
	try {
		j = JSON.parse(line.slice(tab + 1));
	} catch {
		continue;
	}
	if (j.type !== "state") continue;
	snaps.push({
		at: (Date.parse(line.slice(0, tab)) - t0) / 1000,
		inMeeting: !!j.inMeeting,
		states: j.states ?? {},
		context: j.context ?? {}
	});
}
snaps.sort((a, b) => a.at - b.at);
console.log(`${snaps.length} state snapshots, ${snaps[0]?.at.toFixed(1)}s to ${snaps.at(-1)?.at.toFixed(1)}s`);

// ------------------------------------------------------------------ drawing
const inner = (svg: string) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const toolArt = (control: string, active: boolean, colour?: string): string => {
	const art = renderTool(control, { available: true, active, color: colour });
	if (!art.startsWith("data:")) return art;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><image href="${art}" x="0" y="0" width="144" height="144"/></svg>`;
};

const KEY = 96;
const GAP = 12;
const PAD = 22;
const COLS = 5;
const ROWS = 3;
const W = PAD * 2 + COLS * KEY + (COLS - 1) * GAP;
const H = PAD * 2 + ROWS * KEY + (ROWS - 1) * GAP + 34;

/** The presenter layout, which is what is on the deck during the recording. */
function keysFor(s: Snap): string[] {
	const on = (k: string) => !!s.states[k];
	const colour = (k: string) => s.context[`ppt.color.${k}`];
	const live = s.inMeeting;

	return [
		renderSimple("pptPrev", live),
		renderSimple("pptNext", live),
		renderLabelled("pptSlide", s.context["ppt.slide"] ?? "", live ? "on" : "unavailable"),
		renderGlyph(on("ppt-grid") ? "pptGridOn" : "pptGrid", live ? (on("ppt-grid") ? "accent" : "on") : "unavailable"),
		renderSimple("pptRefresh", live),

		toolArt("ppt-cursor", on("ppt-cursor"), colour("ppt-cursor")),
		toolArt("ppt-laser", on("ppt-laser"), colour("ppt-laser")),
		toolArt("ppt-pen", on("ppt-pen"), colour("ppt-pen")),
		toolArt("ppt-highlighter", on("ppt-highlighter"), colour("ppt-highlighter")),
		toolArt("ppt-eraser", on("ppt-eraser"), colour("ppt-eraser")),

		renderToggle({ onKey: "micOff", offKey: "mic", onTone: "on", offTone: "on", active: on("mute"), available: live }),
		renderToggle({ onKey: "camera", offKey: "cameraOff", onTone: "on", offTone: "on", active: on("camera"), available: live }),
		renderGlyph("pptHidePresenterView", live ? "on" : "unavailable"),
		renderGlyph("pptPrivateView", live ? "on" : "unavailable"),
		renderSimple("pptStopPresenting", live, "danger")
	];
}

function panel(s: Snap): string {
	let body = `<rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="#0E0E10" fill-opacity="0.92"/>`;
	body += `<text x="${W / 2}" y="26" fill="#9A9AA2" font-family="Segoe UI, sans-serif" font-size="17" font-weight="600" text-anchor="middle" letter-spacing="1.2">STREAM DECK</text>`;

	keysFor(s).forEach((svg, i) => {
		const x = PAD + (i % COLS) * (KEY + GAP);
		const y = 34 + PAD + Math.floor(i / COLS) * (KEY + GAP);
		body += `<rect x="${x}" y="${y}" width="${KEY}" height="${KEY}" rx="${KEY * 0.13}" fill="#000000"/>`;
		body += `<g transform="translate(${x},${y}) scale(${KEY / 144})">${inner(svg)}</g>`;
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

// ------------------------------------------------------------------- frames
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const total = Math.round(meta.seconds * FPS);
const cache = new Map<string, Buffer>();
let idx = 0;
let rendered = 0;

for (let f = 0; f < total; f++) {
	const t = f / FPS;
	// The state in force at this instant is the last one reported before it.
	while (idx + 1 < snaps.length && snaps[idx + 1].at <= t) idx++;
	const s = snaps[idx] ?? { at: 0, inMeeting: false, states: {}, context: {} };

	const key = JSON.stringify([s.inMeeting, s.states, s.context]);
	let png = cache.get(key);
	if (!png) {
		png = new Resvg(panel(s), { font: { loadSystemFonts: true } }).render().asPng();
		cache.set(key, png);
		rendered++;
	}
	writeFileSync(path.join(OUT, `o${String(f).padStart(5, "0")}.png`), png);
}

console.log(`  ${rendered} unique panels -> ${total} frames (${(total / FPS).toFixed(1)}s)`);
console.log(`  panel ${W}x${H}`);
console.log(`  ${OUT}`);
