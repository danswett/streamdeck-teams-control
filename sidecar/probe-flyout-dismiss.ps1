$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

$all = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $all) {
    $p = (Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    if ($p -ne 'ms-teams') { continue }

    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'raisehands-button')
    $el = $w.FindFirst($TS::Descendants, $cond)
    if ($null -eq $el) { continue }

    Write-Host "Found open React flyout in '$($w.Current.Name)'"
    Write-Host "`n--- ancestor chain ---"
    $cur = $el
    $depth = 0
    while ($null -ne $cur -and $depth -lt 14) {
        $c = $cur.Current
        $pats = ($cur.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '' }) -join ','
        "[{0,2}] <{1}> id='{2}' name='{3}' pats={4}" -f $depth,
            ($c.ControlType.ProgrammaticName -replace 'ControlType\.',''), $c.AutomationId, $c.Name, $pats | Write-Host
        $cur = $walker.GetParent($cur)
        $depth++
    }

    # Can the menu host still be reached and collapsed even though the toolbar
    # is no longer in the tree?
    Write-Host "`n--- can we still see reaction-menu-button? ---"
    $hc = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'reaction-menu-button')
    $host_ = $w.FindFirst($TS::Descendants, $hc)
    if ($host_) {
        Write-Host "YES - attempting Collapse()"
        try {
            $ec = $host_.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            Write-Host "  state before: $($ec.Current.ExpandCollapseState)"
            $ec.Collapse()
            Start-Sleep -Milliseconds 700
            Write-Host "  state after:  $($ec.Current.ExpandCollapseState)"
        }
        catch { Write-Host "  collapse failed: $($_.Exception.Message)" }
    }
    else {
        Write-Host "NO - host is not in the accessibility tree while the flyout is open"
    }
}

Write-Host "`n--- toolbar visible again? ---"
$all2 = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $all2) {
    $p = (Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    if ($p -ne 'ms-teams') { continue }
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
    $mic = $w.FindFirst($TS::Descendants, $c)
    "'{0}' microphone-button={1}" -f $w.Current.Name, $(if ($mic) { "YES ('$($mic.Current.Name)')" } else { 'no' }) | Write-Host
}
