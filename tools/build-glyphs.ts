/**
 * Extracts artwork from Microsoft's MIT-licensed Fluent icon sets and emits it
 * as a TypeScript module, so the plugin bundle carries the glyphs and needs no
 * runtime file access.
 *
 * Sources (both MIT, both Microsoft's own, and both the sets Teams itself
 * renders — so the keys look native without copying anyone's proprietary art):
 *   - @fluentui/svg-icons  : Fluent UI System Icons (monochrome control glyphs)
 *   - fluentui-emoji       : Fluent Emoji, "flat" style (meeting reactions)
 *
 * Run with: node tools/build-glyphs.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYS = path.join(ROOT, "node_modules", "@fluentui", "svg-icons", "icons");
const EMOJI = path.join(ROOT, "node_modules", "fluentui-emoji", "icons", "flat");

/** Control glyphs. These carry no fill, so they can be recoloured per state. */
const CONTROLS: Record<string, string> = {
	mic: "mic_48_filled",
	micOff: "mic_off_48_filled",
	camera: "video_48_filled",
	cameraOff: "video_off_48_filled",
	hand: "hand_right_28_filled",
	blur: "blur_28_filled",
	share: "share_screen_start_48_filled",
	shareStop: "share_screen_stop_48_filled",
	chat: "chat_48_filled",
	people: "people_48_filled",
	leave: "call_end_48_filled",
	emoji: "emoji_48_filled"
};

/** Reaction artwork, matching the five reactions Teams offers. */
const REACTIONS: Record<string, string> = {
	"react-like": "thumbs-up-default",
	"react-love": "red-heart",
	"react-applause": "clapping-hands-default",
	"react-laugh": "grinning-squinting-face",
	"react-wow": "face-with-open-mouth"
};

type Parsed = { viewBox: string; body: string };

function parse(file: string): Parsed {
	const svg = readFileSync(file, "utf8");

	const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
	if (!viewBox) throw new Error(`no viewBox in ${file}`);

	const open = svg.indexOf(">");
	const close = svg.lastIndexOf("</svg>");
	if (open < 0 || close < 0) throw new Error(`malformed svg: ${file}`);

	const body = svg.slice(open + 1, close).trim();
	if (!body) throw new Error(`empty svg: ${file}`);
	return { viewBox, body };
}

function emit(entries: Record<string, string>, dir: string): Record<string, Parsed> {
	const out: Record<string, Parsed> = {};
	for (const [key, file] of Object.entries(entries)) {
		out[key] = parse(path.join(dir, `${file}.svg`));
		console.log(`  ${key} <- ${file}.svg`);
	}
	return out;
}

console.log("Extracting Fluent glyphs...");

const data = {
	$comment: [
		"GENERATED FILE - do not edit. Run: node tools/build-glyphs.ts",
		"",
		"Artwork from Microsoft's Fluent icon sets, both MIT licensed:",
		"  @fluentui/svg-icons (Fluent UI System Icons) - control glyphs, no fill",
		"  fluentui-emoji ('flat' style)                - reactions, full colour"
	],
	controls: emit(CONTROLS, SYS),
	reactions: emit(REACTIONS, EMOJI)
};

const target = path.join(ROOT, "src", "glyphs.generated.json");
const json = `${JSON.stringify(data, null, "\t")}\n`;
writeFileSync(target, json, "utf8");
console.log(`Wrote ${path.relative(ROOT, target)} (${json.length} bytes)`);
