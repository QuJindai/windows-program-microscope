//! Bounded, validated MTP persistence. Caller-controlled paths never enter this API.
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_TRACE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ROWS: usize = 100_000;
const REQUIRED: &[&str] = &[
    "nodes", "threads", "events", "values", "edges", "evidence", "io",
];
const OPTIONAL: &[&str] = &[
    "changes",
    "counters",
    "capabilities",
    "resources",
    "diagnostics",
];

pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Trace identifier must contain 1–96 ASCII letters, digits, '-' or '_'".into());
    }
    let upper = id.to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$"].contains(&upper.as_str())
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit())
    {
        return Err("Reserved Windows file identifier".into());
    }
    Ok(())
}
fn array<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    v.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} must be an array"))
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|x| !x.trim().is_empty() && x.len() <= 65536)
        .ok_or_else(|| format!("{key} must be a nonempty bounded string"))
}
fn number(v: &Value, key: &str, required: bool) -> Result<(), String> {
    match v.get(key) {
        None | Some(Value::Null) if !required => Ok(()),
        Some(value) if value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) => Ok(()),
        _ => Err(format!("{key} must be a finite nonnegative number")),
    }
}
fn reference(v: &Value, key: &str, ids: &HashSet<String>) -> Result<(), String> {
    if let Some(value) = v.get(key).filter(|v| !v.is_null()) {
        let id = value
            .as_str()
            .ok_or_else(|| format!("{key} must be a string"))?;
        if !ids.contains(id) {
            return Err(format!("Unknown {key}: {id}"));
        }
    }
    Ok(())
}
fn thread_id(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|v| !v.trim().is_empty() && v.len() <= 65536)
        .map(str::to_owned)
        .or_else(|| v.as_u64().map(|v| v.to_string()))
}

pub fn validate(trace: &Value) -> Result<(), String> {
    if trace.get("schema_version").and_then(Value::as_str) != Some("0.1") {
        return Err("Unsupported MTP schema_version (expected 0.1)".into());
    }
    let run = trace
        .get("run")
        .filter(|v| v.is_object())
        .ok_or("run must be an object")?;
    validate_id(string(run, "id")?)?;
    string(run, "name")?;
    if !["running", "completed", "failed", "cancelled"].contains(&string(run, "status")?) {
        return Err("Invalid run.status".into());
    }
    if !["observe", "deep_trace", "time_travel"].contains(&string(run, "capture_mode")?) {
        return Err("Invalid capture_mode".into());
    }
    number(run, "duration_ms", true)?;
    for key in ["target", "summary"] {
        if !run.get(key).is_some_and(Value::is_object) {
            return Err(format!("run.{key} must be an object"));
        }
    }
    for key in REQUIRED
        .iter()
        .chain(OPTIONAL.iter().filter(|key| trace.get(**key).is_some()))
    {
        let rows = array(trace, key)?;
        if rows.len() > MAX_ROWS {
            return Err(format!("{key} exceeds {MAX_ROWS} rows"));
        }
        if rows.iter().any(|row| !row.is_object()) {
            return Err(format!("{key} rows must be objects"));
        }
    }
    let mut graph = HashSet::new();
    let mut evidence = HashSet::new();
    let mut threads = HashSet::new();
    for key in ["nodes", "events", "values", "io", "resources"] {
        if let Some(rows) = trace.get(key).and_then(Value::as_array) {
            for row in rows {
                let id = string(row, "id")?;
                if !graph.insert(id.to_owned()) {
                    return Err(format!("Duplicate graph identifier: {id}"));
                }
            }
        }
    }
    let nodes: HashSet<String> = array(trace, "nodes")?
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect();
    let events: HashSet<String> = array(trace, "events")?
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect();
    let resources: HashSet<String> = trace
        .get("resources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect();
    for row in array(trace, "evidence")? {
        let id = string(row, "id")?;
        if !evidence.insert(id.to_owned()) {
            return Err(format!("Duplicate evidence identifier: {id}"));
        }
        if !["REAL", "DERIVED", "UNAVAILABLE", "DEBUG_ONLY"].contains(&string(row, "truth")?) {
            return Err("Invalid evidence.truth".into());
        }
        string(row, "source")?;
        string(row, "detail")?;
    }
    for row in array(trace, "threads")? {
        let id =
            thread_id(&row["id"]).ok_or("Thread id must be a nonnegative integer or string")?;
        if !threads.insert(id) {
            return Err("Duplicate thread identifier".into());
        }
        number(row, "cpu_ms", false)?;
    }
    for row in array(trace, "nodes")? {
        string(row, "kind")?;
        string(row, "label")?;
        if let Some(status) = row.get("status") {
            if !status
                .as_str()
                .is_some_and(|s| ["executed", "skipped", "unknown"].contains(&s))
            {
                return Err("Invalid node.status".into());
            }
        }
    }
    for row in array(trace, "values")? {
        string(row, "name")?;
        if row.get("type").is_some_and(|v| !v.is_string()) {
            return Err("Value type must be a string".into());
        }
    }
    for row in array(trace, "events")? {
        for key in ["kind", "label", "status"] {
            string(row, key)?;
        }
        number(row, "start_ms", true)?;
        number(row, "duration_ms", false)?;
        if row.get("details").is_some_and(|v| !v.is_object()) {
            return Err("Event details must be an object".into());
        }
    }
    for row in array(trace, "io")? {
        string(row, "operation")?;
        if row.get("type").is_some() {
            string(row, "type")?;
        } else {
            string(row, "kind")?;
        }
        number(row, "start_ms", true)?;
        number(row, "duration_ms", false)?;
    }
    let values: HashSet<String> = array(trace, "values")?
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    let io: HashSet<String> = array(trace, "io")?
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    let all_edges: HashSet<String> = array(trace, "edges")?
        .iter()
        .map(|row| string(row, "id").map(str::to_owned))
        .collect::<Result<_, _>>()?;
    for key in REQUIRED
        .iter()
        .chain(OPTIONAL.iter().filter(|key| trace.get(**key).is_some()))
    {
        for row in array(trace, key)? {
            for (single, plural, ids) in [
                ("node_id", "node_ids", &nodes),
                ("event_id", "event_ids", &events),
                ("resource_id", "resource_ids", &resources),
                ("value_id", "value_ids", &values),
                ("io_id", "io_ids", &io),
                ("edge_id", "edge_ids", &all_edges),
                ("evidence_id", "evidence_ids", &evidence),
            ] {
                reference(row, single, ids)?;
                if let Some(references) = row.get(plural) {
                    for id in references
                        .as_array()
                        .ok_or_else(|| format!("{plural} must be an array"))?
                    {
                        if !id.as_str().is_some_and(|id| ids.contains(id)) {
                            return Err(format!("Unknown {plural} reference"));
                        }
                    }
                }
            }
            if let Some(id) = row.get("thread_id").filter(|v| !v.is_null()) {
                if !thread_id(id).is_some_and(|id| threads.contains(&id)) {
                    return Err("Unknown thread_id".into());
                }
            }
            if let Some(ids) = row.get("thread_ids") {
                for id in ids.as_array().ok_or("thread_ids must be an array")? {
                    if !thread_id(id).is_some_and(|id| threads.contains(&id)) {
                        return Err("Unknown thread_ids reference".into());
                    }
                }
            }
            for key in [
                "bytes",
                "bytes_received",
                "bytes_sent",
                "at_ms",
                "start_ms",
                "duration_ms",
                "timestamp_ms",
            ] {
                number(row, key, false)?;
            }
        }
    }
    let mut edge_ids = HashSet::new();
    for row in array(trace, "edges")? {
        let id = string(row, "id")?;
        if !edge_ids.insert(id) {
            return Err("Duplicate edge identifier".into());
        }
        for key in ["from", "to"] {
            string(row, key)?;
            reference(row, key, &graph)?;
        }
        string(row, "type")?;
    }
    if let Some(rows) = trace.get("counters").and_then(Value::as_array) {
        let mut ids = HashSet::new();
        let mut sample_count = 0;
        for row in rows {
            if !ids.insert(string(row, "id")?) {
                return Err("Duplicate counter identifier".into());
            }
            string(row, "name")?;
            string(row, "unit")?;
            let samples = array(row, "samples")?;
            sample_count += samples.len();
            if sample_count > MAX_ROWS {
                return Err("Counters exceed total sample limit".into());
            }
            let mut previous = 0.0;
            for sample in samples {
                number(sample, "timestamp_ms", true)?;
                let timestamp = sample["timestamp_ms"].as_f64().unwrap();
                if timestamp < previous {
                    return Err("Counter sample timestamps must be ordered".into());
                }
                previous = timestamp;
                if !sample["value"].as_f64().is_some_and(f64::is_finite) {
                    return Err("Counter value must be finite".into());
                }
            }
        }
    }
    if let Some(rows) = trace.get("capabilities").and_then(Value::as_array) {
        let mut ids = HashSet::new();
        for row in rows {
            if !ids.insert(string(row, "id")?) {
                return Err("Duplicate capability identifier".into());
            }
            if !row.get("available").is_some_and(Value::is_boolean) {
                return Err("Capability available must be boolean".into());
            }
        }
    }
    Ok(())
}
fn path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(root.join(format!("{id}.mtp.json")))
}
pub fn read_file(file: &Path) -> Result<Value, String> {
    let metadata = fs::metadata(file).map_err(|e| format!("Cannot read trace: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_TRACE_BYTES {
        return Err("Trace must be a regular file of at most 64 MiB".into());
    }
    let file = File::open(file).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_TRACE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_TRACE_BYTES {
        return Err("Trace exceeds 64 MiB".into());
    }
    let trace: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid trace JSON: {e}"))?;
    validate(&trace)?;
    Ok(trace)
}
pub fn load(root: &Path, id: &str) -> Result<Value, String> {
    read_file(&path(root, id)?)
}
pub fn save(root: &Path, trace: &Value) -> Result<Value, String> {
    validate(trace)?;
    let bytes = serde_json::to_vec(trace).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_TRACE_BYTES {
        return Err("Trace exceeds 64 MiB".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let dest = path(root, trace["run"]["id"].as_str().unwrap())?;
    let temp = root.join(format!(".{}.tmp", super::runtime::new_id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, &dest).map_err(|e| format!("Cannot commit trace: {e}"))?;
        #[cfg(unix)]
        File::open(root)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(trace["run"].clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn list(root: &Path) -> Result<Vec<Value>, String> {
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut runs = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".mtp.json") && entry.file_type().map_err(|e| e.to_string())?.is_file() {
            if runs.len() >= 1000 {
                return Err("Trace catalog exceeds 1000 entries".into());
            }
            runs.push(read_file(&entry.path())?["run"].clone());
        }
    }
    runs.sort_by(|a, b| {
        b.get("started_at")
            .and_then(Value::as_str)
            .cmp(&a.get("started_at").and_then(Value::as_str))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    Ok(runs)
}
