<#
    Measures how long the sidecar takes to report a meeting.

    Meeting discovery skips windows already found not to host a meeting, so this
    guards that the optimisation does not delay detection.

    Two earlier versions of this harness gave false results and are worth not
    repeating:
      - reading stdout on a background .NET task never surfaced state back into
        the PowerShell runspace, so it always reported "never detected";
      - Start-Process without -RedirectStandardInput hands the child a closed
        stdin, so the sidecar's read loop hit EOF and the process exited after
        printing one line.

    So stdin is held open and the sidecar is polled with explicit status
    commands, which guarantees a response to read rather than blocking.

    -ColdStart measures discovery against a meeting that is already running.
    Without it, the harness waits for a meeting to start.
#>
param(
    [string]$Exe = "$env:APPDATA\Elgato\StreamDeck\Plugins\com.dswett.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "$env:APPDATA\Elgato\StreamDeck\Plugins\com.dswett.teamscontrol.sdPlugin\selectors.json",
    [int]$TimeoutSeconds = 300,
    [switch]$ColdStart
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Test-MeetingLive {
    try {
        foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'ms-teams') { continue }
            $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
            if ($w.FindFirst($TS::Descendants, $c)) { return $true }
        }
    }
    catch {}
    return $false
}

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`""
$psi.RedirectStandardInput = $true    # held open, or the sidecar exits at once
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

if ($ColdStart -and -not (Test-MeetingLive)) {
    Write-Host "No meeting running; -ColdStart needs one." -ForegroundColor Red
    $proc.Kill(); return
}

$started = Get-Date
Write-Host ("Sidecar PID {0} started at {1}" -f $proc.Id, $started.ToString('HH:mm:ss.fff')) -ForegroundColor Cyan
if ($ColdStart) { Write-Host "Measuring discovery against an already-running meeting.`n" }
else { Write-Host "Waiting for a meeting to start (up to $TimeoutSeconds s).`n" }

$truthAt = if ($ColdStart) { $started } else { $null }
$sidecarAt = $null
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)

while ((Get-Date) -lt $deadline -and -not $sidecarAt) {
    if (-not $truthAt -and (Test-MeetingLive)) {
        $truthAt = Get-Date
        Write-Host "`n  meeting window appeared : $($truthAt.ToString('HH:mm:ss.fff'))" -ForegroundColor Yellow
    }

    # A status command guarantees a reply, so ReadLine cannot hang.
    $proc.StandardInput.WriteLine('{"id":1,"cmd":"status"}')
    $proc.StandardInput.Flush()

    for ($i = 0; $i -lt 4; $i++) {
        $line = $proc.StandardOutput.ReadLine()
        if (-not $line) { break }
        if ($line -match '"inMeeting":true') { $sidecarAt = Get-Date; break }
        if ($line -match '"type":"result"') { break }
    }

    if (-not $sidecarAt) { Start-Sleep -Milliseconds 250 }
}

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(4000)) { $proc.Kill() }

if (-not $truthAt) { Write-Host "`nNo meeting started within the window." -ForegroundColor Red; return }
if (-not $sidecarAt) { Write-Host "`nFAIL: meeting was live but the sidecar never reported it." -ForegroundColor Red; return }

Write-Host ("  sidecar reported it     : {0}" -f $sidecarAt.ToString('HH:mm:ss.fff')) -ForegroundColor Yellow
$delta = [Math]::Max(0, ($sidecarAt - $truthAt).TotalSeconds)
Write-Host ""
Write-Host ("  detection latency : {0:N2}s" -f $delta) `
    -ForegroundColor $(if ($delta -le 3) { 'Green' } elseif ($delta -le 6) { 'Yellow' } else { 'Red' })
if ($delta -le 3) { Write-Host "PASS - detection is prompt" -ForegroundColor Green }
elseif ($delta -le 6) { Write-Host "MARGINAL - shorten the re-check interval" -ForegroundColor Yellow }
else { Write-Host "FAIL - discovery is too slow" -ForegroundColor Red }
