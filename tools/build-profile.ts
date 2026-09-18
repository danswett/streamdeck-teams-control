/**
 * Builds the three bundled Stream Deck profiles the plugin switches between.
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

/** Stream Deck MK.2 / standard 15-key. Matches manifest DeviceType 0. */
const DEVICE_MODEL = "20GBA9901";

type Key = { action: string; name: string; settings?: object };
type Profile = { name: string; uuid: string; page: string; layout: Record<string, Key> };

/**
 * Fixed rather than random: regenerating must not orphan the copy Stream Deck
 * has already installed, and stable ids keep the build reproducible.
 */
const PROFILES: Profile[] = [
	{
		name: "Teams Meeting",
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
			"3,2": { action: "ppt-private-view", name: "PPT Presenter: Private View" },
			"4,2": {
				action: "ppt-stop-presenting",
				name: "PPT Presenter: Stop Presenting"
			}
		}
	}
];

/** Stable per-key id, so rebuilding does not churn the file. */
function actionId(profile: string, position: string): string {
	const h = createHash("sha1").update(`${profile}:${position}`).digest("hex");
	return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `a${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
}

/** Every profile needs an empty page to fall back to; Stream Deck writes one. */
const emptyPage = () => ({ Controllers: [{ Actions: null, Type: "Keypad" }], Icon: "", Name: "" });

const outDir = path.join(PLUGIN_DIR, "profiles");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const profile of PROFILES) {
	const defaultPage = `${profile.page.slice(0, -1)}f`;

	const actions: Record<string, object> = {};
	for (const [position, key] of Object.entries(profile.layout)) {
		actions[position] = {
			ActionID: actionId(profile.name, position),
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

	const root = {
		Device: {
			Model: DEVICE_MODEL,
			// Blank so it installs against whichever matching device is attached.
			UUID: ""
		},
		InstalledByPluginUUID: PLUGIN_UUID,
		Name: profile.name,
		Pages: { Current: profile.page, Default: defaultPage, Pages: [profile.page] },
		PreconfiguredName: profile.name,
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
		JSON.stringify({ Controllers: [{ Actions: actions, Type: "Keypad" }], Icon: "", Name: "" }),
		"utf8"
	);
	writeFileSync(path.join(defaultDir, "manifest.json"), JSON.stringify(emptyPage()), "utf8");

	const out = path.join(outDir, `${profile.name}.streamDeckProfile`);
	const zip = new AdmZip();
	zip.addLocalFolder(profileDir, `${profile.uuid}.sdProfile`);
	zip.writeZip(out);
	rmSync(staging, { recursive: true, force: true });

	console.log(`${path.relative(ROOT, out)}  (${Object.keys(profile.layout).length} keys)`);
}

rmSync(path.join(ROOT, "node_modules", ".cache", "sdprofile"), { recursive: true, force: true });
