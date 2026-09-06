"""Export MTP v0.1 to Perfetto/Chrome JSON trace events.

The JSON format is intentionally dependency-free and can be opened by
Perfetto's web UI. It preserves MTP IDs in args so a user can navigate back to
the evidence record instead of receiving an anonymous flame chart.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def to_perfetto(trace: dict[str, Any]) -> dict[str, Any]:
    run = trace.get("run", {})
    target = run.get("target", {})
    pid = int(target.get("pid", 0) or 0)
    output: list[dict[str, Any]] = []

    for event in trace.get("events", []):
        status = event.get("status", "ok")
        output.append(
            {
                "name": event.get("label", event.get("id", "event")),
                "cat": f"microscope.{event.get('kind', 'event')}",
                "ph": "X",
                "ts": float(event.get("start_ms", 0)) * 1000,
                "dur": float(event.get("duration_ms", 0)) * 1000,
                "pid": pid,
                "tid": int(event.get("thread_id", 0) or 0),
                "args": {
                    "mtp_id": event.get("id"),
                    "phase": event.get("phase"),
                    "outcome": event.get("outcome"),
                    "status": status,
                    "evidence_ids": event.get("evidence_ids", []),
                },
            }
        )

    # Derived counters let the same trace answer “where did time go?” in a
    # Perfetto counter track while keeping the raw durations above intact.
    network_total = sum(
        float(item.get("duration_ms", 0)) for item in trace.get("io", []) if item.get("type") == "network"
    )
    output.append(
        {
            "name": "network_wait_ms",
            "cat": "microscope.derived",
            "ph": "C",
            "ts": 0,
            "pid": pid,
            "args": {"value": network_total, "truth": "DERIVED", "mtp_run": run.get("id")},
        }
    )

    # A CAUSES edge between event IDs becomes a pair of flow arrows. Value
    # edges remain in the MTP JSON and are carried as args because Perfetto's
    # flow renderer cannot attach arrows to an object that has no timestamp.
    event_ids = {str(item.get("id")) for item in trace.get("events", [])}
    for edge in trace.get("edges", []):
        source, target_id = str(edge.get("from", "")), str(edge.get("to", ""))
        if source in event_ids and target_id in event_ids:
            output.extend(
                [
                    {"name": edge.get("label", "CAUSES"), "cat": "microscope.flow", "ph": "s", "ts": 0, "pid": pid, "tid": 0, "id": edge.get("id"), "args": {"from": source, "to": target_id}},
                    {"name": edge.get("label", "CAUSES"), "cat": "microscope.flow", "ph": "f", "ts": 0, "pid": pid, "tid": 0, "id": edge.get("id"), "args": {"from": source, "to": target_id}},
                ]
            )
    return {"traceEvents": output, "displayTimeUnit": "ms", "metadata": {"mtp_schema_version": trace.get("schema_version"), "mtp_run_id": run.get("id")}}


def export_file(input_path: str | Path, output_path: str | Path) -> None:
    source = Path(input_path)
    destination = Path(output_path)
    trace = json.loads(source.read_text(encoding="utf-8"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(to_perfetto(trace), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export an MTP trace to Perfetto JSON")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    export_file(args.input, args.output)

