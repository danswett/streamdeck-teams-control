<#
    Verifies the DPI assumptions the posted clicks depend on.

    Controls are clicked at screen coordinates read from UI Automation. If the
    sidecar is not per-monitor DPI aware, Windows virtualises those coordinates
    and presses land somewhere else - and the symptom gives no hint of the
    cause, so it is worth asserting directly rather than inferring it from a
    click that happened to work on one monitor.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json"
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Dpi {
    [DllImport("user32.dll")] public static extern IntPtr GetDpiAwarenessContextForProcess(IntPtr hProcess);
    [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    public const uint QUERY_LIMITED_INFORMATION = 0x1000;

    public static string Describe(IntPtr ctx) {
        if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-4))) return "PER_MONITOR_AWARE_V2";
        if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-3))) return "PER_MONITOR_AWARE";
        if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-2))) return "SYSTEM_AWARE";
        if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-1))) return "UNAWARE";
        if (AreDpiAwarenessContextsEqual(ctx, new IntPtr(-5))) return "UNAWARE_GDISCALED";
        return "UNKNOWN(" + ctx.ToString() + ")";
    }
}
'@

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

try {
    Start-Sleep -Milliseconds 1500

    $h = [Dpi]::OpenProcess([Dpi]::QUERY_LIMITED_INFORMATION, $false, $proc.Id)
    if ($h -eq [IntPtr]::Zero) { throw "could not open sidecar process $($proc.Id)" }

    try {
        $ctx = [Dpi]::GetDpiAwarenessContextForProcess($h)
        $name = [Dpi]::Describe($ctx)
    }
    finally { [Dpi]::CloseHandle($h) | Out-Null }

    $desktopDpi = [Dpi]::GetDpiForWindow([Dpi]::GetDesktopWindow())
    $scale = [math]::Round($desktopDpi / 96.0 * 100)

    Write-Host "sidecar PID       : $($proc.Id)"
    Write-Host "DPI awareness     : $name"
    Write-Host "primary DPI       : $desktopDpi ($scale%)"

    # Anything below per-monitor leaves coordinates virtualised.
    $ok = $name -in @('PER_MONITOR_AWARE_V2', 'PER_MONITOR_AWARE')
    if ($ok) {
        Write-Host "PASS - coordinates are physical pixels, clicks map correctly on scaled displays" -ForegroundColor Green
    }
    else {
        Write-Host "FAIL - awareness is '$name'; posted clicks will be offset when scaling is not 100%" -ForegroundColor Red
    }

    if ($scale -eq 100) {
        Write-Host "note: this display is at 100%, where an unaware process would also appear to work." -ForegroundColor Yellow
        Write-Host "      the awareness check above is what actually proves it." -ForegroundColor Yellow
    }

    exit ($ok ? 0 : 1)
}
finally {
    try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
    if (-not $proc.WaitForExit(3000)) { $proc.Kill() }
}
