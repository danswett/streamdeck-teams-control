<#
    Lifecycle and robustness checks that do not need a meeting.

    Covers the paths a user hits by accident rather than on purpose: a sidecar
    that dies, malformed input on the wire, and commands the sidecar does not
    know. Each one must degrade to an error message, never take the process
    down - the plugin has no way to tell the user why its keys went dark.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json",
    [switch]$SkipRestart
)

$script:failures = 0

function Check([string]$name, [bool]$ok, [string]$detail = "") {
    if ($ok) { Write-Host "  PASS  $name" -ForegroundColor Green }
    else {
        Write-Host "  FAIL  $name $detail" -ForegroundColor Red
        $script:failures++
    }
}

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

function Send($p, [string]$line) {
    $p.StandardInput.WriteLine($line)
    $p.StandardInput.Flush()
}

function Wait-For($p, [string]$pattern, [int]$ms = 6000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $ms) {
        $line = Read-LineTimeout $p ($ms - $sw.ElapsedMilliseconds)
        if (-not $line) { return $null }
        if ($line -match $pattern) { return $line }
    }
    return $null
}

Write-Host "`n=== malformed input ===" -ForegroundColor Cyan
$p = New-Sidecar
try {
    Wait-For $p '"type":"ready"' | Out-Null

    Send $p 'this is not json at all'
    Check "garbage line is reported as an error" ($null -ne (Wait-For $p '"type":"error"'))
    Check "process survives garbage input" (-not $p.HasExited)

    Send $p '{"id":9,"cmd":"nonsense-command"}'
    # Failures come back as a result carrying the request id rather than a bare
    # error, so the caller's pending promise resolves instead of timing out.
    $unknown = Wait-For $p '"id":9'
    Check "unknown command is reported" ($unknown -match '"ok":false') $unknown
    Check "unknown command names itself" ($unknown -match 'nonsense-command') $unknown

    Send $p '{"id":10,"cmd":"invoke","target":"no-such-control"}'
    $bad = Wait-For $p '"id":10'
    Check "unknown control fails cleanly" ($bad -match '"ok":false') $bad

    Send $p ('{"id":11,"cmd":"invoke","target":"' + ('x' * 20000) + '"}')
    $huge = Wait-For $p '"id":11'
    Check "a very long line does not break framing" ($null -ne $huge)
    Check "process survives a very long line" (-not $p.HasExited)

    Send $p '{"id":12,"cmd":"status"}'
    Check "still answering after all of that" ($null -ne (Wait-For $p '"id":12'))

    # An empty line is what a flushed-but-empty write looks like.
    Send $p ''
    Send $p '{"id":13,"cmd":"ping"}'
    Check "blank lines are skipped, not treated as messages" ($null -ne (Wait-For $p '"id":13'))
}
finally {
    try { Send $p '{"cmd":"shutdown"}' } catch {}
    if (-not $p.WaitForExit(3000)) { $p.Kill() }
}

Write-Host "`n=== clean shutdown ===" -ForegroundColor Cyan
$p2 = New-Sidecar
try {
    Wait-For $p2 '"type":"ready"' | Out-Null
    Send $p2 '{"cmd":"shutdown"}'
    Check "exits on shutdown" ($p2.WaitForExit(5000))
    if ($p2.HasExited) { Check "exits with code 0" ($p2.ExitCode -eq 0) "code=$($p2.ExitCode)" }
}
finally { if (-not $p2.HasExited) { $p2.Kill() } }

Write-Host "`n=== stdin closing ===" -ForegroundColor Cyan
# Stream Deck kills the plugin by closing the pipe; the sidecar must not linger.
$p3 = New-Sidecar
try {
    Wait-For $p3 '"type":"ready"' | Out-Null
    $p3.StandardInput.Close()
    Check "exits when its stdin closes" ($p3.WaitForExit(5000))
}
finally { if (-not $p3.HasExited) { $p3.Kill() } }

if (-not $SkipRestart) {
    Write-Host "`n=== plugin restarts a dead sidecar ===" -ForegroundColor Cyan
    $installed = Get-CimInstance Win32_Process -Filter "Name='TeamsBridge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -like "*Elgato*" } | Select-Object -First 1

    if (-not $installed) {
        Write-Host "  SKIP  the plugin is not installed or not running" -ForegroundColor Yellow
    }
    else {
        $before = $installed.ProcessId
        Stop-Process -Id $before -Force
        Start-Sleep -Seconds 6

        $after = Get-CimInstance Win32_Process -Filter "Name='TeamsBridge.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -like "*Elgato*" } | Select-Object -First 1

        Check "sidecar is respawned after being killed" ($null -ne $after)
        if ($after) { Check "it is genuinely a new process" ($after.ProcessId -ne $before) "before=$before after=$($after.ProcessId)" }
    }
}

Write-Host ""
if ($script:failures -eq 0) { Write-Host "ALL PASS" -ForegroundColor Green; exit 0 }
Write-Host "$($script:failures) FAILED" -ForegroundColor Red
exit 1
