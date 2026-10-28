using Xunit;

namespace TeamsBridge.Tests;

public class MusicModeObserverTests
{
    private sealed class Element
    {
        internal bool? Active;
        internal Action<bool?>? Changed;
    }

    private sealed class Watch(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }

    private Element? _exposed;
    private int _finds;
    private int _subscriptions;
    private int _liveWatches;

    private MusicMode.Observer<Element> Create() => new(
        () => { _finds++; return _exposed; },
        element => element.Active,
        (element, changed) =>
        {
            _subscriptions++;
            _liveWatches++;
            element.Changed = changed;
            return new Watch(() => _liveWatches--);
        });

    [Fact]
    public void Closed_menu_never_searches_or_subscribes_and_initial_state_is_unknown()
    {
        using var observer = Create();
        for (var i = 0; i < 100; i++) Assert.Null(observer.Refresh(false));
        Assert.Equal(0, _finds);
        Assert.Equal(0, _subscriptions);
    }

    [Fact]
    public void Reads_manual_changes_without_writing_and_reuses_one_subscription()
    {
        _exposed = new Element { Active = false };
        using var observer = Create();
        Assert.False(observer.Refresh(true));
        _exposed.Active = true;
        _exposed.Changed!(true);
        for (var i = 0; i < 100; i++) Assert.True(observer.Refresh(true));
        Assert.Equal(1, _finds);
        Assert.Equal(1, _subscriptions);
        Assert.Equal(1, _liveWatches);
    }

    [Fact]
    public void A_change_followed_by_immediate_close_is_retained_and_unsubscribed()
    {
        _exposed = new Element { Active = false };
        using var observer = Create();
        observer.Refresh(true);
        _exposed.Changed!(true);
        Assert.True(observer.Refresh(false));
        Assert.Equal(0, _liveWatches);
        Assert.True(observer.Refresh(false));
        Assert.Equal(1, _finds);
    }

    [Fact]
    public void Missed_events_are_covered_by_reading_only_the_exposed_switch()
    {
        _exposed = new Element { Active = true };
        using var observer = Create();
        observer.Refresh(true);
        _exposed.Active = false;
        Assert.False(observer.Refresh(true));
        Assert.Equal(1, _finds);
    }

    [Fact]
    public void Replaced_or_stale_controls_are_rediscovered_without_leaking_watches()
    {
        var old = new Element { Active = false };
        _exposed = old;
        using var observer = Create();
        observer.Refresh(true);
        old.Active = null;
        _exposed = new Element { Active = true };
        Assert.True(observer.Refresh(true));
        old.Changed!(false);
        Assert.True(observer.Refresh(false));
        Assert.Equal(2, _finds);
        Assert.Equal(2, _subscriptions);
        Assert.Equal(0, _liveWatches);
    }

    [Fact]
    public void Unknown_or_missing_controls_do_not_turn_a_known_on_state_off()
    {
        _exposed = new Element { Active = true };
        using var observer = Create();
        observer.Refresh(true);
        _exposed.Active = null;
        _exposed.Changed!(null);
        Assert.True(observer.Refresh(true));
        _exposed = null;
        Assert.True(observer.Refresh(true));
        Assert.Equal(0, _liveWatches);
    }

    [Fact]
    public void Disposal_releases_the_single_subscription_and_new_observers_start_unknown()
    {
        _exposed = new Element { Active = true };
        var observer = Create();
        observer.Refresh(true);
        observer.Dispose();
        observer.Dispose();
        Assert.Equal(0, _liveWatches);
        using var nextMeeting = Create();
        Assert.Null(nextMeeting.Refresh(false));
    }

    [Fact]
    public void Unsupported_events_still_allow_passive_snapshot_reads()
    {
        var element = new Element { Active = true };
        using var observer = new MusicMode.Observer<Element>(() => element, e => e.Active, (_, _) => null);
        Assert.True(observer.Refresh(true));
        element.Active = false;
        Assert.False(observer.Refresh(true));
    }
}
