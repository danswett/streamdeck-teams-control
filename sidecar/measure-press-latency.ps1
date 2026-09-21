<#
    Measures what a key press actually costs the user.

    Two numbers matter and they are not the same. "result" is what the Stream
    Deck key waits on before it stops looking busy - the plugin holds a press
    in flight until it arrives and shows Stream Deck's failure alert if you
    press again meanwhile - so it is the number the user feels. "state" is when
    the corrected key art arrives, which can legitimately be later.

    Flyout-backed targets (the react-* family) are the interesting case: the
    click lands early and the menu dismissal that follows is cleanup nobody is
    waiting on. Compare one of those against a direct control like mute, which
    opens no menu, to see the difference the deferral makes.

    Nothing here presses anything destructive, but it does drive a real
    meeting: reactions will appear to everyone in it. Use a meeting of one.
#>
param(
    [string]$Exe = "$PSScriptRoot\bin\Debug\net10.0-windows\win-x64\TeamsBridge.exe",
    [string]$Selectors = "",
    [string[]]$Targets = @("react-like", "mute"),
    [int]$Rounds = 5,
    [int]$GapMs = 3500
)

if (-not (Test-Path $Exe)) { throw "sidecar not found: $Exe" }

$argList = if ($Selectors) { "--selectors `"$Selectors`"" } else { "" }

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Exe
$psi.Arguments = $argList
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

function Send-Line([string]$json) {
    $proc.StandardInput.WriteLine($json)
    $proc.StandardInput.Flush()
}

<#
    Reads until the given predicate matches or the budget runs out, returning
    the elapsed milliseconds. ReadLine blocks, which is what makes the timing
    honest: the clock stops when the line is actually available to a reader.
#>
function Wait-For([scriptblock]$match, [System.Diagnostics.Stopwatch]$sw, [int]$budgetMs) {
    while ($sw.ElapsedMilliseconds -lt $budgetMs) {
        $line = $proc.StandardOutput.ReadLine()
        if ($null -eq $line) { return -1 }
        if (& $match $line) { return $sw.ElapsedMilliseconds }
    }
    return -1
}

# Let the first tree walk finish; a cold snapshot is a different measurement.
Start-Sleep -Milliseconds 2500
Send-Line '{"id":1,"cmd":"status"}'

$inMeeting = $false
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline) {
    $line = $proc.StandardOutput.ReadLine()
    if ($null -eq $line) { break }
    if ($line -notmatch '"type"\s*:\s*"state"') { continue }
    $inMeeting = ($line | ConvertFrom-Json).inMeeting
    break
}

if (-not $inMeeting) {
    $proc.Kill()
    throw "not in a meeting - nothing to measure. Start one, then re-run."
}

Write-Host "in a meeting; measuring $($Targets -join ', ') over $Rounds rounds" -ForegroundColor Green
Write-Host ""

$id = 100
$rows = @()

foreach ($target in $Targets) {
    $resultMs = @()
    $stateMs = @()
    $failures = 0

    for ($i = 1; $i -le $Rounds; $i++) {
        $id++
        $mine = $id
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        Send-Line "{`"id`":$mine,`"cmd`":`"invoke`",`"target`":`"$target`"}"

        $script:lastResultLine = $null
        $r = Wait-For {
            param($l)
            if ($l -match '"type"\s*:\s*"result"' -and $l -match "`"id`"\s*:\s*$mine\b") {
                $script:lastResultLine = $l
                return $true
            }
            return $false
        } $sw 15000

        # A press that failed says nothing useful about latency, and an unknown
        # target fails instantly - which would otherwise read as a very fast
        # press rather than as a broken measurement.
        $ok = $true
        $err = ""
        if ($script:lastResultLine) {
            $parsed = $script:lastResultLine | ConvertFrom-Json
            $ok = [bool]$parsed.ok
            if ($parsed.error) { $err = $parsed.error }
        }

        $s = Wait-For { param($l) $l -match '"type"\s*:\s*"state"' } $sw 15000

        if (-not $ok) {
            Write-Host ("  {0,-12} round {1}  FAILED: {2}" -f $target, $i, $err) -ForegroundColor Red
            $failures++
            Start-Sleep -Milliseconds $GapMs
            continue
        }

        if ($r -ge 0) { $resultMs += $r }
        if ($s -ge 0) { $stateMs += $s }
        Write-Host ("  {0,-12} round {1}  result {2,6} ms   state {3,6} ms" -f $target, $i, $r, $s)

        Start-Sleep -Milliseconds $GapMs
    }

    function Stat([int[]]$v, [double]$q) {
        if ($v.Count -eq 0) { return 0 }
        $sorted = $v | Sort-Object
        $at = [Math]::Min([Math]::Max([int][Math]::Ceiling($sorted.Count * $q) - 1, 0), $sorted.Count - 1)
        return $sorted[$at]
    }

    $rows += [PSCustomObject]@{
        Target         = $target
        'result p50'   = Stat $resultMs 0.5
        'result p95'   = Stat $resultMs 0.95
        'result max'   = ($resultMs | Measure-Object -Maximum).Maximum
        'state p50'    = Stat $stateMs 0.5
        'failed'       = $failures
    }
}

Send-Line '{"id":999,"cmd":"ping"}'
Start-Sleep -Milliseconds 400
$proc.Kill()

Write-Host ""
$rows | Format-Table -AutoSize
Write-Host "result = what the key waits on. state = when corrected art arrives." -ForegroundColor DarkGray
