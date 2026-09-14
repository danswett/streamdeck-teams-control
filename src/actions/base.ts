import {
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

	/** Last image drawn per key, so unchanged state costs nothing. */
	#painted = new Map<string, string>();

	/** Keys currently playing an animation; state repaints must not interrupt them. */
	readonly #animating = new Set<string>();

	/** Sidecar control key this action presses, or undefined if it never presses one. */
	protected abstract targetFor(settings: T): string | undefined;

	/** Produces the SVG for the current Teams state. */
	protected abstract draw(state: TeamsState): string;

	/**
	 * Plays a short animation on a key.
	 *
	 * Stream Deck has no animated-image support — `setImage` rejects GIF — so
	 * frames are pushed individually. Only runs on a press, so the cost is a
	 * brief burst on one key rather than anything continuous.
	 */
	protected async playFrames(
		action: KeyAction<T>,
		frame: (progress: number) => string,
		durationMs = 620,
		fps = 30
	): Promise<void> {
		const id = action.id;
		if (this.#animating.has(id)) return; // already popping; let it finish
		this.#animating.add(id);

		const count = Math.max(2, Math.round((durationMs / 1000) * fps));
		const interval = durationMs / count;

		try {
			for (let i = 1; i <= count; i++) {
				await action.setImage(toDataUri(frame(i / count)));
				await new Promise((resolve) => setTimeout(resolve, interval));
			}
		} catch (err) {
			logger.debug(`animation stopped: ${String(err)}`);
		} finally {
			this.#animating.delete(id);
			// Force the resting image back, bypassing the unchanged-frame cache.
			this.#painted.delete(id);
			await this.#paint(action, bridge.state);
		}
	}

	override onWillAppear(ev: WillAppearEvent<T>): void {
		this.#visible++;
		if (!this.#unsubscribe) {
			this.#unsubscribe = bridge.subscribe((state) => this.#paintAll(state));
		}
		if (ev.action.isKey()) void this.#paint(ev.action, bridge.state);
	}

	override onWillDisappear(ev: WillDisappearEvent<T>): void {
		this.#painted.delete(ev.action.id);
		this.#animating.delete(ev.action.id);
		this.#visible = Math.max(0, this.#visible - 1);
		if (this.#visible === 0 && this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
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
			if (action.isKey()) void this.#paint(action, state);
		}
	}

	async #paint(action: KeyAction<T>, state: TeamsState): Promise<void> {
		// Never overwrite a frame mid-animation.
		if (this.#animating.has(action.id)) return;

		const svg = this.draw(state);

		// Stream Deck redraws on every setImage, so skip identical frames.
		if (this.#painted.get(action.id) === svg) return;
		this.#painted.set(action.id, svg);

		try {
			await action.setImage(toDataUri(svg));
		} catch (err) {
			this.#painted.delete(action.id);
			logger.debug(`setImage failed: ${String(err)}`);
		}
	}
}
