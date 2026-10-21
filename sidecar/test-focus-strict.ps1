<#
    Strict check: records every change of foreground window across an invoke, so
    even a brief flash to Teams is caught and timed, and confirms the control
    actually changed state.

    Recording lasts until the press has finished closing its flyout - the sidecar
    reports state once that cleanup is done - and a moment beyond, because
    Chromium activates its window asynchronously. A fixed 2.5s stopped before
    the cleanup's UI Automation fallbacks ran, and they were leaving Teams in
    front (#18).

    Changes are taken from a foreground hook as they happen rather than sampled.
    Sampling from this loop looked every 30-60 ms at best, so a flash could be
    missed outright and one that was caught was timed in whole sampling
    intervals - too coarse to tell a faster focus guard from a slower one (#20).

    -ForceFallback starts the sidecar with click-away turned off, so every
    flyout has to be closed by the fallbacks a crowded meeting or a presented
    deck would reach. That is where Teams can still come forward.

    Yellow is a brief flash the focus guard put right; red is Teams still in
    front when recording stopped.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json",
    # Ceiling on one press and its cleanup, in case the state never arrives.
    [int]$MaxMs = 12000,
    [switch]$ForceFallback,
    # Toggles run twice, so the meeting is left as it was found.
    [string[]]$Targets = @('mute', 'mute', 'hand', 'hand', 'react-like', 'blur', 'blur')
)

Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class W {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }
}

public class StrictForegroundChange {
    public double At;
    public int Pid;
}

// Every change of foreground window, timed as it is reported. Named for this
// script so another script's recorder in the same session cannot collide.
public static class StrictForegroundLog {
    public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; public uint lPrivate; }

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", EntryPoint = "GetMessageW")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    const uint EVENT_SYSTEM_FOREGROUND = 3;
    const uint WM_QUIT = 0x0012;

    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly List<StrictForegroundChange> Changes = new List<StrictForegroundChange>();
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
                IntPtr hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, callback, 0, 0, 0);
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
            PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            worker.Join(1000);
            worker = null;
        }
    }

    static void OnChange(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        lock (Changes) { Changes.Add(new StrictForegroundChange { At = Now(), Pid = (int)pid }); }
    }

    public static StrictForegroundChange[] Between(double from, double to) {
        lock (Changes) { return Changes.FindAll(c => c.At >= from && c.At <= to).ToArray(); }
    }
}
'@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-MicName {
    foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'ms-teams') { continue }
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
        $el = $w.FindFirst($TS::Descendants, $c)
        if ($el) { return $el.Current.Name }
    }
    return $null
}

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
if ($ForceFallback) {
    $psi.EnvironmentVariables['TEAMSBRIDGE_NO_CLICK_AWAY'] = '1'
    Write-Host "click-away is off: every flyout is closed by the fallbacks" -ForegroundColor Cyan
}
$proc = [System.Diagnostics.Process]::Start($psi)

# Read as it arrives rather than discarded: the state that follows a press's
# result is the sign its flyout cleanup has finished.
$script:stdout = $proc.StandardOutput
$script:pending = $script:stdout.ReadLineAsync()
function Read-Ready {
    while ($null -ne $script:pending -and $script:pending.IsCompleted) {
        $line = $script:pending.Result
        if ($null -eq $line) { $script:pending = $null; return }
        $line
        $script:pending = $script:stdout.ReadLineAsync()
    }
}
Start-Sleep -Milliseconds 1500

$shell = New-Object -ComObject Shell.Application
$shell.Explore("$env:USERPROFILE")
Start-Sleep -Seconds 3

[StrictForegroundLog]::Start()
try {
    $procNames = @{}
    function Get-ProcName([int]$procId) {
        if (-not $procNames.ContainsKey($procId)) {
            $procNames[$procId] = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
        }
        $procNames[$procId]
    }

    $id = 100
    $worstMs = 0.0
    $totalFlashes = 0
    foreach ($t in $Targets) {
        $ref = [W]::GetForegroundWindow()
        $refProc = [W]::Proc($ref)
        $before = if ($t -eq 'mute') { Get-MicName } else { $null }

        $null = @(Read-Ready)
        $from = [StrictForegroundLog]::Now()
        $proc.StandardInput.WriteLine(('{{"id":{0},"cmd":"invoke","target":"{1}"}}' -f $id, $t))
        $proc.StandardInput.Flush()

        $resultAt = $null
        $doneAt = $null
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($sw.ElapsedMilliseconds -lt $MaxMs) {
            foreach ($line in @(Read-Ready)) {
                if ($null -eq $resultAt) {
                    if ($line -match ('"type":"result","id":{0}[,}}]' -f $id)) { $resultAt = $sw.ElapsedMilliseconds }
                } elseif ($null -eq $doneAt -and $line -match '"type":"state"') {
                    $doneAt = $sw.ElapsedMilliseconds
                }
            }
            if ($null -ne $doneAt -and $sw.ElapsedMilliseconds -gt $doneAt + 1600) { break }
            Start-Sleep -Milliseconds 20
        }
        $to = [StrictForegroundLog]::Now()

        # Replays the foreground changes: time spent with Teams in front, and how
        # many separate times it came there.
        $seen = @{ $refProc = $true }
        $inTeams = $refProc -eq 'ms-teams'
        $since = $from
        $teamsMs = 0.0
        $flashes = 0
        foreach ($change in [StrictForegroundLog]::Between($from, $to)) {
            $name = Get-ProcName $change.Pid
            $seen[$name] = $true
            $isTeams = $name -eq 'ms-teams'
            if ($isTeams -and -not $inTeams) { $flashes++; $since = $change.At }
            elseif ($inTeams -and -not $isTeams) { $teamsMs += $change.At - $since }
            $inTeams = $isTeams
        }
        if ($inTeams) { $teamsMs += $to - $since }
        if ($refProc -eq 'ms-teams') { $teamsMs = 0.0; $flashes = 0 }
        $stolen = $refProc -ne 'ms-teams' -and $inTeams
        $flash = $flashes -gt 0
        $worstMs = [Math]::Max($worstMs, $teamsMs)
        $totalFlashes += $flashes

        $after = if ($t -eq 'mute') { Get-MicName } else { $null }
        $changed = if ($t -eq 'mute') { $before -ne $after } else { $null }

        $done = if ($null -ne $doneAt) { "${doneAt}ms" } else { 'never' }
        $msg = "  {0,-12} ref={1,-16} flashes={2,-2} teamsMs={3,-7:0.0} stolen={4,-6} done={5,-8} windows=[{6}]" -f $t, $refProc, $flashes, $teamsMs, $stolen, $done, ($seen.Keys -join ',')
        if ($t -eq 'mute') { $msg += "  '$before'->'$after' changed=$changed" }
        Write-Host $msg -ForegroundColor $(if ($stolen) { 'Red' } elseif ($flash) { 'Yellow' } else { 'Green' })
        $id++
        Start-Sleep -Milliseconds 400
    }

    Write-Host ("`nTeams came forward {0} time(s); longest in front for one press: {1:0.0} ms" -f $totalFlashes, $worstMs) `
        -ForegroundColor $(if ($totalFlashes -eq 0) { 'Green' } else { 'Yellow' })
}
finally {
    [StrictForegroundLog]::Stop()
    try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
    if (-not $proc.WaitForExit(5000)) { $proc.Kill() }
}
