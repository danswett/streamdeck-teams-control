using Xunit;

namespace TeamsBridge.Tests;

public class MusicModeDismissTests
{
    private readonly List<string> _calls = [];
    private bool? _open = true;
    private bool _postSucceeds;
    private bool _collapseSucceeds = true;
    private readonly Queue<bool> _closed = new();

    private void Dismiss(Action? afterPost = null) => MusicMode.Dismiss(
        () => { _calls.Add("read"); return _open; },
        () => { _calls.Add("post"); afterPost?.Invoke(); return _postSucceeds; },
        () => { _calls.Add("collapse"); return _collapseSucceeds; },
        () => { _calls.Add("confirm"); return _closed.Dequeue(); },
        () => _calls.Add("fallback"));

    [Fact]
    public void An_already_closed_menu_is_not_toggled_open_again()
    {
        _open = false;
        Dismiss();
        Assert.Equal(["read"], _calls);
    }

    [Fact]
    public void Unknown_menu_state_uses_existing_cleanup_without_a_guessed_click()
    {
        _open = null;
        Dismiss();
        Assert.Equal(["read", "fallback"], _calls);
    }

    [Fact]
    public void A_safe_posted_close_is_preferred_and_must_be_confirmed()
    {
        _postSucceeds = true;
        _closed.Enqueue(true);
        Dismiss();
        Assert.Equal(["read", "post", "confirm"], _calls);
    }

    [Fact]
    public void A_disallowed_or_unavailable_post_uses_collapse_without_a_natural_close_wait()
    {
        _closed.Enqueue(true);
        Dismiss();
        Assert.Equal(["read", "post", "read", "collapse", "confirm"], _calls);
    }

    [Fact]
    public void A_posted_click_is_not_proof_of_dismissal()
    {
        _postSucceeds = true;
        _closed.Enqueue(false);
        _closed.Enqueue(true);
        Dismiss();
        Assert.Equal(["read", "post", "confirm", "read", "collapse", "confirm"], _calls);
    }

    [Fact]
    public void A_menu_that_closed_during_the_attempt_gets_no_further_input()
    {
        Dismiss(() => _open = false);
        Assert.Equal(["read", "post", "read"], _calls);
    }

    [Fact]
    public void Unconfirmed_collapse_retains_the_existing_dismissal_fallback()
    {
        _closed.Enqueue(false);
        Dismiss();
        Assert.Equal(["read", "post", "read", "collapse", "confirm", "fallback"], _calls);
    }

    [Fact]
    public void An_unavailable_collapse_falls_back_without_waiting_for_a_nonexistent_write()
    {
        _collapseSucceeds = false;
        Dismiss();
        Assert.Equal(["read", "post", "read", "collapse", "fallback"], _calls);
    }
}
