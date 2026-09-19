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

    /// <summary>
    /// Accessible name, for the rare control Teams ships without an
    /// AutomationId. Only the confirmation dialog's buttons are like this, and
    /// they exist solely while that dialog is up, so a name is all there is to
    /// match on. Localised, like <see cref="OffName"/> and the state patterns.
    /// </summary>
    public string? Name { get; set; }

    /// <summary>
    /// Restricts a <see cref="Name"/> lookup to inside a popup window whose
    /// class contains this, so "Stop presenting" cannot match a toolbar button
    /// that happens to share the label.
    /// </summary>
    public string? WithinClass { get; set; }

    /// <summary>
    /// True for a control that can only be pressed, never reported on: it has
    /// no AutomationId and is found by name inside a transient dialog.
    /// </summary>
    public bool IsPressOnly => string.IsNullOrEmpty(AutomationId) && !string.IsNullOrEmpty(Name);

    public string? Menu { get; set; }

    /// <summary>
    /// Trigger for a nested menu inside <see cref="Menu"/>, opened before the
    /// item is looked for. PowerPoint Live's slide translation lives two levels
    /// down — "Change view" then "Translate slides" — which no meeting-toolbar
    /// control needed.
    /// </summary>
    public string? Submenu { get; set; }

    public string? MenuItemAutomationId { get; set; }

    /// <summary>
    /// Id the same menu item takes in its opposite state, for entries Teams
    /// swaps rather than checks. "Hide presenter view" is replaced outright by
    /// "Show presenter view", so a key that only knew one id would work once
    /// and then fail.
    /// </summary>
    public string? MenuItemToggleAutomationId { get; set; }

    public string? MenuItemName { get; set; }

    /// <summary>
    /// Restricts a control to one PowerPoint Live role, "presenter" or
    /// "attendee". "Take control" only exists for an attendee and the
    /// annotation tools only for a presenter, so a key for the wrong role is
    /// reported unavailable rather than left looking live.
    /// </summary>
    public string? RequiresRole { get; set; }
    /// <summary>
    /// Item to click when the primary menu item is already checked. Background
    /// effects are a radio group rather than a toggle: clicking "Standard blur"
    /// again leaves blur on, so turning it off means clicking "No background
    /// effect" instead.
    /// </summary>
    public string? MenuItemOffName { get; set; }
    public string? ActivePattern { get; set; }
    public string? InactivePattern { get; set; }

    /// <summary>
    /// Reads state from the element's UI Automation selection instead of its
    /// name. The PowerPoint Live drawing tools are a single-select list, so
    /// "which tool is active" is exposed properly — and, unlike a name pattern,
    /// locale-independently.
    /// </summary>
    public bool StateFromSelection { get; set; }

    /// <summary>
    /// Matches <see cref="ActivePattern"/> and <see cref="InactivePattern"/>
    /// against the element's FullDescription rather than its name.
    ///
    /// For buttons whose label never changes and whose state lives only in the
    /// tooltip: "Private view" stays "Private view" either way, while its
    /// description switches between allowing and preventing. Chromium publishes
    /// the tooltip there, so it reads without hovering. Localised, like the name
    /// patterns it reuses.
    /// </summary>
    public bool StateFromFullDescription { get; set; }

    /// <summary>
    /// An element whose mere presence means this control is currently on.
    ///
    /// Some Teams controls expose no state at all, only a consequence: grid
    /// view is an overlay that replaces the slide surface, and presenter view
    /// is simply whether the notes pane exists. Both are reliable, and both are
    /// locale-independent.
    /// </summary>
    public string? ActiveWhenPresentAutomationId { get; set; }

    /// <summary>
    /// What to press to turn the control back off, when that is a different
    /// element from the one that turned it on. Grid view opens from the slide
    /// toolbar but closes from a button inside the overlay it opened — and that
    /// button carries no AutomationId, only a name.
    /// </summary>
    public string? OffAutomationId { get; set; }
    public string? OffName { get; set; }

    /// <summary>
    /// Marks a control as living inside the slide-show subtree rather than on
    /// the meeting toolbar.
    ///
    /// That subtree is not always in the accessibility tree: Teams unmounts the
    /// whole thing while the presentation is idle — measured absent for 12 of
    /// 40 seconds on a live meeting — and rebuilds it on interaction. Controls
    /// marked this way keep their last known availability across those gaps
    /// instead of blinking out, which is what made every key flicker.
    /// </summary>
    public string? Surface { get; set; }

    /// <summary>
    /// Reads the tool's ink colour out of its accessible name, which is where
    /// Teams puts it ("Pen: Light blue, Thickness 3"), so a key can be drawn in
    /// the colour the tool will actually draw in.
    /// </summary>
    public bool ColorFromName { get; set; }

    private Regex? _off;
    public Regex? OffRegex => _off ??= Compile(OffName);

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
                     ("menuItemOffName", MenuItemOffName),
                     ("offName", OffName)
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

    /// <summary>
    /// How to recognise a PowerPoint Live presentation and read what it is
    /// showing. Separate from <see cref="Controls"/> because this is context
    /// rather than something that can be pressed.
    /// </summary>
    public PowerPointLiveSpec PowerPointLive { get; set; } = new();

    public Dictionary<string, ControlSpec> Controls { get; set; } = new();
}

/// <summary>
/// Locates the PowerPoint Live surface inside a meeting window and reads the
/// context the keys need: which role the user has, which slide is showing, and
/// which deck is being presented.
///
/// PowerPoint Live renders as an embedded document rather than part of the
/// meeting toolbar, so none of the meeting-control selectors reach it.
/// </summary>
public sealed class PowerPointLiveSpec
{
    /// <summary>Root of the embedded slide-show app; its presence is the signal.</summary>
    public string RootAutomationId { get; set; } = "ppt-previewer-root";

    /// <summary>Toolbar holding slide navigation and the view options.</summary>
    public string ToolbarAutomationId { get; set; } = "slideShowToolbarId";

    /// <summary>Carries the current slide in its accessible name.</summary>
    public string SlideContainerAutomationId { get; set; } = "slideshow-app-container";

    /// <summary>
    /// Role markers on the meeting toolbar. Only one can exist at a time — you
    /// can stop a share you are giving, or ask for control of one you are not —
    /// which makes them the authoritative answer, and the one that survives
    /// both the grid overlay and presenter view being hidden.
    /// </summary>
    public string PresenterMarkerAutomationId { get; set; } = "stopPresentingPptBtn";
    public string AttendeeMarkerAutomationId { get; set; } = "takeControlPptBtn";

    /// <summary>
    /// Fallback role detection, used only when neither marker is offered.
    ///
    /// Not the primary signal, despite looking like one: the class tracks the
    /// current view mode rather than the role, and flips to the attendee value
    /// when a presenter hides their own notes and thumbnails.
    /// </summary>
    public string PresenterClassPattern { get; set; } = @"slideshow-app-presenter-role";
    public string AttendeeClassPattern { get; set; } = @"slideshow-app-attendee-role";

    /// <summary>Matches the "3 of 19" counter in the toolbar. Group 1 is the slide, group 2 the total.</summary>
    public string SlidePositionPattern { get; set; } = @"^\s*(\d+)\s*(?:of|/)\s*(\d+)\s*$";

    /// <summary>
    /// The grid-of-thumbnails overlay.
    ///
    /// Opening it replaces the entire slide-show subtree: the root, the
    /// toolbar and every control disappear from the tree. Without knowing
    /// about it the plugin would decide the presentation had ended and dim
    /// every key — including the one key that closes the grid again.
    /// </summary>
    public string GridViewAutomationId { get; set; } = "fluent-grid-view";

    /// <summary>Strips Teams' wrapper off the document title to leave the file name.</summary>
    public string DeckTitlePattern { get; set; } = @"^\s*SlideShow\s*[-–]\s*(.+?)\s*$";

    /// <summary>
    /// Pulls the ink colour out of a drawing tool's accessible name: the part
    /// after the colon and before any thickness. "Pen: Light blue, Thickness 3"
    /// gives "Light blue". Localised, like the name it reads.
    /// </summary>
    public string ToolColorPattern { get; set; } = @"^[^:]+:\s*([^,]+?)\s*(?:,|$)";

    /// <summary>
    /// Pulls the ink thickness out of the same accessible name the colour comes
    /// from: "Pen: Light blue, Thickness 3" gives 3. Localised, like the name it
    /// reads. Only the pen and highlighter carry one; the laser has a colour and
    /// no thickness.
    /// </summary>
    public string ToolThicknessPattern { get; set; } = @"Thickness\s*(\d+)";

    /// <summary>
    /// Name of the thickness slider inside a drawing tool's flyout.
    ///
    /// Matched on the name and never on the AutomationId, which Teams generates
    /// per render - the same slider came back as "slider-r1g" under the pen and
    /// "slider-r1j" under the highlighter.
    /// </summary>
    public string InkThicknessPattern { get; set; } = @"^\s*Ink thickness\s*$";

    /// <summary>
    /// The ink colours offered in a drawing tool's flyout, which is the only
    /// place the chosen colour can be read while that flyout is open: opening it
    /// removes the tool button itself from the tree, taking its name — and with
    /// it the colour — along.
    ///
    /// The union of all three palettes, captured from a live presenter session.
    /// They differ: the pen offers dark and magenta shades the highlighter does
    /// not, the highlighter offers "Faded" and "Yellow" the pen does not, and
    /// the laser offers only six. The swatches carry no automation id, so their
    /// names are the only handle on them.
    ///
    /// A list rather than "whichever swatch is selected" because the pen's
    /// flyout also carries the laser pointer's arrow options, and one of those
    /// always reports itself as selected too. Localised, like the names it
    /// matches.
    /// </summary>
    public string[] InkColorNames { get; set; } =
    {
        "Black", "Blue", "Dark purple", "Dark red", "Dark yellow", "Faded blue",
        "Faded green", "Faded red", "Gray", "Green", "Light blue", "Light gray",
        "Light green", "Light orange", "Magenta", "Orange", "Pink", "Purple",
        "Red", "Yellow"
    };

    /// <summary>
    /// Name of the surface whose controls come and go with the slide-show
    /// subtree; matched against <see cref="ControlSpec.Surface"/>.
    /// </summary>
    public string SlideShowSurface { get; set; } = "slideShow";

    /// <summary>
    /// How long a slide-show control keeps its last known availability after
    /// the subtree vanishes. Comfortably longer than the gaps observed on a
    /// live meeting, and bounded so a presentation that really has ended still
    /// dims the keys.
    /// </summary>
    public int DetachedGraceMs { get; set; } = 30_000;

    /// <summary>
    /// The laser pointer's arrow options, which share the drawing-tool flyout
    /// with the colour swatches and are the reason a colour cannot simply be
    /// "the selected radio button": one of these always reports itself selected
    /// too. Localised, like the names they match.
    /// </summary>
    public string ArrowOptionPattern { get; set; } = @"^(No arrow|Single arrow|Double arrows)$";

    private Regex? _arrowOption;
    public Regex? ArrowOptionRegex => _arrowOption ??= Compile(ArrowOptionPattern);

    private Regex? _toolColor;
    public Regex? ToolColorRegex => _toolColor ??= Compile(ToolColorPattern);

    private Regex? _toolThickness;
    public Regex? ToolThicknessRegex => _toolThickness ??= Compile(ToolThicknessPattern);

    private Regex? _inkThickness;
    public Regex? InkThicknessRegex => _inkThickness ??= Compile(InkThicknessPattern);

    private Regex? _presenter;
    private Regex? _attendee;
    private Regex? _position;
    private Regex? _deck;

    public Regex? PresenterRegex => _presenter ??= Compile(PresenterClassPattern);
    public Regex? AttendeeRegex => _attendee ??= Compile(AttendeeClassPattern);
    public Regex? SlidePositionRegex => _position ??= Compile(SlidePositionPattern);
    public Regex? DeckTitleRegex => _deck ??= Compile(DeckTitlePattern);

    private static Regex? Compile(string? p) =>
        string.IsNullOrWhiteSpace(p)
            ? null
            : new Regex(p, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, ControlSpec.MatchTimeout);

    /// <summary>Compiles every pattern up front, matching <see cref="ControlSpec.Validate"/>.</summary>
    public string? Validate()
    {
        foreach (var (label, pattern) in new[]
                 {
                     ("presenterClassPattern", PresenterClassPattern),
                     ("attendeeClassPattern", AttendeeClassPattern),
                     ("slidePositionPattern", SlidePositionPattern),
                     ("deckTitlePattern", DeckTitlePattern),
                     ("toolColorPattern", ToolColorPattern),
                     ("arrowOptionPattern", ArrowOptionPattern)
                 })
        {
            if (string.IsNullOrWhiteSpace(pattern)) continue;
            try { _ = new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, ControlSpec.MatchTimeout); }
            catch (ArgumentException ex) { return $"{label}: {ex.Message}"; }
        }
        return null;
    }
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

    /// <summary>
    /// Last known availability, carried forward while a flyout hides the
    /// toolbar. Without it every key would be reported available during a
    /// flyout, including keys whose control is not present at all.
    /// </summary>
    private readonly Dictionary<string, bool> _lastAvailable = new();

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
    /// <summary>
    /// Subscribes to the properties that carry a control's state, so a change
    /// made in Teams itself is noticed at once rather than at the next poll.
    ///
    /// Watched once per control: re-subscribing on every snapshot leaks
    /// handlers, and a few hundred of them turn every small change into a storm
    /// of redundant re-reads.
    /// </summary>
    private void WatchControl(string key, AutomationElement el, ControlSpec spec)
    {
        if (!UseEvents) return;

        if (_watched.TryGetValue(key, out var existing))
        {
            if (Equals(existing.Element, el)) return;

            try { existing.Element.FrameworkAutomationElement.UnregisterPropertyChangedEventHandler(existing.Handler); }
            catch { }
            _watched.Remove(key);
        }

        try
        {
            // The name carries mute/camera state and, for a drawing tool, its
            // ink colour. Selection carries which tool is in use, and does not
            // touch the name at all — without it, switching tool in Teams was
            // only noticed when the backstop poll came round.
            var properties = spec.StateFromSelection
                ? new[] { _automation.PropertyLibrary.Element.Name, _automation.PropertyLibrary.SelectionItem.IsSelected }
                : new[] { _automation.PropertyLibrary.Element.Name };

            var handler = el.RegisterPropertyChangedEvent(
                TreeScope.Element,
                (_, _, _) => RaiseHint("property-changed"),
                properties);

            _watched[key] = (el, handler);
            _propertyHandlers.Add((el, handler));
        }
        catch
        {
            // Not fatal: the backstop poll still picks the change up.
        }
    }

    /// <summary>Current property subscription per control, so each is watched once.</summary>
    private readonly Dictionary<string, (AutomationElement Element, FlaUI.Core.EventHandlers.PropertyChangedEventHandlerBase Handler)> _watched = new();

    private void ClearControlWatches()
    {
        foreach (var (el, handler) in _propertyHandlers)
        {
            try { el.FrameworkAutomationElement.UnregisterPropertyChangedEventHandler(handler); }
            catch { }
        }
        _propertyHandlers.Clear();
        _watched.Clear();
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

    private static string ClassOf(AutomationElement el)
    {
        try { return el.Properties.ClassName.ValueOrDefault ?? ""; }
        catch { return ""; }
    }

    /// <summary>
    /// Finds a control by accessible name, optionally only inside a popup
    /// window of a given class. Used for the confirmation dialog, whose buttons
    /// carry no AutomationId.
    /// </summary>
    private static AutomationElement? FindByName(AutomationElement scope, string name, string? withinClass)
    {
        try
        {
            if (string.IsNullOrEmpty(withinClass))
                return scope.FindFirstDescendant(cf => cf.ByName(name));

            foreach (var w in scope.FindAllDescendants(cf => cf.ByControlType(ControlType.Window)))
            {
                if (ClassOf(w).IndexOf(withinClass, StringComparison.OrdinalIgnoreCase) < 0) continue;
                var hit = w.FindFirstDescendant(cf => cf.ByName(name));
                if (hit is not null) return hit;
            }
            return null;
        }
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
        if (_index is not null) return _index.ContainsKey(_config.MeetingProbeAutomationId);

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
        // A name-only control is transient - it exists just while its dialog is
        // up - so it is neither indexed nor cached, and is looked up fresh every
        // time it is asked for.
        if (string.IsNullOrEmpty(spec.AutomationId) && !string.IsNullOrEmpty(spec.Name))
        {
            var dlgWin = ResolveMeetingWindow();
            return dlgWin is null ? null : FindByName(dlgWin, spec.Name!, spec.WithinClass);
        }

        // During a snapshot the index has already answered this in one pass.
        if (_index is not null)
        {
            if (!_index.TryGetValue(spec.AutomationId, out var indexed)) return null;

            _cache[key] = indexed;
            if (spec.ActiveRegex is not null || spec.InactiveRegex is not null || spec.StateFromSelection)
                WatchControl(key, indexed, spec);
            return indexed;
        }

        if (_cache.TryGetValue(key, out var cached) && IsAlive(cached)) return cached;
        _cache.Remove(key);

        var win = ResolveMeetingWindow();
        if (win is null) return null;

        // An empty AutomationId matches the first element that has none, which
        // is almost everything. A spec that names nothing findable must resolve
        // to nothing, not to whatever the tree happens to offer - otherwise a
        // mistyped override quietly clicks an unrelated control.
        if (string.IsNullOrEmpty(spec.AutomationId)) return null;

        var el = FindById(win, spec.AutomationId);
        if (el is null) return null;

        _cache[key] = el;

        // The label is the state, so a change to it is the event worth waking for.
        if (spec.ActiveRegex is not null || spec.InactiveRegex is not null || spec.StateFromSelection)
            WatchControl(key, el, spec);
        return el;
    }

    /// <summary>
    /// Resolves a flyout's trigger button, cached like any other control.
    /// Without this the poll walked the tree once per menu-nested control.
    /// </summary>
    private AutomationElement? ResolveMenuHost(AutomationElement win, string menuId)
    {
        if (_index is not null) return _index.GetValueOrDefault(menuId);

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
        if (spec.StateFromSelection)
        {
            try
            {
                var sel = el.Patterns.SelectionItem.PatternOrDefault;
                if (sel is not null) return sel.IsSelected.ValueOrDefault;
            }
            catch { }
            return null;
        }

        // Some buttons keep one label whatever they do and put the state in the
        // tooltip instead. Chromium publishes that as FullDescription, which is
        // readable without hovering - "Private view" is always "Private view",
        // but its description switches between allowing and preventing.
        var text = spec.StateFromFullDescription ? FullDescriptionOf(el) : NameOf(el);
        if (text.Length == 0) return null;

        if (SafeMatch(spec.ActiveRegex, text)) return true;
        if (SafeMatch(spec.InactiveRegex, text)) return false;
        return null;
    }

    private static string FullDescriptionOf(AutomationElement el)
    {
        try { return el.Properties.FullDescription.ValueOrDefault ?? ""; }
        catch { return ""; }
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
            // The pattern and the length, never the value. What was matched
            // against is a control name or a tooltip read out of the meeting
            // window, and this is the one place such text could reach a log.
            Console.Error.WriteLine(
                $"selector pattern /{rx}/ timed out against {value.Length} chars; treating as no match");
            return false;
        }
    }

    /// <summary>
    /// Finds every control a snapshot needs in a single traversal.
    ///
    /// Resolving controls one at a time became catastrophic once PowerPoint
    /// Live arrived. A control that is present can be cached; one that is
    /// absent cannot, so each missing control cost a full descendant walk of a
    /// Teams window — and most PowerPoint controls are absent most of the time.
    /// At thirty-five controls that meant six or more full walks per snapshot,
    /// measured at 2.6 to 8.9 seconds, which is what made the keys feel dead.
    ///
    /// One OR condition over every id answers the whole question in one pass.
    /// </summary>
    private Dictionary<string, AutomationElement> BuildIndex(AutomationElement win)
    {
        var index = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);
        var ids = WantedIds();
        if (ids.Length == 0) return index;

        try
        {
            var found = win.FindAllDescendants(cf =>
            {
                FlaUI.Core.Conditions.ConditionBase condition = cf.ByAutomationId(ids[0]);
                for (var i = 1; i < ids.Length; i++) condition = condition.Or(cf.ByAutomationId(ids[i]));
                return condition;
            });

            foreach (var el in found)
            {
                string id;
                try { id = el.Properties.AutomationId.ValueOrDefault ?? ""; }
                catch { continue; }
                if (id.Length == 0) continue;

                // Teams can carry the same id in more than one view; the first
                // match is the one in the live tree.
                index.TryAdd(id, el);
            }
        }
        catch { }

        return index;
    }

    /// <summary>Every AutomationId a snapshot looks for. Fixed, so built once.</summary>
    private string[] WantedIds()
    {
        if (_wantedIds is not null) return _wantedIds;

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (_, spec) in _config.Controls)
        {
            if (!string.IsNullOrEmpty(spec.AutomationId)) ids.Add(spec.AutomationId);
            if (!string.IsNullOrEmpty(spec.Menu)) ids.Add(spec.Menu!);
            if (!string.IsNullOrEmpty(spec.ActiveWhenPresentAutomationId))
                ids.Add(spec.ActiveWhenPresentAutomationId!);
        }

        var ppt = _config.PowerPointLive;
        foreach (var id in new[]
                 {
                     ppt.RootAutomationId, ppt.ToolbarAutomationId, ppt.SlideContainerAutomationId,
                     ppt.GridViewAutomationId, ppt.PresenterMarkerAutomationId,
                     ppt.AttendeeMarkerAutomationId, _config.MeetingProbeAutomationId
                 })
        {
            if (!string.IsNullOrEmpty(id)) ids.Add(id);
        }

        _wantedIds = ids.ToArray();
        return _wantedIds;
    }

    private string[]? _wantedIds;

    /// <summary>Index for the snapshot in progress; null outside one.</summary>
    private Dictionary<string, AutomationElement>? _index;

    /// <summary>
    /// Reads the PowerPoint Live surface, if one is being presented.
    ///
    /// Returns the role ("presenter" or "attendee") or null when no
    /// presentation is up. Slide position and deck name are written into
    /// <paramref name="context"/> so keys can label themselves.
    ///
    /// Searched across every Teams window rather than just the meeting one,
    /// because "Pop out" moves the shared content into a window of its own.
    /// </summary>
    private string? ReadPowerPointLive(AutomationElement win, Dictionary<string, string> context)
    {
        var ppt = _config.PowerPointLive;

        var root = ResolveCached($"ppt:{ppt.RootAutomationId}", () =>
        {
            foreach (var scope in SearchScopes(win))
            {
                var found = FindById(scope, ppt.RootAutomationId);
                if (found is not null) return found;
            }
            return null;
        });

        string className = "";
        if (root is not null)
        {
            try { className = root.Properties.ClassName.ValueOrDefault ?? ""; }
            catch { className = ""; }
        }

        var grid = FindAnywhere(win, ppt.GridViewAutomationId);

        // The meeting toolbar decides the role, because only one of these two
        // buttons can exist: you can stop a share you are giving, or ask for
        // control of one you are not.
        //
        // The root's CSS class looks like it should answer this and does not.
        // It tracks the VIEW MODE, not the role: hiding presenter view rewrites
        // it from "presenter-role" to "attendee-role" while you are still very
        // much presenting. Trusting it retired every presenter key the moment
        // someone collapsed their notes. The class is kept only as a fallback
        // for the case where neither button is offered.
        var role = FindAnywhere(win, ppt.PresenterMarkerAutomationId) is not null ? "presenter"
            : FindAnywhere(win, ppt.AttendeeMarkerAutomationId) is not null ? "attendee"
            : SafeMatch(ppt.PresenterRegex, className) ? "presenter"
            : SafeMatch(ppt.AttendeeRegex, className) ? "attendee"
            : null;

        if (role is null) return null;

        // Those two buttons are PowerPoint-specific, so the role also proves a
        // deck is up. That matters because the slide-show subtree itself is not
        // dependable: Teams unmounts it while the presentation sits idle, and
        // requiring it here reported the deck as gone several times a minute.
        if (root is not null) _pptSurfaceSeenAt = Environment.TickCount64;

        context["ppt.role"] = role;

        if (grid is not null)
        {
            context["ppt.grid"] = "1";

            // The slide toolbar is gone, but the grid marks the current slide as
            // its selected thumbnail, so the counter keeps working.
            var selected = SelectedGridSlide(grid) ?? _lastSlide;
            if (selected is not null)
            {
                context["ppt.slide"] = selected;
                _lastSlide = selected;
            }
            if (_lastSlideTotal is not null) context["ppt.slides"] = _lastSlideTotal;
            if (_lastDeck is not null) context["ppt.deck"] = _lastDeck;
            return role;
        }

        if (root is null)
        {
            // Live, but the slide-show surface is momentarily not in the tree.
            // Flagged for the control loop below, then removed again: this flaps
            // every few seconds, and leaving it in the published context would
            // change the fingerprint each time and force a full repaint of every
            // key for no visible reason.
            //
            // Everything read from that surface is carried forward. The slide
            // number especially: opening any flyout takes the surface with it,
            // and without this the counter key blanked every time.
            context["ppt.detached"] = "1";
            if (_lastSlide is not null) context["ppt.slide"] = _lastSlide;
            if (_lastSlideTotal is not null) context["ppt.slides"] = _lastSlideTotal;
            if (_lastDeck is not null) context["ppt.deck"] = _lastDeck;
            return role;
        }

        // "Current slide: Slide 3" — the authoritative position, and the one
        // that keeps working when the toolbar auto-hides.
        var container = ResolveCached($"ppt:{ppt.SlideContainerAutomationId}",
            () => FindById(root, ppt.SlideContainerAutomationId));
        if (container is not null)
        {
            var digits = FirstNumber(NameOf(container));
            if (digits is not null)
            {
                context["ppt.slide"] = digits;
                _lastSlide = digits;
            }
        }

        // The toolbar's "3 of 19" counter is the only source for the deck length.
        var toolbar = ResolveCached($"ppt:{ppt.ToolbarAutomationId}",
            () => FindById(root, ppt.ToolbarAutomationId));
        if (toolbar is not null && ppt.SlidePositionRegex is not null)
        {
            try
            {
                foreach (var t in toolbar.FindAllDescendants(cf => cf.ByControlType(ControlType.Text)))
                {
                    Match m;
                    try { m = ppt.SlidePositionRegex.Match(NameOf(t)); }
                    catch (RegexMatchTimeoutException) { continue; }
                    if (!m.Success) continue;

                    context["ppt.slide"] = m.Groups[1].Value;
                    context["ppt.slides"] = m.Groups[2].Value;
                    _lastSlide = m.Groups[1].Value;
                    _lastSlideTotal = m.Groups[2].Value;
                    break;
                }
            }
            catch { }
        }

        var deck = DeckNameFrom(root, ppt);
        if (deck is not null)
        {
            context["ppt.deck"] = deck;
            _lastDeck = deck;
        }

        // The surface can be present while the pieces read from it are not: the
        // toolbar auto-hides, and opening a flyout takes the counter with it.
        // Nothing here ever legitimately goes from known to unknown while a deck
        // is up, so a missing reading means "not visible right now", not "gone" —
        // publish the last one instead of blanking the key.
        if (!context.ContainsKey("ppt.slide") && _lastSlide is not null)
            context["ppt.slide"] = _lastSlide;
        if (!context.ContainsKey("ppt.slides") && _lastSlideTotal is not null)
            context["ppt.slides"] = _lastSlideTotal;
        if (!context.ContainsKey("ppt.deck") && _lastDeck is not null)
            context["ppt.deck"] = _lastDeck;

        return role;
    }

    /// <summary>Slide position, deck length and deck name, carried across the gaps
    /// where the slide-show surface leaves the tree - the grid overlay replacing it,
    /// a flyout opening, or Teams unmounting it while idle.</summary>
    private string? _lastSlide;
    private string? _lastSlideTotal;
    private string? _lastDeck;

    /// <summary>When the slide-show subtree was last actually in the tree.</summary>
    private long _pptSurfaceSeenAt;

    /// <summary>
    /// Finds an element in any Teams window, meeting window first.
    ///
    /// Cached hard, because this is called several times per snapshot — role
    /// markers, the grid overlay, the notes pane — and each miss is a full
    /// descendant walk of a Teams window, which is tens of thousands of
    /// elements and the single most expensive thing this process does.
    ///
    /// Misses are remembered too, on a short timer. Without that, the common
    /// case of "this element legitimately does not exist right now" paid for a
    /// full walk on every poll and made the keys visibly lag.
    /// </summary>
    private AutomationElement? FindAnywhere(AutomationElement win, string automationId)
    {
        if (string.IsNullOrEmpty(automationId)) return null;

        // The snapshot's own index already covers the meeting window.
        if (_index is not null && _index.TryGetValue(automationId, out var indexed)) return indexed;

        var key = $"any:{automationId}";
        if (_cache.TryGetValue(key, out var cached))
        {
            if (IsAlive(cached)) return cached;
            _cache.Remove(key);
        }

        // Inside a snapshot the index is authoritative for the meeting window,
        // so a miss there means absent; only look wider when there is more than
        // one Teams window to look at.
        if (_index is not null && SearchScopes(win).Length <= 1) return null;

        if (_missingUntil.TryGetValue(automationId, out var until) && Environment.TickCount64 < until)
            return null;

        foreach (var scope in SearchScopes(win))
        {
            if (_index is not null && Equals(scope, win)) continue;

            var found = FindById(scope, automationId);
            if (found is null) continue;

            _cache[key] = found;
            _missingUntil.Remove(automationId);
            return found;
        }

        _missingUntil[automationId] = Environment.TickCount64 + MissingRecheckMs;
        return null;
    }

    /// <summary>
    /// How long a failed lookup is trusted before searching again. Short enough
    /// that appearing controls light up promptly, long enough that an absent
    /// one is not re-searched on every poll.
    /// </summary>
    private const int MissingRecheckMs = 1500;

    /// <summary>When each absent element may be looked for again.</summary>
    private readonly Dictionary<string, long> _missingUntil = new();

    /// <summary>The slide number the grid overlay currently has selected.</summary>
    private static string? SelectedGridSlide(AutomationElement grid)
    {
        try
        {
            foreach (var item in grid.FindAllDescendants(cf => cf.ByControlType(ControlType.ListItem)))
            {
                try
                {
                    var sel = item.Patterns.SelectionItem.PatternOrDefault;
                    if (sel is null || !sel.IsSelected.ValueOrDefault) continue;
                    return FirstNumber(NameOf(item));
                }
                catch { }
            }
        }
        catch { }
        return null;
    }

    /// <summary>
    /// The deck's file name, taken from the embedded document's title
    /// ("SlideShow - deck.pptx").
    /// </summary>
    private static string? DeckNameFrom(AutomationElement root, PowerPointLiveSpec ppt)
    {
        try
        {
            var doc = SafeParent(root);
            for (var i = 0; i < 3 && doc is not null; i++)
            {
                var name = NameOf(doc);
                if (ppt.DeckTitleRegex is not null && name.Length > 0)
                {
                    Match m;
                    try { m = ppt.DeckTitleRegex.Match(name); }
                    catch (RegexMatchTimeoutException) { return null; }
                    if (m.Success) return m.Groups[1].Value;
                }
                doc = SafeParent(doc);
            }
        }
        catch { }
        return null;
    }

    /// <summary>First run of digits in a string, e.g. "Current slide: Slide 3" -> "3".</summary>
    private static string? FirstNumber(string value)
    {
        var start = -1;
        for (var i = 0; i < value.Length; i++)
        {
            if (!char.IsAsciiDigit(value[i])) continue;
            start = i;
            var end = i;
            while (end + 1 < value.Length && char.IsAsciiDigit(value[end + 1])) end++;
            return value[start..(end + 1)];
        }
        return null;
    }

    /// <summary>Last ink colour seen per tool, held across the subtree's absences.</summary>
    private readonly Dictionary<string, string> _lastToolColors = new();

    /// <summary>Whether a control lives in the subtree Teams unmounts when idle.</summary>
    private bool IsSlideShowControl(ControlSpec spec) =>
        !string.IsNullOrEmpty(spec.Surface) &&
        string.Equals(spec.Surface, _config.PowerPointLive.SlideShowSurface, StringComparison.OrdinalIgnoreCase);

    /// <summary>Ink colour named by a drawing tool, e.g. "Pen: Light blue, Thickness 3".</summary>
    private string? ToolColorOf(AutomationElement el)
    {
        var rx = _config.PowerPointLive.ToolColorRegex;
        if (rx is null) return null;

        var name = NameOf(el);
        if (name.Length == 0) return null;

        try
        {
            var m = rx.Match(name);
            if (!m.Success) return null;
            var value = m.Groups[1].Value.Trim();
            return value.Length == 0 ? null : value;
        }
        catch (RegexMatchTimeoutException) { return null; }
    }

    /// <summary>
    /// Reads the ink colour out of an open drawing-tool flyout.
    ///
    /// Needed because opening that flyout unmounts the tool button it belongs
    /// to, so the usual source — the button's own name — does not exist at the
    /// moment the colour changes. Teams recolours its toolbar on the click, and
    /// without this the plugin only caught up once the flyout closed.
    ///
    /// Only swatches named as colours count. The same flyout carries the laser
    /// pointer's arrow options, and one of those reports itself selected too, so
    /// "the selected radio button" alone would happily return "No arrow".
    /// </summary>
    private string? SelectedPaletteColor(AutomationElement win)
    {
        var ppt = _config.PowerPointLive;
        var names = ppt.InkColorNames ?? Array.Empty<string>();
        var arrows = ppt.ArrowOptionRegex;

        string? listed = null;
        string? fallback = null;
        var sawArrow = false;

        try
        {
            foreach (var radio in win.FindAllDescendants(cf => cf.ByControlType(ControlType.RadioButton)))
            {
                var name = NameOf(radio).Trim();
                if (name.Length == 0) continue;

                bool isArrow;
                try { isArrow = arrows is not null && arrows.IsMatch(name); }
                catch (RegexMatchTimeoutException) { isArrow = false; }

                if (isArrow) { sawArrow = true; continue; }

                bool selected;
                try { selected = radio.Patterns.SelectionItem.Pattern.IsSelected.ValueOrDefault; }
                catch { continue; }
                if (!selected) continue;

                if (names.Contains(name, StringComparer.OrdinalIgnoreCase)) listed ??= name;
                else fallback ??= name;
            }
        }
        catch { }

        // A known colour is taken at face value. Anything else is only trusted
        // once an arrow option has confirmed this really is a drawing-tool
        // flyout, which covers a colour Teams adds after this list was written.
        // That guard only helps in the pen's flyout — it is the one that carries
        // the arrow options — so the list still has to be kept complete.
        return listed ?? (sawArrow ? fallback : null);
    }

    /// <summary>
    /// Reads the ink colour out of an open drawing-tool flyout and publishes it
    /// against the tool it belongs to, returning that tool's key.
    ///
    /// Called from both snapshot paths because either can be the one running
    /// when a colour changes: opening a PowerPoint flyout leaves the meeting
    /// toolbar in place, while opening a Teams menu does not.
    /// </summary>
    private string? ApplyPaletteColor(MeetingSnapshot snap, AutomationElement win, string? role)
    {
        if (role != "presenter") return null;

        var color = SelectedPaletteColor(win);
        if (color is null) return null;

        var key = SelectedInkToolKey();
        if (key is null) return null;

        snap.InkFlyoutOpen = true;

        // An open palette is proof the deck is still up, so it holds the grace
        // window open. Without this, studying the colours for half a minute
        // dimmed every slide-show key and dropped the colours altogether — the
        // surface has been "missing" the whole time the flyout was up.
        _pptSurfaceSeenAt = Environment.TickCount64;

        snap.Context[$"ppt.color.{key}"] = color;
        _lastToolColors[key] = color;
        return key;
    }

    /// <summary>
    /// The drawing tool a colour change applies to: the selected one. Its own
    /// button is gone while its flyout is open, so this reads the selection that
    /// was true when the flyout opened.
    /// </summary>
    private string? SelectedInkToolKey()
    {
        foreach (var (key, spec) in _config.Controls)
        {
            if (!spec.ColorFromName) continue;
            if (_lastStates.TryGetValue(key, out var on) && on) return key;
        }
        return null;
    }

    /* ------------------------------------------------------------------- *
     * Setting ink colour and thickness
     *
     * Both live in the flyout a drawing tool opens, and both turned out to be
     * proper UI Automation patterns rather than menu items: thickness is a
     * Slider carrying RangeValue over 1..6, and every colour is a RadioButton
     * that can be selected directly. Neither needs a posted click, which is
     * what makes them quick enough to sit under a dial.
     *
     * Only the tools that carry a colour can be opened at all - pen,
     * highlighter and laser have ExpandCollapse, cursor and eraser have Invoke
     * alone - so anything else is refused rather than half-attempted.
     *
     * The palette is per tool and the sets genuinely differ, so the open flyout
     * is always the authority on what the colours are; InkColorNames is a union
     * of them and matches neither exactly.
     * ------------------------------------------------------------------- */

    /// <summary>Targets handled here rather than by a selector in the config.</summary>
    public const string InkColorTarget = "ppt-ink-color";
    public const string InkThicknessTarget = "ppt-ink-thickness";

    /// <summary>The palette last seen for a tool, in the order Teams lays it out.</summary>
    private readonly Dictionary<string, List<string>> _lastPalette = new();

    /// <summary>The element for the drawing tool that is currently selected.</summary>
    private AutomationElement? SelectedInkTool(AutomationElement win, out string? key)
    {
        key = SelectedInkToolKey();
        if (key is null) return null;
        if (!_config.Controls.TryGetValue(key, out var spec) || string.IsNullOrEmpty(spec.AutomationId)) return null;
        return FindAnywhere(win, spec.AutomationId!);
    }

    /// <summary>
    /// Everything an open flyout offers, found in one pass.
    ///
    /// Walking a Teams window is expensive, and this runs while a dial is
    /// waiting on it, so the slider and the swatches are collected together
    /// rather than with a search each. An earlier version polled for them
    /// separately and took long enough that the press timed out.
    /// </summary>
    private (AutomationElement? slider, List<AutomationElement> swatches) ReadInkFlyout(AutomationElement win)
    {
        var arrows = _config.PowerPointLive.ArrowOptionRegex;
        var thickness = _config.PowerPointLive.InkThicknessRegex;

        foreach (var scope in SearchScopes(win))
        {
            AutomationElement[] all;
            try
            {
                all = scope.FindAllDescendants(cf =>
                    cf.ByControlType(ControlType.RadioButton).Or(cf.ByControlType(ControlType.Slider)));
            }
            catch { continue; }

            AutomationElement? slider = null;
            var swatches = new List<AutomationElement>();

            foreach (var e in all)
            {
                ControlType type;
                try { type = e.Properties.ControlType.ValueOrDefault; }
                catch { continue; }

                var name = NameOf(e).Trim();

                if (type == ControlType.Slider)
                {
                    if (slider is null && (thickness is null || SafeMatch(thickness, name))) slider = e;
                    continue;
                }

                if (name.Length == 0) continue;
                // The pen's flyout carries the laser's arrow options too, and
                // they are radio buttons like every swatch here.
                if (SafeMatch(arrows, name)) continue;
                swatches.Add(e);
            }

            if (slider is not null || swatches.Count > 0) return (slider, swatches);
        }

        return (null, new List<AutomationElement>());
    }

    /// <summary>
    /// Opens the selected tool's options, changes one thing, and closes again.
    /// </summary>
    private (bool ok, string? error) AdjustInk(string target, string? arg)
    {
        var win = ResolveMeetingWindow();
        if (win is null) return (false, "not in a meeting");

        var tool = SelectedInkTool(win, out var key);
        if (tool is null || key is null) return (false, "no drawing tool is selected");

        try
        {
            if (tool.Patterns.ExpandCollapse.PatternOrDefault is null)
                return (false, $"'{key}' has no colour or thickness to set");
        }
        catch { return (false, $"'{key}' has no colour or thickness to set"); }

        var startedAt = Environment.TickCount64;

        try
        {
            var wantThickness = target == InkThicknessTarget;
            AutomationElement? slider = null;
            var swatches = new List<AutomationElement>();

            /*
                Expanding is not reliable enough to do once. Teams hides the
                slide-show toolbar when the pointer is away and rebuilds it on
                demand, and the expand can land on a tool that is mid-rebuild
                and quietly do nothing - observed as a flyout that read back
                empty after two and a half seconds of looking. Asking again
                costs one more open and turns an intermittent failure into a
                slower success.
            */
            for (var attempt = 0; attempt < 2 && slider is null && swatches.Count == 0; attempt++)
            {
                if (!TryExpand(tool)) return (false, "could not open the drawing tool's options");

                // The flyout renders after the expand returns, so wait for the
                // part about to be used rather than for a fixed interval - but
                // bounded, because a dial is waiting on the answer.
                for (var i = 0; i < 6; i++)
                {
                    Thread.Sleep(i == 0 ? 250 : 150);
                    (slider, swatches) = ReadInkFlyout(win);
                    if (wantThickness ? slider is not null : swatches.Count > 0) break;
                }
            }

            if (_traceInk)
                Console.Error.WriteLine(
                    $"ink: read flyout in {Environment.TickCount64 - startedAt}ms " +
                    $"(slider={(slider is not null)}, swatches={swatches.Count})");

            return wantThickness ? SetInkThickness(slider, arg) : StepInkColor(swatches, key, arg);
        }
        finally
        {
            var closing = Environment.TickCount64;
            CloseInkFlyout(win, tool);
            if (_traceInk)
                Console.Error.WriteLine(
                    $"ink: closed in {Environment.TickCount64 - closing}ms, {Environment.TickCount64 - startedAt}ms total");
        }
    }

    /// <summary>
    /// Timing for the ink flyout, which is the slowest thing a dial can ask
    /// for. Off unless TEAMSBRIDGE_TRACE_INK is set, because it runs during a
    /// meeting and stderr is a shared channel.
    /// </summary>
    private static readonly bool _traceInk =
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("TEAMSBRIDGE_TRACE_INK"));

    private (bool ok, string? error) SetInkThickness(AutomationElement? slider, string? arg)
    {
        if (slider is null) return (false, "this tool has no thickness");

        var range = slider.Patterns.RangeValue.PatternOrDefault;
        if (range is null) return (false, "the thickness slider cannot be set");

        double min, max, current;
        try
        {
            min = range.Minimum.ValueOrDefault;
            max = range.Maximum.ValueOrDefault;
            current = range.Value.ValueOrDefault;
        }
        catch { return (false, "could not read the thickness slider"); }

        if (max <= min) return (false, "the thickness slider reports no range");

        // Absolute ("4") or relative ("+1", "-2"). A dial sends absolute,
        // because it already knows the value and the user is watching a number.
        var wanted = current;
        var text = (arg ?? "").Trim();
        if (text.StartsWith('+') || text.StartsWith('-'))
        {
            if (int.TryParse(text, out var delta)) wanted = current + delta;
        }
        else if (double.TryParse(text, out var abs))
        {
            wanted = abs;
        }

        wanted = Math.Clamp(Math.Round(wanted), min, max);
        if (Math.Abs(wanted - current) < 0.5) return (true, null);

        try { range.SetValue(wanted); }
        catch (Exception ex) { return (false, $"could not set thickness: {ex.Message}"); }
        return (true, null);
    }

    private (bool ok, string? error) StepInkColor(List<AutomationElement> swatches, string key, string? arg)
    {
        if (swatches.Count == 0) return (false, "this tool has no colours");

        _lastPalette[key] = swatches.Select(s => NameOf(s).Trim()).ToList();

        var at = -1;
        for (var i = 0; i < swatches.Count; i++)
        {
            try
            {
                if (swatches[i].Patterns.SelectionItem.Pattern.IsSelected.ValueOrDefault) { at = i; break; }
            }
            catch { }
        }
        if (at < 0) at = 0;

        if (!int.TryParse((arg ?? "").Trim(), out var step)) step = 1;
        if (step == 0) return (true, null);

        // Wraps, because a carousel that stops at the ends is not a carousel.
        var count = swatches.Count;
        var wanted = ((at + step) % count + count) % count;

        try { swatches[wanted].Patterns.SelectionItem.Pattern.Select(); }
        catch
        {
            if (!Press(swatches[wanted])) return (false, "could not select the colour");
        }
        return (true, null);
    }

    /// <summary>
    /// Closes the flyout, and waits until the slide-show subtree is back.
    ///
    /// An open flyout unmounts that whole subtree, so leaving one open does not
    /// just strand the user in a menu - it makes a deck that is still being
    /// presented look exactly like one that has stopped, to this process and to
    /// every key on the deck.
    /// </summary>
    private void CloseInkFlyout(AutomationElement win, AutomationElement tool)
    {
        var root = _config.PowerPointLive.RootAutomationId;

        for (var attempt = 0; attempt < 4; attempt++)
        {
            if (FindAnywhere(win, root) is not null) return;

            TryCollapse(tool);
            for (var i = 0; i < 8; i++)
            {
                if (FindAnywhere(win, root) is not null) return;
                Thread.Sleep(70);
            }

            // Collapse can be refused once the element behind it has gone stale.
            // Clicking away is what a user would do, and the toolbar comes back.
            if (attempt >= 1) TryClickAway(win);
        }

        Console.Error.WriteLine("ink flyout would not close; the slide-show surface may read as missing");
    }

    /// <summary>Caches a looked-up element under a key, re-finding it once it dies.</summary>
    private AutomationElement? ResolveCached(string key, Func<AutomationElement?> find)
    {
        if (_cache.TryGetValue(key, out var cached) && IsAlive(cached)) return cached;
        _cache.Remove(key);

        var el = find();
        if (el is not null) _cache[key] = el;
        return el;
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

        // One traversal answers every lookup below. Built here so the whole
        // snapshot sees a consistent view, and cleared in the finally so
        // presses outside a snapshot still resolve elements live.
        _index = BuildIndex(win);
        try
        {
            return Populate(snap, win);
        }
        finally
        {
            _index = null;
        }
    }

    private MeetingSnapshot Populate(MeetingSnapshot snap, AutomationElement win)
    {
        // Read before the toolbar check: PowerPoint Live lives outside the
        // meeting toolbar, so it stays readable while a flyout covers it.
        var role = ReadPowerPointLive(win, snap.Context);
        snap.States["ppt-live"] = role is not null;
        snap.States["ppt-presenting"] = role == "presenter";

        if (!IsToolbarVisible(win))
        {
            // A flyout is covering the toolbar. Report the meeting as live with
            // the last known state rather than blanking every key. Availability
            // is carried forward rather than forced true, so a key for a control
            // that genuinely is not there — a PowerPoint Live key with no deck
            // up — does not flicker to life whenever a menu opens.
            foreach (var key in _config.Controls.Keys)
                snap.Available[key] = !_lastAvailable.TryGetValue(key, out var was) || was;
            foreach (var (k, v) in _lastStates) snap.States[k] = v;

            // Ink colour is the exception. It has to come from the palette
            // rather than from the tool, because opening the palette unmounts
            // the tool button — which is why a new colour used to appear only
            // once the palette closed, long after Teams had recoloured its own
            // toolbar on the click.
            var inkKey = ApplyPaletteColor(snap, win, role);

            foreach (var (key, spec) in _config.Controls)
            {
                if (!spec.ColorFromName) continue;
                if (key == inkKey) continue;
                PublishToolColor(snap, key, spec, ResolveControl(key, spec));
            }

            return snap;
        }

        // The seven menu-nested controls share just two menus, so each menu is
        // located once per snapshot rather than once per control. Resolving them
        // individually cost seven full tree walks every poll.
        var menuAvailable = new Dictionary<string, bool>(StringComparer.Ordinal);

        // Teams unmounts the slide-show subtree while a presentation is idle.
        // Within the grace window its controls keep what they last reported,
        // because the deck has not gone anywhere — only its accessibility tree
        // has.
        var surfaceGone = snap.Context.ContainsKey("ppt.detached");

        // Opening a drawing tool's flyout unmounts that surface too, and with it
        // the very button whose name carries the ink colour. So the one moment
        // the colour can change is the one moment it cannot be read the usual
        // way, and the palette itself becomes the only source.
        //
        // Gated on the surface being gone, which is the only time it is needed.
        var paletteKey = surfaceGone ? ApplyPaletteColor(snap, win, role) : null;

        var detached = surfaceGone &&
                       Environment.TickCount64 - _pptSurfaceSeenAt < _config.PowerPointLive.DetachedGraceMs;

        foreach (var (key, spec) in _config.Controls)
        {
            // Press-only: it lives inside a dialog that is open for a moment,
            // and searching for it costs a scan of every popup window. Nothing
            // draws it, so a snapshot has no reason to look.
            if (spec.IsPressOnly) continue;

            // A control scoped to a PowerPoint Live role is only offered in that
            // role: "Take control" exists for an attendee, the presenter tools
            // for a presenter.
            if (!string.IsNullOrEmpty(spec.RequiresRole) &&
                !string.Equals(spec.RequiresRole, role, StringComparison.OrdinalIgnoreCase))
            {
                snap.Available[key] = false;
                _lastAvailable[key] = false;
                continue;
            }

            if (detached && IsSlideShowControl(spec))
            {
                snap.Available[key] = !_lastAvailable.TryGetValue(key, out var held) || held;
                if (_lastStates.TryGetValue(key, out var heldState)) snap.States[key] = heldState;

                // Covers the tool whose palette is open too: its colour was just
                // published from that palette, so the remembered value is it.
                if (_lastToolColors.TryGetValue(key, out var heldColor))
                    snap.Context[$"ppt.color.{key}"] = heldColor;
                continue;
            }

            // Controls whose state is "something else exists": grid view is an
            // overlay, presenter view is the notes pane. Read first, because in
            // grid view the button that opened it has left the tree — which is
            // exactly when that key has to stay live to get back out.
            var presenceState = !string.IsNullOrEmpty(spec.ActiveWhenPresentAutomationId);
            if (presenceState)
            {
                var on = FindAnywhere(win, spec.ActiveWhenPresentAutomationId!) is not null;

                // The grid overlay unmounts the slide-show surface, and with it
                // the notes pane that presenter view is judged by. Reading it
                // there would report presenter view as switched off every time
                // someone opened the thumbnails. The grid's own key is exempt:
                // the overlay is precisely what it reports on.
                var hiddenByGrid = snap.Context.ContainsKey("ppt.grid") &&
                                   !on &&
                                   !string.Equals(spec.ActiveWhenPresentAutomationId,
                                       _config.PowerPointLive.GridViewAutomationId, StringComparison.Ordinal);

                if (hiddenByGrid && _lastStates.TryGetValue(key, out var held))
                {
                    snap.States[key] = held;
                }
                else
                {
                    snap.States[key] = on;
                    _lastStates[key] = on;
                }

                // Only a control with its own off selector is reachable through
                // it; the rest still toggle through their normal menu or button,
                // so they fall through to the usual availability check below.
                if (snap.States[key] && (!string.IsNullOrEmpty(spec.OffAutomationId) || spec.OffRegex is not null))
                {
                    var reachable = OffTarget(win, spec) is not null;
                    snap.Available[key] = reachable;
                    _lastAvailable[key] = reachable;
                    continue;
                }
            }

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
                _lastAvailable[key] = menuOk;

                // A flyout-nested toggle cannot be read without opening its
                // flyout, so its state is whatever the last press established.
                // Without this a menu control could never show state at all.
                if (!presenceState && _lastStates.TryGetValue(key, out var menuState))
                    snap.States[key] = menuState;
                continue;
            }

            var el = ResolveControl(key, spec);
            if (el is null)
            {
                snap.Available[key] = false;
                _lastAvailable[key] = false;
                // Presence already decided this one; do not overwrite it.
                if (!presenceState && _lastStates.TryGetValue(key, out var carried)) snap.States[key] = carried;
                continue;
            }

            var available = SafeEnabled(el);
            snap.Available[key] = available;
            _lastAvailable[key] = available;

            // A presence-based control has its state already, read from the
            // thing it produced rather than from the button that produced it.
            if (presenceState) continue;

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

            // The ink colour rides along in the same name the selection came
            // from, so a key can be drawn in the colour it will actually draw.
            PublishToolColor(snap, key, spec, el);
        }

        return snap;
    }

    /// <summary>
    /// Publishes the colour and thickness a drawing tool will draw with,
    /// falling back to the last ones seen. <paramref name="el"/> is null when
    /// the control could not be resolved this time round, which is not the same
    /// as it having neither.
    ///
    /// Both come out of the one accessible name Teams writes, "Pen: Light blue,
    /// Thickness 3", so they are read together.
    /// </summary>
    private void PublishToolColor(MeetingSnapshot snap, string key, ControlSpec spec, AutomationElement? el)
    {
        if (!spec.ColorFromName) return;

        var color = el is null ? null : ToolColorOf(el);
        if (color is not null)
        {
            snap.Context[$"ppt.color.{key}"] = color;
            _lastToolColors[key] = color;
        }
        else if (_lastToolColors.TryGetValue(key, out var lastColor))
        {
            snap.Context[$"ppt.color.{key}"] = lastColor;
        }

        var thickness = el is null ? null : ToolThicknessOf(el);
        if (thickness is not null)
        {
            snap.Context[$"ppt.thickness.{key}"] = thickness;
            _lastToolThickness[key] = thickness;
        }
        else if (_lastToolThickness.TryGetValue(key, out var lastThickness))
        {
            snap.Context[$"ppt.thickness.{key}"] = lastThickness;
        }

        // The palette is only readable while the flyout is open, so a dial
        // would have nothing to preview until it had already changed something.
        // Publishing the last one seen lets it show where it is heading.
        if (_lastPalette.TryGetValue(key, out var palette) && palette.Count > 0)
        {
            snap.Context[$"ppt.palette.{key}"] = string.Join("|", palette);
        }
    }

    /// <summary>Last ink thickness seen per tool, held across the subtree's absences.</summary>
    private readonly Dictionary<string, string> _lastToolThickness = new();

    /// <summary>Ink thickness named by a tool, e.g. "Pen: Light blue, Thickness 3".</summary>
    private string? ToolThicknessOf(AutomationElement el)
    {
        var rx = _config.PowerPointLive.ToolThicknessRegex;
        if (rx is null) return null;

        var name = NameOf(el);
        if (name.Length == 0) return null;

        try
        {
            var m = rx.Match(name);
            return m.Success && m.Groups.Count > 1 ? m.Groups[1].Value : null;
        }
        catch (RegexMatchTimeoutException) { return null; }
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
        if (WaitForDismissed(win, host, 1500)) return;

        // Ask the menu to close itself before clicking anything. This is the
        // only dismissal that cannot have a side effect, and it matters most
        // during PowerPoint Live: a stray click on the slide surface advances
        // the deck for everyone watching.
        if (host is not null)
        {
            TryCollapse(host);
            if (WaitForDismissed(win, host, 700)) return;
        }

        // Clicking the menu button again toggles the flyout shut. Its screen
        // position was captured before opening, because the toolbar leaves the
        // accessibility tree while a popup is up.
        if (hostPoint is { } p && InputPoster.TryClickPoint(_renderWidget, p.x, p.y))
        {
            if (WaitForDismissed(win, host, 900)) return;
        }

        // Otherwise click an inert spot inside the meeting window, which is what
        // dismisses a popup normally.
        if (TryClickAway(win))
        {
            if (WaitForDismissed(win, host, 900)) return;
        }

        if (host is not null) TryCollapse(host);
        if (WaitForDismissed(win, host, 300)) return;

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
                    if (WaitForDismissed(win, host, 600)) return;
                }
                catch { }
            }
        }

        if (!WaitForDismissed(win, host, 600))
            Console.Error.WriteLine("warning: could not dismiss Teams flyout");
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

            // The slide surface is not inert. Clicking it during PowerPoint Live
            // advances the deck — for everyone, if you are the one presenting —
            // so a dismissal that landed there was silently driving the
            // presentation. It carries no clickable children of its own, so
            // nothing else would have excluded it.
            var slides = PowerPointSurfaceBounds(win);
            if (slides is { } s) occupied.Add(s);

            foreach (var (x, y) in candidates)
            {
                if (occupied.Any(b => b.Contains(x, y))) continue;
                if (InputPoster.TryClickPoint(_renderWidget, x, y)) return true;
            }

            return false;
        }
        catch { return false; }
    }

    /// <summary>
    /// Screen bounds of the PowerPoint Live slide surface, when one is up.
    /// Treated as occupied so no dismissal click ever lands on a slide.
    /// </summary>
    private System.Drawing.Rectangle? PowerPointSurfaceBounds(AutomationElement win)
    {
        foreach (var id in new[]
                 {
                     _config.PowerPointLive.RootAutomationId,
                     _config.PowerPointLive.GridViewAutomationId
                 })
        {
            var el = FindAnywhere(win, id);
            if (el is null) continue;
            try
            {
                var r = el.BoundingRectangle;
                if (r.Width > 0 && r.Height > 0) return r;
            }
            catch { }
        }
        return null;
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

    /// <summary>
    /// Whether the flyout we opened has actually closed.
    ///
    /// Toolbar visibility alone is not the answer. The big Teams flyouts —
    /// reactions, background effects — drop the whole toolbar from the tree, so
    /// its return means they closed. The smaller PowerPoint Live popups do not:
    /// the meeting toolbar stays right where it is while the Layout menu sits
    /// open over it. Judging by the toolbar there, dismissal decided there was
    /// nothing to do and left the menu on screen, where it then swallowed the
    /// next key press.
    ///
    /// So the host's own expand state is preferred wherever it has one.
    /// </summary>
    private bool IsFlyoutClosed(AutomationElement win, AutomationElement? host)
    {
        if (host is not null)
        {
            try
            {
                var ec = host.Patterns.ExpandCollapse.PatternOrDefault;
                if (ec is not null)
                    return ec.ExpandCollapseState.ValueOrDefault != ExpandCollapseState.Expanded;
            }
            catch { }
        }

        return IsToolbarVisible(win);
    }

    private bool WaitForDismissed(AutomationElement win, AutomationElement? host, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            if (IsFlyoutClosed(win, host)) return true;
            if (Environment.TickCount64 >= deadline) return false;
            Thread.Sleep(60);
        }
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
                if (node.Properties.ControlType.ValueOrDefault == ControlType.Window)
                {
                    // A modal confirmation is not a stray flyout. Teams asks
                    // before ending a presentation for everyone, and dismissing
                    // that on the user's behalf both throws away the answer and
                    // makes the key look broken. Only menus and palettes are
                    // safe to clear.
                    return ClassOf(node).IndexOf("ui-dialog", StringComparison.OrdinalIgnoreCase) < 0;
                }
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
    ///
    /// Cached briefly: enumerating the desktop's children is itself expensive,
    /// and this is called from every lookup that may cross windows. Teams
    /// windows do not come and go faster than this.
    /// </summary>
    private AutomationElement[] SearchScopes(AutomationElement win)
    {
        if (_scopes is not null &&
            Environment.TickCount64 < _scopesUntil &&
            Equals(_scopesFor, win) &&
            _scopes.All(IsAlive))
        {
            return _scopes;
        }

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

        _scopes = scopes.ToArray();
        _scopesFor = win;
        _scopesUntil = Environment.TickCount64 + ScopesTtlMs;
        return _scopes;
    }

    private const int ScopesTtlMs = 3000;
    private AutomationElement[]? _scopes;
    private AutomationElement? _scopesFor;
    private long _scopesUntil;

    /// <summary>
    /// Finds an element inside a just-opened flyout, polling until it appears.
    ///
    /// Several ids may be given for one item: Teams swaps some entries for
    /// their opposite rather than checking them, so only one of the pair is
    /// ever present.
    /// </summary>
    private AutomationElement? FindInPopup(AutomationElement win, string?[] autoIds, Regex? nameRx, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        var scopes = SearchScopes(win);

        // An item Teams has greyed out — Cameo with the camera off — still
        // exists. Kept aside rather than ignored so the caller can say
        // "disabled" and close the menu, instead of polling to the timeout and
        // leaving the flyout orphaned on screen.
        AutomationElement? disabled = null;

        // Once a disabled match is in hand there is little point waiting out the
        // full timeout, but menus do populate in stages, so allow a short grace
        // for it to become enabled. Cameo used to cost the whole 2.5s here,
        // which was most of what pushed a press past the plugin's patience.
        long disabledSince = 0;
        const int DisabledGraceMs = 400;

        while (true)
        {
            foreach (var scope in scopes)
            {
                try
                {
                    foreach (var autoId in autoIds)
                    {
                        if (string.IsNullOrEmpty(autoId)) continue;
                        var byId = FindById(scope, autoId!);
                        if (byId is null) continue;
                        if (SafeEnabled(byId)) return byId;
                        if (disabled is null)
                        {
                            disabled = byId;
                            disabledSince = Environment.TickCount64;
                        }
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
                            if (SafeMatch(nameRx, NameOf(c))) return c;
                        }
                    }
                }
                catch { }
            }

            if (Environment.TickCount64 >= deadline) return disabled;

            // Settled on "present but greyed out": report it now rather than
            // making the user wait out a timeout for an answer we already have.
            if (disabled is not null && Environment.TickCount64 - disabledSince >= DisabledGraceMs)
                return disabled;

            Thread.Sleep(80);
        }
    }

    public (bool ok, string? error) Invoke(string target, string? arg = null)
    {
        // Ink colour and thickness are UI Automation patterns inside a flyout
        // rather than a selector walk, so they are handled directly rather than
        // described in the config like every other control.
        var ink = target is InkColorTarget or InkThicknessTarget;

        ControlSpec? spec = null;
        if (!ink && !_config.Controls.TryGetValue(target, out spec))
            return (false, $"unknown target '{target}'");

        // Chromium activates the Teams window when a control is invoked, so the
        // window that had focus is put back afterwards.
        var previousFocus = _restoreFocus ? FocusGuard.Capture() : IntPtr.Zero;
        try
        {
            return ink ? AdjustInk(target, arg) : InvokeCore(target, spec!, arg);
        }
        finally
        {
            if (previousFocus != IntPtr.Zero) FocusGuard.RestoreAfter(previousFocus);
        }
    }

    /// <summary>
    /// Substitutes a key's configured argument into a selector.
    ///
    /// One control can then cover a whole menu of variants — every slide
    /// translation language is the same flyout walk with a different item id —
    /// instead of needing an entry, and an action, per language.
    /// </summary>
    private static string? Fill(string? template, string? arg, bool forRegex)
    {
        if (string.IsNullOrEmpty(template) || !template!.Contains("{arg}", StringComparison.Ordinal))
            return template;

        var value = arg ?? "";
        return template.Replace("{arg}", forRegex ? Regex.Escape(value) : value, StringComparison.Ordinal);
    }

    /// <summary>
    /// The element that turns an already-on control off.
    ///
    /// Falls back to the control's own selector, because most toggles close the
    /// same way they opened; only the ones with a separate closing control —
    /// grid view — need the explicit off selector.
    /// </summary>
    private AutomationElement? OffTarget(AutomationElement win, ControlSpec spec)
    {
        if (!string.IsNullOrEmpty(spec.OffAutomationId))
        {
            var byId = FindAnywhere(win, spec.OffAutomationId!);
            if (byId is not null && SafeEnabled(byId)) return byId;
        }

        if (spec.OffRegex is not null)
        {
            // The grid overlay's close button carries no AutomationId at all,
            // so a name match is the only way to reach it.
            foreach (var scope in SearchScopes(win))
            {
                try
                {
                    var found = scope.FindAllDescendants(cf =>
                        cf.ByControlType(ControlType.Button).Or(cf.ByControlType(ControlType.MenuItem)));

                    foreach (var e in found)
                    {
                        if (!SafeMatch(spec.OffRegex, NameOf(e))) continue;
                        if (SafeEnabled(e)) return e;
                    }
                }
                catch { }
            }
        }

        if (!string.IsNullOrEmpty(spec.AutomationId))
        {
            var self = FindAnywhere(win, spec.AutomationId);
            if (self is not null && SafeEnabled(self)) return self;
        }

        return null;
    }

    private (bool ok, string? error) InvokeCore(string target, ControlSpec spec, string? arg = null)
    {
        var win = ResolveMeetingWindow();
        if (win is null) return (false, "not in a meeting");

        // A control that is already on may close from somewhere else entirely —
        // grid view opens from the slide toolbar and closes from a button inside
        // the overlay, by which time the opening button has left the tree. Only
        // controls that declare a separate off selector take this path; the ones
        // that merely report state through another element still toggle the
        // normal way.
        var hasOffSelector = !string.IsNullOrEmpty(spec.OffAutomationId) || spec.OffRegex is not null;
        if (hasOffSelector &&
            !string.IsNullOrEmpty(spec.ActiveWhenPresentAutomationId) &&
            FindAnywhere(win, spec.ActiveWhenPresentAutomationId!) is not null)
        {
            var off = OffTarget(win, spec);
            if (off is null) return (false, $"could not find how to turn '{target}' off");
            return Press(off) ? (true, null) : (false, $"could not turn '{target}' off");
        }

        var itemId = Fill(spec.MenuItemAutomationId, arg, forRegex: false);
        var itemToggleId = Fill(spec.MenuItemToggleAutomationId, arg, forRegex: false);
        var itemIds = new[] { itemId, itemToggleId };
        var itemNamePattern = Fill(spec.MenuItemName, arg, forRegex: true);
        Regex? itemNameRx;
        if (ReferenceEquals(itemNamePattern, spec.MenuItemName))
        {
            itemNameRx = spec.MenuItemRegex;
        }
        else
        {
            try
            {
                itemNameRx = string.IsNullOrWhiteSpace(itemNamePattern)
                    ? null
                    : new Regex(itemNamePattern!, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, ControlSpec.MatchTimeout);
            }
            catch (ArgumentException ex) { return (false, $"bad item pattern for '{target}': {ex.Message}"); }
        }

        if (!string.IsNullOrEmpty(spec.MenuItemAutomationId) && string.IsNullOrEmpty(itemId))
            return (false, $"'{target}' needs a value but none was set");

        // A flyout left open by a previous action, or by the user, hides the
        // toolbar. Clear it first so a key press is never a no-op.
        if (!IsToolbarVisible(win)) RecoverFromOpenFlyout(win);

        // Direct toolbar control.
        if (string.IsNullOrEmpty(spec.Menu))
        {
            var el = ResolveControl(target, spec);
            if (el is null) return (false, $"control '{target}' not found");
            if (!SafeEnabled(el)) return (false, $"control '{target}' is disabled");

            // A dialog button is invoked rather than clicked. Press posts a
            // synthetic click into the render widget, which is right for the
            // toolbar - it avoids stealing focus - but a posted click only
            // reports that it was posted, not that it landed, and this dialog
            // is a separate popup layer from that widget. Ending a presentation
            // is one-way and silently doing nothing is the worst outcome, so it
            // uses the deterministic path. Verified live on 2026-09-18: Invoke
            // on this button stops the presentation.
            if (spec.IsPressOnly)
            {
                var invoked = TryInvoke(el);
                Console.Error.WriteLine($"dialog button '{target}' ({NameOf(el)}): invoked={invoked}");
                return invoked ? (true, null) : (false, $"could not invoke '{target}'");
            }

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
            // A nested menu has to be opened before its items exist. Opened the
            // same way as the parent, so it also avoids activating the window.
            if (!string.IsNullOrEmpty(spec.Submenu))
            {
                var sub = FindInPopup(win, new[] { spec.Submenu }, null, 2000);
                if (sub is null) return (false, $"submenu '{spec.Submenu}' not found");
                if (!ExpandMenu(sub)) return (false, $"could not open submenu '{spec.Submenu}'");
                Thread.Sleep(250);
            }

            // Background-effect menus are large and populate lazily, so allow
            // a little longer than a simple reaction flyout.
            item = FindInPopup(win, itemIds, itemNameRx, 2500);

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
                    if (!string.IsNullOrEmpty(spec.Submenu))
                    {
                        var sub = FindInPopup(win, new[] { spec.Submenu }, null, 1500);
                        if (sub is not null) { ExpandMenu(sub); Thread.Sleep(250); }
                    }
                    item = FindInPopup(win, itemIds, itemNameRx, 2000);
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
                var offItem = FindInPopup(win, Array.Empty<string?>(), spec.MenuItemOffRegex, 800);
                if (offItem is not null) item = offItem;
            }

            // Teams greys out entries that do not apply — Cameo needs your
            // camera on. Say so and let the finally block close the menu, rather
            // than pressing nothing and leaving the flyout open.
            if (!SafeEnabled(item))
                return (false, $"'{target}' is not available right now");

            // A checkbox inside a flyout can only be read while the flyout is
            // open, which is exactly now. Reading the truth here and recording
            // the flipped value means the key is right from the first press and
            // re-syncs on every one after, instead of never showing state at
            // all. Only stale if the same setting is changed in Teams directly.
            var wasChecked = IsChecked(item);

            if (!Press(item)) return (false, $"could not invoke item for '{target}'");

            if (wasChecked.HasValue) _lastStates[target] = !wasChecked.Value;

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

    /// <summary>
    /// Free-form context that is not a control: the PowerPoint Live role, slide
    /// position and deck name. Kept apart from States because these are strings
    /// and a key renders them rather than toggling on them.
    /// </summary>
    public Dictionary<string, string> Context { get; set; } = new();

    /// <summary>
    /// A drawing-tool flyout is open, so the colour can change without anything
    /// raising an event: the tool button that would have reported it is unmounted
    /// for as long as its own flyout is up. Polled faster while this holds, and
    /// deliberately kept out of the fingerprint — it is a hint about how often to
    /// look, not a piece of state worth repainting a key for.
    /// </summary>
    public bool InkFlyoutOpen { get; set; }

    public string Fingerprint()
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(TeamsRunning).Append('|').Append(InMeeting).Append('|');
        foreach (var k in States.Keys.Order()) sb.Append(k).Append('=').Append(States[k]).Append(';');
        sb.Append('|');
        foreach (var k in Available.Keys.Order()) sb.Append(k).Append('=').Append(Available[k]).Append(';');
        sb.Append('|');
        // Advancing a slide changes nothing else, so without this the state
        // message would be suppressed as unchanged and a slide-counter key
        // would never update.
        foreach (var k in Context.Keys.Order()) sb.Append(k).Append('=').Append(Context[k]).Append(';');
        return sb.ToString();
    }
}
