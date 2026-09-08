# Windows Observe collector V0.2

.NET 8 / Microsoft TraceEvent **3.2.6** collector. It records one selected PID; child processes are excluded. Start an elevated Windows PowerShell and run:

```powershell
dotnet build collector/windows/ProgramMicroscope.Collector.csproj -c Release
dotnet collector/windows/bin/Release/net8.0-windows/ProgramMicroscope.Collector.dll --list-processes
dotnet collector/windows/bin/Release/net8.0-windows/ProgramMicroscope.Collector.dll --capabilities
dotnet collector/windows/bin/Release/net8.0-windows/ProgramMicroscope.Collector.dll --pid 8420 --duration 20 --out trace/captured.mtp.json
```

`--list-processes` returns a JSON array of `{pid,name,path,arch,os}`. PID 0 is excluded. Protected or inaccessible executable paths are empty and unmeasured architectures are `unknown`; one inaccessible process does not erase the rest of the list.

`--capabilities` returns `{platform,collector_available,reason,capabilities:[...]}`. This query does not start ETW. Availability means the platform/elevation prerequisite is met; provider startup may still fail. An active capture emits its own enabled/observed/unavailable source states.

The desktop runtime may set `MICROSCOPE_SESSION_NAME` to its unique capture-session name. Names must start with `ProgramMicroscope-`, contain only ASCII letters, digits, underscores and hyphens, and be at most 128 characters. A collision fails without replacing the existing session. After an abnormal collector termination, `--stop-session ProgramMicroscope-NAME` targets only that named session and returns `{stopped,reason}`; an already absent session succeeds. Unrelated session names are rejected.

Capture accepts integer durations **1–3600 seconds** (default 20), retains at most **100000 events**, and stops earlier when encoded event/IO/resource records reach **48 MiB**. Compact JSON leaves room for counters and metadata within the desktop runtime's 64 MiB limit. Unknown, duplicate, missing and out-of-range arguments fail. Once the ETW producer and consumer are ready, stdout prints `READY`. A line `stop` on stdin or Ctrl+C stops the producer, drains pending buffers, then atomically writes the completed MTP result. Closing stdin alone leaves the duration timer active. A target exit also ends capture. Exit codes: 0 completed, 1 collection/output error, 2 invalid arguments or unsupported platform.

## Observed data

| Source | Recorded evidence | Bounds and limitations |
|---|---|---|
| Process/thread/image ETW | Start, stop, load, unload and available rundown records | Single PID filter; missing thread ownership is not guessed |
| Process API startup snapshot | Present process, threads and loaded modules | Explicit `phase: snapshot`; this is not the original start/load time |
| File ETW | Create, read, write, flush, close, delete, rename; resolved names and requested byte sizes | Initiation points; completion duration and contents are uncollected |
| Registry ETW | Create/open/set/query/delete/close; KCB name/rundown metadata; available full key/value names and NTSTATUS | No registry value data; bounded 16384-entry/4 MiB KCB-name cache |
| TCP ETW | IPv4 connect/accept/send/receive/disconnect; IPv6 connect/accept/send/receive | Observed endpoints and transfer sizes; no inferred active-connection count |
| Process API counters | Total CPU milliseconds, normalized delta CPU percentage, working-set bytes, private bytes | Sampled at least 250 ms apart; absent measurements remain absent |

No instructions, local variables, stack traces or causal edges are fabricated. Point events have zero duration; IO operations with no measured duration have `duration_ms: null`. A CPU sample is a measured process API value; CPU percentage is derived from successive CPU/wall-time deltas divided by the logical processor count. No value is synthesized when access fails.

MTP remains `schema_version: "0.1"`. Existing collection fields and `changes`, `counters`, `capabilities`, `resources`, `diagnostics` always serialize as arrays. Counter series have `{id,name,unit,samples:[{timestamp_ms,value}],evidence_ids}`. IO rows link to events/evidence and resolved resources. The `collection` object reports limits, filtered/dropped counts and nullable `events_lost`. Loss is queried from the **live TraceEventSession immediately before stop**, covers the whole system session, and does not claim to count final-drain losses. A capped result identifies `run.stop_reason: "event_limit"` or `"byte_limit"` and incomplete coverage; graceful user stop uses `requested`.

TraceEvent 3.2.6's `RegistryTraceData.Status` implementation discards its decoded return value. The collector decodes the v2+ payload NTSTATUS field at offset 8 directly; unsupported payload versions keep the result unknown. Source references: [kernel parser v3.2.6](https://github.com/microsoft/perfview/blob/v3.2.6/src/TraceEvent/Parsers/KernelTraceEventParser.cs), [session loss/stop APIs v3.2.6](https://github.com/microsoft/perfview/blob/v3.2.6/src/TraceEvent/TraceEventSession.cs).

Registry names are resolved by matching observed KCB addresses from KCBCreate/rundown records. Create/Open may name a child relative to a parent KCB; they do not establish the child's address. Value operations use the child KCB identity. A user-handle Close does not invalidate that shared mapping; KCBDelete does. `details.key_name_resolution` records whether the path came from a KCB, an absolute payload, a parent plus relative payload, or remains unresolved. System-PID KCB metadata is used for identity matching without attributing those operations to the target. [Windows registry ETW event types](https://learn.microsoft.com/en-us/windows/win32/etw/registry) document the KCB naming/rundown records.

## Verification

Storage and CLI behavioral tests run without starting ETW and check the actual 100000-event cap, unknown measurements, references, stop boundaries, failure evidence and atomic JSON writes:

```powershell
dotnet run --project tests/windows/CollectorContracts/ProgramMicroscope.Collector.Contracts.csproj -c Release
```

Real Windows acceptance is a separate test using a triggered probe that performs actual file IO, HKCU registry operations, local TCP traffic and a short-lived thread:

```powershell
dotnet build collector/probe/ProgramMicroscope.Probe.csproj -c Release
pwsh -File tests/windows/test_capture.ps1
```

The harness saves process logs, actual probe observations, complete traces, and an acceptance report. Compilation success is reported separately from Windows ETW runtime success; see [acceptance instructions](../../tests/windows/README.md).
