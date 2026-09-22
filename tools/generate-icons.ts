/**
 * Emits the static artwork referenced by manifest.json from the same glyphs the
 * plugin uses at runtime, so the action list and the live keys never drift.
 *
 * Run with: node tools/generate-icons.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { REACTION_KEYS, TOOL_DEFAULT_COLOR, renderEmoji, renderGlyph, renderReaction } from "../src/icons.ts";
import { appIconSvg } from "./app-icon.ts";
import { TOOL_ICONS, composeToolSvg } from "./tool-art.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMGS = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin", "imgs");

/** action folder -> glyph used for its list icon and default key image. */
const ACTIONS: Record<string, { glyph: string; danger?: boolean }> = {
	mute: { glyph: "mic" },
	camera: { glyph: "camera" },
	blur: { glyph: "blur" },
	share: { glyph: "share" },
	chat: { glyph: "chat" },
	people: { glyph: "people" },
	leave: { glyph: "leave", danger: true },

	// PowerPoint Live.
	"ppt-prev": { glyph: "pptPrev" },
	"ppt-next": { glyph: "pptNext" },
	"ppt-status": { glyph: "pptSlide" },
	"ppt-slide-current": { glyph: "pptSlide" },
	"ppt-slide-next": { glyph: "pptNext" },
	"timer-dial": { glyph: "timer" },
	"ppt-sync": { glyph: "pptSync" },
	"ppt-grid": { glyph: "pptGrid" },
	"ppt-high-contrast": { glyph: "pptContrast" },
	"ppt-take-control": { glyph: "pptTakeControl" },
	"ppt-popout": { glyph: "pptPopout" },

	// PowerPoint Live, presenting. The five drawing tools keep Teams' own
	// artwork on their keys and are handled separately below; their action-list
	// icons are monochrome like everything else here.
	"ppt-private-view": { glyph: "pptPrivateView" },
	"ppt-hide-presenter-view": { glyph: "pptHidePresenterView" },
	"ppt-refresh": { glyph: "pptRefresh" },
	"ppt-copy-link": { glyph: "pptCopyLink" },
	"ppt-layout-content": { glyph: "pptLayoutContent" },
	"ppt-layout-cameo": { glyph: "pptLayoutCameo" },
	// The ink dials act on whichever tool is selected, so the list shows what
	// the dial changes - color, thickness - rather than any one tool; at
	// runtime they draw the tool that is actually active.
	"ppt-ink-color-dial": { glyph: "pptInkColor" },
	"ppt-ink-thickness-dial": { glyph: "pptInkThickness" },
	"ppt-stop-presenting": { glyph: "pptStopPresenting", danger: true }
};

function write(file: string, contents: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents, "utf8");
	console.log(`  ${path.relative(ROOT, file)}`);
}

function writePng(file: string, svg: string, width: number): void {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, png);
	console.log(`  ${path.relative(ROOT, file)} (${width}px)`);
}

console.log("Generating icons...");

for (const [name, { glyph, danger }] of Object.entries(ACTIONS)) {
	const dir = path.join(IMGS, "actions", name);
	// Action list icons must be monochrome white on transparent.
	write(path.join(dir, "icon.svg"), renderGlyph(glyph, "on"));
	write(path.join(dir, "key.svg"), renderGlyph(glyph, danger ? "danger" : "on"));
}

/**
 * The drawing tools, which split their artwork between the key and the list.
 *
 * The key shows Teams' own art, captured from the DOM: a generic Fluent pen
 * beside the real one reads as a different control. The action list cannot
 * have it — Elgato require list icons to be a white monochrome stroke on a
 * transparent background, and colored artwork there is what got v1.8.2 sent
 * back — so the list uses the tool's Fluent glyph like every other action.
 */
const TOOL_ACTIONS: Record<string, string> = {
	"ppt-cursor": "pptCursor",
	"ppt-laser": "pptLaser",
	"ppt-pen": "pptPen",
	"ppt-highlighter": "pptHighlighter",
	"ppt-eraser": "pptEraser"
};

for (const [name, glyph] of Object.entries(TOOL_ACTIONS)) {
	const dir = path.join(IMGS, "actions", name);
	const icon = TOOL_ICONS[name];
	if (!icon) throw new Error(`no captured artwork for ${name}`);
	const ink = TOOL_DEFAULT_COLOR[name] ?? "#FFFFFF";

	mkdirSync(dir, { recursive: true });
	write(path.join(dir, "icon.svg"), renderGlyph(glyph, "on"));

	// Rasterised at each size rather than scaled from one, so the gradients and
	// blur filters resolve at the size they are actually shown at. Stream Deck's
	// key sizes: 72px, doubled for @2x.
	const sizes: [string, number][] = [
		["key.png", 72],
		["key@2x.png", 144]
	];
	for (const [file, size] of sizes) {
		writePng(path.join(dir, file), composeToolSvg(icon, ink, false, size), size);
	}

	// The manifest references these without an extension, so a stale file left
	// beside the one meant to win is ambiguous - and was what the action list
	// kept showing. The list icon is SVG now; the key stays PNG.
	for (const stale of ["icon.png", "icon@2x.png", "key.svg"]) {
		rmSync(path.join(dir, stale), { force: true });
	}
}

// Each reaction is its own action, so each gets its own artwork. The key shows
// the full-color emoji, but the action list must be monochrome white on
// transparent per Elgato's guidelines, so it uses a Fluent system glyph.
for (const key of REACTION_KEYS) {
	const dir = path.join(IMGS, "actions", key);
	write(path.join(dir, "icon.svg"), renderGlyph(`list-${key}`, "on"));
	write(path.join(dir, "key.svg"), renderReaction(key, true));
}

// Raise hand follows the same split: emoji on the key, monochrome in the list.
const handDir = path.join(IMGS, "actions", "hand");
write(path.join(handDir, "icon.svg"), renderGlyph("hand", "on"));
write(path.join(handDir, "key.svg"), renderEmoji("hand", true));

// Plugin-level artwork.
const pluginDir = path.join(IMGS, "plugin");
write(path.join(pluginDir, "category-icon.svg"), renderGlyph("category", "on"));

// Stream Deck requires the plugin icon itself to be PNG. Same mark as the
// Marketplace app icon, from one source, so the store and the preferences pane
// cannot end up showing different products - which is exactly what happened
// when they were drawn separately.
const markSvg = appIconSvg();

writePng(path.join(pluginDir, "marketplace.png"), markSvg, 256);
writePng(path.join(pluginDir, "marketplace@2x.png"), markSvg, 512);

// The 288px variant is written by tools/generate-marketplace.ts, alongside the
// thumbnail and gallery it has to sit beside - from the same appIconSvg().

console.log("Done.");
