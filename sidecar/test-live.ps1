#Requires -Version 5.1
<#
    Live test against a running Teams meeting.

    Dumps the meeting toolbar and each flyout so the real AutomationIds for
    raise-hand, the reactions and background blur can be captured, then
    exercises mute/camera invoke and confirms the reported state actually flips.

    Safe to run in a solo "Meet now" meeting. Mute and camera are toggled twice
    so they end where they started.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.dswett.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$OutFile = "$env:TEMP\teams-live-test.jsonl"
)

if (-not (Test-Path $Exe)) { throw "sidecar not found: $Exe" }

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

function Send([string]$json, [int]$waitMs = 1200) {
    Write-Host ">>> $json" -ForegroundColor Cyan
    $proc.StandardInput.WriteLine($json)
    $proc.StandardInput.Flush()
    Start-Sleep -Milliseconds $waitMs
}

Start-Sleep -Milliseconds 1200

Write-Host "`n--- 1. baseline state ---" -ForegroundColor Yellow
Send '{"id":1,"cmd":"status"}' 1500

Write-Host "`n--- 2. map the toolbar and every flyout ---" -ForegroundColor Yellow
Send '{"id":10,"cmd":"discover","menu":""}' 2000
Send '{"id":11,"cmd":"discover","menu":"reaction-menu-button"}' 3000
Send '{"id":12,"cmd":"discover","menu":"callingButtons-showMoreBtn"}' 3000
Send '{"id":13,"cmd":"discover","menu":"video-button-configure"}' 3000

Write-Host "`n--- 3. toggle mute twice (ends where it started) ---" -ForegroundColor Yellow
Send '{"id":20,"cmd":"invoke","target":"mute"}' 1800
Send '{"id":21,"cmd":"invoke","target":"mute"}' 1800

Write-Host "`n--- 4. toggle camera twice ---" -ForegroundColor Yellow
Send '{"id":30,"cmd":"invoke","target":"camera"}' 2500
Send '{"id":31,"cmd":"invoke","target":"camera"}' 2500

Write-Host "`n--- 5. raise hand, then lower it ---" -ForegroundColor Yellow
Send '{"id":40,"cmd":"invoke","target":"hand"}' 2500
Send '{"id":41,"cmd":"invoke","target":"hand"}' 2500

Write-Host "`n--- 6. final state ---" -ForegroundColor Yellow
Send '{"id":50,"cmd":"status"}' 1500

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }

$out = $outTask.Result
Set-Content -Path $OutFile -Value $out -Encoding utf8

Write-Host "`n===== STATE / RESULT MESSAGES =====" -ForegroundColor Green
$out -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch '"type":"discover"' } | ForEach-Object { $_ }

$err = $errTask.Result
if ($err.Trim()) {
    Write-Host "`n===== STDERR =====" -ForegroundColor Red
    $err -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ }
}

Write-Host "`nFull output (including discover dumps): $OutFile" -ForegroundColor Green
