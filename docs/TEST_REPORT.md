# Test report — v0.1 baseline

Date: 2026-09-06  
Environment: Linux sandbox (Python 3.12, Node.js 24); Windows collector build is intended for Windows 11.

## Reference evidence checked

- The Drive file `Dream_Windows_E盘全量部署_详细开发方案_20260906.md` was used only as a reference for the user's Windows machine, low-overhead/Deep Trace choices, evidence truth labels and E-drive deployment expectations.
- The Drive trace `P7_STAGE6_TRACE_FAILURE_20260823_103519.txt` was used only as a reference for trace manifests, SHA-256 integrity, fail-closed provider errors and real-vs-derived data boundaries.
- The public source tree `QuJindai/mllm-windows-ai-workbench` was inspected at commit `df7d8da4c398e05dc54475c656a5638158b1478c`. Its model-specific WPF/H6 UI remains a reference; this repository has no source dependency on it.

## Executed checks

| Check | Result |
| --- | --- |
| `python -m unittest discover -s tests -v` | 8 tests passed |
| `node --check app/app.js` | passed |
| `python -m json.tool` for schema and both fixtures | passed |
| `python -m adapters.perfetto_export` + JSON parse | passed; slices and derived counter preserved |
| In-process HTTP smoke test for `/`, `/api/runs`, `/api/trace/failure`, `/api/summary/failure` | all HTTP 200 |
| Derived network-wait calculation on failure fixture | 65.7% (raw event aggregation) |
| `python tools/package.py` extraction verification | passed; 35 files; SHA-256 recorded in `dist/manifest.json` |

## Windows handoff checks

On the target Windows machine, run the same Python/Node checks, then:

```powershell
dotnet restore collector\windows
dotnet build collector\windows -c Release
dotnet run --project collector\windows -- --pid <PID> --duration 20 --out trace\captured.json
```

The collector is not claimed as hardware-tested in this sandbox because ETW and an actual Windows PID are unavailable here. A provider or permission failure is expected to appear as `UNAVAILABLE` evidence in the output rather than a fabricated event.
