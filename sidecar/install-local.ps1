<#
    Installs the packaged plugin by copying it into place.

    Opening a .streamDeckPlugin file asks for confirmation in the Stream Deck
    UI, which needs someone at the machine. This does the same work without a
    prompt - stop the plugin, replace the files, let Stream Deck restart it -
    so an install can run unattended during development.

    For normal use just double-click the .streamDeckPlugin file and accept the
    prompt.
#>
param(
    [string]$Root = "C:\Users\dswett\repos\streamdeck-teams-control",
    [string]$Uuid = "com.bad-duck.teamscontrol"
)

$ErrorActionPreference = 'Stop'
$pkg = Join-Path $Root "dist\$Uuid.streamDeckPlugin"
$dest = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\$Uuid.sdPlugin"
$tmp = Join-Path $env:TEMP "sdpkg-install"

if (-not (Test-Path $pkg)) { throw "package not found: $pkg" }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($pkg, $tmp)

Push-Location $Root
try { npx streamdeck stop $Uuid 2>&1 | Out-Null } catch {} finally { Pop-Location }
Start-Sleep -Seconds 2

# Release the file locks on the sidecar binary.
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='TeamsBridge.exe'" -ErrorAction SilentlyContinue)) {
    $procId = $p.ProcessId
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match $Uuid })) {
    $procId = $p.ProcessId
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

# Stream Deck may have relaunched the plugin already, re-locking the binary.
# NTFS allows a running image to be renamed, so move it aside rather than
# waiting for a lock that may never clear.
$live = Join-Path $dest 'bin\sidecar\TeamsBridge.exe'
if (Test-Path $live) {
    Get-ChildItem (Split-Path $live) -Filter 'TeamsBridge.old*.exe' -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
    try { Rename-Item $live ("TeamsBridge.old-{0}.exe" -f (Get-Date -Format 'HHmmss')) -Force } catch { }
}

$src = Join-Path $tmp "$Uuid.sdPlugin"
# /R and /W are essential: robocopy's defaults are a million retries 30s apart,
# so a single locked file hangs the install indefinitely instead of failing.
robocopy $src $dest /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NC /NS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copy failed (robocopy $LASTEXITCODE)" }

$version = (Get-Content (Join-Path $dest 'manifest.json') -Raw | ConvertFrom-Json).Version
Write-Host "installed $version" -ForegroundColor Green

Start-Sleep -Seconds 8
$running = Get-CimInstance Win32_Process -Filter "Name='TeamsBridge.exe'" -ErrorAction SilentlyContinue
if ($running) { Write-Host "sidecar running: PID $($running.ProcessId)" -ForegroundColor Green }
else { Write-Host "sidecar not up yet - Stream Deck restarts the plugin shortly" -ForegroundColor Yellow }

Get-ChildItem (Join-Path $dest 'bin\sidecar') -Filter 'TeamsBridge.old*.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
