<#
    Measures whether invoking a Teams control steals foreground focus.

    A reference window is brought to the foreground first, then each control is
    invoked through the sidecar and the foreground window is sampled again.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\selectors.json",
    [string[]]$Targets = @('mute', 'mute', 'camera', 'camera', 'hand', 'hand', 'react-like', 'blur', 'blur')
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Fg {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }
}
'@

# Use an explorer window as the neutral reference foreground.
$shell = New-Object -ComObject Shell.Application
$shell.Explore("$env:USERPROFILE")
Start-Sleep -Seconds 3
$reference = [Fg]::GetForegroundWindow()
Write-Host "reference foreground: '$([Fg]::Title($reference))' [$([Fg]::Proc($reference))]" -ForegroundColor Cyan

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$outTask = $proc.StandardOutput.ReadToEndAsync()

Start-Sleep -Milliseconds 1500

$results = @()
$i = 10
foreach ($t in $Targets) {
    # Re-assert the reference window before each probe.
    [void][Fg]::SetForegroundWindow($reference)
    Start-Sleep -Milliseconds 700
    $before = [Fg]::Proc([Fg]::GetForegroundWindow())

    $proc.StandardInput.WriteLine(('{{"id":{0},"cmd":"invoke","target":"{1}"}}' -f $i, $t))
    $proc.StandardInput.Flush()
    Start-Sleep -Milliseconds 2600

    $after = [Fg]::Proc([Fg]::GetForegroundWindow())
    $stolen = ($before -ne $after -and $after -eq 'ms-teams')
    $results += [PSCustomObject]@{ Target = $t; Before = $before; After = $after; Stolen = $stolen }
    Write-Host ("  {0,-14} {1,-12} -> {2,-12} {3}" -f $t, $before, $after, $(if ($stolen) { "STOLE FOCUS" } else { "ok" })) `
        -ForegroundColor $(if ($stolen) { 'Red' } else { 'Green' })
    $i++
}

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }

Write-Host "`n===== SUMMARY =====" -ForegroundColor Yellow
$results | Group-Object Target | ForEach-Object {
    $any = ($_.Group | Where-Object { $_.Stolen }).Count
    "{0,-14} stole focus in {1}/{2} attempts" -f $_.Name, $any, $_.Count
}
