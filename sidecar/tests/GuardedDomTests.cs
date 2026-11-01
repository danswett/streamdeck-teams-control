using System.Diagnostics;
using System.Text.Json;
using TeamsBridge;
using Xunit;

namespace TeamsBridge.Tests;

public class GuardedDomTests
{
    [Theory]
    [InlineData("Blur", "normal", true)]
    [InlineData("Blur", "blur-off", true)]
    [InlineData("Blur", "localized", true)]
    [InlineData("Blur", "role-radio", true)]
    [InlineData("Blur", "native-radio", true)]
    [InlineData("Blur", "native-ignored", false)]
    [InlineData("Blur", "selector-fallback", true)]
    [InlineData("Blur", "user-popup", true)]
    [InlineData("Blur", "auto-close", true)]
    [InlineData("Blur", "user-popup-auto-close", true)]
    [InlineData("Blur", "foreign-after-write", true)]
    [InlineData("Blur", "foreign-popup", false)]
    [InlineData("Blur", "foreign-batched-open", false)]
    [InlineData("Blur", "unknown-state", false)]
    [InlineData("Blur", "ambiguous", false)]
    [InlineData("Blur", "missing-owner", false)]
    [InlineData("Blur", "ignored-write", false)]
    [InlineData("Blur", "throw-after-write", false)]
    [InlineData("Blur", "cleanup-fails", false)]
    [InlineData("Blur", "transport-after-write", false)]
    [InlineData("Blur", "expired-before-write", false)]
    [InlineData("Grid", "normal", true)]
    [InlineData("Grid", "grid-close", true)]
    [InlineData("Grid", "retained-root", true)]
    [InlineData("Grid", "retained-root-close", true)]
    [InlineData("Grid", "selector-fallback", true)]
    [InlineData("Grid", "grid-close-foreign", false)]
    [InlineData("Grid", "foreign-popup", false)]
    [InlineData("Grid", "ignored-write", false)]
    [InlineData("Grid", "throw-after-write", false)]
    [InlineData("TimerToggle", "normal", true)]
    [InlineData("TimerToggle", "paused", true)]
    [InlineData("TimerToggle", "localized", true)]
    [InlineData("TimerToggle", "user-popup", true)]
    [InlineData("TimerToggle", "expired", false)]
    [InlineData("TimerToggle", "cancel-mapped", false)]
    [InlineData("TimerToggle", "foreign-popup", false)]
    [InlineData("TimerToggle", "ambiguous", false)]
    [InlineData("TimerToggle", "missing-owner", true)]
    [InlineData("TimerToggle", "split-fiber", true)]
    [InlineData("TimerToggle", "wrong-scope", false)]
    [InlineData("TimerToggle", "ignored-write", false)]
    [InlineData("TimerToggle", "throw-after-write", false)]
    [InlineData("TimerReset", "normal", true)]
    [InlineData("TimerReset", "expired", true)]
    [InlineData("TimerReset", "ticking-reset", true)]
    [InlineData("TimerReset", "full-duration", false)]
    [InlineData("TimerReset", "cancel-mapped", false)]
    [InlineData("TimerReset", "ignored-write", false)]
    [InlineData("TimerReset", "throw-after-write", false)]
    [InlineData("ConfirmPresentation", "normal", true)]
    [InlineData("ConfirmPresentation", "foreign-popup", false)]
    [InlineData("ConfirmPresentation", "ambiguous", false)]
    [InlineData("ConfirmPresentation", "missing-dialog", false)]
    [InlineData("ConfirmPresentation", "ignored-write", false)]
    [InlineData("ConfirmPresentation", "throw-after-write", false)]
    [InlineData("ConfirmPresentation", "transport-after-write", false)]
    [InlineData("ConfirmPresentation", "expired-before-write", false)]
    public async Task Named_controls_write_once_confirm_state_and_clean_owned_navigation(
        string operation, string scenario, bool expected)
    {
        var kind = Enum.Parse<GuardedDom.Kind>(operation);
        var config = Defaults.Config();
        if (scenario == "localized")
        {
            config.Controls["blur"].MenuItemName = "^Weichzeichnung$";
            config.Controls["blur"].MenuItemOffName = "^Kein Effekt$";
            config.Timer.ControlsPattern = "^Zeitsteuerung";
            config.Timer.PausePattern = "^Anhalten$";
            config.Timer.ResumePattern = "^Fortsetzen$";
        }
        if (scenario == "selector-fallback")
        {
            config.Controls["blur"].MenuItemAutomationId = "previous-blur-id";
            config.Controls["ppt-grid"].OffAutomationId = "previous-grid-close-id";
        }
        if (scenario == "cancel-mapped")
        {
            config.Timer.PausePattern = config.Timer.CancelPattern;
            config.Timer.ResetPattern = config.Timer.CancelPattern;
        }
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true
        };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "guarded-dom-harness.cjs"));
        start.ArgumentList.Add(operation);
        start.ArgumentList.Add(scenario);
        using var process = Process.Start(start)!;
        var errors = process.StandardError.ReadToEndAsync();
        var calls = 0;
        try
        {
            var result = GuardedDom.Run(config, kind, (script, timeout) =>
            {
                Assert.InRange(timeout, 1, 5000);
                process.StandardInput.WriteLine(JsonSerializer.Serialize(script));
                process.StandardInput.Flush();
                var line = process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10))
                    .GetAwaiter().GetResult();
                Assert.NotNull(line);
                using var reply = JsonDocument.Parse(line);
                if (reply.RootElement.TryGetProperty("error", out var error))
                    throw new InvalidOperationException(error.GetString());
                if (++calls == 2 && scenario == "transport-after-write")
                    return CdpResult.Fail("debugger disconnected after execution");
                return new(true, reply.RootElement.GetProperty("value").GetString(), null);
            }, 5000);
            Assert.True(result.Ok == expected, $"{operation}/{scenario}: {result.Error}");
            if (kind == GuardedDom.Kind.Grid && result.Ok)
            {
                process.StandardInput.WriteLine(JsonSerializer.Serialize(GuardedDom.BuildGridObservation(config)));
                process.StandardInput.Flush();
                var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
                using var observed = JsonDocument.Parse(line!);
                var grid = GuardedDom.ReadGrid(new(true, observed.RootElement.GetProperty("value").GetString(), null), config);
                Assert.NotNull(grid);
                Assert.Equal(result.State, grid.Open);
                Assert.True(grid.Available);
            }
            if (!expected)
            {
                Assert.NotEmpty(result.Error!);
                var routed = TeamsClient.TryDirectGuarded(() => result);
                Assert.NotNull(routed);
                Assert.False(routed.Value.ok);
            }
            process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(process.ExitCode == 0, await errors);
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
    }

    [Fact]
    public void Direct_disabled_never_reads_or_writes_a_debugger_target()
    {
        var dom = new DomActuator(new DirectModeSpec());
        foreach (var target in new[] { "blur", "ppt-grid", "timer-toggle", "timer-reset", "ppt-stop-presenting-confirm" })
            Assert.Null(dom.InvokeGuarded(Defaults.Config(), target));
    }

    [Fact]
    public void Expired_guarded_requests_are_handled_without_probing_or_falling_back()
    {
        var dom = new DomActuator(new DirectModeSpec());
        var result = dom.InvokeGuarded(Defaults.Config(), "ppt-stop-presenting-confirm", Environment.TickCount64 - 1);
        Assert.NotNull(result);
        Assert.False(result.Ok);
        Assert.Contains("deadline", result.Error);
    }

    [Fact]
    public void Configurable_patterns_stay_out_of_browser_scripts()
    {
        var config = Defaults.Config();
        config.Controls["blur"].MenuItemName = "(a+)+$";
        config.Controls["blur"].MenuItemOffName = "off-pattern";
        config.Timer.PausePattern = "pause-pattern";
        config.Timer.ResumePattern = "resume-pattern";
        config.Controls["ppt-grid"].OffName = "grid-pattern";
        var script = GuardedDom.BuildPrepare(config, GuardedDom.Kind.Blur, "token'\"\\", 5000);
        foreach (var pattern in new[] { "(a+)+$", "off-pattern", "pause-pattern", "resume-pattern", "grid-pattern", "new RegExp" })
            Assert.DoesNotContain(pattern, script);
        Assert.Contains(DomActuator.Js("token'\"\\"), script);
    }

    [Fact]
    public void Unknown_or_thrown_results_are_handled_without_a_UIA_retry()
    {
        Assert.Null(TeamsClient.TryDirectGuarded(() => null));
        Assert.False(TeamsClient.TryDirectGuarded(() => new(false, "not confirmed"))!.Value.ok);
        Assert.False(TeamsClient.TryDirectGuarded(() => throw new IOException("disconnected"))!.Value.ok);
    }
}
