/**
 * Moves the deck between the bundled profiles as a meeting progresses.
 *
 *   no meeting          the profile you were on before
 *   in a meeting        Teams Meeting
 *   watching a deck     PowerPoint Live (Attendee)
 *   presenting a deck   PowerPoint Live (Presenter)
 *
 * Off by default. Taking over someone's deck layout unasked is the kind of
 * thing that is delightful once and infuriating thereafter, so it has to be
 * turned on in any PowerPoint Live key's property inspector.
 *
 * The SDK can only switch to profiles the plugin ships itself, which is why
 * tools/build-profile.ts exists; a user-made profile cannot be targeted.
 */
import streamDeck, { DeviceType } from "@elgato/streamdeck";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bridge, type TeamsState } from "./bridge";

const logger = streamDeck.logger.createScope("Profiles");

/**
 * Base names of the bundled profiles.
 *
 * The manifest's `Profiles[].Name` is the path to the .streamDeckProfile with
 * the extension omitted, and each deck gets a file of its own, so a name is
 * only a path once the device is known - see {@link profilePath}.
 */
export const MEETING = "Teams Meeting";
export const ATTENDEE = "PowerPoint Live (Attendee)";
export const PRESENTER = "PowerPoint Live (Presenter)";

/**
 * Decks that have a bundled layout, and the suffix their files carry.
 *
 * The 15-key shipped before there was a second deck, so its files are
 * unsuffixed and must stay that way; anything added since names itself. A
 * device that is not listed here is left alone entirely, because switching it
 * to a layout built for a different grid would push keys off the edge of it.
 */
const SUPPORTED = new Map<DeviceType, string>([
	[DeviceType.StreamDeck, ""],
	[DeviceType.StreamDeckPlusXL, " (+ XL)"]
]);

/**
 * The profiles the manifest declares, which is the authority on where a layout
 * actually lives.
 *
 * Stream Deck installs a bundled profile once and never revisits it, so
 * tools/build-profile.ts appends a revision to the file name when a layout
 * changes - a path it has not seen is the only thing it treats as new. Working
 * the path out here as well would mean two places that have to agree about
 * which revision shipped, and the failure when they disagree is silent: the
 * switch is accepted and simply does nothing.
 */
const declared = readDeclaredProfiles();

function readDeclaredProfiles(): { Name: string; DeviceType: number }[] {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// The bundle runs from <plugin>/bin, so the manifest is one level up.
		path.resolve(here, "..", "manifest.json"),
		// Running from source, as the tests do.
		path.resolve(here, "..", "com.bad-duck.teamscontrol.sdPlugin", "manifest.json")
	];

	for (const file of candidates) {
		try {
			const manifest = JSON.parse(readFileSync(file, "utf8")) as { Profiles?: unknown };
			if (Array.isArray(manifest.Profiles)) {
				return manifest.Profiles as { Name: string; DeviceType: number }[];
			}
		} catch {
			// Try the next one; a missing manifest is only fatal if none resolve.
		}
	}

	logger.error("Could not read the manifest; meeting profiles will not switch");
	return [];
}
/** Where a profile lives for a given deck, or null if that deck has no layout. */
export function profilePath(base: string, device: DeviceType): string | null {
	const suffix = SUPPORTED.get(device);
	if (suffix === undefined) return null;

	const unrevised = `profiles/${base}${suffix}`;
	const match = declared.find(
		(p) => p.DeviceType === device && (p.Name === unrevised || p.Name.startsWith(`${unrevised} r`))
	);
	return match?.Name ?? null;
}

/**
 * Breathing room between profile changes.
 *
 * switchToProfile resolves when the request is sent rather than when Stream
 * Deck has finished with it, so awaiting alone does not stop two of them
 * overlapping. Long enough to clear an install, short enough to be invisible
 * against a meeting changing state.
 */
const SWITCH_GAP_MS = 1500;

/**
 * How long to let a deck settle after it announces itself.
 *
 * Switching immediately on connect is too early - Stream Deck is still
 * bringing the device up and refuses the profile install underneath it.
 */
const DEVICE_SETTLE_MS = 1500;

export type ProfileSettings = {
	/** Follow the meeting between the bundled profiles. */
	pptAutoProfile?: boolean;
};

/**
 * Which profile a meeting state calls for, or null to hand the deck back.
 *
 * Separate from the switching so the decision can be tested on its own: it is
 * the part with the interesting cases, and none of them need a device.
 */
export function profileFor(state: TeamsState): string | null {
	if (!state.teamsRunning || !state.inMeeting) return null;
	if (!(state.states["ppt-live"] ?? false)) return MEETING;

	// Role decides which half of the PowerPoint Live keys are even alive, so it
	// decides the layout. Anything other than a confirmed presenter is treated
	// as an attendee, which is the safer of the two to show by mistake.
	return state.context["ppt.role"] === "presenter" ? PRESENTER : ATTENDEE;
}

class ProfileSwitcher {
	#enabled = false;

	/** Last profile chosen per device, so only a genuine change switches. */
	readonly #current = new Map<string, string>();

	/** Serialises profile changes; see {@link ProfileSwitcher.enqueue}. */
	#queue: Promise<void> = Promise.resolve();

	start(): void {
		logger.debug(
			`Declared profiles: ${declared.length ? declared.map((p) => p.Name).join(", ") : "(none found)"}`
		);

		void streamDeck.settings.getGlobalSettings<ProfileSettings>().then((s) => {
			this.#enabled = s.pptAutoProfile ?? false;
			// The meeting may already be under way when the plugin starts, in
			// which case no state change is coming to act on.
			this.#apply();
		});

		streamDeck.settings.onDidReceiveGlobalSettings<ProfileSettings>((ev) => {
			const enabled = ev.settings.pptAutoProfile ?? false;
			if (enabled === this.#enabled) return;

			this.#enabled = enabled;
			logger.info(`Meeting profiles ${enabled ? "enabled" : "disabled"}`);

			// Turned off while it had the deck: give the profile back rather
			// than stranding the user on a layout they just disabled.
			if (!enabled) this.#restoreAll();
			// Turned on mid-meeting: act now rather than waiting for the next
			// thing to happen in Teams, which may be minutes away.
			else this.#apply();
		});

		/*
			A deck that arrives after the last state change would otherwise
			never be given a profile. Nothing re-evaluates on its own: the
			sidecar only reports when something in Teams changes, so a Stream
			Deck restarted mid-presentation sat on the wrong profile until the
			presenter happened to do something.

			Delayed, because a deck is not ready for a profile the instant it
			announces itself: switching 150ms after one attached got "Another
			operation is already in progress" from Stream Deck, and the request
			was dropped with nothing reported back.
		*/
		streamDeck.devices.onDeviceDidConnect(() => {
			setTimeout(() => this.#apply(), DEVICE_SETTLE_MS);
		});

		bridge.subscribe((state) => this.#onState(state));
	}

	/** Re-evaluates against the state already in hand. */
	#apply(): void {
		this.#onState(bridge.state);
	}

	#onState(state: TeamsState): void {
		if (!this.#enabled) return;
		const wanted = profileFor(state);

		for (const device of streamDeck.devices) {
			if (!device.isConnected) continue;

			const target = wanted === null ? null : profilePath(wanted, device.type);
			// A connected deck the plugin ships no layout for keeps whatever it
			// is showing; it was never taken over, so there is nothing to give
			// back either.
			if (wanted !== null && target === null) continue;
			if (target === (this.#current.get(device.id) ?? null)) continue;

			const id = device.id;

			// Claimed now rather than inside the task. The queue can be several
			// hundred milliseconds deep, and #onState runs in bursts - the
			// initial apply, a device connecting and the first state all land
			// together - so a check made only when the task ran queued the same
			// switch three times over.
			if (target === null) this.#current.delete(id);
			else this.#current.set(id, target);

			if (target === null) this.#enqueue(() => this.#restore(id));
			else this.#enqueue(() => this.#switch(id, target));
		}
	}

	/**
	 * Runs profile changes one at a time.
	 *
	 * Stream Deck installs a bundled profile the first time it is switched to,
	 * and it will only do one of those at once: asking for two decks in the
	 * same tick gets "Another operation is already in progress" and the second
	 * one is dropped silently. The plugin sees nothing - switchToProfile
	 * resolves as soon as the request is sent, not when the import finishes -
	 * so the deck simply never changed, which is exactly how a + XL ended up
	 * sitting on a layout with no dials on it.
	 *
	 * Two decks is the normal case here, not an edge case: the whole point is
	 * that each of them gets its own layout.
	 */
	#enqueue(task: () => Promise<void>): void {
		this.#queue = this.#queue
			.then(task)
			.then(() => new Promise<void>((resolve) => setTimeout(resolve, SWITCH_GAP_MS)))
			.catch((err) => {
				logger.warn(`Profile change failed: ${String(err)}`);
			});
	}

	async #switch(id: string, profile: string): Promise<void> {
		try {
			await streamDeck.profiles.switchToProfile(id, profile);
			logger.info(`${id} -> "${profile}"`);
		} catch (err) {
			// A profile Stream Deck will not switch to must not take the plugin
			// down with it; the keys still work wherever they are.
			this.#current.delete(id);
			logger.warn(`Could not switch ${id} to "${profile}": ${String(err)}`);
		}
	}

	async #restore(id: string): Promise<void> {
		this.#current.delete(id);
		try {
			// No profile name means "whatever was showing before". Only ever
			// called on leaving a meeting: moving between the bundled profiles
			// switches directly by name, so the profile Stream Deck remembers
			// stays the one the user was on before any of this started.
			await streamDeck.profiles.switchToProfile(id);
			logger.info(`${id} -> restored`);
		} catch (err) {
			logger.warn(`Could not restore the profile on ${id}: ${String(err)}`);
		}
	}

	/** Hands every deck back, one at a time, for the same reason switching is. */
	#restoreAll(): void {
		for (const id of [...this.#current.keys()]) this.#enqueue(() => this.#restore(id));
	}
}

export const profileSwitcher = new ProfileSwitcher();
