<#
    Can the grid view reach a slide when presenter view is closed?

    The filmstrip only exists while presenter view is open, so the direct jump
    goes with it. Teams' grid view shows every slide and is available either
    way, which would make it the fallback - if its tiles are invokable.

    Opens the grid, reports what is in it, and closes it again without
    navigating. Does not move the presentation.
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

function Invoke-Control($target) {
    & node -e @"
const { spawn } = require('node:child_process');
const p = spawn('sidecar/bin/Debug/net10.0-windows/win-x64/TeamsBridge.exe', [], { stdio: ['pipe','pipe','pipe'] });
let buf='';
p.stdout.on('data', d => { buf += d;
  const i = buf.indexOf('"type":"result"');
  if (i >= 0) { const line = buf.slice(buf.lastIndexOf('{', i)); console.log(line.split('\n')[0]); p.kill(); process.exit(0); } });
setTimeout(() => p.stdin.write(JSON.stringify({id:1,cmd:'invoke',target:'$target',arg:''})+'\n'), 1200);
setTimeout(() => { p.kill(); process.exit(0); }, 15000);
"@
}

function Slides($m) {
    @($m.FindAll($TS::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))) |
        Where-Object { $_.Current.BoundingRectangle.Width -ge 100 -and $_.Current.BoundingRectangle.Height -ge 60 })
}

$m = Get-Meeting
if (-not $m) { Write-Host "no PowerPoint Live surface" -ForegroundColor Red; return }
"before: slide-sized ListItems={0}" -f (Slides $m).Count | Write-Host

Write-Host "`nopening grid view ..."
Invoke-Control 'ppt-grid'
Start-Sleep -Milliseconds 2500

$m = Get-Meeting
if (-not $m) { Write-Host "surface left the tree while the grid is up" -ForegroundColor Yellow }
else {
    $items = Slides $m
    "grid open: slide-sized ListItems={0}" -f $items.Count | Write-Host
    $n = 0
    foreach ($it in $items) {
        if ($n -ge 4) { break }
        $n++
        $patterns = @()
        foreach ($p in $it.GetSupportedPatterns()) { $patterns += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '') }
        $r = $it.Current.BoundingRectangle
        "   '{0}'  {1}x{2}  patterns: {3}" -f $it.Current.Name, [int]$r.Width, [int]$r.Height, ($patterns -join ', ') | Write-Host
    }
}

Write-Host "`nclosing grid view ..."
Invoke-Control 'ppt-grid'
Start-Sleep -Milliseconds 2500
$m = Get-Meeting
"after: slide-sized ListItems={0}" -f $(if ($m) { (Slides $m).Count } else { -1 }) | Write-Host
