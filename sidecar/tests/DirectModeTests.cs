using TeamsBridge;
using Xunit;

namespace TeamsBridge.Tests;

/// <summary>
/// Direct mode is the optional path, so the property that matters most is that
/// it stays out of the way: off unless asked for, and declining rather than
/// failing whenever it has nothing better to offer than UI Automation.
/// </summary>
public class DirectModeTests
{
    // ------------------------------------------------------------- config

    [Fact]
    public void Direct_mode_is_off_unless_the_config_asks_for_it()
    {
        var cfg = Program.ParseConfig("{}");

        Assert.NotNull(cfg);
        Assert.False(cfg!.DirectMode.Enabled);
    }

    [Fact]
    public void The_built_in_defaults_leave_direct_mode_off()
    {
        var cfg = Program.LoadConfig(Path.Combine(Path.GetTempPath(), "nope-" + Guid.NewGuid()));

        Assert.False(cfg.DirectMode.Enabled);
    }

    [Fact]
    public void Enabling_direct_mode_reads_the_port_and_the_flag()
    {
        var cfg = Program.ParseConfig("""
        { "directMode": { "enabled": true, "port": 9457 } }
        """);

        Assert.True(cfg!.DirectMode.Enabled);
        Assert.Equal(9457, cfg.DirectMode.Port);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(70000)]
    public void An_impossible_port_is_clamped_rather_than_accepted(int port)
    {
        var cfg = Program.ParseConfig($$"""{ "directMode": { "port": {{port}} } }""");

        Assert.InRange(cfg!.DirectMode.Port, 1, 65535);
    }

    [Fact]
    public void A_direct_mode_block_does_not_disturb_the_controls()
    {
        var cfg = Program.ParseConfig("""
        { "directMode": { "enabled": true }, "controls": { "mute": { "automationId": "mic" } } }
        """);

        Assert.True(cfg!.DirectMode.Enabled);
        Assert.Equal("mic", cfg.Controls["mute"].AutomationId);
    }

    // ------------------------------------------------- reading a result

    [Fact]
    public void A_successful_script_reports_success()
    {
        var outcome = DomActuator.Interpret("""{"ok":true}""", "react-like", out _);

        Assert.True(outcome.Handled);
        Assert.True(outcome.Ok);
    }

    [Fact]
    public void A_control_with_no_click_handler_is_declined_not_failed()
    {
        // Declining sends the press to UI Automation silently. Reporting a
        // failure instead would log noise for what is a normal outcome on a
        // control Teams has disabled.
        var outcome = DomActuator.Interpret("""{"noHandler":true}""", "mute", out _);

        Assert.False(outcome.Handled);
        Assert.False(outcome.Ok);
    }

    [Fact]
    public void A_script_error_is_reported_so_the_fallback_is_logged()
    {
        var outcome = DomActuator.Interpret("""{"error":"item not found in menu"}""", "blur", out _);

        Assert.True(outcome.Handled);
        Assert.False(outcome.Ok);
        Assert.Equal("item not found in menu", outcome.Error);
    }

    [Fact]
    public void An_unreadable_result_fails_rather_than_throwing()
    {
        var outcome = DomActuator.Interpret("not json at all", "blur", out _);

        Assert.True(outcome.Handled);
        Assert.False(outcome.Ok);
    }

    [Fact]
    public void Nothing_at_all_fails_rather_than_throwing()
    {
        var outcome = DomActuator.Interpret(null, "blur", out _);

        Assert.False(outcome.Ok);
    }

    [Theory]
    [InlineData("""{"ok":true,"checkedBefore":true}""", true)]
    [InlineData("""{"ok":true,"checkedBefore":false}""", false)]
    public void The_checked_state_read_inside_the_menu_is_carried_back(string json, bool expected)
    {
        // A checkbox inside a flyout can only be read while the flyout is open,
        // so the script reads it there and the sidecar records the flipped
        // value. Losing it means the key never shows state.
        DomActuator.Interpret(json, "ppt-hide-presenter-view", out var wasChecked);

        Assert.Equal(expected, wasChecked);
    }

    [Fact]
    public void A_result_without_a_checked_state_reports_none()
    {
        DomActuator.Interpret("""{"ok":true}""", "react-like", out var wasChecked);

        Assert.Null(wasChecked);
    }

    // --------------------------------------------------- building script

    [Fact]
    public void A_control_with_no_id_is_declined()
    {
        var script = DomActuator.BuildDirectClick(new ControlSpec { AutomationId = "" }, null);

        Assert.Null(script);
    }

    [Fact]
    public void A_direct_click_looks_the_control_up_by_its_id()
    {
        var script = DomActuator.BuildDirectClick(
            new ControlSpec { AutomationId = "share-button" }, null);

        Assert.Contains("\"share-button\"", script);
        Assert.Contains("getElementById", script);
    }

    [Fact]
    public void A_menu_with_nothing_to_match_on_is_declined()
    {
        // Neither an item id nor a name pattern: UI Automation has other ways
        // to find it, so there is nothing to gain by guessing here.
        var script = DomActuator.BuildMenuWalk(
            new ControlSpec { Menu = "reaction-menu-button" }, null);

        Assert.Null(script);
    }

    [Fact]
    public void A_menu_walk_carries_the_trigger_and_the_item()
    {
        var script = DomActuator.BuildMenuWalk(new ControlSpec
        {
            Menu = "reaction-menu-button",
            MenuItemAutomationId = "applause-button"
        }, null);

        Assert.Contains("\"reaction-menu-button\"", script);
        Assert.Contains("\"applause-button\"", script);
    }

    [Fact]
    public void A_menu_walk_hides_the_popup_and_always_takes_the_style_back_down()
    {
        // The stylesheet is what makes the flyout invisible. If it could be
        // left behind, Teams' own menus would stay invisible to the user -
        // a far worse failure than the one this exists to fix.
        var script = DomActuator.BuildMenuWalk(new ControlSpec
        {
            Menu = "reaction-menu-button",
            MenuItemAutomationId = "applause-button"
        }, null);

        Assert.Contains("opacity:0", script);
        Assert.Contains("finally", script);
        Assert.Contains("style.remove()", script);
    }

    [Fact]
    public void A_menu_walk_sweeps_up_a_stylesheet_a_previous_press_left_behind()
    {
        var script = DomActuator.BuildMenuWalk(new ControlSpec
        {
            Menu = "reaction-menu-button",
            MenuItemAutomationId = "applause-button"
        }, null);

        Assert.Contains("stale", script);
    }

    [Fact]
    public void Both_ids_of_a_swapped_menu_entry_are_looked_for()
    {
        // Teams replaces "Hide presenter view" with "Show presenter view"
        // rather than checking it, so only one of the pair ever exists.
        var script = DomActuator.BuildMenuWalk(new ControlSpec
        {
            Menu = "toolbarChangeViewButton",
            MenuItemAutomationId = "toolbarPresenterUIHideOverflowButton",
            MenuItemToggleAutomationId = "toolbarPresenterUIShowOverflowButton"
        }, null);

        Assert.Contains("toolbarPresenterUIHideOverflowButton", script);
        Assert.Contains("toolbarPresenterUIShowOverflowButton", script);
    }

    // ----------------------------------------------------------- escaping

    [Theory]
    [InlineData("plain", "\"plain\"")]
    [InlineData("has \"quotes\"", "\"has \\u0022quotes\\u0022\"")]
    [InlineData("back\\slash", "\"back\\\\slash\"")]
    public void A_value_crossing_into_script_is_escaped(string input, string expected)
    {
        Assert.Equal(expected, DomActuator.Js(input));
    }

    [Fact]
    public void A_null_value_becomes_a_script_null_not_the_word()
    {
        Assert.Equal("null", DomActuator.Js(null));
    }

    [Fact]
    public void A_newline_cannot_break_out_of_its_string_literal()
    {
        var js = DomActuator.Js("line\nbreak");

        Assert.DoesNotContain("\n", js);
    }

    [Fact]
    public void Empty_entries_are_dropped_from_an_id_list()
    {
        var js = DomActuator.JsArray(new[] { "a", null, "", "b" });

        Assert.Equal("[\"a\",\"b\"]", js);
    }

    // ----------------------------------------------------- argument fill

    [Fact]
    public void A_configured_argument_is_substituted_into_a_selector()
    {
        var filled = DomActuator.Fill("translate-{arg}", "de-DE");

        Assert.Equal("translate-de-DE", filled);
    }

    [Fact]
    public void A_selector_without_a_placeholder_is_left_alone()
    {
        Assert.Equal("like-button", DomActuator.Fill("like-button", "ignored"));
    }

    [Fact]
    public void An_argument_going_into_a_name_pattern_is_regex_escaped()
    {
        // The same {arg} reaches an id in one place and a pattern in another.
        // The UI Automation path escapes it for the pattern; without the same
        // treatment here one config entry would mean a literal on one path and
        // live regex syntax on the other.
        var filled = DomActuator.Fill("^{arg}$", "a.b(c)", forRegex: true);

        Assert.DoesNotContain("(c)", filled);
        Assert.Contains(@"a\.b", filled);
    }

    // ------------------------------------------------- connection guards

    [Theory]
    [InlineData("ws://127.0.0.1:9457/devtools/page/AB", true)]
    [InlineData("ws://[::1]:9457/devtools/page/AB", true)]
    public void A_loopback_target_on_the_configured_port_is_connectable(string url, bool expected)
    {
        Assert.Equal(expected, Cdp.IsConnectable(url, 9457));
    }

    [Theory]
    // A different port: the endpoint would be choosing where we connect.
    [InlineData("ws://127.0.0.1:9999/devtools/page/AB")]
    // Off-box entirely.
    [InlineData("ws://192.0.2.1:9457/devtools/page/AB")]
    [InlineData("ws://evil.example:9457/devtools/page/AB")]
    // Wrong scheme.
    [InlineData("http://127.0.0.1:9457/devtools/page/AB")]
    [InlineData("file:///c:/windows/system32/cmd.exe")]
    // Not a URL at all.
    [InlineData("not a url")]
    [InlineData("")]
    public void A_target_we_did_not_ask_for_is_refused(string url)
    {
        // Proven necessary: an endpoint advertising a URL on another port had
        // the sidecar connect to that port instead.
        Assert.False(Cdp.IsConnectable(url, 9457));
    }

    [Theory]
    [InlineData("https://pods.edog.officeapps.live.com/slideshow.aspx", true)]
    [InlineData("https://x.officeapps.live.com/slideshow.aspx?id=1", true)]
    // Substring matches that are not the slide show.
    [InlineData("https://attacker.example/evil?x=slideshow.aspx", false)]
    [InlineData("https://officeapps.live.com.attacker.example/slideshow.aspx", false)]
    [InlineData("http://pods.officeapps.live.com/slideshow.aspx", false)]
    [InlineData("https://pods.officeapps.live.com/notslideshow", false)]
    public void Only_the_real_slide_show_document_is_driven(string url, bool expected)
    {
        Assert.Equal(expected, DomActuator.IsSlideShowTarget(url));
    }
}
