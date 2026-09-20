/*
 * Renders the frames for a Marketplace demo video.
 *
 * Every key is drawn by the same functions the plugin uses, so the video
 * cannot show artwork the product does not ship - the same reason the gallery
 * images are generated rather than screenshotted. Nothing here reproduces the
 * Teams interface: that is Microsoft's, and a still of it would go stale on
 * their release schedule rather than ours.
 *
 * Frames that do not change are rendered once and reused, so a 90-second video
 * costs a few dozen renders rather than a few thousand.
 *
 * Run with: node tools/build-demo-frames.ts [outDir]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import {
	renderEmoji,
	renderGlyph,
	renderLabeled,
	renderLive,
	renderReaction,
	renderSimple,
	renderToggle,
	renderTool
} from "../src/icons.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, "dist", "demo-frames"));

const W = 1920;
const H = 1080;
const FPS = 30;

const BG = "#141416";
const TEXT = "#F2F2F2";
const MUTED = "#9A9AA2";
const ACCENT = "#5059C9";
const FONT = "Segoe UI, Segoe UI Variable, sans-serif";

const inner = (svg: string): string => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");

/** Drawing tools come back as a PNG data URI rather than an SVG document. */
const tool = (control: string, active: boolean, available = true): string => {
	const art = renderTool(control, { available, active });
	if (!art.startsWith("data:")) return art;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><image href="${art}" x="0" y="0" width="144" height="144"/></svg>`;
};

const mute = (active: boolean, available = true): string =>
	renderToggle({ onKey: "micOff", offKey: "mic", onTone: "on", offTone: "on", active, available });
const camera = (active: boolean, available = true): string =>
	renderToggle({ onKey: "camera", offKey: "cameraOff", onTone: "on", offTone: "on", active, available });
const share = (active: boolean, available = true): string =>
	renderToggle({ onKey: "shareStop", offKey: "share", onTone: "accent", offTone: "on", active, available });

type Key = { svg: string; label?: string };

/** A 5x3 deck, centered, with an optional caption above and note below. */
function deck(keys: (Key | null)[], opts: { title?: string; note?: string; pressed?: number; profile?: string }): string {
	const size = 168;
	const gap = 22;
	const cols = 5;
	const rows = 3;
	const gridW = cols * size + (cols - 1) * gap;
	const gridH = rows * size + (rows - 1) * gap;
	const x0 = (W - gridW) / 2;
	const y0 = 300;

	let body = `<rect width="${W}" height="${H}" fill="${BG}"/>`;

	if (opts.title)
		body += `<text x="${W / 2}" y="150" fill="${TEXT}" font-family="${FONT}" font-size="66" font-weight="600" text-anchor="middle">${opts.title}</text>`;
	if (opts.profile)
		body += `<text x="${W / 2}" y="218" fill="${ACCENT}" font-family="${FONT}" font-size="34" font-weight="600" text-anchor="middle">${opts.profile}</text>`;

	// The deck body, so the keys read as a device rather than floating tiles.
	body += `<rect x="${x0 - 34}" y="${y0 - 34}" width="${gridW + 68}" height="${gridH + 68}" rx="28" fill="#1C1C20"/>`;

	keys.forEach((k, i) => {
		const cx = x0 + (i % cols) * (size + gap);
		const cy = y0 + Math.floor(i / cols) * (size + gap);
		body += `<rect x="${cx}" y="${cy}" width="${size}" height="${size}" rx="${size * 0.13}" fill="#000000"/>`;
		if (k) body += `<g transform="translate(${cx},${cy}) scale(${size / 144})">${inner(k.svg)}</g>`;
		if (opts.pressed === i)
			body += `<rect x="${cx - 4}" y="${cy - 4}" width="${size + 8}" height="${size + 8}" rx="${size * 0.15}" fill="none" stroke="${ACCENT}" stroke-width="6"/>`;
	});

	if (opts.note)
		body += `<text x="${W / 2}" y="${y0 + gridH + 120}" fill="${MUTED}" font-family="${FONT}" font-size="38" text-anchor="middle">${opts.note}</text>`;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

function card(title: string, sub: string): string {
	let body = `<rect width="${W}" height="${H}" fill="${BG}"/>`;
	body += `<text x="${W / 2}" y="${H / 2 - 20}" fill="${TEXT}" font-family="${FONT}" font-size="86" font-weight="600" text-anchor="middle">${title}</text>`;
	body += `<text x="${W / 2}" y="${H / 2 + 60}" fill="${MUTED}" font-family="${FONT}" font-size="40" text-anchor="middle">${sub}</text>`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

// ------------------------------------------------------------- deck layouts
const reactions = ["react-like", "react-love", "react-applause", "react-laugh", "react-wow"];

function meetingDeck(o: { live: boolean; muted?: boolean; cam?: boolean; sharing?: boolean }): (Key | null)[] {
	const a = o.live;
	return [
		{ svg: mute(o.muted ?? false, a) },
		{ svg: camera(o.cam ?? false, a) },
		{ svg: renderGlyph("blur", a ? "on" : "unavailable") },
		{ svg: share(o.sharing ?? false, a) },
		{ svg: renderSimple("leave", a, "danger") },
		{ svg: renderEmoji("hand", a) },
		...reactions.slice(0, 4).map((r) => ({ svg: renderReaction(r, a) })),
		{ svg: renderReaction(reactions[4], a) },
		{ svg: renderSimple("chat", a) },
		{ svg: renderSimple("people", a) },
		null,
		null
	];
}

function attendeeDeck(o: { slide: string; behind: boolean; pressed?: number }): (Key | null)[] {
	return [
		{ svg: renderSimple("pptPrev", true) },
		{ svg: renderSimple("pptNext", true) },
		{ svg: renderLabeled("pptSlide", o.slide, "on") },
		{ svg: renderSimple("pptGrid", true) },
		{ svg: renderSimple("pptContrast", true) },
		{ svg: renderLive(o.behind) },
		{ svg: renderSimple("pptPopout", true) },
		{ svg: renderSimple("pptTakeControl", true) },
		{ svg: share(false, true) },
		{ svg: renderGlyph("blur", "on") },
		{ svg: mute(true, true) },
		{ svg: camera(false, true) },
		{ svg: renderEmoji("hand", true) },
		{ svg: renderSimple("chat", true) },
		{ svg: renderSimple("leave", true, "danger") }
	];
}

function presenterDeck(o: { slide: string; activeTool: string }): (Key | null)[] {
	const t = (c: string) => ({ svg: tool(c, o.activeTool === c) });
	return [
		{ svg: renderSimple("pptPrev", true) },
		{ svg: renderSimple("pptNext", true) },
		{ svg: renderLabeled("pptSlide", o.slide, "on") },
		{ svg: renderSimple("pptGrid", true) },
		{ svg: renderSimple("pptRefresh", true) },
		t("ppt-cursor"),
		t("ppt-laser"),
		t("ppt-pen"),
		t("ppt-highlighter"),
		t("ppt-eraser"),
		{ svg: mute(true, true) },
		{ svg: camera(false, true) },
		{ svg: renderGlyph("pptHidePresenterView", "on") },
		{ svg: renderGlyph("pptPrivateView", "on") },
		{ svg: renderSimple("pptStopPresenting", true, "danger") }
	];
}

// ---------------------------------------------------------------- storyboard
type Shot = { svg: string; seconds: number };
const shots: Shot[] = [];
const hold = (svg: string, seconds: number) => shots.push({ svg, seconds });

hold(card("Teams Meeting Controls", "Meetings and PowerPoint Live, on your Stream Deck"), 3);

hold(deck(meetingDeck({ live: false }), { title: "Before a meeting", note: "Keys dim, so there is nothing to press by mistake" }), 3);

hold(deck(meetingDeck({ live: true }), { title: "You join", profile: "Teams Meeting", note: "Every key lights up the moment the call starts" }), 3);

hold(deck(meetingDeck({ live: true, muted: true }), { title: "You join", profile: "Teams Meeting", note: "Mute, and the key shows it - read from Teams, not guessed", pressed: 0 }), 3);
hold(deck(meetingDeck({ live: true, muted: true, cam: true }), { title: "You join", profile: "Teams Meeting", note: "Change it in Teams instead and the key still follows", pressed: 1 }), 3);

hold(deck(attendeeDeck({ slide: "4/17", behind: false }), { title: "Someone shares a deck", profile: "PowerPoint Live (Attendee)", note: "The profile switches on its own" }), 4);
hold(deck(attendeeDeck({ slide: "5/17", behind: false }), { title: "Read ahead", profile: "PowerPoint Live (Attendee)", note: "Move through slides at your own pace", pressed: 1 }), 2);
hold(deck(attendeeDeck({ slide: "6/17", behind: true }), { title: "Read ahead", profile: "PowerPoint Live (Attendee)", note: "Nobody else's view moves - and the key says you are behind", pressed: 1 }), 4);
hold(deck(attendeeDeck({ slide: "4/17", behind: false }), { title: "Catch up", profile: "PowerPoint Live (Attendee)", note: "One press returns you to the presenter", pressed: 5 }), 3);

hold(deck(attendeeDeck({ slide: "4/17", behind: false }), { title: "Take control", profile: "PowerPoint Live (Attendee)", note: "Take over the deck from the person presenting", pressed: 7 }), 3);
hold(deck(presenterDeck({ slide: "4/17", activeTool: "ppt-cursor" }), { title: "Now you are presenting", profile: "PowerPoint Live (Presenter)", note: "The profile follows your role, not just the meeting" }), 4);
hold(deck(presenterDeck({ slide: "4/17", activeTool: "ppt-pen" }), { title: "Draw on the slide", profile: "PowerPoint Live (Presenter)", note: "Pen, highlighter, laser and eraser - the active tool is lit", pressed: 7 }), 4);
hold(deck(presenterDeck({ slide: "5/17", activeTool: "ppt-pen" }), { title: "Draw on the slide", profile: "PowerPoint Live (Presenter)", note: "The slide counter is live on the key", pressed: 1 }), 3);
hold(deck(presenterDeck({ slide: "5/17", activeTool: "ppt-pen" }), { title: "Stop sharing", profile: "PowerPoint Live (Presenter)", note: "Teams asks first; hold the key to answer it", pressed: 14 }), 3);

hold(deck(meetingDeck({ live: true, muted: true, cam: true }), { title: "The deck ends", profile: "Teams Meeting", note: "Back to the meeting controls, without touching anything" }), 4);
hold(deck(meetingDeck({ live: false }), { title: "You leave", note: "And back to your own profile" }), 3);

hold(card("Teams Meeting Controls", "Windows - Stream Deck 7.1 or later - Microsoft Teams desktop"), 3);

// --------------------------------------------------------------------- write
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log(`Rendering ${shots.length} shots at ${W}x${H}, ${FPS}fps...`);
let frame = 0;
let rendered = 0;
for (const shot of shots) {
	const png = new Resvg(shot.svg, { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: true } })
		.render()
		.asPng();
	rendered++;
	const count = Math.round(shot.seconds * FPS);
	for (let i = 0; i < count; i++) {
		writeFileSync(path.join(OUT, `f${String(frame).padStart(5, "0")}.png`), png);
		frame++;
	}
}

const seconds = frame / FPS;
console.log(`  ${rendered} unique renders -> ${frame} frames (${seconds.toFixed(1)}s)`);
console.log(`  ${path.relative(ROOT, OUT)}`);
console.log(`\nEncode with:\n  ffmpeg -y -framerate ${FPS} -i "${OUT}\\f%05d.png" -c:v libx264 -pix_fmt yuv420p -movflags +faststart demo.mp4`);
