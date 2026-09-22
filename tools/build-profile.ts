/**
 * Builds the bundled Stream Deck profiles the plugin switches between.
 *
 * Three states - meeting, watching a deck, presenting one - built for each deck
 * the plugin ships a layout for, so the file count is states x devices.
 *
 * A plugin may only switch to a profile it ships itself - the SDK cannot touch
 * user-made profiles - so any layout the plugin wants to show has to be built
 * here rather than drawn by hand in the Stream Deck app.
 *
 * A .streamDeckProfile is a ZIP whose root holds one `<UUID>.sdProfile` folder:
 *
 *   <UUID>.sdProfile/
 *     manifest.json              device, name, and the list of pages
 *     Profiles/<PAGE-ID>/
 *       manifest.json            one "Controllers" entry holding the key grid
 *
 * The schema here is version 3.0, copied from the profiles Stream Deck itself
 * writes on this machine. The earlier attempt shipped version 2.0, which Stream
 * Deck offered to install and then silently did nothing with - it never
 * appeared in ProfilesV3 at all. Every field Stream Deck writes is reproduced,
 * including the ones that look redundant (ActionID, LinkedTitle, Plugin,
 * Resources), because a profile that is almost right fails quietly.
 *
 * Run with: node tools/build-profile.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Deck as Device, MINI, NEO, PLUS, PLUS_XL, STREAM_DECK, XL } from "./decks.ts";

import AdmZip from "adm-zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin");
const PLUGIN_UUID = "com.bad-duck.teamscontrol";
const PLUGIN_NAME = "Teams Meeting Controls";

type Key = {
	/**
	 * Action to place: this plugin's short key, or another plugin's full UUID
	 * when {@link Key.plugin} says who owns it.
	 */
	action: string;
	name: string;
	settings?: object;
	/**
	 * The plugin that owns this action, when it is not this one.
	 *
	 * A bundled profile may place any plugin's action, which is how Elgato's
	 * own default profiles put volume controls on a + XL. Worth keeping in
	 * mind that the key is dead for anyone who does not have that plugin, so
	 * this is only for the ones a deck ships with.
	 */
	plugin?: { name: string; uuid: string };
};
type Layout = Record<string, Key>;

type Profile = {
	name: string;
	device: Device;
	uuid: string;
	page: string;
	/**
	 * Layout revision, appended to the file name when above 1.
	 *
	 * Stream Deck installs a bundled profile the first time it is switched to
	 * and never looks at the shipped copy again: changing the layout and
	 * updating the plugin leaves every existing user on the old one, with
	 * nothing reported anywhere. It identifies an installed profile by the
	 * plugin that installed it and the path it came from - the path is written
	 * into the installed copy's PreconfiguredName, which is how this was
	 * established - so a changed path is the only thing it treats as new.
	 *
	 * Bumping this is expensive and is not routine. It ships a second profile
	 * rather than replacing the first: the old one stays on the user's machine
	 * for good, because a plugin cannot remove a profile and Stream Deck never
	 * retires one it stops seeing. The revision therefore also goes into the
	 * profile's displayed name, or the two arrive under the same name and
	 * Stream Deck disambiguates them itself as "copy", "copy 1", "copy 2".
	 *
	 * So bump it only for a layout users already have. A layout that has never
	 * shipped can be edited freely; just record the new {@link layoutHash}.
	 */
	revision?: number;
	/**
	 * Fingerprint of the layout as it was last published, from
	 * {@link layoutFingerprint}.
	 *
	 * The revision is what Stream Deck reacts to, and nothing stops a layout
	 * being changed without it being bumped - the result is an update that
	 * reaches nobody, silently. So the build recomputes this and refuses to
	 * run when it has moved and the revision has not, which turns the one
	 * mistake this scheme invites into a failed build.
	 *
	 * Deliberately not the plugin version: that changes on every release,
	 * including the ones that do not touch a layout, and each change would
	 * hand every user a new profile and strand whatever they had customized on
	 * the old one.
	 */
	layoutHash?: string;
	layout: Layout;
	/** Dials, addressed "0,0".."N,0". Only meaningful on a deck that has them. */
	dials?: Layout;
};

/**
 * What a profile actually puts in front of the user: the deck it is for, and
 * every key and dial on it. Deliberately excludes the name, the revision and
 * the ids, because none of those change what is on the hardware.
 */
function layoutFingerprint(profile: Profile): string {
	const placed = (layout: Layout, kind: string) =>
		Object.entries(layout)
			.map(([pos, key]) => `${kind} ${pos} ${key.action} ${JSON.stringify(key.settings ?? {})}`)
			.sort();

	const parts = [
		profile.device.model,
		`${profile.device.columns}x${profile.device.rows}+${profile.device.encoders}`,
		...placed(profile.layout, "key"),
		...placed(profile.dials ?? {}, "dial")
	];

	return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 8);
}

/**
 * The meeting half of the + XL, identical in all three of its profiles.
 *
 * Nine columns is wide enough to stop treating a profile switch as a redraw of
 * the whole deck: the left four columns are the meeting and never move, so
 * mute is under the same finger whether or not anyone is presenting, and only
 * the right five columns change. Leave sits in the far corner, diagonally
 * opposite mute, because the two worst keys to confuse are those.
 */
/**
 * The meeting keys on a deck wide enough to hold them still.
 *
 * Taken from the + XL presenter layout, which was laid out by hand on the
 * hardware and is the reference every other layout is built from. Leave is the
 * one thing that moves: it belongs in the far top corner, and which column
 * that is depends on the deck.
 *
 * These positions are identical in all three of a deck's profiles, so a
 * profile switch never moves mute out from under the finger reaching for it.
 */
const meetingBlock = (leaveColumn: number): Layout => ({
	"0,0": { action: "mute", name: "Mute" },
	"1,0": { action: "camera", name: "Camera" },
	"2,0": { action: "blur", name: "Background Blur" },
	"3,0": { action: "share", name: "Share Screen" },
	[`${leaveColumn},0`]: { action: "leave", name: "Leave" },

	"0,1": { action: "hand", name: "Raise Hand" },
	"1,1": { action: "chat", name: "Chat" },
	"2,1": { action: "people", name: "People" },

	"0,2": { action: "react-like", name: "React: Like" },
	"1,2": { action: "react-love", name: "React: Love" },
	"2,2": { action: "react-applause", name: "React: Applause" },
	"3,2": { action: "react-laugh", name: "React: Laugh" },
	"4,2": { action: "react-wow", name: "React: Wow" }
});

/**
 * Moving through the deck: back, where you are, forward.
 *
 * These three are always adjacent and always in this order, on every deck that
 * ships a PowerPoint Live layout, and always on the bottom row - the row an
 * unsighted hand finds first. Reading the slide number means looking at the
 * deck; reaching for the next slide should not.
 */
const slideNav = (row: number, column = 0): Layout => ({
	[`${column},${row}`]: { action: "ppt-prev", name: "PPT Live: Previous Slide" },
	[`${column + 1},${row}`]: { action: "ppt-status", name: "PPT Live: Slide Counter" },
	[`${column + 2},${row}`]: { action: "ppt-next", name: "PPT Live: Next Slide" }
});

/* ------------------------------------------------------------------------- *
 * The eight-key decks: Stream Deck + and Neo, both 4x2.
 *
 * Eight keys is too few to hold a meeting block still underneath a changing
 * presentation the way the + XL does, so each profile uses all eight for
 * whatever is happening now. Mute survives into every one of them - being
 * moved onto a presentation layout must never be what costs you the mute key.
 *
 * The bottom row is the + XL's bottom row as far as it reaches: the slide
 * navigation, then grid view.
 *
 * The + has four dials and the Neo has none, and neither has room for a key
 * the other lacks, so the two share these three blocks exactly.
 * ------------------------------------------------------------------------- */

const EIGHT_MEETING: Layout = {
	"0,0": { action: "mute", name: "Mute" },
	"1,0": { action: "camera", name: "Camera" },
	"2,0": { action: "blur", name: "Background Blur" },
	"3,0": { action: "share", name: "Share Screen" },

	"0,1": { action: "hand", name: "Raise Hand" },
	"1,1": { action: "chat", name: "Chat" },
	"2,1": { action: "people", name: "People" },
	"3,1": { action: "leave", name: "Leave" }
};

const EIGHT_ATTENDEE: Layout = {
	"0,0": { action: "mute", name: "Mute" },
	"1,0": { action: "camera", name: "Camera" },
	// Navigation moves your own view only, so Sync is what gets you back.
	"2,0": { action: "ppt-sync", name: "PPT Attendee: Sync" },
	"3,0": { action: "ppt-take-control", name: "PPT Attendee: Take Control" },

	...slideNav(1),
	"3,1": { action: "ppt-grid", name: "PPT Live: Grid View" }
};

/**
 * Cursor is in the tools rather than the eraser. Cursor is how drawing is
 * switched off again, so a deck that offers a pen without it can put the
 * presentation into a state it cannot get out of.
 */
const EIGHT_PRESENTER: Layout = {
	"0,0": { action: "mute", name: "Mute" },
	"1,0": { action: "ppt-cursor", name: "PPT Presenter: Cursor" },
	"2,0": { action: "ppt-laser", name: "PPT Presenter: Laser Pointer" },
	"3,0": { action: "ppt-pen", name: "PPT Presenter: Pen" },

	...slideNav(1),
	"3,1": { action: "ppt-grid", name: "PPT Live: Grid View" }
};

/** The timer, which is a meeting control rather than a PowerPoint one. */
const TIMER_DIAL: Layout = {
	"0,0": { action: "timer-dial", name: "Meeting Timer" }
};

/**
 * Fixed rather than random: regenerating must not orphan the copy Stream Deck
 * has already installed, and stable ids keep the build reproducible.
 */
const PROFILES: Profile[] = [
	{
		name: "Teams Meeting",
		device: STREAM_DECK,
		uuid: "1F4B6C2E-8A57-4D39-9E10-3C7B2A6F5D84",
		layoutHash: "72941c2d",
		page: "a1b2c3d4-0001-4e85-a0b7-2f6c1e5d8a34",
		// The meeting itself. Shown from the moment you join until you leave,
		// and returned to whenever a presentation ends.
		layout: {
			"0,0": { action: "mute", name: "Mute" },
			"1,0": { action: "camera", name: "Camera" },
			"2,0": { action: "blur", name: "Background Blur" },
			"3,0": { action: "share", name: "Share Screen" },
			"4,0": { action: "leave", name: "Leave" },

			"0,1": { action: "hand", name: "Raise Hand" },
			"1,1": { action: "chat", name: "Chat" },
			"2,1": { action: "people", name: "People" },

			"0,2": { action: "react-like", name: "React: Like" },
			"1,2": { action: "react-love", name: "React: Love" },
			"2,2": { action: "react-applause", name: "React: Applause" },
			"3,2": { action: "react-laugh", name: "React: Laugh" },
			"4,2": { action: "react-wow", name: "React: Wow" }
		}
	},
	{
		name: "PowerPoint Live (Attendee)",
		device: STREAM_DECK,
		uuid: "2E5C7D3F-9B68-4E4A-8F21-4D8C3B7A6E95",
		layoutHash: "2f39b420",
		/*
			The slide navigation moved to the bottom row. This layout has
			shipped, and Stream Deck will not update one in place, so reaching
			anyone who already has it costs a new path - and leaves their old
			copy behind under the unsuffixed name.
		*/
		revision: 2,
		page: "a1b2c3d4-0002-4e85-a0b7-2f6c1e5d8a34",
		// Watching someone else's deck. The meeting keys keep the top row they
		// have in the meeting profile, and the slide navigation takes the
		// bottom one.
		layout: {
			"0,0": { action: "mute", name: "Mute" },
			"1,0": { action: "camera", name: "Camera" },
			"2,0": { action: "blur", name: "Background Blur" },
			"3,0": { action: "share", name: "Share Screen" },
			"4,0": { action: "leave", name: "Leave" },

			"0,1": { action: "hand", name: "Raise Hand" },
			"1,1": { action: "chat", name: "Chat" },
			// Navigation moves your own view only, so Sync is what gets you back.
			"2,1": { action: "ppt-sync", name: "PPT Attendee: Sync" },
			"3,1": { action: "ppt-popout", name: "PPT Live: Pop Out" },
			// Taking control makes you the presenter, which swaps this whole
			// profile out for the presenter one.
			"4,1": { action: "ppt-take-control", name: "PPT Attendee: Take Control" },

			...slideNav(2),
			"3,2": { action: "ppt-grid", name: "PPT Live: Grid View" },
			"4,2": { action: "ppt-high-contrast", name: "PPT Live: High Contrast" }
		}
	},
	{
		name: "PowerPoint Live (Presenter)",
		device: STREAM_DECK,
		uuid: "3D6E8A4B-1C79-4F5B-9A32-5E9D4C8B7F06",
		layoutHash: "8f6b0afa",
		// Shipped, and changed - see the attendee layout above.
		revision: 2,
		page: "a1b2c3d4-0003-4e85-a0b7-2f6c1e5d8a34",
		// Driving the deck. The drawing tools get their own row because they are
		// a single-select group and read as one control, and the slide
		// navigation takes the bottom one.
		layout: {
			"0,0": { action: "mute", name: "Mute" },
			"1,0": { action: "camera", name: "Camera" },
			"2,0": { action: "ppt-hide-presenter-view", name: "PPT Presenter: Presenter View" },
			"3,0": { action: "ppt-private-view", name: "PPT Presenter: Private Viewing" },
			"4,0": { action: "ppt-stop-presenting", name: "PPT Presenter: Stop Presenting" },

			"0,1": { action: "ppt-cursor", name: "PPT Presenter: Cursor" },
			"1,1": { action: "ppt-laser", name: "PPT Presenter: Laser Pointer" },
			"2,1": { action: "ppt-pen", name: "PPT Presenter: Pen" },
			"3,1": { action: "ppt-highlighter", name: "PPT Presenter: Highlighter" },
			"4,1": { action: "ppt-eraser", name: "PPT Presenter: Eraser" },

			...slideNav(2),
			"3,2": { action: "ppt-grid", name: "PPT Live: Grid View" },
			"4,2": { action: "ppt-refresh", name: "PPT Presenter: Present Latest" }
		}
	},

	/* --------------------------------------------------------------------- *
	 * Stream Deck + XL
	 *
	 * Nine columns wide, so the meeting stops competing with the presentation
	 * for space: XL_MEETING owns the left four columns in all three profiles
	 * and never moves, and the right five carry whatever is happening now. In
	 * the meeting profile they carry nothing, and a dark right-hand side is a
	 * fair description of a meeting with no deck in it.
	 * --------------------------------------------------------------------- */
	{
		name: "Teams Meeting",
		device: PLUS_XL,
		uuid: "4A7C9E1D-2B83-4F6A-8D45-6E1F0C3B9A72",
		layoutHash: "5cfea916",
		page: "a1b2c3d4-0011-4e85-a0b7-2f6c1e5d8a34",
		dials: { ...TIMER_DIAL },
		layout: { ...meetingBlock(8) }
	},
	{
		name: "PowerPoint Live (Attendee)",
		device: PLUS_XL,
		uuid: "5B8D0F2E-3C94-4A7B-9E56-7F2A1D4C8B63",
		layoutHash: "b6f59993",
		page: "a1b2c3d4-0012-4e85-a0b7-2f6c1e5d8a34",
		dials: { ...TIMER_DIAL },
		layout: {
			...meetingBlock(8),

			// The presenter profile's bottom row as far as an attendee needs
			// it: the slide navigation, grid view, then the keys that decide
			// whose deck you are looking at.
			...slideNav(3),
			"3,3": { action: "ppt-grid", name: "PPT Live: Grid View" },
			// Navigation moves your own view only, so Sync is what gets you back.
			"4,3": { action: "ppt-sync", name: "PPT Attendee: Sync" },
			"5,3": { action: "ppt-popout", name: "PPT Live: Pop Out" },
			// Taking control makes you the presenter, which swaps this whole
			// profile out for the presenter one.
			"6,3": { action: "ppt-take-control", name: "PPT Attendee: Take Control" },
			"7,3": { action: "ppt-high-contrast", name: "PPT Live: High Contrast" }
		}
	},
	{
		name: "PowerPoint Live (Presenter)",
		device: PLUS_XL,
		uuid: "6C9E1A3F-4D05-4B8C-8F67-8A3B2E5D9C74",
		layoutHash: "21fe4871",
		page: "a1b2c3d4-0013-4e85-a0b7-2f6c1e5d8a34",
		dials: {
			// Positions 1 and 2: the slide being presented and the one after it.
			"0,0": { action: "ppt-slide-current", name: "PPT Live: Current Slide" },
			"1,0": { action: "ppt-slide-next", name: "PPT Live: Next Slide" },

			"2,0": { action: "ppt-ink-thickness-dial", name: "PPT Presenter: Ink Thickness" },
			"3,0": { action: "ppt-ink-color-dial", name: "PPT Presenter: Ink Color" },

			// The timer is not a PowerPoint control, so it earns a slot in every
			// meeting profile rather than only this one.
			"4,0": { action: "timer-dial", name: "Meeting Timer" }
		},
		/*
			Laid out by hand in the Stream Deck app and read back with
			tools/read-profile.mjs. It is the reference the other layouts are
			built from: the meeting block, then the slide navigation on the
			bottom row with grid view and the drawing tools after it.
		*/
		layout: {
			...meetingBlock(8),

			"5,2": { action: "ppt-refresh", name: "PPT Presenter: Present Latest" },
			"6,2": { action: "ppt-private-view", name: "PPT Presenter: Private Viewing" },
			"7,2": { action: "ppt-copy-link", name: "PPT Presenter: Copy Link" },
			"8,2": { action: "ppt-stop-presenting", name: "PPT Presenter: Stop Presenting" },

			// Navigation and the drawing tools together along the bottom, under
			// the dials that configure them.
			...slideNav(3),
			"3,3": { action: "ppt-grid", name: "PPT Live: Grid View" },
			"4,3": { action: "ppt-cursor", name: "PPT Presenter: Cursor" },
			"5,3": { action: "ppt-laser", name: "PPT Presenter: Laser Pointer" },
			"6,3": { action: "ppt-pen", name: "PPT Presenter: Pen" },
			"7,3": { action: "ppt-highlighter", name: "PPT Presenter: Highlighter" },
			"8,3": { action: "ppt-eraser", name: "PPT Presenter: Eraser" }
		}
	},

	/* --------------------------------------------------------------------- *
	 * Stream Deck Mini - 3x2
	 *
	 * Six keys, so each profile carries only what that moment needs. Mute is
	 * in all three: being moved onto a presentation layout must never be what
	 * costs you the mute key.
	 * --------------------------------------------------------------------- */
	{
		name: "Teams Meeting",
		device: MINI,
		uuid: "7D0F2B4A-5E16-4C9D-8A78-9B4C3F6E1D85",
		layoutHash: "68a31f33",
		page: "a1b2c3d4-0021-4e85-a0b7-2f6c1e5d8a34",
		layout: {
			"0,0": { action: "mute", name: "Mute" },
			"1,0": { action: "camera", name: "Camera" },
			"2,0": { action: "hand", name: "Raise Hand" },

			"0,1": { action: "chat", name: "Chat" },
			"1,1": { action: "blur", name: "Background Blur" },
			"2,1": { action: "leave", name: "Leave" }
		}
	},
	{
		name: "PowerPoint Live (Attendee)",
		device: MINI,
		uuid: "8E1A3C5B-6F27-4D0E-9B89-0C5D4A7F2E96",
		layoutHash: "9ecc3c65",
		page: "a1b2c3d4-0022-4e85-a0b7-2f6c1e5d8a34",
		layout: {
			"0,0": { action: "mute", name: "Mute" },
			"1,0": { action: "camera", name: "Camera" },
			// Navigation moves your own view only, so Sync is what gets you back.
			"2,0": { action: "ppt-sync", name: "PPT Attendee: Sync" },

			...slideNav(1)
		}
	},
	{
		name: "PowerPoint Live (Presenter)",
		device: MINI,
		uuid: "9F2B4D6C-7038-4E1F-8C90-1D6E5B8A3F07",
		layoutHash: "5df1bca3",
		page: "a1b2c3d4-0023-4e85-a0b7-2f6c1e5d8a34",
		/*
			Cursor rather than the pen, on a deck with room for one of them.
			Cursor is how drawing is switched off again, and a pen with no way
			back strands the presentation in a state the deck cannot undo.
		*/
		layout: {
			"0,0": { action: "mute", name: "Mute" },
			"1,0": { action: "ppt-cursor", name: "PPT Presenter: Cursor" },
			"2,0": { action: "ppt-laser", name: "PPT Presenter: Laser Pointer" },

			...slideNav(1)
		}
	},

	/* --------------------------------------------------------------------- *
	 * Stream Deck XL - 8x4
	 *
	 * The + XL without the dials, and one column narrower. It is wide enough
	 * for the same bargain: XL_MEETING owns the left four columns in all three
	 * profiles and never moves, and the right four carry the presentation.
	 * --------------------------------------------------------------------- */
	{
		name: "Teams Meeting",
		device: XL,
		uuid: "0A3C5E7D-8149-4F20-9DA1-2E7F6C9B4018",
		layoutHash: "a1ac84b5",
		page: "a1b2c3d4-0031-4e85-a0b7-2f6c1e5d8a34",
		layout: { ...meetingBlock(7) }
	},
	{
		name: "PowerPoint Live (Attendee)",
		device: XL,
		uuid: "1B4D6F8E-925A-4031-8EB2-3F807DAC5129",
		layoutHash: "eaa8f031",
		page: "a1b2c3d4-0032-4e85-a0b7-2f6c1e5d8a34",
		layout: {
			...meetingBlock(7),

			...slideNav(3),
			"3,3": { action: "ppt-grid", name: "PPT Live: Grid View" },
			// Navigation moves your own view only, so Sync is what gets you back.
			"4,3": { action: "ppt-sync", name: "PPT Attendee: Sync" },
			"5,3": { action: "ppt-popout", name: "PPT Live: Pop Out" },
			// Taking control makes you the presenter, which swaps this whole
			// profile out for the presenter one.
			"6,3": { action: "ppt-take-control", name: "PPT Attendee: Take Control" },
			"7,3": { action: "ppt-high-contrast", name: "PPT Live: High Contrast" }
		}
	},
	{
		name: "PowerPoint Live (Presenter)",
		device: XL,
		uuid: "2C5E708F-A36B-4142-9FC3-40918EBD623A",
		layoutHash: "bf8300b2",
		page: "a1b2c3d4-0033-4e85-a0b7-2f6c1e5d8a34",
		/*
			The + XL presenter with a column taken away, which is one key more
			than its bottom row can hold. The eraser is what moves: it sits
			directly above the highlighter, at the end of the row the rest of
			its group could not reach.

			Stop Presenting is kept two rows clear of Leave. They are the two
			keys that end something, and they should not be neighbours.
		*/
		layout: {
			...meetingBlock(7),

			"3,1": { action: "ppt-layout-content", name: "PPT Presenter: Content Only" },
			"4,1": { action: "ppt-layout-cameo", name: "PPT Presenter: Layout Cameo" },
			"5,1": { action: "ppt-refresh", name: "PPT Presenter: Present Latest" },
			"6,1": { action: "ppt-private-view", name: "PPT Presenter: Private Viewing" },
			"7,1": { action: "ppt-copy-link", name: "PPT Presenter: Copy Link" },

			"5,2": { action: "ppt-hide-presenter-view", name: "PPT Presenter: Presenter View" },
			"6,2": { action: "ppt-stop-presenting", name: "PPT Presenter: Stop Presenting" },
			"7,2": { action: "ppt-eraser", name: "PPT Presenter: Eraser" },

			...slideNav(3),
			"3,3": { action: "ppt-grid", name: "PPT Live: Grid View" },
			"4,3": { action: "ppt-cursor", name: "PPT Presenter: Cursor" },
			"5,3": { action: "ppt-laser", name: "PPT Presenter: Laser Pointer" },
			"6,3": { action: "ppt-pen", name: "PPT Presenter: Pen" },
			"7,3": { action: "ppt-highlighter", name: "PPT Presenter: Highlighter" }
		}
	},
	/* --------------------------------------------------------------------- *
	 * Stream Deck + - 4x2 and four dials
	 * --------------------------------------------------------------------- */
	{
		name: "Teams Meeting",
		device: PLUS,
		uuid: "3D6F819A-B47C-4253-80D4-51A29FCE734B",
		layoutHash: "dbb127c0",
		page: "a1b2c3d4-0041-4e85-a0b7-2f6c1e5d8a34",
		dials: { ...TIMER_DIAL },
		layout: { ...EIGHT_MEETING }
	},
	{
		name: "PowerPoint Live (Attendee)",
		device: PLUS,
		uuid: "4E7092AB-C58D-4364-91E5-62B3A0DF845C",
		layoutHash: "5a646598",
		page: "a1b2c3d4-0042-4e85-a0b7-2f6c1e5d8a34",
		dials: { ...TIMER_DIAL },
		layout: { ...EIGHT_ATTENDEE }
	},
	{
		name: "PowerPoint Live (Presenter)",
		device: PLUS,
		uuid: "5F81A3BC-D69E-4475-82F6-73C4B1E0956D",
		layoutHash: "0b6bd091",
		page: "a1b2c3d4-0043-4e85-a0b7-2f6c1e5d8a34",
		/*
			Four dials and five things that want one, so the timer is the one
			left out here - it keeps its dial on this deck's other two
			profiles. Cutting a thumbnail or an ink control instead would have
			left a pair half-present: the two slides read as one picture of
			where you are, and thickness without color is an odd thing to own.
		*/
		dials: {
			"0,0": { action: "ppt-slide-current", name: "PPT Live: Current Slide" },
			"1,0": { action: "ppt-slide-next", name: "PPT Live: Next Slide" },
			"2,0": { action: "ppt-ink-thickness-dial", name: "PPT Presenter: Ink Thickness" },
			"3,0": { action: "ppt-ink-color-dial", name: "PPT Presenter: Ink Color" }
		},
		layout: { ...EIGHT_PRESENTER }
	},

	/* --------------------------------------------------------------------- *
	 * Stream Deck Neo - 4x2
	 *
	 * The same three layouts as the +, which has the same grid. Its window is
	 * informational and its two sensors are page navigation, so neither is a
	 * slot a profile can fill.
	 * --------------------------------------------------------------------- */
	{
		name: "Teams Meeting",
		device: NEO,
		uuid: "6092B4CD-E7AF-4586-93A7-84D5C2F1A67E",
		layoutHash: "83711e6c",
		page: "a1b2c3d4-0051-4e85-a0b7-2f6c1e5d8a34",
		layout: { ...EIGHT_MEETING }
	},
	{
		name: "PowerPoint Live (Attendee)",
		device: NEO,
		uuid: "71A3C5DE-F8B0-4697-84B8-95E6D302B78F",
		layoutHash: "5f085bd4",
		page: "a1b2c3d4-0052-4e85-a0b7-2f6c1e5d8a34",
		layout: { ...EIGHT_ATTENDEE }
	},
	{
		name: "PowerPoint Live (Presenter)",
		device: NEO,
		uuid: "82B4D6EF-09C1-47A8-95C9-A6F7E413C890",
		layoutHash: "0644f73d",
		page: "a1b2c3d4-0053-4e85-a0b7-2f6c1e5d8a34",
		layout: { ...EIGHT_PRESENTER }
	}
];

/** Stable per-key id, so rebuilding does not churn the file. */
function actionId(profile: string, position: string, controller: string): string {
	// Keypad is unqualified so the ids already installed for the 15-key deck
	// keep hashing to the same value. A dial has to be qualified, or a key and
	// a dial sharing coordinates - "2,0" is both - would collide.
	const seed = controller === "Keypad" ? `${profile}:${position}` : `${profile}:${controller}:${position}`;
	const h = createHash("sha1").update(seed).digest("hex");
	return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `a${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
}

/** Every profile needs an empty page to fall back to; Stream Deck writes one. */
const emptyPage = (device: Device) => ({ Controllers: controllers(null, null, device), Icon: "", Name: "" });

/**
 * The controller list for one page.
 *
 * A deck with dials carries an Encoder controller even when the plugin puts
 * nothing on them, because that is what Stream Deck writes for a page with no
 * dial actions - and a profile that is almost right installs and then quietly
 * does nothing.
 */
function controllers(
	keys: Record<string, object> | null,
	dials: Record<string, object> | null,
	device: Device
): object[] {
	const list: object[] = [{ Actions: keys, Type: "Keypad" }];
	if (device.encoders > 0) list.push({ Actions: dials, Type: "Encoder" });
	return list;
}

/** One controller's worth of placed actions, checked against the deck's shape. */
function place(layout: Layout, title: string, controller: string, limit: (c: number, r: number) => string | null) {
	const actions: Record<string, object> = {};

	for (const [position, key] of Object.entries(layout)) {
		const [col, row] = position.split(",").map(Number);
		const complaint = limit(col, row);
		if (complaint) throw new Error(`${title}: ${position} ${complaint}`);

		const owner = key.plugin ?? { name: PLUGIN_NAME, uuid: PLUGIN_UUID };

		actions[position] = {
			ActionID: actionId(title, position, controller),
			LinkedTitle: true,
			Name: key.name,
			Plugin: { Name: owner.name, UUID: owner.uuid },
			Resources: null,
			Settings: key.settings ?? {},
			State: 0,
			// The plugin paints every key itself, so no title is drawn over it.
			States: [
				{
					FontFamily: "",
					FontSize: 9,
					FontStyle: "",
					FontUnderline: false,
					OutlineThickness: 2,
					ShowTitle: false,
					TitleAlignment: "bottom",
					TitleColor: "#ffffff"
				}
			],
			UUID: key.plugin ? key.action : `${PLUGIN_UUID}.${key.action}`
		};
	}

	return Object.keys(actions).length > 0 ? actions : null;
}

const outDir = path.join(PLUGIN_DIR, "profiles");

/** What the manifest will declare, collected as each profile is written. */
const registered: object[] = [];

/** Profiles whose layout moved without the revision being bumped. */
const drifted: string[] = [];

/** Profiles with no fingerprint recorded yet, so one can be pasted in. */
const unrecorded: string[] = [];

/** Fixed timestamp for every zip entry, so a rebuild is byte-for-byte stable. */
const EPOCH = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const profile of PROFILES) {
	const device = profile.device;
	// The 15-key files shipped before there was a second deck, so its suffix is
	// empty and its ids keep hashing to exactly what is already installed.
	const title = `${profile.name}${device.suffix}`;
	/*
		A revision has to change the path, because that is the only thing Stream
		Deck treats as new. It changes the displayed name too: without that the
		new profile lands beside the old one under the same name, and Stream
		Deck disambiguates them itself as "copy", "copy 1", "copy 2" - which
		tells the user nothing about which is current or which is safe to
		delete.
	*/
	const file = (profile.revision ?? 1) > 1 ? `${title} r${profile.revision}` : title;
	const defaultPage = `${profile.page.slice(0, -1)}f`;

	const actions = place(profile.layout, title, "Keypad", (c, r) =>
		c >= device.columns || r >= device.rows ? `is off a ${device.columns}x${device.rows} deck` : null
	);

	const dials = place(profile.dials ?? {}, title, "Encoder", (c, r) =>
		// Dials are a single row; Stream Deck always addresses them at row 0.
		c >= device.encoders || r !== 0 ? `is not one of ${device.encoders} dials` : null
	);

	const root = {
		Device: {
			Model: device.model,
			// Blank so it installs against whichever matching device is attached.
			UUID: ""
		},
		InstalledByPluginUUID: PLUGIN_UUID,
		Name: file,
		Pages: { Current: profile.page, Default: defaultPage, Pages: [profile.page] },
		PreconfiguredName: file,
		Version: "3.0"
	};

	const staging = path.join(ROOT, "node_modules", ".cache", "sdprofile", profile.uuid);
	rmSync(staging, { recursive: true, force: true });

	const profileDir = path.join(staging, `${profile.uuid}.sdProfile`);
	// Uppercase page directories with lowercase references, exactly as Stream
	// Deck writes them.
	const pageDir = path.join(profileDir, "Profiles", profile.page.toUpperCase());
	const defaultDir = path.join(profileDir, "Profiles", defaultPage.toUpperCase());
	mkdirSync(path.join(pageDir, "Images"), { recursive: true });
	mkdirSync(path.join(defaultDir, "Images"), { recursive: true });

	writeFileSync(path.join(profileDir, "manifest.json"), JSON.stringify(root), "utf8");
	writeFileSync(
		path.join(pageDir, "manifest.json"),
		JSON.stringify({ Controllers: controllers(actions, dials, device), Icon: "", Name: "" }),
		"utf8"
	);
	writeFileSync(path.join(defaultDir, "manifest.json"), JSON.stringify(emptyPage(device)), "utf8");

	const out = path.join(outDir, `${file}.streamDeckProfile`);
	const zip = new AdmZip();
	zip.addLocalFolder(profileDir, `${profile.uuid}.sdProfile`);

	// A ZIP records each entry's modification time, so rebuilding an unchanged
	// profile still produces different bytes and git reports six files touched
	// when nothing about them moved. These are generated artefacts committed to
	// the repository, so that noise hides the one file that did change. Pinning
	// the time makes the build reproducible; Stream Deck reads the contents and
	// does not care what it says.
	for (const entry of zip.getEntries()) entry.header.time = EPOCH;

	zip.writeZip(out);
	rmSync(staging, { recursive: true, force: true });

	const dialCount = Object.keys(profile.dials ?? {}).length;
	console.log(
		`${path.relative(ROOT, out)}  (${Object.keys(profile.layout).length} keys` +
			`${dialCount ? `, ${dialCount} dials` : ""})`
	);

	registered.push({
		Name: `profiles/${file}`,
		DeviceType: device.deviceType,
		Readonly: false,
		DontAutoSwitchWhenInstalled: true
	});

	const fingerprint = layoutFingerprint(profile);
	if (profile.layoutHash === undefined) unrecorded.push(`  ${title}: layoutHash: "${fingerprint}"`);
	else if (profile.layoutHash !== fingerprint) {
		/*
			Two different situations, and only one of them wants a revision.

			A layout that has never shipped can be edited freely - record the
			new fingerprint and move on. A layout that users already have can
			only be replaced by changing its path, and that costs them a second
			profile in their list forever, because a plugin cannot remove one.

			Saying only "bump the revision" is what turned four edits in one
			session into four profiles on a deck.
		*/
		drifted.push(
			`  ${title}\n` +
				`      layout no longer matches layoutHash: "${profile.layoutHash}"\n\n` +
				`      If this layout has NOT shipped yet, just record the new one:\n` +
				`          layoutHash: "${fingerprint}"\n\n` +
				`      If users already have it, they can only be moved by shipping a\n` +
				`      new path, which leaves their old copy behind for good:\n` +
				`          revision: ${(profile.revision ?? 1) + 1}, layoutHash: "${fingerprint}"`
		);
	}
}

rmSync(path.join(ROOT, "node_modules", ".cache", "sdprofile"), { recursive: true, force: true });

/*
	The manifest's list is written from the same source that built the files,
	rather than kept in step by hand. The path in the manifest is the profile's
	identity to Stream Deck, and a path that names a file which is not there
	installs nothing and says nothing - so the two must not be able to disagree.
*/
const manifestPath = path.join(PLUGIN_DIR, "manifest.json");
const raw = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw) as { Profiles: unknown[] };

const before = JSON.stringify(manifest.Profiles);
manifest.Profiles = registered;

if (JSON.stringify(registered) !== before) {
	// Tabs and whatever ending the file already has, matching order-actions.ts.
	writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + (raw.endsWith("\n") ? "\n" : ""), "utf8");
	console.log(`\nmanifest.json: ${registered.length} profiles registered`);
}

/*
	The same list, emitted for the bundle to carry.

	The plugin needs to know which profile path shipped, and used to read it
	back out of manifest.json at runtime. Elgato's DRM makes the manifest a
	protected asset and says outright not to read it at run time - so on a
	Marketplace build that read fails, the list comes back empty, and profile
	switching stops without an error anyone sees. Their own guidance is to
	embed the data instead, which is what this is.
*/
const generated = path.join(ROOT, "src", "profiles.generated.json");
writeFileSync(
	generated,
	`${JSON.stringify(
		{
			$comment: [
				"GENERATED FILE - do not edit. Run: node tools/build-profile.ts",
				"",
				"The profiles manifest.json declares, embedded so the plugin never has",
				"to read the manifest at runtime - DRM protects it, and the failure is",
				"silent. tests/profiles.test.ts fails if this and the manifest disagree."
			],
			profiles: registered
		},
		null,
		"\t"
	)}\n`,
	"utf8"
);
console.log(`src/profiles.generated.json: ${registered.length} profiles embedded`);

if (unrecorded.length) {
	console.log(`\n${unrecorded.length} profile(s) have no layoutHash recorded. Add:`);
	for (const line of unrecorded) console.log(line);
}

if (drifted.length) {
	console.error(
		`\n${drifted.length} profile(s) no longer match their recorded layout.\n\n` +
			`Stream Deck installs a bundled profile once and identifies it by its path,\n` +
			`so a changed layout under the same path reaches nobody who already has it -\n` +
			`and a changed path arrives as an extra profile rather than replacing the old\n` +
			`one. Which of those you want depends on whether the layout has shipped.\n\n` +
			drifted.join("\n\n")
	);
	process.exit(1);
}
