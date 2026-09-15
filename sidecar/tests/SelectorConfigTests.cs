using TeamsBridge;
using Xunit;

namespace TeamsBridge.Tests;

/// <summary>
/// The overlay behaviour matters more than it looks: a selectors.json written
/// against an older version must never be able to remove a control, only
/// change the ones it names.
/// </summary>
public class SelectorConfigTests : IDisposable
{
    private readonly List<string> _temp = new();

    private string WriteTemp(string json)
    {
        var path = Path.Combine(Path.GetTempPath(), $"sel-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, json);
        _temp.Add(path);
        return path;
    }

    public void Dispose()
    {
        foreach (var p in _temp) { try { File.Delete(p); } catch { } }
    }

    [Fact]
    public void A_missing_file_leaves_the_built_in_defaults_intact()
    {
        var config = Program.LoadConfig(Path.Combine(Path.GetTempPath(), "does-not-exist-" + Guid.NewGuid()));

        Assert.NotEmpty(config.Controls);
        Assert.True(config.Controls.ContainsKey("mute"));
    }

    [Fact]
    public void Malformed_json_falls_back_to_the_defaults_instead_of_throwing()
    {
        var path = WriteTemp("{ this is not json");

        var config = Program.LoadConfig(path);

        Assert.True(config.Controls.ContainsKey("mute"));
    }

    [Fact]
    public void An_override_replaces_only_the_control_it_names()
    {
        var before = Program.LoadConfig("nope");
        var path = WriteTemp("""
            { "version": 1, "controls": { "mute": { "automationId": "custom-mic" } } }
            """);

        var config = Program.LoadConfig(path);

        Assert.Equal("custom-mic", config.Controls["mute"].AutomationId);
        Assert.Equal(before.Controls.Count, config.Controls.Count);
        Assert.Equal(before.Controls["camera"].AutomationId, config.Controls["camera"].AutomationId);
    }

    [Fact]
    public void An_override_with_a_broken_pattern_is_skipped_and_the_default_kept()
    {
        var before = Program.LoadConfig("nope");
        var path = WriteTemp("""
            { "controls": { "mute": { "automationId": "custom-mic", "activePattern": "^[oops" } } }
            """);

        var config = Program.LoadConfig(path);

        // The whole override is dropped, so the working default survives rather
        // than a half-applied spec that can find a control but never read it.
        Assert.Equal(before.Controls["mute"].AutomationId, config.Controls["mute"].AutomationId);
    }

    [Fact]
    public void One_broken_override_does_not_discard_the_valid_ones_beside_it()
    {
        var path = WriteTemp("""
            {
              "controls": {
                "mute":   { "automationId": "custom-mic", "activePattern": "^[oops" },
                "camera": { "automationId": "custom-cam" }
              }
            }
            """);

        var config = Program.LoadConfig(path);

        Assert.Equal("custom-cam", config.Controls["camera"].AutomationId);
        Assert.NotEqual("custom-mic", config.Controls["mute"].AutomationId);
    }

    [Fact]
    public void The_meeting_probe_and_full_toolbar_ids_can_be_overridden()
    {
        var path = WriteTemp("""
            { "meetingProbeAutomationId": "probe-x", "fullToolbarAutomationId": "toolbar-x" }
            """);

        var config = Program.LoadConfig(path);

        Assert.Equal("probe-x", config.MeetingProbeAutomationId);
        Assert.Equal("toolbar-x", config.FullToolbarAutomationId);
    }

    [Fact]
    public void An_empty_probe_id_is_ignored_rather_than_blanking_the_default()
    {
        var path = WriteTemp("""{ "meetingProbeAutomationId": "" }""");

        var config = Program.LoadConfig(path);

        Assert.False(string.IsNullOrWhiteSpace(config.MeetingProbeAutomationId));
    }

    [Fact]
    public void ParseConfig_reads_the_flyout_fields_a_reaction_needs()
    {
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "react-like": {
                  "automationId": "",
                  "menu": "reaction-menu-button",
                  "menuItemAutomationId": "like-button",
                  "menuItemName": "^like$"
                }
              }
            }
            """);

        var spec = cfg!.Controls["react-like"];
        Assert.Equal("reaction-menu-button", spec.Menu);
        Assert.Equal("like-button", spec.MenuItemAutomationId);
        Assert.Equal("^like$", spec.MenuItemName);
    }

    [Fact]
    public void Every_built_in_default_has_a_usable_selector()
    {
        var config = Program.LoadConfig("nope");

        foreach (var (key, spec) in config.Controls)
        {
            Assert.True(
                !string.IsNullOrWhiteSpace(spec.AutomationId) || !string.IsNullOrWhiteSpace(spec.Menu),
                $"control '{key}' can neither be found directly nor through a menu");
            Assert.Null(spec.Validate());
        }
    }

    [Fact]
    public void The_shipped_selectors_file_is_valid()
    {
        // Guards against shipping a selectors.json that the sidecar would reject
        // at runtime - the file is data, so nothing else would catch it.
        var repo = FindRepoRoot();
        var shipped = Path.Combine(repo, "com.dswett.teamscontrol.sdPlugin", "selectors.json");
        Assert.True(File.Exists(shipped), $"expected {shipped}");

        var parsed = Program.ParseConfig(File.ReadAllText(shipped));

        Assert.NotNull(parsed);
        Assert.NotEmpty(parsed!.Controls);
        foreach (var (key, spec) in parsed.Controls)
            Assert.True(spec.Validate() is null, $"{key}: {spec.Validate()}");
    }

    private static string FindRepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "package.json")))
            dir = Path.GetDirectoryName(dir);
        return dir ?? throw new InvalidOperationException("repo root not found");
    }
}
