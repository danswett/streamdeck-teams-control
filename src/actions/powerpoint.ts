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
import { action } from "@elgato/streamdeck";

import type { TeamsState } from "../bridge";
import { renderGlyph, renderLabelled, renderSimple, type Tone } from "../icons";
import { GuardedAction, TeamsAction, usable } from "./base";

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

	/** Tone used when the control is live; the grey "unavailable" tone is shared. */
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
export class PptGridAction extends PptAction {
	protected override readonly control = "ppt-grid";
	protected override readonly glyph = "pptGrid";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-popout" })
export class PptPopoutAction extends PptAction {
	protected override readonly control = "ppt-popout";
	protected override readonly glyph = "pptPopout";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-copilot" })
export class PptCopilotAction extends PptAction {
	protected override readonly control = "ppt-copilot";
	protected override readonly glyph = "pptCopilot";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-zoom-in" })
export class PptZoomInAction extends PptAction {
	protected override readonly control = "ppt-zoom-in";
	protected override readonly glyph = "pptZoomIn";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-zoom-out" })
export class PptZoomOutAction extends PptAction {
	protected override readonly control = "ppt-zoom-out";
	protected override readonly glyph = "pptZoomOut";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-high-contrast" })
export class PptHighContrastAction extends PptAction {
	protected override readonly control = "ppt-high-contrast";
	protected override readonly glyph = "pptContrast";
}

/**
 * Requests control of someone else's deck.
 *
 * This is the one key that changes your role. A successful press makes you the
 * presenter, at which point Teams retires this button and the presenter tools
 * appear — so the key dims itself immediately afterwards and the drawing tools,
 * private view and stop-presenting keys light up in its place.
 *
 * Drawn in gold rather than white because it acts on everyone's view, not just
 * your own.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-take-control" })
export class PptTakeControlAction extends PptAction {
	protected override readonly control = "ppt-take-control";
	protected override readonly glyph = "pptTakeControl";
	protected override readonly tone: Tone = "accent";
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
		// Gold rather than white: this key lighting up means you are out of step
		// with the presenter, not merely that a control is available.
		return renderGlyph("pptSync", usable(state, "ppt-sync") ? "accent" : "unavailable");
	}
}

type TranslateSettings = {
	/**
	 * Teams' own id for the language, which is the endonym ("Deutsch",
	 * "日本語"), plus "Original" to turn translation back off. Stored rather
	 * than a locale code because the id is what the menu item carries.
	 */
	language?: string;
};

const DEFAULT_LANGUAGE = "Original";

/**
 * Translates the shared slides. One action covers every language: the sidecar
 * substitutes the chosen value into the menu-item selector, so adding a
 * language Teams later ships needs no plugin change.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-translate" })
export class PptTranslateAction extends TeamsAction<TranslateSettings> {
	protected override targetFor(): string {
		return "ppt-translate";
	}

	protected override argFor(settings: TranslateSettings): string {
		return settings.language || DEFAULT_LANGUAGE;
	}

	protected override draw(state: TeamsState): string {
		return renderSimple("pptTranslate", usable(state, "ppt-translate"));
	}
}

/**
 * Shows the deck's position, "3/19", and nothing else — it is deliberately not
 * pressable, because every plausible action for it already has its own key and
 * a mis-tap during someone else's presentation is expensive.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-status" })
export class PptStatusAction extends TeamsAction {
	protected override targetFor(): undefined {
		return undefined;
	}

	protected override draw(state: TeamsState): string {
		if (!pptLive(state)) return renderLabelled("pptSlide", "", "unavailable");

		const presenting = state.states["ppt-presenting"] ?? false;
		const slide = state.context["ppt.slide"] ?? "";
		const total = state.context["ppt.slides"] ?? "";

		// The total only comes from the toolbar counter, which Teams hides while
		// the pointer is away, so the slide number has to stand on its own.
		const label = slide && total ? `${slide}/${total}` : slide;

		return renderLabelled(
			presenting ? "pptPresenter" : "pptSlide",
			label,
			presenting ? "accent" : "on"
		);
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
 * tracks a tool you picked in Teams itself, not just one pressed from the deck.
 */
abstract class InkToolAction extends TeamsAction {
	protected abstract readonly control: string;
	protected abstract readonly glyph: string;

	protected override targetFor(): string {
		return this.control;
	}

	protected override draw(state: TeamsState): string {
		if (!usable(state, this.control)) return renderGlyph(this.glyph, "unavailable");
		return renderGlyph(this.glyph, state.states[this.control] ? "accent" : "on");
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-cursor" })
export class PptCursorAction extends InkToolAction {
	protected override readonly control = "ppt-cursor";
	protected override readonly glyph = "pptCursor";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-laser" })
export class PptLaserAction extends InkToolAction {
	protected override readonly control = "ppt-laser";
	protected override readonly glyph = "pptLaser";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-pen" })
export class PptPenAction extends InkToolAction {
	protected override readonly control = "ppt-pen";
	protected override readonly glyph = "pptPen";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-highlighter" })
export class PptHighlighterAction extends InkToolAction {
	protected override readonly control = "ppt-highlighter";
	protected override readonly glyph = "pptHighlighter";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-eraser" })
export class PptEraserAction extends InkToolAction {
	protected override readonly control = "ppt-eraser";
	protected override readonly glyph = "pptEraser";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-private-view" })
export class PptPrivateViewAction extends PptAction {
	protected override readonly control = "ppt-private-view";
	protected override readonly glyph = "pptPrivateView";
}

@action({ UUID: "com.bad-duck.teamscontrol.ppt-hide-presenter-view" })
export class PptHidePresenterViewAction extends PptAction {
	protected override readonly control = "ppt-hide-presenter-view";
	protected override readonly glyph = "pptHidePresenterView";
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
 * Ends the presentation for everyone. Offers the same press-and-hold guard as
 * Leave, for the same reason: it sits beside keys pressed constantly and cannot
 * be taken back.
 */
@action({ UUID: "com.bad-duck.teamscontrol.ppt-stop-presenting" })
export class PptStopPresentingAction extends GuardedAction {
	protected override targetFor(): string {
		return "ppt-stop-presenting";
	}

	protected override draw(state: TeamsState): string {
		return renderSimple("pptStopPresenting", usable(state, "ppt-stop-presenting"), "danger");
	}
}
