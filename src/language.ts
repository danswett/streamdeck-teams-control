/**
 * Which language pack the sidecar reads Teams' labels with.
 *
 * Automatic by default: the sidecars publish the accessible names of the
 * toolbar toggles, and when the pack in use cannot read them but exactly one
 * other pack can, that pack is remembered and the sidecar restarted with it.
 * A language chosen in a key's settings overrides detection.
 *
 * Every distinct label is also logged once, which is how a language pack gets
 * checked against a real Teams - see 'Languages' in the README.
 */
import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bridge, type TeamsState } from "./bridge";
import {
	classify, detectLanguage, effectiveLanguage, labelsOf, loadPacks, readsAll, type LanguagePack
} from "./language-packs";
import { getGlobalSettings, updateGlobalSettings } from "./settings";

const logger = streamDeck.logger.createScope("Language");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.resolve(HERE, "..", "locales");

/** Global setting: "auto", or the tag of the pack to use regardless of detection. */
export const LANGUAGE_SETTING = "teamsLanguage";
/** Global setting: the tag detection last settled on. */
export const DETECTED_LANGUAGE_SETTING = "teamsLanguageDetected";

/** Bounds the once-per-label log; a meeting produces a handful at most. */
const MAX_LOGGED_LABELS = 64;

export type LanguageView = {
	event: "language-status";
	loaded: boolean;
	setting: string;
	effective?: string;
	detected?: string;
	/** The labels Teams shows are not read by the pack in use. */
	unrecognised: boolean;
	packs: { tag: string; name: string; status: string }[];
	error?: string;
};

export class LanguageControl {
	#packs: LanguagePack[] = [];
	#setting = "auto";
	#detected: string | undefined;
	#loaded = false;
	#unrecognised = false;
	#error: string | undefined;
	#logged = new Set<string>();
	#warned = new Set<string>();
	#switching = false;

	get #current(): LanguagePack | undefined {
		return effectiveLanguage(this.#packs, this.#setting, this.#detected);
	}

	get view(): LanguageView {
		return {
			event: "language-status", loaded: this.#loaded, setting: this.#setting,
			effective: this.#current?.tag, detected: this.#detected, unrecognised: this.#unrecognised,
			packs: this.#packs.map((p) => ({ tag: p.tag, name: p.name, status: p.status })),
			error: this.#error
		};
	}

	/** Resolves once the saved choice is applied, so the first sidecar starts with it. */
	async start(): Promise<void> {
		this.#packs = loadPacks(LOCALES, (m) => logger.warn(m));
		streamDeck.ui.onSendToPlugin(async (ev) => {
			const payload = ev.payload;
			if (typeof payload !== "object" || payload === null || !("event" in payload)) return;
			if (payload.event === "language-status") await this.#publish();
			else if (payload.event === "language-set")
				await this.setLanguage("value" in payload && typeof payload.value === "string" ? payload.value : "");
		});
		streamDeck.settings.onDidReceiveGlobalSettings((ev) => this.#receive(ev.settings));
		bridge.subscribe((s) => this.#onState(s));
		try {
			this.#receive(await getGlobalSettings());
		} catch (err) {
			this.#error = `Could not load the language setting: ${String(err)}`;
			logger.warn(this.#error);
		}
		this.#loaded = true;
		this.#apply();
	}

	#receive(settings: JsonObject): void {
		const setting = settings[LANGUAGE_SETTING];
		const detected = settings[DETECTED_LANGUAGE_SETTING];
		this.#setting = typeof setting === "string" && setting ? setting : "auto";
		this.#detected = typeof detected === "string" && detected ? detected : undefined;
		if (this.#loaded) this.#apply();
	}

	#apply(): void {
		const pack = this.#current;
		bridge.setLocalePack(pack?.file);
		void this.#publish();
	}

	async setLanguage(value: string): Promise<void> {
		if (value !== "auto" && !this.#packs.some((p) => p.tag === value)) {
			this.#error = `There is no language pack for "${value}"`;
			await this.#publish();
			return;
		}
		try {
			await updateGlobalSettings((s) => ({ ...s, [LANGUAGE_SETTING]: value }));
			this.#setting = value;
			this.#error = undefined;
			this.#unrecognised = false;
			this.#warned.clear();
			logger.info(`Teams language set to ${value}`);
			this.#apply();
		} catch (err) {
			this.#error = `Could not save the language setting: ${String(err)}`;
			logger.warn(this.#error);
			await this.#publish();
		}
	}

	#onState(state: TeamsState): void {
		if (!this.#loaded || this.#switching || !state.inMeeting) return;
		const labels = labelsOf(state.context);
		if (Object.keys(labels).length === 0) return;

		const current = this.#current;
		this.#logLabels(labels, current);

		const readable = current !== undefined && readsAll(current, labels);
		if (readable) {
			if (this.#unrecognised) { this.#unrecognised = false; void this.#publish(); }
			return;
		}

		if (this.#setting === "auto") {
			const found = detectLanguage(this.#packs, labels);
			if (found && found.tag !== current?.tag) {
				void this.#switchTo(found);
				return;
			}
		}

		const summary = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(", ");
		if (!this.#warned.has(summary)) {
			this.#warned.add(summary);
			logger.warn(`No language pack reads these Teams labels (using ${current?.tag ?? "none"}): ${summary}`);
		}
		if (!this.#unrecognised) { this.#unrecognised = true; void this.#publish(); }
	}

	async #switchTo(pack: LanguagePack): Promise<void> {
		this.#switching = true;
		logger.info(`Teams appears to be in ${pack.name} (${pack.tag}, ${pack.status}); switching language pack`);
		try {
			await updateGlobalSettings((s) => ({ ...s, [DETECTED_LANGUAGE_SETTING]: pack.tag }));
		} catch (err) {
			// Still worth using for this session; it is detected again next time.
			logger.warn(`Could not save the detected language: ${String(err)}`);
		}
		this.#detected = pack.tag;
		this.#unrecognised = false;
		this.#switching = false;
		this.#apply();
	}

	/** Logs each distinct label once, with how the pack in use reads it. */
	#logLabels(labels: Record<string, string>, pack: LanguagePack | undefined): void {
		for (const [key, label] of Object.entries(labels)) {
			const id = `${key}\u0000${label}`;
			if (this.#logged.has(id) || this.#logged.size >= MAX_LOGGED_LABELS) continue;
			this.#logged.add(id);
			const read = pack ? classify(pack, key, label) : undefined;
			const reading = read === undefined ? "not recognised" : read ? "active" : "inactive";
			logger.info(`Teams label ${key}: "${label}" (${pack?.tag ?? "no pack"}: ${reading})`);
		}
	}

	async #publish(): Promise<void> {
		if (!streamDeck.ui.action) return;
		try {
			await streamDeck.ui.sendToPropertyInspector(this.view);
		} catch (err) {
			logger.warn(`Could not update the language inspector: ${String(err)}`);
		}
	}
}

export const languageControl = new LanguageControl();
