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

import generated from "./profiles.generated.json" with { type: "json" };
import { bridge, type TeamsState } from "./bridge";
import { getGlobalSettings, updateGlobalSettings } from "./settings";
import type { JsonObject } from "@elgato/utils";

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
 *
 * Every Stream Deck with a fixed grid is here. The ones left out have no grid
 * to build against: the Pedal is three keys with no published layout, and
 * Stream Deck Mobile and the Virtual deck are whatever size the user makes
 * them. Corsair and SCUF keyboards are reported as Stream Decks too, and are
 * left alone for the same reason. The Studio has a fixed grid and is left out
 * anyway - it is a rack-mounted broadcast deck, not something anyone is likely
 * to be running a Teams meeting from.
 */
const SUPPORTED = new Map<DeviceType, string>([
	[DeviceType.StreamDeck, ""],
	[DeviceType.StreamDeckMini, " (Mini)"],
	[DeviceType.StreamDeckXL, " (XL)"],
	[DeviceType.StreamDeckPlus, " (+)"],
	[DeviceType.StreamDeckNeo, " (Neo)"],
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
 *
 * So the list still comes from the build, but embedded rather than read back.
 * This used to open manifest.json at runtime, which Elgato's DRM forbids - the
 * manifest is a protected asset on a Marketplace build, and a failed read left
 * the list empty and profile switching quietly dead. Same source, same
 * guarantee, no file access; tests/profiles.test.ts fails if the two drift.
 */
const declared = generated.profiles as { Name: string; DeviceType: number }[];
const layouts: Readonly<Record<string, readonly string[]>> = generated.layouts;
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
 * overlapping - the second gets "Another operation is already in progress" and
 * is dropped without the plugin hearing about it.
 *
 * Sized for the slow case rather than the common one. Switching to a profile
 * that is already installed is quick; switching to one that is not has to
 * install it first, and 1.5s was not enough for that - a measured success
 * needed around 3.5s between the two decks.
 */
const SWITCH_GAP_MS = 3500;

/**
 * How long to leave Stream Deck alone after a deck has finished laying a
 * profile out.
 *
 * The profile lock is not released the instant the last key appears, and the
 * next deck's switch is refused silently if it arrives inside that. Small
 * because it is now the only fixed wait on the path: the rest is spent
 * watching for the deck to actually finish.
 */
const SETTLE_MS = 400;

/** Time to observe the requested layout before pausing, not permission to retry. */
const INSTALL_GAP_MS = 9000;

/** Give a newly connected deck time to initialize, without blind retry requests. */
const DEVICE_SETTLE_MS = 4000;

export type ProfileSettings = {
	/** Follow the meeting between the bundled profiles. */
	pptAutoProfile?: boolean;
	/** Saved before sending a request; only observed arrival or explicit retry clears it. */
	pptProfilePending?: { device: string; profile: string };
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

export class ProfileSwitcher {
	#enabled = false;
	#loaded = false;
	#paused = false;
	#pending = false;
	#error: string | undefined;
	#epoch = 0;

	/** Last profile chosen per device, so only a genuine change switches. */
	readonly #current = new Map<string, string>();
	/**
	 * Decks sent a named switch that has not been handed back yet.
	 *
	 * Stream Deck suspends app-specific (smart) profile switching on a deck
	 * from the moment a plugin switches it by name until that plugin switches
	 * it back with no name. Whether the layout was confirmed, customized or
	 * edited afterwards has no bearing on that hold, so every request is
	 * recorded here before it is sent and released when the meeting ends.
	 */
	readonly #held = new Set<string>();
	readonly #restoring = new Set<string>();

	/** Serializes profile changes; see {@link ProfileSwitcher.enqueue}. */
	#queue: Promise<void> = Promise.resolve();

	async start(): Promise<void> {
		logger.debug(
			`Declared profiles: ${declared.length ? declared.map((p) => p.Name).join(", ") : "(none found)"}`
		);

		streamDeck.settings.onDidReceiveGlobalSettings((ev) => this.#receive(ev.settings));
		streamDeck.ui.onSendToPlugin(async (ev) => {
			const payload = ev.payload;
			if (typeof payload !== "object" || payload === null || !("event" in payload)) return;
			if (payload.event === "profile-following-status") {
				if (!this.#loaded) await this.#load();
				await this.#publish();
			} else if (payload.event === "profile-following-set") {
				if (!("enabled" in payload) || typeof payload.enabled !== "boolean") {
					logger.warn("Rejected invalid profile-following setting");
					await this.#publish("The following setting must be on or off");
					return;
				}
				const result = await this.setEnabled(payload.enabled);
				if (streamDeck.ui.action?.id === ev.action.id) await this.#publish(result.error);
			}
		});
		streamDeck.devices.onDeviceDidConnect((ev) => {
			setTimeout(() => {
				this.#current.delete(ev.device.id);
				this.#apply();
			}, DEVICE_SETTLE_MS);
		});
		bridge.subscribe((state) => this.#onState(state));
		await this.#load();
	}

	async #load(): Promise<void> {
		const epoch = this.#epoch;
		const error = this.#error;
		try {
			const settings = await getGlobalSettings();
			if (epoch === this.#epoch && this.#error === error) this.#error = undefined;
			this.#receive(settings);
		} catch (err) {
			this.#pause(`Could not load profile settings: ${String(err)}`);
		}
	}

	#receive(settings: JsonObject): void {
		if (this.#loaded) return;
		this.#loaded = true;
		// Once the inspector has sent an explicit choice, an older settings reply cannot undo it.
		if (this.#epoch === 0) {
			this.#enabled = settings["pptAutoProfile"] === true;
			this.#pending = settings["pptProfilePending"] !== undefined;
			if (this.#pending) this.#pause("A previous profile change was not confirmed");
		}
		this.#apply();
		void this.#publish();
	}

	async setEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
		const epoch = ++this.#epoch;
		this.#enabled = enabled;
		this.#paused = true;
		this.#current.clear();
		try {
			await this.#enqueue(async () => {
				await updateGlobalSettings((settings) => {
					const next: JsonObject = { ...settings, pptAutoProfile: enabled };
					if (enabled) delete next["pptProfilePending"];
					return next;
				});
				if (epoch !== this.#epoch) return;
				this.#loaded = true;
				if (enabled) this.#pending = false;
				this.#error = undefined;
				this.#paused = false;
				logger.info(`Meeting profiles ${enabled ? "enabled" : "disabled"}`);
				this.#apply();
			});
			return { ok: true };
		} catch (err) {
			return { ok: false, error: `Could not save profile following: ${String(err)}` };
		}
	}

	#pause(reason: string): void {
		this.#paused = true;
		this.#error = reason;
		logger.warn(`${reason}; automatic profile following paused. Turn following off and on to retry.`);
		void this.#publish(reason);
	}

	async #publish(error = this.#error ?? ""): Promise<void> {
		if (!streamDeck.ui.action) return;
		try {
			await streamDeck.ui.sendToPropertyInspector({
				event: "profile-following-status", enabled: this.#enabled,
				paused: this.#paused || this.#pending, loaded: this.#loaded, error
			});
		} catch (err) {
			logger.warn(`Could not update profile inspector: ${String(err)}`);
		}
	}

	/** Re-evaluates against the state already in hand. */
	#apply(): void {
		this.#onState(bridge.state);
	}

	#onState(state: TeamsState): void {
		if (!this.#loaded) return;
		const wanted = this.#enabled ? profileFor(state) : null;

		for (const device of streamDeck.devices) {
			if (!device.isConnected) continue;

			const target = wanted === null ? null : profilePath(wanted, device.type);
			// A connected deck the plugin ships no layout for keeps whatever it
			// is showing; it was never taken over, so there is nothing to give
			// back either.
			if (wanted !== null && target === null) continue;
			const id = device.id;
			if (target === null) {
				this.#current.delete(id);
				this.#restoreWhenIdle(id);
				continue;
			}
			if (this.#paused || target === this.#current.get(id)) continue;
			// Reserve before queuing so bursts cannot enqueue duplicate requests.
			this.#current.set(id, target);
			const epoch = this.#epoch;
			this.#enqueue(() => this.#switch(id, target, epoch));
		}
	}

	/** Stream Deck has one profile-operation lock, shared by every connected deck. */
	#enqueue(task: () => Promise<void>): Promise<void> {
		const operation = this.#queue.then(task);
		this.#queue = operation.catch((err) => {
			this.#pause(`Profile change failed: ${String(err)}`);
		});
		return operation;
	}

	#eligible(id: string, profile: string, epoch: number): boolean {
		if (!this.#enabled || this.#paused || epoch !== this.#epoch || this.#current.get(id) !== profile) {
			return false;
		}
		const wanted = profileFor(bridge.state);
		const device = [...streamDeck.devices].find((item) => item.id === id && item.isConnected);
		return device !== undefined && wanted !== null && profilePath(wanted, device.type) === profile;
	}

	#matchesLayout(id: string, profile: string): boolean {
		const expected = layouts[profile];
		if (!expected) return false;
		const visible: string[] = [];
		for (const action of streamDeck.actions) {
			if (action.device.id !== id) continue;
			const position = action.coordinates;
			if (!position) return false;
			visible.push(`${action.controllerType} ${position.column},${position.row} ${action.manifestId}`);
		}
		visible.sort();
		return visible.length === expected.length && visible.every((value, index) => value === expected[index]);
	}

	async #savePending(
		pending?: NonNullable<ProfileSettings["pptProfilePending"]>,
		canConfirm?: () => boolean
	): Promise<void> {
		await updateGlobalSettings((settings) => {
			// Recheck the monitored quiet window after the asynchronous read, before sending the clear.
			if (canConfirm && !canConfirm()) {
				throw new Error("Requested layout changed or confirmation expired before saving");
			}
			const next = { ...settings };
			if (pending) next["pptProfilePending"] = pending;
			else delete next["pptProfilePending"];
			return next;
		});
		this.#pending = pending !== undefined;
		await this.#publish();
	}

	async #switch(id: string, profile: string, epoch: number): Promise<void> {
		if (!this.#eligible(id, profile, epoch) || this.#matchesLayout(id, profile)) return;
		if (!layouts[profile]) {
			this.#pause(`No bundled layout metadata for "${profile}"`);
			return;
		}
		try {
			// Persist before sending: a restart while the native prompt is open must not re-arm it.
			await this.#savePending({ device: id, profile });
			if (!this.#eligible(id, profile, epoch) || this.#matchesLayout(id, profile)) {
				await this.#savePending();
				return;
			}
			const observation = this.#waitForLayout(id, INSTALL_GAP_MS, profile);
			try {
				this.#held.add(id);
				await streamDeck.profiles.switchToProfile(id, profile);
				const took = await observation.result;
				if (took === null) {
					this.#pause(`Could not confirm ${id} -> "${profile}" inside ${INSTALL_GAP_MS}ms`);
					return;
				}
				await this.#savePending(undefined, observation.isStable);
				logger.info(`${id} -> "${profile}" (${took}ms)`);
			} finally {
				observation.stop();
			}
		} catch (err) {
			this.#pause(`Could not switch ${id} to "${profile}": ${String(err)}`);
		} finally {
			this.#apply();
		}
	}

	/**
	 * Arrival requires the requested layout to remain quiet and matching through settlement.
	 * Keep monitoring through the settings write; its read can outlive that first match.
	 * Disappearance only paces a restore; the SDK cannot identify the user's previous profile.
	 */
	#waitForLayout(deviceId: string, budgetMs: number, profile?: string) {
		let stop = (): void => {};
		let isStable = (): boolean => false;
		const result = new Promise<number | null>((resolve) => {
			const startedAt = Date.now();
			let settled = false;
			let stopped = false;
			let changedAt = startedAt;
			let stabilization: NodeJS.Timeout | undefined;

			const dispose = (): void => {
				if (stopped) return;
				stopped = true;
				clearTimeout(timer);
				if (stabilization) clearTimeout(stabilization);
				for (const subscription of subscriptions) subscription.dispose();
			};
			const finish = (value: number | null): void => {
				if (settled) return;
				settled = true;
				if (stabilization) clearTimeout(stabilization);
				if (value === null) dispose();
				resolve(value);
			};
			isStable = () => !stopped && profile !== undefined
				&& Date.now() - changedAt >= SETTLE_MS && this.#matchesLayout(deviceId, profile);

			const onEvent = (ev: { action: { device: { id: string } } }): void => {
				if (stopped || ev.action.device.id !== deviceId) return;
				changedAt = Date.now();
				if (settled) return;
				queueMicrotask(() => {
					if (settled || stopped) return;
					if (profile === undefined) {
						finish(Date.now() - startedAt);
						return;
					}
					if (stabilization) clearTimeout(stabilization);
					stabilization = undefined;
					if (this.#matchesLayout(deviceId, profile)) {
						stabilization = setTimeout(() => {
							stabilization = undefined;
							if (isStable()) finish(Date.now() - startedAt);
						}, SETTLE_MS);
					}
				});
			};

			const subscriptions = [streamDeck.actions.onWillDisappear(onEvent)];
			if (profile !== undefined) subscriptions.push(streamDeck.actions.onWillAppear(onEvent));
			const timer = setTimeout(() => {
				dispose();
				finish(null);
			}, budgetMs);
			stop = () => {
				dispose();
				finish(null);
			};
		});
		return { result, stop: () => stop(), isStable: () => isStable() };
	}

	async #restore(id: string): Promise<void> {
		if (this.#enabled && profileFor(bridge.state) !== null) return;
		if (![...streamDeck.devices].some((device) => device.id === id && device.isConnected)) return;
		// Released even when the layout was never confirmed or has since been
		// edited: skipping this leaves smart profiles suspended on the deck.
		if (!this.#held.delete(id)) return;
		this.#current.delete(id);
		const observation = this.#waitForLayout(id, SWITCH_GAP_MS);
		try {
			await streamDeck.profiles.switchToProfile(id);
			const took = await observation.result;
			if (took === null) logger.warn(`Could not confirm the profile restore on ${id}`);
			else {
				logger.info(`${id} -> restored (${took}ms)`);
				await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
			}
		} catch (err) {
			logger.warn(`Could not restore the profile on ${id}: ${String(err)}`);
		} finally {
			observation.stop();
		}
	}

	#restoreWhenIdle(id: string): void {
		if (!this.#held.has(id) || this.#restoring.has(id)) return;
		this.#restoring.add(id);
		this.#enqueue(async () => {
			try { await this.#restore(id); }
			finally { this.#restoring.delete(id); }
		});
	}
}

export const profileSwitcher = new ProfileSwitcher();
