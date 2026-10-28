using System.Runtime.InteropServices;
using FlaUI.Core.Definitions;
using Xunit;

namespace TeamsBridge.Tests;

public class CameraPreferenceTests
{
    private static readonly CameraVideoSettingsSpec Selectors = new();

    [Fact]
    public void Unchanged_preferences_do_not_touch_the_UI()
    {
        var ui = new FakeUi();
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(), null, out var paneUsed);

        Assert.True(result.ok);
        Assert.False(paneUsed);
        Assert.Empty(ui.Calls);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Each_destination_applies_its_preferences_and_repeated_presses_are_idempotent(bool wanted)
    {
        var ui = new FakeUi();
        foreach (var name in new[] { Selectors.MirrorName, Selectors.SoftFocusName, Selectors.BrightnessName })
            ui.States[name] = !wanted;

        foreach (var value in new[] { wanted, !wanted })
        {
            var preferences = new CameraPreferences(value, value, value);
            Assert.True(TeamsClient.ApplyCameraPreferences(ui, Selectors, preferences, null, out _).ok);
            var changes = ui.Changes;
            Assert.True(TeamsClient.ApplyCameraPreferences(ui, Selectors, preferences, null, out _).ok);
            Assert.Equal(changes, ui.Changes);
            foreach (var name in new[] { Selectors.MirrorName, Selectors.SoftFocusName, Selectors.BrightnessName })
                Assert.Equal(value, ui.States[name]);
        }
        Assert.False(ui.PaneVisible);
    }

    [Fact]
    public void Focus_and_brightness_only_do_not_open_a_settings_pane_or_change_mirror()
    {
        var ui = new FakeUi();
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(null, true, true), null, out var paneUsed);

        Assert.True(result.ok);
        Assert.False(paneUsed);
        Assert.DoesNotContain("open", ui.Calls);
        Assert.DoesNotContain($"set:{Selectors.MirrorName}", ui.Calls);
    }

    [Fact]
    public void An_ignored_open_click_retains_the_original_flyout_cleanup()
    {
        var ui = new FakeUi { OpenSucceeds = false };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), null, out var paneUsed);

        Assert.False(result.ok);
        Assert.False(paneUsed);
        Assert.Contains("could not open Teams video settings", result.error);
        Assert.DoesNotContain("could not close", result.error);
        Assert.DoesNotContain("close", ui.Calls);
        Assert.DoesNotContain($"set:{Selectors.MirrorName}", ui.Calls);
    }

    [Fact]
    public void A_pane_arriving_after_the_open_timeout_is_still_closed()
    {
        var ui = new FakeUi { OpenSucceeds = false, PaneArrivesLate = true };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), null, out var paneUsed);

        Assert.False(result.ok);
        Assert.True(paneUsed);
        Assert.False(ui.PaneVisible);
        Assert.Contains("close", ui.Calls);
    }

    [Fact]
    public void Failure_to_select_Settings_still_closes_a_new_pane()
    {
        var ui = new FakeUi { SelectSucceeds = false };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), null, out var paneUsed);

        Assert.False(result.ok);
        Assert.True(paneUsed);
        Assert.False(ui.PaneVisible);
        Assert.DoesNotContain($"set:{Selectors.MirrorName}", ui.Calls);
    }

    [Fact]
    public void A_failed_close_is_reported_instead_of_claiming_success()
    {
        var ui = new FakeUi { CloseSucceeds = false };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), null, out var paneUsed);

        Assert.False(result.ok);
        Assert.True(paneUsed);
        Assert.Contains("could not close the video settings pane", result.error);
        Assert.Contains("some video preferences may already have changed", result.error);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Effects")]
    public void An_existing_pane_is_left_open_on_its_previous_tab(string? originalTab)
    {
        var ui = new FakeUi { PaneVisible = true, SelectedTab = "Effects" };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), originalTab, out var paneUsed);

        Assert.True(result.ok);
        Assert.True(paneUsed);
        Assert.True(ui.PaneVisible);
        Assert.Equal("Effects", ui.SelectedTab);
        Assert.DoesNotContain("open", ui.Calls);
        Assert.DoesNotContain("close", ui.Calls);
        Assert.Contains("dismiss-options", ui.Calls);
    }

    [Fact]
    public void A_pane_closed_by_the_camera_flyout_is_reopened_and_restored()
    {
        var ui = new FakeUi();
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), "Effects", out var paneUsed);

        Assert.True(result.ok);
        Assert.True(paneUsed);
        Assert.True(ui.PaneVisible);
        Assert.Equal("Effects", ui.SelectedTab);
        Assert.DoesNotContain("close", ui.Calls);
    }

    [Fact]
    public void An_early_effect_failure_still_restores_the_original_pane()
    {
        var ui = new FakeUi { OptionsAvailable = false };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true, true), "Effects", out var paneUsed);

        Assert.False(result.ok);
        Assert.True(paneUsed);
        Assert.True(ui.PaneVisible);
        Assert.Equal("Effects", ui.SelectedTab);
        Assert.DoesNotContain($"set:{Selectors.MirrorName}", ui.Calls);
    }

    [Fact]
    public void A_failed_restore_is_reported_without_closing_the_users_pane()
    {
        var ui = new FakeUi { PaneVisible = true, SelectSucceeds = false };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), "Effects", out _);

        Assert.False(result.ok);
        Assert.Contains("could not restore the previous video settings tab", result.error);
        Assert.True(ui.PaneVisible);
        Assert.DoesNotContain("close", ui.Calls);
    }

    [Fact]
    public void A_later_failure_reports_that_an_earlier_preference_may_have_changed()
    {
        var ui = new FakeUi { OpenSucceeds = false };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true, true), null, out var paneUsed);

        Assert.False(result.ok);
        Assert.False(paneUsed);
        Assert.True(ui.States[Selectors.SoftFocusName]);
        Assert.Contains("some video preferences may already have changed", result.error);
        Assert.DoesNotContain($"set:{Selectors.MirrorName}", ui.Calls);
    }

    [Fact]
    public void An_existing_pane_with_unknown_selection_is_not_changed_or_closed()
    {
        var ui = new FakeUi { PaneVisible = true, SelectedTab = null };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), null, out _);

        Assert.False(result.ok);
        Assert.Contains("did not expose the selected video settings tab", result.error);
        Assert.True(ui.PaneVisible);
        Assert.DoesNotContain("close", ui.Calls);
        Assert.DoesNotContain($"set:{Selectors.MirrorName}", ui.Calls);
    }

    [Fact]
    public void A_toggle_exception_does_not_skip_pane_cleanup()
    {
        var ui = new FakeUi { ThrowOnToggle = true };
        var result = TeamsClient.ApplyCameraPreferences(ui, Selectors, new(true), null, out var paneUsed);

        Assert.False(result.ok);
        Assert.True(paneUsed);
        Assert.False(ui.PaneVisible);
        Assert.Contains("could not apply Teams video preferences", result.error);
    }

    [Fact]
    public void Configured_names_are_used_for_each_preference_and_the_Settings_tab()
    {
        var selectors = new CameraVideoSettingsSpec
        {
            SoftFocusName = "focus-custom",
            BrightnessName = "brightness-custom",
            MirrorName = "mirror-custom",
            SettingsTabName = "settings-custom"
        };
        var ui = new FakeUi();
        var result = TeamsClient.ApplyCameraPreferences(ui, selectors, new(true, true, true), null, out _);

        Assert.True(result.ok);
        Assert.Contains("options:focus-custom", ui.Calls);
        Assert.Contains("options:brightness-custom", ui.Calls);
        Assert.Contains("set:mirror-custom", ui.Calls);
        Assert.Contains("tab:settings-custom", ui.Calls);
    }

    [Theory]
    [InlineData(ToggleState.On, true)]
    [InlineData(ToggleState.Off, false)]
    [InlineData(ToggleState.Indeterminate, null)]
    [InlineData((ToggleState)99, null)]
    [InlineData(null, null)]
    public void Unsupported_and_indeterminate_toggle_states_remain_unknown(ToggleState? state, bool? expected)
    {
        Assert.Equal(expected, TeamsClient.ReadCameraToggle(() => state));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_matching_state_is_never_toggled(bool wanted)
    {
        var changes = 0;
        var error = TeamsClient.SetCameraToggle("setting", wanted, () => wanted,
            () => { changes++; return true; }, Poll);

        Assert.Null(error);
        Assert.Equal(0, changes);
    }

    [Fact]
    public void Stale_reads_are_retried_before_and_after_a_single_toggle()
    {
        var reads = 0;
        var changes = 0;
        bool? Read() => TeamsClient.ReadCameraToggle(() => ++reads switch
        {
            1 or 3 => throw new COMException("stale element"),
            2 => ToggleState.Off,
            _ => ToggleState.On
        });

        var error = TeamsClient.SetCameraToggle("setting", true, Read,
            () => { changes++; return true; }, Poll);

        Assert.Null(error);
        Assert.Equal(1, changes);
        Assert.Equal(4, reads);
    }

    [Fact]
    public void An_unknown_initial_state_never_causes_a_blind_toggle()
    {
        var changes = 0;
        var error = TeamsClient.SetCameraToggle("setting", true, () => null,
            () => { changes++; return true; }, Poll);

        Assert.Equal("Teams did not expose the state of 'setting'", error);
        Assert.Equal(0, changes);
    }

    [Fact]
    public void Unknown_confirmation_fails_without_toggling_again()
    {
        var changes = 0;
        var error = TeamsClient.SetCameraToggle("setting", true, () => changes == 0 ? false : null,
            () => { changes++; return true; }, Poll);

        Assert.Equal("Teams did not confirm 'setting'", error);
        Assert.Equal(1, changes);
    }

    [Fact]
    public void A_failed_change_is_not_retried_as_another_toggle()
    {
        var changes = 0;
        var error = TeamsClient.SetCameraToggle("setting", true, () => false,
            () => { changes++; return false; }, Poll);

        Assert.Equal("could not change 'setting'", error);
        Assert.Equal(1, changes);
    }

    private static bool Poll(Func<bool> ready)
    {
        for (var attempt = 0; attempt < 3; attempt++)
            if (ready()) return true;
        return false;
    }

    private sealed class FakeUi : TeamsClient.ICameraPreferenceUi
    {
        public List<string> Calls { get; } = new();
        public Dictionary<string, bool> States { get; } = new();
        public int Changes { get; private set; }
        public bool PaneVisible { get; set; }
        public string? SelectedTab { get; set; } = "Effects";
        public bool OptionsAvailable { get; init; } = true;
        public bool OpenSucceeds { get; init; } = true;
        public bool PaneArrivesLate { get; init; }
        public bool CloseSucceeds { get; init; } = true;
        public bool SelectSucceeds { get; init; } = true;
        public bool ThrowOnToggle { get; init; }

        public bool EnsureOptions(string name, long deadline)
        {
            Calls.Add($"options:{name}");
            return OptionsAvailable;
        }

        public void DismissOptions() => Calls.Add("dismiss-options");

        public bool OpenPane(long deadline)
        {
            Calls.Add("open");
            PaneVisible = OpenSucceeds || PaneArrivesLate;
            return OpenSucceeds;
        }

        public bool ClosePane(long deadline)
        {
            if (!PaneVisible) return true;
            Calls.Add("close");
            if (CloseSucceeds) PaneVisible = false;
            return CloseSucceeds;
        }

        public bool SelectTab(string name, long deadline)
        {
            Calls.Add($"tab:{name}");
            if (SelectSucceeds) SelectedTab = name;
            return SelectSucceeds;
        }

        public string? SetToggle(string name, bool wanted, long deadline)
        {
            Calls.Add($"set:{name}");
            if (ThrowOnToggle) throw new COMException("stale toggle");
            return TeamsClient.SetCameraToggle(name, wanted, () => States.GetValueOrDefault(name), () =>
            {
                Changes++;
                States[name] = wanted;
                return true;
            }, Poll);
        }
    }
}
