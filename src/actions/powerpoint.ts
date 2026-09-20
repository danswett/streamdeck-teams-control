/**
 * PowerPoint Live keys.
 *
 * Teams renders a shared deck as an embedded slide-show app rather than as part
 * of the meeting toolbar, so none of these controls exist unless someone is
 * presenting. Nothing here special-cases that: the sidecar simply cannot find
 * the controls, reports them unavailable, and every key dims itself the same way
 * it already does outside a meeting.
 *
 * Selectors captured from a live meeting on 2026-09-17, Teams 26255.500.5120.7530.
 */
import {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { bridge, type TeamsState } from "../bridge";
import {
	presenterViewGlyph,
	privateViewGlyph,
	renderGlyph,
	renderLive,
	renderLabeled,
	renderSlideCount,
	SLIDE_KEY_H,
	SLIDE_KEY_W,
	renderSimple,
	renderTool,
	type Tone
} from "../icons";
import { TeamsAction, usable } from "./base";

const logger = streamDeck.logger.createScope("PptStop");

/** How long "Stop sharing" must be held before the confirmation is answered. */
const CONFIRM_HOLD_MS = 700;

/** Gap before the single retry, for a dialog that has not rendered yet. */
const CONFIRM_RETRY_MS = 300;

/** True while a deck is actually being presented, in either role. */
export function pptLive(state: TeamsState): boolean {
	return state.inMeeting && (state.states["ppt-live"] ?? false);
}

/**
 * Base for a PowerPoint Live key that is a plain press: navigation, grid view,
 * pop out. Subclasses supply the control key and the glyph.
 */
abstract class PptAction<T extends Record<string, never> | object = object> extends TeamsAction<
	T & Record<string, never>
> {
	protected abstract readonly control: string;
	protected abstract readonly glyph: string;

	/** Tone used when the control is live; the gray "unavailable" tone is shared. */
	protected readonly tone: Tone = "on";

	protected override targetFor(): string {
		return this.control;
	}

	protected override draw(state: TeamsState): string {
		return renderSimple(this.glyph, usable(state, this.control), this.tone);
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-prev" })
export class PptPrevAction extends PptAction {
	protected override readonly control = "ppt-prev";
	protected override readonly glyph = "pptPrev";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-next" })
export class PptNextAction extends PptAction {
	protected override readonly control = "ppt-next";
	protected override readonly glyph = "pptNext";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-grid" })
export class PptGridAction extends TeamsAction {
	protected override targetFor(): string {
		return "ppt-grid";
	}

	/**
	 * Grid view is a real toggle, and the only key that must keep working while
	 * it is open: opening it unmounts the entire slide-show surface, so every
	 * other PowerPoint Live control genuinely disappears until it is closed.
	 *
	 * Outlined at rest and solid when open, which is the same pair PowerPoint
	 * Live itself swaps between — it ships both variants and fills the squares
	 * on hover.
	 */
	protected override draw(state: TeamsState): string {
		const open = state.states["ppt-grid"];
		const glyph = open ? "pptGridOn" : "pptGrid";
		if (!usable(state, "ppt-grid")) return renderGlyph(glyph, "unavailable");
		return renderGlyph(glyph, open ? "accent" : "on");
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-popout" })
export class PptPopoutAction extends PptAction {
	protected override readonly control = "ppt-popout";
	protected override readonly glyph = "pptPopout";
}

/**
 * Views the slides in high contrast, for you only.
 *
 * A real checkbox in Teams, but one that lives inside a flyout, so its state is
 * only readable while that flyout is open. The sidecar reads the true value at
 * the moment it presses and reports the result, which means the key is accurate
 * from your first press and re-syncs on every one after — it can only be stale
 * if you change it in Teams directly.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-high-contrast" })
export class PptHighContrastAction extends TeamsAction {
	protected override targetFor(): string {
		return "ppt-high-contrast";
	}

	protected override draw(state: TeamsState): string {
		const control = "ppt-high-contrast";
		if (!usable(state, control)) return renderGlyph("pptContrast", "unavailable");
		return renderGlyph("pptContrast", state.states[control] ? "accent" : "on");
	}
}

/**
 * Requests control of someone else's deck.
 *
 * This is the one key that changes your role. A successful press makes you the
 * presenter, at which point Teams retires this button and the presenter tools
 * appear — so the key dims itself immediately afterwards and the drawing tools,
 * private view and stop-presenting keys light up in its place.
 *
 * Drawn in white, like the toolbar draws it. Gold would single it out as
 * something to be careful of, but Teams presents it as an ordinary control and
 * the key should not disagree with the application it mirrors.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-take-control" })
export class PptTakeControlAction extends PptAction {
	protected override readonly control = "ppt-take-control";
	protected override readonly glyph = "pptTakeControl";
}

/**
 * Returns an attendee to the presenter's slide.
 *
 * Teams only renders this button once you have navigated away on your own, so
 * the key being live *is* the "you are viewing privately" signal — which is the
 * thing that is easy to forget and awkward to notice.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-sync" })
export class PptSyncAction extends TeamsAction {
	protected override targetFor(): string {
		return "ppt-sync";
	}

	protected override draw(state: TeamsState): string {
		return renderLive(usable(state, "ppt-sync"));
	}
}

/** Whether the slide counter also shows the slide itself. */
type CounterSettings = {
	thumbnail?: boolean;
};

/**
 * Shows the deck's position, "3/19", and nothing else — it is deliberately not
 * pressable, because every plausible action for it already has its own key and
 * a mis-tap during someone else's presentation is expensive.
 *
 * It can also show the slide itself above the count. That reads the content of
 * the meeting rather than which controls exist, so it is off until switched on,
 * the same as the touch-strip thumbnails.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-status" })
export class PptStatusAction extends TeamsAction<CounterSettings & JsonObject> {
	protected override targetFor(): undefined {
		return undefined;
	}

	/** Which keys have been allowed to read the slide, by key id. */
	readonly #allowed = new Map<string, boolean>();

	/** The last picture captured, and the deck position it was taken at. */
	#image: string | undefined;
	#capturedAt: string | undefined;
	#busy = false;

	override onWillAppear(ev: WillAppearEvent<CounterSettings & JsonObject>): void {
		this.#allow(ev.action.id, ev.payload.settings.thumbnail === true);
		super.onWillAppear(ev);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<CounterSettings & JsonObject>): void {
		const was = this.#on();
		this.#allow(ev.action.id, ev.payload.settings.thumbnail === true);

		if (was && !this.#on()) {
			this.#image = undefined;
			this.#capturedAt = undefined;
			bridge.forget("current");
		}
		this.repaintAll();
	}

	override onWillDisappear(ev: WillDisappearEvent<CounterSettings & JsonObject>): void {
		this.#allowed.delete(ev.action.id);
		super.onWillDisappear(ev);
	}

	/** Records the setting, and says so out loud - see the dials for why. */
	#allow(id: string, allowed: boolean): void {
		if (this.#allowed.get(id) === allowed) return;
		this.#allowed.set(id, allowed);
		logger.info(`slide counter thumbnail ${allowed ? "enabled" : "disabled"}`);
	}

	#on(): boolean {
		for (const a of this.actions) if (a.isKey() && this.#allowed.get(a.id) === true) return true;
		return false;
	}

	protected override draw(state: TeamsState, action?: KeyAction<CounterSettings & JsonObject>): string {
		if (!pptLive(state)) {
			if (this.#image !== undefined) {
				this.#image = undefined;
				this.#capturedAt = undefined;
			}
			return renderLabeled("pptSlide", "", "unavailable");
		}

		const slide = state.context["ppt.slide"] ?? "";
		const total = state.context["ppt.slides"] ?? "";

		// The total only comes from the toolbar counter, which Teams hides while
		// the pointer is away, so the slide number has to stand on its own.
		const label = slide && total ? `${slide}/${total}` : slide;

		const allowed = action === undefined ? this.#on() : this.#allowed.get(action.id) === true;
		if (!allowed) return renderLabeled("pptSlide", label, "on");

		this.#considerCapture(slide);
		if (this.#image === undefined) return renderLabeled("pptSlide", label, "on");

		return renderSlideCount(this.#image, label);
	}

	/**
	 * Captures the slide when the deck moves.
	 *
	 * Unlike the touch-strip thumbnail this does not watch for ink or builds:
	 * a key is a glance rather than a preview, and a capture every quarter
	 * second to keep up with a pen is not worth it for one.
	 */
	#considerCapture(slide: string): void {
		if (slide === "" || slide === this.#capturedAt || this.#busy) return;
		void this.#capture(slide);
	}

	async #capture(at: string): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			const shot = await bridge.capture("current", 0, { w: SLIDE_KEY_W, h: SLIDE_KEY_H });
			if (!shot.ok || shot.image === undefined) {
				logger.debug(`slide counter: ${shot.error ?? "no image"}`);
				return;
			}

			this.#capturedAt = at;
			if (shot.image === this.#image) return;

			this.#image = shot.image;
			this.repaintAll();
		} finally {
			this.#busy = false;
		}
	}
}

/* ------------------------------------------------------------------------- *
 * Presenting
 *
 * Everything below only exists while you are the one sharing the deck. The
 * sidecar reports these unavailable in the attendee role, so the keys dim
 * rather than misfiring into someone else's presentation.
 * ------------------------------------------------------------------------- */

/**
 * One of PowerPoint Live's five drawing tools.
 *
 * Teams exposes them as a single-select list, so the active tool is read from
 * the UI Automation selection rather than from a label — which means it also
 * tracks a tool you picked in Teams itself.
 *
 * The ink color comes from the same place: Teams puts it in the control's
 * accessible name ("Pen: Light blue, Thickness 3"), so changing color in
 * Teams recolors the key.
 */
abstract class InkToolAction extends TeamsAction {
	protected abstract readonly control: string;

	protected override targetFor(): string {
		return this.control;
	}

	protected override draw(state: TeamsState): string {
		return renderTool(this.control, {
			available: usable(state, this.control),
			active: state.states[this.control] ?? false,
			color: state.context[`ppt.color.${this.control}`]
		});
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-cursor" })
export class PptCursorAction extends InkToolAction {
	protected override readonly control = "ppt-cursor";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-laser" })
export class PptLaserAction extends InkToolAction {
	protected override readonly control = "ppt-laser";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-pen" })
export class PptPenAction extends InkToolAction {
	protected override readonly control = "ppt-pen";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-highlighter" })
export class PptHighlighterAction extends InkToolAction {
	protected override readonly control = "ppt-highlighter";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-eraser" })
export class PptEraserAction extends InkToolAction {
	protected override readonly control = "ppt-eraser";
}

/**
 * Lets attendees move through the deck on their own, or stops them.
 *
 * The button's label never changes and it offers no toggle pattern, so the
 * sidecar reads the state out of its tooltip instead.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-private-view" })
export class PptPrivateViewAction extends TeamsAction {
	protected override targetFor(): string {
		return "ppt-private-view";
	}

	protected override draw(state: TeamsState): string {
		const control = "ppt-private-view";
		const glyph = privateViewGlyph(state.states[control]);
		return renderGlyph(glyph, usable(state, control) ? "on" : "unavailable");
	}
}

/**
 * Shows or hides your notes and thumbnails. A real toggle: the notes pane
 * existing is what "presenter view is showing" means, so the key tracks the
 * state even when you change it in Teams directly.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-hide-presenter-view" })
export class PptHidePresenterViewAction extends TeamsAction {
	protected override targetFor(): string {
		return "ppt-hide-presenter-view";
	}

	protected override draw(state: TeamsState): string {
		const control = "ppt-hide-presenter-view";

		// Drawn in white either way. The slash is the state, so coloring it as
		// well said the same thing twice - and said it backwards, because the
		// accent landed on the resting state rather than the changed one.
		const glyph = presenterViewGlyph(state.states[control]);
		return renderGlyph(glyph, usable(state, control) ? "on" : "unavailable");
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-refresh" })
export class PptRefreshAction extends PptAction {
	protected override readonly control = "ppt-refresh";
	protected override readonly glyph = "pptRefresh";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-copy-link" })
export class PptCopyLinkAction extends PptAction {
	protected override readonly control = "ppt-copy-link";
	protected override readonly glyph = "pptCopyLink";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-layout-content" })
export class PptLayoutContentAction extends PptAction {
	protected override readonly control = "ppt-layout-content";
	protected override readonly glyph = "pptLayoutContent";
}

/** Teams disables Cameo until your camera is on, so this key dims until then. */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-layout-cameo" })
export class PptLayoutCameoAction extends PptAction {
	protected override readonly control = "ppt-layout-cameo";
	protected override readonly glyph = "pptLayoutCameo";
}

/**
 * Ends the presentation for everyone.
 *
 * Teams guards this itself: pressing "Stop sharing" opens a "Stop presenting?"
 * dialog rather than acting. So the key mirrors that - a press opens the
 * dialog, and keeping the key held answers it. Releasing early leaves the
 * dialog up to be answered on screen, which is exactly what a confirmation is
 * for. No press-and-hold setting, because Teams already asks.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-stop-presenting" })
export class PptStopPresentingAction extends TeamsAction {
	#holds = new Map<string, NodeJS.Timeout>();

	protected override targetFor(): string {
		return "ppt-stop-presenting";
	}

	protected override draw(state: TeamsState): string {
		return renderSimple("pptStopPresenting", usable(state, "ppt-stop-presenting"), "danger");
	}

	override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		// Armed before the press, not after: the press has to round-trip to
		// Teams, and starting the clock afterwards would make the hold longer
		// than it looks.
		const id = ev.action.id;
		this.#clear(id);
		this.#holds.set(
			id,
			setTimeout(() => {
				this.#holds.delete(id);
				void this.#confirm(ev);
			}, CONFIRM_HOLD_MS)
		);

		await super.onKeyDown(ev);
	}

	override async onKeyUp(ev: KeyUpEvent<JsonObject>): Promise<void> {
		this.#clear(ev.action.id);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		this.#clear(ev.action.id);
		super.onWillDisappear(ev);
	}

	async #confirm(ev: KeyDownEvent<JsonObject>): Promise<void> {
		// The dialog is rendered after the press returns, so the first attempt
		// can arrive before its buttons exist. One retry covers that without
		// making a genuinely missing dialog wait.
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await bridge.invoke("ppt-stop-presenting-confirm");
			if (result.ok) {
				await ev.action.showOk();
				return;
			}
			if (attempt === 0) await new Promise((r) => setTimeout(r, CONFIRM_RETRY_MS));
			else logger.warn(`confirming stop-presenting failed: ${result.error ?? "unknown"}`);
		}
		await ev.action.showAlert();
	}

	#clear(id: string): void {
		const t = this.#holds.get(id);
		if (t) {
			clearTimeout(t);
			this.#holds.delete(id);
		}
	}
}
