/*
 * Builds the Stream Deck overlay for the recorded demo.
 *
 * Reads the state the sidecar actually emitted while the screen was being
 * recorded, and draws the deck from it. Nothing is animated to match the
 * footage: if a key changes in the overlay, the plugin reported that change.
 *
 * Two things the recording cannot give us, and how they are handled:
 *
 * - Presses are not in the state stream, because the deck sends them and the
 *   sidecar only reports what Teams looks like afterwards. A key that changes
 *   is flashed instead, which is the thing a viewer is looking for anyway.
 *
 * - A snapshot of a live presentation costs about two seconds, and the meeting
 *   poll is floored at three, so a change can be noticed several seconds after
 *   it happens. Placing each transition at the midpoint between the poll that
 *   missed it and the poll that caught it halves that error, rather than
 *   letting the overlay always run late.
 *
 * Run with:
 *   node tools/build-demo-overlay.ts <captureDir> [outDir] [--end 104]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Resvg } from "@resvg/resvg-js";

import {
	renderEmoji,
	renderGlyph,
	renderLabelled,
	renderReaction,
	renderSimple,
	renderToggle,
	renderTool
} from "../src/icons.ts";

const args = process.argv.slice(2);
const endFlag = args.indexOf("--end");
const END = endFlag > -1 ? Number(args[endFlag + 1]) : Infinity;
// The value after --end is not a positional; without this it is taken as the
// output directory and the frames land in a folder called "104".
const positional = args.filter((a, i) => !a.startsWith("--") && i !== endFlag + 1);

const CAPTURE = path.resolve(positional[0] ?? "");
const OUT = path.resolve(positional[1] ?? path.join(CAPTURE, "overlay"));
if (!existsSync(CAPTURE)) {
	console.error("usage: node tools/build-demo-overlay.ts <captureDir> [outDir] [--end seconds]");
	process.exit(1);
}

const FPS = 30;
/** Windows PowerShell writes UTF-8 with a BOM, which JSON.parse rejects. */
const readText = (p: string) => readFileSync(p, "utf8").replace(/^\uFEFF/, "");
const meta = JSON.parse(readText(path.join(CAPTURE, "meta.json"))) as { startUtc: string; seconds: number };
const t0 = Date.parse(meta.startUtc);

type Snap = {
	at: number;
	inMeeting: boolean;
	states: Record<string, boolean>;
	context: Record<string, string>;
};

const raw: Snap[] = [];
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
	raw.push({
		at: (Date.parse(line.slice(0, tab)) - t0) / 1000,
		inMeeting: !!j.inMeeting,
		states: j.states ?? {},
		context: j.context ?? {}
	});
}
raw.sort((a, b) => a.at - b.at);

const KEY = 96;
const GAP = 12;
const PAD = 22;
const COLS = 5;
const ROWS = 3;
const W = PAD * 2 + COLS * KEY + (COLS - 1) * GAP;
const H = PAD * 2 + ROWS * KEY + (ROWS - 1) * GAP + 34;

const inner = (svg: string) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const toolArt = (control: string, active: boolean, colour?: string): string => {
	const art = renderTool(control, { available: true, active, color: colour });
	if (!art.startsWith("data:")) return art;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><image href="${art}" x="0" y="0" width="144" height="144"/></svg>`;
};

type Cell = { id: string; svg: string } | null;

/**
 * The layout follows the meeting, exactly as the bundled profiles do: meeting
 * controls until a deck goes up, then the attendee or presenter set, then back
 * again when the presentation ends.
 */
function cells(s: Snap): Cell[] {
	const on = (k: string) => !!s.states[k];
	const col = (k: string) => s.context[`ppt.color.${k}`];
	const live = s.inMeeting;

	const mic: Cell = {
		id: "mute",
		svg: renderToggle({ onKey: "micOff", offKey: "mic", onTone: "on", offTone: "on", active: on("mute"), available: live })
	};
	const cam: Cell = {
		id: "camera",
		svg: renderToggle({ onKey: "camera", offKey: "cameraOff", onTone: "on", offTone: "on", active: on("camera"), available: live })
	};
	const leave: Cell = { id: "leave", svg: renderSimple("leave", live, "danger") };

	if (!on("ppt-live")) {
		return [
			mic,
			cam,
			{ id: "blur", svg: renderGlyph("blur", live ? "on" : "unavailable") },
			{
				id: "share",
				svg: renderToggle({ onKey: "shareStop", offKey: "share", onTone: "accent", offTone: "on", active: on("share"), available: live })
			},
			leave,
			{ id: "hand", svg: renderEmoji("hand", live) },
			{ id: "chat", svg: renderSimple("chat", live) },
			{ id: "people", svg: renderSimple("people", live) },
			null,
			null,
			...["react-like", "react-love", "react-applause", "react-laugh", "react-wow"].map((r) => ({
				id: r,
				svg: renderReaction(r, live)
			}))
		];
	}

	const slide = s.context["ppt.slide"] ?? "";
	const total = s.context["ppt.slides"] ?? "";
	const nav: Cell[] = [
		{ id: "ppt-prev", svg: renderSimple("pptPrev", true) },
		{ id: "ppt-next", svg: renderSimple("pptNext", true) },
		{
			id: "ppt-status",
			// Same rule the key itself uses: the total only exists while Teams is
			// showing its toolbar counter, so the number stands alone without it.
			svg: renderLabelled("pptSlide", slide && total ? `${slide}/${total}` : slide, "on")
		},
		{ id: "ppt-grid", svg: renderGlyph(on("ppt-grid") ? "pptGridOn" : "pptGrid", on("ppt-grid") ? "accent" : "on") }
	];

	if (s.context["ppt.role"] === "attendee") {
		return [
			...nav,
			{ id: "ppt-contrast", svg: renderSimple("pptContrast", true) },
			{ id: "ppt-sync", svg: renderSimple("pptSync", true) },
			{ id: "ppt-popout", svg: renderSimple("pptPopout", true) },
			{ id: "ppt-take-control", svg: renderSimple("pptTakeControl", true) },
			null,
			null,
			mic,
			cam,
			{ id: "hand", svg: renderEmoji("hand", live) },
			{ id: "chat", svg: renderSimple("chat", live) },
			leave
		];
	}

	return [
		...nav,
		{ id: "ppt-refresh", svg: renderSimple("pptRefresh", true) },
		{ id: "ppt-cursor", svg: toolArt("ppt-cursor", on("ppt-cursor"), col("ppt-cursor")) },
		{ id: "ppt-laser", svg: toolArt("ppt-laser", on("ppt-laser"), col("ppt-laser")) },
		{ id: "ppt-pen", svg: toolArt("ppt-pen", on("ppt-pen"), col("ppt-pen")) },
		{ id: "ppt-highlighter", svg: toolArt("ppt-highlighter", on("ppt-highlighter"), col("ppt-highlighter")) },
		{ id: "ppt-eraser", svg: toolArt("ppt-eraser", on("ppt-eraser"), col("ppt-eraser")) },
		mic,
		cam,
		{ id: "ppt-presenter-view", svg: renderGlyph("pptHidePresenterView", "on") },
		{ id: "ppt-private-view", svg: renderGlyph("pptPrivateView", "on") },
		{ id: "ppt-stop", svg: renderSimple("pptStopPresenting", true, "danger") }
	];
}

/** Everything the overlay draws, so two snapshots can be compared. */
const shape = (s: Snap) => JSON.stringify(cells(s).map((c) => (c ? [c.id, c.svg] : null)));

// Collapse repeats, then move each change back to the midpoint of the window
// it could have happened in.
const snaps: Snap[] = [];
for (const s of raw) {
	const last = snaps.at(-1);
	if (last && shape(last) === shape(s)) continue;
	if (last) {
		const missed = raw.filter((r) => r.at < s.at).at(-1)?.at ?? last.at;
		s.at = Math.max(last.at, (missed + s.at) / 2);
	}
	snaps.push(s);
}
console.log(`${raw.length} snapshots -> ${snaps.length} distinct states`);

/** Which keys changed between two states, so they can be flashed. */
function changed(a: Snap | undefined, b: Snap): Set<string> {
	const out = new Set<string>();
	if (!a) return out;
	const ca = cells(a);
	const cb = cells(b);
	// A layout swap is not a press; flashing the whole deck would be noise.
	if (ca.length !== cb.length || ca.some((c, i) => c?.id !== cb[i]?.id)) return out;
	cb.forEach((c, i) => {
		if (c && ca[i] && ca[i]!.svg !== c.svg) out.add(c.id);
	});
	return out;
}

const FLASH = 0.45;

function panel(s: Snap, flash: Set<string>): string {
	let body = `<rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="#0E0E10" fill-opacity="0.92"/>`;
	body += `<text x="${W / 2}" y="26" fill="#9A9AA2" font-family="Segoe UI, sans-serif" font-size="17" font-weight="600" text-anchor="middle" letter-spacing="1.2">STREAM DECK</text>`;

	cells(s).forEach((c, i) => {
		const x = PAD + (i % COLS) * (KEY + GAP);
		const y = 34 + PAD + Math.floor(i / COLS) * (KEY + GAP);
		body += `<rect x="${x}" y="${y}" width="${KEY}" height="${KEY}" rx="${KEY * 0.13}" fill="#000000"/>`;
		if (c) body += `<g transform="translate(${x},${y}) scale(${KEY / 144})">${inner(c.svg)}</g>`;
		if (c && flash.has(c.id)) {
			body += `<rect x="${x}" y="${y}" width="${KEY}" height="${KEY}" rx="${KEY * 0.13}" fill="#FFFFFF" fill-opacity="0.18"/>`;
			body += `<rect x="${x - 3}" y="${y - 3}" width="${KEY + 6}" height="${KEY + 6}" rx="${KEY * 0.15}" fill="none" stroke="#FFFFFF" stroke-width="5"/>`;
		}
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

// ------------------------------------------------------------------- frames
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const seconds = Math.min(meta.seconds, END);
const total = Math.round(seconds * FPS);
const cache = new Map<string, Buffer>();
let idx = 0;
let rendered = 0;

for (let f = 0; f < total; f++) {
	const t = f / FPS;
	while (idx + 1 < snaps.length && snaps[idx + 1].at <= t) idx++;
	const s = snaps[idx] ?? { at: 0, inMeeting: false, states: {}, context: {} };
	const lit = t - s.at < FLASH ? changed(snaps[idx - 1], s) : new Set<string>();

	const key = shape(s) + "|" + [...lit].sort().join(",");
	let png = cache.get(key);
	if (!png) {
		png = new Resvg(panel(s, lit), { font: { loadSystemFonts: true } }).render().asPng();
		cache.set(key, png);
		rendered++;
	}
	writeFileSync(path.join(OUT, `o${String(f).padStart(5, "0")}.png`), png);
}

console.log(`  ${rendered} unique panels -> ${total} frames (${seconds.toFixed(1)}s)`);
console.log(`  panel ${W}x${H}`);
console.log(`  ${OUT}`);
