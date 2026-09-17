import { action, type KeyDownEvent } from "@elgato/streamdeck";

import { bridge, type TeamsState } from "../bridge";
import {
	renderEmoji,
	renderGlyph,
	renderHandFrame,
	renderReaction,
	renderReactionFrame,
	renderSimple,
	renderToggle
} from "../icons";
import { GuardedAction, TeamsAction, usable } from "./base";

@action({ UUID: "com.bad-duck.teamscontrol.mute" })
export class MuteAction extends TeamsAction {
	protected override targetFor(): string {
		return "mute";
	}

	protected override draw(state: TeamsState): string {
		// `mute` is true when muted. The slashed glyph already communicates the
		// state, so both sides stay white rather than turning red.
		return renderToggle({
			onKey: "micOff",
			offKey: "mic",
			onTone: "on",
			offTone: "on",
			active: state.states["mute"],
			available: usable(state, "mute")
		});
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.camera" })
export class CameraAction extends TeamsAction {
	protected override targetFor(): string {
		return "camera";
	}

	protected override draw(state: TeamsState): string {
		// `camera` is true when the camera is on; the off glyph carries the slash.
		return renderToggle({
			onKey: "camera",
			offKey: "cameraOff",
			onTone: "on",
			offTone: "on",
			active: state.states["camera"],
			available: usable(state, "camera")
		});
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.hand" })
export class HandAction extends TeamsAction {
	protected override targetFor(): string {
		return "hand";
	}

	protected override draw(state: TeamsState): string {
		// Uses the raised-hand emoji rather than a monochrome glyph, matching
		// how the reaction keys read.
		return renderEmoji("hand", usable(state, "hand"));
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		// Raising a hand reads as an upward motion, so this one lifts straight
		// up rather than wobbling like the reactions.
		if (usable(bridge.state, "hand")) {
			void this.playFrames(ev.action, (t) => renderHandFrame(t));
		}
		await super.onKeyDown(ev);
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.blur" })
export class BlurAction extends TeamsAction {
	protected override targetFor(): string {
		return "blur";
	}

	protected override draw(state: TeamsState): string {
		if (!usable(state, "blur")) return renderGlyph("blur", "unavailable");
		return renderGlyph("blur", state.states["blur"] ? "accent" : "on");
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.share" })
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

@action({ UUID: "com.bad-duck.teamscontrol.chat" })
export class ChatAction extends TeamsAction {
	protected override targetFor(): string {
		return "chat";
	}

	protected override draw(state: TeamsState): string {
		return renderSimple("chat", usable(state, "chat"));
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.people" })
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

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		// Started without awaiting so the key pops immediately; sending the
		// reaction involves opening a Teams flyout and takes noticeably longer.
		if (usable(bridge.state, this.reaction)) {
			void this.playFrames(ev.action, (t) => renderReactionFrame(this.reaction, t));
		}
		await super.onKeyDown(ev);
	}
}

@action({ UUID: "com.bad-duck.teamscontrol.react-like" })
export class ReactLikeAction extends ReactionAction {
	protected override readonly reaction = "react-like";
}

@action({ UUID: "com.bad-duck.teamscontrol.react-love" })
export class ReactLoveAction extends ReactionAction {
	protected override readonly reaction = "react-love";
}

@action({ UUID: "com.bad-duck.teamscontrol.react-applause" })
export class ReactApplauseAction extends ReactionAction {
	protected override readonly reaction = "react-applause";
}

@action({ UUID: "com.bad-duck.teamscontrol.react-laugh" })
export class ReactLaughAction extends ReactionAction {
	protected override readonly reaction = "react-laugh";
}

@action({ UUID: "com.bad-duck.teamscontrol.react-wow" })
export class ReactWowAction extends ReactionAction {
	protected override readonly reaction = "react-wow";
}

@action({ UUID: "com.bad-duck.teamscontrol.leave" })
export class LeaveAction extends GuardedAction {
	protected override targetFor(): string {
		return "leave";
	}

	protected override draw(state: TeamsState): string {
		return renderSimple("leave", usable(state, "leave"), "danger");
	}
}
