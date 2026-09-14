/**
 * Emits the static icons referenced by manifest.json from the same glyph
 * definitions the plugin uses at runtime, so the action list and the live keys
 * can never drift apart.
 *
 * Run with: node tools/generate-icons.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { type Glyph, renderGlyph, renderReaction } from "../src/icons.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMGS = path.join(ROOT, "com.dswett.teamscontrol.sdPlugin", "imgs");

/** action name -> glyph used for its list icon and default key image. */
const ACTIONS: Record<string, Glyph> = {
	mute: "mic",
	camera: "camera",
	hand: "hand",
	blur: "blur",
	share: "share",
	chat: "chat",
	people: "people",
	leave: "leave"
};

function write(file: string, contents: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents, "utf8");
	console.log(`  ${path.relative(ROOT, file)}`);
}

console.log("Generating icons...");

for (const [name, glyph] of Object.entries(ACTIONS)) {
	const dir = path.join(IMGS, "actions", name);
	// Action list icons must be monochrome white on transparent.
	write(path.join(dir, "icon.svg"), renderGlyph(glyph, "on"));
	write(path.join(dir, "key.svg"), renderGlyph(glyph, name === "leave" ? "danger" : "on"));
}

// The reaction action gets a neutral face for its list icon and a "like" key.
const reactDir = path.join(IMGS, "actions", "react");

// White outline version for the action list, which must stay monochrome.
write(
	path.join(reactDir, "icon.svg"),
	`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
		<circle cx="72" cy="72" r="46" fill="none" stroke="#FFFFFF" stroke-width="10"/>
		<circle cx="56" cy="60" r="7" fill="#FFFFFF"/>
		<circle cx="88" cy="60" r="7" fill="#FFFFFF"/>
		<path d="M48 86 Q72 108 96 86" stroke="#FFFFFF" stroke-width="10" fill="none" stroke-linecap="round"/>
	</svg>`
);
write(path.join(reactDir, "key.svg"), renderReaction("react-like", true));

// Plugin-level artwork.
const pluginDir = path.join(IMGS, "plugin");
write(path.join(pluginDir, "category-icon.svg"), renderGlyph("mic", "on"));

// Stream Deck requires the plugin icon itself to be PNG, so this one is
// rasterised from the same source SVG rather than shipped as vector.
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 144 144">
	<rect width="144" height="144" rx="30" fill="#4B53BC"/>
	<g transform="translate(21.6,17.6) scale(0.70)">
		${renderGlyph("mic", "on").replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}
	</g>
</svg>`;

function writePng(file: string, svg: string, width: number): void {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, png);
	console.log(`  ${path.relative(ROOT, file)} (${width}px)`);
}

writePng(path.join(pluginDir, "marketplace.png"), markSvg, 256);
writePng(path.join(pluginDir, "marketplace@2x.png"), markSvg, 512);

// Not referenced by the manifest: Maker Console asks for a 288px app icon at
// submission time.
writePng(path.join(ROOT, "dist", "marketplace", "app-icon-288.png"), markSvg, 288);

console.log("Done.");
