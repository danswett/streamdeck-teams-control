<#
    What the timer looks like while it is running.

    Paused, it offers "Resume timer" and a "Paused" label. A dial needs to know
    what those become once it is running, because that is how it will tell
    running from paused and label its own press.

    Starts the timer, samples it, and pauses it again. It does not reset it, so
    the remaining time is left where it was found give or take the seconds it
    was running.
#>
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TRUE_COND = [System.Windows.Automation.Condition]::TrueCondition

function Get-Meeting {
    foreach ($w in ($AE::RootElement.FindAll($TS::Children, $TRUE_COND) |
            Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'ms-teams' })) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'microphone-button')
        if ($w.FindFirst($TS::Descendants, $c)) { return $w }
    }
    return $null
}

function Snapshot($label) {
    $m = Get-Meeting
    if (-not $m) { "  $label : no window" | Write-Host; return }
    $all = $m.FindAll($TS::Descendants, $TRUE_COND)

    $bits = @()
    foreach ($el in $all) {
        $n = ''
        try { $n = $el.Current.Name } catch { continue }
        if ([string]::IsNullOrWhiteSpace($n)) { continue }
        if ($n -match 'timer|Timer' -or $n -match '^\s*(Paused|Running)\s*$') {
            $bits += "'{0}' [{1}]" -f $n, $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
        }
    }
    "  {0,-16} {1}" -f $label, ($bits -join '  |  ') | Write-Host
}

function Find-ByName($pattern) {
    $m = Get-Meeting
    if (-not $m) { return $null }
    foreach ($el in $m.FindAll($TS::Descendants, $TRUE_COND)) {
        $n = ''
        try { $n = $el.Current.Name } catch { continue }
        if ($n -match $pattern) { return $el }
    }
    return $null
}

Snapshot "as found"

$resume = Find-ByName '^(Resume|Start|Play) timer$'
if (-not $resume) { Write-Host "`nno resume button - timer may already be running" -ForegroundColor Yellow }
else {
    "`ninvoking '{0}' ..." -f $resume.Current.Name | Write-Host
    $resume.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 2500
    Snapshot "running"
    Start-Sleep -Seconds 3
    Snapshot "running +3s"
}

$pause = Find-ByName '^(Pause|Stop) timer$'
if ($pause) {
    "`ninvoking '{0}' to put it back ..." -f $pause.Current.Name | Write-Host
    $pause.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 2000
}
Snapshot "restored"
