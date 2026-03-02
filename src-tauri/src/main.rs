#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rayon::{ThreadPool, ThreadPoolBuilder};
use std::sync::OnceLock;

static SLICER_POOL: OnceLock<ThreadPool> = OnceLock::new();

fn slicer_pool() -> &'static ThreadPool {
    SLICER_POOL.get_or_init(|| {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        ThreadPoolBuilder::new()
            .thread_name(|i| format!("dragonfruit-slicer-{i}"))
            .num_threads(threads)
            .build()
            .expect("failed to create slicer rayon thread pool")
    })
}

#[tauri::command]
async fn slice_solid_native(job_json: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        slicer_pool().install(|| dragonfruit_slicer::slice_solid_and_encode_native_json(&job_json))
    })
    .await
    .map_err(|err| format!("Native slicer task failed to join: {err}"))?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![slice_solid_native])
        .run(tauri::generate_context!())
        .expect("error while running DragonFruit desktop app");
}
