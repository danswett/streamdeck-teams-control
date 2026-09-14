import { action, type KeyDownEvent, type KeyUpEvent } from "@elgato/streamdeck";

import { type TeamsState } from "../bridge";
import { renderGlyph, renderReaction, renderSimple, renderToggle } from "../icons";
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
		// `mute` is true when muted, which is the struck-through Fluent glyph.
		return renderToggle({
			onKey: "micOff",
			offKey: "mic",
			onTone: "danger",
			offTone: "on",
			active: state.states["mute"],
			available: usable(state, "mute")
		});
	}
}

@action({ UUID: "com.dswett.teamscontrol.camera" })
export class CameraAction extends TeamsAction {
	protected override targetFor(): string {
		return "camera";
	}

	protected override draw(state: TeamsState): string {
		// `camera` is true when the camera is on.
		return renderToggle({
			onKey: "camera",
			offKey: "cameraOff",
			onTone: "on",
			offTone: "danger",
			active: state.states["camera"],
			available: usable(state, "camera")
		});
	}
}

@action({ UUID: "com.dswett.teamscontrol.hand" })
export class HandAction extends TeamsAction {
	protected override targetFor(): string {
		return "hand";
	}

	protected override draw(state: TeamsState): string {
		if (!usable(state, "hand")) return renderGlyph("hand", "unavailable");
		// A raised hand reads better as a highlight than as a separate glyph.
		return renderGlyph("hand", state.states["hand"] ? "accent" : "on");
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
		return renderToggle({
			onKey: "shareStop",
			offKey: "share",
			onTone: "accent",
			offTone: "on",
			active: state.states["share"],
			available: usable(state, "share")
		});
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

/**
 * Base for the five meeting reactions. Each is its own action so they can be
 * dragged onto the deck individually, matching how Teams presents them.
 */
abstract class ReactionAction extends TeamsAction {
	protected abstract readonly reaction: string;

	protected override targetFor(): string {
		return this.reaction;
	}

	protected override draw(state: TeamsState): string {
		return renderReaction(this.reaction, usable(state, this.reaction));
	}
}

@action({ UUID: "com.dswett.teamscontrol.react-like" })
export class ReactLikeAction extends ReactionAction {
	protected override readonly reaction = "react-like";
}

@action({ UUID: "com.dswett.teamscontrol.react-love" })
export class ReactLoveAction extends ReactionAction {
	protected override readonly reaction = "react-love";
}

@action({ UUID: "com.dswett.teamscontrol.react-applause" })
export class ReactApplauseAction extends ReactionAction {
	protected override readonly reaction = "react-applause";
}

@action({ UUID: "com.dswett.teamscontrol.react-laugh" })
export class ReactLaughAction extends ReactionAction {
	protected override readonly reaction = "react-laugh";
}

@action({ UUID: "com.dswett.teamscontrol.react-wow" })
export class ReactWowAction extends ReactionAction {
	protected override readonly reaction = "react-wow";
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
		return renderSimple("leave", usable(state, "leave"), "danger");
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
