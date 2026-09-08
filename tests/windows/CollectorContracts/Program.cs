using System.Text.Json;
using System.Buffers.Binary;
using System.Text;

// Behavioral contract tests deliberately inject test records into the bounded store.
// They test storage/CLI semantics and are not evidence that Windows ETW ran.
var passed = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
    passed++;
}
foreach (var argsToReject in new[] {
    Array.Empty<string>(), new[] { "--pid", "0" }, new[] { "--pid", "5", "--duration", "0" },
    new[] { "--pid", "5", "--duration", "3601" }, new[] { "--pid", "5", "--pid", "6" },
    new[] { "--list-processes", "--pid", "1" }, new[] { "--pid", "5", "--out" },
    new[] { "--pid", "5", "--duration", "1.5" }, new[] { "--stop-session", "NT Kernel Logger" },
    new[] { "--stop-session", "ProgramMicroscope-" }, new[] { "--stop-session", "ProgramMicroscope-/invalid" } })
{
    var rejected = false;
    try { CollectorOptions.Parse(argsToReject); } catch (ArgumentException) { rejected = true; }
    Check(rejected, $"Invalid CLI accepted: {string.Join(' ', argsToReject)}");
}
Check(CollectorOptions.Parse(["--pid", "7", "--out", "空 格.mtp.json"]).OutputPath == "空 格.mtp.json", "Output path must be preserved.");
Check(CollectorOptions.Parse(["--capabilities"]).Command == "capabilities", "Capabilities command missing.");
Check(CollectorOptions.Parse(["--stop-session", "ProgramMicroscope-contract_1"]).Command == "stop_session", "Scoped cleanup command missing.");
// Regression from Windows CI: Create used parent KCB 0xffffa9003b287a40,
// while Set/QueryValue used child KCB 0xffffa9003b2841d0. Relative Open/Create
// records must never overwrite the parent's identity or invent the child's.
var registry = new RegistryKeyCache();
const ulong parentKcb = 0xffffa9003b287a40;
const ulong childKcb = 0xffffa9003b2841d0;
const string parentKey = @"\REGISTRY\USER\test-sid\Software\ProgramMicroscopeProbe";
const string childName = "test-probe-token";
var fullKey = parentKey + "\\" + childName;
registry.Observe(parentKcb, parentKey, 10);
Check(registry.Resolve(parentKcb, "create", childName, 11).Key == fullKey, "Create must resolve relative name against observed parent KCB.");
Check(registry.Resolve(childKcb, "set_value", "ProbeValue_test", 12).Key == "", "Create's parent address does not identify the child KCB.");
registry.Observe(childKcb, fullKey, 20);
Check(registry.Resolve(childKcb, "set_value", "ProbeValue_test", 19).Key == "", "Future KCB metadata must not be attributed to an earlier operation.");
Check(registry.Resolve(childKcb, "set_value", "ProbeValue_test", 21).Key == fullKey, "SetValue must resolve the full path from the child KCB.");
Check(registry.Resolve(childKcb, "query_value", "ProbeValue_test", 22).Key == fullKey, "QueryValue must retain the same child KCB identity.");
registry.Resolve(childKcb, "close", "", 23);
Check(registry.Resolve(childKcb, "query_value", "ProbeValue_test", 24).Key == fullKey, "Closing one user handle must not destroy a shared KCB name.");
registry.Resolve(parentKcb, "open", "AnotherChild", 25);
Check(registry.Resolve(parentKcb, "query_value", "Value", 26).Key == parentKey, "Relative Open must not overwrite the parent's path.");
registry.Observe(childKcb, "", 27, deleted: true);
Check(registry.Resolve(childKcb, "query_value", "ProbeValue_test", 28).Key == "", "KCBDelete must invalidate the address before reuse.");
Check(registry.Resolve(0, "open", @"\REGISTRY\MACHINE\absolute", 30).Resolution == "payload_absolute", "Absolute registry names must survive missing parent identity.");
for (var i = 1; i <= RegistryKeyCache.MaxEntries + 1; i++) registry.Observe((ulong)i, "\\REGISTRY\\MACHINE\\test" + i, i);
Check(registry.Count <= RegistryKeyCache.MaxEntries && registry.ResetCount > 0, "System-wide KCB metadata cache must stay bounded.");
foreach (var pointerSize in new[] { 4, 8 })
{
    var text = Encoding.Unicode.GetBytes("ProbeValue_test\0");
    var payload = new byte[16 + pointerSize + text.Length];
    BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(8, 4), 0xc0000034);
    text.CopyTo(payload, 16 + pointerSize);
    var decoded = RegistryKeyCache.Decode(payload, pointerSize, 2);
    Check(decoded.Name == "ProbeValue_test" && decoded.Status == 0xc0000034, "Registry v2 payload must preserve actual name and failure status for both pointer sizes.");
    Check(RegistryKeyCache.Decode(payload, pointerSize, 1).Status is null, "Unsupported registry payload version must remain unknown.");
}
var folder = Path.Combine(Path.GetTempPath(), "microscope-contract-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(folder);
try
{
    var path = Path.Combine(folder, "bounded.json");
    var state = new CaptureState(new("capture", 7, 20, path), new("test-only", 7, "test-only.exe", "unknown", "Windows"));
    for (var i = 0; i < CaptureState.MaxEvents + 10; i++)
        state.Add("process", "test_only", "test-only", 0, null, null, new(), "ev_etw_process");
    Check(state.StopReason == "event_limit", "Storage did not stop at the bound.");
    state.Write(path);
    using (var json = JsonDocument.Parse(File.ReadAllText(path)))
    {
        var root = json.RootElement;
        Check(root.GetProperty("events").GetArrayLength() == CaptureState.MaxEvents, "Event limit failed.");
        Check(root.GetProperty("io").GetArrayLength() == 0, "Process records must not fabricate I/O.");
        Check(root.GetProperty("collection").GetProperty("events_dropped_by_limit").GetInt32() == 10, "Dropped-by-limit count must be measured.");
        Check(root.GetProperty("collection").GetProperty("events_lost").ValueKind == JsonValueKind.Null, "Unqueried ETW loss must remain unknown.");
        Check(root.GetProperty("events")[0].GetProperty("duration_ms").ValueKind == JsonValueKind.Null, "Unknown operation duration was fabricated.");
        Check(!root.GetProperty("events")[0].TryGetProperty("thread_id", out _), "Unknown thread was fabricated.");
        foreach (var key in new[] { "nodes", "threads", "events", "values", "edges", "evidence", "io", "changes", "counters", "capabilities", "resources", "diagnostics" })
            Check(root.GetProperty(key).ValueKind == JsonValueKind.Array, $"{key} must always be an array.");
        Check(root.GetProperty("counters").GetArrayLength() == 0, "Unsampled counters must remain empty.");
        Check(root.GetProperty("edges").GetArrayLength() == 0, "Event order must not imply causality.");
        Check(root.GetProperty("resources").GetArrayLength() == 0, "Process records must not fabricate resources.");
    }
    var byteBounded = new CaptureState(new("capture", 7, 20, path), new("test-only", 7, "", "unknown", "Windows"));
    for (var i = 0; i < CaptureState.MaxEvents && byteBounded.StopReason is null; i++)
    {
        var resourcePath = "test-only-" + i + new string('x', 8192);
        byteBounded.Add("file", "read", resourcePath, 0, null, null, new() { ["file_path"] = resourcePath }, "ev_etw_file");
    }
    Check(byteBounded.StopReason == "byte_limit", "Large records must trigger the byte budget before exhausting event count.");
    byteBounded.Write(path);
    Check(new FileInfo(path).Length <= CaptureState.MaxOutputBytes, "Trace exceeds runtime's bounded read allowance.");
    using (var json = JsonDocument.Parse(File.ReadAllText(path)))
    {
        var root = json.RootElement;
        Check(root.GetProperty("events").GetArrayLength() == root.GetProperty("io").GetArrayLength(), "Byte budget left missing I/O event references.");
        Check(root.GetProperty("events").GetArrayLength() == root.GetProperty("resources").GetArrayLength(), "Rejected large record leaked resource metadata.");
        Check(root.GetProperty("collection").GetProperty("byte_limit_reached").GetBoolean(), "Byte limit must be disclosed.");
        Check(root.GetProperty("events")[0].GetProperty("duration_ms").ValueKind == JsonValueKind.Null, "Unknown I/O duration must remain null.");
    }
    var stopped = new CaptureState(new("capture", 7, 20, path), new("test-only", 7, "", "unknown", "Windows"));
    stopped.RequestStop("requested");
    stopped.Add("file", "read", "late", 1e9, null, null, new(), "ev_etw_file");
    stopped.Write(path); // Replacing an existing result is atomic and leaves no temp file.
    using (var json = JsonDocument.Parse(File.ReadAllText(path)))
    {
        Check(json.RootElement.GetProperty("events").GetArrayLength() == 0, "Post-stop record must be filtered.");
        Check(json.RootElement.GetProperty("run").GetProperty("status").GetString() == "completed", "Graceful stop must complete.");
        Check(json.RootElement.GetProperty("run").GetProperty("stop_reason").GetString() == "requested", "Requested stop reason lost.");
    }
    Check(Directory.GetFiles(folder, "*.tmp").Length == 0, "Atomic write leaked temporary file.");
    var failure = new CaptureState(new("capture", 7, 20, path), new("test-only", 7, "", "unknown", "Windows"));
    failure.Fail("test_failure", "Synthetic failure used only in contract test.");
    failure.ProvidersUnavailable("Synthetic test failure.");
    failure.Write(path);
    using (var json = JsonDocument.Parse(File.ReadAllText(path)))
    {
        Check(json.RootElement.GetProperty("run").GetProperty("status").GetString() == "failed", "Failure must persist failed status.");
        Check(json.RootElement.GetProperty("evidence")[0].GetProperty("truth").GetString() == "UNAVAILABLE", "Failure evidence must say unavailable.");
        Check(json.RootElement.GetProperty("capabilities").EnumerateArray().All(x => !x.GetProperty("available").GetBoolean()), "Unsampled/failed capability must not claim availability.");
    }
}
finally { Directory.Delete(folder, true); }
Console.WriteLine($"Collector storage/CLI contracts: {passed} assertions passed. Windows ETW runtime is a separate acceptance test.");
