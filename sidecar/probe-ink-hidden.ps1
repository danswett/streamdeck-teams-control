<#
    Checks whether ink colour and thickness can be reached while the drawing
    tool's flyout is CLOSED.

    Opening that flyout is not free: it covers the slide on the presenter's own
    screen, and it unmounts the whole slide-show subtree while it is up. If the
    controls are in the tree without it, a dial can set them invisibly.

    Companion to probe-hidden-items.ps1, which asked the same question of the
    reaction and background flyouts.
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
if (-not $meeting) { Write-Host "no PowerPoint Live surface - is a deck being presented (and no flyout open)?" -ForegroundColor Red; return }

Write-Host "window: '$($meeting.Current.Name)'" -ForegroundColor Cyan
Write-Host "slide-show subtree is present, so no flyout is open.`n"

Write-Host "--- the ink tools themselves, in full ---"
foreach ($id in @('ink-tool-0', 'ink-tool-1', 'ink-tool-2', 'ink-tool-3', 'ink-tool-4')) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
    $el = $meeting.FindFirst($TS::Descendants, $c)
    if (-not $el) { "  {0,-12} not in tree" -f $id | Write-Host -ForegroundColor DarkGray; continue }

    $cur = $el.Current
    $pats = ($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '' }) -join ','
    "  {0,-12} name='{1}'" -f $id, $cur.Name | Write-Host -ForegroundColor Green
    "               pats={0}" -f $pats | Write-Host
    "               accessKey='{0}' accelerator='{1}' help='{2}'" -f $cur.AccessKey, $cur.AcceleratorKey, $cur.HelpText | Write-Host

    # A Value pattern on the tool itself would be the cleanest route of all.
    try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        "               VALUE='{0}' readonly={1}" -f $vp.Current.Value, $vp.Current.IsReadOnly | Write-Host -ForegroundColor Yellow
    } catch { }
}

Write-Host "`n--- any Slider in the tree with the flyout CLOSED? ---"
$sliders = $meeting.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Slider)))
if ($sliders.Count -eq 0) { Write-Host "  none" -ForegroundColor DarkGray }
foreach ($s in $sliders) {
    "  name='{0}' id='{1}' offscreen={2}" -f $s.Current.Name, $s.Current.AutomationId, $s.Current.IsOffscreen | Write-Host -ForegroundColor Green
}

Write-Host "`n--- any colour-named RadioButton with the flyout CLOSED? ---"
$radios = $meeting.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::RadioButton)))
Write-Host "  $($radios.Count) radio button(s) in the tree"
foreach ($r in $radios) {
    "    name='{0}' offscreen={1}" -f $r.Current.Name, $r.Current.IsOffscreen | Write-Host -ForegroundColor Green
}

# The control view hides anything Chromium marks presentational; the raw view
# does not. If the swatches exist but are filtered out, they show up here.
Write-Host "`n--- raw tree beneath the toolbar, element counts ---"
$rawWalker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$ctrlWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$barCond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'slideShowToolbarId')
$bar = $meeting.FindFirst($TS::Descendants, $barCond)
if ($bar) {
    function Count-Tree($walker, $node, $depth) {
        if ($depth -gt 6) { return 0 }
        $n = 0
        $child = $walker.GetFirstChild($node)
        while ($child) { $n += 1 + (Count-Tree $walker $child ($depth + 1)); $child = $walker.GetNextSibling($child) }
        return $n
    }
    "  control view: {0}" -f (Count-Tree $ctrlWalker $bar 0) | Write-Host
    "  raw view:     {0}" -f (Count-Tree $rawWalker $bar 0) | Write-Host
} else {
    Write-Host "  toolbar not found"
}
