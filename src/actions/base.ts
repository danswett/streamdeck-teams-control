import {
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { bridge, type TeamsState } from "../bridge";
import { toDataUri } from "../icons";

const logger = streamDeck.logger.createScope("Action");

/**
 * Shared behaviour for every Teams key.
 *
 * One subscription is held per action *class* rather than per key, and state
 * changes are fanned out to whichever instances are currently visible.
 */
export abstract class TeamsAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	#unsubscribe: (() => void) | undefined;
	#visible = 0;

	/** Sidecar control key this action presses, or undefined if it never presses one. */
	protected abstract targetFor(settings: T): string | undefined;

	/** Produces the SVG for the current Teams state. */
	protected abstract draw(state: TeamsState, settings: T): string;

	override onWillAppear(ev: WillAppearEvent<T>): void {
		this.#visible++;
		if (!this.#unsubscribe) {
			this.#unsubscribe = bridge.subscribe((state) => this.#paintAll(state));
		}
		if (ev.action.isKey()) {
			void this.#paint(ev.action, bridge.state, ev.payload.settings);
		}
	}

	override onWillDisappear(_ev: WillDisappearEvent<T>): void {
		this.#visible = Math.max(0, this.#visible - 1);
		if (this.#visible === 0 && this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): void {
		if (ev.action.isKey()) {
			void this.#paint(ev.action, bridge.state, ev.payload.settings);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<T>): Promise<void> {
		const target = this.targetFor(ev.payload.settings);
		if (!target) return;

		const result = await bridge.invoke(target);
		if (!result.ok) {
			logger.warn(`invoke(${target}) failed: ${result.error ?? "unknown"}`);
			await ev.action.showAlert();
		}
	}

	#paintAll(state: TeamsState): void {
		for (const action of this.actions) {
			if (!action.isKey()) continue;
			void action
				.getSettings<T>()
				.then((settings) => this.#paint(action, state, settings))
				.catch((err: unknown) => logger.debug(`repaint skipped: ${String(err)}`));
		}
	}

	async #paint(action: KeyAction<T>, state: TeamsState, settings: T): Promise<void> {
		try {
			await action.setImage(toDataUri(this.draw(state, settings)));
		} catch (err) {
			logger.debug(`setImage failed: ${String(err)}`);
		}
	}
}
