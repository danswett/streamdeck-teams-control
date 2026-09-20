<#
    What the meeting timer exposes.

    The timer sits in its own strip under the meeting toolbar: a remaining time,
    a state ("Paused"), a progress bar, and buttons. A dial needs four things
    from it - the remaining time, whether it is running, the total duration to
    draw a bar against, and controls for start/pause and reset.

    Read-only. Dumps names, ids, types, patterns and any range values.
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
    if ($w.Current.Name -match 'Meeting|Microsoft Teams') {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
        if ($w.FindFirst($TS::Descendants, $c)) { $meeting = $w; break }
    }
}
if (-not $meeting) { Write-Host "no meeting window" -ForegroundColor Red; return }
"window: '{0}'" -f $meeting.Current.Name | Write-Host

$all = $meeting.FindAll($TS::Descendants, $TRUE_COND)
"descendants: {0}" -f $all.Count | Write-Host

function Patterns($el) {
    $p = @()
    foreach ($x in $el.GetSupportedPatterns()) { $p += ($x.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '') }
    return ($p -join ',')
}

function Detail($el) {
    $c = $el.Current
    $r = $c.BoundingRectangle
    $extra = ''

    try {
        $rv = $el.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern).Current
        $extra += "  RANGE value=$($rv.Value) min=$($rv.Minimum) max=$($rv.Maximum)"
    } catch { }
    try {
        $v = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
        if ($v) { $extra += "  VALUE='$v'" }
    } catch { }
    try { if ($c.HelpText) { $extra += "  help='$($c.HelpText)'" } } catch { }
    try { if ($c.ItemStatus) { $extra += "  status='$($c.ItemStatus)'" } } catch { }

    "  type={0,-13} id='{1}' name='{2}'{3}`n      rect={4},{5} {6}x{7} patterns={8}" -f `
        $c.ControlType.ProgrammaticName.Replace('ControlType.', ''), $c.AutomationId, $c.Name, $extra,
        [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height, (Patterns $el)
}

Write-Host "`n--- anything mentioning timer ---"
foreach ($el in $all) {
    $n = ''; $id = ''
    try { $n = $el.Current.Name; $id = $el.Current.AutomationId } catch { continue }
    if ("$n $id" -notmatch 'timer|Timer') { continue }
    Detail $el | Write-Host
}

Write-Host "`n--- anything that looks like a clock (m:ss / mm:ss) ---"
foreach ($el in $all) {
    $n = ''
    try { $n = $el.Current.Name } catch { continue }
    if ($n -notmatch '^\s*\d{1,2}:\d{2}\s*$') { continue }
    Detail $el | Write-Host
}

Write-Host "`n--- progress bars ---"
foreach ($el in $all) {
    if ($el.Current.ControlType -ne [System.Windows.Automation.ControlType]::ProgressBar) { continue }
    Detail $el | Write-Host
}

Write-Host "`n--- state words (Paused / Running / Started) ---"
foreach ($el in $all) {
    $n = ''
    try { $n = $el.Current.Name } catch { continue }
    if ($n -notmatch '^\s*(Paused|Running|Started|Stopped)\s*$') { continue }
    Detail $el | Write-Host
}
