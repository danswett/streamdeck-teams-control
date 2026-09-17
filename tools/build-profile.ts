/**
 * Builds the bundled "PowerPoint Live" Stream Deck profile.
 *
 * A plugin may only switch to a profile it ships itself — the SDK cannot touch
 * user-defined profiles — so the layout the plugin switches to has to be built
 * here rather than made by hand in the Stream Deck app.
 *
 * A .streamDeckProfile is a ZIP whose root holds one `<UUID>.sdProfile` folder:
 *
 *   <UUID>.sdProfile/
 *     manifest.json            device, name and the list of pages
 *     Profiles/<PAGE-ID>/
 *       manifest.json          one "Controllers" entry holding the key grid
 *
 * Verified against the profiles Stream Deck 7.4.2 has on this machine, and
 * against Elgato's own bundled Volume Controller profile.
 *
 * Run with: node tools/build-profile.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin");
const PLUGIN_UUID = "com.bad-duck.teamscontrol";

/** Stream Deck MK.2 / standard 15-key. Matches manifest DeviceType 0. */
const DEVICE_MODEL = "20GBA9901";

/**
 * Fixed rather than random: regenerating the profile must not orphan the copy
 * Stream Deck already installed, and a stable id keeps the build reproducible.
 */
const PROFILE_UUID = "7B1C4F2A-9D63-4E58-B0A7-2F6C1E5D8A34";
const PAGE_ID = "c4f2a7b1-6d39-4e85-a0b7-2f6c1e5d8a34";

const PROFILE_NAME = "PowerPoint Live";

/**
 * The key grid, "column,row" with the origin top-left, matching how Stream Deck
 * stores its own profiles.
 *
 * Laid out to serve BOTH PowerPoint Live roles from one page, because taking
 * control turns an attendee into the presenter mid-session and a profile that
 * only suited one role would be half-dead the moment that happened. Every key
 * reports its own availability, so the attendee sees navigation, sync and take
 * control live with the drawing tools dim, and the presenter sees the reverse.
 *
 * Slide navigation sits on the bottom row under the fingers; the counter and
 * the two keys that act on everyone — take control, stop presenting — are kept
 * apart from it.
 */
const LAYOUT: Record<string, { action: string; name: string; settings?: object }> = {
	"0,0": { action: "ppt-status", name: "PPT Live: Slide Counter" },
	"1,0": { action: "ppt-grid", name: "PPT Live: Grid View" },
	"2,0": { action: "ppt-sync", name: "PPT Live: Sync to Presenter" },
	"3,0": { action: "ppt-private-view", name: "PPT Live: Private View" },
	"4,0": { action: "ppt-popout", name: "PPT Live: Pop Out" },

	"0,1": { action: "ppt-laser", name: "PPT Live: Laser Pointer" },
	"1,1": { action: "ppt-pen", name: "PPT Live: Pen" },
	"2,1": { action: "ppt-highlighter", name: "PPT Live: Highlighter" },
	"3,1": { action: "ppt-eraser", name: "PPT Live: Eraser" },
	"4,1": { action: "ppt-cursor", name: "PPT Live: Cursor" },

	"0,2": { action: "ppt-prev", name: "PPT Live: Previous Slide" },
	"1,2": { action: "ppt-next", name: "PPT Live: Next Slide" },
	// The meeting basics stay reachable, so switching profiles mid-presentation
	// does not cost you the mute key.
	"2,2": { action: "mute", name: "Mute" },
	"3,2": { action: "ppt-take-control", name: "PPT Live: Take Control" },
	// Sits next to Take control deliberately: the two are never live at the same
	// time, so this corner reads as "change who is driving" in either role.
	"4,2": {
		action: "ppt-stop-presenting",
		name: "PPT Live: Stop Presenting",
		settings: { requireHold: true }
	}
};

const rootManifest = {
	Device: {
		Model: DEVICE_MODEL,
		// Blank so the profile installs against whichever device is attached.
		UUID: ""
	},
	InstalledByPluginUUID: PLUGIN_UUID,
	Name: PROFILE_NAME,
	Pages: {
		Current: PAGE_ID,
		Pages: [PAGE_ID]
	},
	PreconfiguredName: PROFILE_NAME,
	Version: "2.0"
};

const actions: Record<string, object> = {};
for (const [position, { action, name, settings }] of Object.entries(LAYOUT)) {
	actions[position] = {
		Name: name,
		Settings: settings ?? {},
		State: 0,
		// The plugin paints every key itself, so no title is drawn over the top.
		States: [{ FontSize: 9, ShowTitle: false, TitleAlignment: "bottom", TitleColor: "#ffffff" }],
		UUID: `${PLUGIN_UUID}.${action}`
	};
}

const pageManifest = {
	Controllers: [{ Actions: actions, Type: "Keypad" }],
	Icon: "",
	Name: ""
};

const staging = path.join(ROOT, "node_modules", ".cache", "sdprofile");
rmSync(staging, { recursive: true, force: true });

const profileDir = path.join(staging, `${PROFILE_UUID}.sdProfile`);
const pageDir = path.join(profileDir, "Profiles", PAGE_ID);
mkdirSync(path.join(pageDir, "Images"), { recursive: true });

writeFileSync(path.join(profileDir, "manifest.json"), JSON.stringify(rootManifest, null, 2), "utf8");
writeFileSync(path.join(pageDir, "manifest.json"), JSON.stringify(pageManifest, null, 2), "utf8");

const outDir = path.join(PLUGIN_DIR, "profiles");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${PROFILE_NAME}.streamDeckProfile`);

const zip = new AdmZip();
zip.addLocalFolder(profileDir, `${PROFILE_UUID}.sdProfile`);
zip.writeZip(out);
rmSync(staging, { recursive: true, force: true });

console.log(`Wrote ${path.relative(ROOT, out)}`);
for (const entry of new AdmZip(out).getEntries()) console.log(`  ${entry.entryName}`);
