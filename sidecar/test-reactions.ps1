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

function Send([string]$json, [int]$waitMs = 2600) {
    Write-Host ">>> $json" -ForegroundColor Cyan
    $proc.StandardInput.WriteLine($json); $proc.StandardInput.Flush()
    Start-Sleep -Milliseconds $waitMs
}

Start-Sleep -Milliseconds 1400
Send '{"id":1,"cmd":"status"}' 1500

$i = 10
foreach ($r in @('react-like', 'react-love', 'react-applause', 'react-laugh', 'react-wow')) {
    Send ('{{"id":{0},"cmd":"invoke","target":"{1}"}}' -f $i, $r)
    $i++
}

Send '{"id":90,"cmd":"status"}' 1500

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }

Write-Host "`n===== RESULTS =====" -ForegroundColor Green
$outTask.Result -split "`n" | Where-Object { $_ -match '"type":"result"' } | ForEach-Object { $_ }

$err = $errTask.Result
if ($err.Trim()) {
    Write-Host "`n===== STDERR =====" -ForegroundColor Yellow
    $err -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ }
}
