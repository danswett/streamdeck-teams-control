import streamDeck from "@elgato/streamdeck";

import {
	BlurAction,
	CameraAction,
	ChatAction,
	HandAction,
	LeaveAction,
	MuteAction,
	PeopleAction,
	ReactionAction,
	ShareAction
} from "./actions/controls";
import { bridge } from "./bridge";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new MuteAction());
streamDeck.actions.registerAction(new CameraAction());
streamDeck.actions.registerAction(new HandAction());
streamDeck.actions.registerAction(new ReactionAction());
streamDeck.actions.registerAction(new BlurAction());
streamDeck.actions.registerAction(new ShareAction());
streamDeck.actions.registerAction(new ChatAction());
streamDeck.actions.registerAction(new PeopleAction());
streamDeck.actions.registerAction(new LeaveAction());

/**
 * Diagnostics hook. The property inspector can ask the sidecar to dump a Teams
 * flyout into the plugin log, which is how the selector map gets re-derived if
 * a Teams update moves a control.
 */
streamDeck.ui.onSendToPlugin((ev) => {
	const payload = ev.payload as { command?: string; menu?: string } | undefined;
	if (payload?.command === "discover") {
		bridge.discover(payload.menu);
	}
});

bridge.start();

// Connect last, once every action is registered.
await streamDeck.connect();
