<#
    Tests clicking a Teams control by posting mouse messages straight to
    Chromium's render widget window.

    A real click activates a background window because the window manager
    routes it. A posted WM_LBUTTONDOWN/UP goes directly into the target
    window's message queue, so it should neither require focus nor raise the
    window - if Chromium honours synthetic mouse input at all.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class M {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);

    public const uint WM_MOUSEMOVE   = 0x0200;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP   = 0x0202;
    public const uint MK_LBUTTON     = 0x0001;

    public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString(); }
    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }

    public static IntPtr MakeLParam(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

    public static IntPtr FindRenderWidget(IntPtr top) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(top, delegate(IntPtr h, IntPtr p) {
            if (ClassOf(h) == "Chrome_RenderWidgetHostHWND") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void ClickAt(IntPtr target, int screenX, int screenY) {
        POINT pt; pt.X = screenX; pt.Y = screenY;
        ScreenToClient(target, ref pt);
        IntPtr lp = MakeLParam(pt.X, pt.Y);
        PostMessage(target, WM_MOUSEMOVE,   IntPtr.Zero,        lp);
        PostMessage(target, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lp);
        PostMessage(target, WM_LBUTTONUP,   IntPtr.Zero,        lp);
    }
}
'@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

$win = $null; $mic = $null
foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'ms-teams') { continue }
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
    $m = $w.FindFirst($TS::Descendants, $c)
    if ($m) { $win = $w; $mic = $m; break }
}
if (-not $mic) { Write-Host "no meeting / mute button" -ForegroundColor Red; return }

$topHwnd = [IntPtr]$win.Current.NativeWindowHandle
Write-Host "meeting window hwnd=$topHwnd '$($win.Current.Name)'"

$render = [M]::FindRenderWidget($topHwnd)
Write-Host "render widget hwnd=$render class='$(if ($render -ne [IntPtr]::Zero) { [M]::ClassOf($render) } else { 'NOT FOUND' })'"

$r = $mic.Current.BoundingRectangle
$cx = [int]($r.X + $r.Width / 2)
$cy = [int]($r.Y + $r.Height / 2)
Write-Host "mute button centre: ($cx, $cy)  rect=$r"

$targets = @()
if ($render -ne [IntPtr]::Zero) { $targets += , @('render widget', $render) }
$targets += , @('top-level window', $topHwnd)

foreach ($t in $targets) {
    $label = $t[0]; $hwnd = $t[1]
    # Park focus somewhere else first.
    $shell = New-Object -ComObject Shell.Application
    $shell.Explore("$env:USERPROFILE")
    Start-Sleep -Seconds 2
    $ref = [M]::GetForegroundWindow()

    $before = $mic.Current.Name
    Write-Host "`n=== posting click to $label ===" -ForegroundColor Cyan
    Write-Host "  foreground before: [$([M]::Proc($ref))]"
    Write-Host "  mic before: '$before'"

    [M]::ClickAt($hwnd, $cx, $cy)

    $stolen = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 50
        $fg = [M]::GetForegroundWindow()
        if ($fg -ne $ref -and [M]::Proc($fg) -eq 'ms-teams') { $stolen = $true; break }
    }
    Start-Sleep -Milliseconds 600

    $after = $mic.Current.Name
    Write-Host "  mic after:  '$after'"
    Write-Host ("  state changed: {0}" -f ($before -ne $after)) -ForegroundColor $(if ($before -ne $after) { 'Green' } else { 'Red' })
    Write-Host ("  stole focus:   {0}" -f $stolen) -ForegroundColor $(if ($stolen) { 'Red' } else { 'Green' })
}
