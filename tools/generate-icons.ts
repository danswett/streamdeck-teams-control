/**
 * Emits the static artwork referenced by manifest.json from the same glyphs the
 * plugin uses at runtime, so the action list and the live keys never drift.
 *
 * Run with: node tools/generate-icons.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { REACTION_KEYS, renderEmoji, renderGlyph, renderReaction } from "../src/icons.ts";

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
	"ppt-zoom-in": { glyph: "pptZoomIn" },
	"ppt-zoom-out": { glyph: "pptZoomOut" },
	"ppt-high-contrast": { glyph: "pptContrast" },
	"ppt-translate": { glyph: "pptTranslate" },
	"ppt-take-control": { glyph: "pptTakeControl" },
	"ppt-popout": { glyph: "pptPopout" },
	"ppt-copilot": { glyph: "pptCopilot" },

	// PowerPoint Live, presenting.
	"ppt-cursor": { glyph: "pptCursor" },
	"ppt-laser": { glyph: "pptLaser" },
	"ppt-pen": { glyph: "pptPen" },
	"ppt-highlighter": { glyph: "pptHighlighter" },
	"ppt-eraser": { glyph: "pptEraser" },
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
