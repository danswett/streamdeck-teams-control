using Xunit;

namespace TeamsBridge.Tests;

public class MusicModeDomTests
{
    private static CdpTarget Page(string name, string origin = "https://teams.microsoft.com/") =>
        new("page", name, origin, "ws://" + name);

    [Fact]
    public void Minimized_mini_toolbar_is_skipped_without_mutating_the_shared_meeting_target()
    {
        var mini = Page("mini");
        var full = Page("full");
        var calls = new List<CdpTarget>();
        var selected = MusicModeDom.FindPage(mini, () => [mini, full], page =>
        {
            calls.Add(page);
            return new(true, page == full ? """{"found":true}""" : """{"found":false}""", null);
        }, 8);
        Assert.Equal(full, selected);
        Assert.Equal(new[] { mini, full }, calls);
    }

    [Fact]
    public void A_full_cached_page_needs_no_additional_enumeration()
    {
        var full = Page("full");
        Assert.Equal(full, MusicModeDom.FindPage(full,
            () => throw new InvalidOperationException("Should not enumerate"),
            _ => new(true, """{"found":true}""", null), 8));
    }

    [Fact]
    public void Page_search_remains_bounded_and_only_touches_teams_pages()
    {
        var mini = Page("mini");
        var probes = 0;
        var pages = new List<CdpTarget> { Page("unrelated", "https://example.com/") };
        pages.AddRange(Enumerable.Range(0, 20).Select(i => Page("teams" + i)));
        Assert.Null(MusicModeDom.FindPage(mini, () => pages, _ =>
        {
            probes++;
            return CdpResult.Fail("unavailable");
        }, 8));
        Assert.Equal(9, probes);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("broken")]
    [InlineData("""{"found":null}""")]
    public void Unknown_page_probes_cannot_select_a_target(string reply)
    {
        Assert.Null(MusicModeDom.FindPage(Page("mini"), () => null, _ => new(true, reply, null), 8));
    }

    [Fact]
    public void Direct_mode_off_declines_without_changing_ui_or_opening_a_port()
    {
        var dom = new DomActuator(new DirectModeSpec());
        Assert.Null(dom.ToggleMusicMode(Defaults.Config().Controls["music-mode"]));
    }

    [Fact]
    public void Missing_direct_selector_declines_without_guessing_from_a_name_regex()
    {
        Assert.Null(MusicModeDom.BuildScript(new ControlSpec { Menu = "audio", MenuItemName = ".*" }, 2500));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Only_a_confirmed_boolean_can_be_successful(bool active)
    {
        var result = MusicModeDom.Interpret(new(true, $$"""{"ok":true,"active":{{active.ToString().ToLowerInvariant()}}}""", null));
        Assert.True(result.Ok);
        Assert.Equal(active, result.Active);
        Assert.False(result.SafeToFallback);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("[]")]
    [InlineData("broken")]
    [InlineData("""{"ok":true,"active":null,"safeToFallback":true}""")]
    public void Unknown_or_malformed_results_cannot_trigger_a_second_toggle(string? json)
    {
        var result = MusicModeDom.Interpret(new(true, json, null));
        Assert.False(result.Ok);
        Assert.False(result.SafeToFallback);
        Assert.NotEmpty(result.Error!);
    }

    [Fact]
    public void A_transport_timeout_is_an_uncertain_write_not_a_uia_retry()
    {
        var result = MusicModeDom.Interpret(CdpResult.Fail("timed out"));
        Assert.False(result.Ok);
        Assert.False(result.SafeToFallback);
    }

    [Fact]
    public void Failure_before_any_known_initial_state_or_write_can_fall_back_after_cleanup()
    {
        var result = MusicModeDom.Interpret(new(true, """{"ok":false,"safeToFallback":true,"error":"not found"}""", null));
        Assert.False(result.Ok);
        Assert.True(result.SafeToFallback);
    }

    [Fact]
    public void A_confirmed_change_with_failed_cleanup_is_explicit_and_never_toggled_back()
    {
        var result = MusicModeDom.Interpret(new(true, """{"ok":false,"active":true,"safeToFallback":false,"error":"cleanup failed"}""", null));
        Assert.False(result.Ok);
        Assert.True(result.Active);
        Assert.False(result.SafeToFallback);
        Assert.Equal("cleanup failed", result.Error);
    }

    [Fact]
    public void Dom_selector_is_optional_typed_and_validated()
    {
        Assert.Equal("custom", Program.ParseConfig("""{"controls":{"music-mode":{"menuItemDataTid":"custom"}}}""")!
            .Controls["music-mode"].MenuItemDataTid);
        Assert.Null(Program.ParseConfig("""{"controls":{"music-mode":{"menuItemDataTid":false}}}""")!
            .Controls["music-mode"].MenuItemDataTid);
        Assert.NotNull(new ControlSpec { MenuItemDataTid = " " }.Validate());
        Assert.Null(new ControlSpec().Validate());
    }

    [Fact]
    public void Selector_values_are_encoded_as_data_not_javascript_or_regular_expressions()
    {
        const string selector = "x\";throw new Error('injected');//";
        var script = MusicModeDom.BuildScript(new ControlSpec { Menu = selector, MenuItemDataTid = selector }, 2500)!;
        Assert.Contains(DomActuator.Js(selector), script);
        Assert.DoesNotContain("new RegExp", script);
        Assert.DoesNotContain(selector, script);
    }
}
