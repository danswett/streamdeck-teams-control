<#
    Tests whether a posted Escape closes a Teams flyout while Teams is in the
    background, and what the same key does when no flyout is open (#20).

    DismissFlyout's fallbacks - UI Automation Collapse and Invoke - activate the
    Teams window. A posted click does not, which is why presses use one, but a
    click at a remembered point can land on the wrong control while PowerPoint
    Live re-renders the toolbar. Escape aims at nothing on screen: if Chromium
    acts on it for a background window, it closes the open menu without
    activating anything and without a click.

    For each flyout this opens it with a posted click, then posts Escape to the
    render widget and, failing that, to the widget's parent, and reports which
    closed it and whether the foreground ever changed. A menu Escape cannot
    close is closed by clicking its button again.

    Then it posts Escape with nothing open, which is what DismissFlyout would
    risk if the menu closed on its own a moment before. It reports anything in
    the meeting that changed - run it while presenting a deck too, since that
    is where an Escape reaching the page could matter.

    -AfterSelection also chooses a reaction first (a Like, visible to anyone in
    the meeting), because Teams treats the next click on a menu button
    differently once something in it has been chosen.

    Run it in a meeting with nobody else in it.
#>
param(
    [string[]]$Menus = @('reaction-menu-button', 'video-button-configure'),
    [switch]$AfterSelection
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
public static class EscProbe {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);

    public const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, MK_LBUTTON = 0x0001;
    public const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, VK_ESCAPE = 0x1B;
    public const uint GA_PARENT = 1;

    public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString(); }
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
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

    // Escape's scan code is 1. Key-up also sets the previous-state and
    // transition bits, as a real key-up does.
    public static bool PostEscape(IntPtr target) {
        bool down = PostMessage(target, WM_KEYDOWN, (IntPtr)VK_ESCAPE, (IntPtr)0x00010001);
        bool up = PostMessage(target, WM_KEYUP, (IntPtr)VK_ESCAPE, (IntPtr)unchecked((int)0xC0010001));
        return down && up;
    }
}

public class EscProbeForegroundChange { public double At; public int Pid; }

// Named for this script so another script's recorder in the same session
// cannot collide with it.
public static class EscProbeForegroundLog {
    public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; public uint lPrivate; }
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", EntryPoint = "GetMessageW")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly List<EscProbeForegroundChange> Changes = new List<EscProbeForegroundChange>();
    static readonly object Gate = new object();
    static Thread worker;
    static uint threadId;
    public static double Now() { return Clock.Elapsed.TotalMilliseconds; }
    // A run interrupted before Stop leaves its recorder going; the next run in
    // the same session carries on with it rather than installing a second hook.
    public static void Start() {
        lock (Gate) {
            if (worker != null && worker.IsAlive) return;
            var ready = new ManualResetEvent(false);
            worker = new Thread(() => {
                threadId = GetCurrentThreadId();
                // Local, and kept alive past the unhook: the hook calls back
                // through it, and nothing else in managed code refers to it.
                WinEventProc callback = OnChange;
                IntPtr hook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
                ready.Set();
                MSG msg;
                while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
                UnhookWinEvent(hook);
                GC.KeepAlive(callback);
            });
            worker.IsBackground = true;
            worker.Start();
            ready.WaitOne();
        }
    }
    public static void Stop() {
        lock (Gate) {
            if (worker == null) return;
            PostThreadMessage(threadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
            worker.Join(1000);
            worker = null;
        }
    }
    // Chromium raises this event itself for accessibility, naming windows that
    // are not in front, so an event is only a cue to read what actually is -
    // by the top of its parent and owner chain, and only when it has changed.
    static IntPtr lastRoot;
    static void OnChange(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
        IntPtr fg = GetForegroundWindow();
        IntPtr root = GetAncestor(fg, 3);   // GA_ROOTOWNER
        if (root == IntPtr.Zero) root = fg;
        lock (Changes) {
            if (root == lastRoot) return;
            lastRoot = root;
            uint pid; GetWindowThreadProcessId(root, out pid);
            Changes.Add(new EscProbeForegroundChange { At = Now(), Pid = (int)pid });
        }
    }
    public static EscProbeForegroundChange[] Between(double from, double to) {
        lock (Changes) { return Changes.FindAll(c => c.At >= from && c.At <= to).ToArray(); }
    }
}
'@
[void][EscProbe]::SetProcessDpiAwareness(2)   # per-monitor aware, so screen coords are real pixels

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

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
function Test-ToolbarVisible { $null -ne (Find-ById $script:win 'microphone-button') }
function Wait-Toolbar([bool]$visible, [int]$ms) {
    $until = [Environment]::TickCount + $ms
    do {
        if ((Test-ToolbarVisible) -eq $visible) { return $true }
        Start-Sleep -Milliseconds 80
    } while ([Environment]::TickCount -lt $until)
    return $false
}
function Get-Center($el) {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { return $null }
    return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
}

# Everything the meeting shows that a stray Escape could plausibly change: the
# buttons present, and the slide counter while a deck is up.
function Get-MeetingState {
    $ids = @()
    $slide = ''
    $c = New-Object System.Windows.Automation.OrCondition(
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)),
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)))
    foreach ($el in $script:win.FindAll($TS::Descendants, $c)) {
        $id = $el.Current.AutomationId
        if ($id) { $ids += $id }
        if ($el.Current.Name -match '^\s*\d+\s*(?:of|/)\s*\d+\s*$') { $slide = $el.Current.Name }
    }
    [pscustomobject]@{ Ids = @($ids | Sort-Object -Unique); Slide = $slide }
}

# Foreground changes since a moment, named by process.
function Get-ForegroundTrail([double]$from) {
    $names = foreach ($change in [EscProbeForegroundLog]::Between($from, [EscProbeForegroundLog]::Now())) {
        (Get-Process -Id $change.Pid -ErrorAction SilentlyContinue).ProcessName
    }
    if ($names) { $names -join ' -> ' } else { 'none' }
}

$script:win = Get-MeetingWindow
if (-not $script:win) { Write-Host "no meeting" -ForegroundColor Red; return }
$render = [EscProbe]::FindRenderWidget([IntPtr]$script:win.Current.NativeWindowHandle)
$parent = [EscProbe]::GetAncestor($render, [EscProbe]::GA_PARENT)
Write-Host ("render widget: {0} [{1}]  parent: {2} [{3}, {4}]" -f $render, [EscProbe]::Proc($render), $parent, [EscProbe]::ClassOf($parent), [EscProbe]::Proc($parent))

$shell = New-Object -ComObject Shell.Application
$shell.Explore("$env:USERPROFILE"); Start-Sleep -Seconds 2
$ref = [EscProbe]::GetForegroundWindow()
Write-Host "foreground: [$([EscProbe]::Proc($ref))]`n"
[EscProbeForegroundLog]::Start()
try {

    foreach ($menu in $Menus) {
        Write-Host "=== $menu ===" -ForegroundColor Cyan
        if (-not (Wait-Toolbar $true 1500)) { Write-Host "    toolbar is not showing; skipping" -ForegroundColor Red; continue }
        $host_ = Find-ById $script:win $menu
        $hostPoint = if ($host_) { Get-Center $host_ } else { $null }
        if (-not $hostPoint) { Write-Host "    '$menu' not found" -ForegroundColor Red; continue }

        $from = [EscProbeForegroundLog]::Now()
        [EscProbe]::ClickAt($render, $hostPoint[0], $hostPoint[1])
        if (-not (Wait-Toolbar $false 1500)) { Write-Host "    did not open" -ForegroundColor Red; continue }
        Write-Host "    opened with a posted click; foreground changes: $(Get-ForegroundTrail $from)"

        if ($AfterSelection -and $menu -eq 'reaction-menu-button') {
            $like = Find-ById $script:win 'like-button'
            $likePoint = if ($like) { Get-Center $like } else { $null }
            if ($likePoint) {
                [EscProbe]::ClickAt($render, $likePoint[0], $likePoint[1])
                Start-Sleep -Milliseconds 1500
                Write-Host ("    chose Like; flyout still open: {0}" -f (-not (Test-ToolbarVisible)))
                if (Test-ToolbarVisible) {
                    Write-Host "    closed by itself, nothing left to test after a selection" -ForegroundColor Yellow
                    continue
                }
            }
        }

        $closedBy = $null
        foreach ($target in @(@('render widget', $render), @('parent', $parent))) {
            $from = [EscProbeForegroundLog]::Now()
            $posted = [EscProbe]::PostEscape($target[1])
            $closed = Wait-Toolbar $true 800
            Write-Host ("    Escape to {0}: posted={1} closed={2} foreground changes: {3}" -f $target[0], $posted, $closed, (Get-ForegroundTrail $from)) `
                -ForegroundColor $(if ($closed) { 'Green' } else { 'Yellow' })
            if ($closed) { $closedBy = $target[0]; break }
        }

        if (-not $closedBy) {
            $from = [EscProbeForegroundLog]::Now()
            [EscProbe]::ClickAt($render, $hostPoint[0], $hostPoint[1])
            $closed = Wait-Toolbar $true 900
            Write-Host ("    clicking '{0}' again: closed={1} foreground changes: {2}" -f $menu, $closed, (Get-ForegroundTrail $from)) `
                -ForegroundColor $(if ($closed) { 'Green' } else { 'Red' })
            if (-not $closed) { Write-Host "    close the menu by hand before going on" -ForegroundColor Red; return }
        }

        # The press after a selection: Teams has been seen to swallow it.
        $from = [EscProbeForegroundLog]::Now()
        [EscProbe]::ClickAt($render, $hostPoint[0], $hostPoint[1])
        $reopened = Wait-Toolbar $false 1500
        Write-Host ("    next press opens it first time: {0}" -f $reopened) -ForegroundColor $(if ($reopened) { 'Green' } else { 'Yellow' })
        if ($reopened) {
            [EscProbe]::ClickAt($render, $hostPoint[0], $hostPoint[1])
            if (-not (Wait-Toolbar $true 1200)) { [void][EscProbe]::PostEscape($render); [void](Wait-Toolbar $true 800) }
        }
        Write-Host ""
    }

    Write-Host "=== Escape with nothing open ===" -ForegroundColor Cyan
    if (Wait-Toolbar $true 1500) {
        $before = Get-MeetingState
        $from = [EscProbeForegroundLog]::Now()
        [void][EscProbe]::PostEscape($render)
        Start-Sleep -Milliseconds 1000
        $after = Get-MeetingState
        $gone = @($before.Ids | Where-Object { $after.Ids -notcontains $_ })
        $new = @($after.Ids | Where-Object { $before.Ids -notcontains $_ })
        $quiet = $gone.Count -eq 0 -and $new.Count -eq 0 -and $before.Slide -eq $after.Slide
        Write-Host ("    controls gone: [{0}]  new: [{1}]  slide: '{2}' -> '{3}'  foreground changes: {4}" -f `
            ($gone -join ', '), ($new -join ', '), $before.Slide, $after.Slide, (Get-ForegroundTrail $from)) `
            -ForegroundColor $(if ($quiet) { 'Green' } else { 'Red' })
    } else {
        Write-Host "    toolbar is not showing; skipped" -ForegroundColor Red
    }
}
finally {
    [EscProbeForegroundLog]::Stop()
}
