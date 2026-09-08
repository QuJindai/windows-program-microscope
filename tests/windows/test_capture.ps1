#Requires -Version 7.0
[CmdletBinding()]
param(
    [string] $CollectorPath = '',
    [string] $ProbePath = '',
    [string] $OutputDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $CollectorPath) {
    $CollectorPath = Join-Path $repo 'collector/windows/bin/Release/net8.0-windows/ProgramMicroscope.Collector.exe'
}
if (-not $ProbePath) {
    $ProbePath = Join-Path $repo 'collector/probe/bin/Release/net8.0-windows/ProgramMicroscope.Probe.exe'
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts/windows-etw' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$script:children = [Collections.Generic.List[object]]::new()
$script:checks = [Collections.Generic.List[object]]::new()
$script:report = [ordered]@{
    schema_version = 1
    started_at = [DateTimeOffset]::UtcNow.ToString('o')
    platform = [Runtime.InteropServices.RuntimeInformation]::OSDescription
    build_status = 'not_run_by_this_script'
    runtime_status = 'running'
    checks = $script:checks
    error = $null
}
$probeProcess = $null
$probeMetadata = $null

function Assert-That([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Add-Check([string] $Name) {
    $script:checks.Add([ordered]@{ name = $Name; status = 'passed' })
    Write-Host "PASS $Name"
}

function Start-Program([string] $Path, [string[]] $Arguments, [string] $LogName) {
    Assert-That (Test-Path -LiteralPath $Path -PathType Leaf) "Executable or DLL does not exist: $Path. Build the projects before running ETW acceptance."
    $fullPath = [IO.Path]::GetFullPath($Path)
    $info = [Diagnostics.ProcessStartInfo]::new()
    if ([IO.Path]::GetExtension($fullPath) -eq '.dll') {
        $info.FileName = (Get-Command dotnet -ErrorAction Stop).Source
        $info.ArgumentList.Add($fullPath)
    } else {
        $info.FileName = $fullPath
    }
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    Assert-That ($process.Start()) "Could not start $fullPath"
    $child = [pscustomobject]@{
        Process = $process
        ErrorTask = $process.StandardError.ReadToEndAsync()
        Lines = [Collections.Generic.List[string]]::new()
        LogName = $LogName
        Drained = $false
    }
    $script:children.Add($child)
    return $child
}

function Save-ChildLogs($Child, [string] $Tail = '') {
    $output = ($Child.Lines -join [Environment]::NewLine) + [Environment]::NewLine + $Tail
    [IO.File]::WriteAllText((Join-Path $OutputDirectory "$($Child.LogName).stdout.log"), $output)
    if ($Child.ErrorTask.IsCompleted) {
        [IO.File]::WriteAllText((Join-Path $OutputDirectory "$($Child.LogName).stderr.log"), $Child.ErrorTask.GetAwaiter().GetResult())
    }
}

function Read-ChildLine($Child, [int] $TimeoutSeconds = 20) {
    $task = $Child.Process.StandardOutput.ReadLineAsync()
    Assert-That ($task.Wait([TimeSpan]::FromSeconds($TimeoutSeconds))) "$($Child.LogName) did not print the expected protocol line within ${TimeoutSeconds}s."
    $line = $task.GetAwaiter().GetResult()
    if ($null -eq $line) {
        $Child.Process.WaitForExit(2000) | Out-Null
        Save-ChildLogs $Child
        $detail = if ($Child.ErrorTask.IsCompleted) { $Child.ErrorTask.GetAwaiter().GetResult() } else { 'stderr still open' }
        throw "$($Child.LogName) exited before the expected protocol line. $detail"
    }
    $Child.Lines.Add($line)
    return $line
}

function Wait-Ready($Child) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt 25) {
        $remaining = [Math]::Max(1, [Math]::Ceiling(25 - $clock.Elapsed.TotalSeconds))
        if ((Read-ChildLine $Child $remaining).Trim() -eq 'READY') { return }
    }
    throw 'Collector did not announce READY after starting the ETW session.'
}

function Complete-Child($Child, [int] $TimeoutSeconds = 30) {
    $tailTask = $Child.Process.StandardOutput.ReadToEndAsync()
    Assert-That ($Child.Process.WaitForExit($TimeoutSeconds * 1000)) "$($Child.LogName) exceeded ${TimeoutSeconds}s exit timeout."
    Assert-That ($tailTask.Wait([TimeSpan]::FromSeconds(5))) "$($Child.LogName) stdout did not close."
    Assert-That ($Child.ErrorTask.Wait([TimeSpan]::FromSeconds(5))) "$($Child.LogName) stderr did not close."
    $tail = $tailTask.GetAwaiter().GetResult()
    $Child.Drained = $true
    Save-ChildLogs $Child $tail
    return [pscustomobject]@{
        ExitCode = $Child.Process.ExitCode
        Stdout = ($Child.Lines -join [Environment]::NewLine) + [Environment]::NewLine + $tail
        Stderr = $Child.ErrorTask.GetAwaiter().GetResult()
    }
}

function Invoke-Program([string] $Path, [string[]] $Arguments, [string] $LogName) {
    $child = Start-Program $Path $Arguments $LogName
    $child.Process.StandardInput.Close()
    return Complete-Child $child 20
}

function Read-Trace([string] $Path) {
    Assert-That (Test-Path -LiteralPath $Path -PathType Leaf) "Collector did not persist $Path"
    $text = [IO.File]::ReadAllText($Path)
    Assert-That (-not [string]::IsNullOrWhiteSpace($text)) "Trace file is empty: $Path"
    try { return ConvertFrom-Json -InputObject $text -AsHashtable -Depth 100 -NoEnumerate }
    catch { throw "Trace is not final valid JSON: $Path. $($_.Exception.Message)" }
}

function Assert-Array($Object, [string] $Key, [string] $Context) {
    Assert-That ($Object.Contains($Key)) "$Context is missing the $Key collection."
    Assert-That ($Object[$Key] -is [System.Collections.IList]) "$Context.$Key must always be a JSON array, including empty and single-item collections."
}

function Assert-RealEvidence($Item, $Evidence, [string] $Context) {
    Assert-Array $Item 'evidence_ids' $Context
    Assert-That ($Item.evidence_ids.Count -gt 0) "$Context has no evidence references."
    foreach ($reference in $Item.evidence_ids) {
        Assert-That ($Evidence.ContainsKey([string]$reference)) "$Context references nonexistent evidence '$reference'."
        Assert-That ($Evidence[[string]$reference].truth -eq 'REAL') "$Context must reference REAL observations."
        Assert-That (-not [string]::IsNullOrWhiteSpace($Evidence[[string]$reference].source)) "$Context evidence has no source."
    }
}

function Assert-TraceContract($Trace, [int] $ExpectedPid) {
    Assert-That ($Trace.schema_version -eq '0.1') 'Collector changed the compatible MTP schema version.'
    Assert-That ($Trace.run.status -eq 'completed') "Capture status is '$($Trace.run.status)' instead of completed."
    Assert-That ($Trace.run.target.pid -eq $ExpectedPid) 'Trace target PID differs from the selected probe.'
    Assert-That ($Trace.run.capture_mode -eq 'observe') 'ETW trace must use observe mode.'
    Assert-That ($Trace.run.duration_ms -gt 0) 'Capture duration must be positive.'
    foreach ($key in @('nodes', 'threads', 'events', 'values', 'edges', 'evidence', 'io', 'counters', 'capabilities', 'resources', 'diagnostics')) {
        Assert-Array $Trace $key 'trace'
    }
    if ($Trace.Contains('changes')) { Assert-Array $Trace 'changes' 'trace' }
    Assert-That ($Trace.events.Count -le 100000) 'Event cap of 100000 was exceeded.'
    Assert-That ($Trace.values.Count -eq 0) 'Observe capture must not fabricate program values.'
    Assert-That ($Trace.edges.Count -eq 0) 'Observe capture must not fabricate causal edges.'
    $evidence = @{}
    foreach ($entry in $Trace.evidence) {
        Assert-That (-not $evidence.ContainsKey([string]$entry.id)) "Duplicate evidence id '$($entry.id)'."
        $evidence[[string]$entry.id] = $entry
    }
    $eventIds = @{}
    foreach ($event in $Trace.events) {
        Assert-That (-not $eventIds.ContainsKey([string]$event.id)) "Duplicate event id '$($event.id)'."
        $eventIds[[string]$event.id] = $true
        Assert-That ($event.start_ms -ge 0 -and $event.start_ms -le $Trace.run.duration_ms) "Event '$($event.id)' timestamp falls outside the capture duration."
        if ($null -ne $event.duration_ms) {
            Assert-That ($event.duration_ms -ge 0 -and ($event.start_ms + $event.duration_ms) -le $Trace.run.duration_ms) "Event '$($event.id)' duration exceeds capture bounds."
        }
        Assert-RealEvidence $event $evidence "event $($event.id)"
    }
    foreach ($item in $Trace.io) {
        Assert-That ($eventIds.ContainsKey([string]$item.event_id)) "I/O '$($item.id)' references a missing event."
        Assert-RealEvidence $item $evidence "I/O $($item.id)"
    }
    foreach ($resource in $Trace.resources) {
        Assert-Array $resource 'event_ids' "resource $($resource.id)"
        foreach ($eventId in $resource.event_ids) {
            Assert-That ($eventIds.ContainsKey([string]$eventId)) "Resource '$($resource.id)' references a missing event."
        }
    }
    foreach ($counter in $Trace.counters) {
        Assert-Array $counter 'samples' "counter $($counter.id)"
        Assert-RealEvidence $counter $evidence "counter $($counter.id)"
        $previous = -1.0
        foreach ($sample in $counter.samples) {
            Assert-That ($sample.value -is [ValueType] -and [double]::IsFinite([double]$sample.value)) "Counter '$($counter.id)' contains a nonnumeric or nonfinite sample."
            Assert-That ($sample.timestamp_ms -ge 0 -and $sample.timestamp_ms -ge $previous -and $sample.timestamp_ms -le $Trace.run.duration_ms) "Counter '$($counter.id)' timestamps are unsorted or out of capture bounds."
            $previous = $sample.timestamp_ms
        }
    }
}

try {
    Assert-That $IsWindows 'Real ETW acceptance requires Windows; this script does not treat a non-Windows skip as success.'
    Write-Host 'Runtime ETW acceptance (compilation is a separate CI/build step).'
    $probeProcess = Start-Program $ProbePath @('--directory', (Join-Path $OutputDirectory 'probe-data')) 'probe'
    $probeMetadata = ConvertFrom-Json -InputObject (Read-ChildLine $probeProcess) -AsHashtable
    Assert-That ($probeMetadata.status -eq 'waiting') 'Probe must wait for an explicit trigger before generating target activity.'
    $targetPid = [int]$probeMetadata.pid
    Assert-That ($targetPid -eq $probeProcess.Process.Id) 'Probe protocol PID differs from the launched process.'

    $listed = Invoke-Program $CollectorPath @('--list-processes') 'list-processes'
    Assert-That ($listed.ExitCode -eq 0) "Process listing failed: $($listed.Stderr)"
    $processes = ConvertFrom-Json -InputObject $listed.Stdout -AsHashtable -NoEnumerate
    Assert-That ($processes -is [Collections.IList]) '--list-processes must return a JSON array.'
    Assert-That (@($processes | Where-Object { $_.pid -le 0 }).Count -eq 0) 'Process listing must omit nonselectable PID 0.'
    Assert-That (@($processes | Where-Object { $_.pid -eq $targetPid }).Count -eq 1) 'Process listing must include the live probe PID exactly once.'
    Add-Check 'Process listing contains live probe'

    $capabilityResult = Invoke-Program $CollectorPath @('--capabilities') 'capabilities'
    Assert-That ($capabilityResult.ExitCode -eq 0) "Capability query failed: $($capabilityResult.Stderr)"
    $capability = ConvertFrom-Json -InputObject $capabilityResult.Stdout -AsHashtable
    Assert-That ($capability.Contains('platform') -and $capability.Contains('reason')) 'Capability response lacks platform/reason.'
    Assert-That ($capability.collector_available -is [bool]) 'collector_available must be a JSON boolean.'
    Assert-Array $capability 'capabilities' 'capability response'
    Assert-That ($capability.capabilities.Count -gt 0) 'Capability response must describe provider availability.'
    foreach ($entry in $capability.capabilities) {
        foreach ($key in @('id', 'available', 'status', 'source', 'reason')) {
            Assert-That ($entry.Contains($key)) "Capability entry lacks '$key'."
        }
        Assert-That ($entry.available -is [bool]) "Capability '$($entry.id)' availability must be boolean."
    }
    Assert-That $capability.collector_available "Windows ETW is unavailable: $($capability.reason). Run on an elevated Windows host."
    Add-Check 'Capabilities report explicit provider availability'

    $invalidCases = @(
        @{ Name = 'missing-pid'; Args = @('--duration', '1') },
        @{ Name = 'bad-pid'; Args = @('--pid', 'not-a-pid') },
        @{ Name = 'zero-pid'; Args = @('--pid', '0') },
        @{ Name = 'missing-value'; Args = @('--pid') },
        @{ Name = 'zero-duration'; Args = @('--pid', "$targetPid", '--duration', '0') },
        @{ Name = 'long-duration'; Args = @('--pid', "$targetPid", '--duration', '3601') },
        @{ Name = 'bad-duration'; Args = @('--pid', "$targetPid", '--duration', 'abc') },
        @{ Name = 'unknown-option'; Args = @('--unknown-option') }
    )
    foreach ($case in $invalidCases) {
        $result = Invoke-Program $CollectorPath $case.Args "invalid-$($case.Name)"
        Assert-That ($result.ExitCode -eq 2) "Invalid arguments '$($case.Name)' must exit 2; got $($result.ExitCode). $($result.Stderr)"
        Assert-That (-not [string]::IsNullOrWhiteSpace($result.Stderr)) "Invalid arguments '$($case.Name)' require an actionable error."
    }
    Add-Check 'Malformed arguments fail with diagnostics'

    $tracePath = Join-Path $OutputDirectory 'capture.mtp.json'
    if (Test-Path -LiteralPath $tracePath) { Remove-Item -LiteralPath $tracePath -Force }
    $collector = Start-Program $CollectorPath @('--pid', "$targetPid", '--duration', '8', '--out', $tracePath) 'capture'
    Wait-Ready $collector
    $probeProcess.Process.StandardInput.WriteLine('go')
    $probeProcess.Process.StandardInput.Flush()
    $completed = ConvertFrom-Json -InputObject (Read-ChildLine $probeProcess 25) -AsHashtable
    Assert-That ($completed.status -eq 'completed') 'Probe did not complete its real operations.'
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'probe-observations.json'), ($completed | ConvertTo-Json -Depth 20))
    $captureResult = Complete-Child $collector 30
    Assert-That ($captureResult.ExitCode -eq 0) "ETW capture failed with exit $($captureResult.ExitCode): $($captureResult.Stderr)"
    $trace = Read-Trace $tracePath
    Assert-TraceContract $trace $targetPid
    Assert-That ($trace.run.duration_ms -ge 7000 -and $trace.run.duration_ms -le 20000) 'Eight-second capture duration falls outside expected timer/flush bounds.'
    Add-Check 'Completed capture is valid bounded MTP with array collections and REAL evidence'

    foreach ($kind in @('process', 'thread', 'module', 'file', 'registry', 'network')) {
        Assert-That (@($trace.events | Where-Object { $_.kind -eq $kind }).Count -gt 0) "No real '$kind' category was captured."
    }
    $workerEvents = @($trace.events | Where-Object { $_.kind -eq 'thread' -and $_.thread_id -eq $completed.thread_id })
    Assert-That ($workerEvents.Count -gt 0) "ETW did not capture short-lived native thread $($completed.thread_id)."
    Add-Check 'Process/thread/module/file/registry/network categories and short-lived worker observed'

    $fileEvents = @($trace.events | Where-Object {
        $_.kind -eq 'file' -and $_.details.Contains('file_path') -and
        [string]$_.details.file_path -like "*$($completed.token)*"
    })
    Assert-That ($fileEvents.Count -gt 0) "File events do not identify unique probe file $($completed.file_path)."
    Assert-That (@($fileEvents | Where-Object { ($_.phase + ' ' + $_.label) -match '(?i)read' }).Count -gt 0) 'Unique probe file has no observed read event.'
    Assert-That (@($fileEvents | Where-Object { ($_.phase + ' ' + $_.label) -match '(?i)write' }).Count -gt 0) 'Unique probe file has no observed write event.'
    $fileIo = @($trace.io | Where-Object {
        $_.Contains('path') -and [string]$_.path -like "*$($completed.token)*" -and
        $_.Contains('bytes') -and $null -ne $_.bytes -and $_.bytes -gt 0
    })
    Assert-That ($fileIo.Count -gt 0) 'Probe file I/O lacks observed positive byte counts.'
    Assert-That ((Get-Item -LiteralPath $completed.file_path).Length -eq $completed.file_bytes) 'Physical probe file length differs from verified probe output.'
    Add-Check 'Unique file read/write names and positive byte counts match probe'

    $registryEvents = @($trace.events | Where-Object {
        $_.kind -eq 'registry' -and $_.details.Contains('registry_key') -and
        [string]$_.details.registry_key -like "*$($completed.token)*"
    })
    Assert-That ($registryEvents.Count -gt 0) "No registry event references unique key $($completed.registry_key)."
    Assert-That (@($registryEvents | Where-Object {
        $_.details.Contains('value_name') -and $_.details.value_name -eq $completed.registry_value_name
    }).Count -gt 0) 'Registry events do not identify the actual probe value name.'
    Add-Check 'Unique HKCU registry key and value name observed'

    $networkEvents = @($trace.events | Where-Object {
        if ($_.kind -ne 'network') { return $false }
        $details = $_.details
        foreach ($key in @('source_address', 'source_port', 'destination_address', 'destination_port')) {
            if (-not $details.Contains($key)) { return $false }
        }
        $forward = $details.source_address -eq $completed.tcp_client_address -and
            $details.source_port -eq $completed.tcp_client_port -and
            $details.destination_address -eq $completed.tcp_server_address -and
            $details.destination_port -eq $completed.tcp_server_port
        $reverse = $details.destination_address -eq $completed.tcp_client_address -and
            $details.destination_port -eq $completed.tcp_client_port -and
            $details.source_address -eq $completed.tcp_server_address -and
            $details.source_port -eq $completed.tcp_server_port
        return $forward -or $reverse
    })
    Assert-That ($networkEvents.Count -gt 0) 'No TCP event matches both actual localhost endpoints reported by the probe.'
    $networkIds = @($networkEvents | ForEach-Object { $_.id })
    $networkIo = @($trace.io | Where-Object {
        $_.event_id -in $networkIds -and $_.Contains('bytes') -and $null -ne $_.bytes -and $_.bytes -gt 0
    })
    Assert-That ($networkIo.Count -gt 0) 'Matching TCP I/O lacks actual positive transfer byte counts.'
    Add-Check 'Real localhost TCP endpoints and positive transfer bytes match probe'

    foreach ($counterId in @('process_cpu_ms', 'working_set_bytes', 'private_bytes')) {
        $counters = @($trace.counters | Where-Object { $_.id -eq $counterId })
        Assert-That ($counters.Count -eq 1) "Expected exactly one $counterId counter series."
        Assert-That ($counters[0].samples.Count -ge 2) "$counterId must contain multiple actual samples."
        Assert-That (@($counters[0].samples | Where-Object { $_.value -gt 0 }).Count -gt 0) "$counterId contains no positive measured value."
    }
    Add-Check 'Actual CPU and nonzero process memory counter series present'

    $stopPath = Join-Path $OutputDirectory 'stopped.mtp.json'
    if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath -Force }
    $stopClock = [Diagnostics.Stopwatch]::StartNew()
    $stoppable = Start-Program $CollectorPath @('--pid', "$targetPid", '--duration', '60', '--out', $stopPath) 'capture-stopped'
    Wait-Ready $stoppable
    Start-Sleep -Milliseconds 1200
    $stoppable.Process.StandardInput.WriteLine('stop')
    $stoppable.Process.StandardInput.Flush()
    $stoppedResult = Complete-Child $stoppable 20
    Assert-That ($stoppedResult.ExitCode -eq 0) "Graceful stop failed: $($stoppedResult.Stderr)"
    Assert-That ($stopClock.Elapsed.TotalSeconds -lt 30) 'Stop command did not stop well before the 60-second deadline.'
    $stopped = Read-Trace $stopPath
    Assert-TraceContract $stopped $targetPid
    Assert-That ($stopped.run.stop_reason -eq 'requested') 'Graceful stop must persist run.stop_reason=requested.'
    Assert-That ($stopped.run.duration_ms -lt 30000) 'Stopped capture persisted an implausible full-duration timestamp.'
    Add-Check 'Early stop preserves a final completed JSON trace'

    $probeProcess.Process.StandardInput.WriteLine('exit')
    $probeProcess.Process.StandardInput.Flush()
    $probeResult = Complete-Child $probeProcess 10
    Assert-That ($probeResult.ExitCode -eq 0) "Probe shutdown failed: $($probeResult.Stderr)"
    $script:report.runtime_status = 'passed'
} catch {
    $script:report.runtime_status = 'failed'
    $script:report.error = $_.Exception.Message
    [Console]::Error.WriteLine("WINDOWS ETW ACCEPTANCE FAILED: $($_.Exception.Message)")
} finally {
    foreach ($child in $script:children) {
        try {
            if (-not $child.Process.HasExited) {
                # Give an ETW collector a chance to dispose its session before a
                # fallback kill. The probe rejects this and then cleans its key.
                $child.Process.StandardInput.WriteLine('stop')
                $child.Process.StandardInput.Flush()
                if (-not $child.Process.WaitForExit(5000)) {
                    $child.Process.Kill($true)
                    $child.Process.WaitForExit(5000) | Out-Null
                }
            }
            if (-not $child.Drained) { Save-ChildLogs $child }
            $child.Process.Dispose()
        } catch { [Console]::Error.WriteLine("Process cleanup: $($_.Exception.Message)") }
    }
    if ($null -ne $probeMetadata -and $probeMetadata.Contains('token') -and $IsWindows) {
        $registryPath = "HKCU:\Software\ProgramMicroscopeProbe\$($probeMetadata.token)"
        if (Test-Path -LiteralPath $registryPath) {
            Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction Continue
        }
    }
    $script:report.finished_at = [DateTimeOffset]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'acceptance-report.json'), ($script:report | ConvertTo-Json -Depth 30))
}

if ($script:report.runtime_status -ne 'passed') { exit 1 }
Write-Host "Windows ETW acceptance passed ($($script:checks.Count) checks). Artifacts: $OutputDirectory"
exit 0
