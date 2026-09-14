$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Get-MeetingWindows {
    $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' }
}

function Test-ToolbarVisible {
    foreach ($w in Get-MeetingWindows) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
        if ($w.FindFirst($TS::Descendants, $c)) { return $true }
    }
    return $false
}

function Find-FlyoutAnchor {
    foreach ($w in Get-MeetingWindows) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'raisehands-button')
        $el = $w.FindFirst($TS::Descendants, $c)
        if ($el) { return $el }
    }
    return $null
}

$anchor = Find-FlyoutAnchor
if (-not $anchor) { Write-Host "no open flyout found"; return }

# Walk up collecting ancestors so each can be tried in turn.
$chain = @()
$cur = $walker.GetParent($anchor)
for ($i = 0; $i -lt 6 -and $cur; $i++) { $chain += $cur; $cur = $walker.GetParent($cur) }

for ($i = 0; $i -lt $chain.Count; $i++) {
    $node = $chain[$i]
    $type = $node.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    try {
        $inv = $node.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    }
    catch { Write-Host "[$i] <$type> no Invoke"; continue }

    Write-Host "[$i] <$type> invoking..."
    try { $inv.Invoke() } catch { Write-Host "   invoke threw: $($_.Exception.Message)"; continue }
    Start-Sleep -Milliseconds 800
    if (Test-ToolbarVisible) { Write-Host "   TOOLBAR BACK - dismissed by invoking ancestor $i (<$type>)"; return }
}

Write-Host "`nancestor invoke did not dismiss; trying SetFocus on the meeting document"
foreach ($w in Get-MeetingWindows) {
    $dc = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'RootWebArea')
    $doc = $w.FindFirst($TS::Descendants, $dc)
    if ($doc) {
        try { $doc.SetFocus(); Write-Host "SetFocus on document OK" } catch { Write-Host "SetFocus failed: $($_.Exception.Message)" }
        Start-Sleep -Milliseconds 900
        if (Test-ToolbarVisible) { Write-Host "TOOLBAR BACK - dismissed by SetFocus"; return }
    }
}

Write-Host "still stuck: toolbar visible = $(Test-ToolbarVisible)"
