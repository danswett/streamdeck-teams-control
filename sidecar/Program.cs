using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace TeamsBridge;

/// <summary>
/// Line-delimited JSON bridge over stdio. The Stream Deck plugin (Node) spawns
/// this process and speaks JSON over stdin/stdout; stderr carries diagnostics
/// only, so stdout stays a clean protocol channel.
/// </summary>
public static class Program
{
    private sealed record WorkItem(int Id, string Cmd, string? Target, string? Menu, string? Arg = null, int Fade = 0, int Width = 200, int Height = 100)
    {
        /// <summary>
        /// When the request arrived. A menu walk takes seconds, so a handful of
        /// quick presses can queue up behind one; without this they would all
        /// run long after the user gave up, driving the meeting on their behalf.
        /// </summary>
        public long QueuedAt { get; } = Environment.TickCount64;
    }

    private const int TrimIntervalMs = 60_000;

    /// <summary>Most frames a single fade may ask for; see the clamp on parse.</summary>
    private const int MaxFadeFrames = 12;

    /// <summary>Largest slot a caller may ask a slide to be composed into.</summary>
    private const int MaxSlotPixels = 1024;

    /// <summary>How long after the last thumbnail to release the capture buffer.</summary>
    private const int CaptureBufferIdleMs = 30_000;

    /// <summary>
    /// How often memory is returned during a meeting. Much rarer than the idle
    /// path because the collection competes with key presses.
    /// </summary>
    private const int MeetingTrimIntervalMs = 300_000;

    /// <summary>
    /// How long after a press to take a second snapshot. Teams applies a role
    /// change - attendee to presenter, after "Take control" - noticeably later
    /// than the press itself returns, and that one press retires half the keys
    /// and brings up the other half.
    /// </summary>
    private const int SettleMs = 1200;

    /// <summary>
    /// How long a queued press stays worth running. The plugin gives up on a
    /// press after 10s and tells the key so; anything older than that would
    /// fire after the user has been told it failed, which is worse than not
    /// firing at all. Held just under the plugin's limit so the two cannot
    /// disagree about whether a press still counts.
    /// </summary>
    private const int StaleInvokeMs = 9_000;

    /// <summary>
    /// A snapshot slower than this is worth complaining about. The worker runs
    /// one thing at a time, so a snapshot this long is long enough to eat most
    /// of the plugin's patience with a press that arrives during it.
    /// </summary>
    private const int SlowSnapshotMs = 2_000;

    /// <summary>
    /// Whether a poll is already queued. Teams raises bursts of property events
    /// for one visible change, and every extra poll only delays real work.
    /// </summary>
    private static int _pollPending;

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int value);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool SetProcessWorkingSetSizeEx(
        IntPtr process, IntPtr minSize, IntPtr maxSize, uint flags);

    /// <summary>
    /// Releases memory back to the OS.
    ///
    /// Two separate problems. The GC keeps heap segments committed after a busy
    /// period — a long-running sidecar sat around 18 MB above a freshly started
    /// one — so an aggressive compacting collection is needed to decommit them.
    /// Separately, start-up touches a lot of pages that are never read again
    /// (JIT, the single-file bundle, the first UIA tree walk), and trimming the
    /// working set releases those; they fault back in if ever needed.
    ///
    /// Only runs on the idle path, so it never delays a key press.
    /// </summary>
    private static void ReleaseMemory(bool compacting)
    {
        try
        {
            if (compacting)
            {
                GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
                GC.WaitForPendingFinalizers();
            }
            else
            {
                GC.Collect(2, GCCollectionMode.Forced, blocking: false, compacting: false);
            }

            SetProcessWorkingSetSizeEx(GetCurrentProcess(), new IntPtr(-1), new IntPtr(-1), 0);
        }
        catch { }
    }

    /// <summary>
    /// Controls are clicked by posting to screen coordinates read from UI
    /// Automation. Without per-monitor DPI awareness Windows would virtualize
    /// those coordinates and the clicks would land in the wrong place on a
    /// scaled or multi-monitor setup.
    /// </summary>
    private static void MakeDpiAware()
    {
        try
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        }
        catch { }

        try
        {
            if (SetProcessDpiAwareness(2) == 0) return; // PROCESS_PER_MONITOR_DPI_AWARE
        }
        catch { }

        // Worth saying out loud: every posted click would be offset on a scaled
        // display, and the symptom - presses landing on the wrong control - gives
        // no hint of the cause.
        Console.Error.WriteLine("WARNING: could not set per-monitor DPI awareness; clicks may be misplaced on scaled displays");
    }

    private static readonly BlockingCollection<WorkItem> Queue = new(new ConcurrentQueue<WorkItem>());
    private static readonly object WriteLock = new();
    private static volatile bool _running = true;

    public static int Main(string[] args)
    {
        MakeDpiAware();
        Console.OutputEncoding = new UTF8Encoding(false);

        var selectorsPath = GetArg(args, "--selectors")
                            ?? Path.Combine(AppContext.BaseDirectory, "selectors.json");
        var pollMs = int.TryParse(GetArg(args, "--poll"), out var p) ? Math.Clamp(p, 150, 5000) : 700;

        var config = LoadConfig(selectorsPath);
        var restoreFocus = !HasFlag(args, "--no-focus-guard");
        var debugEvents = HasFlag(args, "--debug-events");
        var useEvents = !HasFlag(args, "--no-events");
        var worker = new Thread(() => WorkerLoop(config, pollMs, restoreFocus, debugEvents, useEvents)) { IsBackground = true, Name = "uia" };
        // UIA requires MTA; console Main is already MTA but the worker must be explicit.
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();

        Emit(w =>
        {
            w.WriteString("type", "ready");
            w.WriteNumber("pid", Environment.ProcessId);
            w.WriteString("selectors", File.Exists(selectorsPath) ? selectorsPath : "(built-in defaults)");
        });

        string? line;
        while (_running && (line = Console.In.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                var id = root.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var i) ? i : 0;
                var cmd = root.TryGetProperty("cmd", out var c) ? c.GetString() ?? "" : "";
                var target = root.TryGetProperty("target", out var t) ? t.GetString() : null;
                var menu = root.TryGetProperty("menu", out var m) ? m.GetString() : null;
                var arg = root.TryGetProperty("arg", out var a) ? a.GetString() : null;
                // Clamped at the boundary. Nothing downstream bounds it, and a
                // fade is a loop that allocates a frame per turn.
                var fade = root.TryGetProperty("fade", out var f) && f.ValueKind == JsonValueKind.Number
                    && f.TryGetInt32(out var fv) ? Math.Clamp(fv, 0, MaxFadeFrames) : 0;

                // Likewise bounded: the slot is an allocation, and a caller
                // asking for a huge one is asking for a huge bitmap.
                var w = root.TryGetProperty("w", out var we) && we.ValueKind == JsonValueKind.Number
                    && we.TryGetInt32(out var wv) ? Math.Clamp(wv, 16, MaxSlotPixels) : 200;
                var h = root.TryGetProperty("h", out var he) && he.ValueKind == JsonValueKind.Number
                    && he.TryGetInt32(out var hv) ? Math.Clamp(hv, 16, MaxSlotPixels) : 100;

                if (cmd == "shutdown") { _running = false; break; }
                Queue.Add(new WorkItem(id, cmd, target, menu, arg, fade, w, h));
            }
            catch (Exception ex)
            {
                Emit(w =>
                {
                    w.WriteString("type", "error");
                    w.WriteString("message", $"bad request: {ex.Message}");
                });
            }
        }

        _running = false;
        Queue.CompleteAdding();
        return 0;
    }

    private static void WorkerLoop(SelectorConfig config, int pollMs, bool restoreFocus, bool debugEvents, bool useEvents)
    {
        using var client = new TeamsClient(config, restoreFocus) { DebugEvents = debugEvents, UseEvents = useEvents };
        var lastFingerprint = "";
        var nextPoll = 0L;

        // When to take the follow-up snapshot after a press, for effects that
        // land asynchronously - chiefly the attendee -> presenter role change
        // that "Take control" causes.
        var settleAt = 0L;

        // UI Automation events carry the interesting changes - a window opening,
        // and a control's label changing, which is the mute/camera state signal.
        // Polling stays only as a backstop for anything an event misses, so both
        // intervals can be far longer than they were when polling was the only
        // source of truth.
        var meetingPollMs = Math.Max(pollMs, 3000);
        var idlePollMs = Math.Max(pollMs, 15_000);

        // While a drawing-tool flyout is open the tool button is unmounted, so a
        // color change raises no event and polling is the only way to see it.
        // Brief and self-limiting: it only applies while that flyout is up.
        var inkFlyoutPollMs = Math.Clamp(pollMs, 150, 500);
        var currentPollMs = meetingPollMs;

        // First trim shortly after start-up, then periodically.
        var lastTrim = Environment.TickCount64 - TrimIntervalMs + 5_000;

        // Fired from UIA threads; only ever enqueues, never touches UIA.
        //
        // Coalesced: a poll already waiting says everything a second one would,
        // and Teams can raise a burst of property events for a single visible
        // change. Without this the queue grows with work that is already
        // covered, and a press lands behind all of it.
        client.Hint += () =>
        {
            if (Interlocked.Exchange(ref _pollPending, 1) == 1) return;
            try { if (!Queue.IsAddingCompleted) Queue.Add(new WorkItem(0, "poll", null, null)); }
            catch { Interlocked.Exchange(ref _pollPending, 0); }
        };

        while (_running)
        {
            WorkItem? item = null;
            try
            {
                // Whichever comes first: the scheduled poll, or the settle
                // re-read owed after a press.
                var due = nextPoll;
                if (settleAt != 0 && settleAt < due) due = settleAt;

                var wait = (int)Math.Clamp(due - Environment.TickCount64, 0, currentPollMs);
                Queue.TryTake(out item, wait);
            }
            catch (InvalidOperationException) { break; }

            if (item is not null)
            {
                if (item.Cmd == "poll")
                {
                    Interlocked.Exchange(ref _pollPending, 0);

                    // The queue is FIFO, so a press that arrived while this poll
                    // was waiting sits behind it. A poll is only a backstop read
                    // and says the same thing a moment later; a press is what the
                    // user is waiting on, and has 10s before the key reports
                    // failure. Let the press through and poll straight after -
                    // the post-press re-read covers what this poll would have
                    // seen anyway.
                    if (Queue.Count > 0)
                    {
                        nextPoll = Environment.TickCount64;
                        continue;
                    }
                }

                try { Handle(client, item); }
                catch (Exception ex)
                {
                    Emit(w =>
                    {
                        w.WriteString("type", "result");
                        w.WriteNumber("id", item.Id);
                        w.WriteBoolean("ok", false);
                        w.WriteString("error", ex.Message);
                    });
                }
                // Something just happened; report it promptly.
                nextPoll = Environment.TickCount64 + 120;

                // ...and again once Teams has settled. Some controls change far
                // more than themselves: taking control of a deck turns you from
                // attendee into presenter, which retires "Take control" and
                // brings up the whole presenter toolbar. That lands well after
                // the press returns, so a single immediate re-read would report
                // the old role and leave every key a role behind.
                settleAt = Environment.TickCount64 + SettleMs;
                continue;
            }

            if (Environment.TickCount64 < nextPoll && (settleAt == 0 || Environment.TickCount64 < settleAt)) continue;
            if (settleAt != 0 && Environment.TickCount64 >= settleAt) settleAt = 0;

            try
            {
                // Timed because this is the only thing on the worker that can
                // run long, and while it does, a press waits: the plugin gives
                // up after 10s and tells the key it failed. A slow snapshot is
                // therefore the explanation for a key that "did nothing", so it
                // says so rather than leaving it to be guessed at.
                var started = Environment.TickCount64;
                var snap = client.GetSnapshot();
                var took = Environment.TickCount64 - started;
                if (took > SlowSnapshotMs)
                    Console.Error.WriteLine($"slow snapshot: {took}ms (a press during this would have waited)");

                currentPollMs = snap.InkFlyoutOpen ? inkFlyoutPollMs
                    : snap.InMeeting ? meetingPollMs
                    : idlePollMs;
                nextPoll = Environment.TickCount64 + currentPollMs;

                var fp = snap.Fingerprint();
                if (fp != lastFingerprint)
                {
                    lastFingerprint = fp;
                    EmitState(snap);
                }

                // Give memory back once things have settled, and periodically
                // thereafter.
                var sinceTrim = Environment.TickCount64 - lastTrim;

                // Independent of the collection below: the capture buffer is a
                // single large allocation that only matters while thumbnails
                // are being taken, and waiting for the meeting trim would hold
                // it for five minutes after the last one.
                SlideCapture.TrimBuffer(CaptureBufferIdleMs);

                if (!snap.InMeeting && sinceTrim > TrimIntervalMs)
                {
                    lastTrim = Environment.TickCount64;
                    ReleaseMemory(compacting: true);
                }
                else if (snap.InMeeting && sinceTrim > MeetingTrimIntervalMs && Queue.Count == 0)
                {
                    // A long meeting would otherwise never reclaim anything: a
                    // 22-minute soak drifted up 9 MB because the only release
                    // path was the idle one. Do it far less often here, never
                    // compacting and never blocking, and only with no work
                    // queued, so it cannot land between a press and its result.
                    lastTrim = Environment.TickCount64;
                    ReleaseMemory(compacting: false);
                }
            }
            catch (Exception ex)
            {
                nextPoll = Environment.TickCount64 + currentPollMs;
                Console.Error.WriteLine($"poll failed: {ex.Message}");
            }
        }
    }

    private static void Handle(TeamsClient client, WorkItem item)
    {
        switch (item.Cmd)
        {
            case "ping":
            case "poll":
                // "poll" is an internal nudge from a UIA event; the loop takes a
                // snapshot straight after handling any work item.
                if (item.Cmd == "ping")
                {
                    Emit(w =>
                    {
                        w.WriteString("type", "result");
                        w.WriteNumber("id", item.Id);
                        w.WriteBoolean("ok", true);
                    });
                }
                break;

            case "status":
                EmitState(client.GetSnapshot());
                Emit(w =>
                {
                    w.WriteString("type", "result");
                    w.WriteNumber("id", item.Id);
                    w.WriteBoolean("ok", true);
                });
                break;

            case "invoke":
            {
                // Dropped rather than run late: the plugin has already timed out
                // and told the key it failed, so acting now would move the
                // meeting with nothing on screen explaining why.
                var age = Environment.TickCount64 - item.QueuedAt;
                if (age > StaleInvokeMs)
                {
                    Console.Error.WriteLine($"dropping stale invoke '{item.Target}' queued {age}ms ago");
                    Emit(w =>
                    {
                        w.WriteString("type", "result");
                        w.WriteNumber("id", item.Id);
                        w.WriteBoolean("ok", false);
                        w.WriteString("error", "dropped: queued too long");
                    });
                    break;
                }

                var (ok, err) = client.Invoke(item.Target ?? "", item.Arg);
                Emit(w =>
                {
                    w.WriteString("type", "result");
                    w.WriteNumber("id", item.Id);
                    w.WriteBoolean("ok", ok);
                    if (err is not null) w.WriteString("error", err);
                });
                EmitState(client.GetSnapshot());
                break;
            }

            case "thumb":
            {
                // Its own message type rather than a result, because it carries
                // a picture: keeping it off the state channel means a thumbnail
                // never rides along with every key's availability, and a stale
                // one is never replayed.
                //
                // The slot size is the caller's, because a touch-strip slot and
                // a key are different shapes, and composing to the size it will
                // be shown at is what keeps the picture off the wire twice.
                var (ok, err, image, name, end, frames) = client.CaptureSlide(
                    item.Arg ?? "current", item.Fade, item.Width, item.Height);
                Emit(w =>
                {
                    w.WriteString("type", "thumb");
                    w.WriteNumber("id", item.Id);
                    w.WriteBoolean("ok", ok);
                    w.WriteString("which", item.Arg ?? "current");
                    w.WriteBoolean("end", end);
                    if (name is not null) w.WriteString("name", name);
                    if (image is not null) w.WriteString("image", image);
                    if (err is not null) w.WriteString("error", err);
                    if (frames.Count > 0)
                    {
                        w.WriteStartArray("frames");
                        foreach (var f in frames) w.WriteStringValue(f);
                        w.WriteEndArray();
                    }
                });
                break;
            }

            case "forget":
            {
                // No reply: the plugin sends this to stop the sidecar holding a
                // slide, and has nothing to do with the answer.
                SlideCapture.ForgetPrevious(item.Arg);
                break;
            }

            case "discover":            {
                var rows = client.Discover(item.Menu);
                Emit(w =>
                {
                    w.WriteString("type", "discover");
                    w.WriteNumber("id", item.Id);
                    w.WriteString("menu", item.Menu ?? "");
                    w.WritePropertyName("elements");
                    w.WriteStartArray();
                    foreach (var r in rows)
                    {
                        w.WriteStartObject();
                        foreach (var (k, v) in r) w.WriteString(k, v);
                        w.WriteEndObject();
                    }
                    w.WriteEndArray();
                });
                break;
            }

            default:
                Emit(w =>
                {
                    w.WriteString("type", "result");
                    w.WriteNumber("id", item.Id);
                    w.WriteBoolean("ok", false);
                    w.WriteString("error", $"unknown command '{item.Cmd}'");
                });
                break;
        }
    }

    private static void EmitState(MeetingSnapshot snap) => Emit(w =>
    {
        w.WriteString("type", "state");
        w.WriteBoolean("teamsRunning", snap.TeamsRunning);
        w.WriteBoolean("inMeeting", snap.InMeeting);
        w.WriteString("windowTitle", snap.WindowTitle);

        w.WritePropertyName("states");
        w.WriteStartObject();
        foreach (var (k, v) in snap.States) w.WriteBoolean(k, v);
        w.WriteEndObject();

        w.WritePropertyName("available");
        w.WriteStartObject();
        foreach (var (k, v) in snap.Available) w.WriteBoolean(k, v);
        w.WriteEndObject();

        w.WritePropertyName("context");
        w.WriteStartObject();
        foreach (var (k, v) in snap.Context) w.WriteString(k, v);
        w.WriteEndObject();
    });

    private static void Emit(Action<Utf8JsonWriter> body)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            body(w);
            w.WriteEndObject();
        }

        var json = Encoding.UTF8.GetString(ms.ToArray());
        lock (WriteLock)
        {
            Console.Out.Write(json);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
    }

    private static string? GetArg(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return null;
    }

    private static bool HasFlag(string[] args, string name) =>
        args.Any(a => string.Equals(a, name, StringComparison.OrdinalIgnoreCase));

    internal static SelectorConfig LoadConfig(string path)
    {
        var config = Defaults.Config();
        if (!File.Exists(path)) return config;

        try
        {
            // Overlaid onto the defaults rather than replacing them, so a partial
            // or outdated selectors.json can only change what it names.
            var overrides = ParseConfig(File.ReadAllText(path));
            if (overrides is null) return config;

            if (!string.IsNullOrWhiteSpace(overrides.MeetingProbeAutomationId))
                config.MeetingProbeAutomationId = overrides.MeetingProbeAutomationId;

            if (!string.IsNullOrWhiteSpace(overrides.FullToolbarAutomationId))
                config.FullToolbarAutomationId = overrides.FullToolbarAutomationId;

            // Same reasoning as the control patterns below: reject a bad pattern
            // here rather than letting it throw on every poll.
            if (overrides.PowerPointLive.Validate() is { } pptProblem)
                Console.Error.WriteLine($"ignoring powerPointLive overrides from {path} - {pptProblem}");
            else
                config.PowerPointLive = overrides.PowerPointLive;

            var applied = 0;
            foreach (var (key, spec) in overrides.Controls)
            {
                // A pattern is only compiled when a state is read, so an invalid
                // one would otherwise surface as an error on every poll, long
                // after the edit that caused it. Reject it here and keep the
                // working default instead.
                if (spec.Validate() is { } problem)
                {
                    Console.Error.WriteLine($"ignoring override '{key}' from {path} - {problem}");
                    continue;
                }
                config.Controls[key] = spec;
                applied++;
            }

            if (applied > 0)
                Console.Error.WriteLine($"applied {applied} selector override(s) from {path}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"failed to read {path}: {ex.Message}; using built-in defaults");
        }

        return config;
    }

    /// <summary>Hand-rolled so the sidecar stays trim-safe (no reflection-based binding).</summary>
    internal static SelectorConfig? ParseConfig(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var cfg = new SelectorConfig();

        if (root.TryGetProperty("version", out var v) && v.TryGetInt32(out var vi)) cfg.Version = vi;
        if (root.TryGetProperty("meetingProbeAutomationId", out var mp) && mp.GetString() is { } mps)
            cfg.MeetingProbeAutomationId = mps;
        if (root.TryGetProperty("fullToolbarAutomationId", out var ft) && ft.GetString() is { } fts)
            cfg.FullToolbarAutomationId = fts;

        if (root.TryGetProperty("powerPointLive", out var ppt) && ppt.ValueKind == JsonValueKind.Object)
        {
            var spec = cfg.PowerPointLive;
            if (Str(ppt, "rootAutomationId") is { } r) spec.RootAutomationId = r;
            if (Str(ppt, "toolbarAutomationId") is { } tb) spec.ToolbarAutomationId = tb;
            if (Str(ppt, "slideContainerAutomationId") is { } sc) spec.SlideContainerAutomationId = sc;
            if (Str(ppt, "presenterClassPattern") is { } pc) spec.PresenterClassPattern = pc;
            if (Str(ppt, "attendeeClassPattern") is { } ac) spec.AttendeeClassPattern = ac;
            if (Str(ppt, "slidePositionPattern") is { } sp) spec.SlidePositionPattern = sp;
            if (Str(ppt, "deckTitlePattern") is { } dt) spec.DeckTitlePattern = dt;
            if (Str(ppt, "gridViewAutomationId") is { } gv) spec.GridViewAutomationId = gv;
            if (Str(ppt, "presenterMarkerAutomationId") is { } pm) spec.PresenterMarkerAutomationId = pm;
            if (Str(ppt, "attendeeMarkerAutomationId") is { } am) spec.AttendeeMarkerAutomationId = am;
            if (Str(ppt, "toolColorPattern") is { } tc) spec.ToolColorPattern = tc;
            if (Str(ppt, "arrowOptionPattern") is { } ao) spec.ArrowOptionPattern = ao;
            if (ppt.TryGetProperty("inkColorNames", out var icn) && icn.ValueKind == JsonValueKind.Array)
            {
                var colors = icn.EnumerateArray()
                    .Where(e => e.ValueKind == JsonValueKind.String)
                    .Select(e => e.GetString()!)
                    .Where(s => !string.IsNullOrWhiteSpace(s))
                    .ToArray();
                if (colors.Length > 0) spec.InkColorNames = colors;
            }
            if (Str(ppt, "slideShowSurface") is { } ss) spec.SlideShowSurface = ss;
            if (ppt.TryGetProperty("detachedGraceMs", out var dg) && dg.TryGetInt32(out var dgv))
                spec.DetachedGraceMs = Math.Clamp(dgv, 0, 300_000);
        }

        if (!root.TryGetProperty("controls", out var controls)) return cfg;

        foreach (var prop in controls.EnumerateObject())
        {
            var o = prop.Value;
            cfg.Controls[prop.Name] = new ControlSpec
            {
                AutomationId = Str(o, "automationId") ?? "",
                Name = Str(o, "name"),
                WithinClass = Str(o, "withinClass"),
                Menu = Str(o, "menu"),
                Submenu = Str(o, "submenu"),
                RequiresRole = Str(o, "requiresRole"),
                MenuItemAutomationId = Str(o, "menuItemAutomationId"),
                MenuItemToggleAutomationId = Str(o, "menuItemToggleAutomationId"),
                MenuItemName = Str(o, "menuItemName"),
                MenuItemOffName = Str(o, "menuItemOffName"),
                ActivePattern = Str(o, "activePattern"),
                InactivePattern = Str(o, "inactivePattern"),
                ActiveWhenPresentAutomationId = Str(o, "activeWhenPresentAutomationId"),
                OffAutomationId = Str(o, "offAutomationId"),
                OffName = Str(o, "offName"),
                Surface = Str(o, "surface"),
                ColorFromName = o.TryGetProperty("colorFromName", out var cfn) &&
                                cfn.ValueKind == JsonValueKind.True,
                StateFromSelection = o.TryGetProperty("stateFromSelection", out var sfs) &&
                                     sfs.ValueKind == JsonValueKind.True,
                StateFromFullDescription = o.TryGetProperty("stateFromFullDescription", out var sfd) &&
                                           sfd.ValueKind == JsonValueKind.True
            };
        }
        return cfg;

        static string? Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var x) && x.ValueKind == JsonValueKind.String ? x.GetString() : null;
    }
}
