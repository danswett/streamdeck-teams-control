import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

import { ATTENDEE, MEETING, PRESENTER, profileFor } from "../src/profiles";
import { EMPTY_STATE, type TeamsState } from "../src/protocol";

function state(over: Partial<TeamsState>): TeamsState {
	return { ...EMPTY_STATE, ...over };
}

describe("which profile a meeting calls for", () => {
	it("hands the deck back when Teams is not running", () => {
		expect(profileFor(state({ teamsRunning: false, inMeeting: false }))).toBeNull();
	});

	it("hands the deck back when the meeting ends", () => {
		expect(profileFor(state({ teamsRunning: true, inMeeting: false }))).toBeNull();
	});

	it("shows the meeting profile once in a meeting", () => {
		expect(profileFor(state({ teamsRunning: true, inMeeting: true }))).toBe(MEETING);
	});

	it("shows the attendee profile while watching a deck", () => {
		const s = state({
			teamsRunning: true,
			inMeeting: true,
			states: { "ppt-live": true },
			context: { "ppt.role": "attendee" }
		});
		expect(profileFor(s)).toBe(ATTENDEE);
	});

	it("shows the presenter profile while presenting one", () => {
		const s = state({
			teamsRunning: true,
			inMeeting: true,
			states: { "ppt-live": true },
			context: { "ppt.role": "presenter" }
		});
		expect(profileFor(s)).toBe(PRESENTER);
	});

	it("returns to the meeting profile when the presentation ends", () => {
		const s = state({
			teamsRunning: true,
			inMeeting: true,
			states: { "ppt-live": false },
			context: {}
		});
		expect(profileFor(s)).toBe(MEETING);
	});

	it("treats an unknown role as an attendee", () => {
		// Attendee is the safer of the two to show by mistake: it offers nothing
		// that acts on everyone else in the meeting.
		const s = state({ teamsRunning: true, inMeeting: true, states: { "ppt-live": true }, context: {} });
		expect(profileFor(s)).toBe(ATTENDEE);
	});
});

describe("the bundled profiles", () => {
	const PLUGIN = "com.bad-duck.teamscontrol.sdPlugin";
	const manifest = JSON.parse(readFileSync(path.join(PLUGIN, "manifest.json"), "utf8")) as {
		Actions: { UUID: string }[];
		Profiles: { Name: string }[];
	};

	const names = [MEETING, ATTENDEE, PRESENTER];

	it("are all registered in the manifest", () => {
		for (const name of names) {
			expect(manifest.Profiles.map((p) => p.Name)).toContain(name);
		}
		expect(manifest.Profiles).toHaveLength(names.length);
	});

	it.each(names)("%s ships a profile file laid out for the deck", (name) => {
		const file = path.join(PLUGIN, `${name}.streamDeckProfile`);
		const entries = new AdmZip(file).getEntries();

		const root = entries.find((e) => e.entryName.endsWith(".sdProfile/manifest.json"));
		expect(root, "no profile manifest").toBeDefined();
		const profile = JSON.parse(root!.getData().toString("utf8"));

		// Version 2.0 installed silently and never appeared; Stream Deck writes
		// 3.0 and only 3.0 actually shows up.
		expect(profile.Version).toBe("3.0");
		expect(profile.Pages.Default, "needs a default page to fall back to").toBeTruthy();

		const page = entries.find(
			(e) => e.entryName.includes("/Profiles/") && e.entryName.endsWith("manifest.json") &&
				e.getData().toString("utf8").includes("teamscontrol")
		);
		expect(page, "no page holds any keys").toBeDefined();

		const actions = JSON.parse(page!.getData().toString("utf8")).Controllers[0].Actions as Record<
			string,
			{ UUID: string }
		>;
		const positions = Object.keys(actions);
		expect(positions.length).toBeGreaterThan(0);

		// A 15-key deck is 5 columns by 3 rows; anything outside that is a key
		// the user would never see.
		for (const pos of positions) {
			const [col, row] = pos.split(",").map(Number);
			expect(col, `${pos} is off the deck`).toBeLessThan(5);
			expect(row, `${pos} is off the deck`).toBeLessThan(3);
		}

		// Every key must point at an action this plugin actually ships.
		const known = new Set(manifest.Actions.map((a) => a.UUID));
		for (const action of Object.values(actions)) {
			expect(known.has(action.UUID), `${action.UUID} is not an action`).toBe(true);
		}
	});

	it("puts mute on every profile, so it is never more than one press away", () => {
		for (const name of names) {
			const zip = new AdmZip(path.join(PLUGIN, `${name}.streamDeckProfile`));
			const page = zip
				.getEntries()
				.find((e) => e.entryName.includes("/Profiles/") && e.getData().toString("utf8").includes("teamscontrol"));
			expect(page!.getData().toString("utf8")).toContain("com.bad-duck.teamscontrol.mute");
		}
	});
});