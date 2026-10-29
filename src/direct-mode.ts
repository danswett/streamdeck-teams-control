import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { bridge } from "./bridge";
import { DEFAULT_DIRECT_MODE, readDirectModeSettings, type DirectModeSettings, type DirectModeStatus } from "./protocol";

const logger = streamDeck.logger.createScope("DirectMode");
type Result = { ok: boolean; error?: string };
export type DirectModeView = DirectModeStatus & { busy: boolean; error?: string; supported: boolean };

export class DirectModeControl {
	#settings = { ...DEFAULT_DIRECT_MODE };
	#loaded = false;
	#busy = false;
	#error: string | undefined;
	#probeError: string | undefined;
	#listeners = new Set<(status: DirectModeView) => void>();
	#refreshing: Promise<Result> | undefined;

	get status(): DirectModeView {
		return {
			...bridge.directModeStatus, busy: this.#busy, error: this.#error ?? this.#probeError,
			supported: process.platform === "win32"
		};
	}

	async start(): Promise<void> {
		bridge.subscribeDirectMode(() => this.#publish());
		streamDeck.settings.onDidReceiveGlobalSettings((ev) => this.#receive(ev.settings));
		try {
			this.#receive(await this.#getSettings());
		} catch (err) {
			this.#fail(`Could not load Direct mode settings: ${String(err)}`);
		}
		setInterval(() => {
			if ((this.#settings.enabled || bridge.directModeNeedsSync) && !this.#busy) void this.refresh();
		}, 5_000).unref();
	}

	subscribe(fn: (status: DirectModeView) => void): () => void {
		this.#listeners.add(fn);
		fn(this.status);
		return () => this.#listeners.delete(fn);
	}

	#publish(): void {
		for (const fn of this.#listeners) {
			try { fn(this.status); }
			catch (err) { logger.error(`Direct mode listener failed: ${String(err)}`); }
		}
	}

	#fail(error: string): Result {
		this.#error = error;
		logger.warn(error);
		this.#publish();
		return { ok: false, error };
	}

	async #getSettings(): Promise<JsonObject> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				streamDeck.settings.getGlobalSettings(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Stream Deck settings request timed out")), 10_000);
				})
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	#receive(settings: JsonObject): void {
		let next: DirectModeSettings;
		try {
			next = readDirectModeSettings(settings);
		} catch (err) {
			this.#settings = { ...DEFAULT_DIRECT_MODE };
			this.#loaded = true;
			void bridge.configureDirectMode(this.#settings);
			this.#fail(`Invalid Direct mode settings; disabled: ${String(err)}`);
			return;
		}
		if (this.#loaded && next.enabled === this.#settings.enabled && next.port === this.#settings.port) return;
		this.#settings = next;
		this.#loaded = true;
		this.#error = undefined;
		void bridge.configureDirectMode(next).then((result) => {
			if (!result.ok && result.error !== "sidecar not ready") this.#fail(result.error ?? "Direct mode setup failed");
		});
	}

	toggle(): Promise<Result> {
		return this.#change((settings) => readDirectModeSettings({
			...settings, directModeEnabled: settings["directModeEnabled"] !== true
		}));
	}

	setPort(port: number): Promise<Result> {
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			return Promise.resolve(this.#fail("Port must be a whole number between 1 and 65535"));
		return this.#change((settings) => {
			const consent = settings["directModeEnabled"];
			if (consent !== undefined && typeof consent !== "boolean")
				logger.warn("Invalid saved Direct mode consent; leaving Direct mode disabled while saving the port");
			return readDirectModeSettings({ directModeEnabled: consent === true, directModePort: port });
		});
	}

	async #change(change: (settings: JsonObject) => DirectModeSettings): Promise<Result> {
		if (process.platform !== "win32") return this.#fail("Direct mode is available on Windows only");
		if (this.#busy) return { ok: false, error: "A Direct mode change is already in progress" };
		this.#busy = true;
		this.#error = undefined;
		this.#publish();
		try {
			const global = await this.#getSettings();
			const next = change(global);
			await streamDeck.settings.setGlobalSettings({
				...global, directModeEnabled: next.enabled, directModePort: next.port
			});
			this.#settings = next;
			this.#loaded = true;
			const result = await bridge.configureDirectMode(next);
			if (!result.ok) return this.#fail(result.error ?? "Could not apply Direct mode settings");
			this.#error = undefined;
			this.#probeError = undefined;
			return { ok: true };
		} catch (err) {
			return this.#fail(`Could not save Direct mode settings: ${String(err)}`);
		} finally {
			this.#busy = false;
			this.#publish();
		}
	}

	refresh(): Promise<Result> {
		if (this.#refreshing) return this.#refreshing;
		this.#refreshing = bridge.probeDirectMode().then((result) => {
			if (!result.ok && result.error !== "sidecar not ready") {
				this.#probeError = result.error ?? "Direct mode check failed";
				logger.warn(this.#probeError);
				this.#publish();
			}
			if (result.ok) { this.#probeError = undefined; this.#publish(); }
			return result;
		}).finally(() => { this.#refreshing = undefined; });
		return this.#refreshing;
	}
}

export const directModeControl = new DirectModeControl();
