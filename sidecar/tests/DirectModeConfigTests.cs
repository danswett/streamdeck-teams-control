using TeamsBridge;
using Xunit;

namespace TeamsBridge.Tests;

public class DirectModeConfigTests
{
    [Fact]
    public void Missing_user_file_preserves_bundled_settings()
    {
        var config = Defaults.Config();
        var original = config.DirectMode;
        Program.LoadDirectModeConfig(config, Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString()));
        Assert.Same(original, config.DirectMode);
        Assert.False(config.DirectMode.Enabled);
    }

    [Fact]
    public void User_settings_override_only_direct_mode()
    {
        WithFile("""
            { "directMode": { "enabled": true, "port": 12345, "timeoutMs": 900, "probeTtlMs": 7000 },
              "controls": { "mute": { "automationId": "do-not-load" } } }
            """, (config, path) =>
        {
            var mute = config.Controls["mute"];
            Program.LoadDirectModeConfig(config, path);
            Assert.True(config.DirectMode.Enabled);
            Assert.Equal(12345, config.DirectMode.Port);
            Assert.Equal(900, config.DirectMode.TimeoutMs);
            Assert.Equal(7000, config.DirectMode.ProbeTtlMs);
            Assert.Same(mute, config.Controls["mute"]);
        });
    }

    [Fact]
    public void Explicit_disable_overrides_a_locally_enabled_bundle()
    {
        WithFile("""{ "directMode": { "enabled": false } }""", (config, path) =>
        {
            config.DirectMode.Enabled = true;
            Program.LoadDirectModeConfig(config, path);
            Assert.False(config.DirectMode.Enabled);
        });
    }

    [Theory]
    [InlineData(1)]
    [InlineData(65535)]
    public void Valid_ports_are_used_exactly_as_configured(int port)
    {
        WithFile($$"""{ "directMode": { "enabled": true, "port": {{port}} } }""", (config, path) =>
        {
            Program.LoadDirectModeConfig(config, path);
            Assert.True(config.DirectMode.Enabled);
            Assert.Equal(port, config.DirectMode.Port);
        });
    }

    [Fact]
    public void Enabled_without_a_port_uses_the_documented_default()
    {
        WithFile("""{ "directMode": { "enabled": true } }""", (config, path) =>
        {
            Program.LoadDirectModeConfig(config, path);
            Assert.True(config.DirectMode.Enabled);
            Assert.Equal(9457, config.DirectMode.Port);
        });
    }

    [Theory]
    [InlineData(-1, 250, 1000)]
    [InlineData(999999, 10000, 120000)]
    public void User_timing_settings_keep_the_existing_bounds(int value, int timeout, int ttl)
    {
        WithFile($$"""{ "directMode": { "timeoutMs": {{value}}, "probeTtlMs": {{value}} } }""", (config, path) =>
        {
            Program.LoadDirectModeConfig(config, path);
            Assert.False(config.DirectMode.Enabled);
            Assert.Equal(timeout, config.DirectMode.TimeoutMs);
            Assert.Equal(ttl, config.DirectMode.ProbeTtlMs);
        });
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("""{ "directMode": { "port": 12345 } }""")]
    [InlineData("""{ "directMode": { "enabled": "true" } }""")]
    [InlineData("""{ "directMode": { "enabled": true, "port": 0 } }""")]
    [InlineData("""{ "directMode": { "enabled": true, "port": 65536 } }""")]
    [InlineData("""{ "directMode": { "enabled": true, "port": "12345" } }""")]
    [InlineData("""{ "directMode": { "enabled": true, "timeoutMs": null } }""")]
    public void Invalid_or_non_opted_in_settings_do_not_authorize_a_connection(string json)
    {
        WithFile(json, (config, path) =>
        {
            config.DirectMode.Enabled = true;
            Program.LoadDirectModeConfig(config, path);
            Assert.False(config.DirectMode.Enabled);
        });
    }

    private static void WithFile(string json, Action<SelectorConfig, string> check)
    {
        var path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(path, json);
            check(Defaults.Config(), path);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
