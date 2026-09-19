<#
    Finds the filmstrip's viewport - the box slides are actually visible in.

    A filmstrip item reports its rectangle whether or not it is scrolled into
    view, and a partly scrolled one reports the whole slide. Capturing that
    rectangle grabs whatever the list is clipping it against, which is why a
    half-visible slide came back with the chat pane down one side.

    So the capture has to be clipped to the container, not the item. This
    reports both, plus how much of each item actually falls inside.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition
$WALKER = [System.Windows.Automation.TreeWalker]::ControlViewWalker

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

$wr = $meeting.Current.BoundingRectangle
"window: rect={0},{1} {2}x{3}" -f [int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height | Write-Host

$items = @($meeting.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))) |
    Where-Object { $_.Current.BoundingRectangle.Width -ge 100 -and $_.Current.BoundingRectangle.Height -ge 60 })

if ($items.Count -eq 0) { Write-Host "no filmstrip items - presenter view closed?" -ForegroundColor Red; return }

Write-Host "`n--- ancestors of the first slide ---"
$p = $WALKER.GetParent($items[0])
$depth = 0
$viewport = $null
while ($p -and $depth -lt 6) {
    $c = $p.Current
    $r = $c.BoundingRectangle
    "  [{0}] type={1,-12} id='{2}' name='{3}' rect={4},{5} {6}x{7}" -f `
        $depth, $c.ControlType.ProgrammaticName.Replace('ControlType.', ''), $c.AutomationId, $c.Name,
        [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height | Write-Host
    if (-not $viewport -and $c.ControlType.ProgrammaticName -match 'List$') { $viewport = $p }
    $p = $WALKER.GetParent($p)
    $depth++
}

if (-not $viewport) { Write-Host "`nno List ancestor found" -ForegroundColor Yellow; return }

$v = $viewport.Current.BoundingRectangle
"`nviewport: rect={0},{1} {2}x{3}" -f [int]$v.X, [int]$v.Y, [int]$v.Width, [int]$v.Height | Write-Host

Write-Host "`n--- how much of each slide is inside it ---"
foreach ($it in $items) {
    $c = $it.Current
    $r = $c.BoundingRectangle
    $left = [Math]::Max($r.Left, $v.Left)
    $right = [Math]::Min($r.Right, $v.Right)
    $vis = [Math]::Max(0, $right - $left)
    $pct = if ($r.Width) { 100 * $vis / $r.Width } else { 0 }

    $sel = ''
    try { if ($it.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $sel = ' SELECTED' } } catch { }
    $off = ''
    try { if ($c.IsOffscreen) { $off = ' offscreen' } } catch { }

    "  {0,-34} x={1,6}..{2,-6} visible={3,5:N0}%{4}{5}" -f $c.Name, [int]$r.Left, [int]$r.Right, $pct, $sel, $off | Write-Host
}
