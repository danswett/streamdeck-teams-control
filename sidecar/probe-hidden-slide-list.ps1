<#
    Is there a slide list in the tree when nothing is open?

    The earlier probes filtered list items by size, so anything Teams keeps
    mounted at zero size would have been thrown away. This looks for every list
    item regardless of size, and for anything at all named after a slide, with
    presenter view and the grid both closed.

    Read-only. Opens nothing and moves nothing.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

$meeting = $null
foreach ($w in ($AE::RootElement.FindAll($TS::Children, $TRUE_COND) |
        Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' })) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'ppt-previewer-root')
    if ($w.FindFirst($TS::Descendants, $c)) { $meeting = $w; break }
}
if (-not $meeting) { Write-Host "no PowerPoint Live surface" -ForegroundColor Red; return }

$all = $meeting.FindAll($TS::Descendants, $TRUE_COND)
"total descendants: {0}" -f $all.Count | Write-Host

Write-Host "`n--- every ListItem, any size ---"
$n = 0
foreach ($el in $all) {
    if ($el.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) { continue }
    $n++
    if ($n -gt 20) { continue }
    $r = $el.Current.BoundingRectangle
    $patterns = @()
    foreach ($p in $el.GetSupportedPatterns()) { $patterns += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '') }
    "  '{0}' {1}x{2} offscreen={3}  {4}" -f $el.Current.Name, [int]$r.Width, [int]$r.Height, $el.Current.IsOffscreen, ($patterns -join ',') | Write-Host
}
"  ListItems total: {0}" -f $n | Write-Host

Write-Host "`n--- any List / DataGrid containers ---"
foreach ($el in $all) {
    $t = $el.Current.ControlType
    if ($t -ne [System.Windows.Automation.ControlType]::List -and $t -ne [System.Windows.Automation.ControlType]::DataGrid) { continue }
    $r = $el.Current.BoundingRectangle
    $kids = $el.FindAll($TS::Children, $TRUE_COND).Count
    "  {0} id='{1}' name='{2}' {3}x{4} children={5}" -f $t.ProgrammaticName.Replace('ControlType.', ''), $el.Current.AutomationId, $el.Current.Name, [int]$r.Width, [int]$r.Height, $kids | Write-Host
}

Write-Host "`n--- anything invokable that names a slide-ish thing ---"
$seen = 0
foreach ($el in $all) {
    $name = ''
    try { $name = $el.Current.Name } catch { continue }
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if ($name.Length -gt 60) { continue }

    $hasInvoke = $false
    foreach ($p in $el.GetSupportedPatterns()) { if ($p.ProgrammaticName -match 'Invoke') { $hasInvoke = $true } }
    if (-not $hasInvoke) { continue }

    $seen++
    if ($seen -gt 40) { continue }
    "  '{0}' type={1} id='{2}'" -f $name, $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', ''), $el.Current.AutomationId | Write-Host
}
"  invokable total: {0}" -f $seen | Write-Host
