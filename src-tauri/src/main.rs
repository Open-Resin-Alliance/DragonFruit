#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rayon::{ThreadPool, ThreadPoolBuilder};
use serde::Deserialize;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSliceTempPathResult {
    temp_path: String,
    byte_len: u64,
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
                job_json,
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
async fn slice_solid_native_to_temp_path(
    window: tauri::Window,
    job_json: String,
) -> Result<NativeSliceTempPathResult, String> {
    let flag = cancel_flag().clone();
    flag.store(false, Ordering::SeqCst);

    let win = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let progress_cb: dragonfruit_slicer::ProgressCallback =
            Box::new(move |done: u32, total: u32| {
                let _ = win.emit("slicer://progress", SliceProgressPayload { done, total });
            });

        slicer_pool().install(|| {
            dragonfruit_slicer::slice_solid_and_encode_native_json_to_temp_path_with_progress(
                job_json,
                Some(progress_cb),
                Some(&flag),
            )
        })
    })
    .await
    .map_err(|err| format!("Native slicer task failed to join: {err}"))??;

    Ok(NativeSliceTempPathResult {
        temp_path: result.0,
        byte_len: result.1,
    })
}

#[tauri::command]
async fn cancel_slicing() -> Result<(), String> {
    cancel_flag().store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePrintFileArgs {
    default_filename: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePrintFileFromPathArgs {
    default_filename: String,
    source_path: String,
}

#[tauri::command]
async fn save_print_file(args: SavePrintFileArgs) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let suggested_name = {
            let trimmed = args.default_filename.trim();
            if trimmed.is_empty() {
                "slice_export.nanodlp".to_string()
            } else {
                trimmed.to_string()
            }
        };

        let picked = rfd::FileDialog::new()
            .set_file_name(&suggested_name)
            .save_file()
            .ok_or_else(|| "Save cancelled by user".to_string())?;

        if let Some(parent) = picked.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Failed creating destination folder: {err}"))?;
        }

        std::fs::write(&picked, &args.bytes)
            .map_err(|err| format!("Failed saving print file: {err}"))?;

        Ok(picked.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| format!("Save task failed to join: {err}"))?
}

#[tauri::command]
async fn save_print_file_from_path(args: SavePrintFileFromPathArgs) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let suggested_name = {
            let trimmed = args.default_filename.trim();
            if trimmed.is_empty() {
                "slice_export.nanodlp".to_string()
            } else {
                trimmed.to_string()
            }
        };

        let source = std::path::PathBuf::from(args.source_path.trim());
        if !source.exists() {
            return Err("Source print file no longer exists on disk".to_string());
        }

        let picked = rfd::FileDialog::new()
            .set_file_name(&suggested_name)
            .save_file()
            .ok_or_else(|| "Save cancelled by user".to_string())?;

        if let Some(parent) = picked.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Failed creating destination folder: {err}"))?;
        }

        std::fs::copy(&source, &picked)
            .map_err(|err| format!("Failed saving print file: {err}"))?;

        Ok(picked.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| format!("Save task failed to join: {err}"))?
}

#[tauri::command]
async fn read_print_file_bytes(source_path: String) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let source = std::path::PathBuf::from(source_path.trim());
        if !source.exists() {
            return Err("Source print file no longer exists on disk".to_string());
        }

        std::fs::read(&source).map_err(|err| format!("Failed reading print file: {err}"))
    })
    .await
    .map_err(|err| format!("Read task failed to join: {err}"))??;

    Ok(Response::new(bytes))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            slice_solid_native,
            slice_solid_native_to_temp_path,
            cancel_slicing,
            save_print_file,
            save_print_file_from_path,
            read_print_file_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running DragonFruit desktop app");
}
