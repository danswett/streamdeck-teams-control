<#
    Does invoking a filmstrip slide navigate the deck?

    Walking the deck with repeated next presses is what the removed slide dial
    did, and it is slow and lossy over a long spin. The filmstrip items carry
    Invoke, which would be a direct jump. This finds out whether it works, and
    whether it works for a slide scrolled out of view.

    This one DOES move the presentation - that is the thing being tested. It
    jumps forward two slides and then back to where it started, so the deck is
    left where it was found.
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

function Get-Strip {
    @($meeting.FindAll($TS::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))) |
        Where-Object { $_.Current.BoundingRectangle.Width -ge 100 -and $_.Current.BoundingRectangle.Height -ge 60 }) |
        Sort-Object { $_.Current.BoundingRectangle.X }
}

function Get-LiveName {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'slideshow-app-container')
    $el = $meeting.FindFirst($TS::Descendants, $c)
    if ($el) { return $el.Current.Name } else { return '(none)' }
}

function Get-SelectedIndex($strip) {
    for ($i = 0; $i -lt $strip.Count; $i++) {
        try { if ($strip[$i].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { return $i } } catch { }
    }
    return -1
}

$strip = Get-Strip
$start = Get-SelectedIndex $strip
$startLive = Get-LiveName
"START  index={0} '{1}'  live='{2}'  ({3} slides)" -f $start, $strip[$start].Current.Name, $startLive, $strip.Count | Write-Host

$goto = $start + 2
if ($goto -ge $strip.Count) { $goto = [Math]::Max(0, $start - 2) }
$el = $strip[$goto]
"`nInvoke on index={0} '{1}' (offscreen={2})" -f $goto, $el.Current.Name, $el.Current.IsOffscreen | Write-Host

try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
catch { Write-Host "  Invoke threw: $($_.Exception.Message)" -ForegroundColor Red; return }

Start-Sleep -Milliseconds 1200
$after = Get-SelectedIndex (Get-Strip)
$afterLive = Get-LiveName
"AFTER  index={0}  live='{1}'" -f $after, $afterLive | Write-Host

if ($after -eq $goto) { Write-Host "`nPASS: Invoke navigates straight to a slide." -ForegroundColor Green }
else { Write-Host "`nFAIL: expected index $goto, got $after" -ForegroundColor Red }

# Put the deck back where it was found.
Write-Host "`nrestoring to index=$start ..."
(Get-Strip)[$start].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep -Milliseconds 1200
"restored: index={0} live='{1}'" -f (Get-SelectedIndex (Get-Strip)), (Get-LiveName) | Write-Host
