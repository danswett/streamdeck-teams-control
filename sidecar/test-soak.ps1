<#
    Watches the installed sidecar for leaks.

    Short runs cannot show handle or memory growth: the interesting failure is a
    UI Automation subscription or COM reference that accumulates over hours.
    This samples the process and reports the trend rather than a single number.

    Samples the *installed* plugin's sidecar specifically - a development build
    run from the repo, or a leftover test instance, would otherwise be picked up
    and make the numbers meaningless.
#>
param(
    [int]$Minutes = 25,
    [int]$IntervalSeconds = 15,
    [string]$OutFile = "$env:TEMP\sdtc-soak.csv"
)

function Get-InstalledSidecar {
    Get-CimInstance Win32_Process -Filter "Name='TeamsBridge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -like "*Elgato*" } |
        Select-Object -First 1
}

$target = Get-InstalledSidecar
if (-not $target) { throw "the installed plugin's sidecar is not running" }

$pidToWatch = $target.ProcessId
Write-Host "watching PID $pidToWatch for $Minutes minutes (every ${IntervalSeconds}s)" -ForegroundColor Cyan
Write-Host $target.ExecutablePath -ForegroundColor DarkGray

"stamp,handles,ws_mb,priv_mb,threads,cpu_s,gen0,gen1,gen2" | Out-File $OutFile -Encoding utf8

$end = (Get-Date).AddMinutes($Minutes)
$restarted = $false

while ((Get-Date) -lt $end) {
    $p = Get-Process -Id $pidToWatch -ErrorAction SilentlyContinue
    if (-not $p) {
        # A restart resets every counter, so the run is no longer comparable.
        $restarted = $true
        break
    }

    "{0},{1},{2:N1},{3:N1},{4},{5:N1},,," -f (Get-Date -Format "HH:mm:ss"), $p.HandleCount,
        ($p.WorkingSet64 / 1MB), ($p.PrivateMemorySize64 / 1MB), $p.Threads.Count,
        $p.TotalProcessorTime.TotalSeconds | Out-File $OutFile -Append -Encoding utf8

    Start-Sleep -Seconds $IntervalSeconds
}

if ($restarted) {
    Write-Host "FAIL - sidecar PID $pidToWatch went away mid-run; results are not comparable" -ForegroundColor Red
    exit 1
}

$rows = Import-Csv $OutFile
if ($rows.Count -lt 4) { Write-Host "too few samples"; exit 1 }

function Trend([string]$column) {
    $values = $rows | ForEach-Object { [double]$_.$column }
    $half = [int][math]::Floor($values.Count / 2)
    $early = ($values[0..($half - 1)] | Measure-Object -Average).Average
    $late = ($values[$half..($values.Count - 1)] | Measure-Object -Average).Average
    [pscustomobject]@{
        Metric = $column
        First  = $values[0]
        Last   = $values[-1]
        Early  = [math]::Round($early, 1)
        Late   = [math]::Round($late, 1)
        Drift  = [math]::Round($late - $early, 1)
    }
}

$report = @('handles', 'ws_mb', 'priv_mb', 'threads' | ForEach-Object { Trend $_ })
Write-Host ""
$report | Format-Table -AutoSize

$cpu = [double]$rows[-1].cpu_s - [double]$rows[0].cpu_s
$span = ($rows.Count - 1) * $IntervalSeconds
Write-Host ("CPU over the run: {0:N1}s of {1}s wall = {2:N2}%" -f $cpu, $span, ($cpu / $span * 100))

# Second-half versus first-half average, so a single spike does not trip it.
$handleDrift = ($report | Where-Object Metric -eq 'handles').Drift
$privDrift = ($report | Where-Object Metric -eq 'priv_mb').Drift

$failed = $false
if ($handleDrift -gt 50) { Write-Host "FAIL - handle count is climbing (+$handleDrift)" -ForegroundColor Red; $failed = $true }
if ($privDrift -gt 5) { Write-Host "FAIL - private bytes are climbing (+$privDrift MB)" -ForegroundColor Red; $failed = $true }

if (-not $failed) { Write-Host "PASS - no handle or memory growth over $Minutes minutes" -ForegroundColor Green }
exit ($failed ? 1 : 0)
