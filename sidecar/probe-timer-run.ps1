<#
    Records Teams' timer bar across a whole run, sampled inside the bar itself.

    The first attempt measured the whole window row and so mixed the clock text
    in with the bar. This one is told where the bar is and samples only there:
    one CSV row per frame with the fill boundary and the color at sixteen fixed
    points across the trough.

    Resets the timer, starts it, and records until well past expiry.
#>
param(
    [int]$BarStart = 195,
    [int]$BarEnd = 2299,
    [int]$Seconds = 80,
    [int]$Hz = 10,
    [int]$Points = 16,
    [string]$Out = "$env:TEMP\timerbar2.csv"
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TB3 {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$COND = [System.Windows.Automation.Condition]::TrueCondition

function Get-Meeting {
    foreach ($w in ($AE::RootElement.FindAll($TS::Children, $COND) |
            Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' })) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
        if ($w.FindFirst($TS::Descendants, $c)) { return $w }
    }
    return $null
}

function Find-ByName($m, $pattern) {
    foreach ($el in $m.FindAll($TS::Descendants, $COND)) {
        $n = ''
        try { $n = $el.Current.Name } catch { continue }
        if ($n -match $pattern) { return $el }
    }
    return $null
}

$meeting = Get-Meeting
if (-not $meeting) { Write-Host "no meeting window" -ForegroundColor Red; return }
$controls = Find-ByName $meeting '^\s*Timer controls\b'
if (-not $controls) { Write-Host "no timer" -ForegroundColor Red; return }

$hwnd = [IntPtr]$meeting.Current.NativeWindowHandle
$wr = New-Object TB3+RECT
[TB3]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
$ww = $wr.Right - $wr.Left; $wh = $wr.Bottom - $wr.Top
$cr = $controls.Current.BoundingRectangle
$rowY = [int]($cr.Y + $cr.Height / 2 - $wr.Top)

# Put it back to full, then start it.
$reset = Find-ByName $meeting '^\s*Reset timer\s*$'
if ($reset) { $reset.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 1500 }
"after reset: '{0}'" -f (Find-ByName (Get-Meeting) '^\s*Timer controls\b').Current.Name | Write-Host

$resume = Find-ByName (Get-Meeting) '^\s*(Resume|Start) timer\s*$'
if ($resume) { $resume.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
else { Write-Host "already running" -ForegroundColor Yellow }

$bmp = New-Object System.Drawing.Bitmap $ww, $wh
$gfx = [System.Drawing.Graphics]::FromImage($bmp)

$header = @("ms", "fillStart") + (0..($Points - 1) | ForEach-Object { "p$_" })
$rows = New-Object System.Collections.Generic.List[string]
$rows.Add($header -join ',')

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$interval = [int](1000 / $Hz)
$next = 0
$rect = New-Object System.Drawing.Rectangle 0, $rowY, $ww, 1

while ($sw.ElapsedMilliseconds -lt ($Seconds * 1000)) {
    if ($sw.ElapsedMilliseconds -lt $next) { Start-Sleep -Milliseconds 4; continue }
    $next = $sw.ElapsedMilliseconds + $interval
    $t = $sw.ElapsedMilliseconds

    $hdc = $gfx.GetHdc()
    try { [TB3]::PrintWindow($hwnd, $hdc, 2) | Out-Null } finally { $gfx.ReleaseHdc($hdc) }

    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $buf = New-Object byte[] ($ww * 4)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
    $bmp.UnlockBits($data)

    # Walk in from the right: the fill is right-anchored, so the first dark
    # pixel going left is where it stops.
    $fillStart = $BarStart
    for ($x = $BarEnd; $x -ge $BarStart; $x--) {
        $o = $x * 4
        $b = $buf[$o]; $g = $buf[$o+1]; $r = $buf[$o+2]
        $mx = [Math]::Max($r, [Math]::Max($g, $b)); $mn = [Math]::Min($r, [Math]::Min($g, $b))
        if (-not ($mx -gt 60 -and ($mx - $mn) -gt 18)) { $fillStart = $x + 1; break }
    }

    $cells = @()
    for ($i = 0; $i -lt $Points; $i++) {
        $x = [int]($BarStart + ($BarEnd - $BarStart) * $i / ($Points - 1))
        $o = $x * 4
        $cells += ('{0:X2}{1:X2}{2:X2}' -f $buf[$o+2], $buf[$o+1], $buf[$o])
    }

    $rows.Add(("{0},{1},{2}" -f $t, $fillStart, ($cells -join ',')))
}

$sw.Stop()
$gfx.Dispose(); $bmp.Dispose()
Set-Content -Path $Out -Value $rows
"wrote {0} rows to {1}" -f ($rows.Count - 1), $Out | Write-Host
"final: '{0}'" -f (Find-ByName (Get-Meeting) '^\s*Timer controls\b').Current.Name | Write-Host
