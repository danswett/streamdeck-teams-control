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
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { bridge, type TeamsState } from "../bridge";
import { renderInkColor, renderInkThickness, renderSlideJump, renderStripIdle, renderStripNext, renderTimer, toPixmap, toolColor } from "../icons";
import { pptLive } from "./powerpoint";

const logger = streamDeck.logger.createScope("Dial");

/** One touch-strip slot's worth of values, keyed by the layout's item names. */
export type Feedback = Record<string, string | number>;

/**
 * Shared behavior for every dial: one subscription per action class, fanned
 * out to whichever dials are currently on the strip.
 */
export abstract class TeamsDialAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	#unsubscribe: (() => void) | undefined;
	#visible = 0;

	/**
	 * Fingerprint of the last payload drawn per dial, so unchanged state costs
	 * nothing.
	 *
	 * A fingerprint rather than the payload itself, because a slide thumbnail
	 * is around 30 KB of base64 and keeping a second copy of every one of them
	 * alive - for no reason beyond comparing it to the next - is the kind of
	 * thing that goes unnoticed until a profile has a dozen dials on it. The
	 * length is carried alongside the hash so a collision has to match both.
	 */
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
			// Replays the current state straight away, so this paints before
			// the layout below has been applied. That paint is thrown away by
			// Stream Deck; the cache it leaves behind is the problem, and is
			// cleared before the real one.
			this.#unsubscribe = bridge.subscribe((state) => this.#paintAll(state));
		}
		if (!ev.action.isDial()) return;

		const layout = this.layout();
		const dial = ev.action;
		logger.debug(`${this.manifestId ?? "dial"} appeared on ${dial.id}, layout ${layout ?? "(manifest)"}`);
		if (layout === undefined) {
			void this.#paint(dial, bridge.state);
			return;
		}

		/*
			Painted only once the layout is in place: a pixmap sent against the
			previous layout has nowhere to land and the slot stays blank.

			The cache has to be dropped first. Subscribing above paints
			immediately, against the old layout, and records what it drew - so
			this paint, computing the same picture from the same state, was
			skipped as a duplicate and the slot never received anything under
			the layout that could actually show it. It only appeared once
			something in Teams changed and produced a different picture, which
			is exactly how it looked: blank after a restart until a key was
			pressed or a tool was picked.
		*/
		void dial
			.setFeedbackLayout(layout)
			.catch((err) => logger.warn(`setFeedbackLayout failed: ${String(err)}`))
			.then(() => {
				this.#painted.delete(dial.id);
				return this.#paint(dial, bridge.state);
			});
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
		const rendered = JSON.stringify(payload);
		const signature = fingerprint(rendered);
		if (this.#painted.get(dial.id) === signature) return;
		this.#painted.set(dial.id, signature);

		try {
			await dial.setFeedback(payload);
			logger.debug(`${this.manifestId ?? "dial"} painted ${rendered.length} bytes`);
		} catch (err) {
			this.#painted.delete(dial.id);
			logger.warn(`setFeedback failed: ${String(err)}`);
		}
	}
}

/** FNV-1a, plus the length, so two payloads have to agree on both to collide. */
function fingerprint(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${text.length}:${(hash >>> 0).toString(36)}`;
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

/**
 * The tools that change what is on the slide.
 *
 * Holding one of these is the clearest sign the picture is about to go stale,
 * so a live thumbnail watches closely while one is selected. The laser is left
 * out deliberately: it moves constantly and leaves nothing behind, so chasing
 * it would spend the budget redrawing a dot. The cursor marks nothing at all.
 */
const MARKS_SLIDE = new Set(["ppt-pen", "ppt-highlighter", "ppt-eraser"]);

/** How each tool is named on the strip when it has nothing to offer a dial. */
const TOOL_LABEL: Record<string, string> = {
	"ppt-cursor": "Cursor",
	"ppt-laser": "Laser",
	"ppt-pen": "Pen",
	"ppt-highlighter": "Highlighter",
	"ppt-eraser": "Eraser"
};

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
/**
 * Whether presenter view is open.
 *
 * Read off the "hide presenter view" control, whose state tracks the presence
 * of the notes pane - so true means the pane is there and presenter view is
 * showing, which is the opposite of how the control's name reads. The filmstrip
 * lives in that pane, and the filmstrip is the only thing in the tree that
 * addresses a slide by number.
 */
function presenterViewOpen(state: TeamsState): boolean {
	return state.states["ppt-hide-presenter-view"] ?? false;
}

/**
 * Whether Teams' grid of slides is up.
 *
 * Its tiles are slide-sized list items carrying Invoke, exactly like the
 * filmstrip's, so the dial can reach a slide through either one.
 */
function gridOpen(state: TeamsState): boolean {
	return state.states["ppt-grid"] ?? false;
}

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

	/**
	 * The tool the slot is about, or undefined when it has nothing to show.
	 *
	 * Knowing the selected tool has no thickness is not the same as not
	 * knowing what is selected. The laser has a color and no thickness, and the
	 * cursor has neither, so those dials go quiet rather than showing some
	 * other tool's setting and inviting a turn that would do nothing.
	 *
	 * Reporting nothing at all is the other case: Teams unmounts the whole
	 * slide-show subtree while any flyout is open, and the slot should hold
	 * what it was showing instead of blinking out every time one opens.
	 */
	protected displayTool(state: TeamsState): string | undefined {
		const active = activeInkTool(state);
		if (active !== null) {
			if (!this.capable(active)) return undefined;
			this.#lastTool = active;
			return active;
		}
		return this.#lastTool;
	}

	/** Why the slot has nothing to show, in the user's terms. */
	protected idleReason(state: TeamsState): string {
		if (!pptLive(state)) return "no deck";

		const active = activeInkTool(state);
		if (active === null) return "no pen selected";
		return `${TOOL_LABEL[active] ?? "this tool"} has none`;
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
				canvas: toPixmap(renderStripIdle("Thickness", this.idleReason(state)))
			};
		}

		const value = Number.parseInt(this.shown(state, tool, dial), 10);
		// The wedge follows the color dial the instant it moves, rather than
		// waiting for Teams to apply it: the two slots sit next to each other
		// and one lagging the other is obvious.
		const color = dialledColor.get(tool) ?? state.context[`ppt.color.${tool}`];

		return {
			canvas: toPixmap(
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
				canvas: toPixmap(renderStripIdle("Ink color", this.idleReason(state)))
			};
		}

		const shown = this.shown(state, tool, dial);
		// A turn taken before the palette was known has no name to show yet, so
		// the slot keeps the color Teams last reported.
		const name = shown.startsWith(BLIND) ? this.reported(state, tool) : shown;

		return { canvas: toPixmap(renderInkColor(toolColor(tool, name), name)) };
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

/* ------------------------------------------------------------------------- *
 * Slide thumbnails
 *
 * PowerPoint Live publishes the name of a slide and nothing else, so the
 * picture comes off the Teams window itself - see SlideCapture in the sidecar.
 * The source is the presenter-view filmstrip rather than the slide surface:
 * its items are already 16:9 and the selected one is the current slide, which
 * makes "the next slide" simply the one after it. Presenter view therefore has
 * to be open for either of these to show anything.
 *
 * Capturing is not free, so it happens when the slide changes rather than on
 * every snapshot, and the last picture is held while nothing moves.
 * ------------------------------------------------------------------------- */

/** How long to sit on a slide change before capturing it. */
const CAPTURE_SETTLE_MS = 250;

/**
 * How long to leave a slide alone after a capture of it failed.
 *
 * A failure is usually presenter view being closed, which is a thing the user
 * fixes rather than a thing that fixes itself - so retrying is worth doing, but
 * not on every snapshot. Without this a presenter working without the filmstrip
 * open would have the plugin asking Teams for a picture several times a second
 * for the length of the meeting.
 */
const CAPTURE_RETRY_MS = 5000;

/**
 * How many frames to dissolve one slide into the next over, and how long each
 * one stays up.
 *
 * Six frames at 40ms is a quarter-second fade. The frames are JPEG and about
 * 6 KiB each, so a transition costs roughly 40 KiB on the wire - cheap enough
 * to be worth it, but not so many frames that a fast clicker queues them up.
 */
const FADE_FRAMES = 6;
const FADE_FRAME_MS = 40;

/**
 * How often to re-read a slide that is still on screen.
 *
 * A build fires without moving the deck on, so the live slot cannot wait for
 * the slide number to change. A capture costs about 80ms, which is why this
 * runs fast only while something is demonstrably happening and idles slowly
 * the rest of the time.
 */
const POLL_FAST_MS = 700;
const POLL_IDLE_MS = 3000;
const POLL_ACTIVE_FOR_MS = 12_000;

/**
 * How often to re-read the slide while a marking tool is selected.
 *
 * Ink appears under the presenter's hand, so this is the one case where the
 * thumbnail is being watched as it changes rather than glanced at. It is the
 * most expensive rate by some way, which is why it is tied to a tool being
 * held rather than to the deck being up.
 */
const POLL_INK_MS = 250;

/**
 * How long to hold the dialled slide after asking Teams to go there.
 *
 * Teams reports the move well before the new slide has been captured, so the
 * number stays up until the deck agrees rather than until the request was sent.
 * The timeout is only there so a jump that never lands cannot pin the slot.
 */
const JUMP_CONFIRM_MS = 4000;

/** The sidecar target that goes straight to a slide; see TeamsClient.GoToSlide. */
const GOTO_SLIDE = "ppt-goto-slide";

/** The sidecar target that toggles Teams' own grid of slides. */
const GRID_VIEW = "ppt-grid";


/**
 * Whether this slot may read the slide at all.
 *
 * Off unless the user turns it on. Every other action in this plugin reads
 * which controls exist and what state they are in; this one reads the content
 * of the meeting, and that is not a thing to start doing on someone's behalf
 * because they happened to install a plugin for the mute button.
 */
type ThumbSettings = {
	capture?: boolean;
};

abstract class SlideThumbDialAction extends TeamsDialAction<ThumbSettings & JsonObject> {
	/** Which slide to show; sent straight to the sidecar. */
	protected abstract readonly which: "current" | "next";

	/**
	 * Whether this slot changes while the slide number does not.
	 *
	 * The live surface does - a build firing repaints it without moving the
	 * deck on - so it has to be watched. A filmstrip thumbnail of a slide that
	 * has not been reached yet does not.
	 */
	protected abstract readonly live: boolean;

	/** The picture on the strip now, held while nothing changes. */
	#image: string | undefined;

	/** What the deck looked like when that picture was taken. */
	#capturedAt: string | undefined;

	/** Set once the deck runs out of slides, so the slot says so. */
	#ended = false;

	/** Why there is no picture, when the sidecar gave a reason worth showing. */
	#reason: string | undefined;

	/** The slide's name, shown when there is no picture of it to be had. */
	#slideName: string | undefined;

	/** The slide a pending capture should be labeled with. */
	#wanted: string | undefined;

	/** When a capture last failed, so retries are paced rather than spun. */
	#failedAt: string | undefined;
	#failedWhen = 0;

	/** When the picture last actually changed, which sets the polling rate. */
	#changedAt = 0;

	#timer: NodeJS.Timeout | undefined;
	#fade: NodeJS.Timeout | undefined;
	#busy = false;

	protected override layout(): string {
		return INK_LAYOUT;
	}

	/** Which dials have been allowed to read the slide, by dial id. */
	readonly #allowed = new Map<string, boolean>();

	override onWillAppear(ev: WillAppearEvent<ThumbSettings & JsonObject>): void {
		this.#allow(ev.action.id, ev.payload.settings.capture === true);
		super.onWillAppear(ev);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ThumbSettings & JsonObject>): void {
		const was = this.#on();
		this.#allow(ev.action.id, ev.payload.settings.capture === true);

		// Everything in flight is torn down, not just the picture. A capture
		// armed before the box was unticked would otherwise still fire - up to
		// CAPTURE_RETRY_MS later - and read the slide after permission for it
		// had been withdrawn.
		if (was && !this.#on()) this.#standDown();
		this.repaintAll();
	}

	/** Stops reading the slide, and forgets what was read. */
	#standDown(): void {
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#fade) clearTimeout(this.#fade);
		this.#timer = undefined;
		this.#fade = undefined;
		this.#stopWatching();

		this.#wanted = undefined;
		this.#image = undefined;
		this.#clearJump();

		// The sidecar keeps the last frame to fade out of, so ask it to drop
		// that too rather than leaving a slide resident in a process that
		// outlives the decision.
		bridge.forget(this.which);
	}

	/**
	 * Records whether a dial may read the slide, and says so out loud.
	 *
	 * Reading the content of a meeting is the one thing here worth being able
	 * to account for afterwards, so a change of mind is logged at info rather
	 * than debug - "was this ever on, and when" should be answerable from an
	 * ordinary log. Unchanged settings are not logged, because Stream Deck
	 * replays them on every profile switch.
	 */
	#allow(id: string, allowed: boolean): void {
		if (this.#allowed.get(id) === allowed) return;
		this.#allowed.set(id, allowed);
		logger.info(`${this.which} slide capture ${allowed ? "enabled" : "disabled"}`);
	}

	/** Whether any dial on the strip has been allowed to read the slide. */
	#on(): boolean {
		for (const a of this.actions) if (a.isDial() && this.#allowed.get(a.id) === true) return true;
		return false;
	}

	/**
	 * Whether turning this dial moves through the deck.
	 *
	 * Only the current-slide slot does: dialling the next slide somewhere would
	 * be dialling the current one with an off-by-one.
	 */
	protected jumps(): boolean {
		return false;
	}

	/** The slide the dial has been turned to, while it is being turned. */
	#jump: number | undefined;

	/** When the jump was committed, so a stale snapshot does not clear it early. */
	#jumpSentAt = 0;

	#jumpTimer: NodeJS.Timeout | undefined;

	/** Forgets a dialled slide, whether or not it was ever sent. */
	#clearJump(): void {
		if (this.#jumpTimer) clearTimeout(this.#jumpTimer);
		this.#jumpTimer = undefined;
		this.#jump = undefined;
		this.#jumpSentAt = 0;
	}

	override onDialRotate(ev: DialRotateEvent<ThumbSettings & JsonObject>): void {
		if (!this.jumps() || this.#allowed.get(ev.action.id) !== true) return;

		const state = bridge.state;
		if (!pptLive(state)) return;

		/*
			Nothing in the tree addresses a slide by number unless presenter
			view is open. Its filmstrip is the only list that can be walked
			without committing: the grid's tiles navigate and close the grid the
			moment they are selected, and programmatic focus on them paints
			nothing at all, so the grid cannot show where the dial is pointing.
			With neither open the remaining slide controls are Next and
			Previous, and walking there with those is not the same thing - Next
			advances the build, not the slide.

			So the dial goes quiet unless the filmstrip is there to aim at. The
			thumbnail carries on: that comes off the live slide surface, which
			needs none of this.
		*/
		if (!presenterViewOpen(state) || gridOpen(state)) {
			logger.debug("slide dial turned without the filmstrip; nothing to aim at");
			return;
		}

		const total = Number(state.context["ppt.slides"] ?? 0);
		const now = Number(state.context["ppt.slide"] ?? 0);
		if (!Number.isFinite(total) || total < 1 || now < 1) return;

		// Every turn is taken, including while one is in flight: the dial is
		// never allowed to lag, and the commit below picks up wherever it
		// finishes up.
		const from = this.#jump ?? now;
		this.#jump = Math.min(total, Math.max(1, from + ev.payload.ticks));
		this.repaintAll();

		if (this.#jumpTimer) clearTimeout(this.#jumpTimer);
		this.#jumpTimer = setTimeout(() => {
			this.#jumpTimer = undefined;
			void this.#goto();
		}, SETTLE_MS);
	}

	/**
	 * Pressing opens the deck as a grid, and closes it again on the slide the
	 * dial is pointing at.
	 *
	 * Turning inside the grid is the same gesture as turning outside it - the
	 * number counts on the strip and the jump is made once the dial settles -
	 * so by the time the press lands the deck is usually already there. Pressing
	 * before it settles commits straight away rather than making the user wait
	 * out the timer.
	 *
	 * Not gated on the thumbnail setting: this is an ordinary meeting control
	 * that reads nothing, and it needs neither presenter view nor a picture.
	 */
	/**
	 * Pressing shows the deck as a grid, and pressing again puts it away.
	 *
	 * The grid is a view, not something the dial drives: its tiles navigate and
	 * close it the moment they are selected, so there is no way to point at one
	 * without going there. Turning is disabled while it is up for that reason.
	 *
	 * Not gated on the thumbnail setting: this is an ordinary meeting control
	 * that reads nothing, and it needs neither presenter view nor a picture.
	 */
	override async onDialDown(ev: DialDownEvent<ThumbSettings & JsonObject>): Promise<void> {
		if (!this.jumps()) return;
		if (!pptLive(bridge.state)) return;

		const res = await bridge.invoke(GRID_VIEW);
		if (!res.ok) {
			logger.warn(`could not toggle grid view: ${res.error ?? "no reason given"}`);
			await ev.action.showAlert();
		}
	}

	async #goto(): Promise<void> {
		const wanted = this.#jump;
		if (wanted === undefined) return;

		if (Number(bridge.state.context["ppt.slide"] ?? 0) === wanted) {
			// Already there - turned away and back again.
			this.#jump = undefined;
			this.repaintAll();
			return;
		}

		this.#jumpSentAt = Date.now();
		const res = await bridge.invoke(GOTO_SLIDE, String(wanted));
		if (res.ok) return;

		// Nothing happened, so stop claiming it did.
		logger.warn(`could not go to slide ${wanted}: ${res.error ?? "no reason given"}`);
		this.#jump = undefined;
		this.repaintAll();
	}

	/**
	 * Drops the dialled slide once Teams has actually moved to it.
	 *
	 * Held until then rather than cleared on send, because the capture of the
	 * new slide takes a moment longer still - and clearing early would put the
	 * *old* slide back on the strip in between, which reads as the jump having
	 * failed.
	 */
	#settleJump(state: TeamsState): void {
		if (this.#jump === undefined) return;

		// The grid replaces the slide surface, so a pending number cannot be
		// confirmed while it is up - and it is not actionable either. Drop it.
		if (gridOpen(state)) {
			this.#clearJump();
			return;
		}

		if (this.#jumpSentAt === 0) return;

		const now = Number(state.context["ppt.slide"] ?? 0);
		if (now === this.#jump || Date.now() - this.#jumpSentAt > JUMP_CONFIRM_MS) {
			this.#jump = undefined;
			this.#jumpSentAt = 0;
		}
	}

	protected override draw(state: TeamsState, dial: DialAction<ThumbSettings & JsonObject>): Feedback {
		if (this.#allowed.get(dial.id) !== true) {
			return { canvas: toPixmap(renderStripIdle(this.#title(), "turn on in settings")) };
		}

		this.#settleJump(state);

		// Asking from draw keeps the two in step: every repaint is a chance to
		// notice the deck moved, and the capture that follows repaints again.
		this.#considerCapture(state);

		if (this.#jump !== undefined) {
			return {
				canvas: toPixmap(
					renderSlideJump(this.#image, this.#jump, Number(state.context["ppt.slides"] ?? 0))
				)
			};
		}

		if (this.#image !== undefined) return { canvas: this.#image };

		if (this.#ended) return { canvas: toPixmap(renderStripIdle("End of show", "no slide after this one")) };

		// No picture, but a name. The ordinary case for the next slide once the
		// filmstrip has scrolled past it.
		if (this.#slideName !== undefined) {
			return { canvas: toPixmap(renderStripNext(this.#slideName, this.which === "next" ? "NEXT" : "NOW")) };
		}

		return {
			canvas: toPixmap(
				renderStripIdle(
					this.#title(),
					pptLive(state) ? (this.#reason ?? "waiting for the slide") : "no deck"
				)
			)
		};
	}

	#title(): string {
		return this.which === "next" ? "Next slide" : "Current slide";
	}

	/** Where the deck is, as a value that changes exactly when the picture must. */
	#position(state: TeamsState): string | undefined {
		if (!pptLive(state)) return undefined;
		const slide = state.context["ppt.slide"];
		return slide === undefined ? undefined : `${slide}/${state.context["ppt.slides"] ?? ""}`;
	}

	#considerCapture(state: TeamsState): void {
		const at = this.#position(state);

		if (at === undefined) {
			// The deck stopped. Drop the picture rather than leaving a slide on
			// the strip after the presentation has ended, and have the sidecar
			// drop its copy too.
			const had = this.#image !== undefined || this.#capturedAt !== undefined;
			this.#stopWatching();
			this.#image = undefined;
			this.#capturedAt = undefined;
			this.#failedAt = undefined;
			this.#wanted = undefined;
			this.#slideName = undefined;
			this.#ended = false;
			this.#reason = undefined;
			this.#clearJump();
			if (had) bridge.forget(this.which);
			return;
		}

		this.#at = at;

		const inking = MARKS_SLIDE.has(activeInkTool(state) ?? "");
		if (inking !== this.#inking) {
			// Re-armed rather than left to the next tick: picking up a pen has
			// to speed the slot up now, not up to three seconds from now.
			this.#inking = inking;
			this.#stopWatching();
		}
		this.#watch();

		if (at === this.#capturedAt || this.#busy || this.#fade !== undefined) return;

		this.#wanted = at;
		if (this.#timer !== undefined) return;

		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const target = this.#wanted;
			if (target !== undefined) void this.#capture(target, true);
		}, this.#waitFor(at));
	}

	/** The deck's position as of the last snapshot, for the watch loop to use. */
	#at: string | undefined;

	/** Whether a drawing tool is selected, which means ink may be appearing. */
	#inking = false;

	#loop: NodeJS.Timeout | undefined;

	/**
	 * Keeps a live slot re-reading the slide on its own clock.
	 *
	 * This cannot hang off the state subscription the way a slide change does.
	 * Drawing on a slide changes nothing Teams reports - not the slide number,
	 * not any control's state - so no snapshot arrives, and a slot waiting for
	 * one would sit on a picture without the ink until the deck moved. The same
	 * goes for a build firing. So the slot asks, rather than waiting to be told.
	 */
	#watch(): void {
		if (!this.live || this.#loop !== undefined) return;

		const tick = (): void => {
			// Nothing on the strip to paint, or permission withdrawn. The loop
			// ends here rather than being canceled from onWillDisappear,
			// because a snapshot only arrives when something in Teams changes -
			// so a loop stopped on the way out might have nothing to start it
			// again.
			if (!this.#on()) {
				this.#loop = undefined;
				return;
			}

			this.#loop = setTimeout(tick, this.#interval());
			const at = this.#at;
			if (at === undefined || this.#busy || this.#fade !== undefined) return;
			void this.#capture(at, false);
		};

		this.#loop = setTimeout(tick, this.#interval());
	}

	#stopWatching(): void {
		if (this.#loop) clearTimeout(this.#loop);
		this.#loop = undefined;
	}

	/**
	 * How long to leave it before re-reading a slide that has not moved.
	 *
	 * Ink and builds both arrive without warning, so the only way to catch them
	 * is to look. Looking costs about 80ms, so it is done often while there is
	 * reason to think the slide is changing - a pen in hand, or something that
	 * moved in the last few seconds - and rarely the rest of the time.
	 */
	#interval(): number {
		if (this.#inking) return POLL_INK_MS;
		return Date.now() - this.#changedAt < POLL_ACTIVE_FOR_MS ? POLL_FAST_MS : POLL_IDLE_MS;
	}

	#waitFor(at: string): number {
		// Teams animates a slide change, so capturing the instant the number
		// moves catches the transition rather than the slide.

		if (at === this.#failedAt) {
			const since = Date.now() - this.#failedWhen;
			if (since < CAPTURE_RETRY_MS) return CAPTURE_RETRY_MS - since;
		}
		return CAPTURE_SETTLE_MS;
	}

	async #capture(at: string, moved: boolean): Promise<void> {
		// Checked again here rather than only where captures are scheduled, so
		// every path into reading the slide fails closed.
		if (!this.#on() || this.#busy) return;
		this.#busy = true;
		try {
			// Only a change worth watching is faded; a poll that found a build
			// half-drawn should land immediately rather than dissolve into it.
			const shot = await bridge.capture(this.which, moved ? FADE_FRAMES : 0);

			if (shot.end) {
				// Off the end of the deck. Unlike a failure this has to clear
				// the picture: the slide it shows is one the presenter has
				// already moved past, and leaving it there is a lie.
				this.#image = undefined;
				this.#capturedAt = at;
				this.#ended = true;
				this.#failedAt = undefined;
				this.repaintAll();
				return;
			}

			if (!shot.ok || shot.image === undefined) {
				/*
					A stale picture is only honest while the deck has not moved.
					Once it has, whatever is on the strip is a slide the
					presenter has already left - the same complaint as running
					off the end of the deck - so the slot goes back to saying
					what it is rather than showing the wrong slide.
				*/
				if (moved) {
					this.#image = undefined;
					this.#reason = shot.error;
					this.#slideName = shot.name;

					// A name without a picture is the ordinary case for the
					// next slide, not a failure: it is off the end of the
					// filmstrip and will not come back into view by waiting. So
					// the position counts as drawn, and nothing retries it.
					if (this.#slideName !== undefined) this.#capturedAt = at;

					this.repaintAll();
				}

				if (this.#slideName === undefined) {
					// Remembered so the next snapshot does not immediately ask
					// again; the slide is retried, just not on every tick.
					this.#failedAt = at;
					this.#failedWhen = Date.now();
				}
				logger.debug(`${this.which} slide: ${shot.error ?? "no image"}`);
				return;
			}

			this.#failedAt = undefined;
			this.#ended = false;
			this.#reason = undefined;
			this.#slideName = undefined;
			this.#capturedAt = at;

			// An unchanged slide is the common case when polling, and repainting
			// it would only spend bytes on the strip to draw what is already there.
			if (shot.image === this.#image) return;

			this.#changedAt = Date.now();
			this.#play(shot.frames ?? [], shot.image);
		} finally {
			this.#busy = false;
		}
	}

	/** Runs the fade frames out, then settles on the capture itself. */
	#play(frames: string[], final: string): void {
		if (frames.length === 0) {
			this.#image = final;
			this.repaintAll();
			return;
		}

		let i = 0;
		const step = (): void => {
			if (i < frames.length) {
				this.#image = frames[i++];
				this.repaintAll();
				this.#fade = setTimeout(step, FADE_FRAME_MS);
				return;
			}
			this.#fade = undefined;
			this.#image = final;
			this.repaintAll();
		};
		step();
	}

	override onWillDisappear(ev: WillDisappearEvent<ThumbSettings & JsonObject>): void {
		this.#clearJump();
		this.#allowed.delete(ev.action.id);
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#fade) clearTimeout(this.#fade);
		this.#timer = undefined;
		this.#fade = undefined;
		super.onWillDisappear(ev);
	}
}

/**
 * The slide being shown, bordered in red the way Teams marks the live one.
 *
 * Taken off the slide surface rather than the filmstrip, so a slide part-way
 * through its animations looks here the way it looks to the room. That also
 * means this one works without presenter view open.
 *
 * Turning it moves through the deck. The number is drawn over the dimmed
 * thumbnail as it counts, and the jump is made once the dial goes still - the
 * same shape as the ink dials, and for the same reason: one UI Automation walk
 * per gesture rather than one per click.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-slide-current" })
export class SlideCurrentDialAction extends SlideThumbDialAction {
	protected override readonly which = "current" as const;
	protected override readonly live = true;

	protected override jumps(): boolean {
		return true;
	}
}

/**
 * The slide after it, so you can see what is coming without leaving this one.
 *
 * This is the next *slide*, not the next build: a slide that has not been
 * reached has no live render to read, only the fully built thumbnail Teams puts
 * in the filmstrip - which is also why this one needs presenter view open.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-slide-next" })
export class SlideNextDialAction extends SlideThumbDialAction {
	protected override readonly which = "next" as const;
	protected override readonly live = false;
}

/* ------------------------------------------------------------------------- *
 * The meeting timer
 *
 * Teams' timer is a strip above the meeting toolbar with no AutomationIds on
 * anything: the remaining time lives in an accessible name, and whether it is
 * running is said only by which way the toggle is labeled. The sidecar reads
 * both into context; this draws them.
 *
 * Press to start or pause, hold to put it back to the top. Holding is the
 * guard the reset needs - it is the one gesture here that throws away what the
 * timer was counting, and it sits under the same finger as start.
 * ------------------------------------------------------------------------- */

/**
 * How often the timer bar is redrawn while it is moving.
 *
 * Teams' bar drains continuously; this plugin only hears about whole seconds,
 * so the frames in between are drawn locally. 25 a second is enough that the
 * fill and the reddening read as motion rather than as steps.
 */
const FRAME_MS = 40;

/** When the expiry flash has finished and the bar can stop being redrawn. */
const FLASH_SETTLES_MS = 3200;

/** How long the dial must be held before a press becomes a reset. */
const TIMER_HOLD_MS = 700;

/** The sidecar targets that drive the timer; see TeamsClient.DriveTimer. */
const TIMER_TOGGLE = "timer-toggle";
const TIMER_RESET = "timer-reset";

@action({ UUID: "com.bad-duck.teamscontrol.timer-dial" })
export class TimerDialAction extends TeamsDialAction {
	/**
	 * The longest remaining time seen while this timer has been up.
	 *
	 * Teams exposes no duration, so the bar is drawn against this. A timer
	 * starts at its full length, so the first reading after it appears - or
	 * after a reset - is the duration. Setting a *shorter* timer while one is
	 * already part-way through would leave this too high until the next reset;
	 * there is nothing in the tree that would tell us otherwise.
	 */
	#total: number | undefined;

	/**
	 * The last reading from Teams, and when it arrived.
	 *
	 * Teams reports whole seconds, and the sidecar only publishes a change, so
	 * a dial drawing straight from that steps once a second. The reading is an
	 * anchor instead: time is carried forward from it between updates, and each
	 * new reading snaps back to the truth.
	 */
	#anchorRemaining: number | undefined;
	#anchorAt = 0;
	#lastReading: number | undefined;

	/**
	 * When the timer was first seen expired, so the overtime can be counted.
	 *
	 * Teams shows a negative count once time is up, and publishes none of it:
	 * the accessible name pins at "0 sec remaining" whatever the bar says. So
	 * it is counted from the moment the expiry was *observed*, and only when
	 * the timer was seen running beforehand - a dial that arrives already in
	 * overtime says "TIME'S UP" without a number rather than inventing one
	 * from when it happened to start looking.
	 */
	#expiredAt: number | undefined;
	#sawRunning = false;

	/** Held per dial, so a hold on one does not reset from another. */
	readonly #holds = new Map<string, NodeJS.Timeout>();
	readonly #fired = new Set<string>();

	/** Drives the bar between readings; see FRAME_MS. */
	#tick: NodeJS.Timeout | undefined;

	protected override layout(): string {
		return INK_LAYOUT;
	}

	protected override draw(state: TeamsState): Feedback {
		const reading = Number(state.context["timer.remaining"] ?? NaN);

		if (!state.inMeeting || !Number.isFinite(reading)) {
			this.#forget();
			return { canvas: toPixmap(renderStripIdle("Timer", state.inMeeting ? "none set" : "no meeting")) };
		}

		const expired = state.context["timer.expired"] === "1";
		const running = state.context["timer.running"] === "1";
		const now = Date.now();

		// A new reading re-anchors; the same one is carried forward.
		if (reading !== this.#lastReading) {
			this.#lastReading = reading;
			this.#anchorRemaining = reading;
			this.#anchorAt = now;
		}

		if (expired) {
			if (this.#expiredAt === undefined && this.#sawRunning) this.#expiredAt = now;
		} else {
			this.#expiredAt = undefined;
			this.#sawRunning = reading > 0;
			if (this.#total === undefined || reading > this.#total) this.#total = reading;
		}

		/*
			Only a running timer moves on its own. A paused one is drawn from
			the reading, so it does not creep while nobody is counting.
		*/
		const elapsed = (now - this.#anchorAt) / 1000;
		const live =
			running && !expired
				? Math.max(0, (this.#anchorRemaining ?? reading) - elapsed)
				: reading;

		this.#animate(running || expired);

		return {
			canvas: toPixmap(
				renderTimer(
					live,
					this.#total ?? Math.max(1, reading),
					running,
					expired,
					this.#expiredAt === undefined ? undefined : (now - this.#expiredAt) / 1000
				)
			)
		};
	}

	/**
	 * Repaints between readings so the bar drains rather than steps.
	 *
	 * The fill creeps about a tenth of a pixel per frame on a minute-long
	 * timer, so this is what turns a once-a-second jump into movement. It stops
	 * whenever there is nothing moving, which is most of the time.
	 */
	#animate(moving: boolean): void {
		if (!moving) {
			this.#stopTicking();
			return;
		}
		if (this.#tick !== undefined) return;

		this.#tick = setInterval(() => {
			// The flash settles, and a paused bar stops: neither needs frames.
			if (this.#expiredAt !== undefined && Date.now() - this.#expiredAt > FLASH_SETTLES_MS) {
				this.#stopTicking();
				this.repaintAll();
				return;
			}
			this.repaintAll();
		}, FRAME_MS);
	}

	#stopTicking(): void {
		if (this.#tick) clearInterval(this.#tick);
		this.#tick = undefined;
	}

	#forget(): void {
		this.#total = undefined;
		this.#anchorRemaining = undefined;
		this.#lastReading = undefined;
		this.#expiredAt = undefined;
		this.#sawRunning = false;
		this.#stopTicking();
	}

	override onDialDown(ev: DialDownEvent<JsonObject>): void {
		const id = ev.action.id;
		this.#fired.delete(id);

		this.#holds.set(
			id,
			setTimeout(() => {
				this.#holds.delete(id);
				this.#fired.add(id);
				void this.#drive(ev.action, TIMER_RESET);
			}, TIMER_HOLD_MS)
		);
	}

	override async onDialUp(ev: DialUpEvent<JsonObject>): Promise<void> {
		const id = ev.action.id;
		const hold = this.#holds.get(id);
		if (hold) clearTimeout(hold);
		this.#holds.delete(id);

		// The reset already went; releasing must not also toggle it.
		if (this.#fired.delete(id)) return;

		await this.#drive(ev.action, TIMER_TOGGLE);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		const hold = this.#holds.get(ev.action.id);
		if (hold) clearTimeout(hold);
		this.#holds.delete(ev.action.id);
		this.#fired.delete(ev.action.id);
		this.#stopTicking();
		super.onWillDisappear(ev);
	}

	async #drive(dial: DialAction<JsonObject>, target: string): Promise<void> {
		const res = await bridge.invoke(target);
		if (res.ok) {
			// A reset changes the duration the bar is drawn against, and ends
			// any overtime that was being counted.
			if (target === TIMER_RESET) {
				this.#total = undefined;
				this.#expiredAt = undefined;
			}
			return;
		}

		logger.warn(`${target} failed: ${res.error ?? "no reason given"}`);
		await dial.showAlert();
	}
}
