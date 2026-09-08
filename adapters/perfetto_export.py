"""Export measured MTP events to Perfetto/Chrome JSON with evidence metadata."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
from typing import Any

# Support both `python -m adapters.perfetto_export` and the documented direct CLI.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analysis.trace_engine import summarize, validate_trace


def _number(value: Any) -> bool:
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def _numeric_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and 0 <= value <= 9007199254740991:
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit():
        digits = value.lstrip("0") or "0"
        if len(digits) <= 16 and int(digits) <= 9007199254740991:
            return int(digits)
    return None


def to_perfetto(trace: dict[str, Any]) -> dict[str, Any]:
    """Preserve unknown duration as an instant and emit only explicit causal flows."""
    errors = validate_trace(trace)
    if errors:
        raise ValueError(f"Invalid MTP trace: {'; '.join(errors)}")
    run = trace.get("run", {})
    target = run.get("target", {})
    pid = _numeric_id(target.get("pid")) or 0
    output: list[dict[str, Any]] = []
    threads = trace.get("threads", [])
    events = trace.get("events", [])
    raw_ids = [thread.get("id") for thread in threads] + [event.get("thread_id") for event in events]
    raw_ids += [counter.get("thread_id") for counter in trace.get("counters", [])]
    reserved = {value for raw in raw_ids if (value := _numeric_id(raw)) is not None}
    reserved.add(0)
    tids = {}
    next_tid = 1
    for raw in raw_ids:
        if raw is None or str(raw) in tids:
            continue
        numeric = _numeric_id(raw)
        if numeric is None:
            while next_tid in reserved:
                next_tid += 1
            numeric = next_tid
            reserved.add(numeric)
        tids[str(raw)] = numeric

    def tid(raw: Any) -> int:
        return tids.get(str(raw), 0) if raw is not None else 0

    output.append({"name": "process_name", "ph": "M", "pid": pid, "tid": 0,
                   "args": {"name": target.get("name") or run.get("name") or "MTP process"}})
    for thread in threads:
        output.append({"name": "thread_name", "ph": "M", "pid": pid, "tid": tid(thread.get("id")),
                       "args": {"name": thread.get("name") or str(thread.get("id"))}})
    for event in events:
        duration = event.get("duration_ms")
        observed = _number(duration) and duration >= 0 and event.get("duration_observed") is not False
        row = {"name": event.get("label", event.get("id", "event")),
               "cat": f"microscope.{event.get('kind', 'event')}", "ph": "X" if observed else "i",
               "ts": float(event.get("start_ms", 0)) * 1000, "pid": pid, "tid": tid(event.get("thread_id")),
               "args": {"mtp_id": event.get("id"), "phase": event.get("phase"), "outcome": event.get("outcome"),
                        "status": event.get("status", "ok"), "evidence_ids": event.get("evidence_ids", []),
                        "duration_observed": observed, "details": event.get("details", {})}}
        if observed:
            row["dur"] = float(duration) * 1000
        else:
            row["s"] = "t"
        output.append(row)

    for counter in trace.get("counters", []):
        for sample in counter.get("samples", []):
            if not _number(sample.get("timestamp_ms")) or not _number(sample.get("value")):
                continue
            output.append({"name": counter.get("name", counter.get("id", "counter")), "cat": "microscope.counter", "ph": "C",
                           "ts": float(sample["timestamp_ms"]) * 1000, "pid": pid, "tid": tid(counter.get("thread_id")), "id": counter.get("id"),
                           "args": {"value": sample["value"]}})

    derived = []
    summary = summarize(trace)
    if summary["network_wait_truth"] == "DERIVED":
        evidence_ids = list(dict.fromkeys(evidence_id for item in trace.get("io", [])
                                         if item.get("type", item.get("kind")) == "network"
                                         for evidence_id in item.get("evidence_ids", [])))
        derived.append({"id": "network_wait_ms", "name": "network_wait_ms", "truth": "DERIVED", "unit": "ms", "evidence_ids": evidence_ids})
        output.append({"name": "network_wait_ms", "cat": "microscope.derived", "ph": "C",
                       "ts": float(run["duration_ms"]) * 1000, "pid": pid, "tid": 0,
                       "args": {"value": summary["network_wait_ms"]}})

    by_id = {str(event.get("id")): event for event in events}
    export_diagnostics = []
    for edge in trace.get("edges", []):
        if edge.get("type") != "CAUSES":
            continue
        source, destination = by_id.get(str(edge.get("from"))), by_id.get(str(edge.get("to")))
        if source is None or destination is None:
            continue
        duration = source.get("duration_ms")
        # A missing source endpoint cannot establish an end-to-start flow.
        if not _number(duration) or duration < 0 or source.get("duration_observed") is False:
            export_diagnostics.append({"code": "FLOW_NOT_PROJECTED", "edge_id": edge.get("id"), "reason": "source duration unobserved"})
            continue
        start = float(source.get("start_ms", 0)) + duration
        end = float(destination.get("start_ms", 0))
        if end < start:
            export_diagnostics.append({"code": "FLOW_NOT_PROJECTED", "edge_id": edge.get("id"), "reason": "source end follows target start"})
            continue
        common = {"name": edge.get("label", "CAUSES"), "cat": "microscope.flow", "pid": pid, "id": edge.get("id"),
                  "args": {"from": edge.get("from"), "to": edge.get("to"), "evidence_ids": edge.get("evidence_ids", [])}}
        output.append({**common, "ph": "s", "ts": start * 1000, "tid": tid(source.get("thread_id"))})
        output.append({**common, "ph": "f", "ts": end * 1000, "tid": tid(destination.get("thread_id")), "bp": "e"})
    return {"traceEvents": output, "displayTimeUnit": "ms", "metadata": {
        "mtp_schema_version": trace.get("schema_version"), "mtp_run_id": run.get("id"), "mtp_started_at": run.get("started_at"),
        "timestamp_unit": "us", "mtp_edges": list(trace.get("edges", [])), "mtp_evidence": list(trace.get("evidence", [])),
        "mtp_counters": list(trace.get("counters", [])), "mtp_derived_counters": derived,
        "mtp_capabilities": list(trace.get("capabilities", [])), "mtp_resources": list(trace.get("resources", [])),
        "mtp_diagnostics": list(trace.get("diagnostics", [])), "mtp_export_diagnostics": export_diagnostics}}


def export_file(input_path: str | Path, output_path: str | Path) -> None:
    trace = json.loads(Path(input_path).read_text(encoding="utf-8"))
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(to_perfetto(trace), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export an MTP trace to Perfetto JSON")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    export_file(args.input, args.output)
