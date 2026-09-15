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
    private sealed record WorkItem(int Id, string Cmd, string? Target, string? Menu);

    private const int TrimIntervalMs = 60_000;

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
    private static void ReleaseMemory()
    {
        try
        {
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            SetProcessWorkingSetSizeEx(GetCurrentProcess(), new IntPtr(-1), new IntPtr(-1), 0);
        }
        catch { }
    }

    /// <summary>
    /// Controls are clicked by posting to screen coordinates read from UI
    /// Automation. Without per-monitor DPI awareness Windows would virtualise
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
            SetProcessDpiAwareness(2); // PROCESS_PER_MONITOR_DPI_AWARE
        }
        catch { }
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

                if (cmd == "shutdown") { _running = false; break; }
                Queue.Add(new WorkItem(id, cmd, target, menu));
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

        // UI Automation events carry the interesting changes - a window opening,
        // and a control's label changing, which is the mute/camera state signal.
        // Polling stays only as a backstop for anything an event misses, so both
        // intervals can be far longer than they were when polling was the only
        // source of truth.
        var meetingPollMs = Math.Max(pollMs, 3000);
        var idlePollMs = Math.Max(pollMs, 15_000);
        var currentPollMs = meetingPollMs;

        // First trim shortly after start-up, then periodically.
        var lastTrim = Environment.TickCount64 - TrimIntervalMs + 5_000;

        // Fired from UIA threads; only ever enqueues, never touches UIA.
        client.Hint += () =>
        {
            try { if (!Queue.IsAddingCompleted) Queue.Add(new WorkItem(0, "poll", null, null)); }
            catch { }
        };

        while (_running)
        {
            WorkItem? item = null;
            try
            {
                var wait = (int)Math.Clamp(nextPoll - Environment.TickCount64, 0, currentPollMs);
                Queue.TryTake(out item, wait);
            }
            catch (InvalidOperationException) { break; }

            if (item is not null)
            {
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
                continue;
            }

            if (Environment.TickCount64 < nextPoll) continue;

            try
            {
                var snap = client.GetSnapshot();
                currentPollMs = snap.InMeeting ? meetingPollMs : idlePollMs;
                nextPoll = Environment.TickCount64 + currentPollMs;

                var fp = snap.Fingerprint();
                if (fp != lastFingerprint)
                {
                    lastFingerprint = fp;
                    EmitState(snap);
                }

                // Give memory back once things have settled, and periodically
                // thereafter. Skipped while in a meeting so a compacting
                // collection can never land between a key press and its result.
                if (!snap.InMeeting && Environment.TickCount64 - lastTrim > TrimIntervalMs)
                {
                    lastTrim = Environment.TickCount64;
                    ReleaseMemory();
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
                var (ok, err) = client.Invoke(item.Target ?? "");
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

            case "discover":
            {
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

    private static SelectorConfig LoadConfig(string path)
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
    private static SelectorConfig? ParseConfig(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var cfg = new SelectorConfig();

        if (root.TryGetProperty("version", out var v) && v.TryGetInt32(out var vi)) cfg.Version = vi;
        if (root.TryGetProperty("meetingProbeAutomationId", out var mp) && mp.GetString() is { } mps)
            cfg.MeetingProbeAutomationId = mps;
        if (root.TryGetProperty("fullToolbarAutomationId", out var ft) && ft.GetString() is { } fts)
            cfg.FullToolbarAutomationId = fts;

        if (!root.TryGetProperty("controls", out var controls)) return cfg;

        foreach (var prop in controls.EnumerateObject())
        {
            var o = prop.Value;
            cfg.Controls[prop.Name] = new ControlSpec
            {
                AutomationId = Str(o, "automationId") ?? "",
                Menu = Str(o, "menu"),
                MenuItemAutomationId = Str(o, "menuItemAutomationId"),
                MenuItemName = Str(o, "menuItemName"),
                MenuItemOffName = Str(o, "menuItemOffName"),
                ActivePattern = Str(o, "activePattern"),
                InactivePattern = Str(o, "inactivePattern")
            };
        }
        return cfg;

        static string? Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var x) && x.ValueKind == JsonValueKind.String ? x.GetString() : null;
    }
}
