using Xunit;

namespace TeamsBridge.Tests;

public class MusicModeTests
{
    private long _time;
    private int _presses;

    private MusicMode.Switch Switch(bool? active, bool enabled = true, bool pressSucceeds = true) =>
        new(active, enabled, () => { _presses++; return pressSucceeds; });

    private (bool ok, string? error, bool? active) Run(Func<MusicMode.Switch?> find) =>
        MusicMode.Toggle(find, () => _time += 100, () => _time);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Reads_the_actual_state_and_confirms_both_directions(bool initial)
    {
        var reads = 0;
        var result = Run(() => Switch(reads++ < 2 ? initial : !initial));

        Assert.True(result.ok);
        Assert.Equal(!initial, result.active);
        Assert.Equal(1, _presses);
        Assert.Equal(3, reads);
    }

    [Fact]
    public void Refinds_after_stale_reads_before_and_after_the_single_write()
    {
        var reads = new Queue<MusicMode.Switch?>([
            null, Switch(null), Switch(false),
            null, Switch(false),
            null, Switch(null), Switch(false), Switch(true)
        ]);
        var result = Run(() => reads.Dequeue());

        Assert.True(result.ok);
        Assert.True(result.active);
        Assert.Empty(reads);
        Assert.Equal(1, _presses);
    }

    [Fact]
    public void A_manual_change_to_the_desired_state_is_not_toggled_back()
    {
        var reads = new Queue<MusicMode.Switch?>([Switch(false), Switch(true)]);
        var result = Run(() => reads.Dequeue());

        Assert.True(result.ok);
        Assert.True(result.active);
        Assert.Equal(0, _presses);
    }

    [Fact]
    public void Only_the_freshly_found_switch_is_pressed()
    {
        var stalePresses = 0;
        var stale = new MusicMode.Switch(false, true, () => { stalePresses++; return false; });
        var reads = new Queue<MusicMode.Switch?>([stale, Switch(false), Switch(true)]);

        Assert.True(Run(() => reads.Dequeue()).ok);
        Assert.Equal(0, stalePresses);
        Assert.Equal(1, _presses);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Missing_or_unknown_state_is_an_explicit_failure_without_a_write(bool missing)
    {
        var result = Run(() => missing ? null : Switch(null));

        Assert.False(result.ok);
        Assert.Contains("did not expose", result.error);
        Assert.Null(result.active);
        Assert.Equal(0, _presses);
    }

    [Fact]
    public void Unknown_state_immediately_before_the_write_is_not_guessed()
    {
        var reads = 0;
        var result = Run(() => Switch(reads++ == 0 ? false : null));

        Assert.False(result.ok);
        Assert.Contains("before the press", result.error);
        Assert.Null(result.active);
        Assert.Equal(0, _presses);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void A_disabled_switch_is_not_pressed(int when)
    {
        var reads = 0;
        var result = Run(() => Switch(false, reads++ != when));

        Assert.False(result.ok);
        Assert.Contains("disabled", result.error);
        Assert.Equal(0, _presses);
    }

    [Fact]
    public void A_failed_press_is_not_retried()
    {
        var result = Run(() => Switch(false, pressSucceeds: false));

        Assert.False(result.ok);
        Assert.Contains("Could not press", result.error);
        Assert.Null(result.active);
        Assert.Equal(1, _presses);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Unconfirmed_changes_never_trigger_a_second_write(bool disappears)
    {
        var result = Run(() => _presses > 0 && disappears ? null : Switch(false));

        Assert.False(result.ok);
        Assert.Contains("did not confirm", result.error);
        Assert.Null(result.active);
        Assert.Equal(1, _presses);
    }

    [Fact]
    public void The_selector_matches_the_switch_label_not_generated_ids_or_other_audio_settings()
    {
        var spec = Defaults.Config().Controls["music-mode"];
        Assert.Equal("audio-button-configure", spec.Menu);
        Assert.Null(spec.MenuItemAutomationId);
        Assert.NotNull(spec.MenuItemRegex);
        Assert.Matches(spec.MenuItemRegex, "High fidelity music mode");
        Assert.DoesNotMatch(spec.MenuItemRegex, "Noise suppression");
        Assert.DoesNotMatch(spec.MenuItemRegex, "Spatial audio");
        Assert.DoesNotMatch(spec.MenuItemRegex, "Turn on High fidelity music mode?");
    }
}
