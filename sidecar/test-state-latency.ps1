<#
    Measures how quickly a state change reaches the plugin.

    State used to be found by polling. It is now driven by UI Automation
    property-change events, with polling kept only as a slow backstop, so this
    checks that the event path actually delivers - otherwise state would lag by
    up to the backstop interval.

    Mute is toggled and the time until the sidecar reports the new value is
    measured. Anything near the backstop interval means events are not working.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\selectors.json",
    [int]$Rounds = 4
)

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

function Read-Until([string]$pattern, [int]$maxLines = 40) {
    for ($i = 0; $i -lt $maxLines; $i++) {
        $line = $proc.StandardOutput.ReadLine()
        if (-not $line) { return $null }
        if ($line -match $pattern) { return $line }
    }
    return $null
}

# Settle, and learn the current mute value.
Start-Sleep -Milliseconds 1200
$proc.StandardInput.WriteLine('{"id":1,"cmd":"status"}'); $proc.StandardInput.Flush()
$state = Read-Until '"type":"state"'
if (-not $state) { Write-Host "no state from sidecar" -ForegroundColor Red; $proc.Kill(); return }
if ($state -notmatch '"inMeeting":true') { Write-Host "not in a meeting" -ForegroundColor Red; $proc.Kill(); return }
$muted = $state -match '"mute":true'
Read-Until '"type":"result"' | Out-Null

Write-Host "starting mute state: $muted`n" -ForegroundColor Cyan
$results = @()

for ($r = 1; $r -le $Rounds; $r++) {
    $want = if ($muted) { '"mute":false' } else { '"mute":true' }

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $proc.StandardInput.WriteLine(('{{"id":{0},"cmd":"invoke","target":"mute"}}' -f (100 + $r)))
    $proc.StandardInput.Flush()

    # The invoke result and the new state both arrive; wait for the state.
    $hit = $null
    for ($i = 0; $i -lt 60; $i++) {
        $line = $proc.StandardOutput.ReadLine()
        if (-not $line) { break }
        if ($line -match '"type":"state"' -and $line -match [regex]::Escape($want)) { $hit = $sw.Elapsed.TotalMilliseconds; break }
    }
    $sw.Stop()

    if ($hit) {
        $results += $hit
        Write-Host ("  round {0}: state reached the plugin in {1:N0} ms" -f $r, $hit) `
            -ForegroundColor $(if ($hit -lt 1500) { 'Green' } else { 'Yellow' })
    }
    else {
        Write-Host ("  round {0}: NO state update seen" -f $r) -ForegroundColor Red
    }

    $muted = -not $muted
    Start-Sleep -Milliseconds 800
}

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(4000)) { $proc.Kill() }

if ($results.Count) {
    $avg = ($results | Measure-Object -Average).Average
    $max = ($results | Measure-Object -Maximum).Maximum
    Write-Host ""
    Write-Host ("  average {0:N0} ms, worst {1:N0} ms over {2} rounds" -f $avg, $max, $results.Count)
    if ($max -lt 1500) { Write-Host "PASS - events are delivering, not the backstop poll" -ForegroundColor Green }
    else { Write-Host "SLOW - looks like the backstop poll, not events" -ForegroundColor Yellow }
}
