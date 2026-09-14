<#
    Checks whether the controls that live inside Teams flyouts are present in
    the accessibility tree while the flyout is CLOSED.

    If they are, they can be invoked directly and the menu never has to be
    opened, which removes both the visible popup and an activation.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-TeamsWindows {
    $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' }
}

$meeting = $null
foreach ($w in Get-TeamsWindows) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
    if ($w.FindFirst($TS::Descendants, $c)) { $meeting = $w; break }
}
if (-not $meeting) { Write-Host "not in a meeting (or a flyout is open)" -ForegroundColor Red; return }

Write-Host "meeting window: '$($meeting.Current.Name)'" -ForegroundColor Cyan
Write-Host "toolbar visible, so no flyout is open.`n"

Write-Host "--- are flyout items reachable with the menu CLOSED? ---"
foreach ($id in @('like-button', 'heart-button', 'applause-button', 'laugh-button', 'surprised-button', 'raisehands-button')) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
    $el = $meeting.FindFirst($TS::Descendants, $c)
    if ($el) {
        $pats = ($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '' }) -join ','
        "  {0,-20} FOUND  offscreen={1} enabled={2} pats={3}" -f $id, $el.Current.IsOffscreen, $el.Current.IsEnabled, $pats | Write-Host -ForegroundColor Green
    }
    else {
        "  {0,-20} not in tree" -f $id | Write-Host -ForegroundColor DarkGray
    }
}

Write-Host "`n--- background effect items with the menu CLOSED? ---"
$all = $meeting.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$hits = 0
foreach ($d in $all) {
    $n = $d.Current.Name
    if ([string]::IsNullOrWhiteSpace($n)) { continue }
    if ($n -notmatch 'blur|background effect') { continue }
    $hits++
    "  <{0}> id='{1}' name='{2}' offscreen={3}" -f ($d.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''),
        $d.Current.AutomationId, $n, $d.Current.IsOffscreen | Write-Host -ForegroundColor Green
}
if ($hits -eq 0) { Write-Host "  none" -ForegroundColor DarkGray }

Write-Host "`n--- total elements in meeting window: $($all.Count) ---"
