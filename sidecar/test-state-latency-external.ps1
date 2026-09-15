<#
    Measures state latency for a change the plugin did not make.

    test-state-latency.ps1 toggles through the same sidecar that is watching,
    and an invoke forces an immediate refresh - so it cannot tell the event path
    from the poll. Here a second sidecar process performs the toggle while the
    first only observes, which exercises the UI Automation property-change
    subscription for real.

    Fast means events are working. Anything near the backstop interval means
    they are not and polling is carrying it.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json",
    [int]$Rounds = 4,
    # mute is the natural choice, but it is disabled when audio is unavailable
    # (a remote session, for example); camera is the usable alternative.
    [string]$Target = "mute"
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

$watcher = New-Sidecar     # only observes
$actor = New-Sidecar       # performs the toggles

function Read-Until($p, [string]$pattern, [int]$maxLines = 40) {
    for ($i = 0; $i -lt $maxLines; $i++) {
        $line = $p.StandardOutput.ReadLine()
        if (-not $line) { return $null }
        if ($line -match $pattern) { return $line }
    }
    return $null
}

Start-Sleep -Milliseconds 1500
$watcher.StandardInput.WriteLine('{"id":1,"cmd":"status"}'); $watcher.StandardInput.Flush()
$state = Read-Until $watcher '"type":"state"'
if (-not $state -or $state -notmatch '"inMeeting":true') {
    Write-Host "not in a meeting" -ForegroundColor Red
    $watcher.Kill(); $actor.Kill(); return
}
Read-Until $watcher '"type":"result"' | Out-Null
$script:pendingRead = @{}

function Read-LineTimeout($p, [int]$ms) {
    # An abandoned ReadLineAsync stays attached to the stream, so a timed-out
    # read would make every later read throw "stream is currently in use".
    # Keep the in-flight task and wait on it again instead of starting another.
    $key = $p.Id
    if (-not $script:pendingRead.ContainsKey($key)) {
        $script:pendingRead[$key] = $p.StandardOutput.ReadLineAsync()
    }

    $task = $script:pendingRead[$key]
    if (-not $task.Wait($ms)) { return $null }

    $script:pendingRead.Remove($key)
    return $task.Result
}

function Get-ControlState([string]$line, [string]$name) {
    # Match inside the "states" object only - "available" carries the same keys,
    # so a whole-line regex reports availability instead of state.
    if ($line -notmatch '"states":\{(.*?)\}') { return $null }
    $states = $matches[1]
    if ($states -match ('"{0}":(true|false)' -f [regex]::Escape($name))) { return $matches[1] -eq 'true' }
    return $null
}

$muted = Get-ControlState $state $Target
if ($null -eq $muted) {
    Write-Host "control '$Target' reports no state" -ForegroundColor Red
    $watcher.Kill(); $actor.Kill(); return
}
Write-Host "starting $Target state: $muted (watcher PID $($watcher.Id), actor PID $($actor.Id))`n" -ForegroundColor Cyan

$results = @()
for ($r = 1; $r -le $Rounds; $r++) {
    $want = -not $muted

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $actor.StandardInput.WriteLine(('{{"id":{0},"cmd":"invoke","target":"{1}"}}' -f (200 + $r), $Target))
    $actor.StandardInput.Flush()

    $hit = $null
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.Elapsed.TotalMilliseconds -lt 8000) {
        $line = Read-LineTimeout $watcher 8000
        if (-not $line) { break }
        if ($line -notmatch '"type":"state"') { continue }
        if ((Get-ControlState $line $Target) -eq $want) { $hit = $sw.Elapsed.TotalMilliseconds; break }
    }
    $sw.Stop()

    if ($hit) {
        $results += $hit
        Write-Host ("  round {0}: observed externally-made change in {1:N0} ms" -f $r, $hit) `
            -ForegroundColor $(if ($hit -lt 1500) { 'Green' } else { 'Yellow' })
    }
    else { Write-Host ("  round {0}: watcher never saw it" -f $r) -ForegroundColor Red }

    $muted = -not $muted
    # The camera takes a moment to start or stop; toggling again before it
    # settles is refused, so leave room for the hardware.
    Start-Sleep -Milliseconds 4000
}

foreach ($p in @($watcher, $actor)) {
    try { $p.StandardInput.WriteLine('{"cmd":"shutdown"}'); $p.StandardInput.Flush() } catch {}
    if (-not $p.WaitForExit(3000)) { $p.Kill() }
}

if ($results.Count) {
    $avg = ($results | Measure-Object -Average).Average
    $max = ($results | Measure-Object -Maximum).Maximum
    Write-Host ""
    Write-Host ("  average {0:N0} ms, worst {1:N0} ms over {2} rounds" -f $avg, $max, $results.Count)
    if ($max -lt 1500) { Write-Host "PASS - UIA events are carrying state, not the backstop poll" -ForegroundColor Green }
    else { Write-Host "SLOW - the backstop poll is doing the work; events are not firing" -ForegroundColor Yellow }
}
