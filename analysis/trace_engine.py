"""MTP v0.1 analysis helpers.

The engine intentionally works on plain dictionaries so a Windows collector,
the browser prototype, and future desktop shells can share the same contract
without importing a UI framework.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable


TRUTH_VALUES = {"REAL", "DERIVED", "UNAVAILABLE", "DEBUG_ONLY"}
REQUIRED_ROOT_KEYS = {
    "schema_version",
    "run",
    "nodes",
    "threads",
    "events",
    "values",
    "edges",
    "evidence",
    "io",
}


def load_trace(path: str | Path) -> dict[str, Any]:
    """Load one UTF-8 JSON trace and return its dictionary."""

    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def validate_trace(trace: dict[str, Any]) -> list[str]:
    """Return contract errors; an empty list means the fixture is well formed."""

    errors: list[str] = []
    missing = sorted(REQUIRED_ROOT_KEYS - set(trace))
    if missing:
        errors.append(f"missing root keys: {', '.join(missing)}")
    if trace.get("schema_version") != "0.1":
        errors.append("schema_version must be 0.1")

    run = trace.get("run", {})
    for key in ("id", "name", "status", "duration_ms", "target", "capture_mode", "summary"):
        if key not in run:
            errors.append(f"run missing {key}")

    event_ids: set[str] = set()
    last_start = -1.0
    for index, event in enumerate(trace.get("events", [])):
        for key in ("id", "kind", "start_ms", "duration_ms", "label", "status"):
            if key not in event:
                errors.append(f"event {index} missing {key}")
        event_id = str(event.get("id", ""))
        if event_id in event_ids:
            errors.append(f"duplicate event id: {event_id}")
        event_ids.add(event_id)
        start = event.get("start_ms", -1)
        duration = event.get("duration_ms", -1)
        if isinstance(start, (int, float)) and start < last_start:
            errors.append(f"events are not ordered at {event_id}")
        if not isinstance(duration, (int, float)) or duration < 0:
            errors.append(f"event {event_id} has invalid duration")
        if isinstance(start, (int, float)):
            last_start = start

    evidence_ids: set[str] = set()
    for index, item in enumerate(trace.get("evidence", [])):
        for key in ("id", "truth", "source", "detail"):
            if key not in item:
                errors.append(f"evidence {index} missing {key}")
        evidence_id = str(item.get("id", ""))
        evidence_ids.add(evidence_id)
        if item.get("truth") not in TRUTH_VALUES:
            errors.append(f"evidence {evidence_id} has invalid truth")

    for event in trace.get("events", []):
        for evidence_id in event.get("evidence_ids", []):
            if evidence_id not in evidence_ids:
                errors.append(f"event {event.get('id')} references unknown evidence {evidence_id}")
    return errors


def _event_end(event: dict[str, Any]) -> float:
    return float(event.get("start_ms", 0)) + float(event.get("duration_ms", 0))


def summarize(trace: dict[str, Any]) -> dict[str, Any]:
    """Create human-facing summary values while preserving their provenance."""

    events = list(trace.get("events", []))
    duration = float(trace.get("run", {}).get("duration_ms", 0))
    waits = sorted(events, key=lambda item: float(item.get("duration_ms", 0)), reverse=True)
    # A network read that eventually succeeds is still time spent waiting from
    # a person's point of view. The projection therefore attributes all
    # network I/O duration, while the raw event keeps the exact status.
    network_wait = sum(
        float(item.get("duration_ms", 0))
        for item in trace.get("io", [])
        if item.get("type") == "network"
    )
    fault_count = sum(1 for item in events if item.get("status") in {"fault", "error"})
    headline = trace.get("run", {}).get("summary", {}).get("headline")
    if not headline:
        headline = "Completed successfully" if trace.get("run", {}).get("status") == "completed" else "Run needs attention"
    return {
        "headline": headline,
        "duration_ms": duration,
        "event_count": len(events),
        "fault_count": fault_count,
        "longest_wait": waits[0] if waits else None,
        "network_wait_ms": network_wait,
        "network_wait_percent": round((network_wait / duration) * 100, 1) if duration else 0.0,
        "thread_count": len(trace.get("threads", [])),
        "node_count": len(trace.get("nodes", [])),
        "evidence_count": len(trace.get("evidence", [])),
    }


def first_divergence(normal: dict[str, Any], failed: dict[str, Any]) -> dict[str, Any] | None:
    """Find the first event whose phase/outcome/status differs between two runs."""

    left = normal.get("events", [])
    right = failed.get("events", [])
    for index, (a, b) in enumerate(zip(left, right)):
        signature_a = (a.get("phase", a.get("label")), a.get("outcome"), a.get("status"))
        signature_b = (b.get("phase", b.get("label")), b.get("outcome"), b.get("status"))
        if signature_a != signature_b:
            # A human can only point to the changed result after the differing
            # invocation has completed. For same-phase mismatches this is the
            # end of the invocation; for a route change use the earliest start.
            at_ms = max(_event_end(a), _event_end(b)) if a.get("phase") == b.get("phase") else min(float(a.get("start_ms", 0)), float(b.get("start_ms", 0)))
            return {
                "index": index,
                "at_ms": at_ms,
                "normal": a,
                "failed": b,
                "reason": _divergence_reason(a, b),
            }
    if len(left) != len(right):
        index = min(len(left), len(right))
        a = left[index] if index < len(left) else None
        b = right[index] if index < len(right) else None
        return {
            "index": index,
            "at_ms": float((a or b or {}).get("start_ms", 0)),
            "normal": a,
            "failed": b,
            "reason": "one run continued after the other ended",
        }
    return None


def _divergence_reason(normal: dict[str, Any], failed: dict[str, Any]) -> str:
    if normal.get("phase") == failed.get("phase") and normal.get("outcome") != failed.get("outcome"):
        return f"{normal.get('phase')} outcome changed from {normal.get('outcome')} to {failed.get('outcome')}"
    if normal.get("status") != failed.get("status"):
        return f"status changed from {normal.get('status')} to {failed.get('status')}"
    return "the execution route changed"


def provenance(trace: dict[str, Any], target_id: str, limit: int = 12) -> list[dict[str, Any]]:
    """Follow reverse CAUSES edges from a value/event to its sources."""

    by_id: dict[str, dict[str, Any]] = {}
    for collection in (trace.get("values", []), trace.get("events", []), trace.get("io", [])):
        by_id.update({str(item.get("id")): item for item in collection if item.get("id") is not None})
    edges = trace.get("edges", [])
    chain: list[dict[str, Any]] = []
    current = str(target_id)
    visited: set[str] = set()
    while current and current not in visited and len(chain) < limit:
        visited.add(current)
        item = by_id.get(current)
        if item is not None:
            chain.append({"id": current, "kind": _item_kind(item), "label": _item_label(item), "item": item})
        incoming = next((edge for edge in edges if str(edge.get("to")) == current and edge.get("type") == "CAUSES"), None)
        if incoming is None:
            break
        current = str(incoming.get("from", ""))
    return chain


def _item_kind(item: dict[str, Any]) -> str:
    if "type" in item and "operation" in item:
        return "io"
    if "name" in item and "value" in item:
        return "value"
    return str(item.get("kind", "event"))


def _item_label(item: dict[str, Any]) -> str:
    if "name" in item and "value" in item:
        return f"{item['name']} = {item['value']}"
    if "operation" in item:
        return f"{item.get('operation')} {item.get('endpoint') or item.get('path', '')}".strip()
    return str(item.get("label", item.get("id", "unknown")))


def iter_faults(trace: dict[str, Any]) -> Iterable[dict[str, Any]]:
    return (event for event in trace.get("events", []) if event.get("status") in {"fault", "error"})


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Inspect an MTP trace")
    parser.add_argument("trace", type=Path)
    args = parser.parse_args()
    document = load_trace(args.trace)
    print(json.dumps({"validation": validate_trace(document), "summary": summarize(document)}, indent=2))
