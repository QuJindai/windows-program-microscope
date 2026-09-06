# Open-source integration map

The following projects were checked as candidates for the independent Windows product. We use their ideas through narrow adapters and keep their licenses and notices separate.

| Project | License / role | Planned integration | Boundary |
| --- | --- | --- | --- |
| [KrabsETW](https://github.com/microsoft/krabsetw) | Microsoft ETW C++/.NET wrappers | Native Observe collector for providers that need a low-level wrapper | Optional adapter; no copied product UI |
| [TraceEvent / PerfView](https://github.com/microsoft/perfview) | MIT .NET ETW parser | Fast path for parsing process/thread/image events and later stacks | Collector package reference only; MTP remains ours |
| [Perfetto](https://github.com/google/perfetto) | Apache-2.0 | Implemented dependency-free JSON export of slices and derived counters; protobuf/SQL export remains next | Export/analysis target, not the primary GUI |
| [Detours](https://github.com/microsoft/Detours) | MIT | Deep Trace for a user-selected API surface | Never enabled by Observe; explicit consent and scope |
| [xyflow](https://github.com/xyflow/xyflow) | MIT | Replace the prototype Flow renderer when a React desktop shell is introduced | UI dependency only; no data-model dependency |
| [Tracy](https://github.com/wolfpld/tracy) | BSD-style | Optional ingestion of app-emitted telemetry for CPU/lock/GPU detail | Supplementary source; not a Windows system collector |

Microsoft's Windows Performance Toolkit and debugger interfaces remain external system tools. We may interoperate with their trace formats or APIs, but we do not redistribute proprietary binaries in this repository.

## License hygiene

- The repository's own code is MIT.
- Third-party packages are referenced by URL and package metadata; they are not vendored in v0.1.
- If a future release vendors headers or binaries, it must add the upstream license and a generated NOTICE file before packaging.
- MTP's `evidence.truth` field prevents a permissive license from becoming permission to claim data that was not captured.
