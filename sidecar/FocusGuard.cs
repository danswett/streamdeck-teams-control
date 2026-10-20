using System.Runtime.InteropServices;

namespace TeamsBridge;

/// <summary>
/// Keeps a key press from pulling Teams to the front.
///
/// Chromium activates its window when a control is invoked through UI
/// Automation, and no non-activating invoke path is available — Teams' meeting
/// buttons expose only the Invoke pattern, not LegacyIAccessible, so there is
/// nothing like accDoDefaultAction to fall back on.
///
/// Instead the foreground window is captured before the operation and restored
/// afterwards. SetForegroundWindow is normally refused for a background
/// process, so the calling thread is briefly attached to the input queues of
/// both the current and target windows, which lifts that restriction.
/// </summary>
internal static class FocusGuard
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    /// <summary>
    /// The window that was in front, or zero when the guard should not act
    /// (nothing focused, or Teams already had focus and should keep it).
    /// </summary>
    public static IntPtr Capture()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;

        // If the user was already working in Teams, leave focus alone.
        return IsTeamsWindow(hwnd) ? IntPtr.Zero : hwnd;
    }

    /// <summary>
    /// Watches for Teams coming forward and puts focus back, for a short window
    /// after the operation.
    ///
    /// Chromium activates its window asynchronously — after the Invoke call has
    /// already returned — so restoring once immediately is too early to catch
    /// it. This runs off the UIA worker thread so a key press stays responsive.
    /// </summary>
    public static void RestoreAfter(IntPtr previous, int watchMs = 1500) => Watch(previous, watchMs).Dispose();

    /// <summary>
    /// Watches from now until <paramref name="trailingMs"/> after the returned
    /// scope is disposed, for an operation that can bring Teams forward while it
    /// is still running rather than only once it has returned. Teams' Collapse
    /// has been measured blocking for two seconds before it returns; watching
    /// only from then would leave Teams in front for all of that.
    /// </summary>
    public static IDisposable Watch(IntPtr previous, int trailingMs = 1500)
    {
        if (previous == IntPtr.Zero) return NoWatch.Instance;
        var watch = new FocusWatch(previous, trailingMs);
        watch.Start();
        return watch;
    }

    private sealed class FocusWatch : IDisposable
    {
        private readonly IntPtr _previous;
        private readonly int _trailingMs;
        private long _until = long.MaxValue;

        public FocusWatch(IntPtr previous, int trailingMs)
        {
            _previous = previous;
            _trailingMs = trailingMs;
        }

        public void Start()
        {
            var watcher = new Thread(Run)
            {
                IsBackground = true,
                Name = "focus-guard"
            };
            watcher.Start();
        }

        public void Dispose() =>
            Interlocked.CompareExchange(ref _until, Environment.TickCount64 + _trailingMs, long.MaxValue);

        private void Run()
        {
            while (Environment.TickCount64 < Interlocked.Read(ref _until))
            {
                Thread.Sleep(60);
                try
                {
                    if (!IsWindow(_previous)) return;
                    var current = GetForegroundWindow();
                    if (current == _previous) continue;
                    if (current == IntPtr.Zero || !IsTeamsWindow(current)) continue;
                    Restore(_previous);
                }
                catch { return; }
            }
        }
    }

    private sealed class NoWatch : IDisposable
    {
        public static readonly NoWatch Instance = new();
        public void Dispose() { }
    }

    /// <summary>Puts focus back, if Teams took it during the operation.</summary>
    public static void Restore(IntPtr previous)
    {
        if (previous == IntPtr.Zero || !IsWindow(previous)) return;
        if (IsIconic(previous)) return;

        var current = GetForegroundWindow();
        if (current == previous) return;

        // Only intervene when Teams is what came forward.
        if (current != IntPtr.Zero && !IsTeamsWindow(current)) return;

        var self = GetCurrentThreadId();
        var fromThread = current == IntPtr.Zero ? 0 : GetWindowThreadProcessId(current, out _);
        var toThread = GetWindowThreadProcessId(previous, out _);

        var attachedFrom = fromThread != 0 && fromThread != self && AttachThreadInput(self, fromThread, true);
        var attachedTo = toThread != 0 && toThread != self && AttachThreadInput(self, toThread, true);
        try
        {
            BringWindowToTop(previous);
            SetForegroundWindow(previous);
        }
        finally
        {
            if (attachedTo) AttachThreadInput(self, toThread, false);
            if (attachedFrom) AttachThreadInput(self, fromThread, false);
        }
    }

    private static bool IsTeamsWindow(IntPtr hwnd)
    {
        try
        {
            GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == 0) return false;
            using var p = System.Diagnostics.Process.GetProcessById((int)pid);
            return string.Equals(p.ProcessName, "ms-teams", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }
}
