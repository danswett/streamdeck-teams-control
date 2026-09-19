<#
    Does ScrollIntoView on a filmstrip slide move the presentation?

    The filmstrip items carry ScrollItem, Invoke and SelectionItem. Scrolling
    one into view is exactly what is wanted; selecting it would navigate the
    deck for everyone in the meeting. ScrollItemPattern is specified to do only
    the former, but Teams' filmstrip is a virtualised web list and that is worth
    confirming rather than assuming.

    Records the selected slide and the strip's scroll position either side of a
    single ScrollIntoView on the slide after the current one. If the selection
    moves, this prints FAIL and the idea is dead.
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

function Get-Strip($meeting) {
    @($meeting.FindAll($TS::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))) |
        Where-Object { $_.Current.BoundingRectangle.Width -ge 100 -and $_.Current.BoundingRectangle.Height -ge 60 }) |
        Sort-Object { $_.Current.BoundingRectangle.X }
}

function Get-SelectedIndex($strip) {
    for ($i = 0; $i -lt $strip.Count; $i++) {
        try { if ($strip[$i].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { return $i } } catch { }
    }
    return -1
}

$meeting = $null
foreach ($w in Get-TeamsWindows) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'ppt-previewer-root')
    if ($w.FindFirst($TS::Descendants, $c)) { $meeting = $w; break }
}
if (-not $meeting) { Write-Host "no PowerPoint Live surface" -ForegroundColor Red; return }

# The live slide surface is named after the slide being presented, which is the
# authoritative "what is the room looking at" reading.
function Get-LiveSlideName($meeting) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'slideshow-app-container')
    $el = $meeting.FindFirst($TS::Descendants, $c)
    if ($el) { return $el.Current.Name } else { return '(none)' }
}

$strip = Get-Strip $meeting
$before = Get-SelectedIndex $strip
$liveBefore = Get-LiveSlideName $meeting
$viewport = $WALKER.GetParent($strip[0])
$vBefore = $viewport.Current.BoundingRectangle
$firstXBefore = $strip[0].Current.BoundingRectangle.X

"BEFORE  selected index={0} '{1}'" -f $before, $strip[$before].Current.Name | Write-Host
"        live surface: '{0}'" -f $liveBefore | Write-Host
"        first item x={0}  viewport {1}..{2}" -f [int]$firstXBefore, [int]$vBefore.Left, [int]$vBefore.Right | Write-Host

$next = $before + 1
if ($next -ge $strip.Count) { Write-Host "on the last slide - move back a few and rerun" -ForegroundColor Yellow; return }

$target = $strip[$next]
"`nScrollIntoView on '{0}' ..." -f $target.Current.Name | Write-Host
try {
    $target.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView()
} catch {
    Write-Host "  threw: $($_.Exception.Message)" -ForegroundColor Red
    return
}
Start-Sleep -Milliseconds 600

$strip2 = Get-Strip $meeting
$after = Get-SelectedIndex $strip2
$liveAfter = Get-LiveSlideName $meeting
$firstXAfter = $strip2[0].Current.BoundingRectangle.X

"`nAFTER   selected index={0} '{1}'" -f $after, $strip2[$after].Current.Name | Write-Host
"        live surface: '{0}'" -f $liveAfter | Write-Host
"        first item x={0}" -f [int]$firstXAfter | Write-Host

$v2 = $WALKER.GetParent($strip2[0]).Current.BoundingRectangle
$r = $strip2[$next].Current.BoundingRectangle
$vis = [Math]::Max(0, [Math]::Min($r.Right, $v2.Right) - [Math]::Max($r.Left, $v2.Left))
$pct = if ($r.Width) { 100 * $vis / $r.Width } else { 0 }

Write-Host ""
if ($after -ne $before -or $liveAfter -ne $liveBefore) {
    Write-Host "FAIL: the selection moved. ScrollIntoView navigates - do not use it." -ForegroundColor Red
} else {
    Write-Host "PASS: selection and live slide unchanged." -ForegroundColor Green
}
"        strip moved by {0}px; next slide now {1:N0}% visible" -f [int]($firstXBefore - $firstXAfter), $pct | Write-Host
