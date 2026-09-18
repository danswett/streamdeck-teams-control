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
	"ppt-sync": { glyph: "pptSync" },
	"ppt-grid": { glyph: "pptGrid" },
	"ppt-high-contrast": { glyph: "pptContrast" },
	"ppt-take-control": { glyph: "pptTakeControl" },
	"ppt-popout": { glyph: "pptPopout" },

	// PowerPoint Live, presenting. The five drawing tools are handled separately
	// below: they ship Teams' own artwork rather than a Fluent stand-in.
	"ppt-private-view": { glyph: "pptPrivateView" },
	"ppt-hide-presenter-view": { glyph: "pptHidePresenterView" },
	"ppt-refresh": { glyph: "pptRefresh" },
	"ppt-copy-link": { glyph: "pptCopyLink" },
	"ppt-layout-content": { glyph: "pptLayoutContent" },
	"ppt-layout-cameo": { glyph: "pptLayoutCameo" },
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
 * The drawing tools, which are the exception to the monochrome rule.
 *
 * Their keys show Teams' own artwork, captured from the DOM, and a generic
 * Fluent pen beside the real one in the action list reads as a different
 * control. The artwork is already rasterised into tool-images.generated.json,
 * so both files come straight from it and cannot drift from what the key draws.
 */
const TOOL_ACTIONS = ["ppt-cursor", "ppt-laser", "ppt-pen", "ppt-highlighter", "ppt-eraser"];

for (const name of TOOL_ACTIONS) {
	const dir = path.join(IMGS, "actions", name);
	const icon = TOOL_ICONS[name];
	if (!icon) throw new Error(`no captured artwork for ${name}`);
	const ink = TOOL_DEFAULT_COLOR[name] ?? "#FFFFFF";

	// Rasterised at each size rather than scaled from one, so the gradients and
	// blur filters resolve at the size they are actually shown at. Stream Deck's
	// own sizes: 20px in the action list, 72px on a key, doubled for @2x.
	const sizes: [string, number][] = [
		["icon.png", 20],
		["icon@2x.png", 40],
		["key.png", 72],
		["key@2x.png", 144]
	];

	mkdirSync(dir, { recursive: true });
	for (const [file, size] of sizes) {
		writePng(path.join(dir, file), composeToolSvg(icon, ink, false, size), size);
	}

	// The manifest references these without an extension, so a stale SVG left
	// beside the PNG is ambiguous - and was what the action list kept showing.
	for (const stale of ["icon.svg", "key.svg"]) {
		rmSync(path.join(dir, stale), { force: true });
	}
}

// Each reaction is its own action, so each gets its own artwork. The key shows
// the full-colour emoji, but the action list must be monochrome white on
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

// Stream Deck requires the plugin icon itself to be PNG.
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 144 144">
	<rect width="144" height="144" rx="30" fill="#5059C9"/>
	<g transform="translate(14.4,14.4) scale(0.8)">
		${renderGlyph("mic", "on").replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}
	</g>
</svg>`;

writePng(path.join(pluginDir, "marketplace.png"), markSvg, 256);
writePng(path.join(pluginDir, "marketplace@2x.png"), markSvg, 512);

// The 288px Marketplace app icon is produced by tools/generate-marketplace.ts,
// alongside the thumbnail and gallery images it has to sit beside.

console.log("Done.");
