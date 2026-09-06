import unittest
from pathlib import Path

from analysis.trace_engine import first_divergence, load_trace, provenance, summarize, validate_trace


ROOT = Path(__file__).resolve().parents[1]


class TraceEngineTests(unittest.TestCase):
    def setUp(self):
        self.normal = load_trace(ROOT / "trace" / "sample-normal.json")
        self.failure = load_trace(ROOT / "trace" / "sample-failure.json")

    def test_fixtures_satisfy_mtp_contract(self):
        self.assertEqual(validate_trace(self.normal), [])
        self.assertEqual(validate_trace(self.failure), [])

    def test_summary_marks_network_wait_as_derived(self):
        summary = summarize(self.failure)
        self.assertEqual(summary["fault_count"], 5)
        self.assertGreater(summary["network_wait_percent"], 60)
        self.assertEqual(self.failure["evidence"][-2]["truth"], "DERIVED")

    def test_first_divergence_is_crc(self):
        divergence = first_divergence(self.normal, self.failure)
        self.assertIsNotNone(divergence)
        self.assertEqual(divergence["at_ms"], 8368)
        self.assertEqual(divergence["normal"]["phase"], "CheckCRC")
        self.assertEqual(divergence["failed"]["outcome"], "crc_mismatch")

    def test_provenance_follows_reverse_causes_edges(self):
        chain = provenance(self.failure, "v_result")
        self.assertGreaterEqual(len(chain), 4)
        self.assertEqual(chain[0]["label"], "result = false")
        self.assertEqual(chain[1]["label"], "actualCrc = 0x9C4D")
        self.assertIn("tcp_read", chain[-1]["label"])


if __name__ == "__main__":
    unittest.main()
