using System.Runtime.InteropServices;
using FlaUI.Core.AutomationElements;

namespace TeamsBridge;

/// <summary>
/// Clicks Teams controls by posting mouse messages straight to Chromium's
/// render widget.
///
/// UI Automation's Invoke pattern works, but Chromium activates its window when
/// it runs, so every key press pulled Teams to the front. A posted
/// WM_LBUTTONDOWN/UP goes directly into the target window's message queue
/// instead of through the window manager, so it needs no focus, raises no
/// window, and moves no cursor. Verified against both the toolbar and the
/// flyouts: the control fires and the foreground window never changes.
///
/// Messages must go to the child "Chrome_RenderWidgetHostHWND" window; the
/// top-level Teams window ignores them.
/// </summary>
internal static class InputPoster
{
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hWnd, char[] buffer, int count);

    private delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hWnd);

    private const uint WM_MOUSEMOVE = 0x0200;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint MK_LBUTTON = 0x0001;

    private const string RenderWidgetClass = "Chrome_RenderWidgetHostHWND";

    /// <summary>Finds the Chromium render widget that accepts input for a Teams window.</summary>
    public static IntPtr FindRenderWidget(IntPtr topLevel)
    {
        if (topLevel == IntPtr.Zero || !IsWindow(topLevel)) return IntPtr.Zero;

        var found = IntPtr.Zero;
        EnumChildWindows(topLevel, (hwnd, _) =>
        {
            if (!ClassNameOf(hwnd).Equals(RenderWidgetClass, StringComparison.Ordinal)) return true;
            found = hwnd;
            return false;
        }, IntPtr.Zero);

        return found;
    }

    private static string ClassNameOf(IntPtr hwnd)
    {
        var buffer = new char[256];
        var length = GetClassNameW(hwnd, buffer, buffer.Length);
        return length > 0 ? new string(buffer, 0, length) : "";
    }

    /// <summary>Clicks the centre of an element. Returns false if it has no usable bounds.</summary>
    public static bool TryClick(IntPtr renderWidget, AutomationElement element)
    {
        try
        {
            var rect = element.BoundingRectangle;
            if (rect.Width <= 0 || rect.Height <= 0) return false;
            return TryClickPoint(renderWidget, rect.X + rect.Width / 2, rect.Y + rect.Height / 2);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Clicks a screen point by posting to the render widget's queue.</summary>
    public static bool TryClickPoint(IntPtr renderWidget, int screenX, int screenY)
    {
        if (renderWidget == IntPtr.Zero || !IsWindow(renderWidget)) return false;

        var point = new POINT { X = screenX, Y = screenY };
        if (!ScreenToClient(renderWidget, ref point)) return false;

        var lParam = MakeLParam(point.X, point.Y);

        // The move first, so hover state is applied before the press.
        PostMessage(renderWidget, WM_MOUSEMOVE, IntPtr.Zero, lParam);
        if (!PostMessage(renderWidget, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lParam)) return false;
        return PostMessage(renderWidget, WM_LBUTTONUP, IntPtr.Zero, lParam);
    }

    private static IntPtr MakeLParam(int x, int y) => (IntPtr)((y << 16) | (x & 0xFFFF));
}
