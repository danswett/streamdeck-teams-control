<#
    Rebuilds the sidecar and installs it while the plugin is running.

    Stream Deck restarts the plugin automatically whenever it exits, which
    immediately respawns the sidecar and re-locks the binary. Publishing to a
    staging folder and renaming the running executable side-steps that: Windows
    allows a running image to be renamed, and the next spawn picks up the new
    file.
#>
param(
    [string]$Root = "C:\Users\dswett\repos\streamdeck-teams-control",
    [string]$Source = "https://packagefeedproxy.microsoft.io/nuget/v3/index.json",
    [switch]$Restore
)

$ErrorActionPreference = 'Stop'
$stage = Join-Path $env:TEMP "tb-stage"
$dest = Join-Path $Root "com.bad-duck.teamscontrol.sdPlugin\bin\sidecar"

Push-Location $Root
try {
    if ($Restore) {
        Write-Host "Restoring..." -ForegroundColor Cyan
        dotnet restore sidecar/TeamsBridge.csproj --source $Source -v quiet --nologo
    }

    Write-Host "Publishing to staging..." -ForegroundColor Cyan
    $out = dotnet publish sidecar/TeamsBridge.csproj -c Release -o $stage --nologo -v quiet --no-restore 2>&1
    $errors = $out | Select-String -Pattern ": error"
    if ($errors) { $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }; throw "publish failed" }

    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $live = Join-Path $dest "TeamsBridge.exe"

    # A previously replaced image can still be locked by a running process, so
    # each swap uses a unique name and stale copies are cleared best-effort.
    Get-ChildItem $dest -Filter "TeamsBridge.old*.exe" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

    if (Test-Path $live) {
        $backup = "TeamsBridge.old-{0}.exe" -f (Get-Date -Format "HHmmss")
        Rename-Item $live $backup -Force
    }
    Copy-Item (Join-Path $stage "TeamsBridge.exe") $live -Force

    Write-Host "Restarting plugin..." -ForegroundColor Cyan
    npx streamdeck restart com.bad-duck.teamscontrol | Out-Null

    # `streamdeck restart` does not reliably recycle the plugin process, so the
    # sidecar is terminated directly; the plugin's supervisor respawns it from
    # the new binary after its restart backoff.
    Start-Sleep -Seconds 2
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='TeamsBridge.exe'")) {
        $procId = $proc.ProcessId
        Write-Host "  recycling sidecar PID $procId"
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 5

    Get-ChildItem $dest -Filter "TeamsBridge.old*.exe" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

    $p = Get-CimInstance Win32_Process -Filter "Name='TeamsBridge.exe'"
    if ($p) {
        Write-Host "Sidecar running: PID $($p.ProcessId)" -ForegroundColor Green
    }
    else {
        Write-Host "Sidecar not running - check the plugin log" -ForegroundColor Yellow
    }
    Write-Host "Installed: $((Get-Item $live).LastWriteTime)" -ForegroundColor Green
}
finally {
    Pop-Location
}
