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
import { renderInkColor, renderInkThickness, renderStripIdle, toDataUri, toolColor } from "../icons";
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

	/**
	 * Layout to apply to the slot, if the action needs one setting at runtime.
	 *
	 * The manifest names one too, but a dial that was already on the strip when
	 * the plugin restarted can be left on whatever it had, so it is set again
	 * on every appearance rather than trusted.
	 */
	protected layout(): string | undefined {
		return undefined;
	}

	override onWillAppear(ev: WillAppearEvent<T>): void {
		this.#visible++;
		if (!this.#unsubscribe) {
			this.#unsubscribe = bridge.subscribe((state) => this.#paintAll(state));
		}
		if (!ev.action.isDial()) return;

		const layout = this.layout();
		const dial = ev.action;
		if (layout === undefined) {
			void this.#paint(dial, bridge.state);
			return;
		}

		// Painted only once the layout is in place: a pixmap sent against the
		// previous layout has nowhere to land and the slot stays blank.
		void dial
			.setFeedbackLayout(layout)
			.catch((err) => logger.debug(`setFeedbackLayout failed: ${String(err)}`))
			.then(() => this.#paint(dial, bridge.state));
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
 * the cursor has neither, so each dial goes quiet rather than pretending.
 * ------------------------------------------------------------------------- */

/** How still the dial must be before the change behind it is sent. */
const SETTLE_MS = 220;

/** A spin can outrun Teams; past this the extra ticks are dropped. */
const MAX_PENDING = 25;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The drawing tools, and what each actually has to configure. */
const INK_TOOLS = ["ppt-cursor", "ppt-laser", "ppt-pen", "ppt-highlighter", "ppt-eraser"];
const HAS_COLOR = new Set(["ppt-laser", "ppt-pen", "ppt-highlighter"]);
const HAS_THICKNESS = new Set(["ppt-pen", "ppt-highlighter"]);

/** Teams' own range for the ink thickness slider. */
const THICKNESS_MIN = 1;
const THICKNESS_MAX = 6;

/**
 * The slot is drawn as one image, so the layout is a single full-canvas pixmap
 * rather than a built-in arrangement of icon and value boxes.
 */
const INK_LAYOUT = "layouts/ink.json";

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
				canvas: toDataUri(renderStripIdle("Thickness", pptLive(state) ? "no pen selected" : "no deck"))
			};
		}

		const target = this.#target(state, tool, this.pendingOn(dial));
		return {
			canvas: toDataUri(
				renderInkThickness(
					toolColor(tool, state.context[`ppt.color.${tool}`]),
					target,
					THICKNESS_MIN,
					THICKNESS_MAX
				)
			)
		};
	}

	protected override layout(): string {
		return INK_LAYOUT;
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
				canvas: toDataUri(renderStripIdle("Ink colour", pptLive(state) ? "no pen selected" : "no deck"))
			};
		}

		const current = state.context[`ppt.color.${tool}`] ?? "";
		const name = this.#preview(state, tool, current, this.pendingOn(dial));

		return { canvas: toDataUri(renderInkColor(toolColor(tool, name || current), name || current)) };
	}

	protected override layout(): string {
		return INK_LAYOUT;
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
