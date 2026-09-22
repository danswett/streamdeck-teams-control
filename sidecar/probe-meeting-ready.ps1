<#
    Times how long Teams takes to expose a meeting's controls.

    Detection currently lands about 4.3s after a meeting window opens, and the
    open question is whose 4.3s that is. The sidecar polls every ~500ms while
    chasing, so anything it reports is rounded up to the next poll and includes
    its own work; this instead watches for the window with Win32 and then asks
    for the control as fast as UI Automation will answer.

    If the two numbers agree, the wait belongs to Teams building its
    accessibility tree and there is nothing left to win from outside it. If
    this is much faster, the sidecar is leaving time on the table.

    Read-only: it opens nothing, presses nothing, and does not nudge. Start it,
    then join a meeting.
#>
param(
    [string]$Probe = "microphone-button",
    [int]$TimeoutSeconds = 120,
    [switch]$Nudge
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$win32 = @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class MW {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, Proc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  public static List<IntPtr> Visible(uint[] pids) {
    var o = new List<IntPtr>();
    EnumWindows((h,l) => { uint p; GetWindowThreadProcessId(h, out p);
      foreach (var w in pids) if (p == w && IsWindowVisible(h)) o.Add(h);
      return true; }, IntPtr.Zero);
    return o; }
  public static void Wake(IntPtr top) {
    var all = new List<IntPtr> { top };
    EnumChildWindows(top, (h,l) => { all.Add(h); return true; }, IntPtr.Zero);
    IntPtr r;
    foreach (var h in all) SendMessageTimeout(h, 0x003D, IntPtr.Zero, new IntPtr(-4), 0x0002, 250, out r);
  }
}
'@
Add-Type -TypeDefinition $win32 -ErrorAction SilentlyContinue

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $Probe)

function Get-Pids { [uint[]](Get-Process ms-teams -ErrorAction SilentlyContinue | ForEach-Object { [uint]$_.Id }) }

$before = [System.Collections.Generic.HashSet[IntPtr]]::new()
foreach ($h in [MW]::Visible((Get-Pids))) { [void]$before.Add($h) }

Write-Host "watching $($before.Count) visible Teams window(s). Join a meeting now." -ForegroundColor Cyan
Write-Host ("nudging: {0}" -f $(if ($Nudge) { "yes" } else { "no" })) -ForegroundColor DarkGray

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$opened = $null
$openedAt = $null

while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($h in [MW]::Visible((Get-Pids))) {
        if ($before.Contains($h)) { continue }
        $opened = $h
        $openedAt = [System.Diagnostics.Stopwatch]::StartNew()
        break
    }
    if ($opened) { break }
    Start-Sleep -Milliseconds 20
}

if (-not $opened) { Write-Host "no new Teams window appeared" -ForegroundColor Yellow; return }

Write-Host ("new window 0x{0:x} - polling for '{1}' as fast as UIA answers" -f $opened.ToInt64(), $Probe) -ForegroundColor Green

$found = $null
$attempts = 0
while ($openedAt.ElapsedMilliseconds -lt ($TimeoutSeconds * 1000)) {
    $attempts++
    if ($Nudge) { [MW]::Wake($opened) }
    try {
        $el = $AE::FromHandle($opened)
        if ($el -and $el.FindFirst($TS::Descendants, $cond)) { $found = $openedAt.ElapsedMilliseconds; break }
    }
    catch { }
}

if ($null -eq $found) {
    Write-Host "the control never appeared in that window" -ForegroundColor Yellow
    return
}

Write-Host ""
Write-Host ("'{0}' became findable {1}ms after the window opened, over {2} attempts" -f $Probe, $found, $attempts) -ForegroundColor Green
Write-Host "compare with the sidecar's 'meeting detected NNNms' for the same join." -ForegroundColor DarkGray
