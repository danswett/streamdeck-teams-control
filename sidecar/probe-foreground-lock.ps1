<#
    Tests whether LockSetForegroundWindow can stop Teams activating its window
    during a UI Automation invoke.

    LockSetForegroundWindow disables SetForegroundWindow system-wide until
    unlocked, but "the calling thread must be able to set the foreground
    window". A background process cannot - unless it first attaches its input
    queue to the current foreground thread, which is what this checks.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class L {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool LockSetForegroundWindow(uint uLockCode);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] public static extern uint GetLastError();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }

    public const uint LSFW_LOCK = 1;
    public const uint LSFW_UNLOCK = 2;

    static uint attachedTo = 0;

    public static string Lock() {
        IntPtr fg = GetForegroundWindow();
        uint self = GetCurrentThreadId();
        uint tmp;
        uint fgThread = GetWindowThreadProcessId(fg, out tmp);
        bool attached = fgThread != 0 && fgThread != self && AttachThreadInput(self, fgThread, true);
        attachedTo = attached ? fgThread : 0;
        bool ok = LockSetForegroundWindow(LSFW_LOCK);
        return "attached=" + attached + " lock=" + ok + " err=" + (ok ? 0 : GetLastError());
    }

    public static string Unlock() {
        bool ok = LockSetForegroundWindow(LSFW_UNLOCK);
        if (attachedTo != 0) { AttachThreadInput(GetCurrentThreadId(), attachedTo, false); attachedTo = 0; }
        return "unlock=" + ok;
    }
}
'@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

# Locate the mute button up front so the invoke is a single quick call.
$mic = $null
foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'ms-teams') { continue }
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
    $mic = $w.FindFirst($TS::Descendants, $c)
    if ($mic) { break }
}
if (-not $mic) { Write-Host "no meeting / mute button" -ForegroundColor Red; return }

# Reference foreground window.
$shell = New-Object -ComObject Shell.Application
$shell.Explore("$env:USERPROFILE")
Start-Sleep -Seconds 3

function Test-Invoke([string]$label, [bool]$useLock) {
    $ref = [L]::GetForegroundWindow()
    Write-Host "`n=== $label ===" -ForegroundColor Cyan
    Write-Host "  before: [$([L]::Proc($ref))] '$([L]::Title($ref))'"
    Write-Host "  mic name before: '$($mic.Current.Name)'"

    if ($useLock) { Write-Host "  $([L]::Lock())" }
    try {
        $inv = $mic.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $inv.Invoke()
    }
    catch { Write-Host "  invoke failed: $($_.Exception.Message)" -ForegroundColor Red }

    # Sample rapidly to catch a brief flash.
    $stolen = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 40
        $fg = [L]::GetForegroundWindow()
        if ($fg -ne $ref -and [L]::Proc($fg) -eq 'ms-teams') { $stolen = $true; break }
    }

    if ($useLock) { Write-Host "  $([L]::Unlock())" }

    Start-Sleep -Milliseconds 600
    $after = [L]::GetForegroundWindow()
    Write-Host "  mic name after:  '$($mic.Current.Name)'"
    Write-Host ("  foreground ever became Teams: {0}" -f $stolen) -ForegroundColor $(if ($stolen) { 'Red' } else { 'Green' })
    Write-Host "  final foreground: [$([L]::Proc($after))]"
}

Test-Invoke "WITHOUT lock (baseline)" $false
Start-Sleep -Seconds 2
$shell.Explore("$env:USERPROFILE"); Start-Sleep -Seconds 2
Test-Invoke "WITH LockSetForegroundWindow" $true
