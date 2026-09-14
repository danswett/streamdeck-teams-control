using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

namespace TeamsBridge;

/// <summary>
/// Describes how to locate and interpret one Teams meeting control.
/// Loaded from selectors.json so the mapping can be patched without a rebuild
/// when Teams changes its UI.
/// </summary>
public sealed class ControlSpec
{
    public string AutomationId { get; set; } = "";
    public string? Menu { get; set; }
    public string? MenuItemAutomationId { get; set; }
    public string? MenuItemName { get; set; }
    public string? ActivePattern { get; set; }
    public string? InactivePattern { get; set; }

    private Regex? _active;
    private Regex? _inactive;
    private Regex? _menuItem;

    public Regex? ActiveRegex => _active ??= Compile(ActivePattern);
    public Regex? InactiveRegex => _inactive ??= Compile(InactivePattern);
    public Regex? MenuItemRegex => _menuItem ??= Compile(MenuItemName);

    private static Regex? Compile(string? p) =>
        string.IsNullOrWhiteSpace(p) ? null : new Regex(p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
}

public sealed class SelectorConfig
{
    public int Version { get; set; } = 1;
    public string MeetingProbeAutomationId { get; set; } = "microphone-button";
    public Dictionary<string, ControlSpec> Controls { get; set; } = new();
}

/// <summary>
/// Reads and drives Microsoft Teams meeting controls through UI Automation.
///
/// This replaces the local Teams third-party websocket API (ws://localhost:8124),
/// which Microsoft retired on 2026-06-30 (MC1266901) without a replacement.
/// UIA invokes the control directly, so Teams does not need focus and no
/// synthetic keystrokes are sent.
/// </summary>
public sealed class TeamsClient : IDisposable
{
    private const uint WM_GETOBJECT = 0x003D;
    private static readonly IntPtr OBJID_CLIENT = new(-4);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    private delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc cb, IntPtr lParam);

    private readonly SelectorConfig _config;
    private readonly UIA3Automation _automation = new();
    private AutomationElement? _meetingWindow;
    private readonly Dictionary<string, AutomationElement> _cache = new();
    private readonly HashSet<IntPtr> _nudged = new();

    public TeamsClient(SelectorConfig config) => _config = config;

    public void Dispose() => _automation.Dispose();

    /// <summary>
    /// Chromium (and therefore the Teams WebView) only builds its accessibility
    /// tree once a client asks for it. Without this nudge a UIA walk of the Teams
    /// window returns zero elements. Screen readers trigger the same code path.
    /// </summary>
    private void EnableAccessibility()
    {
        foreach (var proc in Process.GetProcessesByName("ms-teams"))
        {
            IntPtr main;
            try { main = proc.MainWindowHandle; }
            catch { continue; }
            finally { proc.Dispose(); }
            if (main == IntPtr.Zero) continue;

            var handles = new List<IntPtr> { main };
            EnumChildWindows(main, (h, _) => { handles.Add(h); return true; }, IntPtr.Zero);

            foreach (var h in handles)
            {
                if (!_nudged.Add(h)) continue;
                SendMessageTimeout(h, WM_GETOBJECT, IntPtr.Zero, OBJID_CLIENT,
                    0x0002 /* SMTO_ABORTIFHUNG */, 250, out _);
            }
        }
    }

    private static bool IsTeams(AutomationElement el)
    {
        try
        {
            using var p = Process.GetProcessById(el.Properties.ProcessId.Value);
            return string.Equals(p.ProcessName, "ms-teams", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static AutomationElement? FindById(AutomationElement scope, string automationId)
    {
        try { return scope.FindFirstDescendant(cf => cf.ByAutomationId(automationId)); }
        catch { return null; }
    }

    private static bool IsAlive(AutomationElement? el)
    {
        if (el is null) return false;
        try { _ = el.Properties.Name.ValueOrDefault; return true; }
        catch { return false; }
    }

    private static string NameOf(AutomationElement el)
    {
        try { return el.Properties.Name.ValueOrDefault ?? ""; }
        catch { return ""; }
    }

    private static bool SafeEnabled(AutomationElement el)
    {
        try { return el.Properties.IsEnabled.ValueOrDefault; }
        catch { return false; }
    }

    /// <summary>Locates the Teams window that currently hosts meeting controls.</summary>
    private AutomationElement? ResolveMeetingWindow()
    {
        if (IsAlive(_meetingWindow) && FindById(_meetingWindow!, _config.MeetingProbeAutomationId) is not null)
            return _meetingWindow;

        _meetingWindow = null;
        _cache.Clear();
        EnableAccessibility();

        AutomationElement[] children;
        try { children = _automation.GetDesktop().FindAllChildren(); }
        catch { return null; }

        foreach (var w in children)
        {
            if (!IsTeams(w)) continue;
            try
            {
                if (FindById(w, _config.MeetingProbeAutomationId) is not null)
                {
                    _meetingWindow = w;
                    return w;
                }
            }
            catch { /* window died mid-walk */ }
        }
        return null;
    }

    private AutomationElement? ResolveControl(string key, ControlSpec spec)
    {
        if (_cache.TryGetValue(key, out var cached) && IsAlive(cached)) return cached;
        _cache.Remove(key);

        var win = ResolveMeetingWindow();
        if (win is null) return null;

        var el = FindById(win, spec.AutomationId);
        if (el is not null) _cache[key] = el;
        return el;
    }

    /// <summary>
    /// Derives a control's boolean state from its accessible name. The name
    /// describes the action the button performs, so it is the inverse of state:
    /// "Unmute mic" means you are currently muted.
    /// </summary>
    private static bool? ReadState(AutomationElement el, ControlSpec spec)
    {
        var name = NameOf(el);
        if (name.Length == 0) return null;

        if (spec.ActiveRegex?.IsMatch(name) == true) return true;
        if (spec.InactiveRegex?.IsMatch(name) == true) return false;
        return null;
    }

    public MeetingSnapshot GetSnapshot()
    {
        var snap = new MeetingSnapshot
        {
            TeamsRunning = Process.GetProcessesByName("ms-teams").Length > 0
        };

        var win = ResolveMeetingWindow();
        snap.InMeeting = win is not null;
        if (win is null) return snap;

        snap.WindowTitle = NameOf(win);

        foreach (var (key, spec) in _config.Controls)
        {
            // Menu-nested controls (reactions, hand, blur) are not readable
            // without opening their flyout, so only report availability.
            if (!string.IsNullOrEmpty(spec.Menu))
            {
                var host = FindById(win, spec.Menu!);
                snap.Available[key] = host is not null && SafeEnabled(host);
                continue;
            }

            var el = ResolveControl(key, spec);
            if (el is null) { snap.Available[key] = false; continue; }

            snap.Available[key] = SafeEnabled(el);
            var st = ReadState(el, spec);
            if (st.HasValue) snap.States[key] = st.Value;
        }

        return snap;
    }

    private static bool TryInvoke(AutomationElement el)
    {
        try
        {
            var invoke = el.Patterns.Invoke.PatternOrDefault;
            if (invoke is not null) { invoke.Invoke(); return true; }
        }
        catch { }

        try
        {
            var toggle = el.Patterns.Toggle.PatternOrDefault;
            if (toggle is not null) { toggle.Toggle(); return true; }
        }
        catch { }

        try
        {
            var legacy = el.Patterns.LegacyIAccessible.PatternOrDefault;
            if (legacy is not null) { legacy.DoDefaultAction(); return true; }
        }
        catch { }

        return false;
    }

    private static bool TryExpand(AutomationElement el)
    {
        try
        {
            var ec = el.Patterns.ExpandCollapse.PatternOrDefault;
            if (ec is not null) { ec.Expand(); return true; }
        }
        catch { }
        return TryInvoke(el);
    }

    private static void TryCollapse(AutomationElement el)
    {
        try { el.Patterns.ExpandCollapse.PatternOrDefault?.Collapse(); }
        catch { }
    }

    /// <summary>
    /// Finds an element inside a just-opened flyout. The flyout is a popup that
    /// may be parented to the desktop rather than the meeting window, so both
    /// scopes are searched.
    /// </summary>
    private AutomationElement? FindInPopup(AutomationElement win, string? autoId, Regex? nameRx, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            foreach (var scope in new[] { win, _automation.GetDesktop() })
            {
                try
                {
                    if (!string.IsNullOrEmpty(autoId))
                    {
                        var byId = FindById(scope, autoId!);
                        if (byId is not null && SafeEnabled(byId)) return byId;
                    }

                    if (nameRx is not null)
                    {
                        var all = scope.FindAllDescendants(cf =>
                            cf.ByControlType(ControlType.Button)
                              .Or(cf.ByControlType(ControlType.MenuItem))
                              .Or(cf.ByControlType(ControlType.ListItem)));

                        foreach (var c in all)
                        {
                            if (nameRx.IsMatch(NameOf(c))) return c;
                        }
                    }
                }
                catch { }
            }
            Thread.Sleep(40);
        }
        return null;
    }

    public (bool ok, string? error) Invoke(string target)
    {
        if (!_config.Controls.TryGetValue(target, out var spec))
            return (false, $"unknown target '{target}'");

        var win = ResolveMeetingWindow();
        if (win is null) return (false, "not in a meeting");

        // Direct toolbar control.
        if (string.IsNullOrEmpty(spec.Menu))
        {
            var el = ResolveControl(target, spec);
            if (el is null) return (false, $"control '{target}' not found");
            if (!SafeEnabled(el)) return (false, $"control '{target}' is disabled");
            return TryInvoke(el) ? (true, null) : (false, $"could not invoke '{target}'");
        }

        // Flyout-nested control: open the menu, click the item, make sure it closed.
        var host = FindById(win, spec.Menu!);
        if (host is null) return (false, $"menu '{spec.Menu}' not found");
        if (!TryExpand(host)) return (false, $"could not open menu '{spec.Menu}'");

        var dismissed = false;
        try
        {
            var item = FindInPopup(win, spec.MenuItemAutomationId, spec.MenuItemRegex, 1500);
            if (item is null) return (false, $"item for '{target}' not found in menu");
            if (!TryInvoke(item)) return (false, $"could not invoke item for '{target}'");

            // Choosing an item dismisses the flyout on its own.
            dismissed = true;
            return (true, null);
        }
        finally
        {
            if (!dismissed) TryCollapse(host);
        }
    }

    /// <summary>
    /// Opens a flyout and dumps everything inside it. Used to map Teams' UI
    /// without guessing, and to re-map it if a Teams update moves things.
    /// </summary>
    public List<Dictionary<string, string>> Discover(string? menuAutomationId)
    {
        var results = new List<Dictionary<string, string>>();
        var win = ResolveMeetingWindow();
        if (win is null) return results;

        AutomationElement? host = null;
        if (!string.IsNullOrEmpty(menuAutomationId))
        {
            host = FindById(win, menuAutomationId!);
            if (host is null) return results;
            TryExpand(host);
            Thread.Sleep(700);
        }

        var scopes = host is null
            ? new[] { win }
            : new[] { win, _automation.GetDesktop() };

        var seen = new HashSet<string>();
        foreach (var scope in scopes)
        {
            AutomationElement[] all;
            try { all = scope.FindAllDescendants(); }
            catch { continue; }

            foreach (var e in all)
            {
                try
                {
                    var type = e.Properties.ControlType.ValueOrDefault;
                    if (type is not (ControlType.Button or ControlType.MenuItem or ControlType.CheckBox
                        or ControlType.ListItem or ControlType.RadioButton)) continue;

                    var name = NameOf(e);
                    var autoId = e.Properties.AutomationId.ValueOrDefault ?? "";
                    if (string.IsNullOrWhiteSpace(name) && string.IsNullOrWhiteSpace(autoId)) continue;

                    if (!seen.Add($"{type}|{autoId}|{name}")) continue;

                    results.Add(new Dictionary<string, string>
                    {
                        ["type"] = type.ToString(),
                        ["automationId"] = autoId,
                        ["name"] = name,
                        ["enabled"] = SafeEnabled(e).ToString(),
                        ["accelerator"] = Safe(() => e.Properties.AcceleratorKey.ValueOrDefault),
                        // aria-pressed / aria-checked would be a locale-independent
                        // state signal wherever Teams sets it.
                        ["aria"] = Safe(() => e.Properties.AriaProperties.ValueOrDefault),
                        ["toggle"] = Safe(() => e.Patterns.Toggle.PatternOrDefault?.ToggleState.ValueOrDefault.ToString())
                    });
                }
                catch { }
            }
        }

        if (host is not null) TryCollapse(host);
        return results;
    }

    private static string Safe(Func<string?> get)
    {
        try { return get() ?? ""; }
        catch { return ""; }
    }
}

public sealed class MeetingSnapshot
{
    public bool TeamsRunning { get; set; }
    public bool InMeeting { get; set; }
    public string WindowTitle { get; set; } = "";
    public Dictionary<string, bool> States { get; set; } = new();
    public Dictionary<string, bool> Available { get; set; } = new();

    public string Fingerprint()
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(TeamsRunning).Append('|').Append(InMeeting).Append('|');
        foreach (var k in States.Keys.Order()) sb.Append(k).Append('=').Append(States[k]).Append(';');
        sb.Append('|');
        foreach (var k in Available.Keys.Order()) sb.Append(k).Append('=').Append(Available[k]).Append(';');
        return sb.ToString();
    }
}
