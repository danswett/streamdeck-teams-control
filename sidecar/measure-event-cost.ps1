<#
    A/B: how much does each mechanism cost while idle?

    Runs the sidecar with and without UI Automation subscriptions and compares
    CPU and memory. The window-opened subscription covers the whole desktop, so
    every window opening anywhere is marshalled into this process - worth
    knowing whether that costs more than it saves.
#>
param(
    [string]$Exe = "$env:TEMP\tb-dbg\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\selectors.json",
    [int]$Seconds = 45
)

function Measure-Variant([string]$label, [string]$extraArgs) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Exe
    $psi.Arguments = "--selectors `"$Selectors`" $extraArgs".Trim()
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $null = $p.StandardOutput.ReadToEndAsync()
    $null = $p.StandardError.ReadToEndAsync()

    # Let start-up settle so JIT and the first scan are not counted.
    Start-Sleep -Seconds 12
    $p.Refresh()
    $t1 = $p.TotalProcessorTime

    $wsSum = 0.0; $privSum = 0.0; $n = 0
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try { $p.Refresh(); $wsSum += $p.WorkingSet64; $privSum += $p.PrivateMemorySize64; $n++ } catch { break }
    }

    $p.Refresh()
    $cpu = (($p.TotalProcessorTime - $t1).TotalSeconds / $Seconds) * 100
    $ws = if ($n) { $wsSum / $n / 1MB } else { 0 }
    $priv = if ($n) { $privSum / $n / 1MB } else { 0 }

    try { $p.StandardInput.WriteLine('{"cmd":"shutdown"}'); $p.StandardInput.Flush() } catch {}
    if (-not $p.WaitForExit(4000)) { $p.Kill() }

    "{0,-22} {1,7:N2}%  {2,8:N1} MB ws  {3,8:N1} MB priv" -f $label, $cpu, $ws, $priv | Write-Host
    return [PSCustomObject]@{ Label = $label; Cpu = $cpu; Ws = $ws; Priv = $priv }
}

Write-Host "measuring each variant for ${Seconds}s after a 12s settle`n" -ForegroundColor Cyan
$withEvents = Measure-Variant "with UIA events" ""
$noEvents = Measure-Variant "polling only" "--no-events"

Write-Host ""
$d = $withEvents.Cpu - $noEvents.Cpu
Write-Host ("  events cost {0:+0.00;-0.00;0.00}% CPU and {1:+0.0;-0.0;0.0} MB working set" -f $d, ($withEvents.Ws - $noEvents.Ws))
if ($d -gt 0.5) { Write-Host "  -> subscriptions are not paying for themselves while idle" -ForegroundColor Yellow }
else { Write-Host "  -> subscriptions are cheap" -ForegroundColor Green }
