<#
    Strict check: samples the foreground window every ~10ms across an invoke, so
    even a brief flash to Teams is caught, and confirms the control actually
    changed state.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\selectors.json"
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
$null = $proc.StandardOutput.ReadToEndAsync()
Start-Sleep -Milliseconds 1500

$shell = New-Object -ComObject Shell.Application
$shell.Explore("$env:USERPROFILE")
Start-Sleep -Seconds 3

$id = 100
foreach ($t in @('mute', 'mute', 'hand', 'react-like', 'blur')) {
    $ref = [W]::GetForegroundWindow()
    $refProc = [W]::Proc($ref)
    $before = if ($t -eq 'mute') { Get-MicName } else { $null }

    $proc.StandardInput.WriteLine(('{{"id":{0},"cmd":"invoke","target":"{1}"}}' -f $id, $t))
    $proc.StandardInput.Flush()

    # Sample tightly for 2.5s.
    $seen = @{}
    $flash = $false
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 2500) {
        $p = [W]::Proc([W]::GetForegroundWindow())
        $seen[$p] = $true
        if ($p -eq 'ms-teams' -and $refProc -ne 'ms-teams') { $flash = $true }
        Start-Sleep -Milliseconds 10
    }

    $after = if ($t -eq 'mute') { Get-MicName } else { $null }
    $changed = if ($t -eq 'mute') { $before -ne $after } else { $null }

    $msg = "  {0,-12} ref={1,-16} sawTeams={2,-6} windows=[{3}]" -f $t, $refProc, $flash, ($seen.Keys -join ',')
    if ($t -eq 'mute') { $msg += "  '$before'->'$after' changed=$changed" }
    Write-Host $msg -ForegroundColor $(if ($flash) { 'Red' } else { 'Green' })
    $id++
    Start-Sleep -Milliseconds 400
}

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }
