<#
    The grid, tested as the grid.

    Earlier probes looked for "slide-sized list items" and found the filmstrip,
    which is present whenever presenter view is open - so they never opened the
    grid and never tested it. The grid has its own container, fluent-grid-view,
    named in selectors.json as what makes ppt-grid read as active. Scope to
    that and the two lists cannot be confused.

    Captures the window at each step so the visual effect of SetFocus and
    Select can be looked at rather than inferred. Restores the starting slide.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cap2 {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition
$SIDECAR = 'sidecar/bin/Debug/net10.0-windows/win-x64/TeamsBridge.exe'
$OUT = "$env:TEMP\gv"

function Get-Meeting {
    foreach ($w in ($AE::RootElement.FindAll($TS::Children, $TRUE_COND) |
            Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' })) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'ppt-previewer-root')
        if ($w.FindFirst($TS::Descendants, $c)) { return $w }
    }
    return $null
}

function Get-GridRoot {
    $m = Get-Meeting
    if (-not $m) { return $null }
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'fluent-grid-view')
    return $m.FindFirst($TS::Descendants, $c)
}

function Toggle-Grid {
    $js = @"
const { spawn } = require('node:child_process');
const p = spawn('$SIDECAR', [], { stdio: ['pipe','pipe','pipe'] });
let buf='';
p.stdout.on('data', d => { buf += d; if (buf.includes('"type":"result"')) { p.kill(); process.exit(0); } });
setTimeout(() => p.stdin.write(JSON.stringify({id:1,cmd:'invoke',target:'ppt-grid',arg:''})+'\n'), 1500);
setTimeout(() => { p.kill(); process.exit(0); }, 20000);
"@
    & node -e $js | Out-Null
}

function GridTiles {
    $g = Get-GridRoot
    if (-not $g) { return @() }
    @($g.FindAll($TS::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)))) |
        Sort-Object { [int]$_.Current.BoundingRectangle.Y * 10000 + [int]$_.Current.BoundingRectangle.X }
}

function ContainerName {
    $m = Get-Meeting
    if (-not $m) { return '(none)' }
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'slideshow-app-container')
    $el = $m.FindFirst($TS::Descendants, $c)
    if ($el) { return $el.Current.Name } else { return '(none)' }
}

function Shoot($label) {
    $m = Get-Meeting
    if (-not $m) { return }
    $h = [IntPtr]$m.Current.NativeWindowHandle
    if ($h -eq [IntPtr]::Zero) { return }
    $r = New-Object Cap2+RECT
    [Cap2]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
    if ($w -le 0 -or $ht -le 0) { return }
    $bmp = New-Object System.Drawing.Bitmap $w, $ht
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc(); [Cap2]::PrintWindow($h, $hdc, 2) | Out-Null; $g.ReleaseHdc($hdc); $g.Dispose()
    $bmp.Save("$OUT-$label.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    "    saved $OUT-$label.png" | Write-Host
}

function Describe($tiles) {
    $sel = -1; $foc = -1
    for ($i = 0; $i -lt $tiles.Count; $i++) {
        try { if ($tiles[$i].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $sel = $i } } catch { }
        try { if ($tiles[$i].Current.HasKeyboardFocus) { $foc = $i } } catch { }
    }
    "tiles={0} selected={1} focused={2} container='{3}'" -f $tiles.Count, $sel, $foc, (ContainerName)
}

"grid container present at start: {0}" -f [bool](Get-GridRoot) | Write-Host
if (-not (Get-GridRoot)) { Write-Host "opening grid ..."; Toggle-Grid; Start-Sleep -Milliseconds 3500 }
if (-not (Get-GridRoot)) { Write-Host "grid still not open - aborting" -ForegroundColor Red; return }

$tiles = GridTiles
"BASELINE {0}" -f (Describe $tiles) | Write-Host
Shoot "0-base"
if ($tiles.Count -lt 5) { Write-Host "too few grid tiles" -ForegroundColor Red; Toggle-Grid; return }

$startSel = -1
for ($i = 0; $i -lt $tiles.Count; $i++) { try { if ($tiles[$i].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $startSel = $i } } catch { } }
if ($startSel -lt 0) { $startSel = 0 }
$target = if ($startSel + 4 -lt $tiles.Count) { $startSel + 4 } else { [Math]::Max(0, $startSel - 4) }

"`nSetFocus on grid tile index {0} '{1}'" -f $target, $tiles[$target].Current.Name | Write-Host
$tiles[$target].SetFocus()
Start-Sleep -Milliseconds 1500
"  {0}" -f (Describe (GridTiles)) | Write-Host
Shoot "1-focus"

"`nSelect on grid tile index {0}" -f $target | Write-Host
(GridTiles)[$target].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
Start-Sleep -Milliseconds 1500
"  {0}" -f (Describe (GridTiles)) | Write-Host
Shoot "2-select"

Write-Host "`nclosing grid WITHOUT invoking ..."
Toggle-Grid
Start-Sleep -Milliseconds 3000
"  after close: container='{0}'" -f (ContainerName) | Write-Host
Shoot "3-closed"
