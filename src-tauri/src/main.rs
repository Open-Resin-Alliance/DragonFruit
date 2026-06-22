#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod astar;
mod mesh_repair;
mod network;
mod sdf;
mod updater_channel;

fn default_minimum_aa_alpha_percent() -> f32 {
    35.0
}

fn default_blur_brush_radius_px() -> u32 {
    1
}

fn default_blur_brush_kernel() -> String {
    "gaussian".to_string()
}

fn default_blur_brush_sigma_x() -> f64 {
    0.5
}

fn default_blur_brush_sigma_y() -> f64 {
    0.5
}

fn default_z_blur_radius_layers() -> u32 {
    0
}

fn default_z_blur_kernel() -> String {
    "box".to_string()
}

fn default_z_blur_sigma() -> f64 {
    0.5
}

fn default_anti_aliasing_mode() -> String {
    "Blur".to_string()
}

fn default_z_blend_look_back() -> u32 {
    2
}

fn default_z_blend_fade_px() -> u32 {
    20
}

fn default_z_blend_max_alpha_percent() -> f32 {
    90.0
}

fn default_dither_device_gamma() -> f64 {
    3.0
}

mod plugin_registry;

use rayon::{ThreadPool, ThreadPoolBuilder};
use serde::Deserialize;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{InvokeBody, Response};
use tauri::Emitter;
use tauri::Manager;

// Runtime type aliases — the feat/cef branch requires an explicit runtime
// generic. These select Cef or Wry based on the active cargo feature.
#[cfg(feature = "tauri-cef")]
type DragonFruitAppHandle = tauri::AppHandle<tauri::Cef>;
#[cfg(not(feature = "tauri-cef"))]
type DragonFruitAppHandle = tauri::AppHandle<tauri::Wry>;

#[cfg(feature = "tauri-cef")]
type DragonFruitWindow = tauri::Window<tauri::Cef>;
#[cfg(not(feature = "tauri-cef"))]
type DragonFruitWindow = tauri::Window<tauri::Wry>;

/// Scene file extensions contributed by built-in fileType plugins — auto-generated, do not edit.
use plugin_registry::GENERATED_BUILTIN_PLUGIN_SCENE_FILE_EXTENSIONS as BUILTIN_PLUGIN_SCENE_EXTENSIONS;

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

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SaveDialogFilterDef {
    name: String,
    extensions: Vec<String>,
}

fn build_save_dialog_with_filters(
    suggested_name: &str,
    custom_filters: Option<&[SaveDialogFilterDef]>,
) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new().set_file_name(suggested_name);

    if let Some(filters) = custom_filters {
        for filter in filters {
            let trimmed_name = filter.name.trim();
            if trimmed_name.is_empty() {
                continue;
            }

            let normalized_exts: Vec<String> = filter
                .extensions
                .iter()
                .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|ext| !ext.is_empty())
                .collect();

            if normalized_exts.is_empty() {
                continue;
            }

            let ext_refs: Vec<&str> = normalized_exts.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(trimmed_name, &ext_refs);
        }

        return dialog;
    }

    let maybe_ext = std::path::Path::new(suggested_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| !ext.is_empty());

    if let Some(ext) = maybe_ext.as_deref() {
        dialog = match ext {
            "stl" | "obj" | "3mf" => dialog.add_filter("Mesh Files", &["stl", "obj", "3mf"]),
            "voxl" => dialog.add_filter("Scene Files", &["voxl"]),
            x if BUILTIN_PLUGIN_SCENE_EXTENSIONS.contains(&x) => {
                dialog.add_filter("Scene Files", BUILTIN_PLUGIN_SCENE_EXTENSIONS)
            }
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

pub(crate) struct StageFileAppender {
    pub path: String,
    pub writer: std::io::BufWriter<std::fs::File>,
    #[allow(dead_code)]
    pub len: u64,
}

#[derive(Default, Clone, PartialEq)]
pub(crate) struct StageMeshStats {
    pub chunks_received: u64,
    pub append_ns_total: u64,
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

pub(crate) fn staged_mesh() -> &'static Mutex<Option<Vec<u8>>> {
    STAGED_MESH.get_or_init(|| Mutex::new(None))
}

pub(crate) fn staged_mesh_stats() -> &'static Mutex<StageMeshStats> {
    STAGED_MESH_STATS.get_or_init(|| Mutex::new(StageMeshStats::default()))
}

pub(crate) fn staged_mesh_file_path() -> &'static Mutex<Option<String>> {
    STAGED_MESH_FILE_PATH.get_or_init(|| Mutex::new(None))
}

pub(crate) fn staged_mesh_file_appender() -> &'static Mutex<Option<StageFileAppender>> {
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
    #[serde(default)]
    output_path: Option<String>,
    source_width_px: u32,
    source_height_px: u32,
    width_px: u32,
    height_px: u32,
    #[serde(default)]
    x_packing_mode: Option<String>,
    png_compression_strategy: String,
    anti_aliasing_level: String,
    #[serde(default = "default_anti_aliasing_mode")]
    anti_aliasing_mode: String,
    #[serde(default = "default_blur_brush_radius_px")]
    blur_brush_radius_px: u32,
    #[serde(default = "default_blur_brush_kernel")]
    blur_brush_kernel: String,
    #[serde(default = "default_blur_brush_sigma_x", alias = "blur_brush_sigma")]
    blur_brush_sigma_x: f64,
    #[serde(default = "default_blur_brush_sigma_y")]
    blur_brush_sigma_y: f64,
    #[serde(default = "default_z_blur_radius_layers")]
    z_blur_radius_layers: u32,
    #[serde(default = "default_z_blur_kernel")]
    z_blur_kernel: String,
    #[serde(default = "default_z_blur_sigma")]
    z_blur_sigma: f64,
    aa_on_supports: bool,
    #[serde(default = "default_minimum_aa_alpha_percent")]
    minimum_aa_alpha_percent: f32,
    #[serde(default)]
    mirror_x: bool,
    #[serde(default)]
    mirror_y: bool,
    #[serde(default = "default_z_blend_look_back")]
    z_blend_look_back: u32,
    #[serde(default = "default_z_blend_fade_px")]
    z_blend_fade_px: u32,
    #[serde(default)]
    z_blend_auto_fade: bool,
    #[serde(default)]
    z_blend_minimum_alpha_percent: f32,
    /// Maximum gray level (0–100 %) for z-blend gradient pixels at the inner boundary.
    #[serde(default = "default_z_blend_max_alpha_percent")]
    z_blend_max_alpha_percent: f32,
    /// Optional custom grayscale cure LUT (256 u8 values).
    ///
    /// Used by 3DAA to override the linear cure-window ramp and by 2D Blur AA
    /// to remap the post-blur grayscale output directly.
    #[serde(default)]
    z_blend_custom_lut: Option<Vec<u8>>,
    #[serde(default)]
    zaa_kernel: Option<String>,
    #[serde(default)]
    zaa_pattern: Option<String>,
    #[serde(default)]
    zaa_duplicate_z: Option<bool>,
    #[serde(default)]
    model_triangle_count: u32,
    container_compression_level: u8,
    build_width_mm: f32,
    build_depth_mm: f32,
    layer_height_mm: f32,
    total_layers: u32,
    export_thumbnail_png_base64: Option<String>,
    #[serde(default)]
    dither_enabled: bool,
    #[serde(default)]
    dither_bit_depth: Option<u32>,
    #[serde(default = "default_dither_device_gamma")]
    dither_device_gamma: f64,
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
    z_blend_backward_ns: u64,
    z_blend_forward_ns: u64,
    cross_blend_ns: u64,
    cross_blend_touched_pixels: u64,
    cross_blend_contributing_layers: u64,
    post_blur_ns: u64,
    support_merge_ns: u64,
    layers: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSlicerRuntimeMetrics {
    pool_threads: u32,
    max_concurrent: u32,
    queue_buffer: u32,
    daa_post_threads: u32,
    daa_post_buffer_depth: u32,
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

fn phase_to_label(phase: dragonfruit_slicing_engine::types::SliceProgressPhaseV3) -> &'static str {
    match phase {
        dragonfruit_slicing_engine::types::SliceProgressPhaseV3::Slicing => "Slicing",
        dragonfruit_slicing_engine::types::SliceProgressPhaseV3::Encoding => "Encoding",
        dragonfruit_slicing_engine::types::SliceProgressPhaseV3::Finalizing => "Finalizing",
    }
}

fn slicer_pool() -> &'static ThreadPool {
    SLICER_POOL.get_or_init(|| {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        ThreadPoolBuilder::new()
            .thread_name(|i| format!("dragonfruit-slicing-engine-{i}"))
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
    win: DragonFruitWindow,
) -> dragonfruit_slicing_engine::types::ProgressCallbackV3 {
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
        move |update: dragonfruit_slicing_engine::types::SliceProgressUpdateV3| {
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
    daa_post_threads: u32,
    daa_post_buffer_depth: u32,
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
        daa_post_threads,
        daa_post_buffer_depth,
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

// ---------------------------------------------------------------------------
// Native mesh export (STL / 3MF)
// ---------------------------------------------------------------------------

/// Read a little-endian `f32` from a byte slice at the given byte offset.
#[inline(always)]
fn read_f32_le(data: &[u8], off: usize) -> f32 {
    f32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}

/// Write binary STL directly to `dest_path` from raw triangle staging data.
///
/// Staging format: 9 × f32 per triangle (v0x v0y v0z  v1x v1y v1z  v2x v2y v2z), LE.
fn write_binary_stl(raw: &[u8], tri_count: usize, dest_path: &str) -> Result<(), String> {
    use std::io::{BufWriter, Write};

    let file =
        std::fs::File::create(dest_path).map_err(|e| format!("Failed creating STL file: {e}"))?;
    let mut w = BufWriter::with_capacity(256 * 1024, file);

    // 80-byte header (all zeros)
    w.write_all(&[0u8; 80])
        .map_err(|e| format!("STL write: {e}"))?;
    w.write_all(&(tri_count as u32).to_le_bytes())
        .map_err(|e| format!("STL write: {e}"))?;

    for i in 0..tri_count {
        let base = i * 36; // 9 floats × 4 bytes
        let v0x = read_f32_le(raw, base);
        let v0y = read_f32_le(raw, base + 4);
        let v0z = read_f32_le(raw, base + 8);
        let v1x = read_f32_le(raw, base + 12);
        let v1y = read_f32_le(raw, base + 16);
        let v1z = read_f32_le(raw, base + 20);
        let v2x = read_f32_le(raw, base + 24);
        let v2y = read_f32_le(raw, base + 28);
        let v2z = read_f32_le(raw, base + 32);

        // Face normal = cross(v1 - v0, v2 - v0), normalized
        let e1x = v1x - v0x;
        let e1y = v1y - v0y;
        let e1z = v1z - v0z;
        let e2x = v2x - v0x;
        let e2y = v2y - v0y;
        let e2z = v2z - v0z;
        let mut nx = e1y * e2z - e1z * e2y;
        let mut ny = e1z * e2x - e1x * e2z;
        let mut nz = e1x * e2y - e1y * e2x;
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len > 1e-30 {
            let inv = 1.0 / len;
            nx *= inv;
            ny *= inv;
            nz *= inv;
        }

        // Normal
        w.write_all(&nx.to_le_bytes())
            .map_err(|e| format!("STL write: {e}"))?;
        w.write_all(&ny.to_le_bytes())
            .map_err(|e| format!("STL write: {e}"))?;
        w.write_all(&nz.to_le_bytes())
            .map_err(|e| format!("STL write: {e}"))?;
        // 3 vertices
        w.write_all(&raw[base..base + 36])
            .map_err(|e| format!("STL write: {e}"))?;
        // Attribute byte count
        w.write_all(&0u16.to_le_bytes())
            .map_err(|e| format!("STL write: {e}"))?;
    }

    w.flush().map_err(|e| format!("STL flush: {e}"))?;
    Ok(())
}

/// Write a 3MF file (DEFLATE-compressed ZIP) directly to `dest_path` from raw
/// triangle staging data.
///
/// The `zip` crate handles DEFLATE compression, CRC32, and central directory
/// bookkeeping.  XML text for vertex/triangle tags compresses ~10–20× with
/// DEFLATE, so the resulting 3MF is typically smaller than the equivalent
/// binary STL.
fn write_3mf(raw: &[u8], tri_count: usize, dest_path: &str) -> Result<(), String> {
    use std::io::{BufWriter, Write};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let file =
        std::fs::File::create(dest_path).map_err(|e| format!("Failed creating 3MF file: {e}"))?;
    // Large outer buffer so 4 MB compressed chunks land on disk efficiently.
    let buf_writer = BufWriter::with_capacity(4 * 1024 * 1024, file);
    let mut zip = ZipWriter::new(buf_writer);

    // Level 1 = fastest deflate. Repetitive XML (vertex/triangle tags) still
    // compresses 5–8× even at level 1, so output size stays reasonable while
    // the compressor runs ~5× faster than the default level 6.
    let deflate_opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(1));

    // ── [Content_Types].xml ──
    zip.start_file("[Content_Types].xml", deflate_opts)
        .map_err(|e| format!("3MF zip: {e}"))?;
    zip.write_all(
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
          <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
          <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
          <Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\
          </Types>",
    )
    .map_err(|e| format!("3MF zip: {e}"))?;

    // ── _rels/.rels ──
    zip.start_file("_rels/.rels", deflate_opts)
        .map_err(|e| format!("3MF zip: {e}"))?;
    zip.write_all(
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
          <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
          <Relationship Target=\"/3D/3dmodel.model\" Id=\"rel0\" \
          Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/>\
          </Relationships>",
    )
    .map_err(|e| format!("3MF zip: {e}"))?;

    // ── 3D/3dmodel.model ──
    // The old approach called zip.write_all once per vertex/triangle — for a
    // 2 M-triangle mesh that is ~8 M individual DEFLATE feed calls, each with
    // full compressor overhead. Instead we accumulate XML into a 4 MB in-memory
    // chunk and flush to DEFLATE in bulk, reducing compressor calls by >1000×.
    zip.start_file("3D/3dmodel.model", deflate_opts)
        .map_err(|e| format!("3MF zip: {e}"))?;

    const CHUNK: usize = 4 * 1024 * 1024;
    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK + 512);

    buf.extend_from_slice(
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
          <model unit=\"millimeter\" xml:lang=\"en-US\" \
          xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\
          <resources><object id=\"1\" type=\"model\"><mesh><vertices>",
    );

    // ── Vertices ──
    for i in 0..tri_count {
        let base = i * 36;
        for j in 0..3usize {
            let fbase = base + j * 12;
            let x = read_f32_le(raw, fbase);
            let y = read_f32_le(raw, fbase + 4);
            let z = read_f32_le(raw, fbase + 8);
            write!(buf, "<vertex x=\"{x:.4}\" y=\"{y:.4}\" z=\"{z:.4}\"/>").unwrap();
        }
        // Flush every ~4 MB so we never hold more than one chunk in memory.
        if buf.len() >= CHUNK {
            zip.write_all(&buf).map_err(|e| format!("3MF zip: {e}"))?;
            buf.clear();
        }
    }

    buf.extend_from_slice(b"</vertices><triangles>");

    // ── Triangles (sequential indices: tri i → 3i, 3i+1, 3i+2) ──
    for i in 0..tri_count {
        let v0 = i * 3;
        write!(
            buf,
            "<triangle v1=\"{v0}\" v2=\"{}\" v3=\"{}\"/>",
            v0 + 1,
            v0 + 2
        )
        .unwrap();
        if buf.len() >= CHUNK {
            zip.write_all(&buf).map_err(|e| format!("3MF zip: {e}"))?;
            buf.clear();
        }
    }

    buf.extend_from_slice(
        b"</triangles></mesh></object></resources>\
          <build><item objectid=\"1\"/></build></model>",
    );
    zip.write_all(&buf).map_err(|e| format!("3MF zip: {e}"))?;

    zip.finish().map_err(|e| format!("3MF zip finish: {e}"))?;
    Ok(())
}

/// Exports raw staged geometry to a properly formatted mesh file.
///
/// JS sends raw triangle vertex data (9 × f32 LE per triangle) to a staging
/// file via `append_mesh_stage_chunk`, then calls this command to convert
/// the staging file into a valid STL or 3MF at the user-chosen destination.
#[tauri::command]
async fn export_mesh_file(
    staging_path: String,
    dest_path: String,
    format: String,
) -> Result<String, String> {
    // Flush and release the staged file appender if it was writing to our staging file,
    // so all buffered bytes are written before we read.
    {
        let mut lock = staged_mesh_file_appender()
            .lock()
            .map_err(|e| format!("Appender lock poisoned: {e}"))?;
        let matches = lock.as_ref().map_or(false, |a| a.path == staging_path);
        if matches {
            if let Some(appender) = lock.as_mut() {
                use std::io::Write;
                appender
                    .writer
                    .flush()
                    .map_err(|e| format!("Failed flushing staging appender: {e}"))?;
            }
            *lock = None; // release file handle
        }
    }

    let raw = std::fs::read(&staging_path)
        .map_err(|e| format!("Failed reading staging file '{}': {e}", staging_path))?;

    if raw.len() % 36 != 0 {
        return Err(format!(
            "Invalid staging data: {} bytes is not a multiple of 36 (9 × f32 per triangle)",
            raw.len()
        ));
    }
    let tri_count = raw.len() / 36;
    if tri_count == 0 {
        return Err("Cannot export: no triangles in staged geometry.".into());
    }

    log::info!(
        "[export_mesh_file] {} triangles → {} format → {}",
        tri_count,
        format,
        dest_path
    );

    match format.as_str() {
        "stl" => write_binary_stl(&raw, tri_count, &dest_path)?,
        "3mf" => write_3mf(&raw, tri_count, &dest_path)?,
        _ => return Err(format!("Unsupported export format: {format}")),
    }

    // Clean up staging file
    let _ = std::fs::remove_file(&staging_path);

    Ok(dest_path)
}

#[tauri::command]
async fn slice_solid_native(
    window: DragonFruitWindow,
    job_json: String,
) -> Result<Response, String> {
    let flag = cancel_flag().clone();
    flag.store(false, Ordering::SeqCst);

    let win = window.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let job: dragonfruit_slicing_engine::types::SliceJobV3 = serde_json::from_str(&job_json)
            .map_err(|err| format!("Invalid SliceJobV3 JSON: {err}"))?;

        let progress_cb = make_throttled_progress_cb(win);

        slicer_pool().install(|| -> Result<Vec<u8>, String> {
            let artifact = dragonfruit_slicing_engine::slice_with_progress_v3(
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

    let offset_header = request.headers().get("x-mesh-stage-offset");
    let is_first_chunk = match offset_header {
        Some(value) => {
            let raw = value
                .to_str()
                .map_err(|e| format!("Invalid x-mesh-stage-offset header value: {e}"))?
                .trim();
            if raw.is_empty() {
                false
            } else {
                raw.parse::<u64>()
                    .map_err(|e| format!("Invalid x-mesh-stage-offset header value: {e}"))?
                    == 0
            }
        }
        None => false,
    };

    let mut appender_lock = staged_mesh_file_appender()
        .lock()
        .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;

    let needs_new_appender = match appender_lock.as_ref() {
        Some(existing) => is_first_chunk || existing.path != path_text,
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
    appender
        .writer
        .flush()
        .map_err(|err| format!("Failed flushing mesh stage bytes: {err}"))?;
    appender.len = appender.len.saturating_add(bytes.len() as u64);

    Ok(appender.len)
}

#[tauri::command]
async fn finish_mesh_stage_write(path: String) -> Result<u64, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("finish_mesh_stage_write requires a non-empty path".into());
    }

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
            let len = appender.len;
            *appender_lock = None; // release OS file handle immediately
            return Ok(len);
        }
    }

    // No open appender for this path (already closed or never opened).
    Ok(0)
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
    window: DragonFruitWindow,
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
        let requested_output_path = meta
            .output_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());

        let mesh_decode_start = std::time::Instant::now();
        let triangles_xyz = decode_mesh_bytes(mesh_bytes, &meta)?;
        let mesh_decode_ns = duration_ns_u64(mesh_decode_start.elapsed());

        let job = dragonfruit_slicing_engine::SliceJobV3 {
            output_format: meta.output_format,
            format_version: meta.format_version,
            source_width_px: meta.source_width_px,
            source_height_px: meta.source_height_px,
            width_px: meta.width_px,
            height_px: meta.height_px,
            x_packing_mode: meta.x_packing_mode.unwrap_or_else(|| "none".to_string()),
            png_compression_strategy: meta.png_compression_strategy,
            anti_aliasing_level: meta.anti_aliasing_level,
            anti_aliasing_mode: meta.anti_aliasing_mode,
            blur_brush_radius_px: meta.blur_brush_radius_px,
            blur_brush_kernel: meta.blur_brush_kernel,
            blur_brush_sigma_x: meta.blur_brush_sigma_x,
            blur_brush_sigma_y: meta.blur_brush_sigma_y,
            z_blur_radius_layers: meta.z_blur_radius_layers,
            z_blur_kernel: meta.z_blur_kernel,
            z_blur_sigma: meta.z_blur_sigma,
            aa_on_supports: meta.aa_on_supports,
            model_triangle_count: meta.model_triangle_count,
            minimum_aa_alpha_percent: meta.minimum_aa_alpha_percent,
            mirror_x: meta.mirror_x,
            mirror_y: meta.mirror_y,
            z_blend_look_back: meta.z_blend_look_back,
            z_blend_fade_px: meta.z_blend_fade_px,
            z_blend_auto_fade: meta.z_blend_auto_fade,
            z_blend_minimum_alpha_percent: meta.z_blend_minimum_alpha_percent,
            z_blend_max_alpha_percent: meta.z_blend_max_alpha_percent,
            z_blend_custom_lut: meta.z_blend_custom_lut,
            zaa_kernel: meta.zaa_kernel,
            zaa_pattern: meta.zaa_pattern,
            zaa_duplicate_z: meta.zaa_duplicate_z,
            dither_enabled: meta.dither_enabled,
            dither_bit_depth: meta.dither_bit_depth,
            dither_device_gamma: meta.dither_device_gamma,
            container_compression_level: meta.container_compression_level,
            build_width_mm: meta.build_width_mm,
            build_depth_mm: meta.build_depth_mm,
            layer_height_mm: meta.layer_height_mm,
            total_layers: meta.total_layers,
            export_thumbnail_png_base64: meta.export_thumbnail_png_base64,
            triangles_xyz,
            metadata_json: meta.metadata_json,
        };

        eprintln!(
            "[SupportAA] native job decoded: model_triangles={} support_triangles={} total_triangles={} aa_on_supports={} mode={} level={} mesh_encoding={}",
            job.model_triangle_count,
            (job.triangles_xyz.len() / 9).saturating_sub(job.model_triangle_count as usize),
            job.triangles_xyz.len() / 9,
            job.aa_on_supports,
            job.anti_aliasing_mode,
            job.anti_aliasing_level,
            meta.mesh_encoding.as_deref().unwrap_or("raw_f32"),
        );
        let fingerprint = |start: usize, end: usize| {
            let mut hash = 0x811c9dc5u32;
            for value in &job.triangles_xyz[start.min(job.triangles_xyz.len())
                ..end.min(job.triangles_xyz.len())]
            {
                hash ^= value.to_bits();
                hash = hash.wrapping_mul(0x01000193);
            }
            format!("{hash:08x}")
        };
        let multiset_fingerprint = |start: usize, end: usize| {
            let mut xor = 0u32;
            let mut sum = 0u32;
            for value in &job.triangles_xyz[start.min(job.triangles_xyz.len())
                ..end.min(job.triangles_xyz.len())]
            {
                let bits = value.to_bits();
                xor ^= bits;
                sum = sum.wrapping_add(bits);
            }
            format!("{xor:08x}:{sum:08x}")
        };
        let model_float_end = (job.model_triangle_count as usize)
            .saturating_mul(9)
            .min(job.triangles_xyz.len());
        eprintln!(
            "[SupportAA] native geometry fingerprints: model={} support={} model_multiset={} support_multiset={}",
            fingerprint(0, model_float_end),
            fingerprint(model_float_end, job.triangles_xyz.len()),
            multiset_fingerprint(0, model_float_end),
            multiset_fingerprint(model_float_end, job.triangles_xyz.len()),
        );

        let progress_cb = make_throttled_progress_cb(win);
        let requested_output_path = requested_output_path.clone();

        slicer_pool().install(
            || -> Result<(String, u64, NativeSlicerPerfMetrics, NativeSlicerRuntimeMetrics), String> {
            let ext = if job.output_format.trim().is_empty() {
                let format_provider = plugin_registry::get_format_provider()
                    .unwrap_or_else(|_| plugin_registry::get_default_format_provider());
                format_provider.default_export_format()
            } else {
                job.output_format.trim_start_matches('.')
            };
            let path = if let Some(requested_path) = requested_output_path.as_deref() {
                let requested = std::path::PathBuf::from(requested_path);
                if let Some(parent) = requested.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|err| format!("Failed creating output folder: {err}"))?;
                }
                requested
            } else {
                temp_artifact_path(ext)
            };

            let perf_raw = dragonfruit_slicing_engine::engine::slice_with_progress_v3_to_path(
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
                z_blend_backward_ns: perf_raw.z_blend_backward_ns,
                z_blend_forward_ns: perf_raw.z_blend_forward_ns,
                cross_blend_ns: perf_raw.cross_blend_ns,
                cross_blend_touched_pixels: perf_raw.cross_blend_touched_pixels,
                cross_blend_contributing_layers: perf_raw.cross_blend_contributing_layers,
                post_blur_ns: perf_raw.post_blur_ns,
                support_merge_ns: perf_raw.support_merge_ns,
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
                perf_raw.daa_post_threads,
                perf_raw.daa_post_buffer_depth,
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
    window: DragonFruitWindow,
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
        let triangles = dragonfruit_slicing_engine::geometry::parse_triangles(&triangles_xyz);

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
        log::debug!(
            "[island-scan-native] triangles={} bbox=({:.4},{:.4},{:.4})-({:.4},{:.4},{:.4}) px_mm={} layer_h={} buf={} conn={} min_area={} overlap_px={} neighborhood={}",
            triangles.len(),
            params.bbox_min_x, params.bbox_min_y, params.bbox_min_z,
            params.bbox_max_x, params.bbox_max_y, params.bbox_max_z,
            params.px_mm, params.layer_height_mm, params.support_buffer_mm,
            params.connectivity, params.min_island_area_mm2,
            params.min_overlap_px, params.overlap_neighborhood_px,
        );
        log::debug!("[island-scan-native] debug dump: {}", dump_dir.display());

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
        log::info!(
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
    #[serde(default)]
    filters: Option<Vec<SaveDialogFilterDef>>,
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

const LOCAL_BACKUP_STATE_FILE_NAME: &str = "state.json";
const LOCAL_BACKUP_HISTORY_DIR_NAME: &str = "history";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBackupStateResponse {
    document_json: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBackupSyncResponse {
    synced_at: String,
    history_id: String,
    state_path: String,
    history_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBackupHistoryEntry {
    id: String,
    path: String,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBackupReadHistoryResponse {
    document_json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBackupRestoreResponse {
    synced_at: Option<String>,
}

fn normalize_backup_directory_path(directory_path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = directory_path.trim();
    if trimmed.is_empty() {
        return Err("Backup directory path is empty".to_string());
    }

    let mut path = std::path::PathBuf::from(trimmed);
    if !path.is_absolute() {
        path = std::env::current_dir()
            .map_err(|err| format!("Failed to resolve current directory: {err}"))?
            .join(path);
    }

    Ok(path)
}

fn local_backup_state_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join(LOCAL_BACKUP_STATE_FILE_NAME)
}

fn local_backup_history_dir(root: &std::path::Path) -> std::path::PathBuf {
    root.join(LOCAL_BACKUP_HISTORY_DIR_NAME)
}

fn is_valid_local_backup_history_id(id: &str) -> bool {
    id.len() == 13 && id.chars().all(|char| char.is_ascii_digit())
}

fn local_backup_history_file_path(
    root: &std::path::Path,
    id: &str,
) -> Result<std::path::PathBuf, String> {
    if !is_valid_local_backup_history_id(id) {
        return Err("Invalid backup history identifier".to_string());
    }

    Ok(local_backup_history_dir(root).join(format!("{id}.json")))
}

fn ensure_local_backup_structure(root: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|err| {
        format!(
            "Failed creating backup directory '{}': {err}",
            root.display()
        )
    })?;

    std::fs::create_dir_all(local_backup_history_dir(root)).map_err(|err| {
        format!(
            "Failed creating backup history directory '{}': {err}",
            local_backup_history_dir(root).display()
        )
    })?;

    Ok(())
}

fn extract_backup_document_updated_at(raw: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;

    parsed
        .get("updatedAt")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| {
            parsed
                .get("snapshot")
                .and_then(|snapshot| snapshot.get("updatedAt"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        })
}

#[tauri::command]
async fn local_backup_default_directory(app: DragonFruitAppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;

        let base = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("Failed resolving app data directory: {err}"))?;

        let directory = base.join("backups");
        std::fs::create_dir_all(&directory).map_err(|err| {
            format!(
                "Failed creating default backup directory '{}': {err}",
                directory.display()
            )
        })?;

        Ok(directory.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| format!("Default backup directory task failed to join: {err}"))?
}

#[tauri::command]
async fn local_backup_pick_directory(current_path: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();

        if let Some(path) = current_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            dialog = dialog.set_directory(path);
        }

        let picked = dialog
            .pick_folder()
            .ok_or_else(|| "Folder selection cancelled by user".to_string())?;

        Ok(picked.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| format!("Pick backup folder task failed to join: {err}"))?
}

#[tauri::command]
async fn local_backup_read_state(
    directory_path: String,
) -> Result<LocalBackupStateResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = normalize_backup_directory_path(&directory_path)?;
        let state_path = local_backup_state_path(&root);

        match std::fs::read_to_string(&state_path) {
            Ok(content) => Ok(LocalBackupStateResponse {
                updated_at: extract_backup_document_updated_at(&content),
                document_json: Some(content),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(LocalBackupStateResponse {
                    updated_at: None,
                    document_json: None,
                })
            }
            Err(error) => Err(format!(
                "Failed reading backup state file '{}': {error}",
                state_path.display()
            )),
        }
    })
    .await
    .map_err(|err| format!("Read backup state task failed to join: {err}"))?
}

#[tauri::command]
async fn local_backup_sync(
    directory_path: String,
    document_json: String,
) -> Result<LocalBackupSyncResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = normalize_backup_directory_path(&directory_path)?;
        ensure_local_backup_structure(&root)?;

        let parsed = serde_json::from_str::<serde_json::Value>(&document_json)
            .map_err(|err| format!("Invalid backup document JSON: {err}"))?;
        let normalized_document = serde_json::to_string_pretty(&parsed)
            .map_err(|err| format!("Failed formatting backup document JSON: {err}"))?;

        let synced_at = parsed
            .get("updatedAt")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .or_else(|| {
                parsed
                    .get("snapshot")
                    .and_then(|snapshot| snapshot.get("updatedAt"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
            })
            .unwrap_or_else(|| String::new());

        let history_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis().to_string())
            .unwrap_or_else(|_| "0".to_string());

        let state_path = local_backup_state_path(&root);
        let history_path = local_backup_history_file_path(&root, &history_id)?;

        std::fs::write(&state_path, normalized_document.as_bytes()).map_err(|err| {
            format!(
                "Failed writing backup state file '{}': {err}",
                state_path.display()
            )
        })?;

        std::fs::write(&history_path, normalized_document.as_bytes()).map_err(|err| {
            format!(
                "Failed writing backup history file '{}': {err}",
                history_path.display()
            )
        })?;

        Ok(LocalBackupSyncResponse {
            synced_at,
            history_id,
            state_path: state_path.to_string_lossy().to_string(),
            history_path: history_path.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|err| format!("Local backup sync task failed to join: {err}"))?
}

#[tauri::command]
async fn local_backup_list_history(
    directory_path: String,
) -> Result<Vec<LocalBackupHistoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = normalize_backup_directory_path(&directory_path)?;
        let history_dir = local_backup_history_dir(&root);

        if !history_dir.exists() {
            return Ok(Vec::new());
        }

        let read_dir = std::fs::read_dir(&history_dir).map_err(|err| {
            format!(
                "Failed listing backup history directory '{}': {err}",
                history_dir.display()
            )
        })?;

        let mut entries: Vec<LocalBackupHistoryEntry> = Vec::new();

        for dir_entry in read_dir.flatten() {
            let path = dir_entry.path();
            if !path.is_file() {
                continue;
            }

            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if extension != "json" {
                continue;
            }

            let id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            if !is_valid_local_backup_history_id(&id) {
                continue;
            }

            let updated_at = std::fs::read_to_string(&path)
                .ok()
                .and_then(|content| extract_backup_document_updated_at(&content));

            entries.push(LocalBackupHistoryEntry {
                id,
                path: path.to_string_lossy().to_string(),
                updated_at,
            });
        }

        entries.sort_by(|left, right| right.id.cmp(&left.id));

        Ok(entries)
    })
    .await
    .map_err(|err| format!("List local backup history task failed to join: {err}"))?
}

#[tauri::command]
async fn local_backup_read_history_item(
    directory_path: String,
    id: String,
) -> Result<LocalBackupReadHistoryResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = normalize_backup_directory_path(&directory_path)?;
        let history_path = local_backup_history_file_path(&root, id.trim())?;

        let document_json = std::fs::read_to_string(&history_path).map_err(|err| {
            format!(
                "Failed reading backup history file '{}': {err}",
                history_path.display()
            )
        })?;

        Ok(LocalBackupReadHistoryResponse { document_json })
    })
    .await
    .map_err(|err| format!("Read local backup history item task failed to join: {err}"))?
}

#[tauri::command]
async fn local_backup_delete_history_item(
    directory_path: String,
    id: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = normalize_backup_directory_path(&directory_path)?;
        let history_path = local_backup_history_file_path(&root, id.trim())?;

        match std::fs::remove_file(&history_path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!(
                "Failed deleting backup history file '{}': {error}",
                history_path.display()
            )),
        }
    })
    .await
    .map_err(|err| format!("Delete local backup history item task failed to join: {err}"))?
}

#[tauri::command]
async fn local_backup_restore_history_item(
    directory_path: String,
    id: String,
) -> Result<LocalBackupRestoreResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = normalize_backup_directory_path(&directory_path)?;
        ensure_local_backup_structure(&root)?;

        let history_path = local_backup_history_file_path(&root, id.trim())?;
        let state_path = local_backup_state_path(&root);

        let document_json = std::fs::read_to_string(&history_path).map_err(|err| {
            format!(
                "Failed reading backup history file '{}': {err}",
                history_path.display()
            )
        })?;

        std::fs::write(&state_path, document_json.as_bytes()).map_err(|err| {
            format!(
                "Failed restoring backup state file '{}': {err}",
                state_path.display()
            )
        })?;

        Ok(LocalBackupRestoreResponse {
            synced_at: extract_backup_document_updated_at(&document_json),
        })
    })
    .await
    .map_err(|err| format!("Restore local backup history item task failed to join: {err}"))?
}

// ---------------------------------------------------------------------------
// Scene Autosave
// ---------------------------------------------------------------------------

const SCENE_AUTOSAVE_DIR_NAME: &str = "autosave";
const SCENE_AUTOSAVE_VOXL_FILE: &str = "scene.voxl";
const SCENE_AUTOSAVE_MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SceneAutosaveManifest {
    saved_at: String,
    clean: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneAutosavePaths {
    voxl_path: String,
    manifest_path: String,
}

fn scene_autosave_resolve_dir(app: &DragonFruitAppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed resolving app data dir: {err}"))?;
    let dir = base.join(SCENE_AUTOSAVE_DIR_NAME);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed creating autosave dir '{}': {err}", dir.display()))?;
    Ok(dir)
}

#[tauri::command]
async fn scene_autosave_get_paths(
    app: DragonFruitAppHandle,
    preferred_save_path: Option<String>,
) -> Result<SceneAutosavePaths, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = scene_autosave_resolve_dir(&app)?;

        // Determine VOXL autosave path: if user has explicitly saved to a .voxl file,
        // autosave directly to that file. Otherwise use the generic recovery location.
        let voxl_path = if let Some(preferred) = preferred_save_path {
            let path = std::path::Path::new(&preferred);
            if is_scene_file_path(path) && path.exists() {
                // User has explicitly saved; autosave directly to that file
                preferred
            } else {
                // Not a valid scene file or doesn't exist; fall back to generic recovery
                dir.join(SCENE_AUTOSAVE_VOXL_FILE)
                    .to_string_lossy()
                    .to_string()
            }
        } else {
            // No preferred path; use generic recovery location
            dir.join(SCENE_AUTOSAVE_VOXL_FILE)
                .to_string_lossy()
                .to_string()
        };

        Ok(SceneAutosavePaths {
            voxl_path,
            manifest_path: dir
                .join(SCENE_AUTOSAVE_MANIFEST_FILE)
                .to_string_lossy()
                .to_string(),
        })
    })
    .await
    .map_err(|err| format!("scene_autosave_get_paths task failed: {err}"))?
}

#[tauri::command]
async fn scene_autosave_write_manifest(
    app: DragonFruitAppHandle,
    saved_at: String,
    clean: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = scene_autosave_resolve_dir(&app)?;
        let manifest = SceneAutosaveManifest { saved_at, clean };
        let json = serde_json::to_string(&manifest)
            .map_err(|err| format!("Failed serializing autosave manifest: {err}"))?;
        let path = dir.join(SCENE_AUTOSAVE_MANIFEST_FILE);
        std::fs::write(&path, json.as_bytes())
            .map_err(|err| format!("Failed writing autosave manifest: {err}"))?;
        Ok(())
    })
    .await
    .map_err(|err| format!("scene_autosave_write_manifest task failed: {err}"))?
}

#[tauri::command]
async fn scene_autosave_read_manifest(
    app: DragonFruitAppHandle,
) -> Result<Option<SceneAutosaveManifest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = scene_autosave_resolve_dir(&app)?;
        let path = dir.join(SCENE_AUTOSAVE_MANIFEST_FILE);
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|err| format!("Failed reading autosave manifest: {err}"))?;
        let manifest: SceneAutosaveManifest = serde_json::from_str(&content)
            .map_err(|err| format!("Failed parsing autosave manifest: {err}"))?;
        Ok(Some(manifest))
    })
    .await
    .map_err(|err| format!("scene_autosave_read_manifest task failed: {err}"))?
}

#[tauri::command]
async fn scene_autosave_read_voxl_bytes(app: DragonFruitAppHandle) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let dir = scene_autosave_resolve_dir(&app)?;
        let path = dir.join(SCENE_AUTOSAVE_VOXL_FILE);
        if !path.exists() {
            return Err("No autosaved scene file found".to_string());
        }
        std::fs::read(&path).map_err(|err| format!("Failed reading autosaved scene: {err}"))
    })
    .await
    .map_err(|err| format!("scene_autosave_read_voxl_bytes task failed: {err}"))??;

    Ok(Response::new(bytes))
}

fn is_scene_file_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let normalized = ext.trim().trim_start_matches('.');
            normalized.eq_ignore_ascii_case("voxl")
                || BUILTIN_PLUGIN_SCENE_EXTENSIONS
                    .iter()
                    .any(|&s| normalized.eq_ignore_ascii_case(s))
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

    // Build scene extension list: voxl + all plugin-registered extensions + zip (for bundles)
    let mut scene_exts: Vec<&str> = vec!["voxl"];
    scene_exts.extend_from_slice(BUILTIN_PLUGIN_SCENE_EXTENSIONS);
    scene_exts.push("zip");

    let normalized = category.trim().to_ascii_lowercase();
    dialog = match normalized.as_str() {
        "mesh" => dialog.add_filter("Mesh Files", &["stl", "obj", "3mf", "zip"]),
        "scene" => dialog.add_filter("Scene Files", &scene_exts),
        "bundle" => dialog.add_filter("JSON Files", &["json"]),
        _ => dialog
            .add_filter("Mesh Files", &["stl", "obj", "3mf", "zip"])
            .add_filter("Scene Files", &scene_exts),
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

        let picked = build_save_dialog_with_filters(&suggested_name, None)
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

        let picked = build_save_dialog_with_filters(&suggested_name, None)
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

        let picked = build_save_dialog_with_filters(&suggested_name, args.filters.as_deref())
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

fn emit_scene_file_handoff(app: &DragonFruitAppHandle, args: &[String], source: &str) {
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

fn focus_main_window(app: &DragonFruitAppHandle) {
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
fn get_slicer_engine_version() -> &'static str {
    dragonfruit_slicing_engine::ENGINE_VERSION
}

#[tauri::command]
async fn notify_launch_scene_handoff(app: DragonFruitAppHandle) -> Result<(), String> {
    let args = std::env::args().collect::<Vec<_>>();
    emit_scene_file_handoff(&app, &args, "primary-launch");
    Ok(())
}

#[tauri::command]
async fn focus_main_window_command(app: DragonFruitAppHandle) -> Result<(), String> {
    focus_main_window(&app);
    Ok(())
}

/// Reveals the main window without calling set_focus().
/// Used at startup to avoid triggering the Windows focus-stealing prevention
/// mechanism, which plays an error sound when SetForegroundWindow is called
/// from a process that does not currently own the foreground.
/// Also closes the splash screen window if it is still open.
#[tauri::command]
async fn reveal_main_window_command(app: DragonFruitAppHandle) -> Result<(), String> {
    // Show the main window first so there is no gap between splash close and
    // main window appearance (which would expose the desktop for a frame).
    // Maximize before show so the window is already at full size when it
    // becomes visible — avoids a two-step resize flash on Windows.
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(true);
        if !is_visible {
            let _ = window.maximize();
            // Re-enable taskbar entry just before we make the window visible.
            #[cfg(target_os = "windows")]
            let _ = window.set_skip_taskbar(false);
            let _ = window.show();
        }
    }
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
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
async fn read_print_file_size(source_path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = std::path::PathBuf::from(source_path.trim());
        if !source.exists() {
            return Err("Source print file no longer exists on disk".to_string());
        }

        std::fs::metadata(&source)
            .map(|meta| meta.len())
            .map_err(|err| format!("Failed reading print file metadata: {err}"))
    })
    .await
    .map_err(|err| format!("Read-size task failed to join: {err}"))?
}

#[tauri::command]
async fn read_print_file_chunk(
    source_path: String,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;

    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let source = std::path::PathBuf::from(source_path.trim());
        if !source.exists() {
            return Err("Source print file no longer exists on disk".to_string());
        }

        let mut file = std::fs::File::open(&source)
            .map_err(|err| format!("Failed opening print file: {err}"))?;

        let file_len = file
            .metadata()
            .map_err(|err| format!("Failed reading print file metadata: {err}"))?
            .len();

        if offset >= file_len {
            return Ok(Vec::new());
        }

        let remaining = file_len - offset;
        let requested = length.max(1).min(MAX_CHUNK_BYTES as u64).min(remaining) as usize;

        use std::io::{Read, Seek, SeekFrom};
        file.seek(SeekFrom::Start(offset))
            .map_err(|err| format!("Failed seeking print file chunk: {err}"))?;

        let mut chunk = vec![0u8; requested];
        file.read_exact(&mut chunk)
            .map_err(|err| format!("Failed reading print file chunk: {err}"))?;

        Ok(chunk)
    })
    .await
    .map_err(|err| format!("Read-chunk task failed to join: {err}"))??;

    Ok(Response::new(bytes))
}

#[tauri::command]
async fn read_print_layer_png(
    source_path: String,
    layer_number: u32,
    format_hint: String,
) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        if layer_number == 0 {
            return Err("Layer number must be >= 1".to_string());
        }

        let source = std::path::PathBuf::from(source_path.trim());
        if !source.exists() {
            return Err("Source print file no longer exists on disk".to_string());
        }

        dragonfruit_slicing_engine::engine::read_layer_preview_png_by_format_hint(
            &source,
            layer_number,
            &format_hint,
        )
        .map_err(|err| err.to_string())
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

/// Open the folder containing the given path in the OS file manager.
/// On Windows this uses `explorer /select,<path>` to highlight the file.
/// On macOS it uses `open -R <path>`. On Linux it falls back to `xdg-open`
/// on the parent directory.
#[tauri::command]
async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("Path is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        let p = std::path::Path::new(&path);
        let dir = p.parent().unwrap_or(p);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
async fn discover_uvtools_path(candidates: Vec<String>) -> Result<Option<String>, String> {
    // Check candidate absolute paths first
    for candidate in &candidates {
        let p = std::path::Path::new(candidate);
        if p.exists() && p.is_file() {
            return Ok(Some(candidate.clone()));
        }
    }

    // Check PATH for UVTools.exe
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let exe_candidate = dir.join("UVTools.exe");
            if exe_candidate.exists() && exe_candidate.is_file() {
                return Ok(Some(exe_candidate.to_string_lossy().to_string()));
            }
        }
    }

    Ok(None)
}

#[tauri::command]
async fn launch_external_process(exe_path: String, file_arg: String) -> Result<(), String> {
    let exe_path = exe_path.trim().to_string();
    let file_arg = file_arg.trim().to_string();

    if exe_path.is_empty() {
        return Err("Executable path is empty".to_string());
    }

    std::process::Command::new(&exe_path)
        .arg(&file_arg)
        .spawn()
        .map_err(|e| format!("Failed to launch external process: {e}"))?;

    Ok(())
}

/// Returns the path to the log-level preference file.
/// This is intentionally computed with raw env vars so it can be called
/// before the Tauri app (and its path resolver) is initialised.
fn resolve_log_level_pref_path() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        std::path::PathBuf::from(appdata)
            .join("org.openresinalliance.dragonfruit")
            .join("loglevel")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("org.openresinalliance.dragonfruit")
            .join("loglevel")
    }
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            format!("{}/.local/share", std::env::var("HOME").unwrap_or_default())
        });
        std::path::PathBuf::from(base)
            .join("org.openresinalliance.dragonfruit")
            .join("loglevel")
    }
}

fn read_log_level_pref() -> log::LevelFilter {
    let content = std::fs::read_to_string(resolve_log_level_pref_path()).unwrap_or_default();
    match content.trim() {
        "error" => log::LevelFilter::Error,
        "warn" => log::LevelFilter::Warn,
        "info" => log::LevelFilter::Info,
        "debug" => log::LevelFilter::Debug,
        "trace" => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    }
}

/// Persist the user's preferred log level to disk AND apply it immediately
/// at runtime via `log::set_max_level`. No restart required.
#[tauri::command]
async fn set_log_level_pref(level: String) -> Result<(), String> {
    const VALID: &[&str] = &["error", "warn", "info", "debug", "trace"];
    let level = level.trim().to_lowercase();
    if !VALID.contains(&level.as_str()) {
        return Err(format!("Invalid log level: {level}"));
    }
    // Apply immediately — log::set_max_level is atomic and takes effect for all
    // subsequent log macro calls without any restart.
    let filter = match level.as_str() {
        "error" => log::LevelFilter::Error,
        "warn" => log::LevelFilter::Warn,
        "info" => log::LevelFilter::Info,
        "debug" => log::LevelFilter::Debug,
        "trace" => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    };
    log::set_max_level(filter);
    // Persist for next startup.
    let path = resolve_log_level_pref_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    std::fs::write(&path, level.as_bytes())
        .map_err(|e| format!("Failed to write log level pref: {e}"))
}

/// Return the last `lines` lines of the log file for the live viewer in Settings.
/// Returns an empty string if the file does not yet exist.
#[tauri::command]
async fn read_log_tail(app: DragonFruitAppHandle, lines: usize) -> Result<String, String> {
    use tauri::Manager;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve log dir: {e}"))?;
    let log_file = log_dir.join("dragonfruit.log");
    match std::fs::read_to_string(&log_file) {
        Ok(content) => {
            let max = lines.clamp(10, 10_000);
            // Collect the last `max` non-empty lines without reversing the order.
            let all: Vec<&str> = content.lines().collect();
            let tail = if all.len() > max {
                &all[all.len() - max..]
            } else {
                &all[..]
            };
            Ok(tail.join("\n"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Failed to read log file: {e}")),
    }
}

/// Open the log file in the OS default text editor / viewer.
#[tauri::command]
async fn open_log_file(app: DragonFruitAppHandle) -> Result<(), String> {
    use tauri::Manager;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve log dir: {e}"))?;
    let log_file = log_dir.join("dragonfruit.log");
    if !log_file.exists() {
        return Err("Log file does not exist yet.".to_string());
    }
    let path_str = log_file.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("notepad.exe")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("Failed to open log file: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-t", &path_str])
            .spawn()
            .map_err(|e| format!("Failed to open log file: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("Failed to open log file: {e}"))?;
    }
    Ok(())
}

/// Delete the log file so it starts fresh on the next write.
#[tauri::command]
async fn delete_log_file(app: DragonFruitAppHandle) -> Result<(), String> {
    use tauri::Manager;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve log dir: {e}"))?;
    let log_file = log_dir.join("dragonfruit.log");
    match std::fs::remove_file(&log_file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete log file: {e}")),
    }
}

fn main() {
    // Issue #83: on Linux with Nvidia+Wayland, WebKitGTK's DMA-BUF renderer
    // can crash inside gbm_bo_create_with_modifiers. Setting this env var
    // before any GTK/WebKit init forces the SHM fallback path, which is
    // slightly slower but stable. Only applies to the wry (WebKitGTK) path;
    // CEF uses its own compositor and is unaffected.
    #[cfg(all(target_os = "linux", not(feature = "tauri-cef")))]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            // NOTE: called at the very start of main, single-threaded, before
            // any other threads or libraries are initialized. On Rust edition
            // 2024+ this will require an unsafe block (set_var became unsafe).
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    // Install a panic hook that writes the panic location and message to the
    // DragonFruit log before the default handler runs.  This ensures that even
    // hard crashes leave a human-readable trace in the log file rather than
    // only a terse Windows Event 1005 entry.
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        let message: String = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "(non-string panic payload)".to_string()
        };
        log::error!("[panic] {message} at {location}");
        default_panic_hook(info);
    }));

    // Sweep week-old stale temp artifacts on app startup.
    let _ = sweep_stale_temp_artifacts(7 * 24 * 60 * 60);

    // Initialize plugin registry and register built-in plugins
    if let Err(error) = plugin_registry::initialize_plugins() {
        if cfg!(debug_assertions) {
            log::warn!("[plugin-registry] WARNING: {error}");
        } else {
            panic!("Failed to initialize plugin registry: {error}");
        }
    }

    log::info!(
        "DragonFruit {} starting (debug={})",
        env!("CARGO_PKG_VERSION"),
        cfg!(debug_assertions)
    );

    let _log_level = read_log_level_pref();
    // Log plugin disabled on CEF — it pulls tauri/wry transitively, causing
    // E0252 collision. See Cargo.toml comment.
    #[cfg(not(feature = "tauri-cef"))]
    let log_plugin = {
        use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};
        LogBuilder::new()
            .targets([
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::LogDir {
                    file_name: Some("dragonfruit".to_string()),
                }),
                Target::new(TargetKind::Webview),
            ])
            .level(_log_level)
            // Suppress chatty low-level transport crates — these flood the log
            // at DEBUG/TRACE and contain no actionable application information.
            .level_for("tungstenite", log::LevelFilter::Warn)
            .level_for("reqwest", log::LevelFilter::Warn)
            .level_for("hyper", log::LevelFilter::Warn)
            .level_for("hyper_util", log::LevelFilter::Warn)
            .level_for("rustls", log::LevelFilter::Warn)
            .level_for("h2", log::LevelFilter::Warn)
            .level_for("tokio_tungstenite", log::LevelFilter::Warn)
            // Updater plugin logs ERROR for non-2XX endpoint responses (expected
            // during dev when no release exists yet). The frontend handles
            // surfacing real update failures to the user, so suppress the
            // Rust-side noise here.
            .level_for("tauri_plugin_updater", log::LevelFilter::Off)
            .max_file_size(5_000_000)
            .rotation_strategy(RotationStrategy::KeepOne)
            .build()
    };

    let builder = tauri::Builder::default();
    #[cfg(not(feature = "tauri-cef"))]
    let builder = builder.plugin(log_plugin);
    let builder = builder.setup(|app| {
        let app_handle = app.handle().clone();

        // Defer main window creation to an async task so the splashscreen's
        // WebView2 instance fully initialises before the main window's does.
        // On Windows, simultaneous WebView2 init produces a brief window flash
        // even when the main window is created with visible=false.
        tauri::async_runtime::spawn(async move {
            use tauri::WebviewWindowBuilder;

            // Give the splash WebView2 a head-start on Windows only.
            #[cfg(target_os = "windows")]
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;

            let config = app_handle.config();
            let Some(window_config) = config.app.windows.iter().find(|w| w.label == "main") else {
                log::error!("Missing 'main' window config in tauri.conf.json");
                return;
            };

            let builder = match WebviewWindowBuilder::from_config(&app_handle, window_config) {
                Ok(b) => b,
                Err(e) => {
                    log::error!("Failed to create main window builder: {e}");
                    return;
                }
            };

            // Keep custom titlebar behavior on non-macOS.
            #[cfg(not(target_os = "macos"))]
            let builder = builder.decorations(false);

            // Belt-and-suspenders: enforce hidden + no taskbar entry while
            // the window is invisible, regardless of config values. On Windows
            // a taskbar button flash is the tell-tale sign the window was
            // briefly visible during WebView2 initialisation.
            let builder = builder.visible(false);
            #[cfg(target_os = "windows")]
            let builder = builder.skip_taskbar(true);

            match builder.build() {
                Ok(_window) => {
                    // On macOS, reveal immediately so a frontend startup hiccup
                    // can't leave the app invisible when created as hidden.
                    #[cfg(target_os = "macos")]
                    {
                        if let Err(error) = _window.show() {
                            log::warn!("Failed to show main window during setup: {error}");
                        }
                    }
                    log::info!("Main window created successfully");
                }
                Err(e) => log::error!("Failed to build main window: {e}"),
            }
        });

        Ok(())
    });

    // Single-instance plugin also disabled on CEF (same wry collision).
    #[cfg(not(feature = "tauri-cef"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        log::info!("Single-instance activated: second launch detected (args={argv:?})");
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

    // Updater plugin — checks GitHub releases for new versions and handles
    // download + install across all platforms.
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    // Process plugin — needed for app relaunch after update installs.
    let builder = builder.plugin(tauri_plugin_process::init());

    builder
        .invoke_handler(tauri::generate_handler![
            slice_solid_native,
            stage_mesh_binary_start,
            allocate_mesh_stage_path,
            append_mesh_stage_chunk,
            finish_mesh_stage_write,
            stage_mesh_file_path,
            stage_mesh_binary_set,
            stage_mesh_binary_chunk,
            slice_solid_native_to_temp_path,
            cancel_slicing,
            run_island_scan_native,
            export_mesh_file,
            save_print_file,
            save_print_file_from_path,
            pick_save_path,
            pick_open_files,
            get_launch_scene_files,
            get_slicer_engine_version,
            notify_launch_scene_handoff,
            focus_main_window_command,
            reveal_main_window_command,
            write_bytes_to_path,
            read_print_file_bytes,
            read_print_file_size,
            read_print_file_chunk,
            read_print_layer_png,
            delete_print_temp_file,
            cleanup_stale_print_temp_files,
            cleanup_all_print_temp_files,
            local_backup_default_directory,
            local_backup_pick_directory,
            local_backup_read_state,
            local_backup_sync,
            local_backup_list_history,
            local_backup_read_history_item,
            local_backup_delete_history_item,
            local_backup_restore_history_item,
            scene_autosave_get_paths,
            scene_autosave_write_manifest,
            scene_autosave_read_manifest,
            scene_autosave_read_voxl_bytes,
            reveal_in_file_manager,
            launch_external_process,
            discover_uvtools_path,
            set_log_level_pref,
            read_log_tail,
            open_log_file,
            delete_log_file,
            network::plugin_network_request,
            network::ensure_rtsp_relay,
            mesh_repair::mesh_analyze_from_path,
            mesh_repair::mesh_analyze_staged,
            mesh_repair::mesh_repair_from_path,
            mesh_repair::mesh_repair_staged,
            mesh_repair::mesh_classify_staged,
            mesh_repair::mesh_hollow_staged,
            mesh_repair::mesh_hollow_preview_capture_staged_source,
            mesh_repair::mesh_hollow_preview_from_captured_source,
            mesh_repair::mesh_hollow_apply_from_captured_source,
            mesh_repair::mesh_hollow_preview_read_positions,
            mesh_repair::mesh_hollow_preview_read_infill_positions,
            mesh_repair::mesh_hollow_preview_read_removed_voxel_centers,
            mesh_repair::mesh_hollow_preview_read_removed_voxel_indices,
            mesh_repair::mesh_hollow_preview_read_blocked_voxel_centers,
            mesh_repair::mesh_hollow_preview_read_cavity_positions,
            mesh_repair::mesh_hollow_staged_read_cavity_positions,
            mesh_repair::mesh_punch_staged,
            mesh_repair::mesh_punch_capture_staged_source,
            mesh_repair::mesh_punch_from_captured_source,
            mesh_repair::mesh_punch_read_positions,
            mesh_repair::mesh_repair_read_positions,
            mesh_repair::load_stl_file,
            sdf::compute_sdf_from_staged,
            sdf::compute_heightmap_from_staged,
            sdf::invalidate_sdf_cache,
            astar::run_astar_pathfinding,
            updater_channel::check_updates,
            updater_channel::perform_update,
            updater_channel::get_saved_update_channel,
            updater_channel::save_update_channel
        ])
        .run(tauri::generate_context!())
        .expect("error while running DragonFruit desktop app");
}
