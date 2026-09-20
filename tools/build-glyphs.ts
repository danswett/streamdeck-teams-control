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

/**
 * Control glyphs. These carry no fill, so they can be recolored per state.
 *
 * All taken from the same 28px size tier: Fluent draws each tier with its own
 * stroke weight and level of detail, so mixing tiers makes the keys look
 * inconsistent next to each other.
 */
const CONTROLS: Record<string, string> = {
	mic: "mic_28_filled",
	micOff: "mic_off_28_filled",
	camera: "video_28_filled",
	cameraOff: "video_off_28_filled",
	hand: "hand_right_28_filled",
	// Teams calls this "background effects"; the plain blur glyph reads poorly
	// at key size.
	blur: "video_background_effect_28_filled",
	share: "share_screen_start_28_filled",
	shareStop: "share_screen_stop_28_filled",
	chat: "chat_28_filled",
	people: "people_28_filled",
	leave: "call_end_28_filled",
	emoji: "emoji_28_filled",

	// PowerPoint Live. Slide navigation uses chevrons rather than the media-style
	// arrows so it does not read as a recording transport.
	//
	// These are the 20px tier, not the 28px one the rest of the keys use,
	// because that is the tier PowerPoint Live's own toolbar is drawn at -
	// confirmed by matching the path data captured from the Teams DOM against
	// the shipped icons (tools/match-captured-icons.js). Fluent redraws each
	// tier rather than scaling it, so the 28px versions are visibly different
	// shapes, not just bigger ones.
	pptPrev: "chevron_left_20_filled",
	pptNext: "chevron_right_20_filled",
	// Outlined at rest, solid while grid view is open. Teams ships both halves
	// of the bundle and fills the squares on hover.
	pptGrid: "grid_20_regular",
	pptGridOn: "grid_20_filled",
	pptSync: "arrow_sync_20_filled",
	timer: "timer_20_filled",
	// Teams uses Fluent's dark-theme glyph here, not a contrast one - confirmed
	// by matching the path captured from the live Change view flyout. It already
	// fills the left half, which is why the earlier stand-in needed rotating and
	// this does not.
	pptContrast: "dark_theme_20_filled",
	// Captured from the live attendee toolbar on 2026-09-18: Teams draws a
	// monitor with a cursor, not a pointing hand. Outline rather than filled,
	// matching the toolbar's resting state. Teams ships this icon re-minified -
	// a cubic where Fluent writes a quadratic, an explicit close where Fluent
	// implies one - so a string comparison calls it "Teams-specific" and a look
	// at the shape calls it what it is.
	pptTakeControl: "desktop_cursor_20_regular",
	pptPopout: "window_new_28_filled",
	pptSlide: "slide_text_28_filled",

	// Presenter tools, drawn in PowerPoint Live's own colors (see TOOL_COLORS).
	// Fluent has no laser-pointer glyph at any size, so the small filled circle
	// stands in: in red it reads as the dot a laser actually puts on the slide,
	// which is closer to what Teams shows than a reticle or a torch would be.
	pptCursor: "cursor_28_filled",
	pptLaser: "circle_small_24_filled",
	pptPen: "pen_28_filled",
	pptHighlighter: "highlight_24_filled",
	pptEraser: "eraser_24_filled",

	// A screen with an X, not a podium. Teams draws "Stop sharing" this way -
	// seen in the meeting toolbar - and the podium-off glyph that was here read
	// as the same key as Presenter View, which is also a struck-through podium.
	pptStopPresenting: "share_screen_stop_20_filled",
	// Private viewing: whether attendees may move through the deck on their
	// own. Struck through while they may not, which is how Teams draws it.
	pptPrivateView: "eye_24_filled",
	pptPrivateViewOff: "eye_off_24_filled",
	// The pair PowerPoint Live's Change view menu swaps between. A podium, not
	// an eye - the eye belongs to private viewing. Struck through while the
	// notes pane exists, plain once it is hidden, named for the action each
	// offers, which is also how Teams labels them. 20px tier like the rest of
	// that toolbar.
	pptHidePresenterView: "presenter_off_20_filled",
	pptShowPresenterView: "presenter_20_filled",
	// Two arrows, not one: PowerPoint Live's refresh is the circular sync pair.
	// Confirmed as arrow_sync_20_filled by matching the captured path data, so
	// it is the 20px tier like the rest of that toolbar.
	pptRefresh: "arrow_sync_20_filled",
	pptCopyLink: "link_28_filled",
	pptLayoutContent: "slide_layout_24_filled",
	pptLayoutCameo: "video_person_28_filled",
	// Category icon. Stream Deck requires this to be monochrome white on
	// transparent, and the Microsoft Teams logo is Microsoft's trademark, so a
	// neutral "team" glyph stands in for it.
	category: "people_team_28_filled",

	// Monochrome stand-ins for the reactions and the hand, used only for the
	// action-list icons. Elgato's guidelines require those to be a white
	// monochrome stroke on transparent, so the full-color emoji that appear on
	// the keys themselves cannot be reused there.
	//
	// Fluent's system set has no applause glyph, so the two-hands icon stands in.
	// These are not all from the 28px tier because the set does not carry every
	// one at that size; they are normalized by viewBox when rendered.
	"list-react-like": "thumb_like_28_filled",
	"list-react-love": "heart_28_filled",
	"list-react-applause": "hand_multiple_28_filled",
	"list-react-laugh": "emoji_laugh_24_filled",
	"list-react-wow": "emoji_surprise_24_filled"
};

/** Reaction artwork, matching the five reactions Teams offers. */
const REACTIONS: Record<string, string> = {
	"react-like": "thumbs-up-default",
	"react-love": "red-heart",
	"react-applause": "clapping-hands-default",
	"react-laugh": "grinning-squinting-face",
	"react-wow": "face-with-open-mouth"
};

/** Emoji used outside the reaction set. */
const EXTRA_EMOJI: Record<string, string> = {
	hand: "raised-hand-default"
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
		const parsed = parse(path.join(dir, `${file}.svg`));


		out[key] = parsed;
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
		"  fluentui-emoji ('flat' style)                - reactions, full color"
	],
	controls: emit(CONTROLS, SYS),
	reactions: emit(REACTIONS, EMOJI),
	emoji: emit(EXTRA_EMOJI, EMOJI)
};

const target = path.join(ROOT, "src", "glyphs.generated.json");
const json = `${JSON.stringify(data, null, "\t")}\n`;
writeFileSync(target, json, "utf8");
console.log(`Wrote ${path.relative(ROOT, target)} (${json.length} bytes)`);
