/*
 * Cross-checks the shipped plugin against everything that describes it.
 *
 * Written as a script rather than done by eye because the failures found today
 * were all of the same kind: a claim that was true once and quietly stopped
 * being true - a zoom key documented months after removal, an action list
 * grouped by role while the README still used the old prefix, a description
 * advertising 20 translation languages when 19 shipped.
 *
 * Run with: node tools/audit-docs.js
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin");

const problems = [];
const notes = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const note = (where, what) => notes.push(`${where}: ${what}`);

const read = (p) => readFileSync(p, "utf8");
const manifest = JSON.parse(read(path.join(PLUGIN, "manifest.json")));
const selectors = JSON.parse(read(path.join(PLUGIN, "selectors.json")));

const actions = manifest.Actions;
const uuids = actions.map((a) => a.UUID);

// ---------------------------------------------------------------- structure
console.log(`plugin ${manifest.Name} ${manifest.Version} - ${actions.length} actions\n`);

for (const a of actions) {
	if (!a.UUID.startsWith(manifest.UUID + ".")) fail(a.Name, `UUID is not under ${manifest.UUID}`);
	if (a.Name.length > 30) fail(a.Name, `name is ${a.Name.length} characters, guideline is ~30`);

	// Icons are referenced without an extension.
	for (const [label, ref] of [["Icon", a.Icon], ...(a.States ?? []).map((s, i) => [`State ${i} image`, s.Image])]) {
		if (!ref) continue;
		const hit = [".svg", ".png"].some((ext) => existsSync(path.join(PLUGIN, ref + ext)));
		if (!hit) fail(a.Name, `${label} "${ref}" resolves to no file`);
	}

	if (a.PropertyInspectorPath && !existsSync(path.join(PLUGIN, a.PropertyInspectorPath)))
		fail(a.Name, `inspector "${a.PropertyInspectorPath}" is missing`);
}

// Orphaned artwork: a folder per action, left behind when one is withdrawn.
const artDir = path.join(PLUGIN, "imgs", "actions");
const expectedArt = new Set(actions.map((a) => a.UUID.split(".").pop()));
for (const dir of readdirSync(artDir)) {
	if (!statSync(path.join(artDir, dir)).isDirectory()) continue;
	if (!expectedArt.has(dir)) fail("imgs/actions", `${dir}/ has no action`);
}

// Orphaned inspectors. The manifest also declares a plugin-level inspector,
// used by every action that does not name its own - twelve of them do not.
const uiDir = path.join(PLUGIN, "ui");
const usedInspectors = new Set(
	[manifest.PropertyInspectorPath, ...actions.map((a) => a.PropertyInspectorPath)]
		.filter(Boolean)
		.map((p) => path.basename(p))
);
if (manifest.PropertyInspectorPath && !existsSync(path.join(PLUGIN, manifest.PropertyInspectorPath)))
	fail("manifest", `plugin inspector "${manifest.PropertyInspectorPath}" is missing`);
const support = new Set(["inspector.css", "action-descriptions.js", "sdpi-components.js"]);
for (const f of readdirSync(uiDir)) {
	if (!f.endsWith(".html")) continue;
	if (!usedInspectors.has(f)) fail("ui", `${f} is not used by any action`);
}
for (const f of readdirSync(uiDir)) {
	if (f.endsWith(".html") || support.has(f)) continue;
	note("ui", `${f} is neither an inspector nor a known support file`);
}

// ------------------------------------------------------------- descriptions
const descSrc = read(path.join(uiDir, "action-descriptions.js"));
const described = [...descSrc.matchAll(/"(com\.bad-duck\.teamscontrol\.[\w-]+)"\s*:/g)].map((m) => m[1]);
for (const u of uuids) if (!described.includes(u)) fail("action-descriptions", `${u} has no description`);
for (const d of described) if (!uuids.includes(d)) fail("action-descriptions", `${d} describes nothing`);

// ----------------------------------------------------------------- controls
const controlKeys = Object.keys(selectors.controls ?? {});
note("selectors.json", `${controlKeys.length} controls`);

// ------------------------------------------------------------------ profiles
for (const p of manifest.Profiles ?? []) {
	const file = path.join(PLUGIN, p.Name + ".streamDeckProfile");
	if (!existsSync(file)) fail("profiles", `${p.Name} is declared but the file is missing`);
}

// ------------------------------------------------------------- stale claims
// Anything withdrawn. A doc naming one of these is describing a key that is
// not there any more.
//
// Matched narrowly on purpose. "translating" about localisation and a note
// explaining that the copy must not mention a withdrawn key are both fine; it
// is the feature being offered that is not.
const withdrawn = [
	["zoom", /\bzoom(ing)?\b(?!\s+(controls are shared|in a browser))/i],
	["slide translation", /translate (the )?slides?|translation languages|\d+ languages/i],
	["Ask Copilot", /ask copilot/i],
	["press-and-hold to stop presenting", /press[- ]and[- ]hold[^.]{0,40}stop/i],
	["old Private View name", /PPT (Live|Presenter): Private View\b(?!ing)/]
];

/**
 * The listing copy is what reaches a customer, so it is checked strictly - but
 * only the copy. The prose around it explains the rules and is allowed to name
 * the things the rules forbid.
 */
function fencedBlocks(text) {
	const out = [];
	let inFence = false;
	let buf = [];
	for (const line of text.split(/\r?\n/)) {
		if (/^```/.test(line)) {
			if (inFence) out.push(buf.join("\n"));
			inFence = !inFence;
			buf = [];
			continue;
		}
		if (inFence) buf.push(line);
	}
	return out;
}

const docs = [
	["README.md", path.join(ROOT, "README.md")],
	["marketplace/README.md", path.join(ROOT, "marketplace", "README.md")],
	["ui/action-descriptions.js", path.join(uiDir, "action-descriptions.js")],
	["manifest.json", path.join(PLUGIN, "manifest.json")],
	["selectors.json", path.join(PLUGIN, "selectors.json")]
];
for (const f of readdirSync(uiDir)) if (f.endsWith(".html")) docs.push([`ui/${f}`, path.join(uiDir, f)]);

for (const [label, file] of docs) {
	const text = read(file);
	// For the submission file only the copy blocks are the product's claims.
	const subject = label === "marketplace/README.md" ? fencedBlocks(text).join("\n") : text;

	for (const [name, rx] of withdrawn) {
		const m = rx.exec(subject);
		if (m) {
			const line = subject.slice(0, m.index).split("\n").length;
			fail(label, `${label === "marketplace/README.md" ? "listing copy" : `line ${line}`} still offers ${name}: "${m[0]}"`);
		}
	}
	// Mojibake: UTF-8 read as CP1252 and re-encoded.
	const mojibake = /â€|Ã©|Â /.exec(text);
	if (mojibake) {
		const line = text.slice(0, mojibake.index).split("\n").length;
		fail(label, `line ${line} has mangled encoding: ${JSON.stringify(mojibake[0])}`);
	}
}

// Action names quoted in prose must exist.
const readme = read(path.join(ROOT, "README.md"));
const names = new Set(actions.map((a) => a.Name));
for (const m of readme.matchAll(/\*\*(PPT (?:Live|Attendee|Presenter): [^*]+)\*\*/g)) {
	const claimed = m[1];
	// Rows may cover several keys at once ("Previous / Next Slide").
	if (names.has(claimed)) continue;
	const parts = claimed.split(": ");
	const variants = parts[1].split(" / ").map((v) => `${parts[0]}: ${v.trim()}`);
	const unknown = variants.filter((v) => !names.has(v));
	if (unknown.length === variants.length) fail("README.md", `names an action that does not exist: "${claimed}"`);
	else if (unknown.length) note("README.md", `"${claimed}" partly resolves; unmatched: ${unknown.join(", ")}`);
}

// The README's "Live state shown" column is a claim about each key, and the
// selectors are the fact. A key that reports state but is documented as
// availability-only undersells it; the reverse promises something the plugin
// cannot show. Both were found in the table at once.
const stateBearing = new Set(
	Object.entries(selectors.controls ?? {})
		.filter(([, v]) =>
			v.activePattern || v.inactivePattern || v.stateFromSelection ||
			v.stateFromFullDescription || v.activeWhenPresentAutomationId ||
			v.colorFromName || v.menuItemToggleAutomationId || v.offName || v.offAutomationId
		)
		.map(([k]) => k)
);

// Only the rows this can resolve unambiguously to a single control.
const rowToControl = {
	"Mute": "mute",
	"Camera": "camera",
	"Share Screen": "share",
	"Background Blur": "blur",
	"Chat": "chat",
	"People": "people",
	"Raise Hand": "hand",
	"Leave": "leave",
	"PPT Live: Grid View": "ppt-grid",
	"PPT Live: High Contrast": "ppt-high-contrast",
	"PPT Live: Pop Out": "ppt-popout",
	"PPT Attendee: Take Control": "ppt-take-control",
	"PPT Presenter: Private Viewing": "ppt-private-view",
	"PPT Presenter: Presenter View": "ppt-hide-presenter-view",
	"PPT Presenter: Present Latest": "ppt-refresh",
	"PPT Presenter: Copy Link": "ppt-copy-link",
	"PPT Presenter: Stop Presenting": "ppt-stop-presenting"
};

for (const line of readme.split(/\r?\n/)) {
	if (!line.startsWith("| **")) continue;
	const cells = line.split("|").map((c) => c.trim());
	const rowName = cells[1].replace(/\*\*/g, "");
	const control = rowToControl[rowName];
	if (!control) continue;

	const claimsState = cells[2].startsWith("✅");
	const reportsState = stateBearing.has(control);
	if (claimsState && !reportsState)
		fail("README.md", `"${rowName}" claims live state, but ${control} reports availability only`);
	if (!claimsState && reportsState)
		fail("README.md", `"${rowName}" says availability only, but ${control} reports state`);
}

// -------------------------------------------------------------------- images
const MARKET = path.join(ROOT, "marketplace");
const pngSize = (file) => {
	const b = readFileSync(file);
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
const marketReadme = read(path.join(MARKET, "README.md"));
const listed = new Set([
	"app-icon-288.png",
	"thumbnail.png",
	...[...marketReadme.matchAll(/`(gallery-[\w-]+\.png)`/g)].map((m) => m[1])
]);
for (const f of readdirSync(MARKET)) {
	if (!f.endsWith(".png")) continue;
	if (!listed.has(f)) fail("marketplace", `${f} is on disk but not listed in the README`);
	const { w, h } = pngSize(path.join(MARKET, f));
	const want = f === "app-icon-288.png" ? [288, 288] : [1920, 960];
	if (w !== want[0] || h !== want[1]) fail("marketplace", `${f} is ${w}x${h}, expected ${want.join("x")}`);
}
for (const f of listed) if (!existsSync(path.join(MARKET, f))) fail("marketplace", `${f} is listed but missing`);

// ------------------------------------------------------------------- report
console.log(`${problems.length} problem(s)\n`);
for (const p of problems) console.log(`  FAIL  ${p}`);
if (notes.length) {
	console.log(`\n${notes.length} note(s)`);
	for (const n of notes) console.log(`  note  ${n}`);
}
process.exit(problems.length ? 1 : 0);
