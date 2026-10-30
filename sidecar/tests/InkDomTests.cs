using TeamsBridge;
using Xunit;

namespace TeamsBridge.Tests;

public class InkDomTests
{
    [Theory]
    [InlineData("color", false, "1")]
    [InlineData("color-wrap", false, "-1")]
    [InlineData("color-noop", false, "0")]
    [InlineData("laser", false, "1")]
    [InlineData("thickness", true, "5")]
    [InlineData("thickness-relative", true, "+1")]
    [InlineData("thickness-clamp", true, "99")]
    [InlineData("thickness-round", true, "4.5")]
    [InlineData("thickness-noop", true, "2")]
    [InlineData("user-popup", false, "1")]
    [InlineData("user-popup-auto-close", false, "1")]
    [InlineData("auto-close", false, "1")]
    [InlineData("unknown-color", false, "1")]
    [InlineData("ignored-color", false, "1")]
    [InlineData("ignored-input", true, "5")]
    [InlineData("throw-after-write", false, "1")]
    [InlineData("foreign-popup", false, "1")]
    [InlineData("cleanup-fails", false, "1")]
    [InlineData("lock", false, "1")]
    [InlineData("unsupported-tool", false, "1")]
    public async Task Ink_changes_are_confirmed_once_and_restore_only_owned_popups(string scenario, bool thickness, string arg)
    {
        var script = InkDom.BuildScript(Defaults.Config(), thickness, arg, 4000);
        Assert.NotNull(script);
        await CameraDomTests.RunScript(script, scenario, "ink-dom-harness.cjs");
    }

    [Theory]
    [InlineData(false, "not-a-step")]
    [InlineData(true, "NaN")]
    [InlineData(true, "Infinity")]
    [InlineData(true, "+1.5")]
    public void Invalid_values_never_generate_a_write(bool thickness, string arg) =>
        Assert.Null(InkDom.BuildScript(Defaults.Config(), thickness, arg, 4000));

    [Fact]
    public void Configured_selectors_and_palette_names_are_encoded_as_data_not_executable_patterns()
    {
        var config = Defaults.Config();
        config.Controls["ppt-pen"].AutomationId = "tool'\"\\";
        config.PowerPointLive.InkColorNames = ["red'\"\\"];
        var script = InkDom.BuildScript(config, false, "1", 4000)!;
        Assert.Contains(DomActuator.Js(config.Controls["ppt-pen"].AutomationId), script);
        Assert.Contains(DomActuator.Js(config.PowerPointLive.InkColorNames[0]), script);
        Assert.DoesNotContain("new RegExp", script);
    }

    [Fact]
    public void Direct_off_declines_without_accessing_a_port() =>
        Assert.Null(new DomActuator(new DirectModeSpec()).AdjustInk(Defaults.Config(), false, "1"));

    [Fact]
    public void A_confirmed_color_publishes_the_actual_tool_palette_and_state()
    {
        var result = InkDom.Interpret(new(true,
            """{"ok":true,"cleanupOk":true,"tool":"ppt-pen","toolName":"Pen: Red, Thickness 3","color":"Red","palette":["Blue","Red"]}""",
            null), Defaults.Config(), false);
        Assert.True(result.Ok);
        Assert.Equal("ppt-pen", result.Tool);
        Assert.Equal("Red", result.Color);
        Assert.Equal("3", result.Thickness);
        Assert.Equal(new[] { "Blue", "Red" }, result.Palette);
    }

    [Theory]
    [InlineData("""{"ok":true,"cleanupOk":true,"tool":"ppt-pen","toolName":"Pen: Red, Thickness 3","value":3}""", true)]
    [InlineData("""{"ok":true,"cleanupOk":true,"tool":"ppt-pen","toolName":"Pen: Red, Thickness 3","value":5}""", false)]
    [InlineData("""{"ok":true,"cleanupOk":true,"tool":"ppt-pen","toolName":"Pen: Red, Thickness 3","value":"3"}""", false)]
    public void A_slider_value_alone_cannot_confirm_an_ignored_application_write(string json, bool ok) =>
        Assert.Equal(ok, InkDom.Interpret(new(true, json, null), Defaults.Config(), true).Ok);

    [Theory]
    [InlineData(null)]
    [InlineData("broken")]
    [InlineData("[]")]
    [InlineData("""{"ok":true}""")]
    [InlineData("""{"ok":true,"cleanupOk":false}""")]
    [InlineData("""{"ok":true,"cleanupOk":true,"tool":"ppt-pen","toolName":"Pen: Blue, Thickness 3","color":"Red","palette":["Blue","Red"]}""")]
    [InlineData("""{"ok":true,"cleanupOk":true,"tool":"ppt-pen","toolName":"Pen: Red, Thickness 3","color":"Red","palette":["Red","Red"]}""")]
    [InlineData("""{"ok":true,"cleanupOk":true,"tool":"ppt-eraser","toolName":"Eraser: Red","color":"Red","palette":["Red"]}""")]
    public void Unknown_or_unconfirmed_results_are_handled_failures_not_UIA_retries(string? json)
    {
        var calls = 0;
        var routed = TeamsClient.TryDirectInk(() =>
        {
            calls++;
            return InkDom.Interpret(new(true, json, null), Defaults.Config(), false);
        });
        Assert.Equal(1, calls);
        Assert.NotNull(routed);
        Assert.False(routed.Value.ok);
        Assert.NotEmpty(routed.Value.error!);
    }

    [Fact]
    public void Timeout_and_exceptions_cannot_repeat_a_relative_color_change()
    {
        var timeout = TeamsClient.TryDirectInk(() =>
            InkDom.Interpret(CdpResult.Fail("timed out"), Defaults.Config(), false));
        var exception = TeamsClient.TryDirectInk(() => throw new IOException("disconnected"));
        Assert.NotNull(timeout);
        Assert.NotNull(exception);
        Assert.False(timeout.Value.ok);
        Assert.False(exception.Value.ok);
        Assert.Contains("may already have changed", timeout.Value.error);
        Assert.Contains("may already have changed", exception.Value.error);
        Assert.Null(TeamsClient.TryDirectInk(() => null));
    }
}
