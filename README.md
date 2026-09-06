# Program Microscope for Windows

**A GUI-first, evidence-grounded microscope for understanding what a Windows program actually did.**

This repository is intentionally independent. It does not depend on the user's other projects or on any model-specific workbench. The first release is a runnable desktop-style web UI and a Windows ETW collector adapter that share one small, explicit trace format (MTP: Microscope Trace Protocol).

## What a person can ask

- What is the program doing right now?
- What happened after I clicked a button?
- Where did the longest wait go?
- Which file, registry key, network endpoint, DLL or child process changed the machine?
- What was the first difference between a normal run and a failed run?
- Where did this value come from?

The six lenses keep those questions connected rather than splitting them into unrelated tools:

| Lens | Human question |
| --- | --- |
| Overview | What is happening now? |
| Timeline | When did it happen? |
| Flow | Which route did the program actually take? |
| State | What was the internal state at that moment? |
| I/O | What did it do to the Windows world? |
| Compare | Why was this run different? |

The execution timeline remains visible at the bottom of every lens. Selecting an event updates the other lenses and the evidence inspector.

## Run the prototype

The prototype uses only the Python standard library and a browser. It works on Windows, macOS and Linux for UI review; the collector is Windows-only.

```powershell
cd windows-program-microscope
py tools\serve.py
```

Open <http://127.0.0.1:8765>. Use **Run A · Normal** and **Run B · Failed** to inspect the built-in evidence, or start a synthetic capture from the Capture screen.

The same UI is ready to be wrapped as a Windows desktop executable with Tauri 2 (Node.js and Rust are only needed for that packaging path):

```powershell
npm install
npm run tauri build
```

Run the contract tests:

```powershell
py -m unittest discover -s tests -v
```

Create and verify a portable source package:

```powershell
py tools\package.py
```

## Windows collector (experimental v0.1)

`collector/windows` contains a .NET 8 console adapter built around Microsoft's TraceEvent ETW parser. It records process, thread and image-load events for a selected PID and writes an MTP JSON file. Run it from an elevated Developer PowerShell on Windows:

```powershell
dotnet run --project collector\windows -- --pid 8420 --duration 20 --out trace\captured.json
```

The collector is deliberately fail-closed: if a provider or permission is unavailable it reports the limitation in `evidence` instead of inventing values. File, registry, network and deep function/state capture are separate adapters and are not silently claimed by Observe mode.

## Open-source integration boundary

The hybrid design borrows proven ideas through adapters, not by forking another product into this repository:

- **KrabsETW** or **TraceEvent** for Windows ETW collection/parsing.
- **Perfetto** as an optional trace export and SQL analysis target.
- **Detours** only for explicitly selected deep API instrumentation.
- **React Flow / xyflow** as a future Flow-lens renderer when the UI graduates from the zero-dependency prototype.
- **Tracy** as an optional instrumentation source for applications that already emit Tracy telemetry.

See [`docs/OPEN_SOURCE_INTEGRATION.md`](docs/OPEN_SOURCE_INTEGRATION.md) for licenses, why each project is used, and what remains intentionally out of scope.

## Status

This is the first independent public baseline: GUI interaction loop, MTP fixtures, provenance/first-divergence analysis, Windows collector adapter, tests, and packaging are included. Symbol-server integration, DbgEng time travel, registry providers, Perfetto export and signed installers are planned work, not hidden promises.
