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
    public void ParseConfig_reads_the_name_fields_a_dialog_button_needs()
    {
        // These are parsed field by field, so a property added to ControlSpec
        // is silently dropped from selectors.json until it is added here too.
        // That failure is invisible - the override loads, the field is just
        // empty - so it is worth pinning down.
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "ppt-stop-presenting-confirm": {
                  "name": "Stop presenting",
                  "withinClass": "ui-dialog",
                  "requiresRole": "presenter"
                }
              }
            }
            """);

        var spec = cfg!.Controls["ppt-stop-presenting-confirm"];
        Assert.Equal("Stop presenting", spec.Name);
        Assert.Equal("ui-dialog", spec.WithinClass);
        Assert.Equal("presenter", spec.RequiresRole);
        Assert.True(spec.IsPressOnly);
    }

    [Fact]
    public void A_spec_naming_nothing_findable_is_not_press_only()
    {
        // An empty automationId used to match the first element without one,
        // which is most of the tree, so a mistyped override could press an
        // unrelated control. Nothing findable must mean nothing pressed.
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "typo": { "automationd": "oops" }
              }
            }
            """);

        var spec = cfg!.Controls["typo"];
        Assert.Equal("", spec.AutomationId);
        Assert.Null(spec.Name);
        Assert.False(spec.IsPressOnly);
    }

    [Fact]
    public void Every_built_in_default_has_a_usable_selector()
    {
        var config = Program.LoadConfig("nope");

        foreach (var (key, spec) in config.Controls)
        {
            Assert.True(
                !string.IsNullOrWhiteSpace(spec.AutomationId) ||
                !string.IsNullOrWhiteSpace(spec.Menu) ||
                !string.IsNullOrWhiteSpace(spec.Name),
                $"control '{key}' can neither be found directly, through a menu, nor by name");
            Assert.Null(spec.Validate());
        }
    }

    [Fact]
    public void A_name_only_control_is_press_only_and_scoped()
    {
        // Matching on a name is a last resort - it is localised, and a bare name
        // could collide with a toolbar button. Anything driven that way must be
        // confined to the dialog it belongs to, and must stay out of snapshots,
        // where finding it would cost a scan of every popup window on each poll.
        var config = Program.LoadConfig("nope");

        foreach (var (key, spec) in config.Controls)
        {
            if (string.IsNullOrWhiteSpace(spec.Name) || !string.IsNullOrWhiteSpace(spec.AutomationId))
            {
                Assert.False(spec.IsPressOnly, $"'{key}' should not be press-only");
                continue;
            }

            Assert.True(spec.IsPressOnly, $"'{key}' is name-only so it must be press-only");
            Assert.False(
                string.IsNullOrWhiteSpace(spec.WithinClass),
                $"'{key}' matches by name and must be scoped with withinClass");
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
    public void ParseConfig_reads_the_two_level_menu_fields_a_nested_item_needs()
    {
        // No shipped control is nested two levels deep now that slide
        // translation has been withdrawn, but the parser still supports it and
        // a selectors.json is user-editable, so the fields stay covered.
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "nested-example": {
                  "menu": "toolbarChangeViewButton",
                  "submenu": "someOverflowButton",
                  "menuItemAutomationId": "someLanguageMenuItem-{arg}"
                }
              }
            }
            """);

        var spec = cfg!.Controls["nested-example"];
        Assert.Equal("toolbarChangeViewButton", spec.Menu);
        Assert.Equal("someOverflowButton", spec.Submenu);
        Assert.Equal("someLanguageMenuItem-{arg}", spec.MenuItemAutomationId);
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
        Assert.DoesNotMatch(rx, "Slide 3");
        Assert.DoesNotMatch(rx, "Elapsed time 15:18");
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

        Assert.Matches(spec.AttendeeRegex!, attendee);
        Assert.DoesNotMatch(spec.PresenterRegex!, attendee);
    }

    [Fact]
    public void The_role_markers_are_the_two_mutually_exclusive_toolbar_buttons()
    {
        // These decide the role, not the root's CSS class. Hiding presenter
        // view rewrites that class to the attendee value while you are still
        // presenting, which retired every presenter key until the markers took
        // over. Verified on a live meeting 2026-09-17.
        var spec = new PowerPointLiveSpec();

        Assert.Equal("stopPresentingPptBtn", spec.PresenterMarkerAutomationId);
        Assert.Equal("takeControlPptBtn", spec.AttendeeMarkerAutomationId);
        Assert.NotEqual(spec.PresenterMarkerAutomationId, spec.AttendeeMarkerAutomationId);
    }

    [Fact]
    public void The_role_markers_match_the_controls_that_depend_on_them()
    {
        // The marker for a role is the very control only that role can use, so
        // a drift between the two would silently disable half the keys.
        var config = Program.LoadConfig("nope");

        Assert.Equal(
            config.PowerPointLive.PresenterMarkerAutomationId,
            config.Controls["ppt-stop-presenting"].AutomationId);
        Assert.Equal(
            config.PowerPointLive.AttendeeMarkerAutomationId,
            config.Controls["ppt-take-control"].AutomationId);
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
    public void ParseConfig_reads_the_surface_and_colour_fields()
    {
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "ppt-pen": {
                  "automationId": "ink-tool-0",
                  "surface": "slideShow",
                  "colorFromName": true
                }
              }
            }
            """);

        var spec = cfg!.Controls["ppt-pen"];
        Assert.Equal("slideShow", spec.Surface);
        Assert.True(spec.ColorFromName);
    }

    [Fact]
    public void Private_view_reads_its_state_from_the_tooltip()
    {
        // The button is labelled "Private view" whichever way it is set and
        // offers no toggle pattern, so the name says nothing. Chromium puts the
        // tooltip in FullDescription, where it does change.
        var config = Program.LoadConfig(Path.Combine(Path.GetTempPath(), "no-selectors-" + Guid.NewGuid()));
        var spec = config.Controls["ppt-private-view"];

        Assert.True(spec.StateFromFullDescription);
        Assert.Equal("presenter", spec.RequiresRole);

        // Captured live: the description states the action, so "Prevent" means
        // private viewing is currently on.
        Assert.Matches(spec.ActiveRegex!,
            "Prevent participants from moving through shared presentation on their own. Has context menu");
        Assert.Matches(spec.InactiveRegex!,
            "Allow participants to move through shared presentation on their own. Has context menu");

        // And they must not both match the same text, or the key would latch.
        Assert.DoesNotMatch(spec.ActiveRegex!,
            "Allow participants to move through shared presentation on their own. Has context menu");
        Assert.DoesNotMatch(spec.InactiveRegex!,
            "Prevent participants from moving through shared presentation on their own. Has context menu");
    }

    [Fact]
    public void ParseConfig_reads_stateFromFullDescription()
    {
        var cfg = Program.ParseConfig("""
            {
              "controls": {
                "ppt-private-view": {
                  "automationId": "toggleEnablePrivateViewingButton",
                  "stateFromFullDescription": true
                },
                "mute": { "automationId": "microphone-button" }
              }
            }
            """);

        Assert.True(cfg!.Controls["ppt-private-view"].StateFromFullDescription);
        Assert.False(cfg.Controls["mute"].StateFromFullDescription);
    }

    [Fact]
    public void The_default_ink_colours_are_the_ones_the_palettes_offer()
    {
        // Captured from a live presenter session, from all three palettes: they
        // differ, and a name missing here cannot be read while its flyout is
        // open. The swatches carry no automation id, so names are the only
        // handle on them.
        var colors = new SelectorConfig().PowerPointLive.InkColorNames;

        // Pen.
        foreach (var expected in new[]
                 {
                     "Black", "Blue", "Dark purple", "Dark red", "Dark yellow", "Gray",
                     "Green", "Light blue", "Light gray", "Light green", "Light orange",
                     "Magenta", "Orange", "Purple", "Red"
                 })
        {
            Assert.Contains(expected, colors);
        }

        // Highlighter-only.
        foreach (var expected in new[] { "Yellow", "Pink", "Faded green", "Faded blue", "Faded red" })
        {
            Assert.Contains(expected, colors);
        }

        // The pen's flyout also carries the laser pointer's arrow options, and
        // one of them always reports itself selected. Treating those as colours
        // would paint the key "No arrow".
        Assert.DoesNotContain("No arrow", colors);
        Assert.DoesNotContain("Single arrow", colors);
        Assert.DoesNotContain("Double arrows", colors);
    }

    [Fact]
    public void ParseConfig_reads_ink_colour_names()
    {
        var cfg = Program.ParseConfig("""
            {
              "powerPointLive": {
                "inkColorNames": ["Rot", "Blau", "Hellgrun"]
              }
            }
            """);

        Assert.Equal(new[] { "Rot", "Blau", "Hellgrun" }, cfg!.PowerPointLive.InkColorNames);
    }

    [Fact]
    public void An_empty_ink_colour_list_keeps_the_defaults()
    {
        // An empty list would otherwise disable colour reading outright, which
        // is never what someone editing this file means by it.
        var cfg = Program.ParseConfig("""
            {
              "powerPointLive": { "inkColorNames": [] }
            }
            """);

        Assert.Contains("Red", cfg!.PowerPointLive.InkColorNames);
    }

    [Fact]
    public void Every_slide_show_control_is_marked_so_it_survives_the_subtree_vanishing()
    {
        // Teams unmounts the slide-show subtree while a presentation is idle —
        // measured absent for 12 of 40 seconds on a live meeting. Anything
        // hosted there must be marked, or its key blinks out several times a
        // minute. Controls on the meeting toolbar must NOT be marked, because
        // theirs is stable and a stale reading would be wrong.
        var config = Program.LoadConfig("nope");

        var hosted = new[]
        {
            "ppt-prev", "ppt-next", "ppt-grid", "ppt-sync",
            "ppt-high-contrast", "ppt-hide-presenter-view",
            "ppt-refresh", "ppt-copy-link",
            "ppt-cursor", "ppt-laser", "ppt-pen", "ppt-highlighter", "ppt-eraser"
        };
        foreach (var key in hosted)
            Assert.Equal("slideShow", config.Controls[key].Surface);

        var meetingToolbar = new[]
        {
            "ppt-popout", "ppt-take-control", "ppt-stop-presenting",
            "ppt-private-view", "ppt-layout-content", "ppt-layout-cameo"
        };
        foreach (var key in meetingToolbar)
            Assert.True(string.IsNullOrEmpty(config.Controls[key].Surface),
                $"{key} is on the meeting toolbar and should not be marked as slide-show hosted");
    }

    [Fact]
    public void The_tool_colour_pattern_reads_the_ink_colour_Teams_names()
    {
        // Captured from a live meeting: the colour sits between the colon and
        // the thickness, and can be more than one word.
        var rx = new PowerPointLiveSpec().ToolColorRegex!;

        Assert.Equal("Light blue", rx.Match("Pen: Light blue, Thickness 3").Groups[1].Value);
        Assert.Equal("Light orange", rx.Match("Laser pointer: Light orange").Groups[1].Value);
        Assert.Equal("Pink", rx.Match("Highlighter: Pink, Thickness 3").Groups[1].Value);

        // Tools with no ink colour say nothing extra.
        Assert.DoesNotMatch(rx, "Cursor");
        Assert.DoesNotMatch(rx, "Eraser");
    }

    [Fact]
    public void Only_the_tools_that_carry_an_ink_colour_report_one()
    {
        var config = Program.LoadConfig("nope");

        foreach (var key in new[] { "ppt-cursor", "ppt-laser", "ppt-pen", "ppt-highlighter", "ppt-eraser" })
            Assert.True(config.Controls[key].ColorFromName, $"{key} should report its colour");

        Assert.False(config.Controls["ppt-next"].ColorFromName);
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
