<#
    Reconnaissance of the PowerPoint Live drawing-tool flyout.

    The sidecar can already read which ink colour is selected, because the
    swatches are radio buttons it can see once the flyout is open. What it has
    never had is a way to *set* a colour or a thickness, and the thickness
    control's shape had never been recorded at all.

    Two things this established, both worth keeping:

      * The tools are ListItems, and the three that carry a colour - pen,
        highlighter, laser - support ExpandCollapse. So the flyout opens
        through the pattern rather than through a posted click, which is both
        faster and far less likely to land somewhere unintended.
      * Cursor and eraser have Invoke only. They have nothing to configure, so
        a colour or thickness dial must leave them alone.

    Without -Expand this only reads, so it is safe during a real presentation.
    With -Expand it opens one tool's flyout, diffs what appeared, and closes it
    again.

    Examples:
      powershell -File sidecar/probe-ink-flyout.ps1
      powershell -File sidecar/probe-ink-flyout.ps1 -Expand ink-tool-0
#>
param(
    [string]$ToolbarId = 'slideShowToolbarId',
    [string]$RootId = 'ppt-previewer-root',
    [string]$Expand = '',
    [switch]$Select,
    [int]$HoldMs = 1200
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

$INTERACTIVE = @('Button', 'RadioButton', 'CheckBox', 'MenuItem', 'ListItem', 'Slider', 'Spinner', 'ComboBox')

function Get-TeamsWindows {
    $AE::RootElement.FindAll($TS::Children, $TRUE_COND) |
        Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' }
}

function Format-Element($el) {
    $c = $el.Current
    $type = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    $pats = ($el.GetSupportedPatterns() |
        ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '' }) -join ','

    $extra = ''
    try {
        $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $extra += "  selected=$($sp.Current.IsSelected)"
    } catch { }
    try {
        $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $extra += "  toggle=$($tp.Current.ToggleState)"
    } catch { }
    try {
        $rv = $el.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
        $extra += "  range=$($rv.Current.Minimum)..$($rv.Current.Maximum) value=$($rv.Current.Value)"
    } catch { }

    $r = $c.BoundingRectangle
    "<{0}> id='{1}' name='{2}'{3} pats={4} rect={5},{6} {7}x{8}" -f `
        $type, $c.AutomationId, $c.Name, $extra, $pats, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height
}

function Get-Interactive($scope) {
    $out = [ordered]@{}
    foreach ($el in $scope.FindAll($TS::Descendants, $TRUE_COND)) {
        try {
            $c = $el.Current
            $type = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
            if ($type -notin $INTERACTIVE) { continue }
            if ([string]::IsNullOrWhiteSpace($c.Name) -and [string]::IsNullOrWhiteSpace($c.AutomationId)) { continue }
            $key = "$type|$($c.AutomationId)|$($c.Name)"
            if (-not $out.Contains($key)) { $out[$key] = $el }
        } catch { }
    }
    return $out
}

<#
    Teams renders a flyout into a popup that is often a top-level window of its
    own rather than a child of the meeting window, so a search rooted at the
    meeting window finds nothing. Every Teams window is re-enumerated on each
    snapshot, which also catches a popup that did not exist beforehand.
#>
function Get-InteractiveEverywhere {
    $out = [ordered]@{}
    foreach ($w in Get-TeamsWindows) {
        foreach ($entry in (Get-Interactive $w).GetEnumerator()) {
            if (-not $out.Contains($entry.Key)) { $out[$entry.Key] = $entry.Value }
        }
    }
    return $out
}

$window = $null
foreach ($w in Get-TeamsWindows) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $RootId)
    if ($w.FindFirst($TS::Descendants, $cond)) { $window = $w; break }
}
if (-not $window) { Write-Host "no PowerPoint Live surface found - is a deck being presented?"; return }

Write-Host "window: '$($window.Current.Name)'"

$before = Get-InteractiveEverywhere

if (-not $Expand) {
    Write-Host "`n=== toolbar ==="
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $ToolbarId)
    $bar = $window.FindFirst($TS::Descendants, $cond)
    if ($bar) { foreach ($el in (Get-Interactive $bar).Values) { Write-Host "   $(Format-Element $el)" } }
    return
}

$cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $Expand)
$tool = $window.FindFirst($TS::Descendants, $cond)
if (-not $tool) { Write-Host "no element with AutomationId '$Expand'"; return }

Write-Host "`ntool: $(Format-Element $tool)"

# A tool that is not the active one may refuse to open its own options, so it
# is selected first when asked. The tool that was active is put back at the end.
$restore = $null
if ($Select) {
    foreach ($el in (Get-Interactive $window).Values) {
        try {
            if ($el.Current.AutomationId -notlike 'ink-tool-*') { continue }
            $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($sp.Current.IsSelected) { $restore = $el; break }
        } catch { }
    }
    Write-Host "selecting '$Expand' (was '$($restore.Current.AutomationId)')"
    try { $tool.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
    catch { Write-Host "   select threw: $($_.Exception.Message)" }
    Start-Sleep -Milliseconds 700
    $tool = $window.FindFirst($TS::Descendants, $cond)
    if ($tool) { Write-Host "tool now: $(Format-Element $tool)" }
    $before = Get-InteractiveEverywhere
}

try {
    $ec = $tool.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
} catch {
    Write-Host "'$Expand' has no ExpandCollapse pattern - nothing to configure on it"
    return
}

Write-Host "expanding (state before: $($ec.Current.ExpandCollapseState))..."
$ec.Expand()
Start-Sleep -Milliseconds $HoldMs
try { Write-Host "state after: $($ec.Current.ExpandCollapseState)" } catch { }

$after = Get-InteractiveEverywhere
Write-Host "`n=== appeared while '$Expand' was open ($($before.Count) -> $($after.Count)) ==="
foreach ($key in $after.Keys) {
    if ($before.Contains($key)) { continue }
    Write-Host "   $(Format-Element $after[$key])"
}

<#
    Closing matters more than it looks. An open flyout unmounts the whole
    slide-show subtree - 'ppt-previewer-root' and every ink tool disappear from
    the tree entirely - so leaving one open blinds this probe, the sidecar, and
    anything else reading the deck. The first run of this script did exactly
    that and the surface looked, wrongly, like it had stopped being presented.

    The element the pattern came from is stale by now for the same reason, so
    the tool is found again before collapsing, and the close is confirmed by
    watching for the subtree to come back rather than assumed.
#>
Write-Host "`nclosing..."
for ($attempt = 1; $attempt -le 4; $attempt++) {
    $rootCond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $RootId)
    $back = $false
    foreach ($w in Get-TeamsWindows) { if ($w.FindFirst($TS::Descendants, $rootCond)) { $back = $true; break } }
    if ($back) { Write-Host "   slide-show subtree is back after $($attempt - 1) attempt(s)"; break }

    foreach ($w in Get-TeamsWindows) {
        $again = $w.FindFirst($TS::Descendants, $cond)
        if (-not $again) { continue }
        try { $again.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() }
        catch { Write-Host "   collapse threw: $($_.Exception.Message)" }
    }
    Start-Sleep -Milliseconds 600
}

$rootCond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $RootId)
$recovered = $false
foreach ($w in Get-TeamsWindows) { if ($w.FindFirst($TS::Descendants, $rootCond)) { $recovered = $true; break } }
if (-not $recovered) {
    Write-Host "   STILL OPEN - click anywhere on the slide to dismiss it, or the deck stays invisible to the plugin"
}

# Re-read the tool: its name carries the colour and thickness it now holds.
$tool2 = $null
foreach ($w in Get-TeamsWindows) { $tool2 = $w.FindFirst($TS::Descendants, $cond); if ($tool2) { break } }
if ($tool2) { Write-Host "tool after: $(Format-Element $tool2)" }

if ($restore) {
    try {
        $restore.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        Write-Host "restored '$($restore.Current.AutomationId)'"
    } catch { Write-Host "could not restore the previous tool: $($_.Exception.Message)" }
}
