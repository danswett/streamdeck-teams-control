<#
    Isolates whether foreground can be restored from a background process.

    Windows refuses SetForegroundWindow for a process that does not own the
    foreground window. Attaching the calling thread to the input queues of both
    the current and target windows is the usual way around that; this checks
    whether it actually works against a Teams window.
#>
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class F {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }
    public static bool RestoreWithAttach(IntPtr target) {
        IntPtr current = GetForegroundWindow();
        if (current == target) return true;
        uint self = GetCurrentThreadId();
        uint tmp;
        uint fromT = 0; if (current != IntPtr.Zero) fromT = GetWindowThreadProcessId(current, out tmp);
        uint toT = GetWindowThreadProcessId(target, out tmp);
        bool a1 = fromT != 0 && fromT != self && AttachThreadInput(self, fromT, true);
        bool a2 = toT   != 0 && toT   != self && AttachThreadInput(self, toT,   true);
        try {
            BringWindowToTop(target);
            return SetForegroundWindow(target);
        } finally {
            if (a2) AttachThreadInput(self, toT, false);
            if (a1) AttachThreadInput(self, fromT, false);
        }
    }
}
'@

# Reference window to steal focus back to.
$shell = New-Object -ComObject Shell.Application
$shell.Explore("$env:USERPROFILE")
Start-Sleep -Seconds 3
$ref = [F]::GetForegroundWindow()
Write-Host "reference: '$([F]::Title($ref))' [$([F]::Proc($ref))]" -ForegroundColor Cyan

# Find a Teams window and pull it forward the way an invoke would.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$teams = [IntPtr]::Zero
foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'ms-teams') { continue }
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
    if ($w.FindFirst($TS::Descendants, $c)) { $teams = [IntPtr]$w.Current.NativeWindowHandle; break }
}
if ($teams -eq [IntPtr]::Zero) { Write-Host "no meeting window; using any teams window" -ForegroundColor Yellow }

Write-Host "`n--- forcing Teams forward (simulating the invoke side effect) ---"
[void][F]::SwitchToThisWindow($teams, $true)
Start-Sleep -Milliseconds 900
$fg = [F]::GetForegroundWindow()
Write-Host "foreground now: '$([F]::Title($fg))' [$([F]::Proc($fg))]"

Write-Host "`n--- method 1: plain SetForegroundWindow ---"
[void][F]::SetForegroundWindow($ref)
Start-Sleep -Milliseconds 700
$fg = [F]::GetForegroundWindow()
Write-Host ("  result: [{0}] {1}" -f [F]::Proc($fg), $(if ($fg -eq $ref) { "RESTORED" } else { "blocked" })) `
    -ForegroundColor $(if ($fg -eq $ref) { 'Green' } else { 'Red' })

if ($fg -ne $ref) {
    Write-Host "`n--- method 2: AttachThreadInput + SetForegroundWindow ---"
    $ok = [F]::RestoreWithAttach($ref)
    Start-Sleep -Milliseconds 700
    $fg = [F]::GetForegroundWindow()
    Write-Host ("  returned {0}; foreground [{1}] {2}" -f $ok, [F]::Proc($fg), $(if ($fg -eq $ref) { "RESTORED" } else { "blocked" })) `
        -ForegroundColor $(if ($fg -eq $ref) { 'Green' } else { 'Red' })
}

if ([F]::GetForegroundWindow() -ne $ref) {
    Write-Host "`n--- method 3: SwitchToThisWindow ---"
    [void][F]::SwitchToThisWindow($ref, $true)
    Start-Sleep -Milliseconds 700
    $fg = [F]::GetForegroundWindow()
    Write-Host ("  foreground [{0}] {1}" -f [F]::Proc($fg), $(if ($fg -eq $ref) { "RESTORED" } else { "blocked" })) `
        -ForegroundColor $(if ($fg -eq $ref) { 'Green' } else { 'Red' })
}
