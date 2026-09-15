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
        string.IsNullOrWhiteSpace(p) ? null : new Regex(p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, MatchTimeout);

    /// <summary>
    /// These patterns come from selectors.json, which users are invited to edit
    /// to localise the state labels. A pattern that backtracks catastrophically
    /// would otherwise wedge the UIA worker thread with no error at all, so
    /// matching is bounded and a timeout is treated as "did not match".
    /// </summary>
    public static readonly TimeSpan MatchTimeout = TimeSpan.FromMilliseconds(250);

    /// <summary>
    /// Compiles every pattern so a bad one is reported when the file is read,
    /// rather than thrown lazily on each state read forever after.
    /// </summary>
    public string? Validate()
    {
        foreach (var (label, pattern) in new[]
                 {
                     ("activePattern", ActivePattern),
                     ("inactivePattern", InactivePattern),
                     ("menuItemName", MenuItemName),
                     ("menuItemOffName", MenuItemOffName)
                 })
        {
            if (string.IsNullOrWhiteSpace(pattern)) continue;
            try { _ = new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, MatchTimeout); }
            catch (ArgumentException ex) { return $"{label}: {ex.Message}"; }
        }
        return null;
    }
}

public sealed class SelectorConfig
{
    public int Version { get; set; } = 1;
    public string MeetingProbeAutomationId { get; set; } = "microphone-button";

    /// <summary>
    /// Marks the full meeting toolbar. Teams can show more than one meeting
    /// window at once — a compact view alongside the main window — and the
    /// compact one carries a reduced toolbar with no chat or video options. Both
    /// match the probe, so this picks the richer window when there is a choice.
    /// </summary>
    public string FullToolbarAutomationId { get; set; } = "callingButtons-showMoreBtn";

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
    /// <summary>Chromium input target for the meeting window; see InputPoster.</summary>
    private IntPtr _renderWidget;

    /// <summary>
    /// Raised from UI Automation threads when something worth re-reading has
    /// happened. Handlers must do no UIA work themselves — this only nudges the
    /// worker to take a snapshot sooner than its next scheduled poll.
    /// </summary>
    public event Action? Hint;

    /// <summary>When set, every event that fires is logged to stderr.</summary>
    public bool DebugEvents { get; set; }

    /// <summary>
    /// When false, no UI Automation subscriptions are made and polling carries
    /// everything. Used to attribute cost between the two approaches.
    /// </summary>
    public bool UseEvents { get; set; } = true;

    private int _hintCount;

    private void RaiseHint(string source)
    {
        var n = Interlocked.Increment(ref _hintCount);
        if (DebugEvents) Console.Error.WriteLine($"uia-event #{n} from {source}");
        Hint?.Invoke();
    }

    /// <summary>Property-change subscriptions on the currently cached controls.</summary>
    private readonly List<(AutomationElement Element, FlaUI.Core.EventHandlers.PropertyChangedEventHandlerBase Handler)> _propertyHandlers = new();
    private bool _windowWatchRegistered;
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

    /// <summary>When a meeting marker was last seen, used to ride out flyouts.</summary>
    private long _markersSeenAt;

    /// <summary>
    /// How long a meeting window stays "in a meeting" after its markers vanish.
    /// The background-effects flyout replaces the entire tree with its own
    /// contents, so none of the markers are present while it is open — without
    /// this, every key would dim whenever a menu was up.
    /// </summary>
    private const int MarkerGraceMs = 15_000;

    public TeamsClient(SelectorConfig config, bool restoreFocus = true)
    {
        _config = config;
        _restoreFocus = restoreFocus;
    }

    /// <summary>
    /// Subscribes to UI Automation events so polling can be reduced to a
    /// backstop.
    ///
    /// Verified to fire for Teams: a window opening anywhere on the desktop, and
    /// the accessible name of a meeting control changing — which is exactly the
    /// mute/camera state signal. Polling is kept, slowly, because a missed event
    /// would otherwise strand the keys.
    /// </summary>
    private void EnsureWindowWatch()
    {
        if (!UseEvents || _windowWatchRegistered) return;
        try
        {
            _automation.GetDesktop().RegisterAutomationEvent(
                _automation.EventLibrary.Window.WindowOpenedEvent,
                TreeScope.Subtree,
                (_, _) => RaiseHint("window-opened"));
            _windowWatchRegistered = true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"window event subscription failed, polling only: {ex.Message}");
        }
    }

    /// <summary>Watches the controls whose label carries state.</summary>
    private void WatchControl(AutomationElement el)
    {
        if (!UseEvents) return;
        try
        {
            var handler = el.RegisterPropertyChangedEvent(
                TreeScope.Element,
                (_, _, _) => RaiseHint("name-changed"),
                _automation.PropertyLibrary.Element.Name);
            _propertyHandlers.Add((el, handler));
        }
        catch
        {
            // Not fatal: the backstop poll still picks the change up.
        }
    }

    private void ClearControlWatches()
    {
        foreach (var (el, handler) in _propertyHandlers)
        {
            try { el.FrameworkAutomationElement.UnregisterPropertyChangedEventHandler(handler); }
            catch { }
        }
        _propertyHandlers.Clear();
    }

    public void Dispose()
    {
        ClearControlWatches();
        try { _automation.UnregisterAllEvents(); } catch { }
        _automation.Dispose();
    }

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

    private static readonly Dictionary<int, bool> TeamsPidCache = new();
    private static long _pidCacheStamp;

    /// <summary>
    /// Teams windows already checked and found not to host a meeting: handle
    /// mapped to when it was checked and the window title at that time.
    ///
    /// A failed search is the expensive case — UIA walks the entire subtree
    /// before giving up, and the chat window holds hundreds of elements. Joining
    /// a meeting opens a new window, so an unseen window is always searched at
    /// once. A cached window is re-searched when its title changes, which is
    /// what happens if a meeting does start inside an existing window, and
    /// otherwise only occasionally as a backstop.
    /// </summary>
    private readonly Dictionary<IntPtr, (long CheckedAt, string Title)> _nonMeetingWindows = new();

    private const int NonMeetingRecheckMs = 8_000;

    /// <summary>True when the cached window carries the full meeting toolbar.</summary>
    private bool _meetingWindowIsFull;

    private long _lastUpgradeCheck;
    private const int UpgradeCheckMs = 5_000;

    /// <summary>When the wider marker scan last ran; see ResolveMeetingWindow.</summary>
    private long _lastDeepScan;
    private const int DeepScanIntervalMs = 10_000;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, char[] buffer, int count);

    /// <summary>Win32 window title. Far cheaper than reading the UIA Name property.</summary>
    private static string TitleOf(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return "";
        var buffer = new char[512];
        var length = GetWindowTextW(hwnd, buffer, buffer.Length);
        return length > 0 ? new string(buffer, 0, length) : "";
    }

    private static IntPtr HandleOf(AutomationElement el)
    {
        try { return new IntPtr(el.Properties.NativeWindowHandle.Value.ToInt64()); }
        catch { return IntPtr.Zero; }
    }

    private bool IsFullToolbar(AutomationElement win)
    {
        if (string.IsNullOrEmpty(_config.FullToolbarAutomationId)) return true;
        return FindById(win, _config.FullToolbarAutomationId) is not null;
    }

    /// <summary>
    /// Swaps a compact meeting window for the full one if it is available.
    /// Returns true when the cached window changed.
    /// </summary>
    private bool TryUpgradeMeetingWindow()
    {
        AutomationElement[] children;
        try { children = _automation.GetDesktop().FindAllChildren(); }
        catch { return false; }

        foreach (var w in children)
        {
            if (!IsTeams(w)) continue;
            if (Equals(w, _meetingWindow)) continue;
            try
            {
                if (FindById(w, _config.MeetingProbeAutomationId) is null) continue;
                if (!IsFullToolbar(w)) continue;

                _meetingWindow = w;
                _meetingWindowIsFull = true;
                _cache.Clear();
                ClearControlWatches();
                _renderWidget = FindRenderWidget(w);
                return true;
            }
            catch { }
        }
        return false;
    }

    private static bool IsTeams(AutomationElement el)
    {
        int pid;
        try { pid = el.Properties.ProcessId.Value; }
        catch { return false; }

        // Process lookups are not free and the desktop is rescanned whenever no
        // meeting is cached, so the answer is remembered briefly.
        var now = Environment.TickCount64;
        if (now - _pidCacheStamp > 10_000)
        {
            TeamsPidCache.Clear();
            _pidCacheStamp = now;
        }

        if (TeamsPidCache.TryGetValue(pid, out var known)) return known;

        bool isTeams;
        try
        {
            using var p = Process.GetProcessById(pid);
            isTeams = string.Equals(p.ProcessName, "ms-teams", StringComparison.OrdinalIgnoreCase);
        }
        catch { isTeams = false; }

        TeamsPidCache[pid] = isTeams;
        return isTeams;
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
        if (IsAlive(_meetingWindow))
        {
            // The cheap cached-probe check covers the common case; the fuller
            // marker scan only runs when a flyout has hidden the toolbar.
            if (IsToolbarVisible(_meetingWindow!) || HasAnyMarker(_meetingWindow!))
            {
                _markersSeenAt = Environment.TickCount64;
                // The render widget can be recreated while the window lives on.
                if (_renderWidget == IntPtr.Zero) _renderWidget = FindRenderWidget(_meetingWindow!);

                // Sitting on a compact window costs real controls, so look for a
                // fuller one now and then rather than staying stuck on it.
                if (!_meetingWindowIsFull
                    && Environment.TickCount64 - _lastUpgradeCheck > UpgradeCheckMs)
                {
                    _lastUpgradeCheck = Environment.TickCount64;
                    if (TryUpgradeMeetingWindow()) return _meetingWindow;
                }

                return _meetingWindow;
            }

            // An open flyout can hide every marker; hold the meeting briefly
            // rather than reporting that it ended.
            if (Environment.TickCount64 - _markersSeenAt < MarkerGraceMs) return _meetingWindow;
        }

        _meetingWindow = null;
        _renderWidget = IntPtr.Zero;
        _cache.Clear();
        ClearControlWatches();
        EnableAccessibility();
        EnsureWindowWatch();

        AutomationElement[] children;
        try { children = _automation.GetDesktop().FindAllChildren(); }
        catch { return null; }

        var now = Environment.TickCount64;
        AutomationElement? fallback = null;
        IntPtr fallbackHwnd = IntPtr.Zero;

        foreach (var w in children)
        {
            if (!IsTeams(w)) continue;

            var hwnd = HandleOf(w);
            var title = TitleOf(hwnd);

            // Skip only if this window was already ruled out, recently, and has
            // not been renamed since. A window that starts hosting a meeting
            // changes its title, so that case is picked up immediately rather
            // than waiting for the backstop re-check.
            if (hwnd != IntPtr.Zero
                && _nonMeetingWindows.TryGetValue(hwnd, out var seen)
                && now - seen.CheckedAt < NonMeetingRecheckMs
                && string.Equals(seen.Title, title, StringComparison.Ordinal))
            {
                continue;
            }

            try
            {
                // Discovery probes for the toolbar only. Searching every marker
                // here meant four full descendant walks per Teams window - and
                // the chat window alone holds hundreds of elements - on every
                // poll while no meeting was running. The wider marker set is
                // still used on the cached window, where flyouts matter.
                if (FindById(w, _config.MeetingProbeAutomationId) is null)
                {
                    if (hwnd != IntPtr.Zero) _nonMeetingWindows[hwnd] = (now, title);
                    continue;
                }

                // Teams can show a compact meeting window alongside the full
                // one; both match the probe but the compact toolbar is missing
                // chat and the video options, so prefer the full window.
                if (!IsFullToolbar(w))
                {
                    fallback ??= w;
                    fallbackHwnd = hwnd;
                    continue;
                }

                _meetingWindow = w;
                _meetingWindowIsFull = true;
                _markersSeenAt = now;
                _renderWidget = FindRenderWidget(w);
                if (hwnd != IntPtr.Zero) _nonMeetingWindows.Remove(hwnd);
                return w;
            }
            catch { /* window died mid-walk */ }
        }

        if (fallback is not null)
        {
            _meetingWindow = fallback;
            _meetingWindowIsFull = false;
            _markersSeenAt = now;
            _renderWidget = FindRenderWidget(fallback);
            if (fallbackHwnd != IntPtr.Zero) _nonMeetingWindows.Remove(fallbackHwnd);
            return fallback;
        }

        // An open flyout removes the whole toolbar from the tree, leaving only
        // the flyout's own buttons, so the cheap probe finds nothing. A running
        // sidecar rides that out on its cached window, but one that *starts*
        // while a flyout is open has no cache and would report no meeting until
        // the flyout closed.
        //
        // Fall back to the wider marker set, which includes the flyout buttons.
        // Only when nothing else matched, and not on every poll: a failed search
        // walks an entire window subtree, and this is the idle path.
        if (Environment.TickCount64 - _lastDeepScan > DeepScanIntervalMs)
        {
            _lastDeepScan = Environment.TickCount64;

            foreach (var w in children)
            {
                if (!IsTeams(w)) continue;
                try
                {
                    if (!HasAnyMarker(w)) continue;

                    _meetingWindow = w;
                    _meetingWindowIsFull = IsFullToolbar(w);
                    _markersSeenAt = now;
                    _renderWidget = FindRenderWidget(w);

                    var found = HandleOf(w);
                    if (found != IntPtr.Zero) _nonMeetingWindows.Remove(found);
                    return w;
                }
                catch { /* window died mid-walk */ }
            }
        }

        // Drop entries for windows that have since closed.
        if (_nonMeetingWindows.Count > 16) _nonMeetingWindows.Clear();

        _lastStates.Clear();
        return null;
    }

    private static IntPtr FindRenderWidget(AutomationElement window)
    {
        try
        {
            var hwnd = new IntPtr(window.Properties.NativeWindowHandle.Value.ToInt64());
            return InputPoster.FindRenderWidget(hwnd);
        }
        catch { return IntPtr.Zero; }
    }

    /// <summary>True when the meeting toolbar itself is reachable, i.e. no flyout is covering it.</summary>
    /// <summary>
    /// True when the meeting toolbar itself is reachable, i.e. no flyout is
    /// covering it.
    ///
    /// The probe element is cached: a live UIA element throws once it leaves the
    /// tree, which is exactly the signal needed, and checking it costs one
    /// property read instead of a full descendant walk on every poll.
    /// </summary>
    private bool IsToolbarVisible(AutomationElement win)
    {
        const string cacheKey = "probe";
        if (_cache.TryGetValue(cacheKey, out var probe) && IsAlive(probe)) return true;
        _cache.Remove(cacheKey);

        var el = FindById(win, _config.MeetingProbeAutomationId);
        if (el is null) return false;

        _cache[cacheKey] = el;
        return true;
    }

    private AutomationElement? ResolveControl(string key, ControlSpec spec)
    {
        if (_cache.TryGetValue(key, out var cached) && IsAlive(cached)) return cached;
        _cache.Remove(key);

        var win = ResolveMeetingWindow();
        if (win is null) return null;

        var el = FindById(win, spec.AutomationId);
        if (el is null) return null;

        _cache[key] = el;

        // The label is the state, so a change to it is the event worth waking for.
        if (spec.ActiveRegex is not null || spec.InactiveRegex is not null) WatchControl(el);
        return el;
    }

    /// <summary>
    /// Resolves a flyout's trigger button, cached like any other control.
    /// Without this the poll walked the tree once per menu-nested control.
    /// </summary>
    private AutomationElement? ResolveMenuHost(AutomationElement win, string menuId)
    {
        var cacheKey = $"menu:{menuId}";
        if (_cache.TryGetValue(cacheKey, out var cached) && IsAlive(cached)) return cached;
        _cache.Remove(cacheKey);

        var el = FindById(win, menuId);
        if (el is not null) _cache[cacheKey] = el;
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

        if (SafeMatch(spec.ActiveRegex, name)) return true;
        if (SafeMatch(spec.InactiveRegex, name)) return false;
        return null;
    }

    /// <summary>
    /// A user-supplied pattern that backtracks badly hits its match timeout; a
    /// key that fails to report state is a far better outcome than a worker
    /// thread stuck on one regex.
    /// </summary>
    private static bool SafeMatch(Regex? rx, string value)
    {
        if (rx is null) return false;
        try { return rx.IsMatch(value); }
        catch (RegexMatchTimeoutException)
        {
            Console.Error.WriteLine($"selector pattern timed out against '{value}'; treating as no match");
            return false;
        }
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

        // The seven menu-nested controls share just two menus, so each menu is
        // located once per snapshot rather than once per control. Resolving them
        // individually cost seven full tree walks every poll.
        var menuAvailable = new Dictionary<string, bool>(StringComparer.Ordinal);

        foreach (var (key, spec) in _config.Controls)
        {
            // Menu-nested controls (reactions, hand, blur) are not readable
            // without opening their flyout, so only report availability.
            if (!string.IsNullOrEmpty(spec.Menu))
            {
                if (!menuAvailable.TryGetValue(spec.Menu!, out var menuOk))
                {
                    var host = ResolveMenuHost(win, spec.Menu!);
                    menuOk = host is not null && SafeEnabled(host);
                    menuAvailable[spec.Menu!] = menuOk;
                }
                snap.Available[key] = menuOk;
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

    /// <summary>
    /// Presses a control. A posted click is tried first because UIA's Invoke
    /// activates the Teams window; Invoke remains the fallback for cases where
    /// the element has no on-screen bounds, such as a minimised window.
    /// </summary>
    private bool Press(AutomationElement el)
    {
        if (InputPoster.TryClick(_renderWidget, el)) return true;

        // The fallback activates the Teams window, so it is worth knowing about.
        Console.Error.WriteLine("posted click unavailable; falling back to UIA Invoke (window will activate)");
        return TryInvoke(el);
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

    private bool ExpandMenu(AutomationElement host)
    {
        // Same reasoning as Press: posting avoids activating the window, which
        // also means the flyout opens behind whatever the user is working in.
        if (InputPoster.TryClick(_renderWidget, host)) return true;

        Console.Error.WriteLine("posted click unavailable for menu; falling back to UIA Expand (window will activate)");
        return TryExpand(host);
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
    private void DismissFlyout(
        AutomationElement win,
        AutomationElement? anchor,
        AutomationElement? host,
        (int x, int y)? hostPoint = null)
    {
        // A posted click behaves like a real one, so selecting an item usually
        // closes the flyout by itself. Give it time to settle before doing
        // anything: clicking the menu button again while it is already closing
        // would re-open it, and the next key press would then just close it
        // instead of acting.
        if (WaitForToolbar(win, 1500)) return;

        // Clicking the menu button again toggles the flyout shut. Its screen
        // position was captured before opening, because the toolbar leaves the
        // accessibility tree while a popup is up.
        if (hostPoint is { } p && InputPoster.TryClickPoint(_renderWidget, p.x, p.y))
        {
            if (WaitForToolbar(win, 900)) return;
        }

        // Otherwise click an inert spot inside the meeting window, which is what
        // dismisses a popup normally.
        if (TryClickAway(win))
        {
            if (WaitForToolbar(win, 900)) return;
        }

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

    /// <summary>
    /// Clicks an inert point inside the meeting window to dismiss a popup.
    ///
    /// This used to click the horizontal centre, 80px down. In the current Teams
    /// the meeting toolbar is centred along the top, so that point landed inside
    /// `reaction-menu-button` and *re-opened* the flyout it was meant to close,
    /// leaving the toolbar out of the tree and breaking the next action. The
    /// middle of the window is no better: it is the participant tile, and
    /// clicking it opens a profile card over the meeting.
    ///
    /// So candidates sit in the quiet corners of the content area, and each is
    /// checked against the controls actually on screen rather than assumed to be
    /// empty.
    /// </summary>
    private bool TryClickAway(AutomationElement win)
    {
        try
        {
            var r = win.BoundingRectangle;
            if (r.Width <= 0 || r.Height <= 0) return false;

            // Well inside the content area: a few pixels from the border falls on
            // the window frame, where a click never reaches the web content and
            // so dismisses nothing. These avoid the toolbar row along the top and
            // the participant tile in the middle.
            int AtX(double f) => r.X + (int)(r.Width * f);
            int AtY(double f) => r.Y + (int)(r.Height * f);

            var candidates = new (int X, int Y)[]
            {
                (AtX(0.12), AtY(0.80)),
                (AtX(0.88), AtY(0.80)),
                (AtX(0.12), AtY(0.28)),
                (AtX(0.88), AtY(0.28)),
                (AtX(0.50), AtY(0.93))
            };
            var occupied = ClickableBounds(win);

            foreach (var (x, y) in candidates)
            {
                if (occupied.Any(b => b.Contains(x, y))) continue;
                if (InputPoster.TryClickPoint(_renderWidget, x, y)) return true;
            }

            return false;
        }
        catch { return false; }
    }

    /// <summary>Bounds of everything currently clickable in the window.</summary>
    private static List<System.Drawing.Rectangle> ClickableBounds(AutomationElement win)
    {
        var bounds = new List<System.Drawing.Rectangle>();
        try
        {
            var found = win.FindAllDescendants(cf =>
                cf.ByControlType(ControlType.Button)
                    .Or(cf.ByControlType(ControlType.MenuItem))
                    .Or(cf.ByControlType(ControlType.ListItem))
                    .Or(cf.ByControlType(ControlType.CheckBox))
                    .Or(cf.ByControlType(ControlType.RadioButton)));

            foreach (var e in found)
            {
                try
                {
                    var r = e.BoundingRectangle;
                    if (r.Width > 0 && r.Height > 0) bounds.Add(r);
                }
                catch { }
            }
        }
        catch { }

        return bounds;
    }

    /// <summary>Lists what is currently reachable, for diagnosing a missed menu item.</summary>
    private string DescribePopup(AutomationElement win)
    {
        var parts = new List<string>();
        try
        {
            foreach (var scope in SearchScopes(win))
            {
                foreach (var c in scope.FindAllDescendants(cf =>
                    cf.ByControlType(ControlType.Button).Or(cf.ByControlType(ControlType.CheckBox))))
                {
                    var id = c.Properties.AutomationId.ValueOrDefault ?? "";
                    var name = NameOf(c);
                    if (id.Length == 0 && name.Length == 0) continue;
                    parts.Add($"{id}|{name}");
                    if (parts.Count >= 12) return string.Join(", ", parts) + ", ...";
                }
            }
        }
        catch { }
        return string.Join(", ", parts);
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
            return Press(el) ? (true, null) : (false, $"could not invoke '{target}'");
        }

        // Flyout-nested control: open the menu, click the item, make sure it closed.
        var host = FindById(win, spec.Menu!);
        if (host is null) return (false, $"menu '{spec.Menu}' not found");

        // Captured before opening: once the flyout is up, Teams removes the
        // toolbar from the tree and the host can no longer be located.
        var hostPoint = CentreOf(host);

        if (!ExpandMenu(host)) return (false, $"could not open menu '{spec.Menu}'");
        var expanded = true;

        AutomationElement? item = null;
        try
        {
            // Background-effect menus are large and populate lazily, so allow
            // a little longer than a simple reaction flyout.
            item = FindInPopup(win, spec.MenuItemAutomationId, spec.MenuItemRegex, 2500);

            // If the toolbar is still showing, the menu never opened. Teams
            // swallows exactly one click on the trigger after a previous
            // selection — including one the user made by hand — so pressing it
            // again opens it.
            if (item is null && IsToolbarVisible(win))
            {
                Console.Error.WriteLine($"menu '{spec.Menu}' did not open; pressing it again");
                Thread.Sleep(200);
                if (ExpandMenu(host))
                {
                    item = FindInPopup(win, spec.MenuItemAutomationId, spec.MenuItemRegex, 2000);
                }
            }

            if (item is null)
            {
                Console.Error.WriteLine(
                    $"item for '{target}' not found. toolbarVisible={IsToolbarVisible(win)} " +
                    $"expandedOk={expanded} candidates=[{DescribePopup(win)}]");
                return (false, $"item for '{target}' not found in menu");
            }

            // Radio-style menus need the "off" entry to undo the selection.
            if (spec.MenuItemOffRegex is not null && IsChecked(item) == true)
            {
                var offItem = FindInPopup(win, null, spec.MenuItemOffRegex, 800);
                if (offItem is not null) item = offItem;
            }

            if (!Press(item)) return (false, $"could not invoke item for '{target}'");

            // Two problems, one fix. The flyout does not reliably close on its
            // own, and after a selection Teams swallows the next click on that
            // menu button. A click on inert space dismisses the popup and clears
            // the suppression, so the following press works first time instead
            // of needing the retry below.
            Thread.Sleep(200);
            TryClickAway(win);
            return (true, null);
        }
        finally
        {
            // Always required: the flyout does not reliably close by itself, and
            // leaving it open hides the toolbar.
            DismissFlyout(win, item, host, hostPoint);
        }
    }

    private static (int x, int y)? CentreOf(AutomationElement el)
    {
        try
        {
            var r = el.BoundingRectangle;
            if (r.Width <= 0 || r.Height <= 0) return null;
            return (r.X + r.Width / 2, r.Y + r.Height / 2);
        }
        catch { return null; }
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
