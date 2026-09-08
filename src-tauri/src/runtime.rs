//! Native process ownership and capture coordination; never substitutes example data.
use super::trace_store;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DIAGNOSTIC_LIMIT: usize = 65536;
const STOP_GRACE_SECONDS: u64 = 30;
const SHUTDOWN_WAIT_SECONDS: u64 = 45;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
pub fn new_id() -> String {
    format!(
        "capture-{}-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros(),
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}
pub fn validate_capture(pid: u32, duration: u32) -> Result<(), String> {
    if pid == 0 {
        return Err("PID must be greater than zero".into());
    }
    if !(1..=3600).contains(&duration) {
        return Err("Capture duration must be 1–3600 seconds".into());
    }
    Ok(())
}
#[derive(Clone, Serialize)]
pub struct RuntimeStatus {
    pub platform: String,
    pub collector_available: bool,
    pub reason: String,
    pub capabilities: Vec<Value>,
}
#[derive(Clone, Serialize)]
pub struct CaptureStatus {
    pub id: String,
    pub status: String,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip)]
    persisted: bool,
}
struct Active {
    id: String,
    control: mpsc::Sender<Control>,
    stdout: Arc<Mutex<Vec<u8>>>,
}
enum Control {
    Stop,
    Shutdown,
}
#[derive(Default)]
struct Sessions {
    shutting_down: bool,
    active: Option<Active>,
    history: VecDeque<CaptureStatus>,
}
pub struct RuntimeEngine {
    pub trace_dir: PathBuf,
    collector: Option<PathBuf>,
    sessions: Arc<Mutex<Sessions>>,
}

pub fn discover_collector(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    // An explicit local override is useful for development and has no shell interpretation.
    if let Some(path) = std::env::var_os("MICROSCOPE_COLLECTOR_PATH") {
        return PathBuf::from(path)
            .canonicalize()
            .ok()
            .filter(|p| p.is_file());
    }
    if let Some(root) = resource_dir {
        candidates.push(root.join("collector/ProgramMicroscope.Collector.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent() {
            candidates.push(root.join("collector/ProgramMicroscope.Collector.exe"));
        }
    }
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(manifest.join("collector/ProgramMicroscope.Collector.exe"));
        candidates.push(manifest.join("../collector/windows/bin/Release/net8.0-windows/win-x64/publish/ProgramMicroscope.Collector.exe"));
        candidates.push(
            manifest.join(
                "../collector/windows/bin/Debug/net8.0-windows/ProgramMicroscope.Collector.exe",
            ),
        );
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .and_then(|p| p.canonicalize().ok())
}
fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}
fn drain(mut reader: impl Read + Send + 'static, limit: usize) -> Arc<Mutex<Vec<u8>>> {
    let output = Arc::new(Mutex::new(Vec::new()));
    let target = output.clone();
    thread::spawn(move || {
        let mut chunk = [0; 8192];
        while let Ok(count) = reader.read(&mut chunk) {
            if count == 0 {
                break;
            }
            if let Ok(mut bytes) = target.lock() {
                let remaining = limit.saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..count.min(remaining)]);
            }
        }
    });
    output
}
fn diagnostics(bytes: &Arc<Mutex<Vec<u8>>>) -> String {
    bytes
        .lock()
        .map(|v| String::from_utf8_lossy(&v).trim().to_owned())
        .unwrap_or_default()
}
fn collector_ready(stdout: &Arc<Mutex<Vec<u8>>>) -> bool {
    diagnostics(stdout)
        .lines()
        .any(|line| line == "READY" || line.starts_with("READY "))
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn query(path: &Path, arg: &str) -> Result<Value, String> {
    query_args(path, &[arg])
}
fn query_args(path: &Path, args: &[&str]) -> Result<Value, String> {
    let mut child = OwnedChild(
        command(path)
            .args(args)
            .spawn()
            .map_err(|e| format!("Cannot launch collector: {e}"))?,
    );
    child.0.stdin.take();
    // Drain both pipes concurrently; time and memory are bounded even for a broken collector.
    let (send, recv) = mpsc::channel();
    let mut stdout = child
        .0
        .stdout
        .take()
        .ok_or("Collector stdout unavailable")?;
    thread::spawn(move || {
        let mut out = Vec::new();
        let result = stdout
            .by_ref()
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut out);
        let _ = send.send((result, out));
    });
    let stderr = drain(
        child
            .0
            .stderr
            .take()
            .ok_or("Collector stderr unavailable")?,
        DIAGNOSTIC_LIMIT,
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            let (result, out) = recv
                .recv_timeout(Duration::from_secs(1))
                .map_err(|_| "Collector output did not close")?;
            result.map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(format!(
                    "Collector exited with {status}: {}",
                    diagnostics(&stderr)
                ));
            }
            if out.len() > 8 * 1024 * 1024 {
                return Err("Collector response exceeds 8 MiB".into());
            }
            return serde_json::from_slice(&out)
                .map_err(|e| format!("Invalid collector response: {e}"));
        }
        if Instant::now() >= deadline {
            return Err("Collector query timed out after 10 seconds".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
}
impl RuntimeEngine {
    pub fn new(trace_dir: PathBuf, collector: Option<PathBuf>) -> Self {
        Self {
            trace_dir,
            collector,
            sessions: Arc::new(Mutex::new(Sessions::default())),
        }
    }
    fn collector(&self) -> Result<&Path, String> {
        if !cfg!(windows) {
            return Err("Live capture is available only on Windows; import an MTP file to inspect existing evidence".into());
        }
        self.collector.as_deref().filter(|p|p.is_file()).ok_or_else(||"Windows collector is missing. Install the complete desktop package or publish the collector into src-tauri/collector".into())
    }
    pub fn status(&self) -> RuntimeStatus {
        let platform = std::env::consts::OS.to_owned();
        let unavailable = |reason| RuntimeStatus {
            platform: platform.clone(),
            collector_available: false,
            reason,
            capabilities: vec![],
        };
        let path = match self.collector() {
            Ok(path) => path,
            Err(error) => return unavailable(error),
        };
        match query(path, "--capabilities") {
            Ok(value) => {
                let Some(available) = value.get("collector_available").and_then(Value::as_bool)
                else {
                    return unavailable("Collector returned invalid availability".into());
                };
                let Some(capabilities) = value.get("capabilities").and_then(Value::as_array) else {
                    return unavailable("Collector returned invalid capabilities".into());
                };
                RuntimeStatus {
                    platform,
                    collector_available: available,
                    reason: value["reason"].as_str().unwrap_or("").to_owned(),
                    capabilities: capabilities.clone(),
                }
            }
            Err(error) => unavailable(error),
        }
    }
    pub fn list_processes(&self) -> Result<Vec<Value>, String> {
        let value = query(self.collector()?, "--list-processes")?;
        process_rows(&value)
    }
    pub fn start(&self, pid: u32, duration: u32) -> Result<CaptureStatus, String> {
        validate_capture(pid, duration)?;
        let path = self.collector()?;
        self.start_program(path, pid, duration)
    }
    fn start_program(&self, path: &Path, pid: u32, duration: u32) -> Result<CaptureStatus, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Capture coordinator unavailable")?;
        if sessions.shutting_down {
            return Err("Application is shutting down".into());
        }
        if sessions.active.is_some() {
            return Err("A capture is already running; stop it before starting another".into());
        }
        let id = new_id();
        let session_name = format!("ProgramMicroscope-{id}");
        let collector_path = path.to_owned();
        let staging = self.trace_dir.join("pending");
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let output = staging.join(format!("{id}.json"));
        let mut child = OwnedChild(
            command(path)
                .env("MICROSCOPE_SESSION_NAME", &session_name)
                .args([
                    "--pid",
                    &pid.to_string(),
                    "--duration",
                    &duration.to_string(),
                    "--out",
                ])
                .arg(&output)
                .spawn()
                .map_err(|e| format!("Cannot start collector: {e}"))?,
        );
        let stdin = child
            .0
            .stdin
            .take()
            .ok_or("Collector control input unavailable")?;
        let stderr = drain(
            child
                .0
                .stderr
                .take()
                .ok_or("Collector stderr unavailable")?,
            DIAGNOSTIC_LIMIT,
        );
        let stdout = drain(
            child
                .0
                .stdout
                .take()
                .ok_or("Collector stdout unavailable")?,
            DIAGNOSTIC_LIMIT,
        );
        let (control, receiver) = mpsc::channel();
        let state = CaptureStatus {
            id: id.clone(),
            status: "running".into(),
            ready: false,
            trace: None,
            error: None,
            persisted: false,
        };
        sessions.active = Some(Active {
            id: id.clone(),
            control,
            stdout: stdout.clone(),
        });
        sessions.history.push_back(state.clone());
        while sessions.history.len() > 32 {
            sessions.history.pop_front();
        }
        let shared = self.sessions.clone();
        let root = self.trace_dir.clone();
        thread::spawn(move || {
            let collected = collect(&mut child, stdin, receiver, duration, &stderr);
            // Ensure the process has exited before inspecting its output, including error paths.
            drop(child);
            let collected =
                collected.map_err(
                    |error| match cleanup_session(&collector_path, &session_name) {
                        Ok(()) => error,
                        Err(cleanup_error) => {
                            format!("{error}; targeted ETW session cleanup failed: {cleanup_error}")
                        }
                    },
                );
            let result = persist_capture(&root, &output, &id, collected);
            let _ = fs::remove_file(&output);
            if let Ok(mut sessions) = shared.lock() {
                if let Some(state) = sessions.history.iter_mut().find(|s| s.id == id) {
                    state.ready = collector_ready(&stdout);
                    match result {
                        Ok((status, error)) => {
                            state.status = status;
                            state.error = error;
                            state.persisted = true;
                        }
                        Err(error) => {
                            state.status = "failed".into();
                            state.error = Some(error);
                        }
                    }
                }
                if sessions.active.as_ref().is_some_and(|s| s.id == id) {
                    sessions.active = None;
                }
            }
        });
        Ok(state)
    }
    pub fn capture_status(&self, id: &str) -> Result<CaptureStatus, String> {
        trace_store::validate_id(id)?;
        let mut view = self
            .sessions
            .lock()
            .map_err(|_| "Capture coordinator unavailable")?
            .history
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or("Unknown capture session")?;
        if view.status == "running" {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Capture coordinator unavailable")?;
            if let Some(active) = sessions.active.as_ref().filter(|s| s.id == id) {
                view.ready = collector_ready(&active.stdout);
            }
        }
        if view.status != "running" && view.persisted {
            view.trace = Some(trace_store::load(&self.trace_dir, id)?);
        }
        Ok(view)
    }
    pub fn stop(&self, id: &str) -> Result<CaptureStatus, String> {
        trace_store::validate_id(id)?;
        {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Capture coordinator unavailable")?;
            if let Some(active) = sessions.active.as_ref().filter(|s| s.id == id) {
                // Closed control means the worker has already observed process exit; polling resolves it.
                let _ = active.control.send(Control::Stop);
            } else if !sessions.history.iter().any(|s| s.id == id) {
                return Err("Unknown capture session".into());
            }
        }
        self.capture_status(id)
    }
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.shutting_down = true;
            if let Some(active) = &sessions.active {
                let _ = active.control.send(Control::Shutdown);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(SHUTDOWN_WAIT_SECONDS);
        while Instant::now() < deadline {
            if self
                .sessions
                .lock()
                .map(|s| s.active.is_none())
                .unwrap_or(true)
            {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
fn process_rows(value: &Value) -> Result<Vec<Value>, String> {
    let rows = value
        .as_array()
        .ok_or("Collector process response must be an array")?;
    if rows.len() > 100000 {
        return Err("Process list exceeds limit".into());
    }
    for row in rows {
        if !row["pid"].as_u64().is_some_and(|n| n <= u32::MAX as u64)
            || !["name", "path", "arch"]
                .iter()
                .all(|key| row[*key].is_string())
        {
            return Err("Collector returned an invalid process row".into());
        }
    }
    Ok(rows
        .iter()
        .filter(|row| row["pid"].as_u64() != Some(0))
        .cloned()
        .collect())
}
fn cleanup_session(path: &Path, session: &str) -> Result<(), String> {
    let id = session
        .strip_prefix("ProgramMicroscope-")
        .ok_or("Refusing cleanup of a session outside Program Microscope")?;
    trace_store::validate_id(id)?;
    let result = query_args(path, &["--stop-session", session])?;
    if result["stopped"].as_bool() == Some(true) {
        Ok(())
    } else {
        Err(format!("Collector did not confirm cleanup: {result}"))
    }
}
fn persist_capture(
    root: &Path,
    output: &Path,
    id: &str,
    collected: Result<(), String>,
) -> Result<(String, Option<String>), String> {
    let mut error = collected.err();
    let mut trace = trace_store::read_file(output).map_err(|trace_error| match &error {
        Some(error) => format!("{error}; no valid trace was produced: {trace_error}"),
        None => trace_error,
    })?;
    trace["run"]["id"] = Value::String(id.to_owned());
    if trace["run"]["status"] == "running" {
        error.get_or_insert_with(|| "Collector exited but trace was still marked running".into());
    }
    if let Some(error) = &error {
        trace["run"]["status"] = Value::String("failed".into());
        let diagnostics = trace
            .as_object_mut()
            .unwrap()
            .entry("diagnostics")
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut()
            .unwrap();
        if diagnostics.len() < trace_store::MAX_ROWS {
            diagnostics.push(
                serde_json::json!({"severity":"error","source":"desktop runtime","message":error}),
            );
        }
    }
    trace_store::save(root, &trace).map_err(|save_error| match &error {
        Some(error) => format!("{error}; could not preserve the partial trace: {save_error}"),
        None => save_error,
    })?;
    Ok((trace["run"]["status"].as_str().unwrap().to_owned(), error))
}
impl Drop for RuntimeEngine {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn collect(
    child: &mut OwnedChild,
    mut stdin: impl Write,
    receiver: mpsc::Receiver<Control>,
    duration: u32,
    stderr: &Arc<Mutex<Vec<u8>>>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(duration as u64 + 30);
    let mut stop_deadline = None;
    loop {
        if let Some(status) = child
            .0
            .try_wait()
            .map_err(|e| format!("Cannot poll collector: {e}"))?
        {
            return if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "Collector exited with {status}: {}",
                    diagnostics(stderr)
                ))
            };
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(control) => {
                let _ = control;
                if stop_deadline.is_none() {
                    if let Err(error) = stdin.write_all(b"stop\n").and_then(|_| stdin.flush()) {
                        if child.0.try_wait().map_err(|e| e.to_string())?.is_none() {
                            return Err(format!("Could not request graceful stop: {error}"));
                        }
                    }
                    stop_deadline = Some(Instant::now() + Duration::from_secs(STOP_GRACE_SECONDS));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) if stop_deadline.is_none() => {
                let _ = stdin.write_all(b"stop\n");
                let _ = stdin.flush();
                stop_deadline = Some(Instant::now() + Duration::from_secs(STOP_GRACE_SECONDS));
            }
            _ => {}
        }
        if Instant::now() >= deadline
            || stop_deadline.is_some_and(|deadline| Instant::now() >= deadline)
        {
            let _ = child.0.kill();
            let _ = child.0.wait();
            return Err(format!(
                "Collector did not finish before its deadline; process was terminated. {}",
                diagnostics(stderr)
            ));
        }
    }
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn real_child_rejects_concurrent_capture_and_stops_via_stdin() {
        let root = std::env::temp_dir().join(new_id());
        fs::create_dir_all(&root).unwrap();
        let sample = root.join("sample.json");
        fs::write(&sample, include_bytes!("../../trace/sample-normal.json")).unwrap();
        let script = root.join("collector");
        fs::write(&script,format!("#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = --out ]; then shift; output=$1; fi; shift; done\nread line\nif [ \"$line\" != stop ]; then exit 3; fi\ncp '{}' \"$output\"\n",sample.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let engine = RuntimeEngine::new(root.join("traces"), Some(script.clone()));
        let state = engine.start_program(&script, 1, 1).unwrap();
        assert!(engine.start_program(&script, 1, 1).is_err());
        engine.stop(&state.id).unwrap();
        engine.stop(&state.id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = engine.capture_status(&state.id).unwrap();
            if status.status != "running" {
                assert_eq!(status.status, "completed", "{:?}", status.error);
                assert_eq!(status.trace.unwrap()["run"]["id"], state.id);
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(trace_store::list(&engine.trace_dir).unwrap().len(), 1);
        let next = engine.start_program(&script, 1, 1).unwrap();
        assert_ne!(next.id, state.id);
        engine.shutdown();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shutdown_prevents_a_late_capture_from_being_orphaned() {
        let root = std::env::temp_dir().join(new_id());
        let engine = RuntimeEngine::new(root.clone(), None);
        engine.shutdown();
        assert!(engine.start_program(Path::new("/bin/false"), 1, 1).is_err());
        assert!(!root.exists());
    }
    #[test]
    fn queries_drain_large_diagnostics_and_reject_invalid_json() {
        let root = std::env::temp_dir().join(new_id());
        fs::create_dir_all(&root).unwrap();
        let script = root.join("query");
        fs::write(
            &script,
            "#!/bin/sh\nhead -c 200000 /dev/zero >&2\necho '[]'\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            query(&script, "--list-processes").unwrap(),
            serde_json::json!([])
        );
        fs::write(&script, "#!/bin/sh\necho invalid\n").unwrap();
        assert!(query(&script, "--capabilities").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_collector_retains_valid_partial_trace_and_diagnostics() {
        let root = std::env::temp_dir().join(new_id());
        fs::create_dir_all(&root).unwrap();
        let sample = root.join("partial.json");
        let mut partial: Value =
            serde_json::from_slice(include_bytes!("../../trace/sample-normal.json")).unwrap();
        partial["run"]["status"] = serde_json::json!("failed");
        partial["diagnostics"] = serde_json::json!([{"severity":"error","source":"ETW","message":"provider interrupted"}]);
        fs::write(&sample, serde_json::to_vec(&partial).unwrap()).unwrap();
        let script = root.join("collector");
        fs::write(&script,format!("#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = --out ]; then shift; output=$1; fi; shift; done\ncp '{}' \"$output\"\necho 'ETW failed after observation' >&2\nexit 7\n",sample.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let engine = RuntimeEngine::new(root.join("traces"), None);
        let state = engine.start_program(&script, 1, 1).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let result = engine.capture_status(&state.id).unwrap();
            if result.status != "running" {
                assert_eq!(result.status, "failed");
                assert!(result.error.is_some());
                let trace = result
                    .trace
                    .expect("valid partial evidence must remain inspectable");
                assert_eq!(trace["run"]["status"], "failed");
                assert_eq!(trace["events"], partial["events"]);
                assert_eq!(trace["diagnostics"][0]["message"], "provider interrupted");
                assert_eq!(trace_store::list(&engine.trace_dir).unwrap().len(), 1);
                assert_eq!(
                    trace_store::load(&engine.trace_dir, &state.id).unwrap(),
                    trace
                );
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn child_failure_is_terminal_and_releases_active_slot() {
        let root = std::env::temp_dir().join(new_id());
        fs::create_dir_all(&root).unwrap();
        let engine = RuntimeEngine::new(root.clone(), None);
        let state = engine.start_program(Path::new("/bin/false"), 1, 1).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let status = engine.capture_status(&state.id).unwrap();
            if status.status != "running" {
                assert_eq!(status.status, "failed");
                assert!(status.error.is_some());
                assert!(status.trace.is_none());
                assert!(trace_store::list(&engine.trace_dir).unwrap().is_empty());
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        }
        assert!(engine.start_program(Path::new("/bin/false"), 1, 1).is_ok());
        engine.shutdown();
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod completion_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn system_idle_pid_zero_is_omitted_but_malformed_rows_still_fail() {
        let valid = json!([{"pid":0,"name":"Idle","path":"","arch":"unknown"},{"pid":42,"name":"Probe","path":"C:\\Probe.exe","arch":"x64"}]);
        let rows = process_rows(&valid).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["pid"], 42);
        let invalid = json!([{"pid":0,"name":"Idle","path":"","arch":"unknown"},{"pid":"42","name":"bad","path":"","arch":"unknown"}]);
        assert!(process_rows(&invalid).is_err());
    }
    #[test]
    fn malformed_failure_output_retains_the_error_without_saving_a_trace() {
        let root = std::env::temp_dir().join(new_id());
        fs::create_dir_all(&root).unwrap();
        let output = root.join("broken.json");
        fs::write(&output, b"broken JSON").unwrap();
        let error = persist_capture(
            &root.join("traces"),
            &output,
            "failed-id",
            Err("collector exit 7".into()),
        )
        .unwrap_err();
        assert!(error.contains("collector exit 7"));
        assert!(error.contains("Invalid trace JSON"));
        assert!(trace_store::list(&root.join("traces")).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, unix))]
mod cleanup_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn targeted_cleanup_passes_owned_session_as_an_argument() {
        let root = std::env::temp_dir().join(new_id());
        fs::create_dir_all(&root).unwrap();
        let script = root.join("cleanup");
        fs::write(&script,"#!/bin/sh\nif [ \"$1\" = --stop-session ] && [ \"$2\" = ProgramMicroscope-owned ]; then echo '{\"stopped\":true}'; else exit 9; fi\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(cleanup_session(&script, "ProgramMicroscope-owned").is_ok());
        assert!(cleanup_session(&script, "OtherApplication-session").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, windows))]
mod windows_cleanup_tests {
    use super::*;
    struct SessionCleanup {
        collector: PathBuf,
        name: String,
    }
    impl Drop for SessionCleanup {
        fn drop(&mut self) {
            let _ = cleanup_session(&self.collector, &self.name);
        }
    }
    #[test]
    fn windows_forced_collector_exit_cleans_owned_etw_session() {
        let Some(collector) = std::env::var_os("MICROSCOPE_TEST_COLLECTOR") else {
            eprintln!(
                "Windows forced-exit cleanup test not requested: set MICROSCOPE_TEST_COLLECTOR"
            );
            return;
        };
        let collector = PathBuf::from(collector);
        let root = std::env::temp_dir().join(new_id());
        fs::create_dir_all(&root).unwrap();
        let session_name = format!("ProgramMicroscope-{}", new_id());
        // Drop order ensures a failed assertion first kills the child, then removes its ETW session.
        let cleanup = SessionCleanup {
            collector: collector.clone(),
            name: session_name.clone(),
        };
        let mut child = OwnedChild(
            command(&collector)
                .env("MICROSCOPE_SESSION_NAME", &session_name)
                .args([
                    "--pid",
                    &std::process::id().to_string(),
                    "--duration",
                    "60",
                    "--out",
                ])
                .arg(root.join("forced.json"))
                .spawn()
                .unwrap(),
        );
        let output = drain(child.0.stdout.take().unwrap(), DIAGNOSTIC_LIMIT);
        let errors = drain(child.0.stderr.take().unwrap(), DIAGNOSTIC_LIMIT);
        let deadline = Instant::now() + Duration::from_secs(25);
        while !collector_ready(&output) {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "{}",
                diagnostics(&errors)
            );
            assert!(Instant::now() < deadline, "Collector never became ready");
            thread::sleep(Duration::from_millis(50));
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        cleanup_session(&collector, &session_name).unwrap();
        let absent = query_args(&collector, &["--stop-session", &session_name]).unwrap();
        assert_eq!(absent["stopped"], true);
        assert!(
            absent["reason"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains("absent"),
            "{absent}"
        );
        drop(child);
        drop(cleanup);
        fs::remove_dir_all(root).unwrap();
    }
}
