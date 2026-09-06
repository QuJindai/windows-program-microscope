using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Session;

// Experimental Windows Observe adapter. It intentionally writes the same
// evidence vocabulary as the browser fixtures and refuses to claim providers
// that were not enabled successfully.
if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("The Windows collector can only run on Windows.");
    return 2;
}

var options = CollectorOptions.Parse(args);
if (options.Pid <= 0)
{
    Console.Error.WriteLine("Usage: --pid <process id> [--duration <seconds>] [--out <file>]");
    return 2;
}

var process = Process.GetProcessById(options.Pid);
var started = Stopwatch.StartNew();
var events = new List<MtpEvent>();
var evidence = new List<MtpEvidence>
{
    new("ev_process", "REAL", "ETW process/thread provider", "Process and thread timestamps"),
};
var nodes = new Dictionary<string, MtpNode>(StringComparer.Ordinal);
var threads = new Dictionary<int, MtpThread>();
var sessionName = $"ProgramMicroscope-{Environment.ProcessId}-{Guid.NewGuid():N}";

using var session = new TraceEventSession(sessionName);
session.StopOnDispose = true;
try
{
    session.EnableKernelProvider(KernelTraceEventParser.Keywords.Process |
                                KernelTraceEventParser.Keywords.Thread |
                                KernelTraceEventParser.Keywords.ImageLoad);
}
catch (Exception error)
{
    evidence.Add(new("ev_provider", "UNAVAILABLE", "ETW session", $"Kernel provider could not be enabled: {error.Message}"));
    WriteTrace(options, process, events, nodes.Values, threads.Values, evidence, started.ElapsedMilliseconds);
    return 1;
}

void AddEvent(TraceEvent data, string kind, string label, string nodeKind)
{
    if (data.ProcessID != options.Pid) return;
    var start = Math.Max(0, (long)Math.Round(data.TimeStampRelativeMSec));
    var nodeId = $"{nodeKind.ToLowerInvariant()}_{label.ToLowerInvariant().Replace(' ', '_')}";
    nodes.TryAdd(nodeId, new MtpNode(nodeId, nodeKind, label, data.ProcessName ?? process.ProcessName, "unresolved", "executed"));
    var threadId = data.ThreadID;
    threads.TryAdd(threadId, new MtpThread(threadId, $"Thread {threadId}", "Running", 0));
    events.Add(new MtpEvent(
        $"etw_{events.Count + 1}", kind, label, start, 0, threadId, nodeId,
        label, "ok", "observed", new Dictionary<string, object?>(), new[] { "ev_process" }));
}

session.Source.Kernel.ProcessStart += data => AddEvent(data, "process", "Process start", "process");
session.Source.Kernel.ProcessStop += data => AddEvent(data, "process", "Process stop", "process");
session.Source.Kernel.ThreadStart += data => AddEvent(data, "thread", "Thread start", "thread");
session.Source.Kernel.ImageLoad += data => AddEvent(data, "module", "Image load", "module");

using var stopTimer = new Timer(_ => session.Source.StopProcessing(), null, options.DurationSeconds * 1000, Timeout.Infinite);
try
{
    session.Source.Process();
}
catch (Exception error)
{
    evidence.Add(new("ev_consumer", "UNAVAILABLE", "ETW consumer", $"Trace stopped: {error.Message}"));
}

if (events.Count == 0)
{
    evidence.Add(new("ev_empty", "UNAVAILABLE", "ETW process filter", "No events matched the selected PID; check elevation and lifetime."));
}

WriteTrace(options, process, events, nodes.Values, threads.Values, evidence, Math.Max(started.ElapsedMilliseconds, 1));
return 0;

static void WriteTrace(CollectorOptions options, Process process, List<MtpEvent> events, IEnumerable<MtpNode> nodes, IEnumerable<MtpThread> threads, List<MtpEvidence> evidence, long durationMs)
{
    var targetPath = "unresolved";
    try
    {
        targetPath = process.MainModule?.FileName ?? targetPath;
    }
    catch (Exception error)
    {
        evidence.Add(new("ev_target_path", "UNAVAILABLE", "Process access", $"Executable path unavailable: {error.Message}"));
    }
    var document = new MtpDocument(
        "0.1",
        new MtpRun("captured", $"{process.ProcessName} · Observe", "completed", durationMs,
            "observe", new MtpTarget(process.ProcessName, process.Id, targetPath, "x64", "Windows"),
            new Dictionary<string, object?> { ["headline"] = "ETW capture completed", ["now"] = "Observed process events", ["threads"] = threads.Count(), ["modules"] = nodes.Count(n => n.Kind == "module"), ["exceptions"] = 0 }),
        nodes.ToArray(), threads.ToArray(), events.OrderBy(e => e.StartMs).ToArray(), Array.Empty<object>(), Array.Empty<object>(), evidence.ToArray(), Array.Empty<object>());
    var json = JsonSerializer.Serialize(document, new JsonSerializerOptions { WriteIndented = true });
    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(options.OutputPath))!);
    File.WriteAllText(options.OutputPath, json);
    Console.WriteLine($"Wrote {events.Count} events to {options.OutputPath}");
}

internal sealed record CollectorOptions(int Pid, int DurationSeconds, string OutputPath)
{
    public static CollectorOptions Parse(string[] args)
    {
        var pid = ReadInt(args, "--pid", 0);
        var duration = Math.Clamp(ReadInt(args, "--duration", 20), 1, 3600);
        var output = ReadString(args, "--out", "trace/captured.json");
        return new(pid, duration, output);
    }

    private static int ReadInt(string[] args, string key, int fallback)
    {
        var index = Array.IndexOf(args, key);
        return index >= 0 && index + 1 < args.Length && int.TryParse(args[index + 1], out var value) ? value : fallback;
    }

    private static string ReadString(string[] args, string key, string fallback)
    {
        var index = Array.IndexOf(args, key);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : fallback;
    }
}

internal sealed record MtpDocument(
    [property: JsonPropertyName("schema_version")] string SchemaVersion,
    [property: JsonPropertyName("run")] MtpRun Run,
    [property: JsonPropertyName("nodes")] MtpNode[] Nodes,
    [property: JsonPropertyName("threads")] MtpThread[] Threads,
    [property: JsonPropertyName("events")] MtpEvent[] Events,
    [property: JsonPropertyName("values")] object[] Values,
    [property: JsonPropertyName("edges")] object[] Edges,
    [property: JsonPropertyName("evidence")] MtpEvidence[] Evidence,
    [property: JsonPropertyName("io")] object[] Io);

internal sealed record MtpRun(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("duration_ms")] long DurationMs,
    [property: JsonPropertyName("capture_mode")] string CaptureMode,
    [property: JsonPropertyName("target")] MtpTarget Target,
    [property: JsonPropertyName("summary")] Dictionary<string, object?> Summary);
internal sealed record MtpTarget(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("pid")] int Pid,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("arch")] string Arch,
    [property: JsonPropertyName("os")] string Os);
internal sealed record MtpNode(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("module")] string Module,
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("status")] string Status);
internal sealed record MtpThread(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("cpu_ms")] long CpuMs);
internal sealed record MtpEvent(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("phase")] string Phase,
    [property: JsonPropertyName("start_ms")] long StartMs,
    [property: JsonPropertyName("duration_ms")] long DurationMs,
    [property: JsonPropertyName("thread_id")] int ThreadId,
    [property: JsonPropertyName("node_id")] string NodeId,
    [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("outcome")] string Outcome,
    [property: JsonPropertyName("details")] Dictionary<string, object?> Details,
    [property: JsonPropertyName("evidence_ids")] string[] EvidenceIds);
internal sealed record MtpEvidence(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("truth")] string Truth,
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("detail")] string Detail);
