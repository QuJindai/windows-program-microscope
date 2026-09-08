#[path = "../../src-tauri/src/pe.rs"]
pub mod pe;
#[path = "../../src-tauri/src/runtime.rs"]
pub mod runtime;
#[path = "../../src-tauri/src/trace_store.rs"]
pub mod trace_store;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    fn sample() -> Value {
        serde_json::from_str(include_str!("../../trace/sample-normal.json")).unwrap()
    }
    fn temp() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(runtime::new_id());
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn round_trip_and_atomic_replacement_preserve_trace() {
        let root = temp();
        let mut trace = sample();
        trace_store::save(&root, &trace).unwrap();
        assert_eq!(trace_store::load(&root, "normal").unwrap(), trace);
        trace["run"]["name"] = json!("Updated name");
        trace_store::save(&root, &trace).unwrap();
        assert_eq!(trace_store::list(&root).unwrap()[0]["name"], "Updated name");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn path_escape_and_invalid_evidence_never_reach_disk() {
        let root = temp();
        let mut trace = sample();
        for id in ["../escape", "a/b", "a\\b", ".", "CON", "NUL", "C:foo"] {
            assert!(trace_store::load(&root, id).is_err(), "{id}");
            trace["run"]["id"] = json!(id);
            assert!(trace_store::save(&root, &trace).is_err(), "{id}");
        }
        trace = sample();
        trace["events"][0]["evidence_ids"] = json!(["missing"]);
        assert!(trace_store::save(&root, &trace).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_collections_numbers_and_references_are_rejected() {
        for (path, value) in [
            ("/events/0/start_ms", json!(-1)),
            ("/events/0/duration_ms", json!("0")),
            ("/events/0/node_id", json!("missing")),
            ("/events/0/thread_id", json!(999)),
            ("/edges/0/to", json!("missing")),
            ("/events/1/id", json!("n1")),
            ("/run/duration_ms", json!(-1)),
            ("/events", json!({})),
        ] {
            let mut trace = sample();
            *trace.pointer_mut(path).unwrap() = value;
            assert!(trace_store::validate(&trace).is_err(), "{path}");
        }
        let mut trace = sample();
        trace["events"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration_ms");
        assert!(trace_store::validate(&trace).is_ok());
    }
    #[test]
    fn bounded_counter_sample_total_and_rows_reject_resource_exhaustion() {
        let mut trace = sample();
        trace["counters"] = json!([
            {"id":"a","name":"A","unit":"n","samples":vec![json!({"timestamp_ms":0,"value":1});60000]},
            {"id":"b","name":"B","unit":"n","samples":vec![json!({"timestamp_ms":0,"value":1});60000]}
        ]);
        assert!(trace_store::validate(&trace).is_err());
    }
    #[test]
    fn invalid_optional_row_fields_are_rejected() {
        let mut trace = sample();
        trace["nodes"][0]["status"] = json!("invented");
        assert!(trace_store::validate(&trace).is_err());
        let mut trace = sample();
        trace["values"][0].as_object_mut().unwrap().remove("name");
        assert!(trace_store::validate(&trace).is_err());
    }
    #[test]
    fn extension_references_and_counter_order_are_validated() {
        let mut trace = sample();
        trace["events"][0]["edge_ids"] = json!(["missing"]);
        assert!(trace_store::validate(&trace).is_err());
        let mut trace = sample();
        trace["io"][0]["value_id"] = json!("missing");
        assert!(trace_store::validate(&trace).is_err());
        let mut trace = sample();
        trace["counters"] = json!([{"id":"c","name":"C","unit":"n","samples":[{"timestamp_ms":2,"value":-1},{"timestamp_ms":1,"value":2}]}]);
        assert!(trace_store::validate(&trace).is_err());
    }
    #[test]
    fn schema_unknown_value_fields_and_numeric_thread_strings_remain_readable() {
        let mut trace = sample();
        trace["values"][0].as_object_mut().unwrap().remove("type");
        trace["values"][0].as_object_mut().unwrap().remove("value");
        trace["events"][0]["thread_id"] = json!("1");
        assert!(trace_store::validate(&trace).is_ok());
    }
    #[test]
    fn oversized_trace_is_rejected_before_json_parsing() {
        let root = temp();
        let path = root.join("large.mtp.json");
        fs::File::create(&path)
            .unwrap()
            .set_len(trace_store::MAX_TRACE_BYTES + 1)
            .unwrap();
        let error = trace_store::read_file(&path).unwrap_err();
        assert!(error.contains("64 MiB"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn packaged_collector_is_discovered_relative_to_resources() {
        if std::env::var_os("MICROSCOPE_COLLECTOR_PATH").is_some() {
            return;
        }
        let root = temp();
        let folder = root.join("collector");
        fs::create_dir_all(&folder).unwrap();
        let executable = folder.join("ProgramMicroscope.Collector.exe");
        fs::write(&executable, []).unwrap();
        assert_eq!(
            runtime::discover_collector(Some(&root)).unwrap(),
            executable.canonicalize().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn session_parameters_are_bounded() {
        assert!(runtime::validate_capture(0, 10).is_err());
        assert!(runtime::validate_capture(1, 0).is_err());
        assert!(runtime::validate_capture(1, 3601).is_err());
        assert!(runtime::validate_capture(1, 3600).is_ok());
    }
    #[test]
    fn missing_collector_and_non_windows_never_fall_back() {
        let root = temp();
        let engine = runtime::RuntimeEngine::new(root.clone(), None);
        let status = engine.status();
        assert!(!status.collector_available);
        assert!(engine.list_processes().is_err());
        assert!(engine.start(123, 1).is_err());
        assert!(engine.capture_status("unknown").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inspect_pe_rejects_non_executable_without_loading_it() {
        let root = temp();
        let path = root.join("fake.exe");
        fs::write(&path, b"not a PE").unwrap();
        assert!(pe::inspect(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, windows))]
mod windows_integration {
    use super::*;
    use serde_json::Value;
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        path::PathBuf,
        process::{Child, Command, Stdio},
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };
    struct Probe(Child);
    impl Drop for Probe {
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }
    #[test]
    fn windows_real_collector_roundtrip() {
        let Some(collector) = std::env::var_os("MICROSCOPE_TEST_COLLECTOR") else {
            eprintln!("Windows ETW runtime integration not requested: set MICROSCOPE_TEST_COLLECTOR and MICROSCOPE_TEST_PROBE");
            return;
        };
        let collector = PathBuf::from(collector);
        let probe_path = PathBuf::from(
            std::env::var_os("MICROSCOPE_TEST_PROBE").expect("set MICROSCOPE_TEST_PROBE"),
        );
        assert!(collector.is_absolute() && collector.is_file());
        assert!(probe_path.is_absolute() && probe_path.is_file());
        let root = std::env::temp_dir().join(runtime::new_id());
        fs::create_dir_all(&root).unwrap();
        let mut probe = Probe(
            Command::new(probe_path)
                .args(["--directory"])
                .arg(&root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let stdout = probe.0.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        let waiting: Value = serde_json::from_str(
            &receiver
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(waiting["status"], "waiting");
        let pid = probe.0.id();
        let engine = runtime::RuntimeEngine::new(root.join("traces"), Some(collector));
        let available = engine.status();
        assert!(available.collector_available, "{}", available.reason);
        assert!(engine
            .list_processes()
            .unwrap()
            .iter()
            .any(|p| p["pid"].as_u64() == Some(pid as u64)));
        let session = engine.start(pid, 60).unwrap();
        assert!(engine.start(pid, 60).is_err());
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            let state = engine.capture_status(&session.id).unwrap();
            assert_eq!(state.status, "running", "{:?}", state.error);
            if state.ready {
                break;
            }
            assert!(Instant::now() < deadline, "Collector never reported READY");
            thread::sleep(Duration::from_millis(50));
        }
        let stdin = probe.0.stdin.as_mut().unwrap();
        stdin.write_all(b"go\n").unwrap();
        stdin.flush().unwrap();
        let completed: Value = serde_json::from_str(
            &receiver
                .recv_timeout(Duration::from_secs(30))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(completed["status"], "completed");
        // A real sampling/ETW flush interval while the probe intentionally remains alive.
        thread::sleep(Duration::from_secs(2));
        engine.stop(&session.id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let trace = loop {
            let state = engine.capture_status(&session.id).unwrap();
            if state.status != "running" {
                assert_eq!(state.status, "completed", "{:?}", state.error);
                break state.trace.expect("completed trace");
            }
            assert!(Instant::now() < deadline, "Collector did not stop");
            thread::sleep(Duration::from_millis(50));
        };
        trace_store::validate(&trace).unwrap();
        assert_eq!(trace["run"]["id"], session.id);
        assert_eq!(trace["run"]["target"]["pid"].as_u64(), Some(pid as u64));
        assert!(
            !trace["events"].as_array().unwrap().is_empty(),
            "No actual ETW events observed"
        );
        assert!(
            trace["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|event| !event["evidence_ids"]
                    .as_array()
                    .unwrap_or(&vec![])
                    .is_empty()),
            "Observed events require evidence"
        );
        assert_eq!(trace_store::list(&engine.trace_dir).unwrap().len(), 1);
        assert_eq!(
            trace_store::load(&engine.trace_dir, &session.id).unwrap(),
            trace
        );
        let stdin = probe.0.stdin.as_mut().unwrap();
        stdin.write_all(b"exit\n").unwrap();
        stdin.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = probe.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(50));
        }
        fs::remove_dir_all(root).unwrap();
    }
}
