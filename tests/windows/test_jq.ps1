#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $CollectorPath,
    [Parameter(Mandatory)][string] $JqPath,
    [string] $OutputDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'test-results/windows/jq' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$expectedHash = 'a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627'
$sessionName = 'ProgramMicroscope-jq-' + [Guid]::NewGuid().ToString('N')
$children = [Collections.Generic.List[object]]::new()
$checks = [Collections.Generic.List[string]]::new()
$report = [ordered]@{
    started_at = [DateTimeOffset]::UtcNow.ToString('o')
    status = 'running'
    source = 'Official jq 1.8.2 Windows amd64 release, byte-identical to the selected Drive file'
    public_asset_url = 'https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-windows-amd64.exe'
    checksum_source = 'https://github.com/jqlang/jq/blob/master/sig/v1.8.2/sha256sum.txt'
    expected_sha256 = $expectedHash
    actual_sha256 = $null
    target_pid = $null
    input_records = 1024
    output_records = 0
    event_count = 0
    etw_event_count = 0
    file_read_event_count = 0
    checks = $checks
    error = $null
}
$jqChild = $null
$collectorChild = $null

function Assert-Jq([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "JQ ACCEPTANCE FAILED: $Message" }
}

function Start-Managed([string] $Path, [string[]] $Arguments, [string] $Role) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    Assert-Jq (Test-Path -LiteralPath $fullPath -PathType Leaf) "Missing executable: $fullPath"
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $fullPath
    if ([IO.Path]::GetExtension($fullPath) -eq '.dll') {
        $info.FileName = (Get-Command dotnet -ErrorAction Stop).Source
        $info.ArgumentList.Add($fullPath)
    }
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = $utf8
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $info.WorkingDirectory = $OutputDirectory
    if ($Role -eq 'collector') { $info.Environment['MICROSCOPE_SESSION_NAME'] = $sessionName }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    Assert-Jq ($process.Start()) "Could not start $Role"
    $child = [pscustomobject]@{
        Process = $process
        Role = $Role
        ErrorTask = $process.StandardError.ReadToEndAsync()
        OutputTask = $null
        Prefix = [Collections.Generic.List[string]]::new()
    }
    # Collector stdout is read line-by-line until READY; every other stream is
    # drained asynchronously before input is sent, preventing full-pipe hangs.
    if ($Role -ne 'collector') { $child.OutputTask = $process.StandardOutput.ReadToEndAsync() }
    $children.Add($child)
    return $child
}

function Save-ManagedLogs($Child) {
    $text = $Child.Prefix -join [Environment]::NewLine
    if ($null -ne $Child.OutputTask -and $Child.OutputTask.IsCompletedSuccessfully) {
        $text += [Environment]::NewLine + $Child.OutputTask.GetAwaiter().GetResult()
    }
    [IO.File]::WriteAllText((Join-Path $OutputDirectory "$($Child.Role).stdout.log"), $text, $utf8)
    if ($Child.ErrorTask.IsCompletedSuccessfully) {
        [IO.File]::WriteAllText((Join-Path $OutputDirectory "$($Child.Role).stderr.log"), $Child.ErrorTask.GetAwaiter().GetResult(), $utf8)
    }
}

function Finish-Managed($Child, [int] $Seconds = 30) {
    if ($null -eq $Child.OutputTask) { $Child.OutputTask = $Child.Process.StandardOutput.ReadToEndAsync() }
    Assert-Jq ($Child.Process.WaitForExit($Seconds * 1000)) "$($Child.Role) exceeded its ${Seconds}s exit deadline"
    Assert-Jq ($Child.OutputTask.Wait([TimeSpan]::FromSeconds(5))) "$($Child.Role) stdout remained open"
    Assert-Jq ($Child.ErrorTask.Wait([TimeSpan]::FromSeconds(5))) "$($Child.Role) stderr remained open"
    Save-ManagedLogs $Child
    Assert-Jq ($Child.Process.ExitCode -eq 0) "$($Child.Role) exited $($Child.Process.ExitCode): $($Child.ErrorTask.GetAwaiter().GetResult())"
    return $Child.OutputTask.GetAwaiter().GetResult()
}

try {
    Assert-Jq $IsWindows 'A real Windows host is required; non-Windows is a failure, not a passing skip'
    $JqPath = [IO.Path]::GetFullPath($JqPath)
    $CollectorPath = [IO.Path]::GetFullPath($CollectorPath)
    $actualHash = (Get-FileHash -LiteralPath $JqPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.actual_sha256 = $actualHash
    Assert-Jq ($actualHash -eq $expectedHash) 'jq bytes differ from the verified official/Drive jq 1.8.2 binary'
    $checks.Add('jq SHA-256 matches the public release and selected Drive binary')
    $versionChild = Start-Managed $JqPath @('--version') 'jq-version'
    $versionChild.Process.StandardInput.Close()
    $version = (Finish-Managed $versionChild 10).Trim()
    Assert-Jq ($version -eq 'jq-1.8.2') "Unexpected jq version: $version"
    $checks.Add('jq reports version 1.8.2')

    $token = 'jq-observation-' + [Guid]::NewGuid().ToString('N')
    $fileName = "$token.json"
    $inputPath = Join-Path $OutputDirectory $fileName
    $fileRecord = [ordered]@{ token = $token; sequence = 1024; value = 'from-file' }
    [IO.File]::WriteAllText($inputPath, ($fileRecord | ConvertTo-Json -Compress) + "`n", $utf8)
    $tracePath = Join-Path $OutputDirectory 'jq.mtp.json'
    if (Test-Path -LiteralPath $tracePath) { Remove-Item -LiteralPath $tracePath -Force }

    # '-' consumes stdin first. Its pipe remains open until READY, so the
    # subsequent uniquely named input file is opened after ETW is listening.
    $jqChild = Start-Managed $JqPath @('-c', '.', '-', $inputPath) 'jq'
    $targetPid = $jqChild.Process.Id
    $report.target_pid = $targetPid
    $collectorChild = Start-Managed $CollectorPath @('--pid', "$targetPid", '--duration', '20', '--out', $tracePath) 'collector'
    $readyClock = [Diagnostics.Stopwatch]::StartNew()
    $ready = $false
    while (-not $ready -and $readyClock.Elapsed.TotalSeconds -lt 25) {
        $lineTask = $collectorChild.Process.StandardOutput.ReadLineAsync()
        $remaining = [Math]::Max(1, [Math]::Ceiling(25 - $readyClock.Elapsed.TotalSeconds))
        Assert-Jq ($lineTask.Wait([TimeSpan]::FromSeconds($remaining))) 'Collector did not print READY before its startup deadline'
        $line = $lineTask.GetAwaiter().GetResult()
        Assert-Jq ($null -ne $line) 'Collector exited before READY; inspect collector.stderr.log'
        $collectorChild.Prefix.Add($line)
        $ready = $line.Trim() -eq 'READY'
    }
    Assert-Jq $ready 'Collector did not announce READY'
    Assert-Jq (-not $jqChild.Process.HasExited) 'jq exited before the capture attached'
    $collectorChild.OutputTask = $collectorChild.Process.StandardOutput.ReadToEndAsync()
    $checks.Add('Collector announced READY while jq remained blocked on stdin')

    $jsonInput = [Text.StringBuilder]::new()
    for ($index = 0; $index -lt 1024; $index++) {
        $record = [ordered]@{ token = $token; sequence = $index; value = 'synthetic-json-record' }
        [void]$jsonInput.AppendLine(($record | ConvertTo-Json -Compress))
    }
    $writeTask = $jqChild.Process.StandardInput.WriteAsync($jsonInput.ToString())
    Assert-Jq ($writeTask.Wait([TimeSpan]::FromSeconds(10))) 'jq did not accept the bounded input payload'
    $jqChild.Process.StandardInput.Flush()
    $jqChild.Process.StandardInput.Close()
    $output = Finish-Managed $jqChild 20
    $lines = @($output -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    Assert-Jq ($lines.Count -eq 1025) "Expected 1025 JSON outputs, received $($lines.Count)"
    for ($index = 0; $index -lt $lines.Count; $index++) {
        $record = ConvertFrom-Json -InputObject $lines[$index] -AsHashtable
        Assert-Jq ($record.token -eq $token -and $record.sequence -eq $index) "Output record $index differs from the supplied input"
        $expectedValue = if ($index -eq 1024) { 'from-file' } else { 'synthetic-json-record' }
        Assert-Jq ($record.value -eq $expectedValue) "Output record $index has an unexpected value"
    }
    $report.output_records = $lines.Count
    $checks.Add('All 1024 stdin records and the final file record round-trip through jq')
    [void](Finish-Managed $collectorChild 35)
    Assert-Jq (Test-Path -LiteralPath $tracePath -PathType Leaf) 'Collector did not persist a trace'
    $trace = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($tracePath)) -AsHashtable -Depth 100 -NoEnumerate
    Assert-Jq ($trace.schema_version -eq '0.1' -and $trace.run.status -eq 'completed') 'Capture did not finish as compatible, completed MTP'
    Assert-Jq ($trace.run.target.pid -eq $targetPid) 'Captured PID differs from the launched jq PID'
    Assert-Jq ($trace.run.stop_reason -eq 'target_exited') 'Collector did not observe jq exit'
    foreach ($key in @('nodes', 'threads', 'events', 'values', 'edges', 'evidence', 'io', 'counters', 'capabilities', 'resources', 'diagnostics')) {
        Assert-Jq ($trace.Contains($key) -and $trace[$key] -is [Collections.IList]) "Trace.$key is not a JSON array"
    }
    Assert-Jq ($trace.events.Count -gt 0 -and $trace.events.Count -le 100000) 'Trace event count is empty or exceeds the capture cap'
    Assert-Jq ($trace.values.Count -eq 0 -and $trace.edges.Count -eq 0) 'Observe capture contains invented values or causal edges'
    $etw = @($trace.events | Where-Object { $_.details.Contains('provider') })
    Assert-Jq ($etw.Count -gt 0) 'Only process snapshots were captured; no real ETW activity was observed'
    Assert-Jq (@($etw | Where-Object { $_.details.pid -ne $targetPid }).Count -eq 0) 'ETW contains events attributed to a different PID'
    $reads = @($etw | Where-Object {
        $_.kind -eq 'file' -and $_.phase -eq 'read' -and $_.details.Contains('file_path') -and
        [string]$_.details.file_path -like "*$fileName"
    })
    Assert-Jq ($reads.Count -gt 0) 'ETW did not observe jq reading the unique synthetic input file after READY'
    $evidence = @{}
    foreach ($entry in $trace.evidence) { $evidence[[string]$entry.id] = $entry }
    foreach ($read in $reads) {
        Assert-Jq ($read.evidence_ids.Count -gt 0) 'Observed file read has no evidence reference'
        foreach ($id in $read.evidence_ids) { Assert-Jq ($evidence.ContainsKey($id) -and $evidence[$id].truth -eq 'REAL') 'File read lacks REAL evidence' }
    }
    $report.event_count = $trace.events.Count
    $report.etw_event_count = $etw.Count
    $report.file_read_event_count = $reads.Count
    $checks.Add('Real jq PID, ETW activity, unique file read, and REAL evidence are present')
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    [Console]::Error.WriteLine($report.error)
} finally {
    foreach ($child in $children.ToArray()) {
        try {
            if (-not $child.Process.HasExited) {
                if ($child.Role -eq 'collector') {
                    $child.Process.StandardInput.WriteLine('stop')
                    $child.Process.StandardInput.Flush()
                } else { $child.Process.StandardInput.Close() }
                if (-not $child.Process.WaitForExit(20000)) {
                    $child.Process.Kill($true)
                    [void]$child.Process.WaitForExit(5000)
                }
            }
            Save-ManagedLogs $child
            $child.Process.Dispose()
        } catch { [Console]::Error.WriteLine("Cleanup $($child.Role): $($_.Exception.Message)") }
    }
    if ($null -ne $collectorChild -and $IsWindows) {
        try {
            $cleanup = Start-Managed $CollectorPath @('--stop-session', $sessionName) 'session-cleanup'
            $cleanup.Process.StandardInput.Close()
            [void](Finish-Managed $cleanup 10)
            $cleanup.Process.Dispose()
        } catch {
            $report.status = 'failed'
            $report.error = "$($report.error) ETW session cleanup failed: $($_.Exception.Message)".Trim()
        }
    }
    $report.finished_at = [DateTimeOffset]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'jq-acceptance-report.json'), ($report | ConvertTo-Json -Depth 20), $utf8)
}
if ($report.status -ne 'passed') { exit 1 }
Write-Host "jq 1.8.2 acceptance passed ($($checks.Count) checks). Artifacts: $OutputDirectory"
exit 0
