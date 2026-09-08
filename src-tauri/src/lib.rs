mod pe;
mod runtime;
mod trace_store;

use runtime::{CaptureStatus, RuntimeEngine, RuntimeStatus};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use tauri::{Manager, State};

async fn background<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("Native worker failed: {e}"))?
}
#[tauri::command]
async fn runtime_status(engine: State<'_, Arc<RuntimeEngine>>) -> Result<RuntimeStatus, String> {
    let engine = engine.inner().clone();
    background(move || Ok(engine.status())).await
}
#[tauri::command]
async fn list_processes(engine: State<'_, Arc<RuntimeEngine>>) -> Result<Vec<Value>, String> {
    let engine = engine.inner().clone();
    background(move || engine.list_processes()).await
}
#[tauri::command]
async fn start_capture(
    engine: State<'_, Arc<RuntimeEngine>>,
    pid: u32,
    duration_seconds: u32,
) -> Result<CaptureStatus, String> {
    let engine = engine.inner().clone();
    background(move || engine.start(pid, duration_seconds)).await
}
#[tauri::command]
async fn capture_status(
    engine: State<'_, Arc<RuntimeEngine>>,
    id: String,
) -> Result<CaptureStatus, String> {
    let engine = engine.inner().clone();
    background(move || engine.capture_status(&id)).await
}
#[tauri::command]
async fn stop_capture(
    engine: State<'_, Arc<RuntimeEngine>>,
    id: String,
) -> Result<CaptureStatus, String> {
    let engine = engine.inner().clone();
    background(move || engine.stop(&id)).await
}
#[tauri::command]
async fn list_traces(engine: State<'_, Arc<RuntimeEngine>>) -> Result<Vec<Value>, String> {
    let engine = engine.inner().clone();
    background(move || trace_store::list(&engine.trace_dir)).await
}
#[tauri::command]
async fn load_trace(engine: State<'_, Arc<RuntimeEngine>>, id: String) -> Result<Value, String> {
    let engine = engine.inner().clone();
    background(move || trace_store::load(&engine.trace_dir, &id)).await
}
#[tauri::command]
async fn save_trace(engine: State<'_, Arc<RuntimeEngine>>, trace: Value) -> Result<Value, String> {
    let engine = engine.inner().clone();
    background(move || trace_store::save(&engine.trace_dir, &trace)).await
}
#[tauri::command]
async fn inspect_pe(path: String) -> Result<Value, String> {
    background(move || pe::inspect(&PathBuf::from(path))).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let trace_dir = app.path().app_data_dir()?.join("traces");
            let resource_dir = app.path().resource_dir().ok();
            let collector = runtime::discover_collector(resource_dir.as_deref());
            app.manage(Arc::new(RuntimeEngine::new(trace_dir, collector)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            list_processes,
            start_capture,
            capture_status,
            stop_capture,
            list_traces,
            load_trace,
            save_trace,
            inspect_pe
        ])
        .build(tauri::generate_context!())
        .expect("error while building Program Microscope");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            handle.state::<Arc<RuntimeEngine>>().shutdown();
        }
    });
}
