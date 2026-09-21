<#
    Watches how Teams' windows look to UI Automation over time.

    Written for a specific gap: the sidecar reported "no meeting" while a
    meeting was demonstrably still running, and separately spent 1.3-1.5 s
    rediscovering the window on alternating polls. Both point at discovery
    rather than at the meeting, so this records what discovery would see -
    every Teams top-level window, whether the probe control is findable in it,
    and how long finding it takes.

    Read-only. It presses nothing and opens nothing.
#>
param(
    [int]$Rounds = 12,
    [int]$GapMs = 2000,
    [string]$Probe = "microphone-button"
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$ANY = [System.Windows.Automation.Condition]::TrueCondition

function Get-TeamsWindows {
    $AE::RootElement.FindAll($TS::Children, $ANY) | Where-Object {
        (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams'
    }
}

for ($r = 1; $r -le $Rounds; $r++) {
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $windows = @(Get-TeamsWindows)
    Write-Host "[$stamp] round $r - $($windows.Count) ms-teams top-level window(s)"

    foreach ($w in $windows) {
        $title = $w.Current.Name
        $hwnd = $w.Current.NativeWindowHandle

        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $Probe)
        $hit = $null
        try { $hit = $w.FindFirst($TS::Descendants, $cond) } catch { }
        $sw.Stop()

        $verdict = if ($hit) { "PROBE FOUND" } else { "probe absent" }
        Write-Host ("    hwnd={0,-10} {1,-12} {2,5} ms  '{3}'" -f $hwnd, $verdict, $sw.ElapsedMilliseconds, $title)
    }

    if ($windows.Count -eq 0) { Write-Host "    (UI Automation sees no Teams windows at all)" -ForegroundColor Red }
    Start-Sleep -Milliseconds $GapMs
}
