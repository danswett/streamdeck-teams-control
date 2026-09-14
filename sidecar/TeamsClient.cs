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
    /// <summary>
    /// Item to click when the primary menu item is already checked. Background
    /// effects are a radio group rather than a toggle: clicking "Standard blur"
    /// again leaves blur on, so turning it off means clicking "No background
    /// effect" instead.
    /// </summary>
    public string? MenuItemOffName { get; set; }
    public string? ActivePattern { get; set; }
    public string? InactivePattern { get; set; }

    private Regex? _active;
    private Regex? _inactive;
    private Regex? _menuItem;
    private Regex? _menuItemOff;

    public Regex? ActiveRegex => _active ??= Compile(ActivePattern);
    public Regex? InactiveRegex => _inactive ??= Compile(InactivePattern);
    public Regex? MenuItemRegex => _menuItem ??= Compile(MenuItemName);
    public Regex? MenuItemOffRegex => _menuItemOff ??= Compile(MenuItemOffName);

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
    private readonly bool _restoreFocus;
    private readonly UIA3Automation _automation = new();
    private AutomationElement? _meetingWindow;
    private readonly Dictionary<string, AutomationElement> _cache = new();
    private readonly HashSet<IntPtr> _nudged = new();

    /// <summary>
    /// Any one of these proves a meeting window. While a flyout is open Teams
    /// drops the whole toolbar from the accessibility tree and exposes only the
    /// popup, so probing for the mic button alone would look like "meeting
    /// ended" every time a menu is opened.
    /// </summary>
    private static readonly string[] MeetingMarkers =
    {
        "microphone-button", "hangup-button", "raisehands-button", "like-button"
    };

    /// <summary>Last known control states, carried forward across transient tree changes.</summary>
    private readonly Dictionary<string, bool> _lastStates = new();

    public TeamsClient(SelectorConfig config, bool restoreFocus = true)
    {
        _config = config;
        _restoreFocus = restoreFocus;
    }

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

    private static bool HasAnyMarker(AutomationElement win)
    {
        foreach (var marker in MeetingMarkers)
        {
            if (FindById(win, marker) is not null) return true;
        }
        return false;
    }

    /// <summary>Locates the Teams window that currently hosts meeting controls.</summary>
    private AutomationElement? ResolveMeetingWindow()
    {
        if (IsAlive(_meetingWindow) && HasAnyMarker(_meetingWindow!))
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
                if (HasAnyMarker(w))
                {
                    _meetingWindow = w;
                    return w;
                }
            }
            catch { /* window died mid-walk */ }
        }

        _lastStates.Clear();
        return null;
    }

    /// <summary>True when the meeting toolbar itself is reachable, i.e. no flyout is covering it.</summary>
    private bool IsToolbarVisible(AutomationElement win) =>
        FindById(win, _config.MeetingProbeAutomationId) is not null;

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

        if (!IsToolbarVisible(win))
        {
            // A flyout is covering the toolbar. Report the meeting as live with
            // the last known state rather than blanking every key.
            foreach (var key in _config.Controls.Keys) snap.Available[key] = true;
            foreach (var (k, v) in _lastStates) snap.States[k] = v;
            return snap;
        }

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
            if (el is null)
            {
                snap.Available[key] = false;
                if (_lastStates.TryGetValue(key, out var carried)) snap.States[key] = carried;
                continue;
            }

            snap.Available[key] = SafeEnabled(el);
            var st = ReadState(el, spec);
            if (st.HasValue)
            {
                snap.States[key] = st.Value;
                _lastStates[key] = st.Value;
            }
            else if (_lastStates.TryGetValue(key, out var carried))
            {
                snap.States[key] = carried;
            }
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
    /// Closes an open Teams flyout without sending any input.
    ///
    /// Invoking a flyout item through UI Automation fires the item's handler but
    /// not the focus/outside-click that normally dismisses the popup, so the
    /// flyout stays open — and while it is open Teams removes the meeting
    /// toolbar from the accessibility tree, wedging every later call.
    ///
    /// Observed structure, consistent across the React and video-options
    /// flyouts: item -> ... -> &lt;Window&gt; (the popup) -> &lt;Group&gt; with an
    /// Invoke pattern. That Group is the dismiss layer; invoking it does what
    /// clicking away would. Groups *inside* the popup also expose Invoke but do
    /// nothing, so the popup Window is used as the landmark.
    /// </summary>
    private void DismissFlyout(AutomationElement win, AutomationElement? anchor, AutomationElement? host)
    {
        if (host is not null) TryCollapse(host);
        if (WaitForToolbar(win, 300)) return;

        if (anchor is not null)
        {
            // Build the ancestor chain once; the tree changes as we invoke.
            var chain = new List<AutomationElement>();
            var node = SafeParent(anchor);
            for (var i = 0; i < 10 && node is not null; i++)
            {
                chain.Add(node);
                node = SafeParent(node);
            }

            var windowIndex = chain.FindIndex(e =>
            {
                try { return e.Properties.ControlType.ValueOrDefault == ControlType.Window; }
                catch { return false; }
            });

            // Preferred target first, then every other invoke-able ancestor.
            var order = new List<int>();
            if (windowIndex >= 0)
            {
                for (var i = windowIndex + 1; i < chain.Count; i++) order.Add(i);
            }
            for (var i = 0; i < chain.Count; i++)
            {
                if (!order.Contains(i)) order.Add(i);
            }

            foreach (var i in order)
            {
                try
                {
                    var invoke = chain[i].Patterns.Invoke.PatternOrDefault;
                    if (invoke is null) continue;
                    invoke.Invoke();
                    if (WaitForToolbar(win, 600)) return;
                }
                catch { }
            }
        }

        if (!WaitForToolbar(win, 600))
            Console.Error.WriteLine("warning: could not dismiss Teams flyout; toolbar still hidden");
    }

    private static AutomationElement? SafeParent(AutomationElement el)
    {
        try { return el.Parent; }
        catch { return null; }
    }

    private bool WaitForToolbar(AutomationElement win, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            if (IsToolbarVisible(win)) return true;
            if (Environment.TickCount64 >= deadline) return false;
            Thread.Sleep(60);
        }
    }

    /// <summary>
    /// Clears a flyout that is currently hiding the toolbar. Any control still
    /// visible must belong to the open popup, so it serves as the anchor for
    /// the same ancestor-based dismissal used after an invoke.
    /// </summary>
    private void RecoverFromOpenFlyout(AutomationElement win)
    {
        AutomationElement? anchor = null;
        try
        {
            var candidates = win.FindAllDescendants(cf =>
                cf.ByControlType(ControlType.Button)
                  .Or(cf.ByControlType(ControlType.CheckBox))
                  .Or(cf.ByControlType(ControlType.MenuItem)));

            foreach (var c in candidates)
            {
                // Only a control sitting under a popup Window is a useful anchor.
                if (HasWindowAncestor(c)) { anchor = c; break; }
            }
        }
        catch { }

        if (anchor is null) return;
        Console.Error.WriteLine("recovering: a Teams flyout was hiding the toolbar");
        DismissFlyout(win, anchor, null);
    }

    private static bool HasWindowAncestor(AutomationElement el)
    {
        var node = SafeParent(el);
        for (var i = 0; i < 6 && node is not null; i++)
        {
            try
            {
                if (node.Properties.ControlType.ValueOrDefault == ControlType.Window) return true;
            }
            catch { return false; }
            node = SafeParent(node);
        }
        return false;
    }

    /// <summary>
    /// Scopes to search for a flyout. Teams renders some popups outside the
    /// meeting window, but walking the whole desktop is far too slow, so this
    /// is limited to Teams' own top-level windows with the meeting first.
    /// </summary>
    private AutomationElement[] SearchScopes(AutomationElement win)
    {
        var scopes = new List<AutomationElement> { win };
        try
        {
            foreach (var w in _automation.GetDesktop().FindAllChildren())
            {
                if (!IsTeams(w)) continue;
                if (Equals(w, win)) continue;
                scopes.Add(w);
            }
        }
        catch { }
        return scopes.ToArray();
    }

    /// <summary>
    /// Finds an element inside a just-opened flyout, polling until it appears.
    /// </summary>
    private AutomationElement? FindInPopup(AutomationElement win, string? autoId, Regex? nameRx, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        var scopes = SearchScopes(win);

        while (true)
        {
            foreach (var scope in scopes)
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
                              .Or(cf.ByControlType(ControlType.ListItem))
                              .Or(cf.ByControlType(ControlType.CheckBox))
                              .Or(cf.ByControlType(ControlType.RadioButton)));

                        foreach (var c in all)
                        {
                            if (nameRx.IsMatch(NameOf(c))) return c;
                        }
                    }
                }
                catch { }
            }

            if (Environment.TickCount64 >= deadline) return null;
            Thread.Sleep(80);
        }
    }

    public (bool ok, string? error) Invoke(string target)
    {
        if (!_config.Controls.TryGetValue(target, out var spec))
            return (false, $"unknown target '{target}'");

        // Chromium activates the Teams window when a control is invoked, so the
        // window that had focus is put back afterwards.
        var previousFocus = _restoreFocus ? FocusGuard.Capture() : IntPtr.Zero;
        try
        {
            return InvokeCore(target, spec);
        }
        finally
        {
            if (previousFocus != IntPtr.Zero) FocusGuard.RestoreAfter(previousFocus);
        }
    }

    private (bool ok, string? error) InvokeCore(string target, ControlSpec spec)
    {
        var win = ResolveMeetingWindow();
        if (win is null) return (false, "not in a meeting");

        // A flyout left open by a previous action, or by the user, hides the
        // toolbar. Clear it first so a key press is never a no-op.
        if (!IsToolbarVisible(win)) RecoverFromOpenFlyout(win);

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

        AutomationElement? item = null;
        try
        {
            // Background-effect menus are large and populate lazily, so allow
            // a little longer than a simple reaction flyout.
            item = FindInPopup(win, spec.MenuItemAutomationId, spec.MenuItemRegex, 2500);
            if (item is null) return (false, $"item for '{target}' not found in menu");

            // Radio-style menus need the "off" entry to undo the selection.
            if (spec.MenuItemOffRegex is not null && IsChecked(item) == true)
            {
                var offItem = FindInPopup(win, null, spec.MenuItemOffRegex, 800);
                if (offItem is not null) item = offItem;
            }

            if (!TryInvoke(item)) return (false, $"could not invoke item for '{target}'");
            return (true, null);
        }
        finally
        {
            // Always required: the flyout does not close by itself when driven
            // through UI Automation, and leaving it open hides the toolbar.
            DismissFlyout(win, item, host);
        }
    }

    /// <summary>Reads a menu item's checked state, where it exposes one.</summary>
    private static bool? IsChecked(AutomationElement el)
    {
        try
        {
            var toggle = el.Patterns.Toggle.PatternOrDefault;
            if (toggle is not null)
                return toggle.ToggleState.ValueOrDefault == ToggleState.On;
        }
        catch { }
        return null;
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
            : SearchScopes(win);

        var seen = new HashSet<string>();
        AutomationElement? popupAnchor = null;
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
                    popupAnchor ??= e;

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

        if (host is not null) DismissFlyout(win, popupAnchor, host);
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
