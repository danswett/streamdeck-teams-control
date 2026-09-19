/**
 * Dial actions, for the decks that have dials.
 *
 * A dial is not a key with a different shape. A key press is one discrete
 * request, and the key path already refuses a second while one is in flight;
 * a dial produces a stream of ticks, and everything behind this plugin is a UI
 * Automation walk that can take the better part of a second. Mapping one tick
 * to one press would queue a whole spin of them and go on driving the deck long
 * after the user stopped turning — the exact failure `#inFlight` was added to
 * stop on the keys.
 *
 * So turning and pressing are kept apart. Ticks accumulate into a local offset,
 * the touch strip shows where the dial thinks it is straight away, and the
 * presses that make that true are issued one at a time until the offset is
 * spent. Turning further while that runs just moves the target.
 */
import {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { bridge, type TeamsState } from "../bridge";
import { renderGlyph, toDataUri } from "../icons";
import { pptLive } from "./powerpoint";

const logger = streamDeck.logger.createScope("Dial");

/** One touch-strip slot's worth of values, keyed by the layout's item names. */
export type Feedback = Record<string, string | number>;

/**
 * Shared behaviour for every dial: one subscription per action class, fanned
 * out to whichever dials are currently on the strip.
 */
export abstract class TeamsDialAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	#unsubscribe: (() => void) | undefined;
	#visible = 0;

	/** Last payload drawn per dial, so unchanged state costs nothing. */
	readonly #painted = new Map<string, string>();

	/** The slot's contents for the current state. */
	protected abstract draw(state: TeamsState, dial: DialAction<T>): Feedback;

	override onWillAppear(ev: WillAppearEvent<T>): void {
		this.#visible++;
		if (!this.#unsubscribe) {
			this.#unsubscribe = bridge.subscribe((state) => this.#paintAll(state));
		}
		if (ev.action.isDial()) void this.#paint(ev.action, bridge.state);
	}

	override onWillDisappear(ev: WillDisappearEvent<T>): void {
		this.#painted.delete(ev.action.id);
		this.#visible = Math.max(0, this.#visible - 1);
		if (this.#visible === 0 && this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
	}

	/**
	 * Redraws one dial against the state already in hand.
	 *
	 * Turning moves what the slot should say without anything having changed in
	 * Teams yet, so a rotation has to ask for this itself.
	 */
	protected refresh(dial: DialAction<T>): void {
		void this.#paint(dial, bridge.state);
	}

	#paintAll(state: TeamsState): void {
		for (const a of this.actions) if (a.isDial()) void this.#paint(a, state);
	}

	async #paint(dial: DialAction<T>, state: TeamsState): Promise<void> {
		const payload = this.draw(state, dial);

		// Stream Deck redraws on every setFeedback, so skip identical frames.
		const signature = JSON.stringify(payload);
		if (this.#painted.get(dial.id) === signature) return;
		this.#painted.set(dial.id, signature);

		try {
			await dial.setFeedback(payload);
		} catch (err) {
			this.#painted.delete(dial.id);
			logger.debug(`setFeedback failed: ${String(err)}`);
		}
	}
}

/** How still the dial must be before the presses behind it are sent. */
const SETTLE_MS = 220;

/**
 * A spin can outrun Teams by a long way. Past this the extra ticks are dropped
 * rather than queued: arriving at slide 40 a minute after the user stopped
 * turning is worse than not going there at all.
 */
const MAX_PENDING = 25;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Moves through a PowerPoint Live deck.
 *
 * Turn for previous and next, press for grid view, touch to sync back to the
 * presenter. The slot shows the position in the deck, and the bar shows how far
 * through it you are — the one genuinely continuous thing this plugin has, and
 * the reason a dial is worth having at all.
 */
@action({ UUID: "com.bad-duck.teamscontrol.dial-slide" })
export class SlideDialAction extends TeamsDialAction {
	/** Slides asked for but not yet pressed, per dial. */
	readonly #pending = new Map<string, number>();
	readonly #timers = new Map<string, NodeJS.Timeout>();

	/** Dials whose backlog is already being walked down. */
	readonly #flushing = new Set<string>();

	protected override draw(state: TeamsState, dial: DialAction<JsonObject>): Feedback {
		const live = pptLive(state);
		const pending = this.#pending.get(dial.id) ?? 0;

		const slide = Number.parseInt(state.context["ppt.slide"] ?? "", 10);
		const total = Number.parseInt(state.context["ppt.slides"] ?? "", 10);

		if (!live || !Number.isFinite(slide)) {
			return {
				title: "Slide",
				icon: toDataUri(renderGlyph("pptSlide", "unavailable")),
				value: live ? "—" : "No deck",
				indicator: 0
			};
		}

		// Where the dial has been turned to, not where Teams has caught up to.
		const target = Number.isFinite(total)
			? clamp(slide + pending, 1, total)
			: Math.max(1, slide + pending);

		return {
			title: pending === 0 ? "Slide" : "Slide →",
			icon: toDataUri(renderGlyph("pptSlide", pending === 0 ? "on" : "accent")),
			value: Number.isFinite(total) ? `${target} / ${total}` : String(target),
			indicator: Number.isFinite(total) && total > 0 ? Math.round((target / total) * 100) : 0
		};
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		const timer = this.#timers.get(ev.action.id);
		if (timer) clearTimeout(timer);
		this.#timers.delete(ev.action.id);
		this.#pending.delete(ev.action.id);
		super.onWillDisappear(ev);
	}

	override onDialRotate(ev: DialRotateEvent<JsonObject>): void {
		if (!pptLive(bridge.state)) return;

		const dial = ev.action;
		const id = dial.id;

		this.#pending.set(id, clamp((this.#pending.get(id) ?? 0) + ev.payload.ticks, -MAX_PENDING, MAX_PENDING));
		this.refresh(dial);

		// Restarted on every tick, so a continuous spin sends nothing until it
		// stops. One press per tick during the spin would arrive minutes late.
		const timer = this.#timers.get(id);
		if (timer) clearTimeout(timer);
		this.#timers.set(
			id,
			setTimeout(() => {
				this.#timers.delete(id);
				void this.#flush(dial);
			}, SETTLE_MS)
		);
	}

	/** Press opens grid view, which both roles have. */
	override async onDialDown(ev: DialDownEvent<JsonObject>): Promise<void> {
		await this.#press(ev.action, "ppt-grid");
	}

	/** Touch returns an attendee to the presenter's slide; a no-op for a presenter. */
	override async onTouchTap(ev: TouchTapEvent<JsonObject>): Promise<void> {
		await this.#press(ev.action, "ppt-sync");
	}

	async #press(dial: DialAction<JsonObject>, target: string): Promise<void> {
		const state = bridge.state;
		if (!state.inMeeting || !(state.available[target] ?? false)) return;

		const result = await bridge.invoke(target);
		if (!result.ok) logger.warn(`invoke(${target}) failed: ${result.error ?? "unknown"}`);
	}

	/**
	 * Walks the backlog down one press at a time.
	 *
	 * Sequential on purpose: the sidecar runs one thing at a time anyway, and
	 * firing them together would only fill its queue with work the user can no
	 * longer see the point of.
	 */
	async #flush(dial: DialAction<JsonObject>): Promise<void> {
		const id = dial.id;
		if (this.#flushing.has(id)) return;
		this.#flushing.add(id);

		try {
			for (;;) {
				const pending = this.#pending.get(id) ?? 0;
				if (pending === 0) break;

				const step = pending > 0 ? 1 : -1;
				const result = await bridge.invoke(step > 0 ? "ppt-next" : "ppt-prev");

				// Spent whether or not it worked, so a failing control cannot
				// spin here forever.
				this.#pending.set(id, (this.#pending.get(id) ?? 0) - step);

				if (!result.ok) {
					logger.warn(`slide dial gave up: ${result.error ?? "unknown"}`);
					this.#pending.set(id, 0);
					break;
				}
				this.refresh(dial);
			}
		} finally {
			this.#flushing.delete(id);
			this.refresh(dial);
		}
	}
}
