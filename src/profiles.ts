/**
 * Switches the deck to the bundled PowerPoint Live profile while a deck is
 * being presented, and back again when it stops.
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
const PROFILE = "profiles/PowerPoint Live";

/** The profile is laid out for the 15-key grid, so it only fits this device. */
const SUPPORTED: DeviceType = DeviceType.StreamDeck;

export type ProfileSettings = {
	/** Switch to the PowerPoint Live profile while a deck is being presented. */
	pptAutoProfile?: boolean;
};

class ProfileSwitcher {
	#enabled = false;

	/** Last PowerPoint Live state seen, so only the transitions act. */
	#wasLive = false;

	/**
	 * Devices this plugin moved off their own profile, so it only ever switches
	 * back the ones it switched away — someone who changes profile by hand
	 * mid-presentation keeps what they chose.
	 */
	readonly #switched = new Set<string>();

	start(): void {
		void streamDeck.settings.getGlobalSettings<ProfileSettings>().then((s) => {
			this.#enabled = s.pptAutoProfile ?? false;
		});

		streamDeck.settings.onDidReceiveGlobalSettings<ProfileSettings>((ev) => {
			const enabled = ev.settings.pptAutoProfile ?? false;
			if (enabled === this.#enabled) return;

			this.#enabled = enabled;
			logger.info(`PowerPoint Live auto-profile ${enabled ? "enabled" : "disabled"}`);

			// Turned off while it had the deck switched: give the profile back
			// rather than stranding the user on a layout they just disabled.
			if (!enabled) void this.#restore();
		});

		bridge.subscribe((state) => this.#onState(state));
	}

	#onState(state: TeamsState): void {
		const live = state.inMeeting && (state.states["ppt-live"] ?? false);
		if (live === this.#wasLive) return;
		this.#wasLive = live;

		if (!this.#enabled) return;
		if (live) void this.#activate();
		else void this.#restore();
	}

	async #activate(): Promise<void> {
		for (const device of streamDeck.devices) {
			if (!device.isConnected || device.type !== SUPPORTED) continue;
			if (this.#switched.has(device.id)) continue;

			try {
				await streamDeck.profiles.switchToProfile(device.id, PROFILE);
				this.#switched.add(device.id);
				logger.info(`Switched ${device.id} to "${PROFILE}"`);
			} catch (err) {
				// A profile Stream Deck will not switch to must not take the
				// plugin down with it; the keys still work where they are.
				logger.warn(`Could not switch ${device.id} to "${PROFILE}": ${String(err)}`);
			}
		}
	}

	async #restore(): Promise<void> {
		for (const id of [...this.#switched]) {
			this.#switched.delete(id);
			try {
				// No profile name means "whatever was showing before".
				await streamDeck.profiles.switchToProfile(id);
				logger.info(`Restored the previous profile on ${id}`);
			} catch (err) {
				logger.warn(`Could not restore the profile on ${id}: ${String(err)}`);
			}
		}
	}
}

export const profileSwitcher = new ProfileSwitcher();
