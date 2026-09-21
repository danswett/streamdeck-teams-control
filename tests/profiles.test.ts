import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { DeviceType } from "@elgato/streamdeck";

import { ATTENDEE, MEETING, PRESENTER, profileFor, profilePath } from "../src/profiles";
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
		Profiles: { Name: string; DeviceType: number }[];
	};

	/**
	 * Every deck with a bundled layout, and the grid it has to fit inside.
	 * A key outside the grid is one the owner of that deck would never see.
	 */
	const DECKS = [
		{ label: "15-key", suffix: "", deviceType: 0, columns: 5, rows: 3, dials: 0 },
		{ label: "+ XL", suffix: " (+ XL)", deviceType: 13, columns: 9, rows: 4, dials: 6 }
	];

	const bases = [MEETING, ATTENDEE, PRESENTER];
	const bundled = DECKS.flatMap((deck) =>
		bases.map((base) => {
			// Asked for rather than rebuilt here: a layout revision changes the
			// file name, and the resolver is what the plugin itself uses.
			const name = profilePath(base, deck.deviceType as DeviceType);
			expect(name, `${base} has no profile for a ${deck.label}`).not.toBeNull();
			return { deck, base, name: name! };
		})
	);

	/** The page holding this plugin's keys, as Stream Deck stores it. */
	function keyPage(name: string): { Controllers: { Actions: Record<string, { UUID: string; Settings?: Record<string, unknown> }> | null; Type: string }[] } {
		const entry = new AdmZip(path.join(PLUGIN, `${name}.streamDeckProfile`))
			.getEntries()
			.find(
				(e) =>
					e.entryName.includes("/Profiles/") &&
					e.entryName.endsWith("manifest.json") &&
					e.getData().toString("utf8").includes("teamscontrol")
			);
		expect(entry, `${name} has no page holding any keys`).toBeDefined();
		return JSON.parse(entry!.getData().toString("utf8"));
	}

	const keypad = (name: string): Record<string, { UUID: string; Settings?: Record<string, unknown> }> => {
		const c = keyPage(name).Controllers.find((x) => x.Type === "Keypad");
		expect(c?.Actions, `${name} has no keypad actions`).toBeTruthy();
		return c!.Actions!;
	};

	it("are all registered in the manifest, against the right deck", () => {
		for (const { name, deck } of bundled) {
			const entry = manifest.Profiles.find((p) => p.Name === name);
			expect(entry, `${name} is not in the manifest`).toBeDefined();
			expect(entry!.DeviceType, `${name} targets the wrong deck`).toBe(deck.deviceType);
		}
		expect(manifest.Profiles).toHaveLength(bundled.length);
	});

	it.each(bundled.map((b) => [b.name, b] as const))("%s ships a profile laid out for its deck", (_label, b) => {
		const entries = new AdmZip(path.join(PLUGIN, `${b.name}.streamDeckProfile`)).getEntries();

		const root = entries.find((e) => e.entryName.endsWith(".sdProfile/manifest.json"));
		expect(root, "no profile manifest").toBeDefined();
		const profile = JSON.parse(root!.getData().toString("utf8"));

		// Version 2.0 installed silently and never appeared; Stream Deck writes
		// 3.0 and only 3.0 actually shows up.
		expect(profile.Version).toBe("3.0");
		expect(profile.Pages.Default, "needs a default page to fall back to").toBeTruthy();

		// The model is what Stream Deck matches against the hardware, and the
		// XL and + XL model names differ by one letter.
		expect(profile.Device.Model).toBe(b.deck.deviceType === 13 ? "20GBX9901" : "20GBA9901");

		// A revision ships a second profile rather than replacing the first, so
		// the name has to say which revision it is. Left identical, Stream Deck
		// files the new one under the old name as "copy", "copy 1", "copy 2",
		// and the deck gives no clue which one is current.
		const shown = path.basename(b.name);
		expect(profile.Name, `${b.name} is named something else`).toBe(shown);
		expect(profile.PreconfiguredName, `${b.name} would install as a duplicate`).toBe(shown);

		const actions = keypad(b.name);
		const positions = Object.keys(actions);
		expect(positions.length).toBeGreaterThan(0);

		for (const pos of positions) {
			const [col, row] = pos.split(",").map(Number);
			expect(col, `${pos} is off a ${b.deck.label} deck`).toBeLessThan(b.deck.columns);
			expect(row, `${pos} is off a ${b.deck.label} deck`).toBeLessThan(b.deck.rows);
		}

		// Every key must point at an action this plugin actually ships, unless
		// it belongs to another plugin and says so.
		const known = new Set(manifest.Actions.map((a) => a.UUID));
		for (const action of Object.values(actions)) {
			if (!action.UUID.startsWith("com.bad-duck.teamscontrol.")) continue;
			expect(known.has(action.UUID), `${action.UUID} is not an action`).toBe(true);
		}
	});

	it.each(bundled.filter((b) => b.deck.dials > 0).map((b) => [b.name, b] as const))(
		"%s carries the encoder controller its deck expects",
		(_label, b) => {
			// Stream Deck writes an Encoder controller into every page on a deck
			// that has dials, even an empty one. A profile that is almost right
			// installs and then quietly does nothing.
			const types = keyPage(b.name).Controllers.map((c) => c.Type);
			expect(types, `${b.name} is missing the Encoder controller`).toContain("Encoder");
		}
	);

	it.each(bundled.filter((b) => b.deck.dials > 0).map((b) => [b.name, b] as const))(
		"%s puts its dials on actions that are actually dials",
		(_label, b) => {
			const encoder = keyPage(b.name).Controllers.find((c) => c.Type === "Encoder");
			const placed = encoder?.Actions ?? {};

			const byUuid = new Map(
				(manifest.Actions as { UUID: string; Controllers?: string[] }[]).map((a) => [a.UUID, a])
			);

			for (const [pos, a] of Object.entries(placed)) {
				const [col, row] = pos.split(",").map(Number);
				expect(col, `${pos} is not one of ${b.deck.dials} dials`).toBeLessThan(b.deck.dials);
				// Stream Deck addresses dials as a single row and always reports
				// row 0 for them, whatever the column.
				expect(row, `${pos} is not on the dial row`).toBe(0);

				// A profile may place another plugin's action - the volume dials
				// that ship with a + XL are on one - and there is no way to check
				// those from here beyond insisting they name an owner.
				if (!a.UUID.startsWith("com.bad-duck.teamscontrol.")) {
					expect(a.Plugin?.UUID, `${pos} (${a.UUID}) names no owning plugin`).toBeTruthy();
					expect(
						a.UUID.startsWith(`${a.Plugin!.UUID}.`),
						`${pos} (${a.UUID}) is not owned by ${a.Plugin!.UUID}`
					).toBe(true);
					continue;
				}

				const declared = byUuid.get(a.UUID);
				expect(declared, `${a.UUID} is not an action`).toBeDefined();
				expect(
					declared!.Controllers ?? [],
					`${a.UUID} is on a dial but does not declare the Encoder controller`
				).toContain("Encoder");
			}
		}
	);

	it("never puts an encoder-only action on a key", () => {
		const encoderOnly = new Set(
			(manifest.Actions as { UUID: string; Controllers?: string[] }[])
				.filter((a) => (a.Controllers ?? ["Keypad"]).every((c) => c === "Encoder"))
				.map((a) => a.UUID)
		);
		expect(encoderOnly.size, "no encoder actions to check").toBeGreaterThan(0);

		for (const { name } of bundled) {
			for (const [pos, a] of Object.entries(keypad(name))) {
				expect(encoderOnly.has(a.UUID), `${name} ${pos} puts a dial action on a key`).toBe(false);
			}
		}
	});

	it.each(bundled.map((b) => [b.name] as const))("%s ships no key that ignores a normal press", (name) => {
		// requireHold makes a tap do nothing. That is a reasonable thing to opt
		// into, but a bundled profile is what someone meets first, and a key
		// that appears dead reads as a broken plugin rather than as a guard -
		// which is exactly how it was reported. Opting in stays a choice made in
		// the inspector, never one made for them.
		for (const [pos, action] of Object.entries(keypad(name))) {
			expect(
				action.Settings?.requireHold,
				`${pos} (${action.UUID}) ships with requireHold on`
			).toBeFalsy();
		}
	});

	it("puts mute on every profile, so it is never more than one press away", () => {
		for (const { name } of bundled) {
			const uuids = Object.values(keypad(name)).map((a) => a.UUID);
			expect(uuids, `${name} has no mute key`).toContain("com.bad-duck.teamscontrol.mute");
		}
	});

	it("keeps the meeting keys in the same place across the shared + XL layouts", () => {
		// Nine columns exist so a profile switch does not move mute out from
		// under the finger reaching for it, and XL_MEETING is the block that
		// guarantees it.
		//
		// The presenter profile is deliberately not in this list. It was laid
		// out by hand in the Stream Deck app and read back, so it places the
		// meeting keys where they were dragged rather than where the shared
		// block puts them. Asserting it here would only force the two to be
		// edited together, which is the opposite of the point.
		const meetingHalf = (name: string) =>
			Object.entries(keypad(name))
				.filter(([pos]) => Number(pos.split(",")[0]) < 4)
				.map(([pos, a]) => `${pos}=${a.UUID}`)
				.sort()
				.join(" ");

		const xl = (base: string) => profilePath(base, DeviceType.StreamDeckPlusXL)!;

		const reference = meetingHalf(xl(MEETING));
		expect(reference).not.toBe("");
		expect(meetingHalf(xl(ATTENDEE)), `${ATTENDEE} moved the meeting keys`).toBe(reference);
	});
});

describe("picking the file for a deck", () => {
	it("uses the unsuffixed files for the 15-key, which shipped first", () => {
		expect(profilePath(MEETING, DeviceType.StreamDeck)).toBe("profiles/Teams Meeting");
	});

	it("uses the suffixed files for the + XL", () => {
		expect(profilePath(ATTENDEE, DeviceType.StreamDeckPlusXL)).toBe(
			"profiles/PowerPoint Live (Attendee) (+ XL)"
		);
	});

	it("follows a layout revision rather than assuming the original file", () => {
		// Stream Deck installs a bundled profile once and never revisits it, so
		// a changed layout ships under a new file name. Working the name out
		// from the base would quietly keep asking for the retired one, and a
		// switch to a profile that is not declared is accepted and does
		// nothing - which is exactly how it fails in the wild.
		const manifest = JSON.parse(
			readFileSync(path.join("com.bad-duck.teamscontrol.sdPlugin", "manifest.json"), "utf8")
		) as { Profiles: { Name: string; DeviceType: number }[] };

		for (const base of [MEETING, ATTENDEE, PRESENTER]) {
			for (const device of [DeviceType.StreamDeck, DeviceType.StreamDeckPlusXL]) {
				const resolved = profilePath(base, device);
				expect(resolved, `${base} on ${device} resolved to nothing`).not.toBeNull();
				expect(
					manifest.Profiles.some((p) => p.Name === resolved && p.DeviceType === device),
					`${resolved} is not declared in the manifest`
				).toBe(true);
			}
		}
	});

	it("leaves a deck with no bundled layout alone", () => {
		// Switching a Mini or a Pedal to a layout built for a bigger grid would
		// push most of the keys off the edge of it.
		expect(profilePath(MEETING, DeviceType.StreamDeckMini)).toBeNull();
		expect(profilePath(MEETING, DeviceType.StreamDeckXL)).toBeNull();
		expect(profilePath(MEETING, DeviceType.StreamDeckPedal)).toBeNull();
	});
});