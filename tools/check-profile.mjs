/**
 * Compares a generated profile against one Stream Deck wrote itself.
 *
 * A profile that is almost right installs and then does nothing, so this checks
 * the shape rather than trusting it: same keys at the root, same keys on an
 * action, and every page referenced actually present.
 */
import AdmZip from "adm-zip";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REFERENCE = path.join(
	process.env.APPDATA,
	"Elgato/StreamDeck/ProfilesV3/2234D30A-6507-48CF-8612-A5512036A5CF.sdProfile"
);

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

if (!existsSync(REFERENCE)) {
	console.log("no reference profile on this machine; checking internal consistency only");
} else {
	const ref = JSON.parse(readFileSync(path.join(REFERENCE, "manifest.json"), "utf8"));
	const missing = Object.keys(ref).filter((k) => !(k in root));
	console.log(`root keys missing vs Stream Deck's own: ${missing.length ? missing.join(", ") : "none"}`);
	console.log(`  Version ours=${root.Version} theirs=${ref.Version}`);
	console.log(`  Device.Model ours=${root.Device.Model} theirs=${ref.Device.Model}`);

	// Compare the shape of one action against one of theirs.
	const refPageId = ref.Pages.Pages[0].toUpperCase();
	const refPage = JSON.parse(
		readFileSync(path.join(REFERENCE, "Profiles", refPageId, "manifest.json"), "utf8")
	);
	const refAction = Object.values(refPage.Controllers[0].Actions)[0];

	const ourPageEntry = entries.find(
		(e) =>
			e.entryName.includes("/Profiles/") &&
			e.entryName.endsWith("manifest.json") &&
			e.getData().toString("utf8").includes("teamscontrol.")
	);
	const ourAction = Object.values(
		JSON.parse(ourPageEntry.getData().toString("utf8")).Controllers[0].Actions
	)[0];

	const missingAction = Object.keys(refAction).filter((k) => !(k in ourAction));
	const extraAction = Object.keys(ourAction).filter((k) => !(k in refAction));
	console.log(`action keys missing: ${missingAction.length ? missingAction.join(", ") : "none"}`);
	console.log(`action keys extra  : ${extraAction.length ? extraAction.join(", ") : "none"}`);

	const refState = refAction.States[0];
	const ourState = ourAction.States[0];
	const missingState = Object.keys(refState).filter((k) => !(k in ourState));
	console.log(`state keys missing : ${missingState.length ? missingState.join(", ") : "none"}`);
}

// Every page the manifest points at must exist in the archive.
const pageIds = [...root.Pages.Pages, root.Pages.Default, root.Pages.Current];
for (const id of new Set(pageIds)) {
	const present = entries.some((e) =>
		e.entryName.toUpperCase().includes(`/PROFILES/${id.toUpperCase()}/MANIFEST.JSON`)
	);
	console.log(`  page ${id}: ${present ? "present" : "MISSING"}`);
}
