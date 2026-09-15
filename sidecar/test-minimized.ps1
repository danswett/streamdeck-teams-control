<#
    Verifies the core requirement: controls work while Teams is minimised and
    unfocused, with no keystrokes sent.

    The Teams meeting window is minimised via ShowWindow (a window-manager call,
    not input), mute is toggled twice through the sidecar, and the reported state
    is checked after each toggle. The window is restored at the end.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json"
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }
}
'@

$SW_MINIMIZE = 6
$SW_RESTORE = 9

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Process.MainWindowHandle returns only one of Teams' several top-level windows,
# so the meeting window is located through UI Automation instead.
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$hwnd = [IntPtr]::Zero
$title = ''
foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $p = (Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    if ($p -ne 'ms-teams') { continue }
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
    if ($w.FindFirst($TS::Descendants, $c)) {
        $hwnd = [IntPtr]$w.Current.NativeWindowHandle
        $title = $w.Current.Name
        break
    }
}
if ($hwnd -eq [IntPtr]::Zero) { throw "no Teams meeting window found - join a meeting first" }
Write-Host "Meeting window: '$title' hwnd=$hwnd"

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$outTask = $proc.StandardOutput.ReadToEndAsync()

function Send([string]$json, [int]$waitMs = 2000) {
    $proc.StandardInput.WriteLine($json); $proc.StandardInput.Flush()
    Start-Sleep -Milliseconds $waitMs
}

Start-Sleep -Milliseconds 1500
Send '{"id":1,"cmd":"status"}' 1500

Write-Host "`nMinimising Teams..." -ForegroundColor Yellow
[void][Win]::ShowWindow($hwnd, $SW_MINIMIZE)
Start-Sleep -Seconds 2
Write-Host "  IsIconic(minimised) = $([Win]::IsIconic($hwnd))"
Write-Host "  foreground window   = '$([Win]::Title([Win]::GetForegroundWindow()))'"

Write-Host "`nToggling mute twice while minimised..." -ForegroundColor Yellow
Send '{"id":2,"cmd":"invoke","target":"mute"}' 2000
Send '{"id":3,"cmd":"status"}' 1200
Send '{"id":4,"cmd":"invoke","target":"mute"}' 2000
Send '{"id":5,"cmd":"status"}' 1200

Write-Host "`nStill minimised? $([Win]::IsIconic($hwnd))" -ForegroundColor Yellow
Write-Host "Foreground window: '$([Win]::Title([Win]::GetForegroundWindow()))'"

Write-Host "`nRestoring Teams..." -ForegroundColor Yellow
[void][Win]::ShowWindow($hwnd, $SW_RESTORE)

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }

Write-Host "`n===== TRACE =====" -ForegroundColor Green
$outTask.Result -split "`n" | Where-Object { $_ -match '"type":"(result|state)"' } | ForEach-Object {
    $o = $_ | ConvertFrom-Json
    if ($o.type -eq 'state') { "state: inMeeting=$($o.inMeeting) muted=$($o.states.mute) camera=$($o.states.camera)" }
    else { "result id=$($o.id) ok=$($o.ok) $($o.error)" }
}
