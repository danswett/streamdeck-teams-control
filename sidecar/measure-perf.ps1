<#
    Samples CPU and memory for the plugin's two processes.

    Working set is what Task Manager shows, but it is reclaimable under
    pressure; private bytes is the more honest figure for what a process
    actually costs, so both are reported.

    Run with -Label to tag a run for before/after comparison.
#>
param(
    [int]$Seconds = 30,
    [string]$Label = "run",
    [string]$OutFile = "$env:TEMP\sdtc-perf.csv"
)

function Get-Targets {
    $list = @()
    foreach ($p in Get-Process -Name TeamsBridge -ErrorAction SilentlyContinue) {
        $list += [PSCustomObject]@{ Role = 'sidecar'; Proc = $p }
    }
    foreach ($ci in Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue) {
        if ($ci.CommandLine -notmatch 'teamscontrol') { continue }
        $p = Get-Process -Id $ci.ProcessId -ErrorAction SilentlyContinue
        if ($p) { $list += [PSCustomObject]@{ Role = 'plugin(node)'; Proc = $p } }
    }
    return $list
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function Test-MeetingLive {
    try {
        foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ((Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -ne 'ms-teams') { continue }
            $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
            if ($w.FindFirst($TS::Descendants, $c)) { return $true }
        }
    }
    catch {}
    return $false
}

$inMeeting = Test-MeetingLive
$targets = Get-Targets
if (-not $targets) { Write-Host "no plugin processes running" -ForegroundColor Red; return }

$start = @{}
foreach ($t in $targets) { $start[$t.Proc.Id] = $t.Proc.TotalProcessorTime }

$peakWs = @{}
$sumWs = @{}
$sumPriv = @{}
$samples = 0

$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $samples++
    foreach ($t in $targets) {
        try {
            $t.Proc.Refresh()
            $id = $t.Proc.Id
            $ws = $t.Proc.WorkingSet64
            $pv = $t.Proc.PrivateMemorySize64
            if (-not $peakWs.ContainsKey($id) -or $ws -gt $peakWs[$id]) { $peakWs[$id] = $ws }
            $sumWs[$id] = ($sumWs[$id] | ForEach-Object { $_ }) + $ws
            $sumPriv[$id] = ($sumPriv[$id] | ForEach-Object { $_ }) + $pv
        }
        catch {}
    }
}

Write-Host ""
Write-Host ("=== {0} === ({1}, {2}s, {3} samples)" -f $Label, $(if ($inMeeting) { 'IN MEETING' } else { 'idle' }), $Seconds, $samples) -ForegroundColor Cyan
"{0,-14} {1,8} {2,12} {3,12} {4,12}" -f 'process', 'cpu%', 'ws avg MB', 'ws peak MB', 'priv avg MB' | Write-Host

$rows = @()
foreach ($t in $targets) {
    $id = $t.Proc.Id
    try { $t.Proc.Refresh() } catch {}
    $cpu = 0.0
    try { $cpu = (($t.Proc.TotalProcessorTime - $start[$id]).TotalSeconds / $Seconds) * 100 } catch {}
    $wsAvg = if ($samples) { $sumWs[$id] / $samples / 1MB } else { 0 }
    $wsPk = $peakWs[$id] / 1MB
    $pvAvg = if ($samples) { $sumPriv[$id] / $samples / 1MB } else { 0 }
    "{0,-14} {1,8:N1} {2,12:N1} {3,12:N1} {4,12:N1}" -f $t.Role, $cpu, $wsAvg, $wsPk, $pvAvg | Write-Host
    $rows += [PSCustomObject]@{
        Label = $Label; State = $(if ($inMeeting) { 'meeting' } else { 'idle' }); Role = $t.Role
        CpuPct = [math]::Round($cpu, 2); WsAvgMB = [math]::Round($wsAvg, 1)
        WsPeakMB = [math]::Round($wsPk, 1); PrivAvgMB = [math]::Round($pvAvg, 1)
    }
}

$rows | Export-Csv -Path $OutFile -NoTypeInformation -Append
Write-Host "`nappended to $OutFile"
