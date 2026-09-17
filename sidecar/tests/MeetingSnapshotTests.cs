using TeamsBridge;
using Xunit;

namespace TeamsBridge.Tests;

/// <summary>
/// The fingerprint decides whether a state line is emitted at all, so it is
/// what stops the sidecar chattering at the plugin on every poll - and what
/// would silently swallow a real change if it were too coarse.
/// </summary>
public class MeetingSnapshotTests
{
    private static MeetingSnapshot Sample() => new()
    {
        TeamsRunning = true,
        InMeeting = true,
        WindowTitle = "Meeting with Someone | Microsoft Teams",
        States = new() { ["mute"] = true, ["camera"] = false },
        Available = new() { ["mute"] = true, ["camera"] = true },
        Context = new() { ["ppt.role"] = "attendee", ["ppt.slide"] = "3", ["ppt.slides"] = "19" }
    };

    [Fact]
    public void An_unchanged_snapshot_produces_an_unchanged_fingerprint()
    {
        Assert.Equal(Sample().Fingerprint(), Sample().Fingerprint());
    }

    [Fact]
    public void Key_insertion_order_does_not_change_the_fingerprint()
    {
        var a = Sample();
        var b = Sample();
        b.States = new() { ["camera"] = false, ["mute"] = true };

        Assert.Equal(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void A_state_change_changes_the_fingerprint()
    {
        var a = Sample();
        var b = Sample();
        b.States["mute"] = false;

        Assert.NotEqual(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void An_availability_change_changes_the_fingerprint()
    {
        // This is what dims a key, so it has to be part of the signal.
        var a = Sample();
        var b = Sample();
        b.Available["mute"] = false;

        Assert.NotEqual(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void Leaving_a_meeting_changes_the_fingerprint()
    {
        var a = Sample();
        var b = Sample();
        b.InMeeting = false;

        Assert.NotEqual(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void Teams_exiting_changes_the_fingerprint()
    {
        var a = Sample();
        var b = Sample();
        b.TeamsRunning = false;

        Assert.NotEqual(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void A_new_control_appearing_changes_the_fingerprint()
    {
        var a = Sample();
        var b = Sample();
        b.Available["chat"] = true;

        Assert.NotEqual(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void The_window_title_is_deliberately_not_part_of_the_fingerprint()
    {
        // Titles carry meeting and participant names and drive nothing on the
        // keys, so a title change must not cause a republish.
        var a = Sample();
        var b = Sample();
        b.WindowTitle = "Meeting with Someone Else | Microsoft Teams";

        Assert.Equal(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void Advancing_a_slide_changes_the_fingerprint()
    {
        // Nothing else moves when the presenter advances, so without the context
        // in the fingerprint the state message would be suppressed as unchanged
        // and the slide counter would never update.
        var a = Sample();
        var b = Sample();
        b.Context["ppt.slide"] = "4";

        Assert.NotEqual(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void Starting_a_presentation_changes_the_fingerprint()
    {
        var a = new MeetingSnapshot { TeamsRunning = true, InMeeting = true };
        var b = new MeetingSnapshot { TeamsRunning = true, InMeeting = true };
        b.States["ppt-live"] = true;
        b.Context["ppt.role"] = "presenter";

        Assert.NotEqual(a.Fingerprint(), b.Fingerprint());
    }

    [Fact]
    public void Context_insertion_order_does_not_change_the_fingerprint()
    {
        var a = new MeetingSnapshot
        {
            Context = new() { ["ppt.slide"] = "3", ["ppt.role"] = "attendee" }
        };
        var b = new MeetingSnapshot
        {
            Context = new() { ["ppt.role"] = "attendee", ["ppt.slide"] = "3" }
        };

        Assert.Equal(a.Fingerprint(), b.Fingerprint());
    }
}
