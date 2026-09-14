<#
    Isolates why a posted click on the React menu button opens the flyout only
    on alternate attempts.

    Cycle A: open, dismiss by clicking away (no item click).
    Cycle B: open, click an item, (menu closes itself).
    Comparing the two shows whether the item click is what leaves bad state.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Q {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);

    public const uint WM_MOUSEMOVE=0x0200, WM_LBUTTONDOWN=0x0201, WM_LBUTTONUP=0x0202, MK_LBUTTON=0x0001;
    public static string ClassOf(IntPtr h){var sb=new StringBuilder(256);GetClassNameW(h,sb,sb.Capacity);return sb.ToString();}
    public static IntPtr LP(int x,int y){return (IntPtr)((y<<16)|(x&0xFFFF));}
    public static IntPtr FindRender(IntPtr top){
        IntPtr f=IntPtr.Zero;
        EnumChildWindows(top, delegate(IntPtr h, IntPtr p){ if(ClassOf(h)=="Chrome_RenderWidgetHostHWND"){f=h;return false;} return true;}, IntPtr.Zero);
        return f;
    }
    public static void Move(IntPtr t,int sx,int sy){POINT p;p.X=sx;p.Y=sy;ScreenToClient(t,ref p);PostMessage(t,WM_MOUSEMOVE,IntPtr.Zero,LP(p.X,p.Y));}
    public static void Down(IntPtr t,int sx,int sy){POINT p;p.X=sx;p.Y=sy;ScreenToClient(t,ref p);PostMessage(t,WM_LBUTTONDOWN,(IntPtr)MK_LBUTTON,LP(p.X,p.Y));}
    public static void Up(IntPtr t,int sx,int sy){POINT p;p.X=sx;p.Y=sy;ScreenToClient(t,ref p);PostMessage(t,WM_LBUTTONUP,IntPtr.Zero,LP(p.X,p.Y));}
}
'@
[void][Q]::SetProcessDpiAwareness(2)

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-Win {
    foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'ms-teams') { continue }
        foreach ($id in @('microphone-button', 'raisehands-button')) {
            $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
            if ($w.FindFirst($TS::Descendants, $c)) { return $w }
        }
    }
    return $null
}
function ById($scope, [string]$id) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
    return $scope.FindFirst($TS::Descendants, $c)
}
function Centre($el) {
    $r = $el.Current.BoundingRectangle
    return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
}
function Click([IntPtr]$render, [int]$x, [int]$y, [int]$gap) {
    [Q]::Move($render, $x, $y)
    if ($gap) { Start-Sleep -Milliseconds $gap }
    [Q]::Down($render, $x, $y)
    if ($gap) { Start-Sleep -Milliseconds $gap }
    [Q]::Up($render, $x, $y)
}

$win = Get-Win
$render = [Q]::FindRender([IntPtr]$win.Current.NativeWindowHandle)
Write-Host "render=$render`n"

function Cycle([string]$label, [string]$after, [int]$gap) {
    $win = Get-Win
    $react = ById $win 'reaction-menu-button'
    if (-not $react) { Write-Host "  $label : menu button NOT in tree (flyout stuck open?)" -ForegroundColor Red; return }
    $rc = Centre $react
    Click $render $rc[0] $rc[1] $gap
    Start-Sleep -Milliseconds 900

    $win2 = Get-Win
    $like = ById $win2 'like-button'
    $opened = $null -ne $like
    Write-Host ("  {0,-26} opened={1}" -f $label, $opened) -ForegroundColor $(if ($opened) { 'Green' } else { 'Red' })
    if (-not $opened) { return }

    $wr = $win2.Current.BoundingRectangle
    $ax = [int]($wr.X + $wr.Width / 2)
    $ay = [int]($wr.Y + 80)

    switch ($after) {
        'away' { Click $render $ax $ay $gap }
        'item' {
            $ic = Centre $like
            Click $render $ic[0] $ic[1] $gap
        }
        'item+move' {
            $ic = Centre $like
            Click $render $ic[0] $ic[1] $gap
            Start-Sleep -Milliseconds 250
            # Hover reset only - no button press, so no side effects.
            [Q]::Move($render, $ax, $ay)
        }
    }
    Start-Sleep -Milliseconds 1100
}

Write-Host "=== cycle A: open + click AWAY ===" -ForegroundColor Cyan
for ($i = 1; $i -le 3; $i++) { Cycle "A$i" 'away' 0 }

Write-Host "`n=== cycle B: open + click ITEM ===" -ForegroundColor Cyan
for ($i = 1; $i -le 3; $i++) { Cycle "B$i" 'item' 0 }

Write-Host "`n=== cycle D: open + click ITEM + MOUSEMOVE away (no press) ===" -ForegroundColor Cyan
for ($i = 1; $i -le 4; $i++) { Cycle "D$i" 'item+move' 0 }
