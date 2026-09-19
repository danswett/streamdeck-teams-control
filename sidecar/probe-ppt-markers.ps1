<#
    Diagnostic: which PowerPoint Live markers are currently in the tree, and
    in which window.

    Teams unmounts the slide-show toolbar subtree when the pointer is away, so
    'ppt-previewer-root' being missing does not mean the deck has stopped. This
    reports each marker separately so the two can be told apart.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

$MARKERS = @(
    'ppt-previewer-root',
    'slideShowToolbarId',
    'slideshow-app-container',
    'stopPresentingPptBtn',
    'takeControlPptBtn',
    'fluent-grid-view',
    'ink-tool-0',
    'microphone-button'
)

$windows = $AE::RootElement.FindAll($TS::Children, $TRUE_COND) |
    Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' }

Write-Host "$($windows.Count) Teams top-level window(s)"

foreach ($w in $windows) {
    $c = $w.Current
    Write-Host "`n--- pid=$($c.ProcessId) class='$($c.ClassName)' name='$($c.Name)'"
    foreach ($id in $MARKERS) {
        $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
        $el = $w.FindFirst($TS::Descendants, $cond)
        if ($el) {
            $r = $el.Current.BoundingRectangle
            "    {0,-26} FOUND  name='{1}' rect={2},{3} {4}x{5}" -f `
                $id, $el.Current.Name, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height | Write-Host
        } else {
            "    {0,-26} -" -f $id | Write-Host
        }
    }
}
