using System.Diagnostics;
using System.Text.Json;
using Xunit;

namespace TeamsBridge.Tests;

public class CameraDomTests
{
    private static CdpTarget Page(string name, string url = "https://teams.microsoft.com/") =>
        new("page", "", url, "ws://" + name);

    [Fact]
    public void Camera_probe_skips_mini_meeting_without_replacing_the_shared_cached_target()
    {
        var mini = Page("mini");
        var full = Page("full");
        var calls = new List<CdpTarget>();
        Assert.Equal(full, CameraDom.FindPage(mini, () => [mini, full], page =>
        {
            calls.Add(page);
            return new(true, page == full ? """{"found":true}""" : """{"found":false}""", null);
        }, 8));
        Assert.Equal(new[] { mini, full }, calls);
    }

    [Fact]
    public void Cached_full_page_avoids_enumeration_but_is_probed_again_on_every_action()
    {
        var full = Page("full");
        var probes = 0;
        for (var i = 0; i < 2; i++)
            Assert.Equal(full, CameraDom.FindPage(full,
                () => throw new InvalidOperationException("Should not enumerate"),
                _ => { probes++; return new(true, """{"found":true}""", null); }, 8));
        Assert.Equal(2, probes);
    }

    [Fact]
    public void When_several_pages_answer_the_largest_wins_not_the_minimized_compact_view()
    {
        // Teams lists the 380x120 compact view first, and while the meeting is
        // minimized it carries the toolbar ids too.
        var gone = Page("gone");
        var compact = Page("compact");
        var full = Page("full");
        var main = Page("main");
        Assert.Equal(full, CameraDom.FindPage(gone, () => [compact, full, main], page => new(true,
            page == compact ? """{"found":true,"area":45600}""" :
            page == full ? """{"found":true,"area":1748212}""" :
            """{"found":false,"area":2825860}""", null), 8));
    }

    [Theory]
    [InlineData("""{"found":true,"area":1748212}""", 1748212)]
    [InlineData("""{"found":true}""", 0)]
    [InlineData("""{"found":true,"area":-5}""", 0)]
    [InlineData("""{"found":false,"area":99}""", -1)]
    [InlineData("broken", -1)]
    public void Meeting_page_probe_reports_area_only_for_a_found_page(string json, long expected) =>
        Assert.Equal(expected, DomActuator.MeetingPageArea(new(true, json, null)));

    [Fact]
    public void Page_search_is_bounded_and_only_probes_Teams_pages()
    {
        var probes = 0;
        var pages = new List<CdpTarget> { Page("unrelated", "https://example.com/") };
        pages.AddRange(Enumerable.Range(0, 20).Select(i => Page("teams" + i)));
        Assert.Null(CameraDom.FindPage(Page("mini"), () => pages, _ =>
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
    public void Unknown_probes_cannot_select_a_page(string json) =>
        Assert.Null(CameraDom.FindPage(Page("mini"), () => null, _ => new(true, json, null), 8));

    [Fact]
    public void Direct_off_declines_without_touching_a_port() =>
        Assert.Null(new DomActuator(new DirectModeSpec())
            .SelectCamera(Defaults.Config().Controls["camera-select"], "one", false));

    [Theory]
    [InlineData(false, """{"cameras":[{"id":"one","mirror":"on"}]}""")]
    [InlineData(true, """{"cameras":[{"id":"one"},{"id":"two","brightness":"off"}]}""")]
    public void Preference_envelopes_are_supported_without_treating_JSON_as_a_device_ID(bool swap, string arg)
    {
        var script = CameraDom.BuildScript(Defaults.Config().Controls["camera-select"], arg, swap, 2500);
        Assert.NotNull(script);
        Assert.Contains("const preferences =", script);
        Assert.DoesNotContain(DomActuator.Js(arg), script);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("""["one","one"]""")]
    public void Invalid_pairs_do_not_enter_the_Direct_path(string? arg) =>
        Assert.Null(CameraDom.BuildScript(Defaults.Config().Controls["camera-swap"], arg, true, 2500));

    [Fact]
    public void Missing_or_unsupported_selectors_decline_without_guessing()
    {
        Assert.Null(CameraDom.BuildScript(new ControlSpec { Menu = "video", MenuItemAutomationId = "{arg}" }, "one", false, 2500));
        var spec = Defaults.Config().Controls["camera-select"];
        spec.MenuItemName = ".*";
        Assert.Null(CameraDom.BuildScript(spec, "one", false, 2500));
    }

    [Theory]
    [InlineData("camera-select", nameof(ControlSpec.Submenu))]
    [InlineData("camera-select", nameof(ControlSpec.MenuItemOffName))]
    [InlineData("camera-select", nameof(ControlSpec.OffAutomationId))]
    [InlineData("camera-select", nameof(ControlSpec.OffName))]
    [InlineData("camera-swap", nameof(ControlSpec.Submenu))]
    [InlineData("camera-swap", nameof(ControlSpec.MenuItemOffName))]
    [InlineData("camera-swap", nameof(ControlSpec.OffAutomationId))]
    [InlineData("camera-swap", nameof(ControlSpec.OffName))]
    public void Each_unsupported_camera_selector_independently_declines_Direct(string target, string selector)
    {
        var spec = Defaults.Config().Controls[target];
        var swap = target == "camera-swap";
        var arg = swap ? """["one","two"]""" : "one";
        Assert.NotNull(CameraDom.BuildScript(spec, arg, swap, 2500));

        switch (selector)
        {
            case nameof(ControlSpec.Submenu): spec.Submenu = "nested-menu"; break;
            case nameof(ControlSpec.MenuItemOffName): spec.MenuItemOffName = "off-item"; break;
            case nameof(ControlSpec.OffAutomationId): spec.OffAutomationId = "off-control"; break;
            case nameof(ControlSpec.OffName): spec.OffName = "off-name"; break;
            default: throw new ArgumentOutOfRangeException(nameof(selector));
        }

        Assert.Null(CameraDom.BuildScript(spec, arg, swap, 2500));
    }

    [Fact]
    public void Both_camera_ids_use_the_same_configured_selector_templates_and_are_encoded_as_data()
    {
        var spec = Defaults.Config().Controls["camera-swap"];
        spec.MenuItemAutomationId = "camera-{arg}";
        spec.MenuItemToggleAutomationId = "alternate-{arg}";
        string[] pair = [@"\\?\usb#one\global", "x\";throw new Error('injected');//"];
        var script = CameraDom.BuildScript(spec, JsonSerializer.Serialize(pair), true, 2500)!;
        foreach (var id in pair)
        {
            Assert.Contains(DomActuator.Js("camera-" + id), script);
            Assert.Contains(DomActuator.Js("alternate-" + id), script);
        }
        Assert.DoesNotContain(pair[1], script);
        Assert.DoesNotContain("new RegExp", script);
    }

    [Fact]
    public void A_confirmed_selection_requires_successful_cleanup()
    {
        Assert.True(CameraDom.Interpret(new(true,
            """{"ok":true,"selectedId":"one","cleanupOk":true}""", null)).Ok);
        var failure = CameraDom.Interpret(new(true,
            """{"ok":false,"selectedId":"one","cleanupOk":false,"error":"cleanup failed"}""", null));
        Assert.False(failure.Ok);
        Assert.False(failure.SafeToFallback);
        Assert.Equal("cleanup failed", failure.Error);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("broken")]
    [InlineData("[]")]
    [InlineData("""{"ok":true}""")]
    [InlineData("""{"ok":true,"selectedId":null,"cleanupOk":true}""")]
    [InlineData("""{"ok":false,"safeToFallback":true}""")]
    [InlineData("""{"ok":null,"safeToFallback":true,"cleanupOk":true,"writeAttempted":false}""")]
    [InlineData("""{"ok":false,"selectedId":false,"safeToFallback":true,"cleanupOk":true,"writeAttempted":false}""")]
    [InlineData("""{"ok":false,"safeToFallback":true,"cleanupOk":true,"writeAttempted":true}""")]
    public void Unknown_or_malformed_results_cannot_trigger_UIA_or_swap_back(string? json)
    {
        var result = CameraDom.Interpret(new(true, json, null));
        Assert.False(result.Ok);
        Assert.False(result.SafeToFallback);
        Assert.NotEmpty(result.Error!);
    }

    [Fact]
    public void Transport_timeout_cannot_trigger_UIA_even_if_JavaScript_keeps_running()
    {
        var result = CameraDom.Interpret(CdpResult.Fail("timed out"));
        Assert.False(result.Ok);
        Assert.False(result.SafeToFallback);
        Assert.Contains("may already have changed", result.Error);
    }

    [Fact]
    public void Only_an_explicit_pre_write_failure_with_confirmed_cleanup_can_fall_back()
    {
        var result = CameraDom.Interpret(new(true,
            """{"ok":false,"safeToFallback":true,"cleanupOk":true,"writeAttempted":false,"error":"not found"}""", null));
        Assert.False(result.Ok);
        Assert.True(result.SafeToFallback);
    }

    [Fact]
    public void Declined_camera_Direct_routing_allows_UIA() =>
        Assert.Null(TeamsClient.TryDirectCamera(() => null));

    [Theory]
    [InlineData("""{"ok":true,"selectedId":"one","cleanupOk":true}""", true, false)]
    [InlineData("""{"ok":false,"safeToFallback":true,"cleanupOk":true,"writeAttempted":false,"error":"not found"}""", false, true)]
    [InlineData("""{"ok":false,"safeToFallback":true,"cleanupOk":true,"writeAttempted":true,"error":"unconfirmed"}""", false, false)]
    [InlineData("""{"ok":false,"safeToFallback":true,"cleanupOk":false,"writeAttempted":false,"error":"cleanup failed"}""", false, false)]
    [InlineData("""{"ok":false,"selectedId":"one","cleanupOk":false,"error":"cleanup failed"}""", false, false)]
    [InlineData("""{"ok":false,"writeAttempted":true,"cleanupOk":true,"error":"confirmation failed"}""", false, false)]
    [InlineData("""{"ok":false,"safeToFallback":true}""", false, false)]
    [InlineData("""{"ok":true}""", false, false)]
    [InlineData("broken", false, false)]
    [InlineData("[]", false, false)]
    [InlineData(null, false, false)]
    public void Camera_Direct_routing_only_falls_back_when_explicitly_safe(string? json, bool ok, bool fallback)
    {
        var camera = CameraDom.Interpret(new(true, json, null));
        var calls = 0;
        var routed = TeamsClient.TryDirectCamera(() => { calls++; return camera; });

        Assert.Equal(1, calls);
        if (fallback)
        {
            Assert.Null(routed);
        }
        else
        {
            Assert.NotNull(routed);
            Assert.Equal(ok, routed.Value.ok);
            Assert.Equal(camera.Error, routed.Value.error);
        }
    }

    [Fact]
    public void Camera_Direct_transport_timeout_is_a_handled_failure_not_UIA_fallback()
    {
        var routed = TeamsClient.TryDirectCamera(() => CameraDom.Interpret(CdpResult.Fail("timed out")));

        Assert.NotNull(routed);
        Assert.False(routed.Value.ok);
        Assert.Contains("may already have changed", routed.Value.error);
    }

    [Fact]
    public void Camera_Direct_exception_is_a_handled_failure_not_UIA_fallback()
    {
        var routed = TeamsClient.TryDirectCamera(() => throw new InvalidOperationException("disconnected"));

        Assert.NotNull(routed);
        Assert.False(routed.Value.ok);
        Assert.Contains("may already have changed", routed.Value.error);
    }

    [Theory]
    [InlineData("select")]
    [InlineData("select-noop")]
    [InlineData("escape-in-popup")]
    [InlineData("swap-first")]
    [InlineData("swap-second")]
    [InlineData("swap-third")]
    [InlineData("fresh-already-desired")]
    [InlineData("stale-before")]
    [InlineData("detach-after-read")]
    [InlineData("stale-after")]
    [InlineData("unknown-after-write")]
    [InlineData("unknown-initial")]
    [InlineData("unknown-before-write")]
    [InlineData("disabled-before-write")]
    [InlineData("missing-second")]
    [InlineData("both-selected")]
    [InlineData("disabled-target")]
    [InlineData("disabled-second")]
    [InlineData("duplicate-container")]
    [InlineData("duplicate-id")]
    [InlineData("ignored-write")]
    [InlineData("throw-write")]
    [InlineData("auto-close")]
    [InlineData("delayed-auto-close")]
    [InlineData("user-open")]
    [InlineData("user-open-auto-close")]
    [InlineData("user-open-noop")]
    [InlineData("other-dialog")]
    [InlineData("failed-open")]
    [InlineData("throw-open")]
    [InlineData("cleanup-fails")]
    [InlineData("throw-cleanup")]
    [InlineData("lock")]
    public async Task Generated_script_obeys_camera_operation_safety_contract(string scenario)
    {
        var swap = scenario.StartsWith("swap-") ||
            scenario is "missing-second" or "disabled-second" or "fresh-already-desired";
        var script = CameraDom.BuildScript(Defaults.Config().Controls["camera-select"],
            swap ? """["one","two"]""" : "one", swap, 2500)!;
        await RunScript(script, scenario, "camera-dom-harness.cjs");
    }

    internal static async Task RunScript(string script, string scenario, string harness)
    {
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true
        };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, harness));
        using var process = Process.Start(start)!;
        process.StandardInput.Write(JsonSerializer.Serialize(new { script, scenario }));
        process.StandardInput.Close();
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(10_000);
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail($"camera DOM harness timed out: {scenario}");
        }
        Assert.True(process.ExitCode == 0, $"{scenario}: {await stdout}\n{await stderr}");
    }
}
