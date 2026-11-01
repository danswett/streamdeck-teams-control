/**
 * Adjusts the manifest for a packaging run, in one place every workflow shares.
 *
 *   --declare-mac        add macOS to the OS list (Windows stays). Used by the
 *                        CI and preview builds while main still declares
 *                        Windows alone, so the combined package is exercised
 *                        long before the day it ships.
 *   --version-suffix N   replace the fourth version component. Stream Deck
 *                        refuses to install a version it already has, so every
 *                        preview build needs its own.
 *
 * Prints the result, and when run under GitHub Actions also writes `version`
 * and `declares-mac` to the step's outputs.
 *
 * Run with: node tools/set-manifest-platforms.ts [--declare-mac] [--version-suffix N]
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The macOS the Swift package targets; see sidecar-macos/Package.swift. */
const MAC_MINIMUM = "13";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin", "manifest.json");

const args = process.argv.slice(2);
const declareMac = args.includes("--declare-mac");
const suffixAt = args.indexOf("--version-suffix");
const suffix = suffixAt >= 0 ? args[suffixAt + 1] ?? "" : "";
if (suffixAt >= 0 && !/^\d+$/.test(suffix)) {
	console.error(`--version-suffix needs a whole number, got "${suffix}"`);
	process.exit(2);
}

type Manifest = { Version: string; OS: { Platform: string; MinimumVersion: string }[] };
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;

if (declareMac && !manifest.OS.some((os) => os.Platform === "mac")) {
	manifest.OS.push({ Platform: "mac", MinimumVersion: MAC_MINIMUM });
}
if (suffix) {
	manifest.Version = [...manifest.Version.split(".").slice(0, 3), suffix].join(".");
}
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`);

const declaresMac = manifest.OS.some((os) => os.Platform === "mac");
const platforms = manifest.OS.map((os) => os.Platform).join(", ");
console.log(`manifest ${manifest.Version}, declares ${platforms}`);
if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `version=${manifest.Version}\ndeclares-mac=${declaresMac}\n`);
}
