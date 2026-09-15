param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json"
)

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

function Send([string]$json, [int]$waitMs = 2200) {
    Write-Host ">>> $json" -ForegroundColor Cyan
    $proc.StandardInput.WriteLine($json)
    $proc.StandardInput.Flush()
    Start-Sleep -Milliseconds $waitMs
}

Start-Sleep -Milliseconds 1200

Send '{"id":1,"cmd":"status"}' 1500

Write-Host "`n-- raise hand, then lower --" -ForegroundColor Yellow
Send '{"id":2,"cmd":"invoke","target":"hand"}'
Send '{"id":3,"cmd":"invoke","target":"hand"}'

Write-Host "`n-- reactions --" -ForegroundColor Yellow
Send '{"id":4,"cmd":"invoke","target":"react-like"}'
Send '{"id":5,"cmd":"invoke","target":"react-applause"}'

Write-Host "`n-- blur on, then off --" -ForegroundColor Yellow
Send '{"id":6,"cmd":"invoke","target":"blur"}' 3000
Send '{"id":7,"cmd":"invoke","target":"blur"}' 3000

Send '{"id":8,"cmd":"status"}' 1500

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }

Write-Host "`n===== RESULTS =====" -ForegroundColor Green
$outTask.Result -split "`n" | Where-Object { $_ -match '"type":"(result|ready)"' } | ForEach-Object { $_ }

$err = $errTask.Result
if ($err.Trim()) {
    Write-Host "`n===== STDERR =====" -ForegroundColor Yellow
    $err -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ }
}
