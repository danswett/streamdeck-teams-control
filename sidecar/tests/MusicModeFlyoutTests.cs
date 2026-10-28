using Xunit;

namespace TeamsBridge.Tests;

public class MusicModeFlyoutTests
{
    private bool? _open = false;
    private bool? _active = false;
    private bool _enabled = true;
    private bool _expandSucceeds = true;
    private bool _opensOnFailure;
    private bool _manualChange;
    private int _expands, _reads, _presses, _collapses, _deferred;
    private long _time;
    private Action? _cleanup;

    private (bool ok, string? error) Run(Func<MusicMode.Switch?>? find = null) => MusicMode.WithFlyout(
        _open,
        () =>
        {
            _expands++;
            _open = _expandSucceeds || _opensOnFailure;
            return _expandSucceeds;
        },
        () =>
        {
            var result = MusicMode.Toggle(find ?? (() =>
            {
                if (++_reads == 2 && _manualChange) _active = !_active;
                return new MusicMode.Switch(_active, _enabled, () =>
                {
                    _presses++;
                    _active = !_active;
                    return true;
                });
            }), () => _time += 100, () => _time);
            return (result.ok, result.error);
        },
        () =>
        {
            _deferred++;
            _cleanup = () => Assert.True(MusicMode.Dismiss(
                () => _open,
                () => { _collapses++; _open = false; return true; },
                () => _open is false));
        });

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void Both_directions_preserve_borrowed_flyouts_and_defer_only_owned_cleanup(bool wasOpen, bool active)
    {
        _open = wasOpen;
        _active = active;

        Assert.True(Run().ok);
        Assert.Equal(!active, _active);
        Assert.Equal(1, _presses);
        Assert.True(_open);
        Assert.Equal(wasOpen ? 0 : 1, _expands);
        Assert.Equal(wasOpen ? 0 : 1, _deferred);
        Assert.Equal(0, _collapses);

        _cleanup?.Invoke();
        Assert.Equal(wasOpen, _open);
        Assert.Equal(wasOpen ? 0 : 1, _collapses);
    }

    [Fact]
    public void Unknown_initial_menu_state_does_not_open_invoke_or_dismiss()
    {
        _open = null;
        var result = Run();
        Assert.False(result.ok);
        Assert.Contains("audio options state", result.error);
        Assert.Equal(0, _expands);
        Assert.Equal(0, _reads);
        Assert.Equal(0, _deferred);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_disabled_switch_preserves_borrowed_ui_and_cleans_up_only_owned_ui(bool wasOpen)
    {
        _open = wasOpen;
        _enabled = false;
        var result = Run();
        Assert.False(result.ok);
        Assert.Contains("disabled", result.error);
        Assert.Equal(0, _presses);
        Assert.Equal(wasOpen ? 0 : 1, _deferred);
        _cleanup?.Invoke();
        Assert.Equal(wasOpen, _open);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Missing_switch_state_preserves_borrowed_ui_and_cleans_up_only_owned_ui(bool wasOpen)
    {
        _open = wasOpen;
        _active = null;
        var result = Run();
        Assert.False(result.ok);
        Assert.Contains("did not expose", result.error);
        Assert.Equal(0, _presses);
        Assert.Equal(wasOpen ? 0 : 1, _deferred);
        _cleanup?.Invoke();
        Assert.Equal(wasOpen, _open);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_manual_change_needing_no_write_still_respects_flyout_ownership(bool wasOpen)
    {
        _open = wasOpen;
        _manualChange = true;
        Assert.True(Run().ok);
        Assert.True(_active);
        Assert.Equal(0, _presses);
        Assert.Equal(wasOpen ? 0 : 1, _deferred);
        _cleanup?.Invoke();
        Assert.Equal(wasOpen, _open);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Failed_opening_attempts_retain_cleanup_even_if_the_flyout_did_open(bool partiallyOpened)
    {
        _expandSucceeds = false;
        _opensOnFailure = partiallyOpened;
        var result = Run();
        Assert.False(result.ok);
        Assert.Contains("Could not open", result.error);
        Assert.Equal(0, _reads);
        Assert.Equal(1, _deferred);
        _cleanup!.Invoke();
        Assert.False(_open);
        Assert.Equal(partiallyOpened ? 1 : 0, _collapses);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Exceptions_do_not_lose_owned_cleanup_or_dismiss_borrowed_ui(bool wasOpen)
    {
        _open = wasOpen;
        Assert.Throws<InvalidOperationException>(() => Run(() => throw new InvalidOperationException("stale provider")));
        Assert.Equal(wasOpen ? 0 : 1, _deferred);
        _cleanup?.Invoke();
        Assert.Equal(wasOpen, _open);
    }
}
