<#
    Watches the state stream across a blur operation.

    The background-effects flyout replaces the whole subtree with its own
    contents, so while it is open none of the meeting markers are present. That
    is what previously made every key dim. inMeeting must stay true throughout.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json"
)

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`" --poll 250"
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

Start-Sleep -Milliseconds 1500
foreach ($t in @('blur', 'blur', 'hand', 'react-wow')) {
    Write-Host ">>> $t"
    $proc.StandardInput.WriteLine(('{{"id":1,"cmd":"invoke","target":"{0}"}}' -f $t))
    $proc.StandardInput.Flush()
    Start-Sleep -Seconds 4
}

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }

Write-Host "`n===== state transitions =====" -ForegroundColor Green
$bad = 0
$outTask.Result -split "`n" | Where-Object { $_ -match '"type":"state"' } | ForEach-Object {
    $o = $_ | ConvertFrom-Json
    $availFalse = @($o.available.PSObject.Properties | Where-Object { -not $_.Value } | ForEach-Object { $_.Name })
    if (-not $o.inMeeting) { $bad++ }
    $flag = if (-not $o.inMeeting) { 'DIMMED-ALL' } elseif ($availFalse.Count) { "unavailable: $($availFalse -join ',')" } else { 'all available' }
    $color = if (-not $o.inMeeting) { 'Red' } elseif ($availFalse.Count) { 'Yellow' } else { 'Green' }
    Write-Host ("  inMeeting={0,-6} {1}" -f $o.inMeeting, $flag) -ForegroundColor $color
}

Write-Host ""
if ($bad -eq 0) { Write-Host "PASS: inMeeting never dropped - no dimming" -ForegroundColor Green }
else { Write-Host "FAIL: inMeeting dropped $bad time(s)" -ForegroundColor Red }

$err = $errTask.Result
if ($err.Trim()) { Write-Host "`n--- stderr ---"; $err -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ } }
