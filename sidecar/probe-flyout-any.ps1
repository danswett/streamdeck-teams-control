param(
    [string[]]$AnchorIds = @('raisehands-button', 'like-button', 'switch-rmcm', 'switch-rmco'),
    [switch]$Recover
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Get-TeamsWindows {
    $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' }
}

function Test-ToolbarVisible {
    foreach ($w in Get-TeamsWindows) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
        if ($w.FindFirst($TS::Descendants, $c)) { return $true }
    }
    return $false
}

Write-Host "toolbar visible at start: $(Test-ToolbarVisible)"

$anchor = $null
foreach ($w in Get-TeamsWindows) {
    foreach ($id in $AnchorIds) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
        $el = $w.FindFirst($TS::Descendants, $c)
        if ($el) { $anchor = $el; Write-Host "anchor '$id' found in '$($w.Current.Name)'"; break }
    }
    if ($anchor) { break }
}

if (-not $anchor) { Write-Host "no open flyout anchor found"; return }

Write-Host "`n--- ancestor chain ---"
$chain = @()
$cur = $walker.GetParent($anchor)
for ($i = 0; $i -lt 10 -and $cur; $i++) {
    $c = $cur.Current
    $pats = ($cur.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '' }) -join ','
    "[{0,2}] <{1}> id='{2}' name='{3}' pats={4}" -f $i,
        ($c.ControlType.ProgrammaticName -replace 'ControlType\.',''), $c.AutomationId, $c.Name, $pats | Write-Host
    $chain += $cur
    $cur = $walker.GetParent($cur)
}

if (-not $Recover) { return }

Write-Host "`n--- attempting dismissal ---"
for ($i = 0; $i -lt $chain.Count; $i++) {
    $node = $chain[$i]
    $type = $node.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    try { $inv = $node.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) }
    catch { continue }
    Write-Host "[$i] <$type> invoking..."
    try { $inv.Invoke() } catch { Write-Host "   threw: $($_.Exception.Message)"; continue }
    Start-Sleep -Milliseconds 800
    if (Test-ToolbarVisible) { Write-Host "   DISMISSED by ancestor $i (<$type>)"; return }
}
Write-Host "toolbar visible after attempts: $(Test-ToolbarVisible)"
