using System.Collections.Concurrent;
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

    private static readonly BlockingCollection<WorkItem> Queue = new(new ConcurrentQueue<WorkItem>());
    private static readonly object WriteLock = new();
    private static volatile bool _running = true;

    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);

        var selectorsPath = GetArg(args, "--selectors")
                            ?? Path.Combine(AppContext.BaseDirectory, "selectors.json");
        var pollMs = int.TryParse(GetArg(args, "--poll"), out var p) ? Math.Clamp(p, 150, 5000) : 400;

        var config = LoadConfig(selectorsPath);
        var restoreFocus = !HasFlag(args, "--no-focus-guard");
        var worker = new Thread(() => WorkerLoop(config, pollMs, restoreFocus)) { IsBackground = true, Name = "uia" };
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

    private static void WorkerLoop(SelectorConfig config, int pollMs, bool restoreFocus)
    {
        var client = new TeamsClient(config, restoreFocus);
        var lastFingerprint = "";
        var nextPoll = 0L;

        while (_running)
        {
            WorkItem? item = null;
            try
            {
                var wait = (int)Math.Clamp(nextPoll - Environment.TickCount64, 0, pollMs);
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
                // An action just changed Teams' state; report it promptly.
                nextPoll = Environment.TickCount64 + 120;
                continue;
            }

            if (Environment.TickCount64 < nextPoll) continue;
            nextPoll = Environment.TickCount64 + pollMs;

            try
            {
                var snap = client.GetSnapshot();
                var fp = snap.Fingerprint();
                if (fp != lastFingerprint)
                {
                    lastFingerprint = fp;
                    EmitState(snap);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"poll failed: {ex.Message}");
            }
        }
    }

    private static void Handle(TeamsClient client, WorkItem item)
    {
        switch (item.Cmd)
        {
            case "ping":
                Emit(w =>
                {
                    w.WriteString("type", "result");
                    w.WriteNumber("id", item.Id);
                    w.WriteBoolean("ok", true);
                });
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

            foreach (var (key, spec) in overrides.Controls) config.Controls[key] = spec;

            if (overrides.Controls.Count > 0)
                Console.Error.WriteLine($"applied {overrides.Controls.Count} selector override(s) from {path}");
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
