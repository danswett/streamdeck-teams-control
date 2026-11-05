/**
 * Language packs: the localized half of the selector map.
 *
 * Teams names its toggle buttons for the action they perform ("Unmute mic"),
 * and those names are translated, so reading mute, camera and share state needs
 * patterns written for the language Teams is displaying. Each pack in
 * `locales/` carries those patterns for one language, in the same shape as
 * selectors.json, and the sidecar lays the chosen one over the bundled file.
 *
 * Pure functions only, so the packs and detection can be tested without a
 * Stream Deck runtime or a live meeting.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type PackStatus = "verified" | "unverified";

export type LanguagePack = {
	tag: string;
	name: string;
	status: PackStatus;
	file: string;
	/** Compiled state patterns, keyed by control. */
	patterns: Record<string, { active?: RegExp; inactive?: RegExp }>;
};

/** The language used when nothing else is known; it is also the bundled baseline. */
export const DEFAULT_LANGUAGE = "en";

/** Context keys under which the sidecars publish a toggle's accessible name. */
export const LABEL_PREFIX = "label.";

function compile(pattern: unknown): RegExp | undefined {
	return typeof pattern === "string" && pattern.trim() ? new RegExp(pattern, "i") : undefined;
}

/** Parses one pack. Throws with a reason when it is not usable. */
export function parsePack(text: string, file: string): LanguagePack {
	const json = JSON.parse(text) as Record<string, unknown>;
	const meta = json["language"] as Record<string, unknown> | undefined;
	const tag = meta?.["tag"];
	const name = meta?.["name"];
	const status = meta?.["status"];
	if (typeof tag !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(tag))
		throw new Error("language.tag must be a language tag such as \"de\" or \"pt-BR\"");
	if (path.basename(file, ".json") !== tag) throw new Error(`language.tag "${tag}" does not match the file name`);
	if (typeof name !== "string" || !name.trim()) throw new Error("language.name is required");
	if (status !== "verified" && status !== "unverified")
		throw new Error("language.status must be \"verified\" or \"unverified\"");

	const patterns: LanguagePack["patterns"] = {};
	const controls = json["controls"];
	if (typeof controls === "object" && controls !== null) {
		for (const [key, raw] of Object.entries(controls as Record<string, Record<string, unknown>>)) {
			const active = compile(raw?.["activePattern"]);
			const inactive = compile(raw?.["inactivePattern"]);
			if (active || inactive) patterns[key] = { active, inactive };
		}
	}
	return { tag, name, status, file, patterns };
}

/** Reads every pack in a directory, reporting the ones that cannot be used. */
export function loadPacks(dir: string, warn: (message: string) => void = () => {}): LanguagePack[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch (err) {
		warn(`Could not read language packs in ${dir}: ${String(err)}`);
		return [];
	}
	const packs: LanguagePack[] = [];
	for (const f of files) {
		const file = path.join(dir, f);
		try {
			packs.push(parsePack(readFileSync(file, "utf8"), file));
		} catch (err) {
			warn(`Ignoring language pack ${f}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return packs;
}

/**
 * Reads a label with one pack: true or false when exactly one of its patterns
 * matches, undefined when neither or both do - either way the pack cannot say.
 */
export function classify(pack: LanguagePack, key: string, label: string): boolean | undefined {
	const p = pack.patterns[key];
	if (!p) return undefined;
	const active = p.active?.test(label) ?? false;
	const inactive = p.inactive?.test(label) ?? false;
	return active === inactive ? undefined : active;
}

/** The labels a state message carries, keyed by control. */
export function labelsOf(context: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(context))
		if (k.startsWith(LABEL_PREFIX) && v) out[k.slice(LABEL_PREFIX.length)] = v;
	return out;
}

/** Whether a pack reads every label it has patterns for. False when it reads none. */
export function readsAll(pack: LanguagePack, labels: Record<string, string>): boolean {
	let read = 0;
	for (const [key, label] of Object.entries(labels)) {
		if (!pack.patterns[key]) continue;
		if (classify(pack, key, label) === undefined) return false;
		read++;
	}
	return read > 0;
}

/**
 * Picks the language Teams is displaying from its toolbar labels: the one pack
 * that reads all of them. Two packs that both read them is not an answer, and
 * neither is none - the caller keeps what it had.
 */
export function detectLanguage(packs: LanguagePack[], labels: Record<string, string>): LanguagePack | undefined {
	const matches = packs.filter((p) => readsAll(p, labels));
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The language to run with: an explicit choice if one was made and still
 * exists, otherwise the last one detected, otherwise English.
 */
export function effectiveLanguage(
	packs: LanguagePack[], setting: string | undefined, detected: string | undefined
): LanguagePack | undefined {
	const byTag = (tag: string | undefined) => (tag ? packs.find((p) => p.tag === tag) : undefined);
	if (setting && setting !== "auto" && byTag(setting)) return byTag(setting);
	return byTag(detected) ?? byTag(DEFAULT_LANGUAGE);
}
