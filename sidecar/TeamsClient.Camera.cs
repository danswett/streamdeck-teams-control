using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using System.Runtime.InteropServices;

namespace TeamsBridge;

public sealed partial class TeamsClient
{
    private (bool ok, string? error) ApplyCameraPreferences(
        AutomationElement win, string menuId, CameraPreferences preferences, string? originalVideoTab, out bool paneUsed)
        => ApplyCameraPreferences(new CameraPreferenceUi(this, win, menuId), _config.CameraVideoSettings,
            preferences, originalVideoTab, out paneUsed);

    internal interface ICameraPreferenceUi
    {
        bool PaneVisible { get; }
        string? SelectedTab { get; }
        bool EnsureOptions(string name, long deadline);
        void DismissOptions();
        bool OpenPane(long deadline);
        bool ClosePane(long deadline);
        bool SelectTab(string name, long deadline);
        string? SetToggle(string name, bool wanted, long deadline);
    }

    internal static (bool ok, string? error) ApplyCameraPreferences(
        ICameraPreferenceUi ui, CameraVideoSettingsSpec selectors, CameraPreferences preferences,
        string? originalVideoTab, out bool paneUsed)
    {
        paneUsed = false;
        if (preferences is { Mirror: null, SoftFocus: null, Brightness: null }) return (true, null);

        var deadline = Environment.TickCount64 + 10_000;
        var stages = new StageLog();
        var attemptedPane = false;
        // Opening the camera flyout can itself close the video-settings pane,
        // so remember its original tab before starting the camera selection.
        string? previousTab = originalVideoTab;
        string? error = null;
        try
        {
            foreach (var (name, value) in new[]
            {
                (selectors.SoftFocusName, preferences.SoftFocus),
                (selectors.BrightnessName, preferences.Brightness)
            })
            {
                if (value is null) continue;
                if (!ui.EnsureOptions(name, deadline))
                {
                    error = $"could not find '{name}' in Teams video options";
                    break;
                }
                error = ui.SetToggle(name, value.Value, deadline);
                stages.Mark(name);
                if (error is not null) break;
            }

            if (error is null && preferences.Mirror is { } mirror)
            {
                var existingPane = ui.PaneVisible;
                if (existingPane)
                {
                    // The camera flyout can overlap an already-open pane.
                    // Dismiss it before clicking controls in the pane beneath.
                    ui.DismissOptions();
                    paneUsed = true;
                }
                else
                {
                    attemptedPane = true;
                    if (ui.OpenPane(deadline)) paneUsed = true;
                    else error = "could not open Teams video settings";
                    stages.Mark("pane");
                }
                if (error is null)
                {
                    if (existingPane)
                    {
                        previousTab ??= ui.SelectedTab;
                        if (previousTab is null) error = "Teams did not expose the selected video settings tab";
                    }
                    if (error is null && !ui.SelectTab(selectors.SettingsTabName, deadline))
                        error = "could not select the video Settings tab";
                    stages.Mark("tab");
                    if (error is null)
                        error = ui.SetToggle(selectors.MirrorName, mirror, deadline);
                    stages.Mark("mirror");
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"camera preferences failed: {ex.Message}");
            error = "could not apply Teams video preferences";
        }
        finally
        {
            try
            {
                var cleanupDeadline = Environment.TickCount64 + 1000;
                if (attemptedPane && previousTab is null)
                {
                    // A posted click is not proof of navigation. Keep the
                    // original flyout cleanup unless a pane actually appeared,
                    // including one arriving after the open timed out.
                    paneUsed |= ui.PaneVisible;
                    if (!ui.ClosePane(cleanupDeadline))
                        error = JoinCameraError(error, "could not close the video settings pane");
                }
                else if (previousTab is not null)
                {
                    var restoredPane = ui.PaneVisible || ui.OpenPane(cleanupDeadline);
                    paneUsed |= restoredPane;
                    if (!restoredPane || !ui.SelectTab(previousTab, cleanupDeadline))
                        error = JoinCameraError(error, "could not restore the previous video settings tab");
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"camera settings cleanup failed: {ex.Message}");
                error = JoinCameraError(error, "could not restore the video settings pane");
            }
            stages.Mark("cleanup");
            stages.ReportIfSlow("camera preferences", SlowFlyoutMs);
        }
        if (error is null) return (true, null);
        Console.Error.WriteLine($"webcam selected, but video preferences failed: {error}");
        return (false, $"webcam selected, but {error}; some video preferences may already have changed");
    }

    private sealed class CameraPreferenceUi(TeamsClient client, AutomationElement win, string menuId) : ICameraPreferenceUi
    {
        private CameraVideoSettingsSpec Selectors => client._config.CameraVideoSettings;
        public bool PaneVisible => FindById(win, Selectors.PaneTabsAutomationId) is not null;
        public string? SelectedTab => FindById(win, Selectors.PaneTabsAutomationId) is { } tabs
            ? SelectedVideoSettingsTab(tabs) : null;

        public bool EnsureOptions(string name, long deadline) =>
            client.EnsureVideoOptions(win, menuId, name, deadline);

        public void DismissOptions()
        {
            var host = FindById(win, menuId);
            client.DismissFlyout(win, null, host, host is null ? null : CenterOf(host), menuId);
        }

        public bool OpenPane(long deadline)
        {
            if (!EnsureOptions(Selectors.MoreSettingsName, deadline)) return false;
            var entry = client.FindVideoSetting(win, Selectors.MoreSettingsName);
            return entry is not null && SafeEnabled(entry) && client.Press(entry) &&
                WaitForCameraUi(() => PaneVisible, deadline);
        }

        public bool ClosePane(long deadline)
        {
            if (!PaneVisible) return true;
            var close = client.FindVideoSetting(win, Selectors.ClosePaneName);
            return close is not null && SafeEnabled(close) && client.Press(close) &&
                WaitForCameraUi(() => !PaneVisible, deadline);
        }

        public bool SelectTab(string name, long deadline) => client.SelectVideoSettingsTab(win, name, deadline);
        public string? SetToggle(string name, bool wanted, long deadline) =>
            client.SetCameraToggle(win, name, wanted, deadline);
    }

    private bool EnsureVideoOptions(AutomationElement win, string menuId, string name, long deadline)
    {
        if (FindVideoSetting(win, name) is not null) return true;
        var host = FindById(win, menuId);
        return host is not null && SafeEnabled(host) && Environment.TickCount64 < deadline &&
            ExpandMenu(host) && WaitForCameraUi(() => FindVideoSetting(win, name) is not null, deadline);
    }

    private bool SelectVideoSettingsTab(AutomationElement win, string name, long deadline)
    {
        AutomationElement? FindTab() => FindById(win, _config.CameraVideoSettings.PaneTabsAutomationId)?.FindFirstDescendant(cf =>
            cf.ByControlType(ControlType.TabItem).And(cf.ByName(name)));
        var tab = FindTab();
        if (tab is null || !SafeEnabled(tab)) return false;
        if (IsSelected(tab) == true) return true;
        var selection = tab.Patterns.SelectionItem.PatternOrDefault;
        if (selection is null || Environment.TickCount64 >= deadline) return false;
        // Tabs expose SelectionItem, not Invoke. Select the tab explicitly
        // rather than posting a click that Chromium can discard during layout.
        Guarded(selection.Select);
        return WaitForCameraUi(() => FindTab() is { } fresh && IsSelected(fresh) == true, deadline);
    }

    private static string? SelectedVideoSettingsTab(AutomationElement tabs) =>
        tabs.FindAllDescendants(cf => cf.ByControlType(ControlType.TabItem))
            .FirstOrDefault(tab => IsSelected(tab) == true) is { } selected ? NameOf(selected) : null;

    private AutomationElement? FindVideoSetting(AutomationElement win, string name)
    {
        foreach (var scope in SearchScopes(win))
        {
            var item = scope.FindFirstDescendant(cf => cf.ByName(name).And(
                cf.ByControlType(ControlType.Button).Or(cf.ByControlType(ControlType.CheckBox))
                  .Or(cf.ByControlType(ControlType.Hyperlink)).Or(cf.ByControlType(ControlType.MenuItem))));
            if (item is not null) return item;
        }
        return null;
    }

    private string? SetCameraToggle(AutomationElement win, string name, bool wanted, long deadline)
    {
        bool? Read() => ReadCameraToggle(() =>
        {
            var toggle = FindVideoSetting(win, name)?.Patterns.Toggle.PatternOrDefault;
            return toggle is not null && toggle.ToggleState.IsSupported ? toggle.ToggleState.Value : null;
        });

        bool Change()
        {
            if (Environment.TickCount64 >= deadline) return false;
            var item = FindVideoSetting(win, name);
            if (item is null || !SafeEnabled(item)) return false;
            var current = ReadCameraToggle(() =>
            {
                var pattern = item.Patterns.Toggle.PatternOrDefault;
                return pattern is not null && pattern.ToggleState.IsSupported ? pattern.ToggleState.Value : null;
            });
            if (current is null) return false;
            if (current == wanted) return true;
            var toggle = item.Patterns.Toggle.PatternOrDefault;
            if (toggle is null) return false;
            // Verified live: the mirror switch can be below the scroll
            // viewport. Toggle works there; a posted click does not. Keep
            // this UIA call under the existing focus guard.
            Guarded(toggle.Toggle);
            return true;
        }

        return SetCameraToggle(name, wanted, Read, Change, ready => WaitForCameraUi(ready, deadline));
    }

    internal static string? SetCameraToggle(
        string name, bool wanted, Func<bool?> read, Func<bool> change, Func<Func<bool>, bool> wait)
    {
        bool? current = null;
        if (!wait(() => (current = read()).HasValue)) return $"Teams did not expose the state of '{name}'";
        if (current == wanted) return null;
        if (!change()) return $"could not change '{name}'";
        return wait(() => read() == wanted) ? null : $"Teams did not confirm '{name}'";
    }

    internal static bool? ReadCameraToggle(Func<ToggleState?> read)
    {
        try
        {
            return read() switch
            {
                ToggleState.On => true,
                ToggleState.Off => false,
                _ => null
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"could not read camera preference state: {ex.Message}");
            return null;
        }
    }

    private static bool WaitForCameraUi(Func<bool> ready, long deadline)
    {
        do
        {
            try
            {
                if (ready()) return true;
            }
            catch (Exception ex) when (ex is COMException or FlaUI.Core.Exceptions.ElementNotAvailableException)
            {
                Console.Error.WriteLine($"camera preference UI changed while waiting: {ex.Message}");
            }
            if (Environment.TickCount64 >= deadline) return false;
            Thread.Sleep(PopupScanIntervalMs);
        } while (true);
    }

    private static string JoinCameraError(string? error, string next) =>
        error is null ? next : $"{error}; {next}";
}
