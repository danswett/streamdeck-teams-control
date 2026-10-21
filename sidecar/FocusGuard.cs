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

    private delegate void WinEventProc(
        IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint eventThread, uint eventTimeMs);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(
        uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll", EntryPoint = "GetMessageW")]
    private static extern int GetMessage(out MSG msg, IntPtr hWnd, uint filterMin, uint filterMax);

    [DllImport("user32.dll")]
    private static extern UIntPtr SetTimer(IntPtr hWnd, UIntPtr id, uint elapseMs, IntPtr timerProc);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool KillTimer(IntPtr hWnd, UIntPtr id);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
        public uint lPrivate;
    }

    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WM_TIMER = 0x0113;

    /// <summary>
    /// How often a watch looks for itself, as well as being told. Ends the
    /// watch on time, and catches Teams coming forward if the hook could not
    /// be installed - which is how every change was found before it existed.
    /// </summary>
    private const int BackstopMs = 60;

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
    /// Whether Teams is in front, where activating it takes nothing from
    /// anyone.
    /// </summary>
    public static bool IsTeamsInFront()
    {
        var hwnd = GetForegroundWindow();
        return hwnd != IntPtr.Zero && IsTeamsWindow(hwnd);
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

        // Held for as long as the hook is installed. Windows calls back through
        // it, and a delegate only native code refers to is otherwise free for
        // the garbage collector to take.
        private WinEventProc? _onForeground;

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

        /// <summary>
        /// Puts focus back the moment Teams takes it, rather than at the next
        /// look.
        ///
        /// Looking every 60 ms left Teams in front for as long as it took to
        /// notice, and that was the flash still visible after #19 (#20). A
        /// foreground hook is told of the change as it happens. Its callbacks
        /// arrive inside GetMessage, so this thread waits there, and the
        /// backstop timer is the message that wakes it to end on time.
        /// </summary>
        private void Run()
        {
            _onForeground = (_, _, _, _, _, _, _) => PutBack();
            var hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero,
                _onForeground, 0, 0, WINEVENT_OUTOFCONTEXT);
            var timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, BackstopMs, IntPtr.Zero);
            try
            {
                if (timer == UIntPtr.Zero)
                {
                    // Nothing would wake GetMessage to end the watch.
                    Poll();
                    return;
                }

                // Teams may have come forward before the hook was in place.
                if (!PutBack()) return;

                while (Environment.TickCount64 < Interlocked.Read(ref _until))
                {
                    if (GetMessage(out var msg, IntPtr.Zero, 0, 0) <= 0) return;
                    if (msg.message == WM_TIMER && !PutBack()) return;
                }
            }
            finally
            {
                if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timer);
                if (hook != IntPtr.Zero) UnhookWinEvent(hook);
                GC.KeepAlive(_onForeground);
            }
        }

        private void Poll()
        {
            while (Environment.TickCount64 < Interlocked.Read(ref _until))
            {
                Thread.Sleep(BackstopMs);
                if (!PutBack()) return;
            }
        }

        /// <summary>
        /// Puts focus back if Teams has it. False once there is nothing to put
        /// it back to, which ends the watch.
        /// </summary>
        private bool PutBack()
        {
            try
            {
                if (!IsWindow(_previous)) return false;
                var current = GetForegroundWindow();
                if (current == _previous || current == IntPtr.Zero || !IsTeamsWindow(current)) return true;
                Restore(_previous);
                return true;
            }
            catch { return false; }
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
