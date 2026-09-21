<#
    Shows the plugin log, from wherever Stream Deck is currently writing it.

    The location moves with the mode: a junction puts logs inside this repo, an
    installed copy puts them under %APPDATA%. Both exist on a machine that has
    been in both modes, and the stale one looks just as plausible as the live
    one - so this resolves the path rather than leaving it to be guessed.

    Everything the sidecar writes to stderr arrives here, prefixed
    "Bridge: sidecar:". That includes the lines worth watching for:

      not clicking to dismiss    a deck is up, so no click was posted
      not in the tree            a control vanished; woken and retried
      slow snapshot              a poll long enough to delay a press
      slow flyout                a menu press with its stage breakdown

    Examples:
      .\sidecar\tail-log.ps1                 last 40 lines
      .\sidecar\tail-log.ps1 -Follow         live
      .\sidecar\tail-log.ps1 -Interesting    just the lines above
      .\sidecar\tail-log.ps1 -Follow -Interesting
#>
param(
    [int]$Lines = 40,
    [switch]$Follow,
    [switch]$Interesting,
    [string]$Match,

    [string]$Root = "C:\Users\dswett\repos\streamdeck-teams-control",
    [string]$Uuid = "com.bad-duck.teamscontrol"
)

$ErrorActionPreference = 'Stop'

$installed = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\$Uuid.sdPlugin"
if (-not (Test-Path $installed)) { throw "plugin is not installed: $installed" }

# Resolved through the junction when there is one, so this is always the folder
# Stream Deck actually loaded - not whichever copy happens to be newer.
$link = (Get-Item $installed -Force)
$live = if ($link.LinkType -eq 'Junction') { $link.Target } else { $installed }
if ($live -is [array]) { $live = $live[0] }

$dir = Join-Path $live 'logs'
if (-not (Test-Path $dir)) { throw "no logs yet: $dir" }

# Stream Deck rotates these: .0.log is current, higher numbers are older.
$log = Get-ChildItem $dir -Filter "$Uuid.*.log" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $log) { throw "no log files in $dir" }

$mode = if ($link.LinkType -eq 'Junction') { 'dev' } else { 'release' }
Write-Host "$($log.FullName)  [$mode]" -ForegroundColor DarkGray
Write-Host ""

$pattern = if ($Match) { $Match }
    elseif ($Interesting) { 'not clicking|not in the tree|slow snapshot|slow flyout|rediscovery|WARN|ERROR|failed' }
    else { $null }

if ($Follow) {
    if ($pattern) { Get-Content $log.FullName -Tail $Lines -Wait | Select-String -Pattern $pattern }
    else { Get-Content $log.FullName -Tail $Lines -Wait }
    return
}

if ($pattern) { Get-Content $log.FullName | Select-String -Pattern $pattern | Select-Object -Last $Lines }
else { Get-Content $log.FullName -Tail $Lines }
