import unittest
from pathlib import Path

from adapters.perfetto_export import to_perfetto
from analysis.trace_engine import load_trace


ROOT = Path(__file__).resolve().parents[1]


class PerfettoExportTests(unittest.TestCase):
    def test_preserves_slices_and_marks_derived_counter(self):
        trace = load_trace(ROOT / "trace" / "sample-failure.json")
        exported = to_perfetto(trace)
        slices = [event for event in exported["traceEvents"] if event["ph"] == "X"]
        counters = [event for event in exported["traceEvents"] if event["ph"] == "C"]
        self.assertEqual(len(slices), len(trace["events"]))
        self.assertEqual(counters[0]["args"]["truth"], "DERIVED")
        self.assertEqual(slices[5]["args"]["mtp_id"], "f6")


if __name__ == "__main__":
    unittest.main()

