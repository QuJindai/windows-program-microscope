using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;

// A controlled source of real activity, not a source of trace fixtures. The
// acceptance harness must send "go" only after the ETW collector prints READY.
if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("The acceptance probe can only run on Windows.");
    return 2;
}

if (args.Length != 0 && (args.Length != 2 || args[0] != "--directory"))
{
    Console.Error.WriteLine("Usage: ProgramMicroscope.Probe [--directory <path>]");
    return 2;
}

var token = Guid.NewGuid().ToString("N");
var directory = Path.GetFullPath(args.Length == 2 ? args[1] : Path.GetTempPath());
var filePath = Path.Combine(directory, $"microscope-probe-{token}.bin");
var registrySubkey = $@"Software\ProgramMicroscopeProbe\{token}";
var registryKey = $@"HKEY_CURRENT_USER\{registrySubkey}";
var registryValueName = $"ProbeValue_{token}";
var registryValue = $"Observed_{token}";
var metadata = new Dictionary<string, object?>
{
    ["status"] = "waiting",
    ["pid"] = Environment.ProcessId,
    ["token"] = token,
    ["file_path"] = filePath,
    ["registry_key"] = registryKey,
    ["registry_value_name"] = registryValueName,
    ["registry_value"] = registryValue,
};
Print(metadata);

try
{
    var trigger = await Console.In.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(60));
    if (trigger != "go")
        throw new InvalidOperationException("Expected the explicit 'go' trigger before probe activity.");

    // Touch and retain memory throughout the collection so working-set/private
    // memory samples can be checked against a live process.
    var retainedMemory = new byte[16 * 1024 * 1024];
    for (var i = 0; i < retainedMemory.Length; i += 4096) retainedMemory[i] = 17;

    Directory.CreateDirectory(directory);
    var payload = Enumerable.Range(0, 65536).Select(i => (byte)(i % 251)).ToArray();
    using (var output = new FileStream(filePath, FileMode.CreateNew, FileAccess.Write,
               FileShare.Read, 4096, FileOptions.WriteThrough))
    {
        output.Write(payload);
        output.Flush(flushToDisk: true);
    }
    var readBack = File.ReadAllBytes(filePath);
    if (!payload.AsSpan().SequenceEqual(readBack))
        throw new InvalidOperationException("File readback did not match the bytes written.");
    metadata["file_bytes"] = payload.Length;

    using (var key = Registry.CurrentUser.CreateSubKey(registrySubkey, writable: true))
    {
        key.SetValue(registryValueName, registryValue, RegistryValueKind.String);
        if (!Equals(key.GetValue(registryValueName), registryValue))
            throw new InvalidOperationException("Registry query did not match the value written.");
        key.DeleteValue(registryValueName, throwOnMissingValue: true);
    }
    Registry.CurrentUser.DeleteSubKey(registrySubkey, throwOnMissingSubKey: true);

    using (var listener = new TcpListener(IPAddress.Loopback, 0))
    {
        listener.Start();
        var serverEndpoint = (IPEndPoint)listener.LocalEndpoint;
        using var client = new TcpClient(AddressFamily.InterNetwork);
        await client.ConnectAsync(IPAddress.Loopback, serverEndpoint.Port)
            .WaitAsync(TimeSpan.FromSeconds(10));
        using var server = await listener.AcceptTcpClientAsync()
            .WaitAsync(TimeSpan.FromSeconds(10));
        var clientEndpoint = (IPEndPoint)client.Client.LocalEndPoint!;
        metadata["tcp_server_address"] = serverEndpoint.Address.ToString();
        metadata["tcp_server_port"] = serverEndpoint.Port;
        metadata["tcp_client_address"] = clientEndpoint.Address.ToString();
        metadata["tcp_client_port"] = clientEndpoint.Port;
        var message = payload.AsMemory(0, 8192);
        var received = new byte[message.Length];
        using var ioTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await client.GetStream().WriteAsync(message, ioTimeout.Token);
        await server.GetStream().ReadExactlyAsync(received, ioTimeout.Token);
        if (!message.Span.SequenceEqual(received))
            throw new InvalidOperationException("TCP server payload mismatch.");
        await server.GetStream().WriteAsync(received, ioTimeout.Token);
        await client.GetStream().ReadExactlyAsync(received, ioTimeout.Token);
        if (!message.Span.SequenceEqual(received))
            throw new InvalidOperationException("TCP client payload mismatch.");
        metadata["tcp_bytes"] = message.Length;
    }

    uint threadId = 0;
    double result = 0;
    var worker = new Thread(() =>
    {
        threadId = NativeMethods.GetCurrentThreadId();
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 350)
            for (var i = 1; i < 10000; i++) result += Math.Sqrt(i);
    }) { Name = $"ProbeWorker-{token}", IsBackground = true };
    worker.Start();
    if (!worker.Join(TimeSpan.FromSeconds(10)))
        throw new TimeoutException("The short-lived probe thread did not finish.");
    metadata["thread_id"] = threadId;
    metadata["thread_result"] = result;

    // Force a named module load after the trigger in addition to process/module
    // rundown at collector startup. Do not fabricate a module event on failure.
    var modulePath = Path.Combine(Environment.SystemDirectory, "version.dll");
    var module = NativeMethods.LoadLibraryW(modulePath);
    if (module == IntPtr.Zero)
        throw new InvalidOperationException($"Could not load {modulePath}: {Marshal.GetLastWin32Error()}");
    metadata["module_path"] = modulePath;
    NativeMethods.FreeLibrary(module);

    metadata["status"] = "completed";
    Print(metadata);
    // Remain alive while ETW flushes and counters sample. The harness explicitly
    // releases the process after both the duration and stop-control tests.
    var exit = await Console.In.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(120));
    if (exit != "exit") throw new InvalidOperationException("Expected the 'exit' shutdown command.");
    GC.KeepAlive(retainedMemory);
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine($"PROBE FAILED: {error}");
    return 1;
}
finally
{
    // Registry cleanup also runs after a partially completed operation.
    try { Registry.CurrentUser.DeleteSubKeyTree(registrySubkey, throwOnMissingSubKey: false); }
    catch (Exception error) { Console.Error.WriteLine($"Probe registry cleanup: {error.Message}"); }
}

static void Print(object value)
{
    Console.WriteLine(JsonSerializer.Serialize(value));
    Console.Out.Flush();
}

internal static class NativeMethods
{
    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr LoadLibraryW(string path);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool FreeLibrary(IntPtr module);
}
