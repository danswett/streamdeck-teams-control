<#
    What is still knowable about a slide that is scrolled out of the filmstrip.

    Teams scrolls the strip so the current slide sits at its trailing edge, so
    while advancing forward the next slide is never drawn - there are no pixels
    to capture. This asks what remains: the name is in the tree either way, and
    ScrollItemPattern would bring it into view if that were ever worth doing.

    Read-only. Nothing here invokes a pattern; invoking ScrollIntoView on the
    wrong element would drive the presentation.
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

$items = @($meeting.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))) |
    Where-Object { $_.Current.BoundingRectangle.Width -ge 100 -and $_.Current.BoundingRectangle.Height -ge 60 })

if ($items.Count -eq 0) { Write-Host "presenter view closed" -ForegroundColor Red; return }

$sorted = $items | Sort-Object { $_.Current.BoundingRectangle.X }
$viewport = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($sorted[0])
$v = $viewport.Current.BoundingRectangle
"viewport x {0}..{1}" -f [int]$v.Left, [int]$v.Right | Write-Host

$at = -1
for ($i = 0; $i -lt $sorted.Count; $i++) {
    try { if ($sorted[$i].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $at = $i; break } } catch { }
}
"selected index {0} of {1}: '{2}'" -f $at, $sorted.Count, $sorted[$at].Current.Name | Write-Host

foreach ($offset in 1, 2) {
    $n = $at + $offset
    if ($n -ge $sorted.Count) { "  +{0}: past the end of the deck" -f $offset | Write-Host; continue }

    $el = $sorted[$n]
    $c = $el.Current
    $r = $c.BoundingRectangle
    $visible = [Math]::Max(0, [Math]::Min($r.Right, $v.Right) - [Math]::Max($r.Left, $v.Left))
    $pct = if ($r.Width) { 100 * $visible / $r.Width } else { 0 }

    $patterns = @()
    foreach ($p in $el.GetSupportedPatterns()) { $patterns += $p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '' }

    "  +{0}: '{1}'" -f $offset, $c.Name | Write-Host
    "        name readable while off-strip: YES" | Write-Host
    "        visible {0:N0}%  offscreen={1}" -f $pct, $c.IsOffscreen | Write-Host
    "        patterns: {0}" -f ($patterns -join ', ') | Write-Host
}
