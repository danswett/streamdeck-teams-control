<#
    What is left to navigate with when presenter view is closed.

    The filmstrip lives in presenter view, so the direct slide jump goes with it.
    This hides presenter view, reports what remains in the tree, and puts it
    back - looking for anything that still names or reaches a specific slide.

    Run with the slide counter visible. It restores presenter view on the way
    out, including if a step fails.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

function Get-Meeting {
    foreach ($w in ($AE::RootElement.FindAll($TS::Children, $TRUE_COND) |
            Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' })) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'ppt-previewer-root')
        if ($w.FindFirst($TS::Descendants, $c)) { return $w }
    }
    return $null
}

function Report($label) {
    $m = Get-Meeting
    if (-not $m) { "  $label : no PowerPoint Live surface" | Write-Host; return }

    $items = @($m.FindAll($TS::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))) |
        Where-Object { $_.Current.BoundingRectangle.Width -ge 100 -and $_.Current.BoundingRectangle.Height -ge 60 })

    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'slideshow-app-container')
    $surface = $m.FindFirst($TS::Descendants, $c)

    "  {0,-22} slide-sized ListItems={1}  live surface='{2}'" -f $label, $items.Count, $(if ($surface) { $surface.Current.Name } else { '(none)' }) | Write-Host

    # Anything that reads like "N of M" is the counter, and may itself be a control.
    $texts = $m.FindAll($TS::Descendants, $TRUE_COND)
    foreach ($el in $texts) {
        $n = ''
        try { $n = $el.Current.Name } catch { continue }
        if ($n -notmatch '^\s*\d+\s+of\s+\d+\s*$') { continue }

        $patterns = @()
        foreach ($p in $el.GetSupportedPatterns()) { $patterns += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '') }
        "      counter '{0}' type={1} id='{2}' patterns: {3}" -f $n, $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', ''), $el.Current.AutomationId, ($patterns -join ', ') | Write-Host
    }
}

Write-Host "--- before ---"
Report "presenter view on"

Write-Host "`nhiding presenter view ..."
& node -e @"
const { spawn } = require('node:child_process');
const p = spawn('sidecar/bin/Debug/net10.0-windows/win-x64/TeamsBridge.exe', [], { stdio: ['pipe','pipe','pipe'] });
let buf='';
p.stdout.on('data', d => { buf += d; if (buf.includes('\"type\":\"result\"')) { p.kill(); process.exit(0); } });
setTimeout(() => p.stdin.write(JSON.stringify({id:1,cmd:'invoke',target:'ppt-hide-presenter-view',arg:''})+'\n'), 1200);
setTimeout(() => { p.kill(); process.exit(0); }, 12000);
"@
Start-Sleep -Milliseconds 2000

Write-Host "--- after ---"
Report "presenter view off"

Write-Host "`nrestoring presenter view ..."
& node -e @"
const { spawn } = require('node:child_process');
const p = spawn('sidecar/bin/Debug/net10.0-windows/win-x64/TeamsBridge.exe', [], { stdio: ['pipe','pipe','pipe'] });
let buf='';
p.stdout.on('data', d => { buf += d; if (buf.includes('\"type\":\"result\"')) { p.kill(); process.exit(0); } });
setTimeout(() => p.stdin.write(JSON.stringify({id:1,cmd:'invoke',target:'ppt-hide-presenter-view',arg:''})+'\n'), 1200);
setTimeout(() => { p.kill(); process.exit(0); }, 12000);
"@
Start-Sleep -Milliseconds 2000
Write-Host "--- restored ---"
Report "presenter view on"
