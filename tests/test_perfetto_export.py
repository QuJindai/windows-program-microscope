import unittest
from pathlib import Path

from adapters.perfetto_export import to_perfetto
from analysis.trace_engine import load_trace


ROOT = Path(__file__).resolve().parents[1]


class PerfettoExportTests(unittest.TestCase):
    def make_trace(self, fields):
        trace = {"schema_version": "0.1", "nodes": [], "threads": [], "events": [], "values": [], "edges": [], "evidence": [], "io": []}
        trace.update(fields)
        trace["run"] = {"id": "test", "name": "Test", "status": "completed", "capture_mode": "observe", "summary": {}, **trace["run"]}
        for event in trace["events"]:
            event.setdefault("label", event["id"])
            event.setdefault("kind", "function")
            event.setdefault("status", "ok")
        return trace

    def test_preserves_slices_and_marks_derived_counter(self):
        trace = load_trace(ROOT / "trace" / "sample-failure.json")
        exported = to_perfetto(trace)
        slices = [event for event in exported["traceEvents"] if event["ph"] == "X"]
        counters = [event for event in exported["traceEvents"] if event["ph"] == "C"]
        self.assertEqual(len(slices), len(trace["events"]))
        self.assertEqual(counters[0]["args"]["value"], 8679)
        self.assertEqual(exported["metadata"]["mtp_derived_counters"][0]["truth"], "DERIVED")
        self.assertEqual(slices[5]["args"]["mtp_id"], "f6")

    def test_unknown_duration_is_instant_and_has_no_fake_counter(self):
        trace = {"run": {"id": "r", "duration_ms": 10, "target": {"pid": 1}}, "threads": [{"id": 2, "name": "Main"}],
                 "events": [{"id": "a", "label": "Start", "thread_id": 2, "start_ms": 1.25, "duration_ms": None}], "io": []}
        result = to_perfetto(self.make_trace(trace))
        instant = next(item for item in result["traceEvents"] if item["ph"] == "i")
        self.assertEqual(instant["ts"], 1250)
        self.assertNotIn("dur", instant)
        self.assertFalse(any(item["ph"] == "C" for item in result["traceEvents"]))
        self.assertTrue(any(item["name"] == "thread_name" for item in result["traceEvents"]))
        self.assertTrue(any(item["name"] == "process_name" for item in result["traceEvents"]))

    def test_flows_use_only_explicit_forward_causes_and_actual_times(self):
        trace = {"run": {"duration_ms": 20, "target": {"pid": 1}}, "threads": [{"id": 1}, {"id": 2}], "events": [
            {"id": "a", "thread_id": 1, "start_ms": 1, "duration_ms": 2},
            {"id": "b", "thread_id": 2, "start_ms": 10, "duration_ms": 1}],
            "edges": [{"id": "cause", "from": "a", "to": "b", "type": "CAUSES"},
                      {"id": "next", "from": "a", "to": "b", "type": "NEXT"},
                      {"id": "back", "from": "b", "to": "a", "type": "CAUSES"}], "evidence": [{"id": "ev", "truth": "REAL", "source": "test", "detail": "observed"}]}
        result = to_perfetto(self.make_trace(trace))
        flows = [item for item in result["traceEvents"] if item["ph"] in ("s", "f")]
        self.assertEqual([(item["ts"], item["tid"]) for item in flows], [(3000, 1), (10000, 2)])
        self.assertEqual(result["metadata"]["mtp_edges"], trace["edges"])
        self.assertEqual(result["metadata"]["mtp_evidence"], trace["evidence"])

    def test_recorded_counter_samples_keep_real_timestamps_and_numeric_args(self):
        trace = {"run": {"duration_ms": 10, "target": {"pid": 1}}, "counters": [
            {"id": "cpu", "name": "CPU", "unit": "%", "samples": [{"timestamp_ms": 2.5, "value": 0}, {"timestamp_ms": 7, "value": 15}], "evidence_ids": ["ev"]}], "evidence": [{"id": "ev", "truth": "REAL", "source": "test", "detail": "observed"}]}
        result = to_perfetto(self.make_trace(trace))
        counters = [item for item in result["traceEvents"] if item["ph"] == "C"]
        self.assertEqual([item["ts"] for item in counters], [2500, 7000])
        self.assertEqual([item["args"] for item in counters], [{"value": 0}, {"value": 15}])
        self.assertEqual(result["metadata"]["mtp_counters"], trace["counters"])


if __name__ == "__main__":
    unittest.main()
