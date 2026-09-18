/**
 * Groups the actions in manifest.json so the Stream Deck action list reads in a
 * sensible order: the meeting controls, then PowerPoint Live keys that work in
 * either role, then attendee-only, then presenter-only.
 *
 * Stream Deck lists actions in manifest order, so this is the only lever. Order
 * within each group is preserved, which keeps navigation before tools.
 *
 * Run with: node tools/order-actions.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin", "manifest.json");

type Action = { Name: string; UUID: string };

/** Lower sorts first. Anything unrecognised keeps its place ahead of the PPT keys. */
function group(name: string): number {
	if (name.startsWith("PPT Live:")) return 1;
	if (name.startsWith("PPT Attendee:")) return 2;
	if (name.startsWith("PPT Presenter:")) return 3;
	return 0;
}

const raw = readFileSync(MANIFEST, "utf8");
const manifest = JSON.parse(raw) as { Actions: Action[] };

const before = manifest.Actions.map((a) => a.Name);

// A stable sort by group only, so the existing order inside each group stands.
manifest.Actions = manifest.Actions
	.map((action, index) => ({ action, index }))
	.sort((a, b) => group(a.action.Name) - group(b.action.Name) || a.index - b.index)
	.map((entry) => entry.action);

const after = manifest.Actions.map((a) => a.Name);

// Match the file's existing style: tabs, and a trailing newline.
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");

const moved = after.filter((name, i) => name !== before[i]).length;
console.log(`${manifest.Actions.length} actions, ${moved} repositioned\n`);
for (const name of after) console.log(`  ${name}`);
