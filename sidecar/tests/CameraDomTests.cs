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
    public void Preference_envelopes_remain_on_the_preference_aware_UIA_path(bool swap, string arg) =>
        Assert.Null(CameraDom.BuildScript(Defaults.Config().Controls["camera-select"], arg, swap, 2500));

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

    [Theory]
    [InlineData("select")]
    [InlineData("select-noop")]
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
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true
        };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "camera-dom-harness.cjs"));
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
