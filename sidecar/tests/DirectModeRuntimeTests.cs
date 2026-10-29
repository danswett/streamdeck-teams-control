using TeamsBridge;
using Xunit;

namespace TeamsBridge.Tests;

public class DirectModeRuntimeTests
{
    [Theory]
    [InlineData(true, 1)]
    [InlineData(false, 9457)]
    [InlineData(true, 65535)]
    public void Runtime_settings_require_explicit_consent_and_an_exact_port(bool enabled, int port)
    {
        var parsed = Program.ParseDirectModeSettings(
            $$"""{ "enabled": {{enabled.ToString().ToLowerInvariant()}}, "port": {{port}} }""");
        Assert.Equal((enabled, port), parsed);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("""{"enabled":true}""")]
    [InlineData("""{"enabled":"true","port":9457}""")]
    [InlineData("""{"enabled":true,"port":0}""")]
    [InlineData("""{"enabled":true,"port":65536}""")]
    [InlineData("""{"enabled":true,"port":"9457"}""")]
    [InlineData("""{"enabled":true,"port":9457.5}""")]
    public void Invalid_runtime_settings_are_rejected(string json)
    {
        Assert.Throws<FormatException>(() => Program.ParseDirectModeSettings(json));
    }

    [Fact]
    public void Settings_can_be_changed_and_disabled_without_recreating_the_actuator()
    {
        var spec = new DirectModeSpec();
        var dom = new DomActuator(spec);
        dom.Configure(true, 12345);
        Assert.True(spec.Enabled);
        Assert.Equal(12345, spec.Port);
        Assert.False(dom.Status.Usable);
        Assert.Equal("not probed yet", dom.Status.Reason);

        dom.Configure(false, 54321);
        Assert.False(spec.Enabled);
        Assert.Equal(54321, spec.Port);
        Assert.False(dom.IsUsable);
        dom.Probe(); // Disabled probing does not access a debugging endpoint.
        Assert.Equal("not enabled", dom.Status.Reason);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65536)]
    public void Invalid_reconfiguration_does_not_change_existing_settings(int port)
    {
        var spec = new DirectModeSpec { Enabled = true, Port = 12345 };
        var dom = new DomActuator(spec);
        Assert.Throws<ArgumentOutOfRangeException>(() => dom.Configure(false, port));
        Assert.True(spec.Enabled);
        Assert.Equal(12345, spec.Port);
    }
}
