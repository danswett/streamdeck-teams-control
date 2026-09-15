param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\sidecar\bin\Release\net10.0-windows\win-x64\TeamsBridge.exe",
    [string]$Selectors = "",
    [string[]]$Commands = @('{"id":1,"cmd":"ping"}', '{"id":2,"cmd":"status"}'),
    [int]$ReadSeconds = 8
)

if (-not (Test-Path $Exe)) { throw "sidecar not found: $Exe" }

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
if ($Selectors) { $psi.Arguments = "--selectors `"$Selectors`"" }
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)

$outLines = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$errLines = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()

$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

Start-Sleep -Milliseconds 800
foreach ($c in $Commands) {
    Write-Host ">>> $c" -ForegroundColor Cyan
    $proc.StandardInput.WriteLine($c)
    $proc.StandardInput.Flush()
    Start-Sleep -Milliseconds 900
}

Start-Sleep -Seconds $ReadSeconds
try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(4000)) { $proc.Kill() }

Write-Host "`n===== STDOUT =====" -ForegroundColor Green
$outTask.Result -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ }

$err = $errTask.Result
if ($err.Trim()) {
    Write-Host "`n===== STDERR =====" -ForegroundColor Yellow
    $err -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ }
}
