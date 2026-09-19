<#
    Finds the regions a slide thumbnail could be captured from.

    Two candidates, and they behave differently:

      * the slide surface itself, which is always there while a deck is up, and
        is the current slide at full size;
      * the presenter-view filmstrip, whose items are the slides either side of
        it - but only while presenter view is open.

    Reports the bounding rectangle of each, and which filmstrip item is
    selected, since that is what "current" and "next" are relative to.
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
if (-not $meeting) { Write-Host "no PowerPoint Live surface (is a deck up, and no flyout open?)" -ForegroundColor Red; return }

$wr = $meeting.Current.BoundingRectangle
"window: '{0}'  rect={1},{2} {3}x{4}" -f $meeting.Current.Name, [int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height | Write-Host

Write-Host "`n--- the slide surface ---"
foreach ($id in @('slideshow-app-container', 'ppt-previewer-root')) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
    $el = $meeting.FindFirst($TS::Descendants, $c)
    if (-not $el) { "  {0,-26} not in tree" -f $id | Write-Host; continue }
    $r = $el.Current.BoundingRectangle
    "  {0,-26} name='{1}' rect={2},{3} {4}x{5}  ratio={6:N2}" -f `
        $id, $el.Current.Name, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height,
        $(if ($r.Height) { $r.Width / $r.Height } else { 0 }) | Write-Host
}

Write-Host "`n--- list items that look like slides ---"
$items = $meeting.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)))

$n = 0
foreach ($it in $items) {
    $c = $it.Current
    # The ink tools are ListItems too; slides are the ones with real size.
    $r = $c.BoundingRectangle
    if ($r.Width -lt 100 -or $r.Height -lt 60) { continue }

    $sel = ''
    try { $sel = "  selected=$($it.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected)" } catch { }

    $n++
    "  [{0,2}] id='{1}' name='{2}'{3}`n        rect={4},{5} {6}x{7}  ratio={8:N2}" -f `
        $n, $c.AutomationId, $c.Name, $sel, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height,
        $(if ($r.Height) { $r.Width / $r.Height } else { 0 }) | Write-Host
}
if ($n -eq 0) { Write-Host "  none - presenter view is probably closed" }
