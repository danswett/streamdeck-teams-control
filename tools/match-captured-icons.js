/**
 * Resolves artwork captured from the Teams DOM to the Fluent icon it came from.
 *
 * Teams renders Fluent "bundle" icons, which ship a regular and a filled
 * variant per button and swap them on hover or state - so a capture only ever
 * shows one half, and picking the glyph by name alone is guesswork. Matching
 * the path data says exactly which file, size tier and variant to use.
 *
 * Run with: node tools/match-captured-icons.js <captured.json>
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = path.join(ROOT, "node_modules", "@fluentui", "svg-icons", "icons");

const file = process.argv[2];
if (!file) {
	console.error("usage: node tools/match-captured-icons.js <captured.json>");
	process.exit(1);
}

/** Path data differs only in whitespace between the DOM and the shipped file. */
const norm = (d) => d.replace(/\s+/g, " ").trim();

console.log("Indexing Fluent icons...");
const index = new Map();
for (const name of readdirSync(ICONS)) {
	if (!name.endsWith(".svg")) continue;
	const svg = readFileSync(path.join(ICONS, name), "utf8");
	for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
		const key = norm(m[1]);
		if (!index.has(key)) index.set(key, []);
		index.get(key).push(name.replace(/\.svg$/, ""));
	}
}
console.log(`  ${index.size} distinct paths\n`);

const captured = JSON.parse(readFileSync(file, "utf8"));

/**
 * Accepts either shape the capture snippets produce: the older
 * `{ icons: [{ d, viewBox, variant }] }`, or a bare array of controls each
 * carrying raw `svg` markup. The two drifted apart, and a capture that cannot
 * be matched is a capture wasted - the window to take it is a live meeting.
 */
function* controls() {
	if (Array.isArray(captured?.icons)) {
		for (const icon of captured.icons) {
			yield {
				id: icon.id,
				label: icon.label,
				size: icon.viewBox ? icon.viewBox.split(" ")[2] : "?",
				variant: icon.variant ?? "",
				paths: [icon.d]
			};
		}
		return;
	}

	const list = Array.isArray(captured) ? captured : [];
	for (const c of list) {
		const markup = [].concat(c.svg ?? []).filter(Boolean);
		const paths = [];
		let size = "?";
		let variant = "";

		for (const svg of markup) {
			const vb = / viewBox="([^"]+)"/.exec(svg);
			if (vb) size = vb[1].split(" ")[2];
			if (/fui-Icon-filled/.test(svg)) variant = "filled";
			else if (/fui-Icon-regular/.test(svg)) variant = "regular";
			for (const m of svg.matchAll(/ d="([^"]+)"/g)) paths.push(m[1]);
		}
		yield { id: c.id ?? "(no id)", label: c.label, size, variant, paths };
	}
}

for (const c of controls()) {
	console.log(`${c.id}`);
	console.log(`  label   ${c.label}`);

	if (c.paths.length === 0) {
		// Worth stating rather than skipping: a control with no glyph cannot be
		// matched to Fluent at all, so its key has to be designed from what
		// Teams actually draws instead of copied.
		console.log(`  drawn   no SVG - text or styled markup only`);
		console.log(`  fluent  NONE - nothing to match\n`);
		continue;
	}

	console.log(`  drawn   ${c.size}px ${c.variant}`.trimEnd());
	for (const d of c.paths) {
		const hit = index.get(norm(d));
		console.log(`  fluent  ${hit ? hit.join(", ") : "NO MATCH (Teams-specific artwork)"}`);
	}
	console.log();
}
