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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin");
const PLUGIN_UUID = "com.bad-duck.teamscontrol";
const PLUGIN_NAME = "Teams Meeting Controls";

type Key = { action: string; name: string; settings?: object };
type Layout = Record<string, Key>;

type Device = {
	/** Value for the manifest's `Profiles[].DeviceType`. */
	deviceType: number;
	/**
	 * `Device.Model` in the profile, which is how Stream Deck decides the
	 * profile belongs to the deck in front of it. Read off the profiles Stream
	 * Deck and Elgato's own plugins write, not guessed: the names are close
	 * enough to swap by accident - 20GAT9901 is the XL, 20GBX9901 the + XL.
	 */
	model: string;
	columns: number;
	rows: number;
	/** Dials, which need a second controller in every page. Zero if it has none. */
	encoders: number;
	/**
	 * Appended to the profile and file name so one plugin can ship a layout per
	 * deck. Empty for the 15-key, whose files shipped before there was a second
	 * device and must keep the names Stream Deck already installed.
	 */
	suffix: string;
};

/** Stream Deck MK.2 / standard 15-key. Matches manifest DeviceType 0. */
const STREAM_DECK: Device = {
	deviceType: 0,
	model: "20GBA9901",
	columns: 5,
	rows: 3,
	encoders: 0,
	suffix: ""
};

/** Stream Deck + XL: 36 keys in a 9x4 grid, plus six dials. Manifest DeviceType 13. */
const PLUS_XL: Device = {
	deviceType: 13,
	model: "20GBX9901",
	columns: 9,
	rows: 4,
	encoders: 6,
	suffix: " (+ XL)"
};

type Profile = {
	name: string;
	device: Device;
	uuid: string;
	page: string;
	layout: Layout;
	/** Dials, addressed "0,0".."N,0". Only meaningful on a deck that has them. */
	dials?: Layout;
};

/**
 * The meeting half of the + XL, identical in all three of its profiles.
 *
 * Nine columns is wide enough to stop treating a profile switch as a redraw of
 * the whole deck: the left four columns are the meeting and never move, so
 * mute is under the same finger whether or not anyone is presenting, and only
 * the right five columns change. Leave sits in the far corner, diagonally
 * opposite mute, because the two worst keys to confuse are those.
 */
const XL_MEETING: Layout = {
	"0,0": { action: "mute", name: "Mute" },
	"1,0": { action: "camera", name: "Camera" },
	"2,0": { action: "blur", name: "Background Blur" },
	"3,0": { action: "share", name: "Share Screen" },

	"0,1": { action: "hand", name: "Raise Hand" },
	"1,1": { action: "chat", name: "Chat" },
	"2,1": { action: "people", name: "People" },

	"0,2": { action: "react-like", name: "React: Like" },
	"1,2": { action: "react-love", name: "React: Love" },
	"2,2": { action: "react-applause", name: "React: Applause" },
	"3,2": { action: "react-laugh", name: "React: Laugh" },

	"0,3": { action: "react-wow", name: "React: Wow" },
	"3,3": { action: "leave", name: "Leave" }
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
		page: "a1b2c3d4-0002-4e85-a0b7-2f6c1e5d8a34",
		// Watching someone else's deck. Navigation moves your own view only, so
		// Sync sits directly under it to get back to the presenter.
		layout: {
			"0,0": { action: "ppt-prev", name: "PPT Live: Previous Slide" },
			"1,0": { action: "ppt-next", name: "PPT Live: Next Slide" },
			"2,0": { action: "ppt-status", name: "PPT Live: Slide Counter" },
			"3,0": { action: "ppt-grid", name: "PPT Live: Grid View" },
			"4,0": { action: "ppt-high-contrast", name: "PPT Live: High Contrast" },

			"0,1": { action: "ppt-sync", name: "PPT Attendee: Sync" },
			"1,1": { action: "ppt-popout", name: "PPT Live: Pop Out" },
			// Taking control makes you the presenter, which swaps this whole
			// profile out for the presenter one.
			"2,1": { action: "ppt-take-control", name: "PPT Attendee: Take Control" },
			"3,1": { action: "share", name: "Share Screen" },
			"4,1": { action: "blur", name: "Background Blur" },

			// The meeting basics stay reachable, so being moved onto a
			// presentation layout never costs you the mute key.
			"0,2": { action: "mute", name: "Mute" },
			"1,2": { action: "camera", name: "Camera" },
			"2,2": { action: "hand", name: "Raise Hand" },
			"3,2": { action: "chat", name: "Chat" },
			"4,2": { action: "leave", name: "Leave" }
		}
	},
	{
		name: "PowerPoint Live (Presenter)",
		device: STREAM_DECK,
		uuid: "3D6E8A4B-1C79-4F5B-9A32-5E9D4C8B7F06",
		page: "a1b2c3d4-0003-4e85-a0b7-2f6c1e5d8a34",
		// Driving the deck. The drawing tools get their own row because they are
		// a single-select group and read as one control.
		layout: {
			"0,0": { action: "ppt-prev", name: "PPT Live: Previous Slide" },
			"1,0": { action: "ppt-next", name: "PPT Live: Next Slide" },
			"2,0": { action: "ppt-status", name: "PPT Live: Slide Counter" },
			"3,0": { action: "ppt-grid", name: "PPT Live: Grid View" },
			"4,0": { action: "ppt-refresh", name: "PPT Presenter: Present Latest" },

			"0,1": { action: "ppt-cursor", name: "PPT Presenter: Cursor" },
			"1,1": { action: "ppt-laser", name: "PPT Presenter: Laser Pointer" },
			"2,1": { action: "ppt-pen", name: "PPT Presenter: Pen" },
			"3,1": { action: "ppt-highlighter", name: "PPT Presenter: Highlighter" },
			"4,1": { action: "ppt-eraser", name: "PPT Presenter: Eraser" },

			"0,2": { action: "mute", name: "Mute" },
			"1,2": { action: "camera", name: "Camera" },
			"2,2": { action: "ppt-hide-presenter-view", name: "PPT Presenter: Presenter View" },
			"3,2": { action: "ppt-private-view", name: "PPT Presenter: Private Viewing" },
			"4,2": {
				action: "ppt-stop-presenting",
				name: "PPT Presenter: Stop Presenting"
			}
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
		page: "a1b2c3d4-0011-4e85-a0b7-2f6c1e5d8a34",
		layout: { ...XL_MEETING }
	},
	{
		name: "PowerPoint Live (Attendee)",
		device: PLUS_XL,
		uuid: "5B8D0F2E-3C94-4A7B-9E56-7F2A1D4C8B63",
		page: "a1b2c3d4-0012-4e85-a0b7-2f6c1e5d8a34",
		layout: {
			...XL_MEETING,

			// Watching someone else's deck. Navigation moves your own view
			// only, so Sync sits directly under it to get back to the presenter.
			"4,0": { action: "ppt-status", name: "PPT Live: Slide Counter" },
			"5,0": { action: "ppt-prev", name: "PPT Live: Previous Slide" },
			"6,0": { action: "ppt-next", name: "PPT Live: Next Slide" },
			"7,0": { action: "ppt-grid", name: "PPT Live: Grid View" },
			"8,0": { action: "ppt-high-contrast", name: "PPT Live: High Contrast" },

			"4,1": { action: "ppt-sync", name: "PPT Attendee: Sync" },
			"5,1": { action: "ppt-popout", name: "PPT Live: Pop Out" },
			// Taking control makes you the presenter, which swaps this whole
			// profile out for the presenter one.
			"6,1": { action: "ppt-take-control", name: "PPT Attendee: Take Control" }
		}
	},
	{
		name: "PowerPoint Live (Presenter)",
		device: PLUS_XL,
		uuid: "6C9E1A3F-4D05-4B8C-8F67-8A3B2E5D9C74",
		page: "a1b2c3d4-0013-4e85-a0b7-2f6c1e5d8a34",
		dials: {
			"2,0": { action: "ppt-ink-thickness-dial", name: "PPT Presenter: Ink Thickness" },
			"3,0": { action: "ppt-ink-color-dial", name: "PPT Presenter: Ink Colour" }
		},
		layout: {
			...XL_MEETING,

			"4,0": { action: "ppt-status", name: "PPT Live: Slide Counter" },
			"5,0": { action: "ppt-prev", name: "PPT Live: Previous Slide" },
			"6,0": { action: "ppt-next", name: "PPT Live: Next Slide" },
			"7,0": { action: "ppt-grid", name: "PPT Live: Grid View" },
			"8,0": { action: "ppt-refresh", name: "PPT Presenter: Present Latest" },

			// All five drawing tools in one unbroken row. They are a
			// single-select group - picking one drops the last - so they should
			// read as one control rather than as five scattered keys, which is
			// the whole reason nine columns is worth having.
			"4,1": { action: "ppt-cursor", name: "PPT Presenter: Cursor" },
			"5,1": { action: "ppt-laser", name: "PPT Presenter: Laser Pointer" },
			"6,1": { action: "ppt-pen", name: "PPT Presenter: Pen" },
			"7,1": { action: "ppt-highlighter", name: "PPT Presenter: Highlighter" },
			"8,1": { action: "ppt-eraser", name: "PPT Presenter: Eraser" },

			"4,2": { action: "ppt-private-view", name: "PPT Presenter: Private Viewing" },
			"5,2": { action: "ppt-hide-presenter-view", name: "PPT Presenter: Presenter View" },
			"6,2": { action: "ppt-copy-link", name: "PPT Presenter: Copy Link" },
			"7,2": { action: "ppt-layout-content", name: "PPT Presenter: Content Only" },
			"8,2": { action: "ppt-layout-cameo", name: "PPT Presenter: Layout Cameo" },

			// Alone in the far corner. It ends the presentation for everyone,
			// and nothing else should be within a mis-tap of it.
			"8,3": {
				action: "ppt-stop-presenting",
				name: "PPT Presenter: Stop Presenting"
			}
		}
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

		actions[position] = {
			ActionID: actionId(title, position, controller),
			LinkedTitle: true,
			Name: key.name,
			Plugin: { Name: PLUGIN_NAME, UUID: PLUGIN_UUID },
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
			UUID: `${PLUGIN_UUID}.${key.action}`
		};
	}

	return Object.keys(actions).length > 0 ? actions : null;
}

const outDir = path.join(PLUGIN_DIR, "profiles");

/** Fixed timestamp for every zip entry, so a rebuild is byte-for-byte stable. */
const EPOCH = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const profile of PROFILES) {
	const device = profile.device;
	// The 15-key files shipped before there was a second deck, so its suffix is
	// empty and its ids keep hashing to exactly what is already installed.
	const title = `${profile.name}${device.suffix}`;
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
		Name: title,
		Pages: { Current: profile.page, Default: defaultPage, Pages: [profile.page] },
		PreconfiguredName: title,
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

	const out = path.join(outDir, `${title}.streamDeckProfile`);
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
}

rmSync(path.join(ROOT, "node_modules", ".cache", "sdprofile"), { recursive: true, force: true });
