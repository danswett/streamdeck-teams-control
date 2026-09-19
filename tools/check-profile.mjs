/**
 * Compares a generated profile against one Stream Deck wrote itself.
 *
 * A profile that is almost right installs and then does nothing, so this checks
 * the shape rather than trusting it: same keys at the root, same keys on an
 * action, and every page referenced actually present.
 *
 * The reference is found by device model rather than hard-coded, because the
 * plugin now ships a layout per deck and a 15-key profile is no reference at
 * all for a deck with dials. Pair the deck, let Stream Deck write its own
 * default profile for it, and this finds it.
 *
 * Run with: node tools/check-profile.mjs <file.streamDeckProfile>
 */
import AdmZip from "adm-zip";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PROFILES = path.join(process.env.APPDATA, "Elgato", "StreamDeck", "ProfilesV3");

const ours = process.argv[2];
if (!ours) {
	console.error("usage: node tools/check-profile.mjs <file.streamDeckProfile>");
	process.exit(1);
}

const zip = new AdmZip(ours);
const entries = zip.getEntries();

const rootEntry = entries.find((e) => e.entryName.endsWith(".sdProfile/manifest.json"));
const root = JSON.parse(rootEntry.getData().toString("utf8"));

console.log(`=== ${path.basename(ours)} ===`);
console.log(`  device model ${root.Device.Model}`);

/** A profile Stream Deck wrote for the same deck, with a page that holds keys. */
function reference(model) {
	if (!existsSync(PROFILES)) return null;

	for (const dir of readdirSync(PROFILES)) {
		const base = path.join(PROFILES, dir);
		const manifest = path.join(base, "manifest.json");
		if (!existsSync(manifest)) continue;

		let m;
		try {
			m = JSON.parse(readFileSync(manifest, "utf8"));
		} catch {
			continue;
		}
		// Ours are written by this repo, so they prove nothing about the format.
		if (m.Device?.Model !== model || m.InstalledByPluginUUID) continue;

		for (const page of m.Pages?.Pages ?? []) {
			const file = path.join(base, "Profiles", page.toUpperCase(), "manifest.json");
			if (!existsSync(file)) continue;

			const p = JSON.parse(readFileSync(file, "utf8"));
			const keypad = (p.Controllers ?? []).find((c) => c.Type === "Keypad" && c.Actions);
			if (keypad) return { name: m.Name, root: m, page: p, action: Object.values(keypad.Actions)[0] };
		}
	}
	return null;
}

const ourPageEntry = entries.find(
	(e) =>
		e.entryName.includes("/Profiles/") &&
		e.entryName.endsWith("manifest.json") &&
		e.getData().toString("utf8").includes("teamscontrol.")
);
const ourPage = JSON.parse(ourPageEntry.getData().toString("utf8"));
const ourKeypad = ourPage.Controllers.find((c) => c.Type === "Keypad");
const ourAction = Object.values(ourKeypad.Actions)[0];

const ref = reference(root.Device.Model);
if (!ref) {
	console.log(`  no profile for ${root.Device.Model} on this machine; checking internal consistency only`);
} else {
	console.log(`  compared against Stream Deck's own "${ref.name}"`);

	const missing = Object.keys(ref.root).filter((k) => !(k in root));
	console.log(`root keys missing vs Stream Deck's own: ${missing.length ? missing.join(", ") : "none"}`);
	console.log(`  Version ours=${root.Version} theirs=${ref.root.Version}`);

	const missingAction = Object.keys(ref.action).filter((k) => !(k in ourAction));
	const extraAction = Object.keys(ourAction).filter((k) => !(k in ref.action));
	console.log(`action keys missing: ${missingAction.length ? missingAction.join(", ") : "none"}`);
	console.log(`action keys extra  : ${extraAction.length ? extraAction.join(", ") : "none"}`);

	const missingState = Object.keys(ref.action.States[0]).filter((k) => !(k in ourAction.States[0]));
	console.log(`state keys missing : ${missingState.length ? missingState.join(", ") : "none"}`);

	// A deck with dials gets an Encoder controller in every page, even an empty
	// one. Order is not significant - Stream Deck and Elgato's own plugins
	// disagree about it - but presence is.
	const theirTypes = new Set(ref.page.Controllers.map((c) => c.Type));
	const ourTypes = new Set(ourPage.Controllers.map((c) => c.Type));
	const missingTypes = [...theirTypes].filter((t) => !ourTypes.has(t));
	console.log(`controllers missing: ${missingTypes.length ? missingTypes.join(", ") : "none"}`);
}

// No key may sit outside the grid; one that does is a key nobody can press.
const cols = new Set();
const rows = new Set();
for (const pos of Object.keys(ourKeypad.Actions)) {
	const [c, r] = pos.split(",").map(Number);
	cols.add(c);
	rows.add(r);
}
console.log(`  ${Object.keys(ourKeypad.Actions).length} keys, columns 0-${Math.max(...cols)}, rows 0-${Math.max(...rows)}`);

// Every page the manifest points at must exist in the archive.
const pageIds = [...root.Pages.Pages, root.Pages.Default, root.Pages.Current];
for (const id of new Set(pageIds)) {
	const present = entries.some((e) =>
		e.entryName.toUpperCase().includes(`/PROFILES/${id.toUpperCase()}/MANIFEST.JSON`)
	);
	console.log(`  page ${id}: ${present ? "present" : "MISSING"}`);
}
