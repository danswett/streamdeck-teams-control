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

	/** Redraws every dial of this action against the state already in hand. */
	protected repaintAll(): void {
		this.#paintAll(bridge.state);
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
 * Color and thickness are what a dial is genuinely better at than a key: one
 * is a ring of options and the other a bounded range, and neither is worth a
 * key each when there are fifteen colors.
 *
 * Both act on whichever drawing tool is selected, so neither dial has a tool
 * of its own to configure - pick the pen and they drive the pen. The laser has
 * a color and no thickness, and the cursor has neither, so each dial says so
 * rather than pretending.
 * ------------------------------------------------------------------------- */

/**
 * How still the dial must be before the change behind it is sent.
 *
 * Every commit opens a Teams flyout, so this is the difference between one
 * flyout for a whole gesture and one per click of the dial.
 */
const SETTLE_MS = 400;

/**
 * How long a dialled value stands if Teams never confirms it.
 *
 * Without a ceiling, a change Teams quietly refused would leave the slot
 * claiming an ink setting that was never applied.
 */
const CONFIRM_TIMEOUT_MS = 4000;

/**
 * How long to keep showing a dialled value after Teams first agrees with it.
 *
 * Letting go the moment a snapshot matches is too early. The snapshot taken
 * while the flyout was open carries the value from before the change - the
 * tools are unmounted then, so the sidecar reports the color it last cached -
 * and that one can land after the confirming snapshot. The result was the one
 * thing a dial must never do: the new color, then the old one, then the new
 * one again.
 */
const CONFIRM_HOLD_MS = 1500;

/**
 * The ink color the color dial has been turned to but Teams has not applied.
 *
 * The thickness dial draws its wedge in the ink color, and the two dials are
 * separate action instances with no state in common. Without this the wedge
 * stayed on the old color until the change committed, which is visible right
 * next to a slot that had already moved.
 */
const dialledColor = new Map<string, string>();

/** Dials to redraw when the dialled color changes under them. */
const inkListeners = new Set<() => void>();

function notifyInk(): void {
	for (const listener of inkListeners) listener();
}

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

/** Marks a turn made before the tool's palette had ever been seen. */
const BLIND = "step:";

/** The selected drawing tool, which is the one both ink dials act on. */
function activeInkTool(state: TeamsState): string | null {
	for (const tool of INK_TOOLS) if (state.states[tool]) return tool;
	return null;
}

/**
 * A dial that shows where it has been turned to at once, and catches Teams up
 * afterwards.
 *
 * Three things have to hold at the same time, and the obvious implementation
 * breaks all three:
 *
 *   - It must not lag. The strip is redrawn on the tick, never on the reply.
 *   - It must not flap. Teams is a long way behind a dial: the flyout has to
 *     open, the value has to be set, and a snapshot has to come back. Drawing
 *     from the reported state through that window shows the old value, then
 *     the new one, then the old one again as a stale snapshot lands.
 *   - It must not drop a turn. Refusing ticks while a change is in flight
 *     loses most of a quick gesture.
 *
 * So the dial keeps its own value from the moment it is touched, draws that,
 * and only lets go once a snapshot reports the same thing.
 */
abstract class InkDialAction extends TeamsDialAction {
	/** What the user turned to, held until Teams reports the same. */
	readonly #intent = new Map<string, { value: string; since: number; confirmedAt?: number }>();
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #busy = new Set<string>();

	/**
	 * The last tool this dial could act on.
	 *
	 * Selecting the cursor, or opening any flyout - which unmounts the whole
	 * slide-show subtree - leaves nothing selected that has ink. Keeping the
	 * last one means the slot still shows what it is about instead of going
	 * blank, which is what made the strip look dead until a flyout had been
	 * opened once.
	 */
	#lastTool: string | undefined;

	/** Whether a tool has the thing this dial changes. */
	protected abstract capable(tool: string): boolean;

	/** The value Teams currently reports. */
	protected abstract reported(state: TeamsState, tool: string): string;

	/** Applies a turn to the value on screen, giving the new one. */
	protected abstract step(from: string, ticks: number, state: TeamsState, tool: string): string;

	/** Sends the dialled value to Teams. */
	protected abstract send(
		tool: string,
		value: string,
		state: TeamsState
	): Promise<{ ok: boolean; error?: string }>;

	protected override layout(): string {
		return INK_LAYOUT;
	}

	/** The tool the slot is about: the live one, or the last one it was about. */
	protected displayTool(state: TeamsState): string | undefined {
		const active = activeInkTool(state);
		if (active !== null && this.capable(active)) {
			this.#lastTool = active;
			return active;
		}
		if (this.#lastTool !== undefined) return this.#lastTool;

		// Nothing this dial can act on has been selected yet, which is the
		// normal way a meeting starts - the cursor is the default tool. Show
		// whichever capable tool Teams has already reported a value for, so the
		// slot arrives with the real setting on it instead of waiting for the
		// user to go and pick a pen first.
		for (const tool of INK_TOOLS) {
			if (this.capable(tool) && this.reported(state, tool) !== "") return tool;
		}
		return undefined;
	}

	/** True when a turn would actually reach Teams right now. */
	protected canAct(state: TeamsState): boolean {
		const active = activeInkTool(state);
		return pptLive(state) && active !== null && this.capable(active);
	}

	/** What the slot should say: the dialled value if there is one, else Teams'. */
	protected shown(state: TeamsState, tool: string, dial: DialAction<JsonObject>): string {
		const intent = this.#intent.get(dial.id);
		if (intent === undefined) return this.reported(state, tool);

		const reported = this.reported(state, tool);
		const now = Date.now();

		if (reported === intent.value) {
			// Held briefly rather than dropped on the first agreement; see
			// CONFIRM_HOLD_MS for the stale snapshot this rides out.
			intent.confirmedAt ??= now;
			if (now - intent.confirmedAt > CONFIRM_HOLD_MS) {
				this.#intent.delete(dial.id);
				this.forget(tool);
			}
			return intent.value;
		}

		if (now - intent.since > CONFIRM_TIMEOUT_MS) {
			this.#intent.delete(dial.id);
			this.forget(tool);
			return reported;
		}
		return intent.value;
	}

	/** Told when a dialled value is adopted, so it can be shared with the other dial. */
	protected claim(_tool: string, _value: string): void {}

	/** Told when a dialled value is let go of. */
	protected forget(_tool: string): void {}

	/** True while the dial is showing something Teams has not confirmed. */
	protected pendingOn(dial: DialAction<JsonObject>): boolean {
		return this.#intent.has(dial.id);
	}

	override onDialRotate(ev: DialRotateEvent<JsonObject>): void {
		const state = bridge.state;
		const tool = this.displayTool(state);
		if (tool === undefined || !this.canAct(state)) return;

		const dial = ev.action;
		const id = dial.id;

		// Turns are always taken, including while a change is in flight; the
		// commit that is running will pick the newer value up when it finishes.
		const from = this.#intent.get(id)?.value ?? this.reported(state, tool);
		const next = this.step(from, ev.payload.ticks, state, tool);
		this.#intent.set(id, { value: next, since: Date.now() });
		this.claim(tool, next);
		this.refresh(dial);

		const timer = this.#timers.get(id);
		if (timer) clearTimeout(timer);
		this.#timers.set(
			id,
			setTimeout(() => {
				this.#timers.delete(id);
				void this.#commit(dial);
			}, SETTLE_MS)
		);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		const timer = this.#timers.get(ev.action.id);
		if (timer) clearTimeout(timer);
		this.#timers.delete(ev.action.id);
		this.#intent.delete(ev.action.id);
		super.onWillDisappear(ev);
	}

	async #commit(dial: DialAction<JsonObject>): Promise<void> {
		const id = dial.id;
		if (this.#busy.has(id)) return; // the one in flight will come back round

		const state = bridge.state;
		const tool = this.displayTool(state);
		const intent = this.#intent.get(id);
		if (tool === undefined || intent === undefined) return;
		if (intent.value === this.reported(state, tool)) return;

		this.#busy.add(id);
		try {
			const result = await this.send(tool, intent.value, state);
			if (!result.ok) {
				logger.warn(`${this.manifestId ?? "dial"}: ${result.error ?? "unknown"}`);
				// Drop the claim rather than leaving the slot asserting an ink
				// setting Teams never took.
				this.#intent.delete(id);
				this.forget(tool);
				this.refresh(dial);
			}
		} finally {
			this.#busy.delete(id);
		}

		// Turned again while that was in flight, so go round once more rather
		// than leaving the strip showing something that was never sent.
		const latest = this.#intent.get(id);
		if (latest !== undefined && latest.value !== intent.value) await this.#commit(dial);
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
	protected override capable(tool: string): boolean {
		return HAS_THICKNESS.has(tool);
	}

	protected override reported(state: TeamsState, tool: string): string {
		return state.context[`ppt.thickness.${tool}`] ?? "";
	}

	protected override step(from: string, ticks: number): string {
		const now = Number.parseInt(from, 10);
		const base = Number.isFinite(now) ? now : THICKNESS_MIN;
		return String(clamp(base + ticks, THICKNESS_MIN, THICKNESS_MAX));
	}

	protected override send(_tool: string, value: string): Promise<{ ok: boolean; error?: string }> {
		// Absolute, because the dial already knows where it is; a delta applied
		// to a value that moved underneath it would land somewhere else.
		return bridge.invoke("ppt-ink-thickness", value);
	}

	protected override draw(state: TeamsState, dial: DialAction<JsonObject>): Feedback {
		const tool = this.displayTool(state);
		if (tool === undefined) {
			return {
				canvas: toDataUri(renderStripIdle("Thickness", pptLive(state) ? "no pen selected" : "no deck"))
			};
		}

		const value = Number.parseInt(this.shown(state, tool, dial), 10);
		// The wedge follows the color dial the instant it moves, rather than
		// waiting for Teams to apply it: the two slots sit next to each other
		// and one lagging the other is obvious.
		const color = dialledColor.get(tool) ?? state.context[`ppt.color.${tool}`];

		return {
			canvas: toDataUri(
				renderInkThickness(
					toolColor(tool, color),
					Number.isFinite(value) ? value : THICKNESS_MIN,
					THICKNESS_MIN,
					THICKNESS_MAX
				)
			)
		};
	}

	override onWillAppear(ev: WillAppearEvent<JsonObject>): void {
		super.onWillAppear(ev);

		// Registered once and left: this is a singleton action that lives as
		// long as the plugin, and repainting when no dial is on the strip is a
		// no-op anyway.
		if (this.#listening) return;
		this.#listening = true;
		inkListeners.add(() => this.repaintAll());
	}

	#listening = false;
}

/**
 * Carousels the selected tool through its colors.
 *
 * The palette belongs to the tool - the pen and the highlighter offer
 * different sets - and it can only be read while the flyout is open, so the
 * sidecar publishes whichever one it last saw. Before it has seen any, a turn
 * is still accepted and sent as a plain step; the first one teaches it the
 * palette and everything after that can be previewed by name.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-ink-color-dial" })
export class InkColorDialAction extends InkDialAction {
	protected override capable(tool: string): boolean {
		return HAS_COLOR.has(tool);
	}

	protected override reported(state: TeamsState, tool: string): string {
		return state.context[`ppt.color.${tool}`] ?? "";
	}

	protected override step(from: string, ticks: number, state: TeamsState, tool: string): string {
		const palette = this.#palette(state, tool);
		if (palette.length === 0) {
			const already = from.startsWith(BLIND) ? Number.parseInt(from.slice(BLIND.length), 10) : 0;
			return `${BLIND}${(Number.isFinite(already) ? already : 0) + ticks}`;
		}

		const at = palette.indexOf(from);
		const base = at < 0 ? palette.indexOf(this.reported(state, tool)) : at;
		const n = palette.length;
		// Wraps, because a carousel that stops at the ends is not a carousel.
		return palette[(((base < 0 ? 0 : base) + ticks) % n + n) % n];
	}

	protected override send(
		tool: string,
		value: string,
		state: TeamsState
	): Promise<{ ok: boolean; error?: string }> {
		if (value.startsWith(BLIND)) {
			return bridge.invoke("ppt-ink-color", value.slice(BLIND.length));
		}

		const palette = this.#palette(state, tool);
		const from = palette.indexOf(this.reported(state, tool));
		const to = palette.indexOf(value);
		if (from < 0 || to < 0) return Promise.resolve({ ok: true });

		// Shortest way round the ring, so picking the color before the current
		// one is one step back rather than fourteen forward.
		const n = palette.length;
		let steps = to - from;
		if (steps > n / 2) steps -= n;
		else if (steps < -n / 2) steps += n;

		return bridge.invoke("ppt-ink-color", String(steps));
	}

	protected override draw(state: TeamsState, dial: DialAction<JsonObject>): Feedback {
		const tool = this.displayTool(state);
		if (tool === undefined) {
			return {
				canvas: toDataUri(renderStripIdle("Ink color", pptLive(state) ? "no pen selected" : "no deck"))
			};
		}

		const shown = this.shown(state, tool, dial);
		// A turn taken before the palette was known has no name to show yet, so
		// the slot keeps the color Teams last reported.
		const name = shown.startsWith(BLIND) ? this.reported(state, tool) : shown;

		return { canvas: toDataUri(renderInkColor(toolColor(tool, name), name)) };
	}

	protected override claim(tool: string, value: string): void {
		// Shared so the thickness dial can draw its wedge in the color being
		// turned to rather than the one Teams still has.
		if (!value.startsWith(BLIND)) dialledColor.set(tool, value);
		notifyInk();
	}

	protected override forget(tool: string): void {
		dialledColor.delete(tool);
		notifyInk();
	}

	#palette(state: TeamsState, tool: string): string[] {
		return (state.context[`ppt.palette.${tool}`] ?? "").split("|").filter(Boolean);
	}
}
