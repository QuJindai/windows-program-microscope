# Development plan

## Product boundary

Program Microscope is a standalone Windows desktop product. The GUI is the product; collectors and analysis exist to make visible answers trustworthy. It does not share runtime code, schemas or release artifacts with the user's other applications.

## Milestones

### M0 — Evidence-first prototype (this release)

- Freeze the six-lens GUI and persistent timeline.
- Define MTP v0.1 with explicit `REAL`, `DERIVED`, `UNAVAILABLE` and `DEBUG_ONLY` evidence states.
- Provide normal/failed fixtures, value provenance and first-divergence analysis.
- Provide a zero-dependency browser prototype and a Windows ETW Observe adapter.
- Add contract tests and a reproducible source package.

### M1 — Observe mode on Windows

- Process/thread/image-load ETW session with PID scoping.
- File I/O, TCP/IP, registry and window-message providers behind capability checks.
- Ring-buffer capture, redaction and cancellation.
- Replace fixture overview with live event stream while keeping the same GUI contract.

### M2 — Deep Trace

- Optional function and stack capture using documented Windows debugging interfaces.
- Symbol resolution through DIA/symbol paths, with unresolved frames marked explicitly.
- Selected-value watchpoints and bounded memory snapshots.
- “Trace value origin” links from State, Flow and Compare to shared evidence.

### M3 — Compare and export

- Stable event alignment and first-divergence explanations for repeated runs.
- Perfetto export adapter (slices, counters, flows, tracks).
- JSON/CSV evidence export and a shareable read-only report.

### M4 — Time Travel (opt-in)

- A separate recorder/replayer with clear overhead and disk estimates.
- Historical value navigation and replay validation.
- No default instrumentation: the user chooses the cost before capture starts.

## Definition of done for every milestone

1. A visible GUI action has a corresponding trace contract.
2. Every displayed number is labelled as real, derived or unavailable.
3. A failing provider produces an honest limitation card and a useful partial trace.
4. A fixture test covers the happy path and the first likely failure.
5. The source package can be extracted and its tests can be rerun on a clean Windows machine.

