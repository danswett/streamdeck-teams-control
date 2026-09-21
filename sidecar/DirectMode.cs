using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace TeamsBridge;

/// <summary>
/// Opt-in settings for Direct mode.
///
/// Direct mode drives Teams by evaluating JavaScript in its own page through
/// the Chrome DevTools Protocol, instead of walking the accessibility tree and
/// posting synthetic clicks. That removes the visible flyout — a menu can be
/// opened, used and closed while it is styled invisible — and works when the
/// Teams window is minimized, which the posted-click path cannot do.
///
/// It requires a local debugging port on Teams, which this plugin deliberately
/// does NOT create. See docs/direct-mode.md: the user enables it themselves by
/// setting WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and restarting Teams, and can
/// remove it the same way. Nothing here writes an environment variable, a
/// registry key, or any other machine setting.
///
/// That split is the point. A debugging port is unauthenticated: anything
/// running as the same user can attach to it and drive the session. That is a
/// decision for the person who owns the machine, so the plugin only ever
/// *consumes* a port that is already open, and reports itself unavailable when
/// there is not one.
/// </summary>
public sealed class DirectModeSpec
{
    /// <summary>
    /// Whether to use the port when one is found. Off unless the user turns it
    /// on: finding a port is not consent to use it.
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Where to look. Must match the port the user put in
    /// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
    ///
    /// No scanning: a sweep of loopback would find debugging ports belonging to
    /// other applications, and attaching to one of those is exactly the thing
    /// this design is trying not to do.
    /// </summary>
    public int Port { get; set; } = 9457;

    /// <summary>
    /// How long a Direct mode attempt may take before it is abandoned and the
    /// UI Automation path runs instead. Short on purpose: a key press that has
    /// to fall back should still feel like a key press.
    /// </summary>
    public int TimeoutMs { get; set; } = 2500;

    /// <summary>How long a successful probe is trusted before re-checking.</summary>
    public int ProbeTtlMs { get; set; } = 5_000;
}

/// <summary>One page, iframe or worker reachable over the debugging port.</summary>
internal sealed record CdpTarget(string Type, string Title, string Url, string WebSocketUrl);

/// <summary>Outcome of a JavaScript evaluation.</summary>
internal sealed record CdpResult(bool Ok, string? Json, string? Error)
{
    public static CdpResult Fail(string why) => new(false, null, why);
}

/// <summary>
/// What Direct mode found on the port, and whether it is safe to use.
/// </summary>
public sealed record DirectModeStatus(bool Usable, string Reason, bool DeckShared, string? Browser)
{
    public static DirectModeStatus Off(string reason) => new(false, reason, false, null);
}

/// <summary>
/// Minimal Chrome DevTools Protocol client: list targets, evaluate an
/// expression in one of them.
///
/// Hand-rolled rather than taken from a package for the same reason the config
/// parser is: the sidecar publishes trimmed and single-file, so anything that
/// binds JSON by reflection is a liability. Everything here reads with
/// JsonDocument and writes with Utf8JsonWriter, neither of which needs the
/// types kept around.
///
/// Every call is synchronous. The sidecar runs one work item at a time, and a
/// loopback round trip is well under a millisecond, so an async path would add
/// machinery without buying latency.
/// </summary>
internal static class Cdp
{
    /// <summary>
    /// Deliberately proxy-free. A managed machine often has a proxy
    /// auto-config script, and letting HttpClient discover one adds seconds to
    /// what should be a loopback request to 127.0.0.1.
    /// </summary>
    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        UseProxy = false,
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromMilliseconds(750)
    });

    public static IReadOnlyList<CdpTarget>? ListTargets(int port, int timeoutMs)
    {
        try
        {
            using var cts = new CancellationTokenSource(timeoutMs);
            using var res = Http.GetAsync($"http://127.0.0.1:{port}/json/list", cts.Token)
                .GetAwaiter().GetResult();
            if (res.StatusCode != HttpStatusCode.OK) return null;

            var body = res.Content.ReadAsStringAsync(cts.Token).GetAwaiter().GetResult();
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;

            var targets = new List<CdpTarget>();
            foreach (var t in doc.RootElement.EnumerateArray())
            {
                var ws = Str(t, "webSocketDebuggerUrl");
                if (ws is null) continue;
                targets.Add(new CdpTarget(
                    Str(t, "type") ?? "", Str(t, "title") ?? "", Str(t, "url") ?? "", ws));
            }
            return targets;
        }
        catch { return null; }

        static string? Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var x) && x.ValueKind == JsonValueKind.String ? x.GetString() : null;
    }

    public static string? BrowserVersion(int port, int timeoutMs)
    {
        try
        {
            using var cts = new CancellationTokenSource(timeoutMs);
            using var res = Http.GetAsync($"http://127.0.0.1:{port}/json/version", cts.Token)
                .GetAwaiter().GetResult();
            if (res.StatusCode != HttpStatusCode.OK) return null;

            var body = res.Content.ReadAsStringAsync(cts.Token).GetAwaiter().GetResult();
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.TryGetProperty("Browser", out var b) ? b.GetString() : null;
        }
        catch { return null; }
    }

    /// <summary>
    /// Evaluates an expression in a target and returns its value as raw JSON.
    ///
    /// <c>awaitPromise</c> is set because every script this sidecar sends is an
    /// async IIFE: opening a menu and waiting for its contents cannot be done
    /// in one synchronous pass.
    /// </summary>
    public static CdpResult Evaluate(CdpTarget target, string expression, int timeoutMs)
    {
        try
        {
            using var cts = new CancellationTokenSource(timeoutMs);
            using var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.Zero;
            ws.ConnectAsync(new Uri(target.WebSocketUrl), cts.Token).GetAwaiter().GetResult();

            const int callId = 1;
            var request = BuildEvaluate(callId, expression);
            ws.SendAsync(Encoding.UTF8.GetBytes(request), WebSocketMessageType.Text, true, cts.Token)
                .GetAwaiter().GetResult();

            var buffer = new byte[32 * 1024];
            var sb = new StringBuilder();
            while (!cts.IsCancellationRequested)
            {
                sb.Clear();
                WebSocketReceiveResult chunk;
                do
                {
                    chunk = ws.ReceiveAsync(new ArraySegment<byte>(buffer), cts.Token)
                        .GetAwaiter().GetResult();
                    if (chunk.MessageType == WebSocketMessageType.Close)
                        return CdpResult.Fail("debugger closed the connection");
                    sb.Append(Encoding.UTF8.GetString(buffer, 0, chunk.Count));
                } while (!chunk.EndOfMessage);

                using var doc = JsonDocument.Parse(sb.ToString());
                var root = doc.RootElement;

                // Targets emit unsolicited events on the same socket; only the
                // reply carrying our id answers the call.
                if (!root.TryGetProperty("id", out var idEl) ||
                    !idEl.TryGetInt32(out var id) || id != callId) continue;

                if (root.TryGetProperty("error", out var err))
                    return CdpResult.Fail($"devtools error: {err}");

                if (!root.TryGetProperty("result", out var outer))
                    return CdpResult.Fail("malformed devtools reply");

                if (outer.TryGetProperty("exceptionDetails", out var ex))
                {
                    var text = ex.TryGetProperty("exception", out var exo) &&
                               exo.TryGetProperty("description", out var d)
                        ? d.GetString()
                        : ex.ToString();
                    return CdpResult.Fail($"script threw: {Trim(text)}");
                }

                if (!outer.TryGetProperty("result", out var inner) ||
                    !inner.TryGetProperty("value", out var value))
                    return CdpResult.Fail("script returned nothing");

                return new CdpResult(true, value.ToString(), null);
            }

            return CdpResult.Fail("timed out waiting for the debugger");
        }
        catch (OperationCanceledException) { return CdpResult.Fail("timed out"); }
        catch (Exception ex) { return CdpResult.Fail(ex.Message); }

        static string? Trim(string? s) =>
            s is null ? null : (s.Length > 200 ? s[..200] : s);
    }

    private static string BuildEvaluate(int id, string expression)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteNumber("id", id);
            w.WriteString("method", "Runtime.evaluate");
            w.WriteStartObject("params");
            w.WriteString("expression", expression);
            w.WriteBoolean("returnByValue", true);
            w.WriteBoolean("awaitPromise", true);
            w.WriteEndObject();
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }
}
