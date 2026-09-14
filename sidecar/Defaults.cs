namespace TeamsBridge;

/// <summary>
/// Built-in selector map. Every AutomationId here was observed directly on the
/// Teams meeting toolbar (ClassName TeamsWebView, toolbar "horizontalMiddleEnd").
/// AutomationIds are locale-independent; the name patterns used for state are
/// English and can be overridden with an external selectors.json.
/// </summary>
public static class Defaults
{
    public static SelectorConfig Config() => new()
    {
        Version = 1,
        MeetingProbeAutomationId = "microphone-button",
        Controls = new Dictionary<string, ControlSpec>
        {
            // ---- Direct toolbar controls (confirmed) ----
            ["mute"] = new()
            {
                AutomationId = "microphone-button",
                // The label states the action, so "Unmute mic" means you are muted.
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

            // ---- Flyout-nested controls ----
            // AutomationIds are filled in by `discover`; the name patterns let
            // these work on an English client before that mapping is captured.
            ["hand"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemName = @"(raise|lower)\s+(your\s+)?hand"
            },
            ["react-like"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemName = @"^\s*(like|thumbs\s*up)\b"
            },
            ["react-love"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemName = @"^\s*(love|heart)\b"
            },
            ["react-applause"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemName = @"^\s*(applause|applaud|clap)\b"
            },
            ["react-laugh"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemName = @"^\s*(laugh|haha)\b"
            },
            ["react-wow"] = new()
            {
                Menu = "reaction-menu-button",
                MenuItemName = @"^\s*(wow|surprised)\b"
            },
            ["blur"] = new()
            {
                Menu = "video-button-configure",
                MenuItemName = @"blur|background\s+effects"
            }
        }
    };
}
