using Xunit;

namespace TeamsBridge.Tests;

public class MusicModeDismissTests
{
    private readonly List<string> _calls = [];
    private bool? _open = true;
    private bool _collapseSucceeds = true;
    private bool _closeOnCollapse = true;

    private bool Dismiss(Action? beforeCollapse = null) => MusicMode.Dismiss(
        () => { _calls.Add("read"); return _open; },
        () =>
        {
            _calls.Add("collapse");
            beforeCollapse?.Invoke();
            if (_collapseSucceeds && _closeOnCollapse) _open = false;
            return _collapseSucceeds;
        },
        () => { _calls.Add("confirm"); return _open is false; });

    [Fact]
    public void An_already_closed_menu_is_not_toggled_open_again()
    {
        _open = false;
        Assert.True(Dismiss());
        Assert.Equal(["read"], _calls);
    }

    [Fact]
    public void Unknown_menu_state_can_only_use_idempotent_collapse()
    {
        _open = null;
        Assert.True(Dismiss());
        Assert.Equal(["read", "collapse", "confirm"], _calls);
    }

    [Fact]
    public void Collapse_must_be_confirmed_before_reporting_dismissal()
    {
        Assert.True(Dismiss());
        Assert.Equal(["read", "collapse", "confirm"], _calls);
    }

    [Fact]
    public void A_menu_that_closes_between_the_read_and_collapse_is_never_reopened()
    {
        Assert.True(Dismiss(() => _open = false));
        Assert.False(_open);
        Assert.Equal(["read", "collapse", "confirm"], _calls);
    }

    [Fact]
    public void Unconfirmed_collapse_reports_failure_without_a_toggle_fallback()
    {
        _closeOnCollapse = false;
        Assert.False(Dismiss());
        Assert.True(_open);
        Assert.Equal(["read", "collapse", "confirm"], _calls);
    }

    [Fact]
    public void An_unavailable_collapse_reports_failure_without_other_input()
    {
        _collapseSucceeds = false;
        Assert.False(Dismiss());
        Assert.Equal(["read", "collapse", "read"], _calls);
    }

    [Fact]
    public void A_failed_collapse_that_actually_closed_is_not_a_false_failure()
    {
        _collapseSucceeds = false;
        Assert.True(Dismiss(() => _open = false));
        Assert.Equal(["read", "collapse", "read"], _calls);
    }

    [Fact]
    public void Unknown_state_and_unavailable_collapse_cannot_report_success()
    {
        _open = null;
        _collapseSucceeds = false;
        Assert.False(Dismiss());
        Assert.Equal(["read", "collapse", "read"], _calls);
    }
}
