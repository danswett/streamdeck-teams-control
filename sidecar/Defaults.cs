namespace TeamsBridge;

/// <summary>
/// Built-in selector map, captured from a live Teams meeting on 2026-09-14
/// (client 26255.500.5120.7530).
///
/// Toolbar controls live under the "Meeting controls" toolbar
/// (AutomationId "horizontalMiddleEnd"); reactions and raise-hand live inside
/// the React flyout; background effects inside the video options flyout.
///
/// AutomationIds are locale-independent. The name patterns used for state and
/// for the background-effects items are English and can be overridden with an
/// external selectors.json.
/// </summary>
public static class Defaults
{
    public static SelectorConfig Config() => new()
    {
        Version = 2,
        MeetingProbeAutomationId = "microphone-button",
        Controls = new Dictionary<string, ControlSpec>
        {
            // ---- Toolbar controls ----
            ["mute"] = new()
            {
                AutomationId = "microphone-button",
                // The label states the action, so "Unmute mic" means you are muted.
                // Neither aria-pressed nor a Toggle pattern is exposed here, so the
                // name is the only available state signal.
                ActivePattern = @"^\s*unmute\b",
                InactivePattern = @"^\s*mute\b"
            },
            ["camera"] = new()
            {
                AutomationId = "video-button",
                ActivePattern = @"camera\s+off",
                InactivePattern = @"camera\s+on"
            },
            ["leave"] = new() { AutomationId = "hangup-button" },
            ["share"] = new()
            {
                AutomationId = "share-button",
                ActivePattern = @"stop\s+(sharing|presenting)",
                InactivePattern = @"^\s*share\b"
            },
            ["chat"] = new() { AutomationId = "chat-button" },
            ["people"] = new() { AutomationId = "roster-button" },

            // ---- React flyout ----
            // Reaction buttons are labelled with the emoji itself, so they are
            // matched by AutomationId only.
            ["hand"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemAutomationId = "raisehands-button"
            },
            ["react-like"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemAutomationId = "like-button"
            },
            ["react-love"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemAutomationId = "heart-button"
            },
            ["react-applause"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemAutomationId = "applause-button"
            },
            ["react-laugh"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemAutomationId = "laugh-button"
            },
            ["react-wow"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemAutomationId = "surprised-button"
            },

            // ---- Video options flyout ----
            // Background effects are a radio group with unstable generated ids,
            // so these are matched by name and need an explicit "off" entry.
            ["blur"] = new()
            {
                Menu = "video-button-configure",
                MenuItemName = @"^\s*standard\s+blur\s*$",
                MenuItemOffName = @"^\s*no\s+background\s+effect\s*$"
            },

            // ---- PowerPoint Live ----
            // The slide-show surface is an embedded document, not part of the
            // meeting toolbar, so none of these exist unless a deck is being
            // presented. That is what makes the keys dim on their own.
            // Captured from a live meeting on 2026-09-17.
            ["ppt-prev"] = new() { AutomationId = "prevSlideButton", Surface = "slideShow" },
            ["ppt-next"] = new() { AutomationId = "nextSlideButton", Surface = "slideShow" },

            // Grid view replaces the whole slide-show subtree with an overlay,
            // so the button that opened it is gone by the time you want out.
            // The overlay's close button carries no AutomationId at all, hence
            // the name match, and the overlay's presence is the state.
            ["ppt-grid"] = new()
            {
                Surface = "slideShow",
                AutomationId = "gridViewToolbarButton",
                ActiveWhenPresentAutomationId = "fluent-grid-view",
                OffName = @"^\s*close\s+grid\s+view\s*$"
            },

            // Only rendered once you have navigated away from the presenter's
            // slide, so its presence is exactly the "viewing privately" signal.
            ["ppt-sync"] = new() { AutomationId = "syncToPresenterToolbarButton", Surface = "slideShow" },


            // Moves the shared content into its own window.
            ["ppt-popout"] = new() { AutomationId = "popout-content-button" },

            // Requesting control is something only an attendee can do — and it
            // is the one key that changes your role: a successful press turns
            // you into the presenter, which retires this key and lights up the
            // presenter tools below.
            ["ppt-take-control"] = new()
            {
                AutomationId = "takeControlPptBtn",
                RequiresRole = "attendee"
            },

            // ---- PowerPoint Live "Change view" flyout ----
            // A real checkbox, so pressing it toggles rather than needing an
            // "off" twin the way the background effects do.
            ["ppt-high-contrast"] = new()
            {
                Surface = "slideShow",
                Menu = "toolbarChangeViewButton",
                MenuItemAutomationId = "toolbarHighContrastOverflowButton"
            },


            // ---- PowerPoint Live, presenting ----
            // Captured while presenting on 2026-09-17. Note that zoom above is
            // shared: Teams labels it "only for me" for an attendee but
            // "for all" for the presenter, and drives the same control.
            ["ppt-stop-presenting"] = new()
            {
                AutomationId = "stopPresentingPptBtn",
                RequiresRole = "presenter"
            },
            // Teams confirms before ending a presentation for everyone. The
            // dialog is titled "Stop presenting?" and its buttons carry no
            // AutomationId, so the confirm is matched by name inside that
            // dialog. Captured live on 2026-09-18:
            //   [Window] name='Stop presenting?' class='ui-dialog ...'
            //     [Button] name='Cancel'
            //     [Button] name='Stop presenting'
            // The toolbar stays visible while it is up, so flyout recovery does
            // not fire and the dialog survives until answered.
            ["ppt-stop-presenting-confirm"] = new()
            {
                Name = "Stop presenting",
                WithinClass = "ui-dialog",
                RequiresRole = "presenter"
            },
            ["ppt-private-view"] = new()
            {
                AutomationId = "toggleEnablePrivateViewingButton",
                // The label is "Private view" whichever way it is set, and the
                // button offers no toggle pattern, so the state is only in the
                // tooltip. Chromium publishes that as FullDescription, which
                // reads without hovering: "Prevent participants from moving..."
                // while private viewing is on, "Allow participants to move..."
                // while it is off.
                StateFromFullDescription = true,
                ActivePattern = @"^\s*Prevent\b",
                InactivePattern = @"^\s*Allow\b",
                RequiresRole = "presenter"
            },
            ["ppt-refresh"] = new()
            {
                Surface = "slideShow",
                AutomationId = "toolbarRefreshButton",
                RequiresRole = "presenter"
            },

            // The drawing tools are one single-select list, so the active tool
            // is readable from the selection rather than from a label.
            ["ppt-cursor"] = new()
            {
                Surface = "slideShow",
                ColorFromName = true,
                AutomationId = "ink-tool-4",
                RequiresRole = "presenter",
                StateFromSelection = true
            },
            ["ppt-laser"] = new()
            {
                Surface = "slideShow",
                ColorFromName = true,
                AutomationId = "ink-tool-3",
                RequiresRole = "presenter",
                StateFromSelection = true
            },
            ["ppt-pen"] = new()
            {
                Surface = "slideShow",
                ColorFromName = true,
                AutomationId = "ink-tool-0",
                RequiresRole = "presenter",
                StateFromSelection = true
            },
            ["ppt-highlighter"] = new()
            {
                Surface = "slideShow",
                ColorFromName = true,
                AutomationId = "ink-tool-1",
                RequiresRole = "presenter",
                StateFromSelection = true
            },
            ["ppt-eraser"] = new()
            {
                Surface = "slideShow",
                ColorFromName = true,
                AutomationId = "ink-tool-2",
                RequiresRole = "presenter",
                StateFromSelection = true
            },

            ["ppt-copy-link"] = new()
            {
                Surface = "slideShow",
                Menu = "toolbarShareButton",
                MenuItemAutomationId = "toolbarShareButtonMenuListCopyLinkItem",
                RequiresRole = "presenter"
            },
            ["ppt-hide-presenter-view"] = new()
            {
                Surface = "slideShow",
                Menu = "toolbarChangeViewButton",
                MenuItemAutomationId = "toolbarPresenterUIHideOverflowButton",
                // Teams replaces the entry with its opposite rather than
                // checking it, so both ids are needed for one key to toggle.
                MenuItemToggleAutomationId = "toolbarPresenterUIShowOverflowButton",
                // The notes pane existing is what "presenter view is showing"
                // actually means, and it survives the menu closing.
                ActiveWhenPresentAutomationId = "notes-pane-parent",
                RequiresRole = "presenter"
            },
            ["ppt-layout-content"] = new()
            {
                Menu = "ppt-sharing-layout-toolbar",
                MenuItemAutomationId = "pptContentOnlyButton",
                RequiresRole = "presenter"
            },
            // Teams disables Cameo until your camera is on, which the sidecar
            // reports as unavailable without needing to know why.
            ["ppt-layout-cameo"] = new()
            {
                Menu = "ppt-sharing-layout-toolbar",
                MenuItemAutomationId = "pptCameoButton",
                RequiresRole = "presenter"
            }
        }
    };
}
