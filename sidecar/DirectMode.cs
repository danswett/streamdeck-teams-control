using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
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
/// Works out which process is listening on a loopback TCP port.
///
/// This exists because "is this port Teams?" cannot be answered by asking the
/// port. The DevTools endpoint reports its own targets, so a check against the
/// URL it returns is self-assertion: any local process can claim to be Teams,
/// and a browser with one tab open on teams.microsoft.com claims it honestly
/// while still being the wrong thing to drive.
///
/// The operating system knows who holds the socket, and will not lie about it.
/// </summary>
internal static class PortOwner
{
    private const int AfInet = 2;
    private const int AfInet6 = 23;

    /// <summary>TCP_TABLE_OWNER_PID_LISTENER</summary>
    private const int TcpTableOwnerPidListener = 3;

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        IntPtr pTcpTable, ref int dwOutBufLen, bool sort, int ipVersion, int tblClass, int reserved);

    [StructLayout(LayoutKind.Sequential)]
    private struct TcpRowOwnerPid
    {
        public uint State;
        public uint LocalAddr;
        public uint LocalPort;      // network byte order in the low two bytes
        public uint RemoteAddr;
        public uint RemotePort;
        public uint OwningPid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Tcp6RowOwnerPid
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] LocalAddr;
        public uint LocalScopeId;
        public uint LocalPort;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] RemoteAddr;
        public uint RemoteScopeId;
        public uint RemotePort;
        public uint State;
        public uint OwningPid;
    }

    /// <summary>
    /// The image name of the process listening on <paramref name="port"/>, or
    /// null when that cannot be established. Null is deliberately not treated
    /// as permission by callers.
    /// </summary>
    public static string? ProcessNameFor(int port)
    {
        var pid = OwningPidFor(port);
        if (pid is null) return null;
        // Disposed rather than left to a finalizer: this runs on a probe
        // interval, and an undisposed Process holds an OS handle.
        try { using var p = Process.GetProcessById(pid.Value); return p.ProcessName; }
        catch { return null; }
    }

    public static int? OwningPidFor(int port)
    {
        foreach (var family in new[] { AfInet, AfInet6 })
        {
            var pid = OwningPid(port, family);
            if (pid is not null) return pid;
        }
        return null;
    }

    private const int Th32CsSnapProcess = 0x00000002;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>
    /// Whether the process holding <paramref name="port"/> is
    /// <paramref name="image"/>, or was started by it.
    ///
    /// The second case is the one that matters. A WebView2 application does not
    /// open the debugging port itself: the flag is passed through to the
    /// browser process, so the socket belongs to msedgewebview2.exe, whose
    /// parent is the host application. Checking only the direct owner rejects
    /// the real thing, which is how this was found.
    /// </summary>
    public static (bool ok, string? owner) IsOwnedBy(int port, string image, int maxDepth = 4)
    {
        var pid = OwningPidFor(port);
        if (pid is null) return (false, null);

        var snapshot = CreateToolhelp32Snapshot(Th32CsSnapProcess, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return (false, null);

        var names = new Dictionary<uint, string>();
        var parents = new Dictionary<uint, uint>();
        try
        {
            var entry = new ProcessEntry32 { dwSize = (uint)Marshal.SizeOf<ProcessEntry32>() };
            if (!Process32FirstW(snapshot, ref entry)) return (false, null);
            do
            {
                names[entry.th32ProcessID] = Path.GetFileNameWithoutExtension(entry.szExeFile ?? "");
                parents[entry.th32ProcessID] = entry.th32ParentProcessID;
            } while (Process32NextW(snapshot, ref entry));
        }
        catch { return (false, null); }
        finally { CloseHandle(snapshot); }

        var current = (uint)pid.Value;
        names.TryGetValue(current, out var ownerName);

        var seen = new HashSet<uint>();
        for (var depth = 0; depth < maxDepth && current != 0 && seen.Add(current); depth++)
        {
            if (!names.TryGetValue(current, out var name)) break;
            if (string.Equals(name, image, StringComparison.OrdinalIgnoreCase))
                return (true, ownerName);
            if (!parents.TryGetValue(current, out current)) break;
        }

        return (false, ownerName);
    }

    private static int? OwningPid(int port, int family)
    {
        var size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, TcpTableOwnerPidListener, 0);
        if (size <= 0) return null;

        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (GetExtendedTcpTable(buffer, ref size, false, family, TcpTableOwnerPidListener, 0) != 0)
                return null;

            var count = Marshal.ReadInt32(buffer);
            var rowSize = family == AfInet
                ? Marshal.SizeOf<TcpRowOwnerPid>()
                : Marshal.SizeOf<Tcp6RowOwnerPid>();
            var cursor = buffer + sizeof(int);

            for (var i = 0; i < count; i++)
            {
                uint localPort, owningPid;
                if (family == AfInet)
                {
                    var row = Marshal.PtrToStructure<TcpRowOwnerPid>(cursor);
                    localPort = row.LocalPort; owningPid = row.OwningPid;
                }
                else
                {
                    var row = Marshal.PtrToStructure<Tcp6RowOwnerPid>(cursor);
                    localPort = row.LocalPort; owningPid = row.OwningPid;
                }

                // The port sits in the low two bytes, network byte order.
                var actual = ((localPort & 0xFF) << 8) | ((localPort >> 8) & 0xFF);
                if (actual == port) return (int)owningPid;

                cursor += rowSize;
            }
        }
        catch { }
        finally { Marshal.FreeHGlobal(buffer); }

        return null;
    }
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
    })
    {
        // Whatever is on that port is not necessarily Teams, and a discovery
        // document is a few kilobytes. Refuse to buffer a reply that is trying
        // to be something else.
        MaxResponseContentBufferSize = MaxResponseBytes
    };

    /// <summary>Largest discovery document worth reading.</summary>
    private const int MaxResponseBytes = 1 * 1024 * 1024;

    /// <summary>
    /// Largest reply accepted from a debugger target.
    ///
    /// A scripted press returns a small JSON object. Without a ceiling a peer
    /// that streams indefinitely takes the sidecar down with it: a 40 MB reply
    /// was measured driving the process from 58 MB to 402 MB of working set,
    /// because the bytes are decoded to UTF-16 and then parsed.
    /// </summary>
    private const int MaxEvaluateBytes = 8 * 1024 * 1024;

    /// <summary>
    /// Filters the advertised targets down to the ones it is safe to connect to.
    ///
    /// The debugging endpoint chooses the WebSocket URL, so without this the
    /// party being vetted decides where the next connection goes — verified by
    /// standing up a fake endpoint whose target pointed at a different port,
    /// which the sidecar duly connected to. Only loopback, only ws, and only
    /// the port already configured.
    /// </summary>
    internal static bool IsConnectable(string url, int expectedPort)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (!string.Equals(uri.Scheme, "ws", StringComparison.OrdinalIgnoreCase)) return false;
        if (uri.Port != expectedPort) return false;
        return IPAddress.TryParse(uri.Host, out var ip) && IPAddress.IsLoopback(ip);
    }

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
                if (ws is null || !IsConnectable(ws, port)) continue;
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
            // Accumulated as BYTES, not decoded per chunk. A receive boundary
            // can fall in the middle of a multi-byte character, and decoding
            // each chunk separately turns that character into replacement
            // characters on both sides - silently corrupting the reply.
            using var message = new MemoryStream();
            while (!cts.IsCancellationRequested)
            {
                message.SetLength(0);
                WebSocketReceiveResult chunk;
                do
                {
                    chunk = ws.ReceiveAsync(new ArraySegment<byte>(buffer), cts.Token)
                        .GetAwaiter().GetResult();
                    if (chunk.MessageType == WebSocketMessageType.Close)
                        return CdpResult.Fail("debugger closed the connection");

                    if (message.Length + chunk.Count > MaxEvaluateBytes)
                        return CdpResult.Fail("reply exceeded the size limit");

                    message.Write(buffer, 0, chunk.Count);
                } while (!chunk.EndOfMessage);

                using var doc = JsonDocument.Parse(message.ToArray());
                var root = doc.RootElement;

                // Targets emit unsolicited events on the same socket; only the
                // reply carrying our id answers the call.
                if (!root.TryGetProperty("id", out var idEl) ||
                    !idEl.TryGetInt32(out var id) || id != callId) continue;

                if (root.TryGetProperty("error", out var err))
                    return CdpResult.Fail($"devtools error: {Trim(err.ToString())}");

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
