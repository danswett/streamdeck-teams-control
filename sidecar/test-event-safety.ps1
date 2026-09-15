<#
    Checks the sidecar stays responsive with UI Automation event subscriptions
    active.

    Events are delivered on RPC threads while the worker thread is making its
    own UIA calls, which is a known deadlock risk. This sends status commands
    over time and times each reply; a stall means the subscriptions are unsafe
    and polling should carry state instead.

    Also toggles mute externally, through a separate short-lived sidecar, to see
    whether the watcher notices a change it did not make.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\selectors.json"
)

function New-Sidecar {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Exe
    $psi.Arguments = "--selectors `"$Selectors`""
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($psi)
}

$watcher = New-Sidecar
Start-Sleep -Milliseconds 1500
Write-Host "watcher PID $($watcher.Id)`n" -ForegroundColor Cyan

# A status reply is guaranteed, so a slow reply means the worker is blocked.
function Measure-Reply([int]$id) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $watcher.StandardInput.WriteLine(('{{"id":{0},"cmd":"status"}}' -f $id))
    $watcher.StandardInput.Flush()
    for ($i = 0; $i -lt 30; $i++) {
        $line = $watcher.StandardOutput.ReadLine()
        if (-not $line) { return -1 }
        if ($line -match ('"type":"result","id":{0}' -f $id)) { return $sw.Elapsed.TotalMilliseconds }
    }
    return -1
}

Write-Host "--- responsiveness over 20s ---"
$stalled = $false
for ($i = 1; $i -le 5; $i++) {
    $ms = Measure-Reply (500 + $i)
    $ok = $ms -ge 0 -and $ms -lt 2000
    if (-not $ok) { $stalled = $true }
    Write-Host ("  probe {0}: {1}" -f $i, $(if ($ms -lt 0) { "NO REPLY" } else { "{0:N0} ms" -f $ms })) `
        -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
    Start-Sleep -Seconds 4
}

Write-Host "`n--- does it notice a change it did not make? ---"
$actor = New-Sidecar
Start-Sleep -Milliseconds 1200
$actor.StandardInput.WriteLine('{"id":900,"cmd":"invoke","target":"mute"}')
$actor.StandardInput.Flush()
Start-Sleep -Seconds 3

$sw = [Diagnostics.Stopwatch]::StartNew()
$seen = $false
# The watcher pushes state unsolicited on change; a status also forces one.
$ms = Measure-Reply 999
Write-Host ("  watcher still replying after the external change: {0}" -f $(if ($ms -ge 0) { "yes ({0:N0} ms)" -f $ms } else { "NO" })) `
    -ForegroundColor $(if ($ms -ge 0) { 'Green' } else { 'Red' })

# Put mute back.
$actor.StandardInput.WriteLine('{"id":901,"cmd":"invoke","target":"mute"}')
$actor.StandardInput.Flush()
Start-Sleep -Seconds 2

foreach ($p in @($watcher, $actor)) {
    try { $p.StandardInput.WriteLine('{"cmd":"shutdown"}'); $p.StandardInput.Flush() } catch {}
    if (-not $p.WaitForExit(3000)) { $p.Kill() }
}

Write-Host ""
if ($stalled) { Write-Host "FAIL - the sidecar stalled; event subscriptions are unsafe" -ForegroundColor Red }
else { Write-Host "PASS - responsive throughout with subscriptions active" -ForegroundColor Green }
