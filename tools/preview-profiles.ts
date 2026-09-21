/**
 * Draws every bundled profile as it will look once installed.
 *
 * One picture per deck, holding all three of its layouts, built from the
 * .streamDeckProfile files themselves rather than from the source that
 * generated them - a picture that agrees with the intent but not with the
 * shipped file would be worse than no picture at all.
 *
 * Only five decks can be checked against real hardware here, so these are also
 * how the other layouts get looked at: a key in the wrong place is obvious in
 * a picture and invisible in a diff of coordinates.
 *
 * Keys are drawn exactly as the deck draws them, which is the artwork and
 * nothing else - the profiles ship ShowTitle off, so a real key carries no
 * text. The captions under each key are an annotation for the page, not
 * something that appears on the deck.
 *
 * Run with: node tools/preview-profiles.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { Resvg } from "@resvg/resvg-js";

import { renderStripIdle } from "../src/icons.ts";
import { DECKS, type Deck } from "./decks.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin");
const OUT = path.join(ROOT, "docs", "profiles");

const KEY = 84;
const KEY_GAP = 10;
const CAPTION_H = 26;
const ROW_PITCH = KEY + CAPTION_H + KEY_GAP;
const COL_PITCH = KEY + KEY_GAP;
const PAD = 28;
const TITLE_H = 40;
const DIAL_H = 34;

const BG = "#0E0E12";
const EMPTY = "#17171C";
const KEY_BG = "#22222A";
const TEXT = "#E8E8ED";
const MUTED = "#7E7E88";

type Manifest = {
	Actions: { UUID: string; Name: string; States?: { Image?: string }[] }[];
	Profiles: { Name: string; DeviceType: number }[];
};

type Placed = { UUID: string; Name: string };
type Controller = { Type: string; Actions: Record<string, Placed> | null };

const manifest = JSON.parse(readFileSync(path.join(PLUGIN, "manifest.json"), "utf8")) as Manifest;
const actionByUuid = new Map(manifest.Actions.map((a) => [a.UUID, a]));

/** The page a profile keeps this plugin's keys on. */
function pageOf(file: string): Controller[] {
	const entry = new AdmZip(path.join(PLUGIN, `${file}.streamDeckProfile`))
		.getEntries()
		.find(
			(e) =>
				e.entryName.includes("/Profiles/") &&
				e.entryName.endsWith("manifest.json") &&
				e.getData().toString("utf8").includes("teamscontrol")
		);
	if (!entry) throw new Error(`${file}: no page holding any keys`);
	return (JSON.parse(entry.getData().toString("utf8")) as { Controllers: Controller[] }).Controllers;
}

/**
 * The artwork a key shows the moment the profile installs.
 *
 * That is state 0's image: the plugin only replaces it once Teams has told it
 * something, and a picture of what you get should show what is there first.
 */
const artCache = new Map<string, string>();
function keyArt(uuid: string): string | null {
	if (artCache.has(uuid)) return artCache.get(uuid)!;

	const declared = actionByUuid.get(uuid)?.States?.[0]?.Image;
	if (!declared) return null;

	// Stream Deck stores the path without a suffix and picks the file itself.
	for (const ext of [".svg", ".png"]) {
		const file = path.join(PLUGIN, `${declared}${ext}`);
		if (!existsSync(file)) continue;

		const data =
			ext === ".svg"
				? `data:image/svg+xml;base64,${readFileSync(file).toString("base64")}`
				: `data:image/png;base64,${readFileSync(file).toString("base64")}`;
		artCache.set(uuid, data);
		return data;
	}
	return null;
}

/** Rasterized here because resvg will not draw an SVG nested in an <image>. */
function rasterize(svg: string, width: number): string {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
	return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

/** What a dial shows before a meeting has told it anything. */
const DIAL_CAPTION: Record<string, [string, string]> = {
	"com.bad-duck.teamscontrol.ppt-slide-current": ["SLIDE", "Current slide"],
	"com.bad-duck.teamscontrol.ppt-slide-next": ["SLIDE", "Next slide"],
	"com.bad-duck.teamscontrol.ppt-ink-thickness-dial": ["INK", "Thickness"],
	"com.bad-duck.teamscontrol.ppt-ink-color-dial": ["INK", "Color"],
	"com.bad-duck.teamscontrol.timer-dial": ["TIMER", "Meeting timer"]
};

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The part of an action's name that is not the group it belongs to. */
const shortName = (name: string) => name.replace(/^PPT (Live|Presenter|Attendee): /, "");

function text(x: number, y: number, s: string, size: number, fill: string, weight = 400, anchor = "start") {
	return (
		`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Segoe UI, system-ui, sans-serif" ` +
		`font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`
	);
}

/** Two short lines, because a key is narrower than most of these names. */
function caption(cx: number, top: number, name: string): string {
	const words = shortName(name).split(" ");
	const lines: string[] = [];
	let line = "";
	for (const w of words) {
		const next = line ? `${line} ${w}` : w;
		// Roughly 5.2px per character at 9px, which is what fits inside a key.
		if (next.length * 5.2 > KEY + 6 && line) {
			lines.push(line);
			line = w;
		} else line = next;
	}
	if (line) lines.push(line);

	return lines
		.slice(0, 2)
		.map((l, i) => text(cx, top + 11 + i * 11, l, 9, MUTED, 400, "middle"))
		.join("");
}

function drawProfile(deck: Deck, file: string, heading: string, y0: number, width: number): string {
	const controllers = pageOf(file);
	const keys = controllers.find((c) => c.Type === "Keypad")?.Actions ?? {};
	const dials = controllers.find((c) => c.Type === "Encoder")?.Actions ?? {};

	let out = text(PAD, y0 + 22, heading, 17, TEXT, 600);
	const gridTop = y0 + TITLE_H;

	for (let r = 0; r < deck.rows; r++) {
		for (let c = 0; c < deck.columns; c++) {
			const x = PAD + c * COL_PITCH;
			const y = gridTop + r * ROW_PITCH;
			const placed = keys[`${c},${r}`];

			out +=
				`<rect x="${x}" y="${y}" width="${KEY}" height="${KEY}" rx="10" ` +
				`fill="${placed ? KEY_BG : EMPTY}" />`;
			if (!placed) continue;

			const art = keyArt(placed.UUID);
			if (art) {
				const inset = 12;
				out +=
					`<image x="${x + inset}" y="${y + inset}" width="${KEY - inset * 2}" ` +
					`height="${KEY - inset * 2}" href="${art}" />`;
			}
			out += caption(x + KEY / 2, y + KEY + 2, placed.Name);
		}
	}

	if (deck.encoders > 0) {
		const top = gridTop + deck.rows * ROW_PITCH + 6;
		const slotW = (width - PAD * 2) / deck.encoders;

		for (let d = 0; d < deck.encoders; d++) {
			const x = PAD + d * slotW;
			const placed = dials[`${d},0`];
			const [label, detail] = placed
				? (DIAL_CAPTION[placed.UUID] ?? ["DIAL", shortName(placed.Name)])
				: ["", ""];

			let dialY = top;

			if (deck.stripWidth > 0) {
				// A slot is 200x100 on every deck that has a strip, so it is
				// drawn at that ratio rather than stretched to fill the space.
				const h = Math.round(slotW / 2);
				if (placed) {
					out +=
						`<image x="${x + 2}" y="${top}" width="${slotW - 4}" height="${h}" ` +
						`href="${rasterize(renderStripIdle(label, detail), 400)}" />`;
				} else {
					out += `<rect x="${x + 2}" y="${top}" width="${slotW - 4}" height="${h}" rx="6" fill="${EMPTY}" />`;
				}
				dialY = top + h;
			} else if (placed) {
				// No strip behind these dials, so the caption is the only way
				// to say what the dial does - and drawing a strip here would
				// claim the deck has one.
				out +=
					text(x + slotW / 2, top + 16, label, 11, MUTED, 700, "middle") +
					text(x + slotW / 2, top + 34, detail, 13, TEXT, 400, "middle");
				dialY = top + 44;
			} else dialY = top + 44;

			out +=
				`<circle cx="${x + slotW / 2}" cy="${dialY + 18}" r="11" fill="${KEY_BG}" />` +
				text(x + slotW / 2, dialY + 22, String(d + 1), 10, MUTED, 600, "middle");
		}
	}

	return out;
}

function profileHeight(deck: Deck): number {
	const grid = TITLE_H + deck.rows * ROW_PITCH;
	if (deck.encoders === 0) return grid + 26;

	const slotW = (deckWidth(deck) - PAD * 2) / deck.encoders;
	const dialArea = deck.stripWidth > 0 ? Math.round(slotW / 2) : 44;
	return grid + 6 + dialArea + DIAL_H + 26;
}

function deckWidth(deck: Deck): number {
	// The floor is what the title line needs, not the grid: a Mini is three
	// keys wide and its heading is wider than that.
	return Math.max(PAD * 2 + deck.columns * COL_PITCH - KEY_GAP, 380);
}

mkdirSync(OUT, { recursive: true });

const BASES = ["Teams Meeting", "PowerPoint Live (Attendee)", "PowerPoint Live (Presenter)"];
const HEADINGS = ["In a meeting", "Watching a deck", "Presenting a deck"];

for (const deck of DECKS) {
	const files = BASES.map((base) => {
		const wanted = `profiles/${base}${deck.suffix}`;
		const declared = manifest.Profiles.find(
			(p) => p.DeviceType === deck.deviceType && (p.Name === wanted || p.Name.startsWith(`${wanted} r`))
		);
		if (!declared) throw new Error(`${deck.label}: no profile declared for "${base}"`);
		return declared.Name;
	});

	const width = deckWidth(deck);
	const each = profileHeight(deck);
	const height = PAD + 46 + each * 3 + PAD;

	let body =
		`<rect width="${width}" height="${height}" fill="${BG}" />` +
		text(PAD, PAD + 24, deck.label, 24, TEXT, 700) +
		text(
			width - PAD,
			PAD + 24,
			`${deck.columns} x ${deck.rows}${deck.encoders ? ` and ${deck.encoders} dials` : ""}`,
			14,
			MUTED,
			400,
			"end"
		);

	files.forEach((file, i) => {
		body += drawProfile(deck, file, HEADINGS[i], PAD + 46 + each * i, width);
	});

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
		`viewBox="0 0 ${width} ${height}">${body}</svg>`;

	const name = `${deck.slug}.png`;
	const png = new Resvg(svg, { fitTo: { mode: "width", value: width * 2 } }).render().asPng();
	writeFileSync(path.join(OUT, name), png);
	console.log(`docs/profiles/${name}  (${width}x${height})`);
}
