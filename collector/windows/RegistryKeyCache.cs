using System.Buffers.Binary;
using System.Text;

// Registry operation handles are KCB addresses. In Open/Create they may identify
// the parent of the relative payload name; SetValue identifies the resulting key.
// Only KCB lifecycle records establish the address-to-full-name mapping.
internal sealed class RegistryKeyCache
{
    internal const int MaxEntries = 16384;
    internal const int MaxNameBytes = 4 * 1024 * 1024;
    private readonly Dictionary<ulong, Entry> entries = new();
    private int nameBytes;
    internal int ResetCount { get; private set; }
    internal int Count => entries.Count;
    internal void Observe(ulong address, string fullName, long timestamp, bool deleted = false)
    {
        if (address == 0) return;
        if (entries.TryGetValue(address, out var current) && current.Timestamp > timestamp) return;
        if (deleted)
        {
            if (entries.Remove(address, out var removed)) nameBytes -= removed.Name.Length * 2;
            return;
        }
        if (!fullName.StartsWith('\\') || fullName.Length * 2 > MaxNameBytes) return;
        if (entries.Remove(address, out var old)) nameBytes -= old.Name.Length * 2;
        if (entries.Count >= MaxEntries || nameBytes + fullName.Length * 2 > MaxNameBytes)
        { entries.Clear(); nameBytes = 0; ResetCount++; }
        entries[address] = new(fullName, timestamp);
        nameBytes += fullName.Length * 2;
    }
    internal (string Key, string Resolution) Resolve(ulong address, string operation, string rawName, long timestamp)
    {
        if (operation is "open" or "create")
        {
            if (rawName.StartsWith('\\')) return (rawName, "payload_absolute");
            if (entries.TryGetValue(address, out var parent) && parent.Timestamp <= timestamp)
                return (string.IsNullOrEmpty(rawName) ? parent.Name : parent.Name.TrimEnd('\\') + "\\" + rawName.TrimStart('\\'), "kcb_parent_and_relative_payload");
            return (rawName, string.IsNullOrEmpty(rawName) ? "unresolved" : "payload_relative_only");
        }
        if (entries.TryGetValue(address, out var key) && key.Timestamp <= timestamp) return (key.Name, "kcb");
        if (operation == "delete" && rawName.StartsWith('\\')) return (rawName, "payload_absolute");
        return ("", "unresolved");
    }
    // Version 2 payload: InitialTime(8), NTSTATUS(4), Index(4), pointer-sized KCB,
    // then UTF-16 name. This also avoids TraceEvent 3.2.6's broken Status getter.
    internal static (string Name, uint? Status) Decode(byte[] payload, int pointerSize, int version)
    {
        if (version < 2 || pointerSize is not (4 or 8) || payload.Length < 16 + pointerSize) return ("", null);
        var bytes = payload.AsSpan(16 + pointerSize);
        var length = bytes.Length - bytes.Length % 2;
        for (var i = 0; i < length; i += 2)
            if (bytes[i] == 0 && bytes[i + 1] == 0) { length = i; break; }
        return (Encoding.Unicode.GetString(bytes[..length]), BinaryPrimitives.ReadUInt32LittleEndian(payload.AsSpan(8, 4)));
    }
    private sealed record Entry(string Name, long Timestamp);
}
