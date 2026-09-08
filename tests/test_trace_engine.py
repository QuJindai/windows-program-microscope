import unittest
import copy
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

    def test_unknown_durations_are_valid_and_remain_unavailable(self):
        self.normal["events"][0]["duration_ms"] = None
        del self.normal["events"][1]["duration_ms"]
        self.normal["io"][1]["duration_ms"] = None
        self.normal["io"][2]["duration_ms"] = 0
        self.assertEqual(validate_trace(self.normal), [])
        summary = summarize(self.normal)
        self.assertIsNone(summary["network_wait_ms"])
        self.assertIsNone(summary["network_wait_percent"])
        self.assertEqual(summary["network_wait_truth"], "UNAVAILABLE")
        self.assertEqual(summary["unknown_network_duration_count"], 1)
        self.assertEqual(summary["observed_network_duration_ms"], 0)
        self.assertEqual(summary["longest_wait"]["id"], "n4")

    def test_network_union_is_clipped_and_not_double_counted(self):
        self.normal["run"]["duration_ms"] = 100
        self.normal["io"] = [
            {"id": "io_a", "type": "network", "start_ms": 10, "duration_ms": 60},
            {"id": "io_b", "type": "network", "start_ms": 40, "duration_ms": 80},
        ]
        summary = summarize(self.normal)
        self.assertEqual(summary["network_wait_ms"], 90)
        self.assertEqual(summary["network_wait_percent"], 90)
        self.assertEqual(summary["network_wait_truth"], "DERIVED")

    def test_no_measurements_are_not_invented_zeros(self):
        self.normal["events"] = []
        self.normal["io"] = []
        summary = summarize(self.normal)
        self.assertIsNone(summary["network_wait_ms"])
        self.assertIsNone(summary["network_wait_percent"])
        self.assertIsNone(summary["longest_wait"])
        self.assertEqual(summary["counters"], [])
        self.normal["io"] = [{"type": "network", "start_ms": 0, "duration_ms": 0}]
        self.assertEqual(summarize(self.normal)["network_wait_ms"], 0)

    def test_validation_rejects_malformed_structures_without_crashing(self):
        for trace in (None, [], 7, "trace", {"run": [], "events": [None], "nodes": {}}):
            with self.subTest(trace=trace):
                self.assertTrue(validate_trace(trace))
        for collection in ("events", "nodes", "threads", "values", "edges", "evidence", "io", "resources", "counters", "capabilities", "diagnostics"):
            trace = copy.deepcopy(self.normal)
            trace[collection] = {}
            self.assertTrue(validate_trace(trace), collection)

    def test_validation_rejects_nonfinite_negative_and_boolean_times(self):
        for value in (float("nan"), float("inf"), -1, True, "12"):
            for collection, field in (("events", "start_ms"), ("events", "duration_ms"), ("io", "duration_ms")):
                trace = copy.deepcopy(self.normal)
                trace[collection][0][field] = value
                self.assertTrue(validate_trace(trace), (collection, field, value))
            trace = copy.deepcopy(self.normal)
            trace["run"]["duration_ms"] = value
            self.assertTrue(validate_trace(trace))

    def test_validation_rejects_times_that_cannot_safely_export_as_microseconds(self):
        self.normal["events"][-1]["start_ms"] = 1e308
        self.assertTrue(validate_trace(self.normal))

    def test_validation_rejects_duplicate_and_dangling_references(self):
        for collection in ("nodes", "threads", "events", "values", "edges", "evidence", "io"):
            trace = copy.deepcopy(self.normal)
            trace[collection].append(copy.deepcopy(trace[collection][0]))
            self.assertTrue(validate_trace(trace), collection)
        for field in ("thread_id", "node_id", "event_id", "resource_id", "edge_id"):
            trace = copy.deepcopy(self.normal)
            trace["events"][0][field] = "missing"
            self.assertTrue(validate_trace(trace), field)
        trace = copy.deepcopy(self.normal)
        trace["edges"][0]["from"] = "missing"
        self.assertTrue(validate_trace(trace))
        trace = copy.deepcopy(self.normal)
        trace["values"][0]["evidence_ids"] = ["missing"]
        self.assertTrue(validate_trace(trace))

    def test_provenance_visits_all_branches_once_and_terminates_cycles(self):
        trace = {"values": [{"id": key, "name": key, "value": 1} for key in "abcd"], "edges": [
            {"id": "ab", "from": "a", "to": "b", "type": "CAUSES"},
            {"id": "cb", "from": "c", "to": "b", "type": "CAUSES"},
            {"id": "dc", "from": "d", "to": "c", "type": "CAUSES"},
            {"id": "bd", "from": "b", "to": "d", "type": "CAUSES"},
        ]}
        chain = provenance(trace, "b")
        self.assertEqual([item["id"] for item in chain], ["b", "a", "c", "d"])
        self.assertEqual(chain[0]["depth"], 0)
        self.assertIsNone(chain[0]["parent_id"])
        self.assertEqual(chain[2]["parent_id"], "b")
        self.assertEqual(chain[2]["via_edge_id"], "cb")
        self.assertEqual(len(provenance(trace, "b", limit=2)), 2)

    def test_graph_uses_explicit_objects_and_directed_edges(self):
        from analysis.trace_engine import build_graph, reachable, shortest_path
        trace = {"nodes": [{"id": "node", "kind": "function", "label": "Entry"}],
                 "events": [{"id": "a", "node_id": "node", "label": "A"}, {"id": "b", "label": "B"}],
                 "resources": [{"id": "resource", "kind": "file", "label": "File"}],
                 "edges": [{"id": "ab", "from": "a", "to": "b", "type": "NEXT"}]}
        graph = build_graph(trace)
        self.assertEqual(len(graph["nodes"]), 4)
        self.assertEqual(graph["edges"], trace["edges"])
        self.assertEqual({n["id"] for n in reachable(graph, "b", "backward")["nodes"]}, {"a", "b"})
        self.assertEqual(shortest_path(graph, "a", "b")["edges"][0]["id"], "ab")
        self.assertEqual(shortest_path(graph, "b", "a"), {"nodes": [], "edges": []})
        self.assertEqual(reachable(graph, "missing"), {"nodes": [], "edges": []})

    def test_compare_aligns_named_threads_despite_concurrent_noise(self):
        noisy = copy.deepcopy(self.failure)
        for thread in noisy["threads"]:
            thread["id"] += 100
        for event in noisy["events"]:
            event["thread_id"] += 100
        noisy["threads"].append({"id": 999, "name": "Unrelated"})
        noisy["events"].insert(2, {"id": "noise", "thread_id": 999, "kind": "noise", "label": "Noise", "start_ms": 22, "duration_ms": 1, "status": "ok"})
        result = first_divergence(self.normal, noisy)
        self.assertEqual(result["normal"]["phase"], "CheckCRC")
        self.assertEqual(result["at_ms"], 8368)

    def test_compare_detects_insertion_in_a_matched_thread(self):
        altered = copy.deepcopy(self.normal)
        extra = dict(altered["events"][1], id="inserted", label="Extra call", phase="Extra call", start_ms=17)
        altered["events"].insert(1, extra)
        result = first_divergence(self.normal, altered)
        self.assertIsNone(result["normal"])
        self.assertEqual(result["failed"]["id"], "inserted")

    def test_compare_detects_changed_file_target_with_generic_observed_event(self):
        normal = copy.deepcopy(self.normal)
        normal["events"] = [{"id": "read", "kind": "file", "phase": "read", "label": "read", "thread_id": 1,
                             "start_ms": 1, "duration_ms": None, "status": "observed", "outcome": "observed",
                             "details": {"file_path": "C:\\data\\input.txt"}}]
        changed = copy.deepcopy(normal)
        changed["events"][0]["details"]["file_path"] = "C:\\data\\different.txt"
        result = first_divergence(normal, changed)
        self.assertIsNotNone(result)
        self.assertEqual(result["kind"], "divergence")
        self.assertEqual(result["reason"], "the execution route changed")

    def test_compare_ignores_run_local_node_pid_and_clock_identity(self):
        normal = copy.deepcopy(self.normal)
        normal["events"] = [{"id": "read", "kind": "file", "label": "read", "thread_id": 1, "node_id": "local-node-a",
                             "start_ms": 1, "duration_ms": None, "status": "observed", "outcome": "observed",
                             "file_path": "C:\\data\\input.txt", "details": {"pid": 123, "timestamp_qpc": 111}}]
        changed = copy.deepcopy(normal)
        changed["events"][0].update(node_id="local-node-b", details={"pid": 456, "timestamp_qpc": 999})
        self.assertIsNone(first_divergence(normal, changed))

    def test_compare_empty_runs_reports_first_inserted_or_deleted_event(self):
        empty = copy.deepcopy(self.normal)
        empty["events"] = []
        self.assertIsNone(first_divergence(empty, empty))
        inserted = first_divergence(empty, self.normal)
        self.assertIsNone(inserted["normal"])
        self.assertEqual(inserted["failed"]["id"], "n1")
        deleted = first_divergence(self.normal, empty)
        self.assertEqual(deleted["normal"]["id"], "n1")
        self.assertIsNone(deleted["failed"])

    def test_unrelated_runs_are_incomparable_instead_of_equal(self):
        unrelated = copy.deepcopy(self.normal)
        unrelated["threads"] = [{"id": "other", "name": "Different thread"}]
        for event in unrelated["events"]:
            event["thread_id"] = "other"
        result = first_divergence(self.normal, unrelated)
        self.assertEqual(result["alignment"], "unavailable")
        self.assertEqual(result["kind"], "incomparable")
        self.assertEqual(result["reason"], "runs have no comparable thread lanes")

    def test_identical_matched_threads_with_extra_lane_reports_partial_coverage(self):
        extra = copy.deepcopy(self.normal)
        extra["threads"].append({"id": 999, "name": "Unrelated"})
        extra["events"].append({"id": "noise", "thread_id": 999, "start_ms": 9420, "label": "Noise", "kind": "function", "status": "ok"})
        result = first_divergence(self.normal, extra)
        self.assertEqual(result["kind"], "partial")
        self.assertIsNone(result["normal"])
        self.assertIsNone(result["at_ms"])
        self.assertEqual(result["ignored_normal_lanes"], 0)
        self.assertEqual(result["ignored_failed_lanes"], 1)
        self.assertEqual(result["comparable_lanes"], 3)

    def test_provenance_preserves_both_links_to_shared_ancestor(self):
        trace = {"values": [{"id": key, "name": key, "value": False} for key in "abcd"], "edges": [
            {"id": "ab", "from": "a", "to": "b", "type": "CAUSES"},
            {"id": "ac", "from": "a", "to": "c", "type": "CAUSES"},
            {"id": "bd", "from": "b", "to": "d", "type": "CAUSES"},
            {"id": "cd", "from": "c", "to": "d", "type": "CAUSES"}]}
        chain = provenance(trace, "d")
        ancestor = next(item for item in chain if item["id"] == "a")
        self.assertEqual(ancestor["parent_ids"], ["b", "c"])
        self.assertEqual(ancestor["via_edge_ids"], ["ab", "ac"])
        self.assertEqual(ancestor["label"], "a = false")
        self.assertEqual(chain[0]["parent_ids"], [])


if __name__ == "__main__":
    unittest.main()
