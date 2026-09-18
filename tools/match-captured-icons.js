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
for (const icon of captured.icons) {
	const hit = index.get(norm(icon.d));
	const where = hit ? hit.join(", ") : "NO MATCH (Teams-specific artwork)";
	console.log(`${icon.id}`);
	console.log(`  label   ${icon.label}`);
	console.log(`  drawn   ${icon.viewBox.split(" ")[2]}px ${icon.variant}`);
	console.log(`  fluent  ${where}\n`);
}
