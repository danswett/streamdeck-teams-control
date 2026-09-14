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
            }
        }
    };
}
