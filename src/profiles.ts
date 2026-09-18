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
 * Must match the manifest's `Profiles[].Name`, which the schema defines as the
 * path to the .streamDeckProfile with the extension omitted.
 */
export const MEETING = "profiles/Teams Meeting";
export const ATTENDEE = "profiles/PowerPoint Live (Attendee)";
export const PRESENTER = "profiles/PowerPoint Live (Presenter)";

/** The layouts are built for the 15-key grid, so they only fit this device. */
const SUPPORTED: DeviceType = DeviceType.StreamDeck;

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
			if (!device.isConnected || device.type !== SUPPORTED) continue;
			if (wanted === (this.#current.get(device.id) ?? null)) continue;

			if (wanted === null) void this.#restore(device.id);
			else void this.#switch(device.id, wanted);
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
