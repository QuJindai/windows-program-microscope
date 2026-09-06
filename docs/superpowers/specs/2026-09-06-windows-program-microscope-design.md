# Windows Program Microscope — design baseline

Date: 2026-09-06  
Status: approved baseline for v0.1 implementation

## Decision

Build an independent Windows GUI workbench whose primary abstraction is a person selecting a moment in a program run. Every lens is a different view of the same trace, not a separate tool.

## Architecture

```text
Windows process
    │
    ├─ Observe: ETW collector (low overhead)
    ├─ Deep Trace: debugger/instrumentation adapter (opt-in)
    └─ Time Travel: recorder/replayer (opt-in, future)
    │
    ▼
MTP trace (Run, Node, Invocation, Event, Value, Edge, Evidence)
    │
    ├─ summary / wait attribution
    ├─ flow and timeline projections
    ├─ provenance and first-divergence analysis
    └─ optional Perfetto export
    │
    ▼
GUI lenses + shared inspector + persistent timeline
```

## Why this is a hybrid

The product combines the human interaction ideas of time-travel debuggers with ETW's low-overhead system view, Perfetto's trace vocabulary, and node-graph navigation. None of those projects is embedded as the product or treated as a source of truth. The adapter boundary keeps licenses and failure modes explicit.

## Non-goals for v0.1

- no coupling to Dream, mobile harnesses or another model workbench;
- no silent DLL injection or system-wide capture by default;
- no AI chat that invents explanations;
- no claim that a provider captured data when the evidence is missing;
- no cross-platform collector abstraction that hides Windows-specific capabilities.

## Approval assumption

The earlier “ok” approved the independent Windows/GUI-first direction. The current continuation request authorizes implementing this baseline, including a public repository, fixtures, tests and a portable source package.

