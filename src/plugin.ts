import streamDeck from "@elgato/streamdeck";

import {
	BlurAction,
	CameraAction,
	ChatAction,
	HandAction,
	LeaveAction,
	MuteAction,
	PeopleAction,
	ReactApplauseAction,
	ReactLaughAction,
	ReactLikeAction,
	ReactLoveAction,
	ReactWowAction,
	ShareAction
} from "./actions/controls";
import {
	PptCopyLinkAction,
	PptCursorAction,
	PptEraserAction,
	PptGridAction,
	PptHidePresenterViewAction,
	PptHighContrastAction,
	PptHighlighterAction,
	PptLaserAction,
	PptLayoutCameoAction,
	PptLayoutContentAction,
	PptNextAction,
	PptPenAction,
	PptPopoutAction,
	PptPrevAction,
	PptPrivateViewAction,
	PptRefreshAction,
	PptStatusAction,
	PptStopPresentingAction,
	PptSyncAction,
	PptTakeControlAction
} from "./actions/powerpoint";
import { bridge } from "./bridge";
import { InkColorDialAction, InkThicknessDialAction, SlideCurrentDialAction, SlideNextDialAction } from "./actions/dials";
import { profileSwitcher } from "./profiles";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new MuteAction());
streamDeck.actions.registerAction(new CameraAction());
streamDeck.actions.registerAction(new HandAction());
streamDeck.actions.registerAction(new ReactLikeAction());
streamDeck.actions.registerAction(new ReactLoveAction());
streamDeck.actions.registerAction(new ReactApplauseAction());
streamDeck.actions.registerAction(new ReactLaughAction());
streamDeck.actions.registerAction(new ReactWowAction());
streamDeck.actions.registerAction(new BlurAction());
streamDeck.actions.registerAction(new ShareAction());
streamDeck.actions.registerAction(new ChatAction());
streamDeck.actions.registerAction(new PeopleAction());
streamDeck.actions.registerAction(new LeaveAction());

// PowerPoint Live. These dim themselves whenever no deck is being presented.
streamDeck.actions.registerAction(new PptPrevAction());
streamDeck.actions.registerAction(new PptNextAction());
streamDeck.actions.registerAction(new PptStatusAction());
streamDeck.actions.registerAction(new PptSyncAction());
streamDeck.actions.registerAction(new PptGridAction());
streamDeck.actions.registerAction(new PptHighContrastAction());
streamDeck.actions.registerAction(new PptTakeControlAction());
streamDeck.actions.registerAction(new PptPopoutAction());

// PowerPoint Live, presenting. Unavailable unless you are the one sharing.
streamDeck.actions.registerAction(new PptCursorAction());
streamDeck.actions.registerAction(new PptLaserAction());
streamDeck.actions.registerAction(new PptPenAction());
streamDeck.actions.registerAction(new PptHighlighterAction());
streamDeck.actions.registerAction(new PptEraserAction());
streamDeck.actions.registerAction(new PptPrivateViewAction());
streamDeck.actions.registerAction(new PptHidePresenterViewAction());
streamDeck.actions.registerAction(new PptRefreshAction());
streamDeck.actions.registerAction(new PptCopyLinkAction());
streamDeck.actions.registerAction(new PptLayoutContentAction());
streamDeck.actions.registerAction(new PptLayoutCameoAction());
streamDeck.actions.registerAction(new PptStopPresentingAction());

// Dials, on the decks that have them. Nothing registers per device: Stream Deck
// only ever raises these for a dial the user has actually placed.
streamDeck.actions.registerAction(new InkColorDialAction());
streamDeck.actions.registerAction(new InkThicknessDialAction());
streamDeck.actions.registerAction(new SlideCurrentDialAction());
streamDeck.actions.registerAction(new SlideNextDialAction());

bridge.start();
profileSwitcher.start();

// Connect last, once every action is registered.
await streamDeck.connect();
