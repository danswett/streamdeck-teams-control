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

/** Where a profile lives for a given deck, or null if that deck has no layout. */
export function profilePath(base: string, device: DeviceType): string | null {
	const suffix = SUPPORTED.get(device);
	return suffix === undefined ? null : `profiles/${base}${suffix}`;
}

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

	start(): void {
		void streamDeck.settings.getGlobalSettings<ProfileSettings>().then((s) => {
			this.#enabled = s.pptAutoProfile ?? false;
		});

		streamDeck.settings.onDidReceiveGlobalSettings<ProfileSettings>((ev) => {
			const enabled = ev.settings.pptAutoProfile ?? false;
			if (enabled === this.#enabled) return;

			this.#enabled = enabled;
			logger.info(`Meeting profiles ${enabled ? "enabled" : "disabled"}`);

			// Turned off while it had the deck: give the profile back rather
			// than stranding the user on a layout they just disabled.
			if (!enabled) void this.#restoreAll();
		});

		bridge.subscribe((state) => this.#onState(state));
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

			if (target === null) void this.#restore(device.id);
			else void this.#switch(device.id, target);
		}
	}

	async #switch(id: string, profile: string): Promise<void> {
		// Recorded before awaiting, so a second state arriving mid-switch does
		// not fire the same switch a second time.
		this.#current.set(id, profile);
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

	async #restoreAll(): Promise<void> {
		for (const id of [...this.#current.keys()]) await this.#restore(id);
	}
}

export const profileSwitcher = new ProfileSwitcher();
