#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rayon::{ThreadPool, ThreadPoolBuilder};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::Emitter;
use tauri::ipc::Response;

static SLICER_POOL: OnceLock<ThreadPool> = OnceLock::new();
static CANCEL_FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();

fn slicer_pool() -> &'static ThreadPool {
    SLICER_POOL.get_or_init(|| {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        ThreadPoolBuilder::new()
            .thread_name(|i| format!("dragonfruit-slicer-{i}"))
            .num_threads(threads)
            .build()
            .expect("failed to create slicer rayon thread pool")
    })
}

fn cancel_flag() -> &'static Arc<AtomicBool> {
    CANCEL_FLAG.get_or_init(|| Arc::new(AtomicBool::new(false)))
}

#[derive(Clone, Serialize)]
struct SliceProgressPayload {
    done: u32,
    total: u32,
}

#[tauri::command]
async fn slice_solid_native(
    window: tauri::Window,
    job_json: String,
) -> Result<Response, String> {
    let flag = cancel_flag().clone();
    flag.store(false, Ordering::SeqCst);

    let win = window.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let progress_cb: dragonfruit_slicer::ProgressCallback =
            Box::new(move |done: u32, total: u32| {
                let _ = win.emit("slicer://progress", SliceProgressPayload { done, total });
            });

        slicer_pool().install(|| {
            dragonfruit_slicer::slice_solid_and_encode_native_json_with_progress(
                &job_json,
                Some(progress_cb),
                Some(&flag),
            )
        })
    })
    .await
    .map_err(|err| format!("Native slicer task failed to join: {err}"))??;

    Ok(Response::new(bytes))
}

#[tauri::command]
async fn cancel_slicing() -> Result<(), String> {
    cancel_flag().store(true, Ordering::SeqCst);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![slice_solid_native, cancel_slicing])
        .run(tauri::generate_context!())
        .expect("error while running DragonFruit desktop app");
}
