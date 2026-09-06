# Windows Observe collector

This adapter is intentionally small and experimental. It uses the MIT-licensed Microsoft TraceEvent package to start a kernel ETW session scoped to one PID and records process, thread and image-load events into MTP JSON.

Build and run from an elevated Windows Developer PowerShell:

```powershell
dotnet restore
dotnet run -- --pid 8420 --duration 20 --out ..\..\trace\captured.json
```

The target must remain alive for the capture window. ETW permissions, provider availability and empty PID matches are represented as `UNAVAILABLE` evidence. This collector does not claim file, registry, network or function-level data yet; those are separate adapters in the development plan.

