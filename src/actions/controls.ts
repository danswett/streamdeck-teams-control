import { action, type KeyDownEvent, type KeyUpEvent } from "@elgato/streamdeck";

import { type TeamsState } from "../bridge";
import {
	REACTION_KEYS,
	renderGlyph,
	renderReaction,
	renderSimple,
	renderToggle
} from "../icons";
import { TeamsAction } from "./base";

/** True when Teams is in a meeting and the control is present and enabled. */
function usable(state: TeamsState, key: string): boolean {
	return state.inMeeting && (state.available[key] ?? false);
}

@action({ UUID: "com.dswett.teamscontrol.mute" })
export class MuteAction extends TeamsAction {
	protected override targetFor(): string {
		return "mute";
	}

	protected override draw(state: TeamsState): string {
		// A muted mic is struck through and red, matching the Teams toolbar.
		return renderToggle("mic", usable(state, "mute"), state.states["mute"], true, true);
	}
}

@action({ UUID: "com.dswett.teamscontrol.camera" })
export class CameraAction extends TeamsAction {
	protected override targetFor(): string {
		return "camera";
	}

	protected override draw(state: TeamsState): string {
		// State is "camera on", so the slash belongs on the inactive side.
		return renderToggle("camera", usable(state, "camera"), state.states["camera"], false, true);
	}
}

@action({ UUID: "com.dswett.teamscontrol.hand" })
export class HandAction extends TeamsAction {
	protected override targetFor(): string {
		return "hand";
	}

	protected override draw(state: TeamsState): string {
		if (!usable(state, "hand")) return renderGlyph("hand", "unavailable");
		// Raised hands read better as a highlight than as a struck-through glyph.
		return renderGlyph("hand", state.states["hand"] ? "accent" : "on");
	}
}

type ReactionSettings = {
	reaction?: string;
};

@action({ UUID: "com.dswett.teamscontrol.react" })
export class ReactionAction extends TeamsAction<ReactionSettings> {
	protected override targetFor(settings: ReactionSettings): string {
		const key = settings.reaction ?? "react-like";
		return REACTION_KEYS.includes(key) ? key : "react-like";
	}

	protected override draw(state: TeamsState, settings: ReactionSettings): string {
		const key = this.targetFor(settings);
		// Reactions live in the React flyout, so availability tracks that menu.
		return renderReaction(key, usable(state, key));
	}
}

@action({ UUID: "com.dswett.teamscontrol.blur" })
export class BlurAction extends TeamsAction {
	protected override targetFor(): string {
		return "blur";
	}

	protected override draw(state: TeamsState): string {
		if (!usable(state, "blur")) return renderGlyph("blur", "unavailable");
		return renderGlyph("blur", state.states["blur"] ? "accent" : "on");
	}
}

@action({ UUID: "com.dswett.teamscontrol.share" })
export class ShareAction extends TeamsAction {
	protected override targetFor(): string {
		return "share";
	}

	protected override draw(state: TeamsState): string {
		if (!usable(state, "share")) return renderGlyph("share", "unavailable");
		return renderGlyph("share", state.states["share"] ? "accent" : "on");
	}
}

@action({ UUID: "com.dswett.teamscontrol.chat" })
export class ChatAction extends TeamsAction {
	protected override targetFor(): string {
		return "chat";
	}

	protected override draw(state: TeamsState): string {
		return renderSimple("chat", usable(state, "chat"));
	}
}

@action({ UUID: "com.dswett.teamscontrol.people" })
export class PeopleAction extends TeamsAction {
	protected override targetFor(): string {
		return "people";
	}

	protected override draw(state: TeamsState): string {
		return renderSimple("people", usable(state, "people"));
	}
}

type LeaveSettings = {
	requireHold?: boolean;
};

const HOLD_MS = 700;

@action({ UUID: "com.dswett.teamscontrol.leave" })
export class LeaveAction extends TeamsAction<LeaveSettings> {
	#holds = new Map<string, NodeJS.Timeout>();

	protected override targetFor(): string {
		return "leave";
	}

	protected override draw(state: TeamsState): string {
		return renderSimple("leave", usable(state, "leave"), true);
	}

	/**
	 * Leaving a meeting cannot be undone, so an optional press-and-hold guards
	 * against a mis-tap. Without it the key fires immediately.
	 */
	override async onKeyDown(ev: KeyDownEvent<LeaveSettings>): Promise<void> {
		if (!ev.payload.settings.requireHold) {
			await super.onKeyDown(ev);
			return;
		}

		const id = ev.action.id;
		this.#clear(id);
		this.#holds.set(
			id,
			setTimeout(() => {
				this.#holds.delete(id);
				void super.onKeyDown(ev);
			}, HOLD_MS)
		);
	}

	override async onKeyUp(ev: KeyUpEvent<LeaveSettings>): Promise<void> {
		if (!ev.payload.settings.requireHold) return;
		if (this.#holds.has(ev.action.id)) {
			// Released before the hold completed: cancel and tell the user.
			this.#clear(ev.action.id);
			await ev.action.showAlert();
		}
	}

	#clear(id: string): void {
		const t = this.#holds.get(id);
		if (t) {
			clearTimeout(t);
			this.#holds.delete(id);
		}
	}
}
