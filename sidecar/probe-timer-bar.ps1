<#
    What Teams' own timer bar is filled with.

    The bar carries a gradient, and the thing worth knowing is whether it is
    scaled to the fill or fixed to the whole trough: a full sweep inside a
    nearly-empty bar means the former, a single end-colour means the latter.
    That decides whether the colours march as it drains or stay put.

    Captures the timer strip and samples across it. Read-only - it neither
    starts, pauses nor resets the timer.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

$meeting = $null
foreach ($w in ($AE::RootElement.FindAll($TS::Children, $TRUE_COND) |
        Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' })) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
    if ($w.FindFirst($TS::Descendants, $c)) { $meeting = $w; break }
}
if (-not $meeting) { Write-Host "no meeting window" -ForegroundColor Red; return }

# The controls button sits in the timer strip, so it locates the band.
$controls = $null
foreach ($el in $meeting.FindAll($TS::Descendants, $TRUE_COND)) {
    $n = ''
    try { $n = $el.Current.Name } catch { continue }
    if ($n -match '^\s*Timer controls\b') { $controls = $el; break }
}
if (-not $controls) { Write-Host "no timer on screen" -ForegroundColor Red; return }
"timer label: '{0}'" -f $controls.Current.Name | Write-Host

$wr = New-Object TCap+RECT
$h = [IntPtr]$meeting.Current.NativeWindowHandle
[TCap]::GetWindowRect($h, [ref]$wr) | Out-Null
$ww = $wr.Right - $wr.Left; $wh = $wr.Bottom - $wr.Top

$bmp = New-Object System.Drawing.Bitmap $ww, $wh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc(); [TCap]::PrintWindow($h, $hdc, 2) | Out-Null; $g.ReleaseHdc($hdc); $g.Dispose()

$cr = $controls.Current.BoundingRectangle
$bandY = [int]($cr.Y + $cr.Height / 2 - $wr.Top)
"sampling window row y={0} (window is {1}x{2})" -f $bandY, $ww, $wh | Write-Host

$bmp.Save("$env:TEMP\timerbar-window.png", [System.Drawing.Imaging.ImageFormat]::Png)

# Walk the row and report every run of colour, so the fill and the trough
# separate themselves without knowing where the bar starts.
$prev = $null; $runStart = 0; $runs = @()
for ($x = 0; $x -lt $ww; $x++) {
    $p = $bmp.GetPixel($x, $bandY)
    $key = "{0},{1},{2}" -f [int]($p.R / 12), [int]($p.G / 12), [int]($p.B / 12)
    if ($key -ne $prev) {
        if ($null -ne $prev) { $runs += [pscustomobject]@{ Start = $runStart; End = $x - 1; Color = $prevColor } }
        $prev = $key; $runStart = $x; $prevColor = $p
    }
}
$runs += [pscustomobject]@{ Start = $runStart; End = $ww - 1; Color = $prevColor }

Write-Host "`n--- colour runs wider than 8px along that row ---"
foreach ($r in $runs) {
    $w = $r.End - $r.Start + 1
    if ($w -lt 8) { continue }
    "  x {0,5}..{1,-5} {2,5}px  #{3:X2}{4:X2}{5:X2}" -f $r.Start, $r.End, $w, $r.Color.R, $r.Color.G, $r.Color.B | Write-Host
}

# Now sample the coloured (non-grey, non-black) span at intervals, which is the fill.
$fillX = @()
for ($x = 0; $x -lt $ww; $x++) {
    $p = $bmp.GetPixel($x, $bandY)
    $max = [Math]::Max($p.R, [Math]::Max($p.G, $p.B))
    $min = [Math]::Min($p.R, [Math]::Min($p.G, $p.B))
    if ($max -gt 70 -and ($max - $min) -gt 25) { $fillX += $x }
}
if ($fillX.Count -eq 0) { Write-Host "`nno coloured fill found on that row" -ForegroundColor Yellow; $bmp.Dispose(); return }

$a = $fillX[0]; $b = $fillX[$fillX.Count - 1]
"`nfill spans x {0}..{1} ({2}px)" -f $a, $b, ($b - $a + 1) | Write-Host
Write-Host "colour across the fill:"
foreach ($f in 0.0, 0.25, 0.5, 0.75, 1.0) {
    $x = [int]($a + ($b - $a) * $f)
    $p = $bmp.GetPixel($x, $bandY)
    "  {0,5:P0} at x={1,5}  #{2:X2}{3:X2}{4:X2}" -f $f, $x, $p.R, $p.G, $p.B | Write-Host
}
$bmp.Dispose()
