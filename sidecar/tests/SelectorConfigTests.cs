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
        var shipped = Path.Combine(repo, "com.bad-duck.teamscontrol.sdPlugin", "selectors.json");
        Assert.True(File.Exists(shipped), $"expected {shipped}");

        var parsed = Program.ParseConfig(File.ReadAllText(shipped));

        Assert.NotNull(parsed);
        Assert.NotEmpty(parsed!.Controls);
        foreach (var (key, spec) in parsed.Controls)
            Assert.True(spec.Validate() is null, $"{key}: {spec.Validate()}");

        Assert.Null(parsed.PowerPointLive.Validate());
    }

    [Fact]
    public void ParseConfig_reads_the_two_level_menu_fields_slide_translation_needs()
    {
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "ppt-translate": {
                  "menu": "toolbarChangeViewButton",
                  "submenu": "toolbarTranslateSlidesOverflowButton",
                  "menuItemAutomationId": "toolbarTranslateSlidesLanguageMenuItem-{arg}"
                }
              }
            }
            """);

        var spec = cfg!.Controls["ppt-translate"];
        Assert.Equal("toolbarChangeViewButton", spec.Menu);
        Assert.Equal("toolbarTranslateSlidesOverflowButton", spec.Submenu);
        Assert.Equal("toolbarTranslateSlidesLanguageMenuItem-{arg}", spec.MenuItemAutomationId);
    }

    [Fact]
    public void ParseConfig_reads_the_role_a_control_is_limited_to()
    {
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "ppt-take-control": {
                  "automationId": "takeControlPptBtn",
                  "requiresRole": "attendee"
                }
              }
            }
            """);

        Assert.Equal("attendee", cfg!.Controls["ppt-take-control"].RequiresRole);
    }

    [Fact]
    public void A_control_with_no_role_is_offered_in_both_roles()
    {
        var cfg = Program.ParseConfig("""
            { "controls": { "ppt-next": { "automationId": "nextSlideButton" } } }
            """);

        Assert.Null(cfg!.Controls["ppt-next"].RequiresRole);
    }

    [Fact]
    public void ParseConfig_reads_the_PowerPoint_Live_section()
    {
        var cfg = Program.ParseConfig("""
            {
              "powerPointLive": {
                "rootAutomationId": "custom-root",
                "presenterClassPattern": "is-presenting",
                "slidePositionPattern": "^(\\d+) / (\\d+)$"
              }
            }
            """);

        Assert.Equal("custom-root", cfg!.PowerPointLive.RootAutomationId);
        Assert.Equal("is-presenting", cfg.PowerPointLive.PresenterClassPattern);
        Assert.Equal(@"^(\d+) / (\d+)$", cfg.PowerPointLive.SlidePositionPattern);

        // Untouched fields keep the built-in value rather than blanking.
        Assert.Equal("slideShowToolbarId", cfg.PowerPointLive.ToolbarAutomationId);
        Assert.Equal("slideshow-app-attendee-role", cfg.PowerPointLive.AttendeeClassPattern);
    }

    [Fact]
    public void A_config_with_no_PowerPoint_Live_section_keeps_the_defaults()
    {
        var path = WriteTemp("""{ "controls": {} }""");
        var config = Program.LoadConfig(path);

        Assert.Equal("ppt-previewer-root", config.PowerPointLive.RootAutomationId);
        Assert.Null(config.PowerPointLive.Validate());
    }

    [Fact]
    public void A_broken_PowerPoint_Live_pattern_is_rejected_and_the_default_kept()
    {
        var path = WriteTemp("""
            {
              "powerPointLive": { "slidePositionPattern": "^(\\d+" },
              "controls": { "mute": { "automationId": "custom-mic" } }
            }
            """);

        var config = Program.LoadConfig(path);

        // The bad section is dropped whole, and the valid control beside it still lands.
        Assert.Equal(@"^\s*(\d+)\s*(?:of|/)\s*(\d+)\s*$", config.PowerPointLive.SlidePositionPattern);
        Assert.Equal("custom-mic", config.Controls["mute"].AutomationId);
    }

    [Fact]
    public void PowerPointLive_Validate_names_the_field_that_is_wrong()
    {
        var spec = new PowerPointLiveSpec { DeckTitlePattern = "(unclosed" };

        Assert.Contains("deckTitlePattern", spec.Validate());
    }

    [Fact]
    public void The_slide_counter_pattern_reads_the_position_Teams_renders()
    {
        var rx = new PowerPointLiveSpec().SlidePositionRegex!;

        var m = rx.Match("3 of 19");
        Assert.True(m.Success);
        Assert.Equal("3", m.Groups[1].Value);
        Assert.Equal("19", m.Groups[2].Value);

        // Must not match the other numbers that share the slide-show tree.
        Assert.False(rx.IsMatch("Slide 3"));
        Assert.False(rx.IsMatch("Elapsed time 15:18"));
    }

    [Fact]
    public void The_deck_title_pattern_strips_the_wrapper_Teams_adds()
    {
        var rx = new PowerPointLiveSpec().DeckTitleRegex!;

        var m = rx.Match("SlideShow - 2026_09_17_Windows+M365_PSM_Exec_Check-in_Sep.pptx");
        Assert.True(m.Success);
        Assert.Equal("2026_09_17_Windows+M365_PSM_Exec_Check-in_Sep.pptx", m.Groups[1].Value);
    }

    [Fact]
    public void The_role_patterns_tell_the_two_slide_show_roles_apart()
    {
        var spec = new PowerPointLiveSpec();
        const string attendee = "slideshow-app-transparent ppt-root-reflow slideshow-app-attendee-role";

        Assert.True(spec.AttendeeRegex!.IsMatch(attendee));
        Assert.False(spec.PresenterRegex!.IsMatch(attendee));
    }

    [Fact]
    public void ParseConfig_reads_the_swapped_menu_item_id_a_one_key_toggle_needs()
    {
        // Teams replaces "Hide presenter view" with "Show presenter view"
        // rather than checking it, so one key has to know both ids.
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "ppt-hide-presenter-view": {
                  "menu": "toolbarChangeViewButton",
                  "menuItemAutomationId": "toolbarPresenterUIHideOverflowButton",
                  "menuItemToggleAutomationId": "toolbarPresenterUIShowOverflowButton"
                }
              }
            }
            """);

        var spec = cfg!.Controls["ppt-hide-presenter-view"];
        Assert.Equal("toolbarPresenterUIHideOverflowButton", spec.MenuItemAutomationId);
        Assert.Equal("toolbarPresenterUIShowOverflowButton", spec.MenuItemToggleAutomationId);
    }

    [Fact]
    public void ParseConfig_reads_selection_based_state()
    {
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "ppt-laser": { "automationId": "ink-tool-3", "stateFromSelection": true },
                "ppt-next": { "automationId": "nextSlideButton" }
              }
            }
            """);

        Assert.True(cfg!.Controls["ppt-laser"].StateFromSelection);
        Assert.False(cfg.Controls["ppt-next"].StateFromSelection);
    }

    [Fact]
    public void Taking_control_and_stopping_a_presentation_are_opposite_roles()
    {
        // Pressing "Take control" turns an attendee into the presenter, so the
        // two keys must never be offered together - one retiring is what makes
        // the other appear.
        var config = Program.LoadConfig("nope");

        Assert.Equal("attendee", config.Controls["ppt-take-control"].RequiresRole);
        Assert.Equal("presenter", config.Controls["ppt-stop-presenting"].RequiresRole);
    }

    [Fact]
    public void Every_drawing_tool_is_presenter_only_and_reads_its_own_selection()
    {
        var config = Program.LoadConfig("nope");

        foreach (var key in new[] { "ppt-cursor", "ppt-laser", "ppt-pen", "ppt-highlighter", "ppt-eraser" })
        {
            var spec = config.Controls[key];
            Assert.Equal("presenter", spec.RequiresRole);
            Assert.True(spec.StateFromSelection, $"{key} should read state from its selection");
            Assert.False(string.IsNullOrWhiteSpace(spec.AutomationId));
        }
    }

    [Fact]
    public void The_shipped_manifest_and_selectors_carry_no_byte_order_mark()
    {
        // Node's JSON.parse rejects a BOM outright, so a tool that rewrites
        // either file with one would break the plugin at load with no other
        // symptom.
        var repo = FindRepoRoot();
        foreach (var name in new[] { "manifest.json", "selectors.json" })
        {
            var path = Path.Combine(repo, "com.bad-duck.teamscontrol.sdPlugin", name);
            var bytes = File.ReadAllBytes(path);
            var hasBom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
            Assert.False(hasBom, $"{name} starts with a UTF-8 BOM");
        }
    }

    private static string FindRepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "package.json")))
            dir = Path.GetDirectoryName(dir);
        return dir ?? throw new InvalidOperationException("repo root not found");
    }
}
