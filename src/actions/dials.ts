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
import { renderGlyph, renderTool, toDataUri } from "../icons";
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
@action({ UUID: "com.bad-duck.teamscontrol.ppt-slide-dial" })
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

/* ------------------------------------------------------------------------- *
 * Ink
 *
 * Colour and thickness are what a dial is genuinely better at than a key: one
 * is a ring of options and the other a bounded range, and neither is worth a
 * key each when there are fifteen colours.
 *
 * Both act on whichever drawing tool is selected, so neither dial has a tool
 * of its own to configure - pick the pen and they drive the pen. The tools
 * differ in what they even have: the laser has a colour and no thickness, and
 * the cursor and eraser have neither, so each dial goes quiet rather than
 * pretending.
 * ------------------------------------------------------------------------- */

/** The drawing tools, and what each actually has to configure. */
const INK_TOOLS = ["ppt-cursor", "ppt-laser", "ppt-pen", "ppt-highlighter", "ppt-eraser"];
const HAS_COLOR = new Set(["ppt-laser", "ppt-pen", "ppt-highlighter"]);
const HAS_THICKNESS = new Set(["ppt-pen", "ppt-highlighter"]);

/** Teams' own range for the ink thickness slider. */
const THICKNESS_MIN = 1;
const THICKNESS_MAX = 6;

/** The selected drawing tool, which is the one both ink dials act on. */
function activeInkTool(state: TeamsState): string | null {
	for (const tool of INK_TOOLS) if (state.states[tool]) return tool;
	return null;
}

/**
 * A dial whose whole gesture becomes a single request.
 *
 * Unlike a slide, where every step is a press Teams has to animate, colour and
 * thickness are each set in one call - so there is nothing to be gained by
 * sending the steps one at a time. The rotation accumulates, the strip shows
 * where it is heading, and one command goes out when the dial stops.
 */
abstract class InkDialAction extends TeamsDialAction {
	readonly #pending = new Map<string, number>();
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #busy = new Set<string>();

	/** The tool this dial can act on now, or null when it has nothing to change. */
	protected abstract toolFor(state: TeamsState): string | null;

	/** Issues the change for a whole gesture. */
	protected abstract commit(
		tool: string,
		pending: number,
		state: TeamsState
	): Promise<{ ok: boolean; error?: string }>;

	protected pendingOn(dial: DialAction<JsonObject>): number {
		return this.#pending.get(dial.id) ?? 0;
	}

	override onDialRotate(ev: DialRotateEvent<JsonObject>): void {
		const dial = ev.action;
		const id = dial.id;

		if (this.toolFor(bridge.state) === null) return;
		// Turning while the last gesture is still being applied would race it;
		// the flyout it opens is the slowest thing on this deck.
		if (this.#busy.has(id)) return;

		this.#pending.set(id, clamp((this.#pending.get(id) ?? 0) + ev.payload.ticks, -MAX_PENDING, MAX_PENDING));
		this.refresh(dial);

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

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		const timer = this.#timers.get(ev.action.id);
		if (timer) clearTimeout(timer);
		this.#timers.delete(ev.action.id);
		this.#pending.delete(ev.action.id);
		super.onWillDisappear(ev);
	}

	async #flush(dial: DialAction<JsonObject>): Promise<void> {
		const id = dial.id;
		const pending = this.#pending.get(id) ?? 0;
		if (pending === 0 || this.#busy.has(id)) return;

		const state = bridge.state;
		const tool = this.toolFor(state);
		if (tool === null) {
			this.#pending.set(id, 0);
			this.refresh(dial);
			return;
		}

		this.#busy.add(id);
		try {
			const result = await this.commit(tool, pending, state);
			if (!result.ok) logger.warn(`${this.manifestId ?? "dial"}: ${result.error ?? "unknown"}`);
		} finally {
			this.#busy.delete(id);
			// Spent either way: the state that arrives next is the truth, and a
			// backlog that survived a failure would fire again on the next turn.
			this.#pending.set(id, 0);
			this.refresh(dial);
		}
	}
}

/**
 * Sets how thick the selected tool draws, over Teams' own range of 1 to 6.
 *
 * Six detents against a six-step range is as close as this plugin gets to a
 * control that was designed for the hardware.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-ink-thickness-dial" })
export class InkThicknessDialAction extends InkDialAction {
	protected override toolFor(state: TeamsState): string | null {
		const tool = activeInkTool(state);
		return pptLive(state) && tool !== null && HAS_THICKNESS.has(tool) ? tool : null;
	}

	protected override draw(state: TeamsState, dial: DialAction<JsonObject>): Feedback {
		const tool = this.toolFor(state);
		if (tool === null) {
			return {
				title: "Thickness",
				icon: toDataUri(renderGlyph("pptHighlighter", "unavailable")),
				value: pptLive(state) ? "No pen" : "No deck",
				indicator: 0
			};
		}

		const pending = this.pendingOn(dial);
		const target = this.#target(state, tool, pending);

		return {
			title: pending === 0 ? "Thickness" : "Thickness →",
			icon: toDataUri(
				renderTool(tool, { available: true, active: true, color: state.context[`ppt.color.${tool}`] })
			),
			value: String(target),
			indicator: Math.round(((target - THICKNESS_MIN) / (THICKNESS_MAX - THICKNESS_MIN)) * 100)
		};
	}

	protected override commit(
		tool: string,
		pending: number,
		state: TeamsState
	): Promise<{ ok: boolean; error?: string }> {
		// Absolute rather than relative: the dial already knows where it is,
		// and a delta applied to a value that moved underneath it would land
		// somewhere neither of us meant.
		return bridge.invoke("ppt-ink-thickness", String(this.#target(state, tool, pending)));
	}

	#target(state: TeamsState, tool: string, pending: number): number {
		const now = Number.parseInt(state.context[`ppt.thickness.${tool}`] ?? "", 10);
		const from = Number.isFinite(now) ? now : THICKNESS_MIN;
		return clamp(from + pending, THICKNESS_MIN, THICKNESS_MAX);
	}
}

/**
 * Carousels the selected tool through its colours.
 *
 * The palette belongs to the tool rather than to Teams - the pen and the
 * highlighter offer different sets - and it can only be read while the flyout
 * is open, so the sidecar publishes whichever one it last saw. Until it has
 * seen one, the dial can say where it is but not where it is going.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-ink-color-dial" })
export class InkColorDialAction extends InkDialAction {
	protected override toolFor(state: TeamsState): string | null {
		const tool = activeInkTool(state);
		return pptLive(state) && tool !== null && HAS_COLOR.has(tool) ? tool : null;
	}

	protected override draw(state: TeamsState, dial: DialAction<JsonObject>): Feedback {
		const tool = this.toolFor(state);
		if (tool === null) {
			return {
				title: "Ink colour",
				icon: toDataUri(renderGlyph("pptPen", "unavailable")),
				value: pptLive(state) ? "No pen" : "No deck"
			};
		}

		const pending = this.pendingOn(dial);
		const current = state.context[`ppt.color.${tool}`] ?? "";
		const name = this.#preview(state, tool, current, pending);

		return {
			title: pending === 0 ? "Ink colour" : "Ink colour →",
			icon: toDataUri(renderTool(tool, { available: true, active: true, color: name || current })),
			value: name || current || "—"
		};
	}

	protected override commit(
		_tool: string,
		pending: number
	): Promise<{ ok: boolean; error?: string }> {
		// Relative, because only the open flyout knows the order, and it wraps.
		return bridge.invoke("ppt-ink-color", String(pending));
	}

	/** Where the dial is pointing, once a palette has been seen. */
	#preview(state: TeamsState, tool: string, current: string, pending: number): string {
		if (pending === 0) return current;

		const palette = (state.context[`ppt.palette.${tool}`] ?? "").split("|").filter(Boolean);
		if (palette.length === 0) return current;

		const at = palette.indexOf(current);
		const from = at < 0 ? 0 : at;
		return palette[((from + pending) % palette.length + palette.length) % palette.length];
	}
}
