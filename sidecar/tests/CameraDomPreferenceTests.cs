using Xunit;

namespace TeamsBridge.Tests;

public class CameraDomPreferenceTests
{
    [Fact]
    public async Task Preferences_allow_a_slow_settings_pane_without_exhausting_the_single_click_budget()
    {
        const string arg = """{"cameras":[{"id":"one","mirror":"on","softFocus":"off","brightness":"on"}]}""";
        var timeoutMs = CameraDom.OperationTimeoutMs(arg, 2500);
        var script = CameraDom.BuildScript(Defaults.Config().Controls["camera-select"],
            arg, false, timeoutMs);
        Assert.NotNull(script);
        await CameraDomTests.RunScript(script, "slow-pane", "camera-preferences-dom-harness.cjs");
    }

    [Theory]
    [InlineData("select")]
    [InlineData("camera-noop")]
    [InlineData("preferences-noop")]
    [InlineData("swap-first")]
    [InlineData("swap-second")]
    [InlineData("swap-third")]
    [InlineData("unchanged")]
    [InlineData("focus-only")]
    [InlineData("brightness-only")]
    [InlineData("mirror-only")]
    [InlineData("user-pane")]
    [InlineData("user-pane-settings")]
    [InlineData("user-pane-missing-tab")]
    [InlineData("user-pane-restore-fails")]
    [InlineData("user-flyout")]
    [InlineData("user-flyout-missing-tab")]
    [InlineData("detach-before-write")]
    [InlineData("fresh-already-desired")]
    [InlineData("stale-after-write")]
    [InlineData("unknown-initial")]
    [InlineData("unknown-before-write")]
    [InlineData("unknown-after-write")]
    [InlineData("disabled-switch")]
    [InlineData("indeterminate")]
    [InlineData("contradictory-state")]
    [InlineData("missing-switch")]
    [InlineData("ignored-write")]
    [InlineData("mirror-ignored-write")]
    [InlineData("throw-write")]
    [InlineData("missing-tab")]
    [InlineData("unknown-tab")]
    [InlineData("ignored-tab")]
    [InlineData("pane-open-fails")]
    [InlineData("late-pane")]
    [InlineData("ignored-close")]
    [InlineData("throw-close")]
    [InlineData("missing-close")]
    [InlineData("camera-changed")]
    [InlineData("camera-changed-after-mirror")]
    [InlineData("other-pane")]
    public async Task Preferences_use_fresh_desired_state_and_restore_owned_navigation(string scenario)
    {
        var swap = scenario.StartsWith("swap-");
        var first = scenario switch
        {
            "unchanged" => """{"id":"one","mirror":"unchanged","softFocus":"unchanged","brightness":"unchanged"}""",
            "focus-only" => """{"id":"one","softFocus":"off"}""",
            "brightness-only" => """{"id":"one","brightness":"on"}""",
            "mirror-only" => """{"id":"one","mirror":"on"}""",
            _ => """{"id":"one","mirror":"on","softFocus":"off","brightness":"on"}"""
        };
        var cameras = swap ? first + """,{"id":"two","mirror":"off","softFocus":"on","brightness":"off"}""" : first;
        var arg = """{"cameras":[""" + cameras + "]}";
        var script = CameraDom.BuildScript(Defaults.Config().Controls[swap ? "camera-swap" : "camera-select"],
            arg, swap, 2500);
        Assert.NotNull(script);
        await CameraDomTests.RunScript(script, scenario, "camera-preferences-dom-harness.cjs");
    }

    [Theory]
    [InlineData("""{"cameras":[]}""")]
    [InlineData("""{"cameras":[{"id":"one","mirror":true}]}""")]
    [InlineData("""{"cameras":[{"id":"one","brightness":"invalid"}]}""")]
    [InlineData("""{"cameras":[{"id":"","softFocus":"on"}]}""")]
    [InlineData("""{"cameras":[{"id":"one"},{"id":"two"}]}""")]
    [InlineData("""{"cameras":null}""")]
    [InlineData("{broken")]
    public void Invalid_preference_envelopes_never_generate_a_write(string arg) =>
        Assert.Null(CameraDom.BuildScript(Defaults.Config().Controls["camera-select"], arg, false, 2500));

    [Fact]
    public void Preference_parser_matches_the_camera_preferences_protocol_and_legacy_IDs()
    {
        var choices = CameraArguments.Parse(
            """{"cameras":[{"id":"one","mirror":"on","softFocus":"off","brightness":"unchanged"},{"id":"two"}]}""", true);
        Assert.NotNull(choices);
        Assert.Equal(new CameraChoice("one", new(true, false, null)), choices[0]);
        Assert.Equal(new CameraChoice("two", new()), choices[1]);
        Assert.Equal(new CameraChoice("legacy", new()), Assert.Single(CameraArguments.Parse("legacy", false)!));
        Assert.Null(CameraArguments.Parse("""{"cameras":[{"id":"one"},{"id":"ONE"}]}""", true));
    }

    [Fact]
    public void Configured_preference_selectors_are_encoded_as_data()
    {
        var selectors = new CameraVideoSettingsSpec
        {
            PaneTabsAutomationId = "tabs'\"\\",
            PaneDataTid = "panel'\"\\",
            SettingsTabName = "settings'\"\\",
            MirrorName = "mirror'\"\\",
            SoftFocusName = "focus'\"\\",
            BrightnessName = "brightness'\"\\",
            MoreSettingsName = "more'\"\\",
            ClosePaneName = "close'\"\\"
        };
        var script = CameraDom.BuildScript(Defaults.Config().Controls["camera-select"],
            """{"cameras":[{"id":"one","mirror":"on"}]}""", false, 2500, selectors)!;
        foreach (var value in new[] { selectors.PaneTabsAutomationId, selectors.PaneDataTid, selectors.SettingsTabName,
            selectors.MirrorName, selectors.SoftFocusName, selectors.BrightnessName, selectors.MoreSettingsName, selectors.ClosePaneName })
            Assert.Contains(DomActuator.Js(value), script);
    }
}
