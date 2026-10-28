namespace TeamsBridge;

public sealed class CameraVideoSettingsSpec
{
    public string PaneTabsAutomationId { get; set; } = "video-effects-and-settings-menu";
    public string SettingsTabName { get; set; } = "Settings";
    public string MirrorName { get; set; } = "Mirror my video";
    public string SoftFocusName { get; set; } = "Soft focus";
    public string BrightnessName { get; set; } = "Adjust brightness";
    public string MoreSettingsName { get; set; } = "More video effects and settings";
    public string ClosePaneName { get; set; } = "Close video effects and settings pane";

    internal string? Validate()
    {
        foreach (var (name, value) in new[]
        {
            (nameof(PaneTabsAutomationId), PaneTabsAutomationId),
            (nameof(SettingsTabName), SettingsTabName),
            (nameof(MirrorName), MirrorName),
            (nameof(SoftFocusName), SoftFocusName),
            (nameof(BrightnessName), BrightnessName),
            (nameof(MoreSettingsName), MoreSettingsName),
            (nameof(ClosePaneName), ClosePaneName)
        })
            if (string.IsNullOrWhiteSpace(value)) return $"{name} must not be empty";
        return null;
    }
}
