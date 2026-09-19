<#
    Dumps the subtree under the live slide surface.

    The container Teams calls 'slideshow-app-container' is named after the
    current slide, but its rectangle is not the slide's: it is a 4:3-ish box
    with the 16:9 slide letterboxed inside it. A thumbnail wants the slide, so
    this looks for a descendant whose rectangle actually is the slide.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

function Get-TeamsWindows {
    $AE::RootElement.FindAll($TS::Children, $TRUE_COND) |
        Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' }
}

$meeting = $null
foreach ($w in Get-TeamsWindows) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'ppt-previewer-root')
    if ($w.FindFirst($TS::Descendants, $c)) { $meeting = $w; break }
}
if (-not $meeting) { Write-Host "no PowerPoint Live surface" -ForegroundColor Red; return }

$c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'slideshow-app-container')
$root = $meeting.FindFirst($TS::Descendants, $c)
if (-not $root) { Write-Host "no slideshow-app-container" -ForegroundColor Red; return }

$rr = $root.Current.BoundingRectangle
"container: rect={0},{1} {2}x{3} ratio={4:N3}" -f [int]$rr.X, [int]$rr.Y, [int]$rr.Width, [int]$rr.Height, ($rr.Width / $rr.Height) | Write-Host
"   16:9 inside it would be {0}x{1} at y offset {2}" -f [int]$rr.Width, [int]($rr.Width * 9 / 16), [int](($rr.Height - $rr.Width * 9 / 16) / 2) | Write-Host

Write-Host "`n--- every descendant with a real rectangle ---"
$all = $root.FindAll($TS::Descendants, $TRUE_COND)
$n = 0
foreach ($el in $all) {
    $cur = $el.Current
    $r = $cur.BoundingRectangle
    if ($r.Width -lt 80 -or $r.Height -lt 45) { continue }
    $n++
    $ratio = if ($r.Height) { $r.Width / $r.Height } else { 0 }
    $flag = if ([Math]::Abs($ratio - (16 / 9)) -lt 0.02) { '   <== 16:9' } else { '' }
    "  [{0,2}] type={1,-12} id='{2}' name='{3}'`n        rect={4},{5} {6}x{7} ratio={8:N3}{9}" -f `
        $n, $cur.ControlType.ProgrammaticName.Replace('ControlType.', ''), $cur.AutomationId, $cur.Name,
        [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height, $ratio, $flag | Write-Host
}
if ($n -eq 0) { Write-Host "  none - the surface has no sized children" }
