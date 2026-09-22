/**
 * Refuses to package a plugin that promises a platform it cannot serve.
 *
 * The manifest's OS list is what Stream Deck and Marketplace believe. Each
 * platform needs its own sidecar binary beside plugin.js, and neither machine
 * can build the other's: the .NET host is win-x64, the Swift one is Mach-O. So
 * `npm run pack` on Windows produces a plugin that declares macOS support and
 * contains only TeamsBridge.exe. It installs, it loads, and every key sits
 * dimmed forever, because the sidecar it looks for is not there.
 *
 * That package is indistinguishable from a good one until a Mac user opens it,
 * which is far too late. CI builds both halves and packs on macOS; this exists
 * so a hand-built package cannot quietly skip that.
 *
 * Run with: node tools/check-sidecars.ts
 * Override for a deliberate single-platform test build:
 *   SKIP_SIDECAR_CHECK=1 npm run pack
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sidecarFileName } from "../src/sidecar-path.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin");

/**
 * Manifest platform names to Node's, so the binary name comes from
 * `sidecarFileName` - the same function `bridge.ts` spawns through. Checking
 * for a name this file made up would pass while the plugin looked for another.
 */
const NODE_PLATFORM: Record<string, NodeJS.Platform> = {
	windows: "win32",
	mac: "darwin"
};

/** How to produce the one that is missing, since it cannot be cross-built. */
const HOW: Record<string, string> = {
	windows: "npm run build:sidecar        (needs Windows and the .NET 10 SDK)",
	mac: "npm run build:sidecar:macos (needs macOS and a Swift toolchain)"
};

type Manifest = { OS: { Platform: string }[] };

if (process.env.SKIP_SIDECAR_CHECK) {
	console.log("SKIP_SIDECAR_CHECK set - not checking sidecars. This package may be");
	console.log("inert on a platform its manifest declares. Do not ship it.");
	process.exit(0);
}

const manifest = JSON.parse(readFileSync(path.join(PLUGIN, "manifest.json"), "utf8")) as Manifest;

const declared = manifest.OS.map((o) => o.Platform);
const missing: { platform: string; name: string }[] = [];

console.log("Checking the sidecar for every platform the manifest declares...");

for (const platform of declared) {
	const node = NODE_PLATFORM[platform];
	if (!node) {
		console.log(`  ${platform.padEnd(8)} no sidecar known for this platform, skipping`);
		continue;
	}

	const name = sidecarFileName(node);
	const file = path.join(PLUGIN, "bin", "sidecar", name);

	if (existsSync(file)) {
		const mb = (statSync(file).size / 1024 / 1024).toFixed(2);
		console.log(`  ${platform.padEnd(8)} ${name} (${mb} MB)`);
	} else {
		console.log(`  ${platform.padEnd(8)} ${name} MISSING`);
		missing.push({ platform, name });
	}
}

if (missing.length === 0) {
	console.log("All declared platforms have a sidecar.");
	process.exit(0);
}

console.error("");
console.error(
	`Refusing to pack: the manifest declares ${missing.map((m) => m.platform).join(" and ")}, but`
);
console.error(`bin/sidecar/ has no ${missing.map((m) => m.name).join(" and no ")}.`);
console.error("");
console.error("A package built like this installs and then does nothing on that");
console.error("platform - the plugin loads, finds no sidecar, and leaves every key");
console.error("dimmed. Nothing about the file says so.");
console.error("");
for (const { platform } of missing) console.error(`  ${HOW[platform]}`);
console.error("");
console.error("CI builds both and packs on macOS, which is how a release gets made.");
console.error("For a deliberate single-platform build: SKIP_SIDECAR_CHECK=1 npm run pack");
process.exit(1);
