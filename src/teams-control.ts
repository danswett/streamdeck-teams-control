/**
 * Teams control on macOS: the opt-in behind the Accessibility permission.
 *
 * Every Teams key works by pressing Teams' own controls through the macOS
 * Accessibility API, and macOS asks the user before Stream Deck may do that.
 * That request is never made on the plugin's behalf: it follows an explicit
 * "Allow Teams control" - answered once in a dialog when the plugin first runs,
 * so it is settled before the first meeting, and changeable afterwards in any
 * Teams key's settings. Until it is on, presses are refused with a reason and
 * keys say what is needed.
 *
 * Further permissions are held separately and asked for by their own features:
 * Screen Recording only when a slide dial is allowed to show the slide.
 *
 * Windows has no equivalent prompt, so all of this is a no-op there.
 */
import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { execFile } from "node:child_process";

import { bridge, type Permissions } from "./bridge";
import { getGlobalSettings, updateGlobalSettings } from "./settings";

const logger = streamDeck.logger.createScope("TeamsControl");

/** Global setting: true allowed, false declined, absent not yet answered. */
export const TEAMS_CONTROL_SETTING = "teamsControlEnabled";

export const TEAMS_CONTROL_OFF =
	"Teams control is off on this Mac. Turn on \"Allow Teams control\" in any Teams key's settings.";

/** How often to look again while macOS has not yet granted Accessibility. */
const PERMISSION_POLL_MS = 5_000;

export type FirstRunAnswer = "allow" | "decline" | "dismissed";

const ALLOW = "Allow Teams control";
const DECLINE = "Not now";

/**
 * Asks, in a native dialog, whether to allow Teams control.
 *
 * osascript's own `display dialog` needs no permission of its own - unlike
 * driving System Events, which would be one more prompt to explain. Gives up
 * after ten minutes, which leaves the question open for the next launch rather
 * than recording an answer nobody gave.
 */
export function askFirstRun(): Promise<FirstRunAnswer> {
	const message = [
		"Teams Control for Stream Deck presses Microsoft Teams' meeting controls for you - mute, camera, reactions, leave and the PowerPoint Live tools.",
		"",
		"To do that, macOS will ask you to allow Stream Deck under Accessibility. Nothing works until you do.",
		"",
		"Slide thumbnails need Screen Recording too. That is asked for separately, only if you turn them on for a slide dial.",
		"",
		"You can change this later in any Teams key's settings."
	].join("\n");
	// One statement on one line: AppleScript does not continue across a newline.
	// The message has no double quotes or backslashes to escape.
	const script = `display dialog "${message}" with title "Teams Control" ` +
		`buttons {"${DECLINE}", "${ALLOW}"} default button "${ALLOW}" with icon note giving up after 600`;
	return new Promise((resolve) => {
		execFile("/usr/bin/osascript", ["-e", script], { timeout: 660_000 }, (error, stdout) => {
			if (error) {
				// Cancel arrives as an error too (-128), and means the same as Not now.
				if (/-128/.test(String(error))) resolve("decline");
				else {
					logger.warn(`Could not show the Teams control dialog: ${String(error)}`);
					resolve("dismissed");
				}
				return;
			}
			const out = String(stdout);
			if (/gave up:\s*true/.test(out)) resolve("dismissed");
			else if (out.includes(`button returned:${ALLOW}`)) resolve("allow");
			else resolve("decline");
		});
	});
}

export type TeamsControlView = {
	supported: boolean;
	loaded: boolean;
	/** Undefined until the user has answered. */
	enabled?: boolean;
	accessibility?: boolean;
	screenRecording?: boolean;
	busy: boolean;
	error?: string;
};

type Result = { ok: boolean; error?: string };

export class TeamsControl {
	#enabled: boolean | undefined;
	#loaded = false;
	#asked = false;
	#busy = false;
	#error: string | undefined;
	#permissions: Permissions | undefined;
	/** Accessibility was allowed while no sidecar was up to ask through. */
	#requestOnReady = false;
	readonly #listeners = new Set<() => void>();

	constructor(
		private readonly ask: () => Promise<FirstRunAnswer> = askFirstRun,
		private readonly platform: NodeJS.Platform = process.platform
	) {}

	get supported(): boolean {
		return this.platform === "darwin";
	}

	/** Why presses are refused, or undefined when they may go ahead. */
	get refusal(): string | undefined {
		return this.supported && this.#enabled !== true ? TEAMS_CONTROL_OFF : undefined;
	}

	/** Whether keys should show the setup tile instead of their own artwork. */
	get needsSetup(): boolean {
		return this.supported && (this.#enabled !== true || this.#permissions?.accessibility === false);
	}

	/** Allowed in the plugin, but macOS has not granted Accessibility yet. */
	get waitingForMacOS(): boolean {
		return this.supported && this.#enabled === true && this.#permissions?.accessibility === false;
	}

	get view(): TeamsControlView {
		return {
			supported: this.supported, loaded: this.#loaded, enabled: this.#enabled,
			accessibility: this.#permissions?.accessibility, screenRecording: this.#permissions?.screenRecording,
			busy: this.#busy, error: this.#error
		};
	}

	subscribe(fn: () => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	async start(): Promise<void> {
		streamDeck.ui.onSendToPlugin(async (ev) => {
			const payload = ev.payload;
			if (typeof payload !== "object" || payload === null || !("event" in payload)) return;
			if (payload.event === "teams-control-status") {
				await this.#publish();
			} else if (payload.event === "teams-control-set") {
				if (!("enabled" in payload) || typeof payload.enabled !== "boolean") {
					this.#error = "The Teams control setting must be on or off";
					await this.#publish();
					return;
				}
				await this.setEnabled(payload.enabled);
			}
		});
		if (!this.supported) return;

		bridge.setGate(() => this.refusal);
		bridge.onReady(() => void this.#onReady());
		streamDeck.settings.onDidReceiveGlobalSettings((ev) => this.#receive(ev.settings));
		setInterval(() => {
			if (this.#enabled === true && this.#permissions?.accessibility !== true) void this.refresh();
		}, PERMISSION_POLL_MS).unref();

		try {
			this.#receive(await getGlobalSettings());
		} catch (err) {
			this.#error = `Could not load the Teams control setting: ${String(err)}`;
			logger.warn(this.#error);
			await this.#publish();
			return;
		}
		if (this.#enabled === undefined) void this.#firstRun();
	}

	#receive(settings: JsonObject): void {
		const value = settings[TEAMS_CONTROL_SETTING];
		const next = typeof value === "boolean" ? value : undefined;
		const changed = !this.#loaded || next !== this.#enabled;
		this.#enabled = next;
		this.#loaded = true;
		if (changed) void this.#publish();
	}

	/** Asks once per launch until answered; a dismissed dialog asks again next time. */
	async #firstRun(): Promise<void> {
		if (this.#asked) return;
		this.#asked = true;
		let answer: FirstRunAnswer;
		try {
			answer = await this.ask();
		} catch (err) {
			logger.warn(`Teams control dialog failed: ${String(err)}`);
			return;
		}
		// Answered in a key's settings while the dialog was up: that wins.
		if (this.#enabled !== undefined) return;
		logger.info(`Teams control first-run answer: ${answer}`);
		if (answer === "allow") await this.setEnabled(true);
		else if (answer === "decline") await this.setEnabled(false);
	}

	async setEnabled(enabled: boolean): Promise<Result> {
		if (!this.supported) return { ok: false, error: "Teams control needs no setup on this platform" };
		if (this.#busy) return { ok: false, error: "A Teams control change is already in progress" };
		this.#busy = true;
		this.#error = undefined;
		await this.#publish();
		try {
			await updateGlobalSettings((settings) => ({ ...settings, [TEAMS_CONTROL_SETTING]: enabled }));
			this.#enabled = enabled;
			this.#loaded = true;
			logger.info(`Teams control ${enabled ? "allowed" : "turned off"}`);
			// The one place Accessibility is asked for, and only on a yes.
			if (enabled) await this.#requestAccessibility();
			return { ok: true };
		} catch (err) {
			this.#error = `Could not save the Teams control setting: ${String(err)}`;
			logger.warn(this.#error);
			return { ok: false, error: this.#error };
		} finally {
			this.#busy = false;
			await this.#publish();
		}
	}

	async #requestAccessibility(): Promise<void> {
		const result = await bridge.permissions("accessibility");
		if (result.ok) {
			this.#requestOnReady = false;
			this.#permissions = result.permissions;
		} else if (result.error === "sidecar not ready" || result.error === "sidecar not running") {
			this.#requestOnReady = true;
		} else {
			this.#error = `Could not ask macOS for Accessibility: ${result.error ?? "unknown error"}`;
			logger.warn(this.#error);
		}
	}

	async #onReady(): Promise<void> {
		if (this.#requestOnReady && this.#enabled === true) await this.#requestAccessibility();
		else await this.refresh();
		await this.#publish();
	}

	/** Re-reads permission state. Never prompts. */
	async refresh(): Promise<void> {
		const result = await bridge.permissions();
		if (!result.ok || !result.permissions) return;
		const before = this.#permissions;
		this.#permissions = result.permissions;
		if (before?.accessibility !== result.permissions.accessibility ||
			before?.screenRecording !== result.permissions.screenRecording) await this.#publish();
	}

	/**
	 * Asks macOS for Screen Recording, for slide thumbnails.
	 *
	 * Called only when a slide dial is allowed to show the slide, which is the
	 * explicit choice that permission belongs to. Separate from Teams control.
	 */
	async requestScreenRecording(): Promise<void> {
		if (!this.supported) return;
		const result = await bridge.permissions("screen-recording");
		if (result.ok && result.permissions) {
			this.#permissions = result.permissions;
			await this.#publish();
		} else if (!result.ok) {
			logger.warn(`Could not ask macOS for Screen Recording: ${result.error ?? "unknown error"}`);
		}
	}

	async #publish(): Promise<void> {
		for (const fn of this.#listeners) {
			try { fn(); }
			catch (err) { logger.error(`Teams control listener failed: ${String(err)}`); }
		}
		if (!streamDeck.ui.action) return;
		try {
			await streamDeck.ui.sendToPropertyInspector({ event: "teams-control-status", ...this.view });
		} catch (err) {
			logger.warn(`Could not update the Teams control inspector: ${String(err)}`);
		}
	}
}

export const teamsControl = new TeamsControl();
