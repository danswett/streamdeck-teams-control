<#
    Strict check: samples the foreground window every ~10ms across an invoke, so
    even a brief flash to Teams is caught, and confirms the control actually
    changed state.

    Sampling lasts until the press has finished closing its flyout - the sidecar
    reports state once that cleanup is done - and a moment beyond, because
    Chromium activates its window asynchronously. A fixed 2.5s stopped before
    the cleanup's UI Automation fallbacks ran, and they were leaving Teams in
    front (#18).

    Yellow is a brief flash the focus guard put right; red is Teams still in
    front when sampling stopped.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json",
    # Ceiling on one press and its cleanup, in case the state never arrives.
    [int]$MaxMs = 12000
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
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

$id = 100
# Toggles run twice, so the meeting is left as it was found.
foreach ($t in @('mute', 'mute', 'hand', 'hand', 'react-like', 'blur', 'blur')) {
    $ref = [W]::GetForegroundWindow()
    $refProc = [W]::Proc($ref)
    $before = if ($t -eq 'mute') { Get-MicName } else { $null }

    $null = @(Read-Ready)
    $proc.StandardInput.WriteLine(('{{"id":{0},"cmd":"invoke","target":"{1}"}}' -f $id, $t))
    $proc.StandardInput.Flush()

    $seen = @{}
    $flash = $false
    $teamsMs = 0
    $resultAt = $null
    $doneAt = $null
    $last = 0
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

        $p = [W]::Proc([W]::GetForegroundWindow())
        $seen[$p] = $true
        $now = $sw.ElapsedMilliseconds
        if ($p -eq 'ms-teams' -and $refProc -ne 'ms-teams') {
            $flash = $true
            $teamsMs += $now - $last
        }
        $last = $now
        Start-Sleep -Milliseconds 10
    }
    $stolen = $refProc -ne 'ms-teams' -and [W]::Proc([W]::GetForegroundWindow()) -eq 'ms-teams'

    $after = if ($t -eq 'mute') { Get-MicName } else { $null }
    $changed = if ($t -eq 'mute') { $before -ne $after } else { $null }

    $done = if ($null -ne $doneAt) { "${doneAt}ms" } else { 'never' }
    $msg = "  {0,-12} ref={1,-16} sawTeams={2,-6} teamsMs={3,-5} stolen={4,-6} done={5,-8} windows=[{6}]" -f $t, $refProc, $flash, $teamsMs, $stolen, $done, ($seen.Keys -join ',')
    if ($t -eq 'mute') { $msg += "  '$before'->'$after' changed=$changed" }
    Write-Host $msg -ForegroundColor $(if ($stolen) { 'Red' } elseif ($flash) { 'Yellow' } else { 'Green' })
    $id++
    Start-Sleep -Milliseconds 400
}

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }
