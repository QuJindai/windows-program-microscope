using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
using Microsoft.Diagnostics.Tracing.Session;

try
{
    var options = CollectorOptions.Parse(args);
    if (options.Command == "capabilities")
    {
        var supported = OperatingSystem.IsWindows() && TraceEventSession.IsElevated() == true;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            platform = OperatingSystem.IsWindows() ? "windows" : RuntimeInformation.OSDescription,
            collector_available = supported,
            reason = supported ? "ETW capture requires successful provider startup; no session has been started by this query."
                : OperatingSystem.IsWindows() ? "Run the application elevated to start the kernel ETW session."
                : "The Windows collector can only run on Windows.",
            capabilities = CaptureState.CapabilityList(supported)
        }));
        return 0;
    }
    if (!OperatingSystem.IsWindows())
    {
        Console.Error.WriteLine("The Windows collector can only run on Windows.");
        return 2;
    }
    if (options.Command == "stop_session")
    {
        try
        {
            using var existing = TraceEventSession.GetActiveSession(options.SessionName!);
            var stopped = existing?.Stop() ?? true;
            Console.WriteLine(JsonSerializer.Serialize(new { stopped, reason = existing is null ? "Session is already absent." : "Session stopped." }));
            return stopped ? 0 : 1;
        }
        catch (Exception error)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { stopped = false, reason = error.Message }));
            return 1;
        }
    }
    if (options.Command == "list")
    {
        var rows = new List<MtpTarget>();
        foreach (var item in Process.GetProcesses())
        {
            using (item)
            {
                if (item.Id <= 0) continue; // Idle PID 0 is not a selectable capture target.
                try { rows.Add(ProcessMetadata.Read(item)); }
                catch (InvalidOperationException) { /* Process exited during enumeration. */ }
                catch (System.ComponentModel.Win32Exception) { /* Enumeration raced an exit/access change. */ }
            }
        }
        Console.WriteLine(JsonSerializer.Serialize(rows.OrderBy(x => x.Pid)));
        return 0;
    }
    using var process = Process.GetProcessById(options.Pid);
    return await Collector.Capture(options, process);
}
catch (ArgumentException error)
{
    Console.Error.WriteLine(error.Message);
    Console.Error.WriteLine("Usage: --list-processes | --capabilities | --stop-session ProgramMicroscope-NAME | --pid N [--duration 1..3600] [--out FILE]");
    return 2;
}
catch (Exception error)
{
    Console.Error.WriteLine($"Collector failed: {error.GetType().Name}: {error.Message}");
    return 1;
}

internal static class Collector
{
    public static async Task<int> Capture(CollectorOptions options, Process process)
    {
        var state = new CaptureState(options, ProcessMetadata.Read(process));
        var sessionName = Environment.GetEnvironmentVariable("MICROSCOPE_SESSION_NAME") ?? $"ProgramMicroscope-{Environment.ProcessId}-{Guid.NewGuid():N}";
        CollectorOptions.ValidateSessionName(sessionName);
        using var session = new TraceEventSession(sessionName, TraceEventSessionOptions.Create | TraceEventSessionOptions.NoRestartOnCreate)
        { StopOnDispose = true, BufferSizeMB = 64 };
        ConsoleCancelEventHandler cancel = (_, e) => { e.Cancel = true; state.RequestStop("requested"); };
        Console.CancelKeyPress += cancel;
        Task? consumer = null;
        try
        {
            // FileIOInit records operation initiation; DiskFileIO supplies name mapping.
            session.EnableKernelProvider(KernelTraceEventParser.Keywords.Process |
                KernelTraceEventParser.Keywords.Thread | KernelTraceEventParser.Keywords.ImageLoad |
                KernelTraceEventParser.Keywords.FileIO | KernelTraceEventParser.Keywords.FileIOInit |
                KernelTraceEventParser.Keywords.DiskFileIO | KernelTraceEventParser.Keywords.Registry |
                KernelTraceEventParser.Keywords.NetworkTCPIP);
            var source = session.Source;
            var kernel = new KernelTraceEventParser(source,
                KernelTraceEventParser.ParserTrackingOptions.ThreadToProcess |
                KernelTraceEventParser.ParserTrackingOptions.FileNameToObject |
                KernelTraceEventParser.ParserTrackingOptions.VolumeMapping);
            Register(kernel, state);
            state.ProvidersEnabled();
            state.Snapshot(process);
            state.Sample(process);
            consumer = Task.Run(() => source.Process());
            Console.WriteLine("READY");
            Console.Out.Flush();
            // EOF is not a stop request: callers may launch without redirecting stdin.
            _ = Task.Run(async () =>
            {
                try
                {
                    while (await Console.In.ReadLineAsync() is { } line)
                        if (line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase))
                        { state.RequestStop("requested"); break; }
                }
                catch (IOException) { /* Closed parent pipe; duration still bounds capture. */ }
            });
            while (state.StopReason is null && !consumer.IsCompleted)
            {
                await Task.Delay(100);
                if (state.ElapsedMs >= options.DurationSeconds * 1000.0) state.RequestStop("duration");
                try
                {
                    if (process.HasExited) state.RequestStop("target_exited");
                    else if (state.StopReason is null) state.Sample(process);
                }
                catch (InvalidOperationException) { state.RequestStop("target_exited"); }
            }
            if (state.StopReason is null)
            {
                if (consumer.IsFaulted) await consumer;
                throw new IOException("ETW consumer ended before capture was stopped.");
            }
            // Source.EventsLost is only a header snapshot in a real-time session.
            try { session.Flush(); state.RecordLoss(session.EventsLost); }
            catch (Exception error) { state.Diagnostic("loss_query_failed", "warning", error.Message); }
            // Stop the producer so Process() drains final buffers. StopProcessing() alone
            // abandons pending data and is reserved for bounded emergency cleanup.
            session.Stop();
            try { await consumer.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (TimeoutException)
            {
                source.StopProcessing();
                state.Fail("consumer_drain_timeout", "ETW did not drain within 10 seconds; final buffers may be incomplete.");
                await consumer.WaitAsync(TimeSpan.FromSeconds(5));
            }
        }
        catch (Exception error)
        {
            state.Fail(consumer is null ? "provider_start_failed" : "consumer_failed", $"{error.GetType().Name}: {error.Message}");
            if (consumer is null) state.ProvidersUnavailable(error.Message);
            try { session.Stop(true); } catch (Exception) { }
            if (consumer is not null && !consumer.IsCompleted)
            {
                try { session.Source.StopProcessing(); await consumer.WaitAsync(TimeSpan.FromSeconds(5)); }
                catch (Exception cleanupError) { state.Diagnostic("cleanup_failed", "error", cleanupError.Message); }
            }
        }
        finally { Console.CancelKeyPress -= cancel; }
        state.Write(options.OutputPath);
        Console.WriteLine($"WROTE {state.EventCount} events to {Path.GetFullPath(options.OutputPath)}");
        return state.Failed ? 1 : 0;
    }

    private static void Register(KernelTraceEventParser k, CaptureState s)
    {
        k.ProcessStart += d => s.Etw(d, "process", "start", d.ImageFileName);
        k.ProcessStop += d => s.Etw(d, "process", "stop", d.ImageFileName);
        k.ProcessDCStart += d => s.Etw(d, "process", "rundown", d.ImageFileName);
        k.ThreadStart += d => s.Etw(d, "thread", "start", $"Thread {d.ThreadID}");
        k.ThreadStop += d => s.Etw(d, "thread", "stop", $"Thread {d.ThreadID}");
        k.ThreadDCStart += d => s.Etw(d, "thread", "rundown", $"Thread {d.ThreadID}");
        k.ImageLoad += d => s.Etw(d, "module", "load", d.FileName, new() { ["file_path"] = d.FileName, ["image_base"] = $"0x{d.ImageBase:x}", ["image_size"] = d.ImageSize });
        k.ImageUnload += d => s.Etw(d, "module", "unload", d.FileName);
        k.ImageDCStart += d => s.Etw(d, "module", "rundown", d.FileName);
        k.FileIOCreate += d => s.File(d, "create", d.FileName, null, new() { ["file_object"] = $"0x{d.FileObject:x}", ["create_disposition"] = d.CreateDisposition.ToString() });
        k.FileIORead += d => s.File(d, "read", d.FileName, d.IoSize >= 0 ? d.IoSize : null, new() { ["offset"] = d.Offset, ["irp"] = $"0x{d.IrpPtr:x}" });
        k.FileIOWrite += d => s.File(d, "write", d.FileName, d.IoSize >= 0 ? d.IoSize : null, new() { ["offset"] = d.Offset, ["irp"] = $"0x{d.IrpPtr:x}" });
        k.FileIOFlush += d => s.File(d, "flush", d.FileName, null);
        k.FileIOClose += d => s.File(d, "close", d.FileName, null);
        k.FileIODelete += d => s.File(d, "delete", d.FileName, null);
        k.FileIORename += d => s.File(d, "rename", d.FileName, null);
        k.RegistryCreate += d => s.Registry(d, "create");
        k.RegistryOpen += d => s.Registry(d, "open");
        k.RegistrySetValue += d => s.Registry(d, "set_value");
        k.RegistryQueryValue += d => s.Registry(d, "query_value");
        k.RegistryDeleteValue += d => s.Registry(d, "delete_value");
        k.RegistryDelete += d => s.Registry(d, "delete");
        k.RegistryClose += d => s.Registry(d, "close");
        k.RegistryKCBCreate += d => s.RegistryKcb(d, "kcb_create");
        k.RegistryKCBDelete += d => s.RegistryKcb(d, "kcb_delete");
        k.RegistryKCBRundownBegin += d => s.RegistryKcb(d, "kcb_rundown_begin");
        k.RegistryKCBRundownEnd += d => s.RegistryKcb(d, "kcb_rundown_end");
        k.TcpIpConnect += d => s.Network(d, "connect", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, null);
        k.TcpIpAccept += d => s.Network(d, "accept", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, null);
        k.TcpIpSend += d => s.Network(d, "send", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, d.size);
        k.TcpIpRecv += d => s.Network(d, "receive", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, d.size);
        k.TcpIpDisconnect += d => s.Network(d, "disconnect", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, null);
        k.TcpIpSendIPV6 += d => s.Network(d, "send", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, d.size);
        k.TcpIpRecvIPV6 += d => s.Network(d, "receive", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, d.size);
        k.TcpIpConnectIPV6 += d => s.Network(d, "connect", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, null);
        k.TcpIpAcceptIPV6 += d => s.Network(d, "accept", d.saddr.ToString(), d.sport, d.daddr.ToString(), d.dport, null);
    }
}

internal sealed class CaptureState
{
    public const int MaxEvents = 100000;
    public const long MaxRecordBytes = 48L * 1024 * 1024;
    public const long MaxOutputBytes = 64L * 1024 * 1024;
    private readonly object gate = new();
    private readonly CollectorOptions options;
    private readonly MtpTarget target;
    private readonly long origin = Stopwatch.GetTimestamp();
    private readonly string startedAt = DateTimeOffset.UtcNow.ToString("O");
    private readonly string id = Guid.NewGuid().ToString("N");
    private long? endQpc;
    private string? stopReason;
    private bool failed;
    private int? eventsLost;
    private int filteredAfterStop;
    private int droppedByLimit;
    private long encodedRecordBytes;
    private int droppedByByteLimit;
    private readonly List<MtpEvent> events = new();
    private readonly Dictionary<string, MtpNode> nodes = new(StringComparer.Ordinal);
    private readonly Dictionary<int, object> threads = new();
    private readonly Dictionary<string, MtpEvidence> evidence = new(StringComparer.Ordinal);
    private readonly List<Dictionary<string, object?>> io = new();
    private readonly Dictionary<string, MtpResource> resources = new(StringComparer.Ordinal);
    private readonly Dictionary<string, MtpCapability> capabilities = new(StringComparer.Ordinal);
    private readonly Dictionary<string, MtpCounter> counters = new(StringComparer.Ordinal);
    private readonly List<object> diagnostics = new();
    private readonly HashSet<string> diagnosticCodes = new(StringComparer.Ordinal);
    private readonly RegistryKeyCache registryNames = new();
    private double? lastCpuMs;
    private double lastCpuTime;
    private double lastSampleTime = -250;
    private static readonly string[] EtwKinds = ["process", "thread", "module", "file", "registry", "network"];

    public CaptureState(CollectorOptions options, MtpTarget target)
    {
        this.options = options; this.target = target;
        foreach (var c in CapabilityList(false)) capabilities[c.Id] = c.Id is "stacks" or "locals" or "time_travel"
            ? c : c with { Available = false, Status = "not_collected", Reason = "No samples or enabled provider have been observed for this source." };
        foreach (var kind in EtwKinds)
            evidence[$"ev_etw_{kind}"] = new($"ev_etw_{kind}", "REAL", $"Windows kernel ETW {kind}", "Timestamp and decoded event payload; no stack, causal edge, or unobserved operation duration is inferred.");
        evidence["ev_snapshot"] = new("ev_snapshot", "REAL", "Windows process API snapshot", "Process/module/thread presence at capture startup; snapshot timestamps do not identify original load/start time.");
        evidence["ev_counters"] = new("ev_counters", "REAL", "System.Diagnostics.Process", "Sampled TotalProcessorTime, WorkingSet64 and PrivateMemorySize64 with monotonic sample timestamps.");
        evidence["ev_cpu_percent"] = new("ev_cpu_percent", "DERIVED", "Process CPU percentage calculation",
            "100 * delta(process_cpu_ms) / (delta(timestamp_ms) * logical_processors), using successive ev_counters process CPU time samples.", ["ev_counters"]);
    }

    public static MtpCapability[] CapabilityList(bool ready) => EtwKinds.Select(x => new MtpCapability(x, ready,
        ready ? "supported" : "unavailable", "Windows kernel ETW", ready ? "Requires successful provider enablement during capture." : "Requires Windows and elevation."))
        .Concat(new[] {
            new MtpCapability("cpu", OperatingSystem.IsWindows(), OperatingSystem.IsWindows() ? "supported" : "unavailable", "Windows process API", "Process CPU time and normalized CPU percentage; target access can fail."),
            new MtpCapability("memory", OperatingSystem.IsWindows(), OperatingSystem.IsWindows() ? "supported" : "unavailable", "Windows process API", "Working set and private bytes; target access can fail."),
            new MtpCapability("stacks", false, "unavailable", "none", "Stack collection and symbol resolution are not implemented."),
            new MtpCapability("locals", false, "unavailable", "none", "ETW does not expose arbitrary native local variables."),
            new MtpCapability("time_travel", false, "unavailable", "none", "Instruction replay is not provided by this collector.")
        }).ToArray();
    public string? StopReason { get { lock (gate) return stopReason; } }
    public bool Failed { get { lock (gate) return failed; } }
    public int EventCount { get { lock (gate) return events.Count; } }
    public double ElapsedMs => (Stopwatch.GetTimestamp() - origin) * 1000.0 / Stopwatch.Frequency;
    public void RequestStop(string reason)
    {
        lock (gate) { if (stopReason is null) { endQpc = Stopwatch.GetTimestamp(); stopReason = reason; } }
    }
    public void ProvidersEnabled()
    {
        lock (gate) foreach (var x in EtwKinds) capabilities[x] = capabilities[x] with { Available = true, Status = "enabled", Reason = "Provider enabled; event counts are reported separately." };
    }
    public void ProvidersUnavailable(string reason)
    {
        lock (gate) foreach (var x in EtwKinds) capabilities[x] = capabilities[x] with { Available = false, Status = "unavailable", Reason = reason };
    }
    public void Diagnostic(string code, string severity, string message)
    {
        lock (gate) if (diagnosticCodes.Add(code)) diagnostics.Add(new { code, severity, message });
    }
    public void Fail(string code, string message)
    {
        lock (gate)
        {
            failed = true; RequestStop("error"); Diagnostic(code, "error", message);
            evidence[$"ev_failure_{code}"] = new($"ev_failure_{code}", "UNAVAILABLE", "Windows collector", message);
        }
    }
    public void RecordLoss(int count) { lock (gate) eventsLost = count; }

    public void Snapshot(Process process)
    {
        Add("process", "snapshot", target.Name, ElapsedMs, 0, null, new() { ["pid"] = target.Pid, ["path"] = target.Path }, "ev_snapshot");
        try
        {
            foreach (ProcessThread thread in process.Threads)
            { using (thread) Add("thread", "snapshot", $"Thread {thread.Id}", ElapsedMs, 0, thread.Id, new(), "ev_snapshot"); }
        }
        catch (Exception error) { Diagnostic("thread_snapshot_unavailable", "warning", error.Message); }
        try
        {
            foreach (ProcessModule module in process.Modules)
                Add("module", "snapshot", module.FileName, ElapsedMs, 0, null,
                    new() { ["file_path"] = module.FileName, ["image_base"] = $"0x{module.BaseAddress:x}", ["image_size"] = module.ModuleMemorySize }, "ev_snapshot");
        }
        catch (Exception error) { Diagnostic("module_snapshot_unavailable", "warning", error.Message); }
    }
    public void Sample(Process process)
    {
        lock (gate)
        {
            var timestamp = ElapsedMs;
            if (stopReason is not null || timestamp - lastSampleTime < 250) return;
            lastSampleTime = timestamp;
            process.Refresh();
            try
            {
                var cpu = process.TotalProcessorTime.TotalMilliseconds;
                Counter("process_cpu_ms", "Process CPU time", "ms", timestamp, cpu);
                if (lastCpuMs is { } prior && cpu >= prior && timestamp > lastCpuTime)
                    Counter("process_cpu_percent", "Process CPU", "%", timestamp, (cpu - prior) / (timestamp - lastCpuTime) * 100 / Environment.ProcessorCount);
                lastCpuMs = cpu; lastCpuTime = timestamp;
                capabilities["cpu"] = capabilities["cpu"] with { Available = true, Status = "observed", Reason = "Process API samples available; CPU percent uses successive samples and logical processor count." };
            }
            catch (Exception error) { Diagnostic("cpu_samples_unavailable", "warning", error.Message); }
            try
            {
                var working = process.WorkingSet64;
                var privateBytes = process.PrivateMemorySize64;
                Counter("working_set_bytes", "Working set", "bytes", timestamp, working);
                Counter("private_bytes", "Private bytes", "bytes", timestamp, privateBytes);
                capabilities["memory"] = capabilities["memory"] with { Available = true, Status = "observed", Reason = "Process API memory samples available." };
            }
            catch (Exception error) { Diagnostic("memory_samples_unavailable", "warning", error.Message); }
        }
    }
    internal void Counter(string counterId, string name, string unit, double time, double value)
    {
        if (!double.IsFinite(value) || value < 0) return;
        if (!counters.TryGetValue(counterId, out var counter)) counters[counterId] = counter = new(counterId, name, unit, new(), [counterId == "process_cpu_percent" ? "ev_cpu_percent" : "ev_counters"]);
        counter.Samples.Add(new(time, value));
    }
    public void Etw(TraceEvent data, string kind, string operation, string label, Dictionary<string, object?>? details = null)
    {
        if (data.ProcessID != target.Pid) return;
        // This QPC session and Stopwatch use the same monotonic Windows clock.
        // Keep a shared origin for ETW events and process-counter samples; session-
        // relative timestamps would otherwise have a different zero point.
#pragma warning disable CS0618
        var timestamp = (data.TimeStampQPC - origin) * 1000.0 / Stopwatch.Frequency;
        if (timestamp < 0) return;
        details ??= new();
        details["provider"] = data.ProviderName;
        details["event_name"] = data.EventName;
        details["event_version"] = data.Version;
        details["pid"] = data.ProcessID;
        details["timestamp_qpc"] = data.TimeStampQPC;
#pragma warning restore CS0618
        // The parser resolves omitted PID by thread ownership. Unknown ownership is
        // discarded, never attributed to the target by time proximity.
        Add(kind, operation, string.IsNullOrWhiteSpace(label) ? $"{kind} {operation} (name unavailable)" : label,
            timestamp, kind is "file" or "registry" or "network" ? null : 0,
            data.ThreadID > 0 ? data.ThreadID : null, details, $"ev_etw_{kind}");
    }
    public void File(TraceEvent data, string operation, string path, int? bytes, Dictionary<string, object?>? details = null)
    {
        if (data.ProcessID != target.Pid) return;
        details ??= new(); details["file_path"] = path;
        if (bytes is not null) { details["bytes"] = bytes; details["byte_semantics"] = "requested_io_size"; }
        Etw(data, "file", operation, path, details);
    }
    public void Registry(RegistryTraceData data, string operation)
    {
        if (data.ProcessID != target.Pid) return;
        var payload = RegistryKeyCache.Decode(data.EventData(), data.PointerSize, data.Version);
#pragma warning disable CS0618 // Shared monotonic ETW clock, as in Etw().
        var resolved = registryNames.Resolve(data.KeyHandle, operation, payload.Name, data.TimeStampQPC);
#pragma warning restore CS0618
        var valueName = operation is "set_value" or "query_value" or "delete_value" ? payload.Name : "";
        var details = new Dictionary<string, object?> { ["registry_key"] = resolved.Key, ["value_name"] = valueName,
            ["key_handle"] = $"0x{data.KeyHandle:x}", ["key_name_resolution"] = resolved.Resolution };
        if (operation is "open" or "create" or "delete") details["raw_key_name"] = payload.Name;
        if (payload.Status is { } status)
        {
            details["ntstatus"] = $"0x{status:x8}";
            details["result"] = status == 0 ? "success" : (status >> 30) switch
            { 3 => "failure", 2 => "warning", _ => "informational" };
        }
        Etw(data, "registry", operation, resolved.Key, details);
        // A user-handle Close does not delete the shared KCB; only KCBDelete does.
    }
    public void RegistryKcb(RegistryTraceData data, string operation)
    {
        // KCB rundown/name records may have a system PID; they supply identity
        // metadata, not target operations. Never filter them before mapping.
        var payload = RegistryKeyCache.Decode(data.EventData(), data.PointerSize, data.Version);
        var before = registryNames.ResetCount;
#pragma warning disable CS0618
        registryNames.Observe(data.KeyHandle, payload.Name, data.TimeStampQPC, operation == "kcb_delete");
#pragma warning restore CS0618
        if (registryNames.ResetCount != before) Diagnostic("registry_name_map_reset", "warning", "Registry KCB cache reached its 16384-entry/4 MiB bound; evicted names remain unresolved until observed again.");
        if (data.ProcessID == target.Pid)
            Etw(data, "registry", operation, payload.Name, new() { ["registry_key"] = payload.Name,
                ["value_name"] = "", ["key_handle"] = $"0x{data.KeyHandle:x}", ["key_name_resolution"] = "kcb_payload" });
    }
    public void Network(TraceEvent data, string operation, string source, int sourcePort, string destination, int destinationPort, int? bytes)
    {
        if (data.ProcessID != target.Pid) return;
        var details = new Dictionary<string, object?> { ["protocol"] = "tcp", ["source_address"] = source, ["source_port"] = sourcePort,
            ["destination_address"] = destination, ["destination_port"] = destinationPort };
        if (bytes is >= 0) details["bytes"] = bytes;
        Etw(data, "network", operation, $"[{source}]:{sourcePort} → [{destination}]:{destinationPort}", details);
    }
    internal void Add(string kind, string operation, string label, double start, double? duration, int? threadId, Dictionary<string, object?> details, string evidenceId)
    {
        lock (gate)
        {
            if (endQpc is { } end && start > (end - origin) * 1000.0 / Stopwatch.Frequency) { filteredAfterStop++; return; }
            if (events.Count >= MaxEvents) { droppedByLimit++; RequestStop("event_limit"); return; }
            if (stopReason == "byte_limit") { droppedByByteLimit++; return; }
            var nodeKey = $"{kind}\0{operation}\0{label}";
            var newNode = !nodes.TryGetValue(nodeKey, out var node);
            node ??= new($"node_{nodes.Count + 1}", kind, label, target.Name, "unresolved", "executed");
            object? newThread = threadId is { } tid && !threads.ContainsKey(tid) ? new { id = tid, name = $"Thread {tid}", state = "Observed" } : null;
            var eventId = $"event_{events.Count + 1}";
            var result = details.TryGetValue("result", out var resultValue) ? resultValue?.ToString() : null;
            var observedEvent = new MtpEvent(eventId, kind, operation, start, duration, threadId, node.Id, $"{operation}: {label}",
                result == "failure" ? "error" : "observed", result ?? "observed", details, [evidenceId]);
            Dictionary<string, object?>? row = null;
            MtpResource? resource = null;
            string? resourceKey = null;
            var newResource = false;
            if (kind is "file" or "registry" or "network")
            {
                row = new Dictionary<string, object?> { ["id"] = $"io_{io.Count + 1}", ["event_id"] = eventId, ["kind"] = kind, ["type"] = kind,
                    ["operation"] = operation, ["target"] = label, ["start_ms"] = start, ["duration_ms"] = duration, ["status"] = result ?? "observed", ["evidence_ids"] = new[] { evidenceId } };
                var resourceName = kind == "network" ? label : details.GetValueOrDefault(kind == "file" ? "file_path" : "registry_key")?.ToString() ?? "";
                row[kind == "network" ? "endpoint" : "path"] = resourceName;
                if (details.TryGetValue("bytes", out var bytes)) row["bytes"] = bytes;
                // Unknown names do not establish that two events used the same resource.
                if (!string.IsNullOrWhiteSpace(resourceName))
                {
                    resourceKey = $"{kind}\0{resourceName}";
                    newResource = !resources.TryGetValue(resourceKey, out resource);
                    resource ??= new($"resource_{resources.Count + 1}", kind, resourceName, new());
                    row["resource_id"] = resource.Id;
                }
            }
            // Measure compact encoded records before accepting them. Reserve 16 MiB of
            // the runtime's 64 MiB file allowance for <=4*14400 counter samples,
            // evidence, capabilities, metadata and container syntax.
            static int Size(object value) => JsonSerializer.SerializeToUtf8Bytes(value).Length;
            var recordBytes = (long)Size(observedEvent) + 16;
            if (newNode) recordBytes += Size(node) + 1;
            if (newThread is not null) recordBytes += Size(newThread) + 1;
            if (row is not null) recordBytes += Size(row) + 1;
            if (resource is not null) recordBytes += (newResource ? Size(resource) : 0) + Size(eventId) + 2;
            if (encodedRecordBytes + recordBytes > MaxRecordBytes)
            { droppedByByteLimit++; RequestStop("byte_limit"); return; }
            encodedRecordBytes += recordBytes;
            if (newNode) nodes[nodeKey] = node;
            if (newThread is not null) threads[threadId!.Value] = newThread;
            events.Add(observedEvent);
            if (row is not null) io.Add(row);
            if (resource is not null)
            {
                if (newResource) resources[resourceKey!] = resource;
                resource.EventIds.Add(eventId);
            }
            if (evidenceId.StartsWith("ev_etw_", StringComparison.Ordinal)) capabilities[kind] = capabilities[kind] with { Status = "observed", Reason = "Matching target ETW events were received." };
            if (events.Count == MaxEvents) RequestStop("event_limit");
        }
    }
    public void Write(string outputPath)
    {
        lock (gate)
        {
            RequestStop(failed ? "error" : "duration");
            var duration = (endQpc!.Value - origin) * 1000.0 / Stopwatch.Frequency;
            if (eventsLost is > 0) Diagnostic("etw_events_lost", "warning", $"ETW reported {eventsLost} lost events across this system-wide session; affected PIDs are unknown.");
            if (stopReason == "event_limit") Diagnostic("event_limit_reached", "warning", "Capture reached 100000 events and stopped; the requested time window is incomplete.");
            if (stopReason == "byte_limit") Diagnostic("byte_limit_reached", "warning", "Capture reached its 48 MiB encoded-record budget and stopped; the requested time window is incomplete.");
            if (!events.Any(x => x.EvidenceIds.Any(e => e.StartsWith("ev_etw_", StringComparison.Ordinal)))) Diagnostic("no_matching_etw_events", "warning", "No ETW events matched the target; API snapshots do not establish ETW event coverage.");
            Diagnostic("loss_scope", "info", "events_lost is the live session query immediately before stop; losses during final drain are not measurable by this query. ETW loss counts cover all PIDs, not just the target.");
            Diagnostic("observation_scope", "info", "Single PID only; child processes are excluded. File bytes are requested sizes; operation completion latency, file contents, arbitrary values, stacks and causal edges are not collected.");
            var run = new MtpRun(id, $"{target.Name} · Observe", failed ? "failed" : "completed", duration, startedAt, "observe", target,
                new() { ["headline"] = failed ? "Capture failed; partial evidence retained" : "Windows capture completed", ["now"] = "Observed evidence", ["threads"] = threads.Count,
                    ["modules"] = nodes.Values.Where(x => x.Kind == "module").Select(x => x.Label).Distinct().Count(), ["events"] = events.Count }, stopReason!);
            var usedEvidence = events.SelectMany(x => x.EvidenceIds).Concat(counters.Values.SelectMany(x => x.EvidenceIds)).ToHashSet(StringComparer.Ordinal);
            var pendingEvidence = new Queue<string>(usedEvidence);
            while (pendingEvidence.TryDequeue(out var evidenceId))
                if (evidence.TryGetValue(evidenceId, out var entry))
                    foreach (var input in entry.EvidenceIds ?? [])
                        if (usedEvidence.Add(input)) pendingEvidence.Enqueue(input);
            var document = new MtpDocument("0.1", run, nodes.Values.ToArray(), threads.Values.ToArray(), events.OrderBy(x => x.StartMs).ToArray(),
                [], [], evidence.Values.Where(x => x.Truth == "UNAVAILABLE" || usedEvidence.Contains(x.Id)).ToArray(),
                io.OrderBy(x => (double)x["start_ms"]!).ToArray(), [], counters.Values.ToArray(), capabilities.Values.ToArray(), resources.Values.ToArray(), diagnostics.ToArray(),
                new() { ["max_events"] = MaxEvents, ["requested_duration_ms"] = options.DurationSeconds * 1000, ["event_limit_reached"] = stopReason == "event_limit",
                    ["events_dropped_by_limit"] = droppedByLimit, ["events_filtered_after_stop"] = filteredAfterStop, ["events_lost"] = eventsLost,
                    ["max_record_bytes"] = MaxRecordBytes, ["max_output_bytes"] = MaxOutputBytes, ["encoded_record_bytes"] = encodedRecordBytes,
                    ["byte_limit_reached"] = stopReason == "byte_limit", ["events_dropped_by_byte_limit"] = droppedByByteLimit,
                    ["loss_count_scope"] = "system_session_before_stop", ["loss_count_final"] = false, ["counter_interval_ms"] = 250, ["logical_processors"] = Environment.ProcessorCount });
            var path = Path.GetFullPath(outputPath);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + $".{Guid.NewGuid():N}.tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    JsonSerializer.Serialize(stream, document);
                    if (stream.Length > MaxOutputBytes) throw new IOException("Encoded trace exceeded its 64 MiB output safety bound.");
                    stream.Flush(true);
                }
                System.IO.File.Move(temporary, path, true);
            }
            finally { if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary); }
        }
    }
}

internal sealed record CollectorOptions(string Command, int Pid, int DurationSeconds, string OutputPath, string? SessionName = null)
{
    public static void ValidateSessionName(string name)
    {
        const string prefix = "ProgramMicroscope-";
        if (!name.StartsWith(prefix, StringComparison.Ordinal) || name.Length <= prefix.Length || name.Length > 128 ||
            name.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('_' or '-')))
            throw new ArgumentException("Session name must be ProgramMicroscope- followed by ASCII letters, digits, underscore or hyphen, at most 128 characters.");
    }
    public static CollectorOptions Parse(string[] args)
    {
        if (args.Length == 1 && args[0] is "--list-processes" or "--capabilities") return new(args[0] == "--list-processes" ? "list" : "capabilities", 0, 20, "");
        if (args.Length == 2 && args[0] == "--stop-session")
        { ValidateSessionName(args[1]); return new("stop_session", 0, 0, "", args[1]); }
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < args.Length; i += 2)
            if (args[i] is not ("--pid" or "--duration" or "--out") || i + 1 >= args.Length || !values.TryAdd(args[i], args[i + 1])) throw new ArgumentException($"Unknown, duplicate, or incomplete argument: {args[i]}");
        if (!values.TryGetValue("--pid", out var pidText) || !int.TryParse(pidText, NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid <= 0) throw new ArgumentException("--pid must be a positive integer.");
        var duration = 20;
        if (values.TryGetValue("--duration", out var durationText) && (!int.TryParse(durationText, NumberStyles.None, CultureInfo.InvariantCulture, out duration) || duration is < 1 or > 3600)) throw new ArgumentException("--duration must be an integer from 1 to 3600 seconds.");
        var output = values.GetValueOrDefault("--out", "captured.mtp.json");
        if (string.IsNullOrWhiteSpace(output)) throw new ArgumentException("--out must be a file path.");
        return new("capture", pid, duration, output);
    }
}

internal static class ProcessMetadata
{
    public static MtpTarget Read(Process process)
    {
        var name = process.ProcessName;
        var path = "";
        var arch = "unknown";
        var handle = OpenProcess(0x1000, false, process.Id); // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle != IntPtr.Zero)
        {
            try
            {
                var buffer = new StringBuilder(32768);
                var length = buffer.Capacity;
                if (QueryFullProcessImageName(handle, 0, buffer, ref length)) path = buffer.ToString();
                try
                {
                    if (IsWow64Process2(handle, out var processMachine, out var nativeMachine)) arch = (processMachine == 0 ? nativeMachine : processMachine) switch { 0x014c => "x86", 0x8664 => "x64", 0xaa64 => "arm64", 0x01c4 => "arm", _ => "unknown" };
                }
                catch (EntryPointNotFoundException) { /* Older Windows keeps architecture unknown. */ }
            }
            finally { CloseHandle(handle); }
        }
        return new(name, process.Id, path, arch, "Windows");
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}

internal sealed record MtpDocument(
    [property: JsonPropertyName("schema_version")] string SchemaVersion, [property: JsonPropertyName("run")] MtpRun Run,
    [property: JsonPropertyName("nodes")] MtpNode[] Nodes, [property: JsonPropertyName("threads")] object[] Threads,
    [property: JsonPropertyName("events")] MtpEvent[] Events, [property: JsonPropertyName("values")] object[] Values,
    [property: JsonPropertyName("edges")] object[] Edges, [property: JsonPropertyName("evidence")] MtpEvidence[] Evidence,
    [property: JsonPropertyName("io")] Dictionary<string, object?>[] Io, [property: JsonPropertyName("changes")] object[] Changes,
    [property: JsonPropertyName("counters")] MtpCounter[] Counters, [property: JsonPropertyName("capabilities")] MtpCapability[] Capabilities,
    [property: JsonPropertyName("resources")] MtpResource[] Resources, [property: JsonPropertyName("diagnostics")] object[] Diagnostics,
    [property: JsonPropertyName("collection")] Dictionary<string, object?> Collection);
internal sealed record MtpRun([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("status")] string Status, [property: JsonPropertyName("duration_ms")] double DurationMs,
    [property: JsonPropertyName("started_at")] string StartedAt, [property: JsonPropertyName("capture_mode")] string CaptureMode,
    [property: JsonPropertyName("target")] MtpTarget Target, [property: JsonPropertyName("summary")] Dictionary<string, object?> Summary,
    [property: JsonPropertyName("stop_reason")] string StopReason);
internal sealed record MtpTarget([property: JsonPropertyName("name")] string Name, [property: JsonPropertyName("pid")] int Pid,
    [property: JsonPropertyName("path")] string Path, [property: JsonPropertyName("arch")] string Arch, [property: JsonPropertyName("os")] string Os);
internal sealed record MtpNode([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("label")] string Label, [property: JsonPropertyName("module")] string Module,
    [property: JsonPropertyName("source")] string Source, [property: JsonPropertyName("status")] string Status);
internal sealed record MtpEvent([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("phase")] string Phase, [property: JsonPropertyName("start_ms")] double StartMs,
    [property: JsonPropertyName("duration_ms")] double? DurationMs,
    [property: JsonPropertyName("thread_id"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? ThreadId,
    [property: JsonPropertyName("node_id")] string NodeId, [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("status")] string Status, [property: JsonPropertyName("outcome")] string Outcome,
    [property: JsonPropertyName("details")] Dictionary<string, object?> Details, [property: JsonPropertyName("evidence_ids")] string[] EvidenceIds);
internal sealed record MtpEvidence([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("truth")] string Truth,
    [property: JsonPropertyName("source")] string Source, [property: JsonPropertyName("detail")] string Detail,
    [property: JsonPropertyName("evidence_ids"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? EvidenceIds = null);
internal sealed record MtpCapability([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("available")] bool Available,
    [property: JsonPropertyName("status")] string Status, [property: JsonPropertyName("source")] string Source, [property: JsonPropertyName("reason")] string Reason);
internal sealed record MtpCounter([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("unit")] string Unit, [property: JsonPropertyName("samples")] List<MtpSample> Samples,
    [property: JsonPropertyName("evidence_ids")] string[] EvidenceIds);
internal sealed record MtpSample([property: JsonPropertyName("timestamp_ms")] double TimestampMs, [property: JsonPropertyName("value")] double Value);
internal sealed record MtpResource([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("name")] string Name, [property: JsonPropertyName("event_ids")] List<string> EventIds);
