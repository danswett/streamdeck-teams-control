<#
    Extends the posted-click approach to the flyout controls.

    If opening the React menu with a posted click does not activate the window,
    the popup appears behind whatever the user is working in and is effectively
    invisible - which is the whole point.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class P {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);

    public const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, MK_LBUTTON = 0x0001;

    public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString(); }
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

    public static IntPtr HwndAt(int x, int y) { POINT pt; pt.X = x; pt.Y = y; return WindowFromPoint(pt); }

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
[void][P]::SetProcessDpiAwareness(2)   # per-monitor aware, so screen coords are real pixels

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-MeetingWindow {
    foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'ms-teams') { continue }
        foreach ($id in @('microphone-button', 'raisehands-button')) {
            $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
            if ($w.FindFirst($TS::Descendants, $c)) { return $w }
        }
    }
    return $null
}
function Find-ById($scope, [string]$id) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
    return $scope.FindFirst($TS::Descendants, $c)
}
function Click-Element($el, [IntPtr]$render) {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { Write-Host "    empty rect" -ForegroundColor Red; return $false }
    $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
    $owner = [P]::HwndAt($cx, $cy)
    Write-Host "    clicking ($cx,$cy) target=$render  (WindowFromPoint -> $owner '$([P]::ClassOf($owner))')"
    [P]::ClickAt($render, $cx, $cy)
    return $true
}

$win = Get-MeetingWindow
if (-not $win) { Write-Host "no meeting" -ForegroundColor Red; return }
$render = [P]::FindRenderWidget([IntPtr]$win.Current.NativeWindowHandle)
Write-Host "render widget: $render"

$shell = New-Object -ComObject Shell.Application
$shell.Explore("$env:USERPROFILE"); Start-Sleep -Seconds 2
$ref = [P]::GetForegroundWindow()
Write-Host "foreground: [$([P]::Proc($ref))]`n"

Write-Host "=== step 1: open React flyout with a posted click ===" -ForegroundColor Cyan
$react = Find-ById $win 'reaction-menu-button'
if (-not $react) { Write-Host "reaction-menu-button not found" -ForegroundColor Red; return }
[void](Click-Element $react $render)
Start-Sleep -Milliseconds 900

$fg = [P]::GetForegroundWindow()
Write-Host ("    foreground now: [{0}] {1}" -f [P]::Proc($fg), $(if ($fg -eq $ref) { 'UNCHANGED' } else { 'CHANGED' })) `
    -ForegroundColor $(if ($fg -eq $ref) { 'Green' } else { 'Red' })

$like = Find-ById $win 'like-button'
Write-Host ("    flyout open (like-button present): {0}" -f ($null -ne $like)) -ForegroundColor $(if ($like) { 'Green' } else { 'Red' })

if ($like) {
    Write-Host "`n=== step 2: click a reaction with a posted click ===" -ForegroundColor Cyan
    [void](Click-Element $like $render)
    Start-Sleep -Milliseconds 1200
    $fg = [P]::GetForegroundWindow()
    Write-Host ("    foreground: [{0}] {1}" -f [P]::Proc($fg), $(if ($fg -eq $ref) { 'UNCHANGED' } else { 'CHANGED' })) `
        -ForegroundColor $(if ($fg -eq $ref) { 'Green' } else { 'Red' })
    $stillOpen = $null -ne (Find-ById $win 'like-button')
    Write-Host ("    flyout still open: {0}" -f $stillOpen) -ForegroundColor $(if ($stillOpen) { 'Yellow' } else { 'Green' })

    if ($stillOpen) {
        Write-Host "`n=== step 3: dismiss by clicking away ===" -ForegroundColor Cyan
        # Click a harmless spot inside the meeting window, away from the menu.
        $wr = $win.Current.BoundingRectangle
        $cx = [int]($wr.X + $wr.Width / 2); $cy = [int]($wr.Y + 80)
        [P]::ClickAt($render, $cx, $cy)
        Start-Sleep -Milliseconds 1000
        $stillOpen2 = $null -ne (Find-ById $win 'like-button')
        $mic = Find-ById $win 'microphone-button'
        Write-Host ("    flyout still open: {0}   toolbar back: {1}" -f $stillOpen2, ($null -ne $mic)) `
            -ForegroundColor $(if (-not $stillOpen2 -and $mic) { 'Green' } else { 'Red' })
    }
}
