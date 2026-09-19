/*
 * What each key does, shown in its property inspector.
 *
 * Hand-written, not generated: these say what the key does, what its state
 * means and when it is available, which is more than the one-line tooltip the
 * action list shows and cannot be derived from it.
 *
 * Every action must have an entry, and every entry must match a real action -
 * tests/marketplace.test.ts fails on either.
 */
globalThis.ACTION_DESCRIPTIONS = {
	"com.bad-duck.teamscontrol.mute":
		"Mutes and unmutes your microphone. The key follows the live state, so it stays correct when you mute in Teams itself, from a keyboard shortcut, or on a headset.",

	"com.bad-duck.teamscontrol.camera":
		"Turns your camera on or off. The key follows the live state, including changes made in Teams itself.",

	"com.bad-duck.teamscontrol.hand":
		"Raises or lowers your hand. It lives in Teams' React flyout, which the key opens, clicks and closes in one press. That flyout cannot be read without opening it, so the key shows whatever your last press set.",

	"com.bad-duck.teamscontrol.react-like":
		"Sends a Like reaction. Reactions live in Teams' React flyout, which the key opens, clicks and closes in one press. A reaction is momentary, so the key shows no state.",
	"com.bad-duck.teamscontrol.react-love":
		"Sends a Love reaction. Reactions live in Teams' React flyout, which the key opens, clicks and closes in one press. A reaction is momentary, so the key shows no state.",
	"com.bad-duck.teamscontrol.react-applause":
		"Sends an Applause reaction. Reactions live in Teams' React flyout, which the key opens, clicks and closes in one press. A reaction is momentary, so the key shows no state.",
	"com.bad-duck.teamscontrol.react-laugh":
		"Sends a Laugh reaction. Reactions live in Teams' React flyout, which the key opens, clicks and closes in one press. A reaction is momentary, so the key shows no state.",
	"com.bad-duck.teamscontrol.react-wow":
		"Sends a Wow reaction. Reactions live in Teams' React flyout, which the key opens, clicks and closes in one press. A reaction is momentary, so the key shows no state.",

	"com.bad-duck.teamscontrol.blur":
		"Turns background blur on or off. It sits in Teams' video options flyout, which the key opens and closes for you. That flyout cannot be read without opening it, so the key shows whatever your last press set.",

	"com.bad-duck.teamscontrol.share":
		"Opens Teams' share tray, and stops sharing when you already are. The key follows the live state.",

	"com.bad-duck.teamscontrol.chat":
		"Shows or hides the meeting chat pane. Teams reports no state for this button, so the key does not light up.",

	"com.bad-duck.teamscontrol.people":
		"Shows or hides the participant roster. Teams reports no state for this button, so the key does not light up.",

	"com.bad-duck.teamscontrol.leave":
		"Leaves the meeting. This cannot be undone, so the key offers a press-and-hold guard below: with it on, the key must be held for about a second, and a quick tap is ignored rather than reported as an error. Off by default.",

	"com.bad-duck.teamscontrol.ppt-prev":
		"Goes back one slide. As the presenter this moves the deck for everyone; as an attendee it moves your view only, and the Sync key brings you back. Available whenever a deck is being presented.",

	"com.bad-duck.teamscontrol.ppt-next":
		"Advances one slide. As the presenter this moves the deck for everyone; as an attendee it moves your view only, and the Sync key brings you back. Available whenever a deck is being presented.",

	"com.bad-duck.teamscontrol.ppt-status":
		"Shows the current slide and the deck length, such as 3 / 19. Display only - pressing it does nothing. It holds the last known position while Teams hides its toolbar or a flyout is open, rather than going blank.",

	"com.bad-duck.teamscontrol.ppt-ink-color-dial":
		"Turns the selected pen, highlighter or laser through its colours. The palette belongs to the tool rather than to Teams - the pen and the highlighter offer different sets - so the dial reads whichever one is in front of it, and wraps at the ends. Turning shows the colour you are heading for; it is applied when you stop. Goes quiet for the cursor and the eraser, which have no colour.",

	"com.bad-duck.teamscontrol.ppt-ink-thickness-dial":
		"Sets how thick the selected pen or highlighter draws, over Teams' own range of 1 to 6. Turning shows the thickness you are heading for; it is applied when you stop. Goes quiet for the laser, the cursor and the eraser, none of which have a thickness.",

	"com.bad-duck.teamscontrol.ppt-slide-dial":
		"Moves through the deck from a dial. Turn for previous and next, press for grid view, tap the touch strip to sync back to the presenter. The strip shows the slide you are turning towards and how far through the deck it is. Turning quickly does not queue a press per click: the slides are sent once you stop, so a long spin cannot go on moving the deck after you let go.",

	"com.bad-duck.teamscontrol.ppt-sync":
		"Returns you to the slide the presenter is on, after you have moved through the deck privately. Attendee only. Teams only offers this while you are actually out of step, so the key reads 'In sync' the rest of the time.",

	"com.bad-duck.teamscontrol.ppt-grid":
		"Opens the grid of slide thumbnails, and closes it again. A real toggle, so the key stays lit while the grid is open. Opening the grid removes every other PowerPoint Live control from Teams' UI, which makes this the one key that keeps working while it is up.",

	"com.bad-duck.teamscontrol.ppt-high-contrast":
		"Switches the slides to high contrast for you only - the presenter and everyone else see them unchanged. A toggle, so the key shows whether it is on.",


	"com.bad-duck.teamscontrol.ppt-take-control":
		"Takes control of a deck someone else is presenting. Attendee only, and the one key that changes your role: a successful press makes you the presenter, which dims this key and lights up the presenter keys.",

	"com.bad-duck.teamscontrol.ppt-popout":
		"Moves the shared content into its own window, so you can put it on another screen.",


	"com.bad-duck.teamscontrol.ppt-laser":
		"Selects the laser pointer. The drawing tools are a single-select group, so the key lights while this is the active tool and follows the tool you pick in Teams' own toolbar. The key is drawn in the colour the pointer will actually use. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-pen":
		"Selects the pen. The drawing tools are a single-select group, so the key lights while this is the active tool and follows the tool you pick in Teams' own toolbar. The key is drawn in the colour the pen will actually draw in. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-highlighter":
		"Selects the highlighter. The drawing tools are a single-select group, so the key lights while this is the active tool and follows the tool you pick in Teams' own toolbar. The key is drawn in the colour the highlighter will actually draw in. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-eraser":
		"Selects the eraser, which removes annotations you have drawn. The key lights while it is the active tool. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-cursor":
		"Puts the drawing tools away and goes back to the ordinary cursor. The key lights while no drawing tool is in use. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-private-view":
		"Lets attendees move through the deck on their own, or stops them. The key shows the current setting: the eye is struck through while private viewing is off. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-hide-presenter-view":
		"Shows or hides your notes and thumbnails, on your own screen only. The key shows the current state: the podium is struck through while presenter view is up, because pressing it will hide it. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-refresh":
		"Reloads the deck so you present the latest saved version, after it has been edited during the meeting. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-copy-link":
		"Copies a link to the deck you are presenting to the clipboard, through Teams' Share flyout. Presenter only.",

	"com.bad-duck.teamscontrol.ppt-layout-content":
		"Shows the slides on their own, without your camera placed on them. Presenter only, and offered only while a different layout is in use.",

	"com.bad-duck.teamscontrol.ppt-layout-cameo":
		"Places your camera feed onto the slide. Presenter only, and needs your camera on: Teams still lists the option with the camera off but disables it, so the key dims.",

	"com.bad-duck.teamscontrol.ppt-stop-presenting":
		"Stops sharing the deck, which ends the presentation for everyone. A press opens the \"Stop presenting?\" dialog Teams shows; keep the key held to answer it, or release and answer on screen. Presenter only."
};
