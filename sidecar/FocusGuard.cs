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
    public static void RestoreAfter(IntPtr previous, int watchMs = 1500)
    {
        if (previous == IntPtr.Zero) return;

        var watcher = new Thread(() =>
        {
            var deadline = Environment.TickCount64 + watchMs;
            while (Environment.TickCount64 < deadline)
            {
                Thread.Sleep(60);
                try
                {
                    if (!IsWindow(previous)) return;
                    var current = GetForegroundWindow();
                    if (current == previous) continue;
                    if (current == IntPtr.Zero || !IsTeamsWindow(current)) continue;
                    Restore(previous);
                }
                catch { return; }
            }
        })
        {
            IsBackground = true,
            Name = "focus-guard"
        };
        watcher.Start();
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
