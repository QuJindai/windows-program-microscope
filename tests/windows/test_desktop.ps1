[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$SkipScreenshot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Installed desktop smoke testing requires Windows.' }
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'RUNNER_TEMP is required: this installer smoke test must use an isolated CI temporary directory.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or [IO.Path]::GetExtension($installer) -ne '.exe') {
    throw 'InstallerPath must identify the built NSIS executable.'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$temporaryRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path.TrimEnd('\', '/')
$ownedName = 'microscope-desktop-smoke-' + [Guid]::NewGuid().ToString('N')
$installation = Join-Path $temporaryRoot $ownedName
New-Item -ItemType Directory -Path $installation | Out-Null
$reportPath = Join-Path $output 'desktop-report.json'
$report = [ordered]@{
    scope = 'Installed Windows desktop startup; compilation, ETW capture, and UI interaction are separate checks.'
    started_at = [DateTime]::UtcNow.ToString('o')
    status = 'running'
    installer = [ordered]@{ path = $installer; sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); status = 'not_run' }
    installation = [ordered]@{ directory = $installation; status = 'not_run' }
    collector = [ordered]@{ capabilities = 'not_run'; process_list = 'not_run' }
    startup = [ordered]@{ status = 'not_run' }
    screenshot = [ordered]@{ status = 'not_attempted' }
    cleanup = [ordered]@{ status = 'not_run'; errors = @() }
    errors = @()
}
$app = $null
$failure = $null

function Save-Report {
    $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reportPath -Encoding utf8
}

function Stop-OwnedProcess([Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        $Process.Kill($true)
        if (-not $Process.WaitForExit(10000)) { throw "Owned process $($Process.Id) did not terminate." }
    }
}

function Invoke-BoundedProcess([string]$Executable, [string]$Arguments, [int]$TimeoutSeconds, [string]$LogName) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    try {
        if (-not $process.Start()) { throw "Could not start $Executable" }
        $started = $true
        # Both streams drain concurrently so a diagnostic cannot fill a pipe and deadlock the process.
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Stop-OwnedProcess $process
            throw "$LogName timed out after $TimeoutSeconds seconds."
        }
        if (-not $stdout.Wait(2000) -or -not $stderr.Wait(2000)) { throw "$LogName output streams did not close." }
        $outText = $stdout.GetAwaiter().GetResult()
        $errText = $stderr.GetAwaiter().GetResult()
        $outText | Set-Content -LiteralPath (Join-Path $output "$LogName.stdout.txt") -Encoding utf8
        $errText | Set-Content -LiteralPath (Join-Path $output "$LogName.stderr.txt") -Encoding utf8
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $outText; Stderr = $errText }
    }
    finally {
        try { if ($started) { Stop-OwnedProcess $process } } finally { $process.Dispose() }
    }
}

function Capture-ActualWindow([Diagnostics.Process]$Process) {
    if (-not [Environment]::UserInteractive) { throw 'The runner has no interactive desktop.' }
    Add-Type -AssemblyName System.Drawing
    if (-not ('MicroscopeDesktopSmoke.Native' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace MicroscopeDesktopSmoke {
    public static class Native {
        [StructLayout(LayoutKind.Sequential)]
        public struct Rect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll", SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    }
}
'@
    }
    $window = $Process.MainWindowHandle
    [void][MicroscopeDesktopSmoke.Native]::ShowWindow($window, 9)
    [void][MicroscopeDesktopSmoke.Native]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds 500
    if ([MicroscopeDesktopSmoke.Native]::GetForegroundWindow() -ne $window) {
        throw 'The application window could not become the foreground window; screenshot would be ambiguous.'
    }
    $bounds = [MicroscopeDesktopSmoke.Native+Rect]::new()
    if (-not [MicroscopeDesktopSmoke.Native]::GetWindowRect($window, [ref]$bounds)) { throw 'GetWindowRect failed.' }
    $width = $bounds.Right - $bounds.Left
    $height = $bounds.Bottom - $bounds.Top
    if ($width -lt 100 -or $height -lt 100 -or $width -gt 8192 -or $height -gt 8192) {
        throw "Unusable application window dimensions: $width x $height"
    }
    $bitmap = [Drawing.Bitmap]::new($width, $height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
        # Locked/service desktops can return a flat black image without throwing.
        $colors = [Collections.Generic.HashSet[int]]::new()
        for ($row = 0; $row -lt 32; $row++) {
            for ($column = 0; $column -lt 32; $column++) {
                [void]$colors.Add($bitmap.GetPixel([int]($column * ($width - 1) / 31), [int]($row * ($height - 1) / 31)).ToArgb())
            }
        }
        if ($colors.Count -lt 8) { throw 'Desktop capture was blank or flat; no usable screenshot was produced.' }
        $screenshot = Join-Path $output 'installed-desktop.png'
        $bitmap.Save($screenshot, [Drawing.Imaging.ImageFormat]::Png)
        return [ordered]@{ status = 'captured'; path = $screenshot; width = $width; height = $height; method = 'GetWindowRect + CopyFromScreen of the actual foreground window' }
    }
    finally { $graphics.Dispose(); $bitmap.Dispose() }
}

try {
    Save-Report
    # NSIS requires /D= to be the final argument and to remain unquoted; no shell is involved.
    $install = Invoke-BoundedProcess $installer "/S /D=$installation" 120 'installer'
    $report.installer.exit_code = $install.ExitCode
    if ($install.ExitCode -ne 0) { throw "NSIS installation exited with $($install.ExitCode): $($install.Stderr)" }
    $report.installer.status = 'passed'
    $main = Join-Path $installation 'program-microscope.exe'
    $collector = Join-Path $installation 'collector\ProgramMicroscope.Collector.exe'
    if (-not (Test-Path -LiteralPath $main -PathType Leaf)) { throw "Installed desktop executable is missing: $main" }
    if (-not (Test-Path -LiteralPath $collector -PathType Leaf)) { throw "Installed collector executable is missing: $collector" }
    $report.installation.status = 'passed'
    $report.installation.main_executable = $main
    $report.installation.collector_executable = $collector

    $capabilities = Invoke-BoundedProcess $collector '--capabilities' 20 'installed-collector-capabilities'
    if ($capabilities.ExitCode -ne 0) { throw "Installed collector --capabilities failed: $($capabilities.Stderr)" }
    $capabilityData = $capabilities.Stdout | ConvertFrom-Json
    if ($capabilityData.platform -ne 'windows' -or $capabilityData.collector_available -ne $true) {
        throw "Installed collector is unavailable: $($capabilities.Stdout)"
    }
    $report.collector.capabilities = 'passed'
    $report.collector.capability_response = $capabilityData
    $processes = Invoke-BoundedProcess $collector '--list-processes' 20 'installed-collector-processes'
    if ($processes.ExitCode -ne 0) { throw "Installed collector --list-processes failed: $($processes.Stderr)" }
    if (-not $processes.Stdout.TrimStart().StartsWith('[')) { throw 'Installed process list did not return a JSON array.' }
    $processData = @($processes.Stdout | ConvertFrom-Json)
    if ($processData.Count -eq 0 -or @($processData | Where-Object { $_.pid -gt 0 }).Count -eq 0) { throw 'Installed collector returned no usable processes.' }
    $report.collector.process_list = 'passed'
    $report.collector.process_count = $processData.Count

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $main
    $start.WorkingDirectory = $installation
    $start.UseShellExecute = $false
    $app = [Diagnostics.Process]::Start($start)
    $report.startup.pid = $app.Id
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ($true) {
        $app.Refresh()
        if ($app.HasExited) { throw "Installed desktop exited before showing its window (code $($app.ExitCode))." }
        if ($app.MainWindowHandle -ne [IntPtr]::Zero -and $app.MainWindowTitle -eq '程序显微镜') { break }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Installed desktop did not expose the expected Chinese window title. Last title: '$($app.MainWindowTitle)'"
        }
        Start-Sleep -Milliseconds 200
    }
    $alive = [Diagnostics.Stopwatch]::StartNew()
    while ($alive.Elapsed.TotalSeconds -lt 3) {
        Start-Sleep -Milliseconds 200
        $app.Refresh()
        if ($app.HasExited -or $app.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Installed desktop did not remain alive with a window for three seconds.' }
    }
    $report.startup.status = 'passed'
    $report.startup.window_title = $app.MainWindowTitle
    $report.startup.window_handle = '0x' + $app.MainWindowHandle.ToInt64().ToString('X')
    $report.startup.observed_alive_seconds = [Math]::Round($alive.Elapsed.TotalSeconds, 3)
    if ($SkipScreenshot) { $report.screenshot.status = 'skipped_by_request' }
    elseif (-not [Environment]::UserInteractive) {
        $report.screenshot = [ordered]@{ status = 'unavailable'; error = 'The runner has no interactive desktop.' }
    }
    else {
        try { $report.screenshot = Capture-ActualWindow $app }
        catch {
            $report.screenshot = [ordered]@{ status = 'failed'; error = $_.Exception.Message }
            Write-Warning "Desktop startup passed; screenshot was not captured: $($_.Exception.Message)"
        }
    }
    $report.status = 'passed'
}
catch {
    $failure = $_.Exception.Message
    $report.status = 'failed'
    $report.errors += $failure
    if ($report.startup.status -ne 'passed') { $report.startup.status = 'failed_or_not_reached' }
}
finally {
    if ($null -ne $app) {
        try {
            $app.Refresh()
            if (-not $app.HasExited) {
                [void]$app.CloseMainWindow()
                if (-not $app.WaitForExit(10000)) { Stop-OwnedProcess $app }
            }
        }
        catch { $report.cleanup.errors += "Desktop stop: $($_.Exception.Message)" }
        finally { $app.Dispose() }
    }
    try {
        # Only the nonce directory created by this invocation can ever be removed.
        $actual = [IO.Path]::GetFullPath($installation).TrimEnd('\', '/')
        $expected = [IO.Path]::GetFullPath((Join-Path $temporaryRoot $ownedName)).TrimEnd('\', '/')
        if ($actual -ne $expected -or -not $ownedName.StartsWith('microscope-desktop-smoke-')) { throw 'Owned-directory cleanup guard failed.' }
        $uninstaller = Join-Path $installation 'uninstall.exe'
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            $uninstall = Invoke-BoundedProcess $uninstaller "/S _?=$installation" 45 'uninstaller'
            $report.cleanup.uninstaller_exit_code = $uninstall.ExitCode
            if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)." }
        }
        elseif ($report.installer.status -eq 'passed') { throw 'Installed uninstaller is missing; registry/shortcut cleanup cannot be confirmed.' }
        if (Test-Path -LiteralPath $installation) { Remove-Item -LiteralPath $installation -Recurse -Force }
    }
    catch { $report.cleanup.errors += $_.Exception.Message }
    $report.cleanup.status = if ($report.cleanup.errors.Count -eq 0) { 'passed' } else { 'failed' }
    if ($report.cleanup.status -eq 'failed') {
        $report.status = 'failed'
        if ($null -eq $failure) { $failure = 'Installed desktop cleanup failed; see desktop-report.json.' }
    }
    $report.finished_at = [DateTime]::UtcNow.ToString('o')
    Save-Report
}
if ($null -ne $failure) { throw $failure }
Write-Host "Installed desktop startup passed. Screenshot: $($report.screenshot.status). Report: $reportPath"
