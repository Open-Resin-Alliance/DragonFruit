#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod network;
fn default_minimum_aa_alpha_percent() -> f32 {
    35.0
}
mod plugin_registry;

use rayon::{ThreadPool, ThreadPoolBuilder};
use serde::Deserialize;
use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{InvokeBody, Response};
use tauri::Emitter;
use tauri::Manager;

fn temp_artifact_path(extension: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let clean_ext = extension.trim_start_matches('.');
    path.push(format!("dragonfruit-slice-{stamp}.{clean_ext}"));
    path
}

fn is_dragonfruit_temp_artifact(path: &std::path::Path) -> bool {
    let file_name_ok = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("dragonfruit-slice-"))
        .unwrap_or(false);
    let in_temp_dir = path.starts_with(std::env::temp_dir());
    file_name_ok && in_temp_dir
}

fn sweep_stale_temp_artifacts(max_age_seconds: u64) -> u32 {
    let mut removed = 0u32;
    let temp_dir = std::env::temp_dir();
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(max_age_seconds))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

    let entries = match std::fs::read_dir(&temp_dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_dragonfruit_temp_artifact(&path) {
            continue;
        }

        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|modified| modified <= cutoff)
            .unwrap_or(false);

        if stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }

    removed
}

fn sweep_all_temp_artifacts() -> u32 {
    let mut removed = 0u32;
    let temp_dir = std::env::temp_dir();
    let entries = match std::fs::read_dir(&temp_dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_dragonfruit_temp_artifact(&path) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }

    removed
}

fn build_save_dialog_with_filters(suggested_name: &str) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new().set_file_name(suggested_name);

    let maybe_ext = std::path::Path::new(suggested_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| !ext.is_empty());

    if let Some(ext) = maybe_ext.as_deref() {
        dialog = match ext {
            "stl" | "3mf" => dialog.add_filter("Mesh Files", &["stl", "3mf"]),
            "voxl" => dialog.add_filter("Scene Files", &["voxl"]),
            "lys" => dialog.add_filter("Scene Files", &["lys"]),
            "json" => dialog.add_filter("JSON Files", &["json"]),
            _ => dialog.add_filter("Print Files", &[ext]),
        };
    }

    dialog
}

static SLICER_POOL: OnceLock<ThreadPool> = OnceLock::new();
static CANCEL_FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();
static STAGED_MESH: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
static STAGED_MESH_STATS: OnceLock<Mutex<StageMeshStats>> = OnceLock::new();
static STAGED_MESH_FILE_PATH: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static STAGED_MESH_FILE_APPENDER: OnceLock<Mutex<Option<StageFileAppender>>> = OnceLock::new();
const STAGED_MESH_PREALLOC_MIN_BYTES: usize = 16 * 1024 * 1024;
const STAGED_MESH_PREALLOC_MAX_BYTES: usize = 1024 * 1024 * 1024;

struct StageFileAppender {
    path: String,
    writer: std::io::BufWriter<std::fs::File>,
    len: u64,
}

#[derive(Default)]
struct StageMeshStats {
    chunks_received: u64,
    append_ns_total: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageMeshChunkAck {
    chunk_bytes: u64,
    total_bytes: u64,
    capacity_bytes: u64,
    reserve_grew: bool,
    chunks_received: u64,
    append_ns: u64,
    append_ns_total: u64,
}

fn staged_mesh() -> &'static Mutex<Option<Vec<u8>>> {
    STAGED_MESH.get_or_init(|| Mutex::new(None))
}

fn staged_mesh_stats() -> &'static Mutex<StageMeshStats> {
    STAGED_MESH_STATS.get_or_init(|| Mutex::new(StageMeshStats::default()))
}

fn staged_mesh_file_path() -> &'static Mutex<Option<String>> {
    STAGED_MESH_FILE_PATH.get_or_init(|| Mutex::new(None))
}

fn staged_mesh_file_appender() -> &'static Mutex<Option<StageFileAppender>> {
    STAGED_MESH_FILE_APPENDER.get_or_init(|| Mutex::new(None))
}

fn resolve_mesh_stage_directory() -> std::path::PathBuf {
    let configured = std::env::var("DF_MESH_STAGE_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);

    configured.unwrap_or_else(std::env::temp_dir)
}

fn allocate_mesh_stage_file_path() -> Result<std::path::PathBuf, String> {
    let mut dir = resolve_mesh_stage_directory();
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Failed creating mesh stage directory '{}': {e}",
            dir.display()
        )
    })?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.push(format!("dragonfruit-mesh-stage-{stamp}.bin"));
    Ok(dir)
}

fn normalize_staged_mesh_prealloc_bytes(total_bytes_hint: usize) -> usize {
    total_bytes_hint
        .max(STAGED_MESH_PREALLOC_MIN_BYTES)
        .min(STAGED_MESH_PREALLOC_MAX_BYTES)
}

fn bytes_to_f32_vec(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err(format!(
            "Mesh binary length {} is not a multiple of 4 (f32 size)",
            bytes.len()
        ));
    }

    // Fast path on little-endian targets (Windows/macOS/Linux desktop):
    // memcpy raw bytes into a pre-sized Vec<f32> to avoid per-float conversion overhead.
    #[cfg(target_endian = "little")]
    {
        let count = bytes.len() / 4;
        let mut floats = vec![0.0f32; count];
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                floats.as_mut_ptr() as *mut u8,
                bytes.len(),
            );
        }
        return Ok(floats);
    }

    #[cfg(not(target_endian = "little"))]
    {
        let count = bytes.len() / 4;
        let mut floats = Vec::with_capacity(count);
        for chunk in bytes.chunks_exact(4) {
            floats.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        Ok(floats)
    }
}

fn bytes_into_f32_vec(bytes: Vec<u8>) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err(format!(
            "Mesh binary length {} is not a multiple of 4 (f32 size)",
            bytes.len()
        ));
    }

    #[cfg(target_endian = "little")]
    {
        let ptr_addr = bytes.as_ptr() as usize;
        let aligned_for_f32 = ptr_addr % std::mem::align_of::<f32>() == 0;
        let capacity_bytes = bytes.capacity();

        // Reinterpret in-place only when alignment and capacity permit exact Vec layout conversion.
        if aligned_for_f32 && (capacity_bytes % 4 == 0) {
            let mut bytes = std::mem::ManuallyDrop::new(bytes);
            let ptr = bytes.as_mut_ptr() as *mut f32;
            let len_f32 = bytes.len() / 4;
            let cap_f32 = bytes.capacity() / 4;
            let floats = unsafe { Vec::from_raw_parts(ptr, len_f32, cap_f32) };
            return Ok(floats);
        }

        return bytes_to_f32_vec(&bytes);
    }

    #[cfg(not(target_endian = "little"))]
    {
        bytes_to_f32_vec(&bytes)
    }
}

/// Metadata-only slice job (no inline triangles — those come from staged binary).
#[derive(Deserialize)]
struct MeshQuantizationMetadata {
    min_x: f32,
    min_y: f32,
    min_z: f32,
    max_x: f32,
    max_y: f32,
    max_z: f32,
}

#[derive(Deserialize)]
struct SliceJobMetadata {
    output_format: String,
    #[serde(default)]
    format_version: Option<String>,
    source_width_px: u32,
    source_height_px: u32,
    width_px: u32,
    height_px: u32,
    #[serde(default)]
    x_packing_mode: Option<String>,
    png_compression_strategy: String,
    anti_aliasing_level: String,
    aa_on_supports: bool,
    #[serde(default = "default_minimum_aa_alpha_percent")]
    minimum_aa_alpha_percent: f32,
    #[serde(default)]
    mirror_x: bool,
    #[serde(default)]
    mirror_y: bool,
    container_compression_level: u8,
    build_width_mm: f32,
    build_depth_mm: f32,
    layer_height_mm: f32,
    total_layers: u32,
    export_thumbnail_png_base64: Option<String>,
    #[serde(default)]
    mesh_encoding: Option<String>,
    #[serde(default)]
    mesh_quantization: Option<MeshQuantizationMetadata>,
    metadata_json: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSlicerPerfMetrics {
    total_ns: u64,
    index_build_ns: u64,
    render_wall_ns: u64,
    render_ns: u64,
    png_encode_ns: u64,
    archive_encode_ns: u64,
    layers: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSlicerRuntimeMetrics {
    pool_threads: u32,
    max_concurrent: u32,
    queue_buffer: u32,
    build_profile: String,
    artifact_dir: String,
    mesh_stage_dir: String,
    metadata_parse_ns: u64,
    mesh_decode_ns: u64,
    artifact_metadata_ns: u64,
    wrapper_total_ns: u64,
    wrapper_overhead_ns: u64,
}

fn duration_ns_u64(duration: std::time::Duration) -> u64 {
    duration.as_nanos().min(u64::MAX as u128) as u64
}

fn phase_to_label(phase: dragonfruit_slicer_v3::types::SliceProgressPhaseV3) -> &'static str {
    match phase {
        dragonfruit_slicer_v3::types::SliceProgressPhaseV3::Slicing => "Slicing",
        dragonfruit_slicer_v3::types::SliceProgressPhaseV3::Encoding => "Encoding",
        dragonfruit_slicer_v3::types::SliceProgressPhaseV3::Finalizing => "Finalizing",
    }
}

fn slicer_pool() -> &'static ThreadPool {
    SLICER_POOL.get_or_init(|| {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        ThreadPoolBuilder::new()
            .thread_name(|i| format!("dragonfruit-slicer-v3-{i}"))
            .num_threads(threads)
            .build()
            .expect("failed to create slicer rayon thread pool")
    })
}

fn decode_quantized_u16_mesh(
    bytes: &[u8],
    quant: &MeshQuantizationMetadata,
) -> Result<Vec<f32>, String> {
    if bytes.len() % 2 != 0 {
        return Err(format!(
            "Quantized mesh binary length {} is not a multiple of 2 (u16 size)",
            bytes.len()
        ));
    }

    let spans = [
        (quant.max_x - quant.min_x).max(0.0),
        (quant.max_y - quant.min_y).max(0.0),
        (quant.max_z - quant.min_z).max(0.0),
    ];
    let mins = [quant.min_x, quant.min_y, quant.min_z];
    let values = bytes.len() / 2;
    let mut floats = Vec::with_capacity(values);

    for (index, chunk) in bytes.chunks_exact(2).enumerate() {
        let q = u16::from_le_bytes([chunk[0], chunk[1]]);
        let axis = index % 3;
        let span = spans[axis];
        if span <= 0.0 || !span.is_finite() {
            floats.push(mins[axis]);
            continue;
        }

        let normalized = (q as f32) / 65_535.0;
        floats.push(mins[axis] + normalized * span);
    }

    Ok(floats)
}

fn decode_mesh_bytes(bytes: Vec<u8>, meta: &SliceJobMetadata) -> Result<Vec<f32>, String> {
    match meta.mesh_encoding.as_deref() {
        Some("quantized_u16") => {
            let quant = meta
                .mesh_quantization
                .as_ref()
                .ok_or("Quantized mesh encoding requires mesh_quantization metadata")?;
            decode_quantized_u16_mesh(&bytes, quant)
        }
        Some("raw_f32") | None => bytes_into_f32_vec(bytes),
        Some(other) => Err(format!("Unsupported mesh encoding: {other}")),
    }
}

fn cancel_flag() -> &'static Arc<AtomicBool> {
    CANCEL_FLAG.get_or_init(|| Arc::new(AtomicBool::new(false)))
}

/// Build a progress callback that throttles `window.emit` to at most ~60 fps.
///
/// The first event, any phase change, and the final event (done == total) are
/// always emitted immediately.  Intermediate updates are skipped if fewer than
/// 16 ms have elapsed since the last emit.
fn make_throttled_progress_cb(
    win: tauri::Window,
) -> dragonfruit_slicer_v3::types::ProgressCallbackV3 {
    use std::sync::Mutex;
    use std::time::Instant;

    struct State {
        last_emit: Instant,
        last_phase: String,
    }

    let state = Arc::new(Mutex::new(State {
        last_emit: Instant::now(),
        last_phase: String::new(),
    }));

    Arc::new(
        move |update: dragonfruit_slicer_v3::types::SliceProgressUpdateV3| {
            let phase = phase_to_label(update.phase).to_string();
            let is_final = update.done >= update.total;

            let should_emit = {
                let mut s = state.lock().unwrap();
                let phase_changed = s.last_phase != phase;
                let elapsed = s.last_emit.elapsed().as_millis() >= 8;

                if is_final || phase_changed || elapsed {
                    s.last_emit = Instant::now();
                    s.last_phase = phase.clone();
                    true
                } else {
                    false
                }
            };

            if should_emit {
                let _ = win.emit(
                    "slicer://progress",
                    SliceProgressPayload {
                        done: update.done,
                        total: update.total,
                        phase,
                    },
                );
            }
        },
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SliceProgressPayload {
    done: u32,
    total: u32,
    phase: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSliceTempPathResult {
    temp_path: String,
    byte_len: u64,
    perf: Option<NativeSlicerPerfMetrics>,
    runtime: NativeSlicerRuntimeMetrics,
}

fn v3_runtime_metrics(
    output_path: &std::path::Path,
    metadata_parse_ns: u64,
    mesh_decode_ns: u64,
    artifact_metadata_ns: u64,
    wrapper_total_ns: u64,
    wrapper_overhead_ns: u64,
) -> NativeSlicerRuntimeMetrics {
    let hw_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let max_concurrent = std::env::var("DF_V3_MAX_CONCURRENT")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(hw_threads)
        .clamp(1, hw_threads);
    let queue_buffer = (max_concurrent * 2).clamp(2, 16);

    let artifact_dir = output_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());

    let mesh_stage_dir = resolve_mesh_stage_directory().to_string_lossy().to_string();

    let build_profile = if cfg!(debug_assertions) {
        "debug".to_string()
    } else {
        "release".to_string()
    };

    NativeSlicerRuntimeMetrics {
        pool_threads: hw_threads as u32,
        max_concurrent: max_concurrent as u32,
        queue_buffer: queue_buffer as u32,
        build_profile,
        artifact_dir,
        mesh_stage_dir,
        metadata_parse_ns,
        mesh_decode_ns,
        artifact_metadata_ns,
        wrapper_total_ns,
        wrapper_overhead_ns,
    }
}

#[tauri::command]
async fn slice_solid_native(window: tauri::Window, job_json: String) -> Result<Response, String> {
    let flag = cancel_flag().clone();
    flag.store(false, Ordering::SeqCst);

    let win = window.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let job: dragonfruit_slicer_v3::types::SliceJobV3 = serde_json::from_str(&job_json)
            .map_err(|err| format!("Invalid SliceJobV3 JSON: {err}"))?;

        let progress_cb = make_throttled_progress_cb(win);

        slicer_pool().install(|| -> Result<Vec<u8>, String> {
            let artifact = dragonfruit_slicer_v3::slice_with_progress_v3(
                &job,
                Some(progress_cb),
                Some(flag.as_ref()),
            )
            .map_err(|err| format!("V3 slicing failed: {err}"))?;
            Ok(artifact.bytes)
        })
    })
    .await
    .map_err(|err| format!("Native slicer task failed to join: {err}"))??;

    Ok(Response::new(bytes))
}

/// Receive raw mesh bytes from the frontend via efficient binary IPC in chunks.
/// The bytes are stored in a pre-allocated memory vector and consumed by the next `slice_solid_native_to_temp_path` call.
#[tauri::command]
async fn stage_mesh_binary_start(total_bytes: usize) -> Result<(), String> {
    let reserve_bytes = normalize_staged_mesh_prealloc_bytes(total_bytes);
    *staged_mesh()
        .lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))? =
        Some(Vec::with_capacity(reserve_bytes));

    *staged_mesh_stats()
        .lock()
        .map_err(|e| format!("staged mesh stats lock poisoned: {e}"))? = StageMeshStats::default();

    *staged_mesh_file_path()
        .lock()
        .map_err(|e| format!("staged mesh file-path lock poisoned: {e}"))? = None;

    *staged_mesh_file_appender()
        .lock()
        .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))? = None;

    Ok(())
}

#[tauri::command]
async fn allocate_mesh_stage_path() -> Result<String, String> {
    let path = allocate_mesh_stage_file_path()?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn append_mesh_stage_chunk(request: tauri::ipc::Request<'_>) -> Result<u64, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err("append_mesh_stage_chunk expects raw binary body, got JSON".into())
        }
    };

    let path_header = request
        .headers()
        .get("x-mesh-stage-path")
        .ok_or("append_mesh_stage_chunk missing x-mesh-stage-path header")?;

    let path_text = path_header
        .to_str()
        .map_err(|e| format!("Invalid x-mesh-stage-path header value: {e}"))?
        .trim();

    if path_text.is_empty() {
        return Err("append_mesh_stage_chunk received empty x-mesh-stage-path header".into());
    }

    let path = std::path::PathBuf::from(path_text);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed creating mesh stage directory: {err}"))?;
    }

    let mut appender_lock = staged_mesh_file_appender()
        .lock()
        .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;

    let needs_new_appender = match appender_lock.as_ref() {
        Some(existing) => existing.path != path_text,
        None => true,
    };

    if needs_new_appender {
        if let Some(existing) = appender_lock.as_mut() {
            use std::io::Write;
            let _ = existing.writer.flush();
        }

        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .map_err(|err| format!("Failed opening mesh stage file for write: {err}"))?;

        *appender_lock = Some(StageFileAppender {
            path: path_text.to_string(),
            writer: std::io::BufWriter::with_capacity(4 * 1024 * 1024, file),
            len: 0,
        });
    }

    let appender = appender_lock
        .as_mut()
        .ok_or("Failed initializing mesh stage file appender")?;

    use std::io::Write;
    appender
        .writer
        .write_all(bytes)
        .map_err(|err| format!("Failed appending mesh stage bytes: {err}"))?;
    appender.len = appender.len.saturating_add(bytes.len() as u64);

    Ok(appender.len)
}

#[tauri::command]
async fn stage_mesh_file_path(mesh_file_path: String) -> Result<u64, String> {
    let trimmed = mesh_file_path.trim();
    if trimmed.is_empty() {
        return Err("stage_mesh_file_path requires a non-empty path".into());
    }

    let path = std::path::PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!(
            "Mesh stage file does not exist: {}",
            path.display()
        ));
    }

    {
        let mut appender_lock = staged_mesh_file_appender()
            .lock()
            .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;
        if let Some(appender) = appender_lock.as_mut() {
            if appender.path == trimmed {
                use std::io::Write;
                appender
                    .writer
                    .flush()
                    .map_err(|e| format!("Failed flushing mesh stage file writer: {e}"))?;
            }
        }
    }

    let len = std::fs::metadata(&path)
        .map_err(|e| format!("Failed reading mesh stage file metadata: {e}"))?
        .len();

    *staged_mesh()
        .lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))? = None;

    *staged_mesh_file_path()
        .lock()
        .map_err(|e| format!("staged mesh file-path lock poisoned: {e}"))? =
        Some(path.to_string_lossy().to_string());

    *staged_mesh_stats()
        .lock()
        .map_err(|e| format!("staged mesh stats lock poisoned: {e}"))? = StageMeshStats {
        chunks_received: 1,
        append_ns_total: 0,
    };

    Ok(len)
}

#[tauri::command]
async fn stage_mesh_binary_set(
    request: tauri::ipc::Request<'_>,
) -> Result<StageMeshChunkAck, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err("stage_mesh_binary_set expects raw binary body, got JSON".into())
        }
    };

    let reserve_bytes = normalize_staged_mesh_prealloc_bytes(bytes.len());
    let append_start = std::time::Instant::now();
    let mut staged = Vec::with_capacity(reserve_bytes);
    staged.extend_from_slice(bytes);
    let append_ns = append_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
    let capacity_bytes = staged.capacity() as u64;
    let total_bytes = staged.len() as u64;

    *staged_mesh()
        .lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))? = Some(staged);

    *staged_mesh_stats()
        .lock()
        .map_err(|e| format!("staged mesh stats lock poisoned: {e}"))? = StageMeshStats {
        chunks_received: 1,
        append_ns_total: append_ns,
    };

    *staged_mesh_file_path()
        .lock()
        .map_err(|e| format!("staged mesh file-path lock poisoned: {e}"))? = None;

    *staged_mesh_file_appender()
        .lock()
        .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))? = None;

    Ok(StageMeshChunkAck {
        chunk_bytes: total_bytes,
        total_bytes,
        capacity_bytes,
        reserve_grew: capacity_bytes > reserve_bytes as u64,
        chunks_received: 1,
        append_ns,
        append_ns_total: append_ns,
    })
}

#[tauri::command]
async fn stage_mesh_binary_chunk(
    request: tauri::ipc::Request<'_>,
) -> Result<StageMeshChunkAck, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err("stage_mesh_binary_chunk expects raw binary body, got JSON".into())
        }
    };

    let mut lock = staged_mesh()
        .lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))?;

    let vec = lock
        .as_mut()
        .ok_or("Staged mesh not started. Call stage_mesh_binary_start first")?;

    let chunk_bytes = bytes.len() as u64;
    let capacity_before = vec.capacity();
    let append_start = std::time::Instant::now();
    vec.extend_from_slice(bytes);
    let append_ns = append_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
    let capacity_after = vec.capacity();
    let total_bytes = vec.len() as u64;

    drop(lock);

    let mut stats = staged_mesh_stats()
        .lock()
        .map_err(|e| format!("staged mesh stats lock poisoned: {e}"))?;
    stats.chunks_received = stats.chunks_received.saturating_add(1);
    stats.append_ns_total = stats.append_ns_total.saturating_add(append_ns);

    Ok(StageMeshChunkAck {
        chunk_bytes,
        total_bytes,
        capacity_bytes: capacity_after as u64,
        reserve_grew: capacity_after > capacity_before,
        chunks_received: stats.chunks_received,
        append_ns,
        append_ns_total: stats.append_ns_total,
    })
}

#[tauri::command]
async fn slice_solid_native_to_temp_path(
    window: tauri::Window,
    job_json: String,
) -> Result<NativeSliceTempPathResult, String> {
    // Take the pre-staged mesh bytes (set by stage_mesh_binary)
    let staged_mesh_bytes = staged_mesh()
        .lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))?
        .take();

    let mesh_bytes = if let Some(bytes) = staged_mesh_bytes {
        bytes
    } else {
        {
            let mut appender_lock = staged_mesh_file_appender()
                .lock()
                .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;
            if let Some(appender) = appender_lock.as_mut() {
                use std::io::Write;
                appender
                    .writer
                    .flush()
                    .map_err(|e| format!("Failed flushing mesh stage file writer: {e}"))?;
            }
        }

        let staged_path = staged_mesh_file_path()
            .lock()
            .map_err(|e| format!("staged mesh file-path lock poisoned: {e}"))?
            .take()
            .ok_or("No staged mesh binary or file path — call stage_mesh_binary_* or stage_mesh_file_path first")?;

        let path = std::path::PathBuf::from(staged_path.trim());
        if !path.exists() {
            return Err(format!(
                "Staged mesh file no longer exists: {}",
                path.display()
            ));
        }

        let bytes = std::fs::read(&path)
            .map_err(|e| format!("Failed reading staged mesh file '{}': {e}", path.display()))?;

        let _ = std::fs::remove_file(&path);
        *staged_mesh_file_appender()
            .lock()
            .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))? = None;
        bytes
    };

    let flag = cancel_flag().clone();
    flag.store(false, Ordering::SeqCst);

    let win = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let wrapper_start = std::time::Instant::now();

        let metadata_parse_start = std::time::Instant::now();
        let meta: SliceJobMetadata = serde_json::from_str(&job_json)
            .map_err(|err| format!("Invalid slice job metadata JSON: {err}"))?;
        let metadata_parse_ns = duration_ns_u64(metadata_parse_start.elapsed());

        let mesh_decode_start = std::time::Instant::now();
        let triangles_xyz = decode_mesh_bytes(mesh_bytes, &meta)?;
        let mesh_decode_ns = duration_ns_u64(mesh_decode_start.elapsed());

        let job = dragonfruit_slicer_v3::SliceJobV3 {
            output_format: meta.output_format,
            format_version: meta.format_version,
            source_width_px: meta.source_width_px,
            source_height_px: meta.source_height_px,
            width_px: meta.width_px,
            height_px: meta.height_px,
            x_packing_mode: meta.x_packing_mode.unwrap_or_else(|| "none".to_string()),
            png_compression_strategy: meta.png_compression_strategy,
            anti_aliasing_level: meta.anti_aliasing_level,
            aa_on_supports: meta.aa_on_supports,
            minimum_aa_alpha_percent: meta.minimum_aa_alpha_percent,
            mirror_x: meta.mirror_x,
            mirror_y: meta.mirror_y,
            container_compression_level: meta.container_compression_level,
            build_width_mm: meta.build_width_mm,
            build_depth_mm: meta.build_depth_mm,
            layer_height_mm: meta.layer_height_mm,
            total_layers: meta.total_layers,
            export_thumbnail_png_base64: meta.export_thumbnail_png_base64,
            triangles_xyz,
            metadata_json: meta.metadata_json,
        };

        let progress_cb = make_throttled_progress_cb(win);

        slicer_pool().install(
            || -> Result<(String, u64, NativeSlicerPerfMetrics, NativeSlicerRuntimeMetrics), String> {
            let ext = if job.output_format.trim().is_empty() {
                let format_provider = plugin_registry::get_format_provider()
                    .unwrap_or_else(|_| plugin_registry::get_default_format_provider());
                format_provider.default_export_format()
            } else {
                job.output_format.trim_start_matches('.')
            };
            let path = temp_artifact_path(ext);

            let perf_raw = dragonfruit_slicer_v3::engine::slice_with_progress_v3_to_path(
                &job,
                &path,
                Some(progress_cb),
                Some(flag.as_ref()),
            )
            .map_err(|err| format!("V3 slicing failed: {err}"))?;

            let perf = NativeSlicerPerfMetrics {
                total_ns: perf_raw.total_ns,
                index_build_ns: perf_raw.index_build_ns,
                render_wall_ns: perf_raw.render_wall_ns,
                render_ns: perf_raw.render_ns,
                png_encode_ns: perf_raw.png_encode_ns,
                archive_encode_ns: perf_raw.archive_encode_ns,
                layers: perf_raw.layers,
            };

            let artifact_metadata_start = std::time::Instant::now();
            let byte_len = std::fs::metadata(&path)
                .map_err(|err| format!("Failed reading temp artifact metadata: {err}"))?
                .len();
            let artifact_metadata_ns = duration_ns_u64(artifact_metadata_start.elapsed());

            let wrapper_total_ns = duration_ns_u64(wrapper_start.elapsed());
            let wrapper_overhead_ns = wrapper_total_ns.saturating_sub(perf_raw.total_ns);
            let runtime = v3_runtime_metrics(
                &path,
                metadata_parse_ns,
                mesh_decode_ns,
                artifact_metadata_ns,
                wrapper_total_ns,
                wrapper_overhead_ns,
            );

            Ok((
                path.to_string_lossy().to_string(),
                byte_len,
                perf,
                runtime,
            ))
        },
        )
    })
    .await
    .map_err(|err| format!("Native slicer task failed to join: {err}"))??;

    Ok(NativeSliceTempPathResult {
        temp_path: result.0,
        byte_len: result.1,
        perf: Some(result.2),
        runtime: result.3,
    })
}

#[tauri::command]
async fn cancel_slicing() -> Result<(), String> {
    cancel_flag().store(true, Ordering::SeqCst);
    Ok(())
}

// ---------------------------------------------------------------------------
// Native Island Scan
// ---------------------------------------------------------------------------

/// Parameters for native island scan. Field names match the JSON keys sent by
/// nativeIslandScan.ts (snake_case).
#[derive(Deserialize)]
struct IslandScanParams {
    px_mm: f64,
    support_buffer_mm: f64,
    #[serde(default = "default_connectivity")]
    connectivity: u8,
    #[serde(default = "default_min_island_area")]
    min_island_area_mm2: f64,
    #[serde(default = "default_overlap_px")]
    min_overlap_px: i32,
    #[serde(default = "default_neighborhood_px")]
    overlap_neighborhood_px: i32,
    layer_height_mm: f64,
    // Bounding box from frontend (world coords after transform)
    bbox_min_x: f64,
    bbox_max_x: f64,
    bbox_min_y: f64,
    bbox_max_y: f64,
    bbox_min_z: f64,
    bbox_max_z: f64,
}

fn default_connectivity() -> u8 {
    4
}
fn default_min_island_area() -> f64 {
    0.01
}
fn default_overlap_px() -> i32 {
    1
}
fn default_neighborhood_px() -> i32 {
    1
}

/// IPC result matching the TS `ScanResults` shape so the frontend overlay/voxel
/// rendering works unchanged.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeIslandScanResult {
    grid: NativeGridRef,
    islands: Vec<NativeIsland>,
    island_labels_per_layer: Vec<NativeRleLabels>,
    // Derived arrays the frontend overlay needs
    first_hit: Vec<i16>,
    last_hit: Vec<i16>,
    base_footprint: Vec<u8>,
    base_labels: Vec<i32>,
    comp_base: Vec<i16>,
    comp_top: Vec<i16>,
    // Perf
    rasterize_ms: f64,
    scan_ms: f64,
    total_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeGridRef {
    origin_x: f64,
    origin_z: f64,
    width: i32,
    height: i32,
    px_mm: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeIsland {
    id: u32,
    first_layer: u32,
    last_layer: u32,
    status: String,
    total_area_mm2: f64,
    per_layer_area_mm2: std::collections::HashMap<String, f64>,
    parent_id: Option<u32>,
    child_ids: Vec<u32>,
    volume_mm3: Option<f64>,
    max_area_mm2: Option<f64>,
    max_area_layer: Option<u32>,
    is_merged_placeholder: bool,
    centroid: Option<NativeCentroid>,
    last_layer_centroid: Option<NativeCentroid>,
}

#[derive(Serialize)]
struct NativeCentroid {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Serialize)]
struct NativeRleLabels {
    rows: Vec<Vec<i32>>,
    width: i32,
    height: i32,
}

#[tauri::command]
async fn run_island_scan_native(
    window: tauri::Window,
    params_json: String,
) -> Result<NativeIslandScanResult, String> {
    // Take staged mesh bytes
    let mesh_bytes = staged_mesh()
        .lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))?
        .take()
        .ok_or("No staged mesh binary — call stage_mesh_binary first")?;

    let win = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let params: IslandScanParams = serde_json::from_str(&params_json)
            .map_err(|e| format!("Invalid island scan params JSON: {e}"))?;

        let triangles_xyz = bytes_to_f32_vec(&mesh_bytes)?;
        let triangles = dragonfruit_slicer_v3::geometry::parse_triangles(&triangles_xyz);

        // Debug dump: write positions + params to temp dir for offline reproduction
        let dump_dir = std::env::temp_dir().join("dragonfruit-island-debug");
        let _ = std::fs::create_dir_all(&dump_dir);
        let _ = std::fs::write(
            dump_dir.join("params.json"),
            &params_json,
        );
        // Write positions as raw f32 binary (same format as stage_mesh_binary)
        let _ = std::fs::write(
            dump_dir.join("positions.bin"),
            &mesh_bytes,
        );
        eprintln!(
            "[island-scan-native] triangles={} bbox=({:.4},{:.4},{:.4})-({:.4},{:.4},{:.4}) px_mm={} layer_h={} buf={} conn={} min_area={} overlap_px={} neighborhood={}",
            triangles.len(),
            params.bbox_min_x, params.bbox_min_y, params.bbox_min_z,
            params.bbox_max_x, params.bbox_max_y, params.bbox_max_z,
            params.px_mm, params.layer_height_mm, params.support_buffer_mm,
            params.connectivity, params.min_island_area_mm2,
            params.min_overlap_px, params.overlap_neighborhood_px,
        );
        eprintln!("[island-scan-native] debug dump: {}", dump_dir.display());

        // Phase A: Rasterize all layers using shared module (same code as bench)
        let total_layers;
        let grid_width;
        let grid_height;
        let origin_x;
        let origin_z;
        let w;
        let h;

        let t_raster = std::time::Instant::now();
        let (masks, gw, gh, num_layers, ox, oz) = slicer_pool().install(|| {
            dragonfruit_islands::rasterize::rasterize_for_island_scan(
                &triangles,
                params.bbox_min_x, params.bbox_max_x,
                params.bbox_min_y, params.bbox_max_y,
                params.bbox_min_z, params.bbox_max_z,
                params.px_mm,
                params.layer_height_mm,
            )
        });
        grid_width = gw;
        grid_height = gh;
        origin_x = ox;
        origin_z = oz;
        w = grid_width as usize;
        h = grid_height as usize;
        total_layers = num_layers as u32;
        let rasterize_ms = t_raster.elapsed().as_secs_f64() * 1000.0;

        // Phase B: Island scan pipeline (sequential tracking — progress per layer)
        let t_scan = std::time::Instant::now();
        let connectivity = if params.connectivity == 8 {
            dragonfruit_islands::model::Connectivity::Eight
        } else {
            dragonfruit_islands::model::Connectivity::Four
        };

        let job = dragonfruit_islands::model::IslandScanJob {
            px_mm: params.px_mm,
            support_buffer_mm: params.support_buffer_mm,
            connectivity,
            min_island_area_mm2: params.min_island_area_mm2,
            layer_height_mm: params.layer_height_mm,
            grid: dragonfruit_islands::model::GridRef {
                origin_x,
                origin_z,
                width: grid_width,
                height: grid_height,
                px_mm: params.px_mm,
            },
            num_layers: num_layers as u32,
            min_overlap_px: params.min_overlap_px,
            overlap_neighborhood_px: params.overlap_neighborhood_px,
        };

        let win_scan = win.clone();
        let scan_result = slicer_pool().install(|| {
            dragonfruit_islands::pipeline::run_island_scan(
                &job,
                &masks,
                Some(&move |done: u32, total: u32| {
                    // Map pipeline progress (0..total) to layer count (0..total_layers)
                    // — same convention as TS ScanOrchestrator onProgress(done, numLayers)
                    let layer = (done as u64 * total_layers as u64 / total.max(1) as u64) as u32;
                    let _ = win_scan.emit("islandscan://progress", SliceProgressPayload {
                        done: layer.min(total_layers),
                        total: total_layers,
                        phase: "Scanning".to_string(),
                    });
                }),
            )
        });
        let scan_ms = t_scan.elapsed().as_secs_f64() * 1000.0;
        let total_ms = rasterize_ms + scan_ms;

        let total_solid_px: u64 = masks.iter().map(|m| m.pixel_count()).sum();
        eprintln!(
            "[island-scan-native] grid={}x{} layers={} solid_px={} islands={} raster={:.0}ms scan={:.0}ms",
            grid_width, grid_height, num_layers, total_solid_px,
            scan_result.islands.len(), rasterize_ms, scan_ms,
        );

        // Phase C: Build frontend-compatible result
        // Compute firstHit, lastHit, baseLabels, compBase, compTop
        let pixel_count = w * h;
        let mut first_hit = vec![-1i16; pixel_count];
        let mut last_hit = vec![-1i16; pixel_count];
        let mut base_labels = vec![0i32; pixel_count];

        for (l, labels) in scan_result.island_labels_per_layer.iter().enumerate() {
            for (y, row) in labels.rows.iter().enumerate() {
                let row_off = y * w;
                for run in row {
                    for j in 0..run.length {
                        let idx = row_off + (run.start + j) as usize;
                        if idx < pixel_count {
                            if first_hit[idx] == -1 {
                                first_hit[idx] = l as i16;
                                if run.id > 0 { base_labels[idx] = run.id; }
                            }
                            last_hit[idx] = l as i16;
                        }
                    }
                }
            }
        }

        let base_footprint: Vec<u8> = first_hit.iter().map(|&h| if h != -1 { 1 } else { 0 }).collect();

        // compBase/compTop from islands
        let max_id = scan_result.islands.iter().map(|i| i.id.0).max().unwrap_or(0) as usize;
        let mut comp_base = vec![-1i16; max_id + 1];
        let mut comp_top = vec![-1i16; max_id + 1];
        for island in &scan_result.islands {
            let id = island.id.0 as usize;
            if id <= max_id {
                comp_base[id] = island.first_layer as i16;
                comp_top[id] = island.last_layer as i16;
            }
        }

        // Convert islands to frontend shape
        let islands: Vec<NativeIsland> = scan_result.islands.iter().map(|i| {
            NativeIsland {
                id: i.id.0,
                first_layer: i.first_layer,
                last_layer: i.last_layer,
                status: match i.status {
                    dragonfruit_islands::model::IslandStatus::Active => "active".into(),
                    dragonfruit_islands::model::IslandStatus::Complete => "complete".into(),
                },
                total_area_mm2: i.total_area_mm2,
                per_layer_area_mm2: i.per_layer_area_mm2.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
                parent_id: i.parent_id.map(|p| p.0),
                child_ids: i.child_ids.iter().map(|c| c.0).collect(),
                volume_mm3: i.volume_mm3,
                max_area_mm2: i.max_area_mm2,
                max_area_layer: i.max_area_layer,
                is_merged_placeholder: i.is_merged_placeholder,
                centroid: i.centroid.map(|c| NativeCentroid { x: c.x, y: c.y, z: c.z }),
                last_layer_centroid: i.last_layer_centroid.map(|c| NativeCentroid { x: c.x, y: c.y, z: c.z }),
            }
        }).collect();

        // Convert RLE labels to frontend shape (flat i32 arrays)
        let island_labels_per_layer: Vec<NativeRleLabels> = scan_result.island_labels_per_layer.iter().map(|labels| {
            NativeRleLabels {
                rows: labels.rows.iter().map(|row| {
                    let mut flat = Vec::new();
                    for run in row { flat.push(run.start); flat.push(run.length); flat.push(run.id); }
                    flat
                }).collect(),
                width: labels.width,
                height: labels.height,
            }
        }).collect();

        Ok::<NativeIslandScanResult, String>(NativeIslandScanResult {
            grid: NativeGridRef { origin_x, origin_z, width: grid_width, height: grid_height, px_mm: params.px_mm },
            islands,
            island_labels_per_layer,
            first_hit,
            last_hit,
            base_footprint,
            base_labels,
            comp_base,
            comp_top,
            rasterize_ms,
            scan_ms,
            total_ms,
        })
    })
    .await
    .map_err(|e| format!("Island scan task failed to join: {e}"))??;

    Ok(result)
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickSavePathArgs {
    default_filename: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBytesToPathArgs {
    destination_path: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickOpenFilesArgs {
    category: String,
    multiple: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedOpenFile {
    path: String,
    name: String,
}

fn is_scene_file_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            ext.trim()
                .trim_start_matches('.')
                .eq_ignore_ascii_case("voxl")
                || ext
                    .trim()
                    .trim_start_matches('.')
                    .eq_ignore_ascii_case("lys")
        })
        .unwrap_or(false)
}

fn collect_scene_file_paths_from_args(args: &[String]) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();

    for arg in args.iter().skip(1) {
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            continue;
        }

        let path = std::path::PathBuf::from(trimmed);
        if !path.is_file() {
            continue;
        }

        if !is_scene_file_path(&path) {
            continue;
        }

        files.push(path.to_string_lossy().to_string());
    }

    files
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneFileHandoffPayload {
    paths: Vec<String>,
    source: String,
}

fn build_open_dialog_with_filters(category: &str) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new();

    let normalized = category.trim().to_ascii_lowercase();
    dialog = match normalized.as_str() {
        "mesh" => dialog.add_filter("Mesh Files", &["stl", "3mf"]),
        "scene" => dialog.add_filter("Scene Files", &["voxl", "lys"]),
        "bundle" => dialog.add_filter("JSON Files", &["json"]),
        _ => dialog
            .add_filter("Mesh Files", &["stl", "3mf"])
            .add_filter("Scene Files", &["voxl", "lys"]),
    };

    dialog
}

#[tauri::command]
async fn save_print_file(args: SavePrintFileArgs) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let suggested_name = {
            let trimmed = args.default_filename.trim();
            if trimmed.is_empty() {
                let format_provider = plugin_registry::get_format_provider()
                    .unwrap_or_else(|_| plugin_registry::get_default_format_provider());
                format_provider.default_export_filename()
            } else {
                trimmed.to_string()
            }
        };

        let picked = build_save_dialog_with_filters(&suggested_name)
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
                let format_provider = plugin_registry::get_format_provider()
                    .unwrap_or_else(|_| plugin_registry::get_default_format_provider());
                format_provider.default_export_filename()
            } else {
                trimmed.to_string()
            }
        };

        let source = std::path::PathBuf::from(args.source_path.trim());
        if !source.exists() {
            return Err("Source print file no longer exists on disk".to_string());
        }

        let picked = build_save_dialog_with_filters(&suggested_name)
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
async fn pick_save_path(args: PickSavePathArgs) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let suggested_name = {
            let trimmed = args.default_filename.trim();
            if trimmed.is_empty() {
                let format_provider = plugin_registry::get_format_provider()
                    .unwrap_or_else(|_| plugin_registry::get_default_format_provider());
                format_provider.default_export_filename()
            } else {
                trimmed.to_string()
            }
        };

        let picked = build_save_dialog_with_filters(&suggested_name)
            .save_file()
            .ok_or_else(|| "Save cancelled by user".to_string())?;

        Ok(picked.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| format!("Save picker task failed to join: {err}"))?
}

#[tauri::command]
async fn write_bytes_to_path(args: WriteBytesToPathArgs) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed_destination = args.destination_path.trim();
        if trimmed_destination.is_empty() {
            return Err("Destination path is empty".to_string());
        }

        let destination = std::path::PathBuf::from(trimmed_destination);

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Failed creating destination folder: {err}"))?;
        }

        std::fs::write(&destination, &args.bytes)
            .map_err(|err| format!("Failed writing file bytes: {err}"))?;

        Ok(destination.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| format!("Write-bytes task failed to join: {err}"))?
}

#[tauri::command]
async fn pick_open_files(args: PickOpenFilesArgs) -> Result<Vec<PickedOpenFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = build_open_dialog_with_filters(&args.category);

        let picked_paths: Vec<std::path::PathBuf> = if args.multiple {
            dialog.pick_files().unwrap_or_default()
        } else {
            match dialog.pick_file() {
                Some(path) => vec![path],
                None => Vec::new(),
            }
        };

        if picked_paths.is_empty() {
            return Err("Open cancelled by user".to_string());
        }

        let files = picked_paths
            .into_iter()
            .map(|path| PickedOpenFile {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("file")
                    .to_string(),
                path: path.to_string_lossy().to_string(),
            })
            .collect::<Vec<_>>();

        Ok(files)
    })
    .await
    .map_err(|err| format!("Open picker task failed to join: {err}"))?
}

#[tauri::command]
async fn get_launch_scene_files() -> Result<Vec<PickedOpenFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = collect_scene_file_paths_from_args(&std::env::args().collect::<Vec<_>>())
            .into_iter()
            .map(|path_text| {
                let path = std::path::PathBuf::from(&path_text);
                PickedOpenFile {
                    name: path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("file")
                        .to_string(),
                    path: path_text,
                }
            })
            .collect::<Vec<_>>();

        Ok(files)
    })
    .await
    .map_err(|err| format!("Launch scene-files task failed to join: {err}"))?
}

fn emit_scene_file_handoff(app: &tauri::AppHandle, args: &[String], source: &str) {
    let paths = collect_scene_file_paths_from_args(args);
    if paths.is_empty() {
        return;
    }

    let payload = SceneFileHandoffPayload {
        paths,
        source: source.to_string(),
    };

    let _ = app.emit("dragonfruit://scene-file-handoff", payload);
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(true);
        if !is_visible {
            let _ = window.show();
        }

        let is_minimized = window.is_minimized().unwrap_or(false);
        if is_minimized {
            let _ = window.unminimize();
        }

        let is_focused = window.is_focused().unwrap_or(false);
        if !is_focused {
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
async fn notify_launch_scene_handoff(app: tauri::AppHandle) -> Result<(), String> {
    let args = std::env::args().collect::<Vec<_>>();
    emit_scene_file_handoff(&app, &args, "primary-launch");
    Ok(())
}

#[tauri::command]
async fn focus_main_window_command(app: tauri::AppHandle) -> Result<(), String> {
    focus_main_window(&app);
    Ok(())
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

#[tauri::command]
async fn read_print_layer_png(source_path: String, layer_number: u32) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        if layer_number == 0 {
            return Err("Layer number must be >= 1".to_string());
        }

        let source = std::path::PathBuf::from(source_path.trim());
        if !source.exists() {
            return Err("Source print file no longer exists on disk".to_string());
        }

        let file = std::fs::File::open(&source)
            .map_err(|err| format!("Failed opening print archive: {err}"))?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|err| format!("Failed reading print archive: {err}"))?;

        let entry_name = format!("{}.png", layer_number);
        let mut entry = zip
            .by_name(&entry_name)
            .map_err(|err| format!("Failed reading layer PNG {entry_name}: {err}"))?;

        let mut png_bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut png_bytes)
            .map_err(|err| format!("Failed reading layer PNG bytes: {err}"))?;

        Ok(png_bytes)
    })
    .await
    .map_err(|err| format!("Read layer task failed to join: {err}"))??;

    Ok(Response::new(bytes))
}

#[tauri::command]
async fn delete_print_temp_file(source_path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = std::path::PathBuf::from(source_path.trim());
        if !source.exists() {
            return Ok(false);
        }
        if !is_dragonfruit_temp_artifact(&source) {
            return Err("Refusing to delete non-DragonFruit temp artifact path".to_string());
        }
        std::fs::remove_file(&source)
            .map_err(|err| format!("Failed deleting temp artifact: {err}"))?;
        Ok(true)
    })
    .await
    .map_err(|err| format!("Delete task failed to join: {err}"))?
}

#[tauri::command]
async fn cleanup_stale_print_temp_files(max_age_seconds: u64) -> Result<u32, String> {
    let age = max_age_seconds.max(60);
    let removed = tauri::async_runtime::spawn_blocking(move || sweep_stale_temp_artifacts(age))
        .await
        .map_err(|err| format!("Cleanup task failed to join: {err}"))?;
    Ok(removed)
}

#[tauri::command]
async fn cleanup_all_print_temp_files() -> Result<u32, String> {
    let removed = tauri::async_runtime::spawn_blocking(sweep_all_temp_artifacts)
        .await
        .map_err(|err| format!("Cleanup-all task failed to join: {err}"))?;
    Ok(removed)
}

fn main() {
    // Sweep week-old stale temp artifacts on app startup.
    let _ = sweep_stale_temp_artifacts(7 * 24 * 60 * 60);

    // Initialize plugin registry and register built-in plugins
    if let Err(error) = plugin_registry::initialize_plugins() {
        if cfg!(debug_assertions) {
            eprintln!("[plugin-registry] WARNING: {error}");
        } else {
            panic!("Failed to initialize plugin registry: {error}");
        }
    }

    let builder = tauri::Builder::default()
        .setup(|app| {
            use tauri::WebviewWindowBuilder;

            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .expect("Missing 'main' window config in tauri.conf.json");

            let builder = WebviewWindowBuilder::from_config(app, window_config)?;

            // Keep custom titlebar behavior on non-macOS.
            #[cfg(not(target_os = "macos"))]
            let builder = builder.decorations(false);

            let _window = builder.build()?;

            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let has_scene_files = !collect_scene_file_paths_from_args(&argv).is_empty();
            emit_scene_file_handoff(app, &argv, "single-instance");

            // Only force foreground when this second launch is handing off a scene file.
            // Avoiding unconditional focus here reduces Windows "error" chimes when users
            // launch the app again while it's already running.
            if has_scene_files {
                focus_main_window(app);
            }
        }));

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_fps::init());

    builder
        .invoke_handler(tauri::generate_handler![
            slice_solid_native,
            stage_mesh_binary_start,
            allocate_mesh_stage_path,
            append_mesh_stage_chunk,
            stage_mesh_file_path,
            stage_mesh_binary_set,
            stage_mesh_binary_chunk,
            slice_solid_native_to_temp_path,
            cancel_slicing,
            run_island_scan_native,
            save_print_file,
            save_print_file_from_path,
            pick_save_path,
            pick_open_files,
            get_launch_scene_files,
            notify_launch_scene_handoff,
            focus_main_window_command,
            write_bytes_to_path,
            read_print_file_bytes,
            read_print_layer_png,
            delete_print_temp_file,
            cleanup_stale_print_temp_files,
            cleanup_all_print_temp_files,
            network::plugin_network_request,
            network::ensure_rtsp_relay
        ])
        .run(tauri::generate_context!())
        .expect("error while running DragonFruit desktop app");
}
