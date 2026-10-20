<#
    Live check of Change Camera and Swap Camera in a running meeting.

    Lists webcams through the sidecar, then changes to another webcam, presses
    it again (a no-op), swaps both ways, and changes back to the webcam Teams
    started on. After every press it reads which webcam Teams has selected,
    and checks that the camera's on/off state did not change.

    Each press is sampled for the foreground window until its flyout cleanup
    has finished, as in test-focus-strict.ps1: yellow is a flash the focus
    guard put right, red is Teams still in front at the end. Reading the
    selection opens the video menu through UI Automation, which brings Teams
    forward, so the reference window is put back before each press.

    Needs a meeting and at least two webcams Teams can use.
#>
param(
    [string]$Exe = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\bin\sidecar\TeamsBridge.exe",
    [string]$Selectors = "C:\Users\dswett\repos\streamdeck-teams-control\com.bad-duck.teamscontrol.sdPlugin\selectors.json",
    # Ceiling on one press and its cleanup, in case the state never arrives.
    [int]$MaxMs = 12000
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class W {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    public static string Proc(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }
    // The same input-queue attachment FocusGuard uses, so this works when the
    // script is not itself the foreground process.
    public static void Front(IntPtr h) {
        uint pid; var self = GetCurrentThreadId();
        var from = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        var to = GetWindowThreadProcessId(h, out pid);
        var a = from != 0 && from != self && AttachThreadInput(self, from, true);
        var b = to != 0 && to != self && AttachThreadInput(self, to, true);
        try { BringWindowToTop(h); SetForegroundWindow(h); }
        finally { if (b) AttachThreadInput(self, to, false); if (a) AttachThreadInput(self, from, false); }
    }
}
'@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Find-ById($root, [string]$id) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
    return $root.FindFirst($TS::Descendants, $c)
}

function Get-TeamsWindows {
    foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams') { $w }
    }
}

# Which of $Ids Teams has selected, read from the video menu. The sidecar is
# not asked, because the point is to check what it did.
function Get-SelectedCamera([string[]]$Ids) {
    $menu = $null
    foreach ($w in Get-TeamsWindows) { $menu = Find-ById $w 'video-button-configure'; if ($menu) { break } }
    if (-not $menu) { return '(menu not found)' }
    $expand = $menu.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $expand.Expand()
    $selected = $null
    $deadline = (Get-Date).AddSeconds(4)
    while (-not $selected -and (Get-Date) -lt $deadline) {
        foreach ($w in Get-TeamsWindows) {
            foreach ($id in $Ids) {
                $el = Find-ById $w $id
                if (-not $el) { continue }
                $item = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                if ($item.Current.IsSelected) { $selected = $id; break }
            }
            if ($selected) { break }
        }
        if (-not $selected) { Start-Sleep -Milliseconds 200 }
    }
    try { $expand.Collapse() } catch { }
    Start-Sleep -Milliseconds 600
    if ($selected) { return $selected } else { return '(none of the listed webcams)' }
}

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = "--selectors `"$Selectors`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

$script:stdout = $proc.StandardOutput
$script:pending = $script:stdout.ReadLineAsync()
$script:cameraOn = $null
function Read-Ready {
    while ($null -ne $script:pending -and $script:pending.IsCompleted) {
        $line = $script:pending.Result
        if ($null -eq $line) { $script:pending = $null; return }
        if ($line -match '"type":"state"' -and $line -match '"camera":(true|false)') { $script:cameraOn = $Matches[1] }
        $line
        $script:pending = $script:stdout.ReadLineAsync()
    }
}

$script:id = 100
function Send([hashtable]$Command) {
    $null = @(Read-Ready)
    $Command.id = $script:id
    $proc.StandardInput.WriteLine(($Command | ConvertTo-Json -Compress))
    $proc.StandardInput.Flush()
    $script:id++
    return $Command.id
}

# Sends one invoke and samples the foreground until its cleanup is done.
function Invoke-Press([string]$Target, [string]$Arg, [string]$Label, [IntPtr]$Ref) {
    [W]::Front($Ref)
    Start-Sleep -Milliseconds 300
    $refProc = [W]::Proc([W]::GetForegroundWindow())
    $sent = Send @{ cmd = 'invoke'; target = $Target; arg = $Arg }

    $result = $null; $doneAt = $null
    $flash = $false; $teamsMs = 0; $last = 0
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $MaxMs) {
        foreach ($line in @(Read-Ready)) {
            if ($null -eq $result) {
                if ($line -match ('"type":"result","id":{0}[,}}]' -f $sent)) { $result = $line | ConvertFrom-Json }
            } elseif ($null -eq $doneAt -and $line -match '"type":"state"') {
                $doneAt = $sw.ElapsedMilliseconds
            }
        }
        if ($null -ne $doneAt -and $sw.ElapsedMilliseconds -gt $doneAt + 1600) { break }
        $now = $sw.ElapsedMilliseconds
        if ([W]::Proc([W]::GetForegroundWindow()) -eq 'ms-teams' -and $refProc -ne 'ms-teams') {
            $flash = $true
            $teamsMs += $now - $last
        }
        $last = $now
        Start-Sleep -Milliseconds 10
    }
    $stolen = $refProc -ne 'ms-teams' -and [W]::Proc([W]::GetForegroundWindow()) -eq 'ms-teams'
    return [pscustomobject]@{
        Label = $Label; Ok = $result.ok; Error = $result.error
        Flash = $flash; TeamsMs = $teamsMs; Stolen = $stolen
    }
}

Start-Sleep -Milliseconds 1500
$null = @(Read-Ready)

# The list the Change Camera and Swap Camera settings are filled from.
$sent = Send @{ cmd = 'cameras' }
$cameras = $null
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not $cameras -and $sw.ElapsedMilliseconds -lt 10000) {
    foreach ($line in @(Read-Ready)) {
        if ($line -match ('"type":"cameras","id":{0}[,}}]' -f $sent)) { $cameras = $line | ConvertFrom-Json }
    }
    Start-Sleep -Milliseconds 50
}
if (-not $cameras -or -not $cameras.ok) { throw "webcam list failed: $($cameras.error)" }
Write-Host ("webcams: " + (($cameras.cameras | ForEach-Object { $_.name }) -join ' | '))
$ids = @($cameras.cameras | ForEach-Object { $_.id })
if ($ids.Count -lt 2) { throw 'needs at least two webcams' }

$shell = New-Object -ComObject Shell.Application
$before = @($shell.Windows() | ForEach-Object { [int64]$_.HWND })
$shell.Explore("$env:USERPROFILE")
$ref = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $ref -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 100
    $h = @($shell.Windows() | ForEach-Object { [int64]$_.HWND } | Where-Object { $_ -notin $before }) | Select-Object -First 1
    if ($h) { $ref = [IntPtr]$h }
}
if ($ref -eq [IntPtr]::Zero) { throw 'could not open a reference window' }

$original = Get-SelectedCamera $ids
if ($original -notin $ids) { throw "could not read Teams' webcam: $original" }
$other = $ids | Where-Object { $_ -ne $original } | Select-Object -First 1
$name = @{}; foreach ($c in $cameras.cameras) { $name[$c.id] = $c.name }
$null = @(Read-Ready)
$cameraAtStart = $script:cameraOn
Write-Host "Teams starts on '$($name[$original])'; the other webcam is '$($name[$other])'; camera on: $cameraAtStart"

$pair = ConvertTo-Json @($original, $other) -Compress
$steps = @(
    @{ Target = 'camera-select'; Arg = $other; Label = 'change to the other webcam'; Expect = $other },
    @{ Target = 'camera-select'; Arg = $other; Label = 'press it again (no-op)'; Expect = $other },
    @{ Target = 'camera-swap'; Arg = $pair; Label = 'swap from the second'; Expect = $original },
    @{ Target = 'camera-swap'; Arg = $pair; Label = 'swap from the first'; Expect = $other },
    @{ Target = 'camera-select'; Arg = $original; Label = 'change back'; Expect = $original }
)

$failed = 0
foreach ($s in $steps) {
    $r = Invoke-Press $s.Target $s.Arg $s.Label $ref
    $now = Get-SelectedCamera $ids
    $right = $r.Ok -and $now -eq $s.Expect -and $script:cameraOn -eq $cameraAtStart
    if (-not $right -or $r.Stolen) { $failed++ }
    $msg = "  {0,-28} ok={1,-5} selected='{2}' expected='{3}' cameraOn={4} sawTeams={5} teamsMs={6} stolen={7}" -f `
        $r.Label, $r.Ok, $name[$now], $name[$s.Expect], $script:cameraOn, $r.Flash, $r.TeamsMs, $r.Stolen
    if ($r.Error) { $msg += "  error='$($r.Error)'" }
    Write-Host $msg -ForegroundColor $(if (-not $right -or $r.Stolen) { 'Red' } elseif ($r.Flash) { 'Yellow' } else { 'Green' })
}

# Settings a user can get wrong. Each has to fail with a reason, not switch.
$bad = @(
    @{ Target = 'camera-swap'; Arg = (ConvertTo-Json @($original, $original) -Compress); Label = 'swap with one webcam twice' },
    @{ Target = 'camera-select'; Arg = 'no-such-webcam'; Label = 'change to a missing webcam' }
)
foreach ($s in $bad) {
    $r = Invoke-Press $s.Target $s.Arg $s.Label $ref
    $now = Get-SelectedCamera $ids
    $right = -not $r.Ok -and $r.Error -and $now -eq $original
    if (-not $right -or $r.Stolen) { $failed++ }
    $msg = "  {0,-28} ok={1,-5} error='{2}' selected='{3}' sawTeams={4} teamsMs={5} stolen={6}" -f `
        $r.Label, $r.Ok, $r.Error, $name[$now], $r.Flash, $r.TeamsMs, $r.Stolen
    Write-Host $msg -ForegroundColor $(if (-not $right -or $r.Stolen) { 'Red' } elseif ($r.Flash) { 'Yellow' } else { 'Green' })
}

try { $proc.StandardInput.WriteLine('{"cmd":"shutdown"}'); $proc.StandardInput.Flush() } catch {}
if (-not $proc.WaitForExit(5000)) { $proc.Kill() }
Write-Host $(if ($failed) { "$failed check(s) failed" } else { 'all checks passed' }) -ForegroundColor $(if ($failed) { 'Red' } else { 'Green' })
