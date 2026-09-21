<#
    Checks that pressing a key never moves the presentation.

    A dismissal click is posted to an inert spot in the meeting window to close
    a flyout. The slide surface is not inert: a click there advances the deck
    for everyone watching. The surface is excluded by bounds, but those bounds
    can only be read while it is in the accessibility tree - and opening a
    flyout unmounts it - so the exclusion is exactly the thing that quietly
    stops working.

    Compares against the last slide number actually observed, rather than
    against the reading taken just before the press. A press often leaves the
    surface briefly unreadable, and an earlier version of this script compared
    5 -> "(no slide)", called it "detached", and passed - while the next round
    opened at 6. The deck had moved and the run still said PASS.

    Run it while presenting a deck through PowerPoint Live.
#>
param(
    [string]$Exe = "$PSScriptRoot\bin\Debug\net10.0-windows\win-x64\TeamsBridge.exe",
    [string]$Selectors = "",
    [string[]]$Targets = @("react-like", "react-love", "mute"),
    [int]$Rounds = 3,
    [int]$GapMs = 3000
)

if (-not (Test-Path $Exe)) { throw "sidecar not found: $Exe" }

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = if ($Selectors) { "--selectors `"$Selectors`"" } else { "" }
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

$script:id = 100

function Send-Line([string]$json) {
    $proc.StandardInput.WriteLine($json)
    $proc.StandardInput.Flush()
}

<#
    Reads the slide number, retrying while the surface is unreadable.

    A press leaves the slide-show subtree out of the accessibility tree for a
    moment, and a single read landing in that window returns nothing. Retrying
    is what turns "cannot see it" into either a real number or a genuine
    absence, and only a real number can be compared.
#>
function Get-Slide([int]$Attempts = 6) {
    for ($a = 1; $a -le $Attempts; $a++) {
        $script:id++
        Send-Line "{`"id`":$($script:id),`"cmd`":`"status`"}"
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $deadline) {
            $line = $proc.StandardOutput.ReadLine()
            if ($null -eq $line) { return $null }
            if ($line -notmatch '"type":"state"') { continue }
            if ($line -match '"ppt\.slide":"([^"]*)"') { return $matches[1] }
            break
        }
        Start-Sleep -Milliseconds 700
    }
    return $null
}

Start-Sleep -Milliseconds 3000
$first = Get-Slide

if ($null -eq $first) {
    $proc.Kill()
    throw "no slide position is being reported - share a deck through PowerPoint Live first."
}

Write-Host "presenting, slide $first. Pressing $($Targets -join ', ') x$Rounds." -ForegroundColor Green
Write-Host ""

$moves = 0
$presses = 0
$failed = 0
$unreadable = 0

# The last slide number actually seen. Compared against this rather than
# against the reading before each press, so a move cannot hide inside a gap
# where the surface was unreadable.
$known = $first

foreach ($target in $Targets) {
    for ($i = 1; $i -le $Rounds; $i++) {
        $script:id++
        $mine = $script:id
        Send-Line "{`"id`":$mine,`"cmd`":`"invoke`",`"target`":`"$target`"}"

        $ok = $false
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $deadline) {
            $line = $proc.StandardOutput.ReadLine()
            if ($null -eq $line) { break }
            if ($line -match '"type":"result"' -and $line -match "`"id`":$mine\b") {
                $ok = ($line -match '"ok":true')
                break
            }
        }

        # Long enough for the deferred cleanup - the settle, any dismissal and
        # the flyout collapse - to have finished and for Teams to have redrawn.
        Start-Sleep -Milliseconds $GapMs
        $after = Get-Slide
        $presses++

        if ($null -eq $after) {
            $unreadable++
            Write-Host ("  {0,-16} round {1}  ok={2}  slide unreadable (last known {3})" -f $target, $i, $ok, $known) -ForegroundColor Yellow
        }
        elseif ($after -ne $known) {
            $moves++
            Write-Host ("  {0,-16} round {1}  ok={2}  SLIDE MOVED {3} -> {4}" -f $target, $i, $ok, $known, $after) -ForegroundColor Red
            $known = $after
        }
        elseif (-not $ok) {
            $failed++
            Write-Host ("  {0,-16} round {1}  PRESS FAILED, slide {2} held" -f $target, $i, $after) -ForegroundColor Red
        }
        else {
            Write-Host ("  {0,-16} round {1}  ok=True  slide {2} held" -f $target, $i, $after)
        }
    }
}

$proc.Kill()

Write-Host ""
Write-Host "$presses presses: $moves moved the deck, $failed failed, $unreadable unreadable."

if ($moves -eq 0 -and $failed -eq 0 -and $unreadable -eq 0) {
    Write-Host "PASS: every press landed and the deck never moved." -ForegroundColor Green
    exit 0
}

Write-Host "FAIL" -ForegroundColor Red
exit 1
