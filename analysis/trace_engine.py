"""Evidence-preserving MTP analysis, shared semantically with app/trace-core.js."""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict, deque
from pathlib import Path
from typing import Any, Iterable


TRUTH_VALUES = {"REAL", "DERIVED", "UNAVAILABLE", "DEBUG_ONLY"}
REQUIRED_ROOT_KEYS = {"schema_version", "run", "nodes", "threads", "events", "values", "edges", "evidence", "io"}
COLLECTIONS = ("nodes", "threads", "events", "values", "edges", "evidence", "io", "resources", "counters", "capabilities", "diagnostics", "changes")
GRAPH_COLLECTIONS = ("nodes", "events", "values", "io", "resources")


def load_trace(path: str | Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _number(value: Any, nonnegative: bool = True) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value) and (not nonnegative or value >= 0)
    except OverflowError:
        return False


def _string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _timestamp(value: Any) -> bool:
    return _number(value) and value <= 9007199254740991 / 1000


def _known_duration(item: dict[str, Any]) -> bool:
    return _number(item.get("duration_ms")) and item.get("duration_observed") is not False


def _id(value: Any) -> str | None:
    if _string(value):
        return value
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991:
        return str(value)
    return None


def validate_trace(trace: Any) -> list[str]:
    """Report malformed values and dangling references without raising exceptions.

    Event and I/O durations may be absent or null: neither supplies a measured
    endpoint. All supplied numeric times must be finite and nonnegative.
    """
    if not isinstance(trace, dict):
        return ["trace must be an object"]
    errors: list[str] = []
    pending, seen = [(trace, "trace")], set()
    while pending:
        value, location = pending.pop()
        if isinstance(value, (int, float)) and not isinstance(value, bool) and not _number(value, False):
            errors.append(f"{location} must be finite")
        if isinstance(value, (dict, list)) and id(value) not in seen:
            seen.add(id(value))
            children = value.items() if isinstance(value, dict) else enumerate(value)
            pending.extend((child, f"{location}.{key}") for key, child in children)
    missing = sorted(REQUIRED_ROOT_KEYS - trace.keys())
    if missing:
        errors.append(f"missing root keys: {', '.join(missing)}")
    if trace.get("schema_version") != "0.1":
        errors.append("schema_version must be 0.1")
    run = trace.get("run")
    if not isinstance(run, dict):
        errors.append("run must be an object")
    else:
        for key in ("id", "name", "status", "duration_ms", "target", "capture_mode", "summary"):
            if key not in run:
                errors.append(f"run missing {key}")
        for key in ("id", "name"):
            if not _string(run.get(key)):
                errors.append(f"run has invalid {key}")
        if not _timestamp(run.get("duration_ms")):
            errors.append("run has invalid duration_ms")
        for key in ("target", "summary"):
            if not isinstance(run.get(key), dict):
                errors.append(f"run {key} must be an object")
        if run.get("status") not in ("running", "completed", "failed", "cancelled"):
            errors.append("run has invalid status")
        if run.get("capture_mode") not in ("observe", "deep_trace", "time_travel"):
            errors.append("run has invalid capture_mode")
        target = run.get("target")
        if isinstance(target, dict) and target.get("pid") is not None:
            pid = target["pid"]
            if not isinstance(pid, int) or isinstance(pid, bool) or not 0 <= pid <= 9007199254740991:
                errors.append("run.target.pid must be a nonnegative integer")

    collections: dict[str, list[dict[str, Any]]] = {}
    ids: dict[str, set[str]] = {}
    graph_ids: set[str] = set()
    required = {
        "nodes": ("id", "kind", "label"), "threads": ("id",),
        "events": ("id", "kind", "start_ms", "label", "status"),
        "values": ("id", "name"), "edges": ("id", "from", "to", "type"),
        "evidence": ("id", "truth", "source", "detail"),
        "io": ("id", "operation", "start_ms"), "resources": ("id",),
        "counters": ("id", "name", "unit", "samples"), "capabilities": ("id", "available"),
        "diagnostics": (), "changes": (),
    }
    for name in COLLECTIONS:
        raw = trace.get(name, [])
        if not isinstance(raw, list):
            errors.append(f"{name} must be an array")
            raw = []
        collections[name] = []
        ids[name] = set()
        previous_start = -math.inf
        if name == "events" and len(raw) > 100000:
            errors.append("events exceeds 100000 event limit")
        for index, item in enumerate(raw):
            prefix = f"{name}[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{prefix} must be an object")
                continue
            collections[name].append(item)
            for key in required[name]:
                if key not in item:
                    errors.append(f"{prefix} missing {key}")
            item_id = _id(item.get("id"))
            if "id" in required[name] or "id" in item:
                if item_id is None or (name != "threads" and not _string(item.get("id"))):
                    errors.append(f"{prefix} has invalid id")
                elif item_id in ids[name] or (name in GRAPH_COLLECTIONS and item_id in graph_ids):
                    errors.append(f"duplicate {name} id: {item_id}")
                else:
                    ids[name].add(item_id)
                    if name in GRAPH_COLLECTIONS:
                        graph_ids.add(item_id)
            for field in ("start_ms", "timestamp_ms", "at_ms", "end_ms", "duration_ms", "cpu_ms"):
                if field in item:
                    if field == "duration_ms" and name in ("events", "io") and item[field] is None:
                        continue
                    if field == "cpu_ms" and name == "threads" and item[field] is None:
                        continue
                    if not _timestamp(item[field]):
                        errors.append(f"{prefix} has invalid {field}")
            if name in ("events", "io") and not _timestamp(item.get("start_ms")):
                errors.append(f"{prefix} has invalid start_ms")
            text_fields = {"nodes": ("kind", "label"), "events": ("kind", "label", "status"), "values": ("name",),
                           "edges": ("from", "to", "type"), "evidence": ("source", "detail"),
                           "io": ("operation",), "counters": ("name", "unit")}.get(name, ())
            for field in text_fields:
                if not _string(item.get(field)):
                    errors.append(f"{prefix} has invalid {field}")
            if name == "events":
                if _number(item.get("start_ms")):
                    if item["start_ms"] < previous_start:
                        errors.append(f"events are not ordered at {item.get('id')}")
                    previous_start = item["start_ms"]
                if "details" in item and not isinstance(item["details"], dict):
                    errors.append(f"{prefix} details must be an object")
            if "duration_observed" in item and not isinstance(item["duration_observed"], bool):
                errors.append(f"{prefix} duration_observed must be boolean")
            if name == "evidence" and (not isinstance(item.get("truth"), str) or item["truth"] not in TRUTH_VALUES):
                errors.append(f"{prefix} has invalid truth")
            if name == "io" and not (_string(item.get("type")) or _string(item.get("kind"))):
                errors.append(f"{prefix} missing type or kind")
            if name == "io":
                for field in ("bytes", "bytes_received", "bytes_sent"):
                    if item.get(field) is not None and not _number(item[field]):
                        errors.append(f"{prefix} has invalid {field}")
            if name == "capabilities" and not isinstance(item.get("available"), bool):
                errors.append(f"{prefix} available must be boolean")
            if name == "counters":
                samples = item.get("samples")
                if not isinstance(samples, list):
                    errors.append(f"{prefix} samples must be an array")
                else:
                    previous_sample = -math.inf
                    for sample_index, sample in enumerate(samples):
                        if not isinstance(sample, dict):
                            errors.append(f"{prefix} sample {sample_index} must be an object")
                        elif not _timestamp(sample.get("timestamp_ms")) or not _number(sample.get("value"), False):
                            errors.append(f"{prefix} sample {sample_index} has invalid timestamp_ms or value")
                        else:
                            if sample["timestamp_ms"] < previous_sample:
                                errors.append(f"{prefix} samples must be ordered")
                            previous_sample = sample["timestamp_ms"]

    refs = {"thread_id": "threads", "node_id": "nodes", "event_id": "events", "resource_id": "resources", "edge_id": "edges", "evidence_id": "evidence", "io_id": "io", "value_id": "values"}
    for name, items in collections.items():
        for index, item in enumerate(items):
            prefix = f"{name}[{index}]"
            for field, collection in refs.items():
                if field in item and item[field] is not None:
                    if (collection != "threads" and not _string(item[field])) or _id(item[field]) not in ids[collection]:
                        errors.append(f"{prefix} references unknown {field}: {item[field]}")
            for field, collection in (("evidence_ids", "evidence"), ("event_ids", "events"), ("node_ids", "nodes"), ("edge_ids", "edges"),
                                      ("resource_ids", "resources"), ("thread_ids", "threads"), ("io_ids", "io"), ("value_ids", "values")):
                if field not in item:
                    continue
                if not isinstance(item[field], list):
                    errors.append(f"{prefix} {field} must be an array")
                else:
                    for value in item[field]:
                        if (collection != "threads" and not _string(value)) or _id(value) not in ids[collection]:
                            errors.append(f"{prefix} references unknown {field}: {value}")
            if name == "edges":
                for field in ("from", "to"):
                    if _id(item.get(field)) not in graph_ids:
                        errors.append(f"{prefix} references unknown {field}: {item.get(field)}")
    return errors


def _event_end(event: dict[str, Any]) -> float:
    start = event.get("start_ms")
    duration = event.get("duration_ms")
    return (float(start) if _number(start) else 0.0) + (float(duration) if _known_duration(event) else 0.0)


def _network_summary(trace: dict[str, Any]) -> dict[str, Any]:
    duration = trace.get("run", {}).get("duration_ms")
    network = [item for item in trace.get("io", []) if item.get("type", item.get("kind")) == "network"]
    unknown = sum(not _known_duration(item) or not _number(item.get("start_ms")) for item in network)
    intervals = []
    if _number(duration):
        for item in network:
            if not _known_duration(item) or not _number(item.get("start_ms")):
                continue
            start = min(float(duration), max(0.0, float(item["start_ms"])))
            end = min(float(duration), max(start, _event_end(item)))
            intervals.append((start, end))
    intervals.sort()
    measured: float | None = None
    if intervals:
        measured = 0.0
        current_start, current_end = intervals[0]
        for start, end in intervals[1:]:
            if start <= current_end:
                current_end = max(current_end, end)
            else:
                measured += current_end - current_start
                current_start, current_end = start, end
        measured += current_end - current_start
    available = bool(network) and unknown == 0 and len(intervals) == len(network)
    return {"network_wait_ms": measured if available else None,
            "network_wait_percent": math.floor(measured / duration * 1000 + 0.5) / 10 if available and duration else None,
            "network_wait_truth": "DERIVED" if available else "UNAVAILABLE",
            "observed_network_duration_ms": measured,
            "unknown_network_duration_count": unknown}


def summarize(trace: dict[str, Any]) -> dict[str, Any]:
    """Aggregate recorded facts; overlap is a union, missing data remains unknown."""
    events = trace.get("events", [])
    known_events = [event for event in events if _known_duration(event)]
    run = trace.get("run", {})
    headline = run.get("summary", {}).get("headline")
    if not headline:
        headline = "Completed successfully" if run.get("status") == "completed" else "Run needs attention"
    return {"headline": headline, "duration_ms": run.get("duration_ms"),
            "event_count": len(events),
            "fault_count": sum(event.get("status") in ("fault", "error") for event in events),
            "longest_wait": max(known_events, key=lambda event: event["duration_ms"]) if known_events else None,
            **_network_summary(trace),
            "thread_count": len(trace.get("threads", [])), "node_count": len(trace.get("nodes", [])),
            "evidence_count": len(trace.get("evidence", [])), "counters": list(trace.get("counters", []))}


def _thread_groups(trace: dict[str, Any], shared_names: set[str]) -> dict[str, list[tuple[int, dict[str, Any]]]]:
    threads = {_id(thread.get("id")): thread for thread in trace.get("threads", [])}
    result: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for index, event in enumerate(trace.get("events", [])):
        thread_id = _id(event.get("thread_id"))
        thread = threads.get(thread_id, {})
        name = thread.get("name")
        key = f"name:{name}" if _string(name) and name in shared_names else f"id:{thread_id}" if thread_id is not None else "@unassigned"
        result[key].append((index, event))
    return result


def _stable_key(event: dict[str, Any]) -> tuple[Any, ...]:
    key = (event.get("phase") or event.get("label"), event.get("kind"))
    if event.get("kind") not in ("file", "network", "registry"):
        return key
    details = event.get("details") if isinstance(event.get("details"), dict) else {}
    fields = ("file_path", "path", "registry_key", "value_name", "endpoint", "target", "source_address",
              "source_port", "destination_address", "destination_port", "protocol")
    resource = tuple(event[field] if event.get(field) is not None else details.get(field) for field in fields)
    return key + (event.get("label"), resource)


def _divergence_reason(normal: dict[str, Any], failed: dict[str, Any]) -> str:
    if _stable_key(normal) == _stable_key(failed) and normal.get("outcome") != failed.get("outcome"):
        return f"{normal.get('phase') or normal.get('label')} outcome changed from {normal.get('outcome') if normal.get('outcome') is not None else 'unknown'} to {failed.get('outcome') if failed.get('outcome') is not None else 'unknown'}"
    if _stable_key(normal) == _stable_key(failed) and normal.get("status") != failed.get("status"):
        return f"status changed from {normal.get('status')} to {failed.get('status')}"
    return "the execution route changed"


def first_divergence(normal: dict[str, Any], failed: dict[str, Any]) -> dict[str, Any] | None:
    """Compare semantic thread lanes, ignoring interleaving and unrelated threads."""
    normal_events, failed_events = normal.get("events", []), failed.get("events", [])
    names = [Counter(t.get("name") for t in trace.get("threads", []) if _string(t.get("name"))) for trace in (normal, failed)]
    shared_names = {name for name, count in names[0].items() if count == 1 and names[1][name] == 1}
    left_groups, right_groups = (_thread_groups(trace, shared_names) for trace in (normal, failed))
    comparable = left_groups.keys() & right_groups.keys()
    coverage = {"comparable_lanes": len(comparable), "ignored_normal_lanes": len(left_groups) - len(comparable),
                "ignored_failed_lanes": len(right_groups) - len(comparable)}
    if not normal_events or not failed_events:
        if not normal_events and not failed_events:
            return None
        a, b = normal_events[0] if normal_events else None, failed_events[0] if failed_events else None
        return {"index": 0, "normal_index": 0 if a else None, "failed_index": 0 if b else None,
                "at_ms": float((a or b).get("start_ms", 0)), "normal": a, "failed": b,
                "reason": "an event was added to the compared thread" if a is None else "an event is missing from the compared thread",
                "alignment": "thread-semantic", "kind": "divergence", **coverage}
    if not comparable:
        a, b = normal_events[0], failed_events[0]
        return {"index": 0, "normal_index": 0, "failed_index": 0, "normal": a, "failed": b,
                "at_ms": min(float(a.get("start_ms", 0)), float(b.get("start_ms", 0))),
                "reason": "runs have no comparable thread lanes", "alignment": "unavailable", "kind": "incomparable", **coverage}
    candidates = []
    for lane in left_groups.keys() & right_groups.keys():
        left, right = left_groups[lane], right_groups[lane]
        for offset in range(max(len(left), len(right))):
            a_index, a = left[offset] if offset < len(left) else (None, None)
            b_index, b = right[offset] if offset < len(right) else (None, None)
            if a and b and _stable_key(a) == _stable_key(b) and a.get("status") == b.get("status") and a.get("outcome") == b.get("outcome"):
                continue
            if a and b and _stable_key(a) != _stable_key(b):
                if offset + 1 < len(right) and _stable_key(a) == _stable_key(right[offset + 1][1]):
                    a_index, a = None, None
                elif offset + 1 < len(left) and _stable_key(left[offset + 1][1]) == _stable_key(b):
                    b_index, b = None, None
            if a is None or b is None:
                at_ms = float((a or b).get("start_ms", 0))
                reason = "an event was added to the compared thread" if a is None else "an event is missing from the compared thread"
            else:
                same = _stable_key(a) == _stable_key(b)
                at_ms = max(_event_end(a), _event_end(b)) if same else min(float(a.get("start_ms", 0)), float(b.get("start_ms", 0)))
                reason = _divergence_reason(a, b)
            candidates.append({"index": min(index for index in (a_index, b_index) if index is not None),
                               "normal_index": a_index, "failed_index": b_index, "at_ms": at_ms,
                               "normal": a, "failed": b, "reason": reason, "alignment": "thread-semantic", "kind": "divergence", **coverage})
            break
    if candidates:
        return min(candidates, key=lambda item: (item["at_ms"], item["normal_index"] if item["normal_index"] is not None else math.inf, item["failed_index"] if item["failed_index"] is not None else math.inf))
    if coverage["ignored_normal_lanes"] or coverage["ignored_failed_lanes"]:
        return {"kind": "partial", "normal": None, "failed": None, "at_ms": None, "index": None,
                "normal_index": None, "failed_index": None, "alignment": "thread-semantic",
                "reason": "no divergence in comparable threads; some thread lanes could not be matched", **coverage}
    return None


def _item_kind(item: dict[str, Any], collection: str = "events") -> str:
    if collection == "io":
        return "io"
    if collection == "values":
        return "value"
    return str(item.get("kind", "resource" if collection == "resources" else "node" if collection == "nodes" else "event"))


def _item_label(item: dict[str, Any]) -> str:
    if "name" in item and "value" in item:
        value = item["value"] if isinstance(item["value"], str) else json.dumps(item["value"], ensure_ascii=False, separators=(",", ":"))
        return f"{item['name']} = {value}"
    if "operation" in item:
        return f"{item.get('operation')} {item.get('endpoint') or item.get('path') or item.get('target') or ''}".strip()
    return str(item.get("label") or item.get("name") or item.get("path") or item.get("id", "unknown"))


def build_graph(trace: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Project explicit entities and edges without inventing causal relations."""
    nodes = [{"id": str(item["id"]), "kind": _item_kind(item, collection), "label": _item_label(item), "item": item}
             for collection in GRAPH_COLLECTIONS for item in trace.get(collection, []) if item.get("id") is not None]
    node_ids = {node["id"] for node in nodes}
    return {"nodes": nodes, "edges": [edge for edge in trace.get("edges", []) if str(edge.get("from")) in node_ids and str(edge.get("to")) in node_ids]}


def provenance(trace: dict[str, Any], target_id: str, limit: int = 1000) -> list[dict[str, Any]]:
    """Breadth-first reverse CAUSES traversal, including every branch once."""
    graph = build_graph(trace)
    by_id = {node["id"]: node for node in graph["nodes"]}
    incoming: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in graph["edges"]:
        if edge.get("type") == "CAUSES":
            incoming[str(edge.get("to"))].append(edge)
    queue = deque([(str(target_id), 0, None, None)])
    visited = set()
    result = []
    while queue and len(result) < limit:
        item_id, depth, parent_id, edge_id = queue.popleft()
        if item_id in visited or item_id not in by_id:
            continue
        visited.add(item_id)
        result.append({**by_id[item_id], "depth": depth, "parent_id": parent_id, "via_edge_id": edge_id})
        for edge in incoming[item_id]:
            queue.append((str(edge.get("from")), depth + 1, item_id, edge.get("id")))
    included = {entry["id"] for entry in result}
    branch_links: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in graph["edges"]:
        if edge.get("type") == "CAUSES" and str(edge.get("to")) in included:
            branch_links[str(edge.get("from"))].append(edge)
    for entry in result:
        links = branch_links[entry["id"]] if entry["id"] != str(target_id) else []
        entry["parent_ids"] = [str(edge.get("to")) for edge in links]
        entry["via_edge_ids"] = [edge.get("id") for edge in links]
    return result


def reachable(graph: dict[str, Any], target_id: str, direction: str = "forward") -> dict[str, list[dict[str, Any]]]:
    if direction not in ("forward", "backward", "both"):
        raise ValueError("direction must be forward, backward, or both")
    by_id = {str(node["id"]): node for node in graph.get("nodes", [])}
    target_id = str(target_id)
    if target_id not in by_id:
        return {"nodes": [], "edges": []}
    adjacency = defaultdict(list)
    for index, edge in enumerate(graph.get("edges", [])):
        source, target = str(edge.get("from")), str(edge.get("to"))
        if source in by_id and target in by_id:
            if direction in ("forward", "both"):
                adjacency[source].append((target, index))
            if direction in ("backward", "both"):
                adjacency[target].append((source, index))
    visited, edge_indices = {target_id}, set()
    queue = deque([target_id])
    order = []
    while queue:
        current = queue.popleft()
        order.append(current)
        for target, index in adjacency[current]:
            edge_indices.add(index)
            if target not in visited:
                visited.add(target)
                queue.append(target)
    return {"nodes": [node for node in graph.get("nodes", []) if str(node["id"]) in visited], "edges": [edge for index, edge in enumerate(graph.get("edges", [])) if index in edge_indices]}


def shortest_path(graph: dict[str, Any], source_id: str, target_id: str) -> dict[str, list[dict[str, Any]]]:
    """Return a directed shortest path as original graph node/edge objects."""
    by_id = {str(node["id"]): node for node in graph.get("nodes", [])}
    source_id, target_id = str(source_id), str(target_id)
    empty = {"nodes": [], "edges": []}
    if source_id not in by_id or target_id not in by_id:
        return empty
    adjacency = defaultdict(list)
    for edge in graph.get("edges", []):
        if str(edge.get("to")) in by_id:
            adjacency[str(edge.get("from"))].append(edge)
    queue = deque([source_id])
    parents: dict[str, tuple[str, dict[str, Any]] | None] = {source_id: None}
    while queue:
        current = queue.popleft()
        if current == target_id:
            nodes, edges = [by_id[current]], []
            while parents[current] is not None:
                previous, edge = parents[current]
                edges.append(edge)
                nodes.append(by_id[previous])
                current = previous
            return {"nodes": nodes[::-1], "edges": edges[::-1]}
        for edge in adjacency[current]:
            target = str(edge.get("to"))
            if target not in parents:
                parents[target] = (current, edge)
                queue.append(target)
    return empty


def iter_faults(trace: dict[str, Any]) -> Iterable[dict[str, Any]]:
    return (event for event in trace.get("events", []) if event.get("status") in {"fault", "error"})


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Inspect an MTP trace")
    parser.add_argument("trace", type=Path)
    args = parser.parse_args()
    document = load_trace(args.trace)
    print(json.dumps({"validation": validate_trace(document), "summary": summarize(document)}, indent=2))
