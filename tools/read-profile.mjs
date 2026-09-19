/**
 * Reads a profile back out of the Stream Deck app, as source for
 * tools/build-profile.ts.
 *
 * Laying keys out by dragging them around the app is far quicker than editing
 * coordinates by hand, but the app edits its own installed copy and the plugin
 * ships a generated one. This closes that loop: rearrange the profile in Stream
 * Deck, run this, and paste the result back into the builder.
 *
 * Stream Deck writes profile changes to disk as they are made, so nothing needs
 * to be restarted first - but check the reported modification time if the
 * output looks stale.
 *
 * Usage:
 *   node tools/read-profile.mjs                 # list what can be read
 *   node tools/read-profile.mjs "Presenter (+ XL)"
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_UUID = "com.bad-duck.teamscontrol";
const PROFILES = path.join(process.env.APPDATA, "Elgato", "StreamDeck", "ProfilesV3");

const manifest = JSON.parse(
	readFileSync(path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin", "manifest.json"), "utf8")
);

/** Action UUID -> the name the builder puts on a key. */
const NAMES = new Map(manifest.Actions.map((a) => [a.UUID, a.Name]));

function installed() {
	if (!existsSync(PROFILES)) return [];

	const out = [];
	for (const dir of readdirSync(PROFILES)) {
		const base = path.join(PROFILES, dir);
		const file = path.join(base, "manifest.json");
		if (!existsSync(file)) continue;

		let root;
		try {
			root = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (root.InstalledByPluginUUID !== PLUGIN_UUID) continue;

		out.push({ dir: base, name: root.Name, model: root.Device?.Model, pages: root.Pages?.Pages ?? [] });
	}
	return out;
}

/** The page holding this plugin's keys, and when it was last written. */
function readPage(profile) {
	for (const page of profile.pages) {
		const file = path.join(profile.dir, "Profiles", page.toUpperCase(), "manifest.json");
		if (!existsSync(file)) continue;

		const contents = readFileSync(file, "utf8");
		if (!contents.includes(PLUGIN_UUID)) continue;
		return { page: JSON.parse(contents), modified: statSync(file).mtime };
	}
	return null;
}

/** Emits one controller's placements as the builder's own source shape. */
function emit(actions, label) {
	if (!actions) return { lines: [], foreign: [] };

	const lines = [];
	const foreign = [];

	const placed = Object.entries(actions).sort(([a], [b]) => {
		const [ac, ar] = a.split(",").map(Number);
		const [bc, br] = b.split(",").map(Number);
		return ar - br || ac - bc;
	});

	let row = null;
	for (const [position, action] of placed) {
		const uuid = action.UUID ?? "";
		if (!uuid) {
			foreign.push(`${position} (no action)`);
			continue;
		}

		// A blank line between rows, the way the layouts are already written.
		const thisRow = Number(position.split(",")[1]);
		if (row !== null && thisRow !== row) lines.push("");
		row = thisRow;

		const own = uuid.startsWith(`${PLUGIN_UUID}.`);
		const key = own ? uuid.slice(PLUGIN_UUID.length + 1) : uuid;
		const name = (own ? NAMES.get(uuid) : null) ?? action.Name ?? key;
		const settings =
			action.Settings && Object.keys(action.Settings).length
				? `, settings: ${JSON.stringify(action.Settings)}`
				: "";

		// Another plugin's action is kept rather than dropped - a volume dial
		// that ships with the deck is a reasonable thing to put on a profile -
		// but it has to say who owns it, or the builder would claim it.
		const owner = own
			? ""
			: `, plugin: { name: ${JSON.stringify(action.Plugin?.Name ?? "")}, uuid: ${JSON.stringify(
					action.Plugin?.UUID ?? ""
				)} }`;
		if (!own) foreign.push(`${position} ${uuid}`);

		lines.push(`\t\t\t"${position}": { action: "${key}", name: "${name}"${settings}${owner} },`);
	}

	if (lines.length) {
		// The builder's own object literals have no trailing comma.
		const last = lines.length - 1;
		lines[last] = lines[last].replace(/,$/, "");
	}
	return { lines, foreign, label };
}

const wanted = process.argv[2];
const profiles = installed();

if (!profiles.length) {
	console.error("No profiles installed by this plugin were found. Switch to one first.");
	process.exit(1);
}

const matches = wanted
	? // An exact name wins outright, so a duplicate made in the app - "... copy"
		// - cannot make the profile it was copied from ambiguous.
		(profiles.filter((p) => p.name.toLowerCase() === wanted.toLowerCase()).length
			? profiles.filter((p) => p.name.toLowerCase() === wanted.toLowerCase())
			: profiles.filter((p) => p.name.toLowerCase().includes(wanted.toLowerCase())))
	: profiles;

if (!wanted || matches.length !== 1) {
	console.log(wanted ? `"${wanted}" matched ${matches.length}. Pick one:` : "Profiles this plugin installed:");
	for (const p of profiles) console.log(`  ${p.name}   [${p.model}]`);
	process.exit(wanted ? 1 : 0);
}

const profile = matches[0];
const found = readPage(profile);
if (!found) {
	console.error(`${profile.name}: no page holding this plugin's keys.`);
	process.exit(1);
}

console.log(`// ${profile.name}  [${profile.model}]`);
console.log(`// read ${found.modified.toLocaleString()}\n`);

const keypad = found.page.Controllers.find((c) => c.Type === "Keypad");
const encoder = found.page.Controllers.find((c) => c.Type === "Encoder");

const keys = emit(keypad?.Actions, "layout");
console.log("\t\tlayout: {");
for (const line of keys.lines) console.log(line);
console.log("\t\t}");

const dials = emit(encoder?.Actions, "dials");
if (dials.lines.length) {
	console.log("\t\tdials: {");
	for (const line of dials.lines) console.log(line);
	console.log("\t\t}");
}

const foreign = [...keys.foreign, ...dials.foreign];
if (foreign.length) {
	console.log(`\n// ${foreign.length} placement(s) belong to other plugins and are carried as-is.`);
	console.log("// They are dead keys for anyone without that plugin installed.");
	for (const f of foreign) console.log(`//   ${f}`);
}
