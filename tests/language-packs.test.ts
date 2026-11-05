import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	classify, detectLanguage, effectiveLanguage, labelsOf, loadPacks, parsePack, type LanguagePack
} from "../src/language-packs";

const LOCALES = "com.bad-duck.teamscontrol.sdPlugin/locales";
const FIXTURES = "tests/fixtures/teams-labels";

type Fixture = {
	language: string;
	teamsVersion: string;
	platform: string;
	captured: string;
	labels: Record<string, { active: string[]; inactive: string[] }>;
};

function packs(): LanguagePack[] {
	const warnings: string[] = [];
	const loaded = loadPacks(LOCALES, (m) => warnings.push(m));
	expect(warnings).toEqual([]);
	return loaded;
}

function fixtures(): Fixture[] {
	return readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as Fixture);
}

function pack(tag: string): LanguagePack {
	const found = packs().find((p) => p.tag === tag);
	if (!found) throw new Error(`no ${tag} pack`);
	return found;
}

describe("shipped language packs", () => {
	it("all load, and include the English baseline", () => {
		expect(packs().map((p) => p.tag)).toContain("en");
	});

	it("English matches the bundled selectors, so the baseline and its pack cannot drift", () => {
		const selectors = JSON.parse(readFileSync("com.bad-duck.teamscontrol.sdPlugin/selectors.json", "utf8"));
		const en = JSON.parse(readFileSync(`${LOCALES}/en.json`, "utf8"));
		for (const [key, spec] of Object.entries(en.controls as Record<string, Record<string, string>>)) {
			expect(selectors.controls[key].activePattern, key).toBe(spec["activePattern"]);
			expect(selectors.controls[key].inactivePattern, key).toBe(spec["inactivePattern"]);
		}
	});

	it("are verified exactly when a real label capture is checked in for them", () => {
		const captured = new Set(fixtures().map((f) => f.language));
		for (const p of packs())
			expect(p.status === "verified", `${p.tag}: verified needs ${FIXTURES}/${p.tag}.json`).toBe(captured.has(p.tag));
	});

	it("rejects a pack whose tag does not match its file name", () => {
		const text = JSON.stringify({ language: { tag: "fr", name: "Français", status: "unverified" } });
		expect(() => parsePack(text, "de.json")).toThrow(/does not match/);
	});
});

describe("captured Teams labels", () => {
	for (const fixture of fixtures()) {
		describe(`${fixture.language} (Teams ${fixture.teamsVersion}, ${fixture.platform})`, () => {
			it("has a pack, and every label reads as the state it was captured in", () => {
				expect(existsSync(`${LOCALES}/${fixture.language}.json`)).toBe(true);
				const p = pack(fixture.language);
				for (const [key, { active, inactive }] of Object.entries(fixture.labels)) {
					for (const label of active) expect(classify(p, key, label), `${key} "${label}"`).toBe(true);
					for (const label of inactive) expect(classify(p, key, label), `${key} "${label}"`).toBe(false);
				}
			});

			it("is detected as its own language and no other", () => {
				for (const side of ["active", "inactive"] as const) {
					const labels: Record<string, string> = {};
					for (const [key, states] of Object.entries(fixture.labels)) labels[key] = states[side][0]!;
					expect(detectLanguage(packs(), labels)?.tag, side).toBe(fixture.language);
				}
			});
		});
	}
});

describe("German alternate wordings", () => {
	const muted = ["Stummschaltung aufheben", "Stummschaltung des Mikrofons aufheben", "Mikrofon wieder aktivieren"];
	const live = ["Stummschalten", "Mikrofon stummschalten", "Mikrofon deaktivieren"];

	it("reads every candidate mute label as one state", () => {
		const de = pack("de");
		for (const label of muted) expect(classify(de, "mute", label), label).toBe(true);
		for (const label of live) expect(classify(de, "mute", label), label).toBe(false);
	});

	it("reads camera and share both ways", () => {
		const de = pack("de");
		expect(classify(de, "camera", "Kamera ausschalten")).toBe(true);
		expect(classify(de, "camera", "Kamera einschalten")).toBe(false);
		expect(classify(de, "share", "Teilen beenden")).toBe(true);
		expect(classify(de, "share", "Teilen")).toBe(false);
	});

	it("is what an English pack hands over to when Teams is in German", () => {
		// Issue #60: an English pack cannot read these, so keys showed a guess.
		const labels = { mute: "Stummschaltung aufheben", camera: "Kamera ausschalten" };
		expect(classify(pack("en"), "mute", labels.mute)).toBeUndefined();
		expect(detectLanguage(packs(), labels)?.tag).toBe("de");
	});
});

describe("detection", () => {
	it("gives no answer when no pack reads the labels", () => {
		expect(detectLanguage(packs(), { mute: "Réactiver le micro" })).toBeUndefined();
	});

	it("only considers the toolbar labels a state message carries", () => {
		expect(labelsOf({ "label.mute": "Mute mic", "ppt.role": "presenter", "label.camera": "" }))
			.toEqual({ mute: "Mute mic" });
	});
});

describe("effectiveLanguage", () => {
	it("prefers an explicit choice, then detection, then English", () => {
		const all = packs();
		expect(effectiveLanguage(all, "de", "en")?.tag).toBe("de");
		expect(effectiveLanguage(all, "auto", "de")?.tag).toBe("de");
		expect(effectiveLanguage(all, "auto", undefined)?.tag).toBe("en");
	});

	it("falls back when a chosen or detected pack no longer ships", () => {
		expect(effectiveLanguage(packs(), "xx", "yy")?.tag).toBe("en");
	});
});
