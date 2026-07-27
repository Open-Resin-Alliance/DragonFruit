#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod astar;
mod mesh_minima;
mod mesh_repair;
mod network;
mod sdf;
mod stl_budget;
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

fn default_z_blend_max_alpha_percent() -> f32 {
    90.0
}

fn default_dither_device_gamma() -> f64 {
    3.0
}

mod plugin_registry;
mod window_state;

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
    // nanos alone is NOT unique: Windows SystemTime granularity is coarse
    // enough that two concurrent allocations can land in the same tick and
    // return the same path — the export writer creates/truncates, so one
    // finished export would silently replace the other. Same mechanism as
    // `allocate_mesh_stage_file_path` below and the 2026-07-20
    // `mesh_repair.rs::load_binary_stl_preview` fix: pid + a process-wide
    // counter makes uniqueness deterministic. The `dragonfruit-slice-`
    // prefix must stay byte-identical — `is_dragonfruit_temp_artifact`
    // gates both temp sweepers on it.
    static TEMP_ARTIFACT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let clean_ext = extension.trim_start_matches('.');
    path.push(format!(
        "dragonfruit-slice-{}-{stamp}-{}.{clean_ext}",
        std::process::id(),
        TEMP_ARTIFACT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    path
}

/// Marker that identifies a scene-file commit temp. Must stay byte-identical:
/// `is_scene_commit_temp_path` gates the discard command on it, so an arbitrary
/// caller-supplied path can never be deleted through that seam.
const SCENE_COMMIT_TEMP_MARKER: &str = ".tmp-";

/// Allocates the staging file for an atomic scene-file commit, as a **sibling**
/// of the target: `<target>.tmp-<pid>-<seq>`.
///
/// Sibling by construction is what makes the commit atomic — `fs::rename` is
/// only guaranteed atomic within a volume, and a temp-dir staging file can
/// easily be on a different one (a project on D:, `%TEMP%` on C:).
///
/// pid + a process-wide counter, the same idiom as
/// `allocate_mesh_stage_file_path` / `temp_artifact_path` above: nanos alone are
/// NOT unique because Windows `SystemTime` granularity lets two concurrent
/// allocations land in the same tick, and the consumer opens with
/// `truncate(true)` — two in-flight saves sharing a name would let one overwrite
/// the other's staging bytes and then rename the wrong content over the user's
/// project. Unlike those two helpers the nanos stamp is deliberately **omitted**
/// here: these temps live next to the user's project rather than in `%TEMP%`,
/// and a bounded per-process name space means a hard crash leaves at most one
/// residue file per concurrent write (reused and truncated by a later run)
/// instead of an unbounded pile of dead files in the user's folder.
fn sibling_commit_temp_path(target: &std::path::Path) -> Result<std::path::PathBuf, String> {
    static COMMIT_TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "Cannot stage an atomic commit for '{}': no UTF-8 file name",
                target.display()
            )
        })?;

    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed creating destination directory '{}': {err}",
                parent.display()
            )
        })?;
    }

    Ok(parent.join(format!(
        "{file_name}{SCENE_COMMIT_TEMP_MARKER}{}-{}",
        std::process::id(),
        COMMIT_TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )))
}

fn is_scene_commit_temp_path(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let Some((_, suffix)) = name.rsplit_once(SCENE_COMMIT_TEMP_MARKER) else {
                return false;
            };
            let mut parts = suffix.split('-');
            let pid_ok = parts
                .next()
                .map(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(false);
            let seq_ok = parts
                .next()
                .map(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(false);
            pid_ok && seq_ok && parts.next().is_none()
        })
        .unwrap_or(false)
}

const SCENE_COMMIT_RENAME_BACKOFF_MS: [u64; 3] = [50, 150, 300];

/// Commits a fully-written staging file over `target` atomically: fsync the
/// temp, then rename it into place. Either the reader sees the previous good
/// file or it sees the new one — never a truncated prefix of either.
///
/// The bounded retry is a Windows concession: a rename can transiently fail with
/// `ERROR_ACCESS_DENIED` / `ERROR_SHARING_VIOLATION` while an antivirus scanner
/// or an Explorer thumbnailer holds the destination open.
///
/// On terminal failure the temp is removed and the **previous good target is
/// left untouched** — strictly better than the pre-Ph0.1 writer, which had
/// already destroyed it by the time anything could fail.
fn commit_scene_file_atomic(
    temp: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    if !temp.exists() {
        return Err(format!(
            "Atomic commit staging file is missing: {}",
            temp.display()
        ));
    }

    // fsync the payload BEFORE the rename, or a power loss can leave the
    // rename durable while the bytes it points at are not.
    //
    // Opened for write rather than read-only (the obvious choice on unix):
    // Windows `FlushFileBuffers` requires write access to the handle, so a
    // read-only handle would fail with ERROR_ACCESS_DENIED on the platform this
    // ships to first.
    let sync_result = std::fs::OpenOptions::new()
        .write(true)
        .open(temp)
        .and_then(|file| file.sync_all());
    if let Err(err) = sync_result {
        let _ = std::fs::remove_file(temp);
        return Err(format!(
            "Failed flushing '{}' to disk before commit: {err}",
            temp.display()
        ));
    }

    let mut last_error: Option<String> = None;
    for (attempt, backoff_ms) in SCENE_COMMIT_RENAME_BACKOFF_MS.iter().enumerate() {
        match std::fs::rename(temp, target) {
            Ok(()) => {
                // Best-effort directory fsync so the rename itself is durable.
                // No portable Windows equivalent (a directory cannot be opened
                // as a file), where NTFS metadata journalling covers it.
                #[cfg(unix)]
                {
                    if let Some(parent) = target.parent() {
                        if let Ok(dir) = std::fs::File::open(parent) {
                            let _ = dir.sync_all();
                        }
                    }
                }
                return Ok(());
            }
            Err(err) => {
                last_error = Some(err.to_string());
                if attempt + 1 < SCENE_COMMIT_RENAME_BACKOFF_MS.len() {
                    std::thread::sleep(std::time::Duration::from_millis(*backoff_ms));
                }
            }
        }
    }

    let _ = std::fs::remove_file(temp);
    Err(format!(
        "Failed committing '{}' over '{}' after {} attempts: {}",
        temp.display(),
        target.display(),
        SCENE_COMMIT_RENAME_BACKOFF_MS.len(),
        last_error.unwrap_or_else(|| "unknown error".to_string()),
    ))
}

/// **User invariant: autosave ALWAYS writes `.voxl`.**
///
/// Deliberately NOT `is_scene_file_path`, which also accepts every plugin scene
/// extension (`BUILTIN_PLUGIN_SCENE_EXTENSIONS`). Autosave emits VOXL bytes, so
/// a plugin-format project must never be handed back as the autosave target —
/// that would write VOXL into a file whose extension promises a foreign format.
/// Since sub-phase B such a project gets a correctly-named
/// `<stem>_autosave.voxl` sidecar instead of being handed back verbatim, and
/// `resolve_scene_autosave_target` uses this predicate to check its own output
/// before returning it.
fn is_voxl_autosave_target(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim().trim_start_matches('.').eq_ignore_ascii_case("voxl"))
        .unwrap_or(false)
}

/// Allocates the sibling staging path for an atomic scene-file write.
#[tauri::command]
async fn scene_file_begin_atomic_write(target_path: String) -> Result<String, String> {
    let trimmed = target_path.trim().to_string();
    if trimmed.is_empty() {
        return Err("scene_file_begin_atomic_write requires a non-empty target path".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let temp = sibling_commit_temp_path(std::path::Path::new(&trimmed))?;
        Ok(temp.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| format!("scene_file_begin_atomic_write task failed: {err}"))?
}

/// fsync + atomic rename of a staged scene file over its destination.
#[tauri::command]
async fn scene_file_commit_atomic(temp_path: String, target_path: String) -> Result<(), String> {
    let temp = temp_path.trim().to_string();
    let target = target_path.trim().to_string();
    if temp.is_empty() || target.is_empty() {
        return Err("scene_file_commit_atomic requires non-empty temp and target paths".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        commit_scene_file_atomic(std::path::Path::new(&temp), std::path::Path::new(&target))
    })
    .await
    .map_err(|err| format!("scene_file_commit_atomic task failed: {err}"))?
}

/// Removes an abandoned commit staging file (the write failed before commit),
/// so a failed save does not litter the user's project folder.
///
/// Gated on `is_scene_commit_temp_path`: this command can only ever delete a
/// path this process's own allocator could have produced, never an arbitrary
/// caller-supplied file.
#[tauri::command]
async fn scene_file_discard_atomic_temp(temp_path: String) -> Result<(), String> {
    let temp = temp_path.trim().to_string();
    if temp.is_empty() {
        return Err("scene_file_discard_atomic_temp requires a non-empty path".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&temp);
        if !is_scene_commit_temp_path(path) {
            return Err(format!(
                "Refusing to discard '{temp}': not a scene-file commit temp"
            ));
        }
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|err| format!("Failed discarding commit temp '{temp}': {err}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|err| format!("scene_file_discard_atomic_temp task failed: {err}"))?
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

    // nanos alone is NOT unique: Windows SystemTime granularity is coarse
    // enough that two concurrent allocations can land in the same tick and
    // return the same path — and the consumer (`append_mesh_stage_chunk`)
    // opens with create+append, so two writers would silently interleave
    // into one stage file. Same mechanism observed concretely 2026-07-20 in
    // `mesh_repair.rs::load_binary_stl_preview` (os error 183) and fixed the
    // same way: pid + a process-wide counter makes uniqueness deterministic.
    // The `dragonfruit-mesh-stage-` prefix must stay byte-identical — audit
    // and cleanup tooling key on it.
    static MESH_STAGE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.push(format!(
        "dragonfruit-mesh-stage-{}-{stamp}-{}.bin",
        std::process::id(),
        MESH_STAGE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
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

    stage_append_chunk(path_text, bytes, is_first_chunk)
}

/// Body of `append_mesh_stage_chunk`, extracted from the `#[tauri::command]`
/// wrapper so the writer's crash-safety and contention contracts can be driven
/// directly from unit tests (a `tauri::ipc::Request` cannot be constructed in
/// one). Behaviour is byte-for-byte the pre-extraction behaviour apart from the
/// explicitly-documented contention backstop below.
pub(crate) fn stage_append_chunk(
    path_text: &str,
    bytes: &[u8],
    is_first_chunk: bool,
) -> Result<u64, String> {
    let path = std::path::PathBuf::from(path_text);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed creating mesh stage directory: {err}"))?;
    }

    let mut appender_lock = staged_mesh_file_appender()
        .lock()
        .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;

    // Contention backstop (Ph0.1 A / finding N2). There is exactly ONE
    // process-global appender. A mid-sequence chunk (offset != 0) that arrives
    // while a *different* path owns the appender means two chunked writes are
    // interleaving: the previous code silently evicted the other writer and
    // re-opened with truncate(true), so this chunk landed at offset 0 and the
    // other writer's bytes were destroyed — both files corrupt, no error.
    // The frontend single-flight queue (`runExclusiveNativeWrite` in
    // nativeSlicerBridge.ts) makes this unreachable for callers that go through
    // it; this backstop covers the one caller that streams chunks directly
    // (`sliceExportOrchestrator.handleMeshFileChunk`). A loud error beats two
    // silently corrupt files.
    //
    // Deliberately NOT extended to the `None` case: `handleMeshFileChunk` sends
    // no `x-mesh-stage-offset` header at all, so *every* chunk of a slice stage
    // is `is_first_chunk == false` and relies on the `None` branch to open its
    // file. Erroring there would break slicing outright.
    if let Some(existing) = appender_lock.as_ref() {
        if !is_first_chunk && existing.path != path_text {
            return Err(format!(
                "concurrent mesh-stage write detected: '{}' is mid-write while a chunk arrived for '{}'",
                existing.path, path_text
            ));
        }
    }

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
    finish_stage_write(&path)
}

/// Body of `finish_mesh_stage_write`, extracted for the same reason as
/// `stage_append_chunk`.
pub(crate) fn finish_stage_write(path: &str) -> Result<u64, String> {
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

        // Phase A: Calculate grid dimensions and bounds
        let origin_x = params.bbox_min_x;
        let origin_z = -params.bbox_max_y; // mask Y = -world Y
        let grid_width = ((params.bbox_max_x - params.bbox_min_x) / params.px_mm).ceil().max(1.0) as i32;
        let grid_height = ((params.bbox_max_y - params.bbox_min_y) / params.px_mm).ceil().max(1.0) as i32;
        let model_height = params.bbox_max_z - params.bbox_min_z;
        let num_layers = (model_height / params.layer_height_mm).ceil().max(0.0) as usize;

        let w = grid_width as usize;
        let h = grid_height as usize;

        // Phase B: Island scan pipeline (sequential tracking using streaming)
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
            candidate_only: false,
        };

        let win_scan = win.clone();
        let scan_result = slicer_pool().install(|| {
            dragonfruit_islands::stream::run_island_scan_streaming(
                &job,
                &triangles,
                params.bbox_min_z,
                true, // store_labels = true for Volume Analysis
                Some(&move |done: u32, total: u32| {
                    let _ = win_scan.emit("islandscan://progress", SliceProgressPayload {
                        done,
                        total,
                        phase: "Scanning".to_string(),
                    });
                }),
            )
        });
        let scan_ms = t_scan.elapsed().as_secs_f64() * 1000.0;
        let rasterize_ms = 0.0;
        let total_ms = scan_ms;

        let total_solid_px: u64 = scan_result
            .island_labels_per_layer
            .iter()
            .map(|labels| {
                labels
                    .rows
                    .iter()
                    .map(|row| row.iter().map(|run| run.length as u64).sum::<u64>())
                    .sum::<u64>()
            })
            .sum();

        log::info!(
            "[island-scan-native] grid={}x{} layers={} solid_px={} islands={} scan={:.0}ms",
            grid_width, grid_height, num_layers, total_solid_px,
            scan_result.islands.len(), scan_ms,
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
/// The generic-recovery payload name. It carries the `_autosave` marker so the
/// **third** target invariant holds without an exception: every path autosave
/// writes is self-describing, whether it is a sidecar or the fallback. The
/// directory is unchanged, so this is still "the existing generic recovery
/// location"; only the file name gained the marker.
const SCENE_AUTOSAVE_VOXL_FILE: &str = "scene_autosave.voxl";
/// The pre-Ph0.1 generic payload name. Never written any more, always searched:
/// an autosave a user already has on disk must stay recoverable.
const SCENE_AUTOSAVE_LEGACY_VOXL_FILE: &str = "scene.voxl";
const SCENE_AUTOSAVE_MANIFEST_FILE: &str = "manifest.json";

/// Every field added after `saved_at` / `clean` is `#[serde(default)]` so a
/// manifest written by a pre-Ph0.1 build still parses — losing recovery for the
/// autosave a user already has on disk would be a worse bug than the one this
/// sub-phase fixes.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SceneAutosaveManifest {
    saved_at: String,
    clean: bool,
    /// Absolute path of the payload actually committed. **Authoritative**: the
    /// manifest is written only after the atomic rename, so this can only ever
    /// name a fully-committed file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    voxl_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    /// The project the sidecar belongs to; lets recovery re-derive the sidecar
    /// when `voxl_path` has gone stale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    payload_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fallback_reason: Option<String>,
    /// Reserved for sub-phase D (finding N4). Carried here so the manifest
    /// schema settles in one change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Sidecar naming, writability, and payload identity
// ---------------------------------------------------------------------------

/// The marker that makes a recovery file self-describing in Explorer and gates
/// every deletion seam below.
const SCENE_AUTOSAVE_SIDECAR_MARKER: &str = "_autosave";

/// **THE ONE PLACE THE SIDECAR FILE NAME IS BUILT.**
///
/// Every target, every discovery candidate, and every deletion guard routes
/// through this function, so the naming scheme has exactly one definition.
///
/// *Open decision, deliberately left as a one-line change:* a per-process name
/// (`<stem>_<pid>_autosave.voxl`) would make two instances editing the same
/// project unable to collide. It is **not** the default, because the pid is
/// gone by the time it matters: after a crash — the one case clean-exit
/// deletion cannot cover — recovery would face several `MyPrint_1234_autosave`
/// files with no way to say which is current, and the orphans accumulate
/// forever. A single well-known name is unambiguous at recovery time, which is
/// the moment the file exists for. To switch, change only this format string
/// (and `is_sidecar_autosave_file`'s suffix test to a marker `contains`).
fn sidecar_autosave_file_name(project_stem: &str) -> String {
    format!("{project_stem}{SCENE_AUTOSAVE_SIDECAR_MARKER}.voxl")
}

/// `<dir>/<stem>_autosave.voxl` for a project file. `None` when the path has no
/// usable stem (the caller falls back to the recovery directory).
fn sidecar_autosave_path_for_project(project: &std::path::Path) -> Option<std::path::PathBuf> {
    let stem = project.file_stem().and_then(|s| s.to_str())?.trim();
    if stem.is_empty() {
        return None;
    }
    let parent = project.parent().unwrap_or_else(|| std::path::Path::new(""));
    Some(parent.join(sidecar_autosave_file_name(stem)))
}

/// Windows paths are case-insensitive; a candidate-list check that missed
/// `C:\Projects\...` vs `c:\projects\...` would reject a legitimate recovery.
fn autosave_paths_equal(a: &std::path::Path, b: &std::path::Path) -> bool {
    if a == b {
        return true;
    }
    a.to_string_lossy().to_ascii_lowercase() == b.to_string_lossy().to_ascii_lowercase()
}

fn is_sidecar_autosave_file(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let suffix = format!("{SCENE_AUTOSAVE_SIDECAR_MARKER}.voxl");
    let lower = name.to_ascii_lowercase();
    // Strictly longer than the suffix: a file called exactly `_autosave.voxl`
    // belongs to no project and is not ours to delete.
    lower.ends_with(&suffix) && lower.len() > suffix.len()
}

/// The deletion gate. Only a file this policy could itself have produced — a
/// `<stem>_autosave.voxl` sidecar, or the generic recovery payload — may be
/// removed through any of the cleanup seams. The user's project never qualifies.
fn is_deletable_autosave_payload(
    recovery_dir: &std::path::Path,
    path: &std::path::Path,
) -> bool {
    is_sidecar_autosave_file(path)
        || autosave_paths_equal(path, &recovery_dir.join(SCENE_AUTOSAVE_LEGACY_VOXL_FILE))
}

/// Deletes the sidecar belonging to `project`, if there is one.
///
/// Used on Save As, where the sidecar beside the **old** project would otherwise
/// be orphaned — a `_autosave.voxl` next to a file the user no longer edits
/// implies unsaved work that does not exist.
fn delete_sidecar_for_project(project: &std::path::Path) -> Result<(), String> {
    let Some(sidecar) = sidecar_autosave_path_for_project(project) else {
        return Ok(());
    };
    if !is_sidecar_autosave_file(&sidecar) {
        return Err(format!(
            "Refusing to delete '{}': not an autosave sidecar",
            sidecar.display()
        ));
    }
    if !sidecar.exists() {
        return Ok(());
    }
    std::fs::remove_file(&sidecar)
        .map_err(|err| format!("Failed deleting sidecar '{}': {err}", sidecar.display()))
}

/// Real-syscall writability probe for a prospective sidecar location.
///
/// Deliberately not a metadata/permissions guess: read-only volumes,
/// permission-denied folders, and unreachable network shares all present
/// differently in metadata but identically to an actual create. Reuses sub-phase
/// A's `sibling_commit_temp_path` so the probe exercises the very mechanism the
/// real commit will use, rather than a lookalike.
///
/// Returns `None` when the directory is usable, or the `fallback_reason` to
/// record in the manifest when it is not.
fn probe_directory_writable(sidecar: &std::path::Path) -> Option<&'static str> {
    let parent = sidecar.parent().unwrap_or_else(|| std::path::Path::new("."));
    if !parent.as_os_str().is_empty() && !parent.is_dir() {
        return Some("parent-missing");
    }

    let probe = sibling_commit_temp_path(sidecar).ok()?;
    let writable = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    if writable {
        None
    } else {
        Some("parent-unwritable")
    }
}

// ---------------------------------------------------------------------------
// Recovery discovery
// ---------------------------------------------------------------------------

const VOXL_FILE_MAGIC: &[u8; 4] = b"VOXL";

/// A candidate is only advertised if it exists, is non-empty, and actually
/// starts with the VOXL magic — a truncated or foreign file must never be
/// offered as a recoverable scene.
fn is_readable_voxl_payload(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).is_ok() && &magic == VOXL_FILE_MAGIC
}

/// The ordered recovery candidate list — and the **only** paths the recovery
/// reader will ever open.
///
/// 1. `manifest.voxlPath` — authoritative: the manifest is written only after
///    the atomic rename, so it can only name a fully-committed payload.
/// 2. the sidecar derived from `manifest.projectPath` — covers a project that
///    moved, and manifests from builds older than this change.
/// 3. the legacy generic `<app_data>/autosave/scene.voxl` — every autosave
///    written before sub-phase B; back-compat is free and mandatory.
fn scene_autosave_recovery_candidates(
    recovery_dir: &std::path::Path,
    manifest: Option<&SceneAutosaveManifest>,
) -> Vec<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Some(manifest) = manifest {
        if let Some(voxl_path) = manifest
            .voxl_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            candidates.push(std::path::PathBuf::from(voxl_path));
        }
        if let Some(project) = manifest
            .project_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Some(sidecar) = sidecar_autosave_path_for_project(std::path::Path::new(project)) {
                candidates.push(sidecar);
            }
        }
    }

    candidates.push(recovery_dir.join(SCENE_AUTOSAVE_VOXL_FILE));
    candidates.push(recovery_dir.join(SCENE_AUTOSAVE_LEGACY_VOXL_FILE));

    let mut deduped: Vec<std::path::PathBuf> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if !deduped
            .iter()
            .any(|existing| autosave_paths_equal(existing, &candidate))
        {
            deduped.push(candidate);
        }
    }
    deduped
}

/// The read gate: `scene_autosave_read_voxl_bytes` accepts a path **only** if
/// the resolver itself produced it. Same discipline as
/// `scene_file_discard_atomic_temp` — an arbitrary caller-supplied path can
/// never be turned into a file read through this seam.
fn is_allowed_recovery_read(candidates: &[std::path::PathBuf], path: &std::path::Path) -> bool {
    candidates
        .iter()
        .any(|candidate| autosave_paths_equal(candidate, path))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneAutosaveRecoveryCandidate {
    voxl_path: std::path::PathBuf,
    origin: String,
    saved_at: Option<String>,
    clean: bool,
    project_path: Option<String>,
    payload_bytes: u64,
    fallback_reason: Option<String>,
}

fn resolve_scene_autosave_recovery(
    recovery_dir: &std::path::Path,
    manifest: Option<&SceneAutosaveManifest>,
) -> Option<SceneAutosaveRecoveryCandidate> {
    let generic = recovery_dir.join(SCENE_AUTOSAVE_VOXL_FILE);
    let legacy_generic = recovery_dir.join(SCENE_AUTOSAVE_LEGACY_VOXL_FILE);

    for candidate in scene_autosave_recovery_candidates(recovery_dir, manifest) {
        if !is_readable_voxl_payload(&candidate) {
            continue;
        }

        let origin = if autosave_paths_equal(&candidate, &generic)
            || autosave_paths_equal(&candidate, &legacy_generic)
        {
            SCENE_AUTOSAVE_ORIGIN_RECOVERY_DIR.to_string()
        } else {
            manifest
                .and_then(|m| m.origin.clone())
                .unwrap_or_else(|| SCENE_AUTOSAVE_ORIGIN_SIDECAR.to_string())
        };

        let payload_bytes = std::fs::metadata(&candidate).map(|m| m.len()).unwrap_or(0);

        return Some(SceneAutosaveRecoveryCandidate {
            voxl_path: candidate,
            origin,
            saved_at: manifest.map(|m| m.saved_at.clone()),
            clean: manifest.map(|m| m.clean).unwrap_or(false),
            project_path: manifest.and_then(|m| m.project_path.clone()),
            payload_bytes,
            fallback_reason: manifest.and_then(|m| m.fallback_reason.clone()),
        });
    }

    None
}

// ---------------------------------------------------------------------------
// Stale commit-temp sweep (inherited from sub-phase A)
// ---------------------------------------------------------------------------

/// The pid segment of a `<target>.tmp-<pid>-<seq>` name.
fn scene_commit_temp_pid(path: &std::path::Path) -> Option<u32> {
    let name = path.file_name().and_then(|n| n.to_str())?;
    let (_, suffix) = name.rsplit_once(SCENE_COMMIT_TEMP_MARKER)?;
    suffix.split('-').next()?.parse::<u32>().ok()
}

/// Removes commit temps abandoned by a crashed write.
///
/// Conservative by construction, because these live in the user's own project
/// folder: only names `is_scene_commit_temp_path` recognises (sub-phase A's
/// exact pattern), only in a directory autosave already writes to, never this
/// process's own temps (they may be in flight — `scene_file_discard_atomic_temp`
/// owns those), and only past an age gate so another instance's in-flight write
/// is never deleted out from under it.
fn sweep_stale_scene_commit_temps(dir: &std::path::Path, min_age_seconds: u64) -> u32 {
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(min_age_seconds))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let current_pid = std::process::id();

    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };

    let mut removed = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_scene_commit_temp_path(&path) {
            continue;
        }
        if scene_commit_temp_pid(&path) == Some(current_pid) {
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

/// Crash residue can be minutes old for a large scene; anything younger than
/// this may still be an in-flight write from a second instance.
const SCENE_COMMIT_TEMP_SWEEP_MIN_AGE_SECONDS: u64 = 30 * 60;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneAutosavePaths {
    voxl_path: String,
    manifest_path: String,
    origin: String,
    project_path: Option<String>,
    fallback_reason: Option<String>,
}

/// Where an autosave tick will land, and why.
///
/// Pure and app-handle-free on purpose: the recovery directory is passed in, so
/// the whole target policy — including the three invariants the user pinned —
/// is testable without a Tauri runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SceneAutosaveTarget {
    voxl_path: std::path::PathBuf,
    origin: &'static str,
    project_path: Option<String>,
    fallback_reason: Option<&'static str>,
}

const SCENE_AUTOSAVE_ORIGIN_SIDECAR: &str = "sidecar";
const SCENE_AUTOSAVE_ORIGIN_RECOVERY_DIR: &str = "recovery-dir";

/// Resolves where an autosave tick lands.
///
/// **User item 5.** A project that has been saved or opened gets its recovery
/// copy *beside it* as `<stem>_autosave.voxl` — local and obvious, not a hidden
/// app-data path the user would have to hunt for. Untitled scenes keep the
/// generic recovery location exactly as before.
///
/// **Binding fallback directive.** Any failure of the sidecar target — folder
/// gone, read-only volume, permission denied, unreachable network share — falls
/// back to the generic recovery location with a `fallback_reason` recorded in
/// the manifest. Never fail an autosave over a folder-policy question, and never
/// lie about where the payload actually went.
///
/// Three invariants hold for every input, each with its own test: the result
/// never equals the project path, always ends in `.voxl`, and always carries the
/// `_autosave` marker.
fn resolve_scene_autosave_target(
    recovery_dir: &std::path::Path,
    preferred_project_path: Option<&str>,
) -> SceneAutosaveTarget {
    let fallback = |project: Option<&str>, reason: &'static str| SceneAutosaveTarget {
        voxl_path: recovery_dir.join(SCENE_AUTOSAVE_VOXL_FILE),
        origin: SCENE_AUTOSAVE_ORIGIN_RECOVERY_DIR,
        project_path: project.map(str::to_string),
        fallback_reason: Some(reason),
    };

    let Some(project) = preferred_project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return fallback(None, "no-project");
    };

    let path = std::path::Path::new(project);
    // `is_scene_file_path`, not `is_voxl_autosave_target`: a project saved in a
    // plugin scene format is still a project and still deserves a sidecar. It
    // gets a correctly-named `.voxl` one, so VOXL bytes never land in a file
    // whose extension promises a foreign format (invariant b).
    if !is_scene_file_path(path) {
        return fallback(Some(project), "not-a-scene-file");
    }

    let Some(sidecar) = sidecar_autosave_path_for_project(path) else {
        return fallback(Some(project), "not-a-scene-file");
    };

    // Invariants (a) and (b), enforced rather than assumed: the target is never
    // the file the user saves to, and it always ends in `.voxl`. Both are
    // unreachable by construction — `sidecar_autosave_file_name` inserts the
    // marker before a hard-coded `.voxl` — but they are the locks this whole
    // sub-phase exists for, so the resolver checks its own output instead of
    // trusting that the naming helper is never changed carelessly.
    if autosave_paths_equal(&sidecar, path) || !is_voxl_autosave_target(&sidecar) {
        return fallback(Some(project), "not-a-scene-file");
    }

    if let Some(reason) = probe_directory_writable(&sidecar) {
        return fallback(Some(project), reason);
    }

    SceneAutosaveTarget {
        voxl_path: sidecar,
        origin: SCENE_AUTOSAVE_ORIGIN_SIDECAR,
        project_path: Some(project.to_string()),
        fallback_reason: None,
    }
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
        let target = resolve_scene_autosave_target(&dir, preferred_save_path.as_deref());

        // Sweep crash residue from the directory we are about to write to, and
        // only that one. A `<project>.voxl.tmp-<pid>-<seq>` left by a killed
        // write is confusing clutter sitting next to the user's project.
        if let Some(parent) = target.voxl_path.parent() {
            sweep_stale_scene_commit_temps(parent, SCENE_COMMIT_TEMP_SWEEP_MIN_AGE_SECONDS);
        }

        Ok(SceneAutosavePaths {
            voxl_path: target.voxl_path.to_string_lossy().to_string(),
            manifest_path: dir
                .join(SCENE_AUTOSAVE_MANIFEST_FILE)
                .to_string_lossy()
                .to_string(),
            origin: target.origin.to_string(),
            project_path: target.project_path,
            fallback_reason: target.fallback_reason.map(str::to_string),
        })
    })
    .await
    .map_err(|err| format!("scene_autosave_get_paths task failed: {err}"))?
}

/// Writes the recovery manifest — **always after** the payload has been
/// committed by sub-phase A's atomic rename. That ordering is what makes
/// `voxl_path` authoritative: the manifest can only ever name a file that is
/// already complete on disk.
///
/// `delete_payload` is the cleanup seam. It removes the payload the *previous*
/// manifest advertised (plus the legacy generic location), gated on
/// `is_deletable_autosave_payload` so the user's project can never be reached
/// through it. Callers use it only after a successful save, restore, or an
/// explicit discard — never while unsaved work exists.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn scene_autosave_write_manifest(
    app: DragonFruitAppHandle,
    saved_at: String,
    clean: bool,
    voxl_path: Option<String>,
    origin: Option<String>,
    project_path: Option<String>,
    payload_bytes: Option<u64>,
    fallback_reason: Option<String>,
    delete_payload: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = scene_autosave_resolve_dir(&app)?;
        let path = dir.join(SCENE_AUTOSAVE_MANIFEST_FILE);

        let previous: Option<SceneAutosaveManifest> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok());

        if delete_payload.unwrap_or(false) {
            let mut targets: Vec<std::path::PathBuf> =
                vec![dir.join(SCENE_AUTOSAVE_LEGACY_VOXL_FILE), dir.join(SCENE_AUTOSAVE_VOXL_FILE)];
            for advertised in [
                previous.as_ref().and_then(|m| m.voxl_path.clone()),
                voxl_path.clone(),
            ]
            .into_iter()
            .flatten()
            {
                targets.push(std::path::PathBuf::from(advertised));
            }
            if let Some(project) = previous
                .as_ref()
                .and_then(|m| m.project_path.clone())
                .or_else(|| project_path.clone())
            {
                if let Some(sidecar) =
                    sidecar_autosave_path_for_project(std::path::Path::new(&project))
                {
                    targets.push(sidecar);
                }
            }

            for target in targets {
                if !is_deletable_autosave_payload(&dir, &target) {
                    continue;
                }
                if target.exists() {
                    let _ = std::fs::remove_file(&target);
                }
            }
        }

        let manifest = SceneAutosaveManifest {
            saved_at,
            clean,
            // A cleaned manifest must not keep advertising a payload it just
            // deleted, or recovery would offer a file that is gone.
            voxl_path: if delete_payload.unwrap_or(false) { None } else { voxl_path },
            origin,
            project_path,
            payload_bytes,
            fallback_reason,
            last_error: None,
        };
        let json = serde_json::to_string(&manifest)
            .map_err(|err| format!("Failed serializing autosave manifest: {err}"))?;
        std::fs::write(&path, json.as_bytes())
            .map_err(|err| format!("Failed writing autosave manifest: {err}"))?;
        Ok(())
    })
    .await
    .map_err(|err| format!("scene_autosave_write_manifest task failed: {err}"))?
}

/// Deletes the sidecar belonging to a specific project.
///
/// Save As uses this on the **old** project path, so a successful Save As never
/// orphans a `_autosave.voxl` beside a file the user has stopped editing.
#[tauri::command]
async fn scene_autosave_delete_sidecar(project_path: String) -> Result<(), String> {
    let trimmed = project_path.trim().to_string();
    if trimmed.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        delete_sidecar_for_project(std::path::Path::new(&trimmed))
    })
    .await
    .map_err(|err| format!("scene_autosave_delete_sidecar task failed: {err}"))?
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

fn scene_autosave_read_manifest_from_dir(dir: &std::path::Path) -> Option<SceneAutosaveManifest> {
    let path = dir.join(SCENE_AUTOSAVE_MANIFEST_FILE);
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// **Recovery-discovery parity.** Without this, sidecar path control would be a
/// regression rather than a fix: the manifest would advertise a payload beside
/// the project and the reader — hard-wired to the generic location before this
/// change — could not open it.
#[tauri::command]
async fn scene_autosave_resolve_recovery(
    app: DragonFruitAppHandle,
) -> Result<Option<SceneAutosaveRecoveryCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = scene_autosave_resolve_dir(&app)?;
        let manifest = scene_autosave_read_manifest_from_dir(&dir);
        Ok(resolve_scene_autosave_recovery(&dir, manifest.as_ref()))
    })
    .await
    .map_err(|err| format!("scene_autosave_resolve_recovery task failed: {err}"))?
}

/// Reads a recovery payload. `path` is accepted **only** when it appears in the
/// resolver's own candidate list — never an arbitrary caller-supplied path.
/// Omitting it keeps the pre-Ph0.1 behaviour of reading the generic location.
#[tauri::command]
async fn scene_autosave_read_voxl_bytes(
    app: DragonFruitAppHandle,
    path: Option<String>,
) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let dir = scene_autosave_resolve_dir(&app)?;
        let manifest = scene_autosave_read_manifest_from_dir(&dir);
        let candidates = scene_autosave_recovery_candidates(&dir, manifest.as_ref());

        let requested = path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from);

        let target = match requested {
            Some(requested) => {
                if !is_allowed_recovery_read(&candidates, &requested) {
                    return Err(format!(
                        "Refusing to read '{}': not an autosave recovery candidate",
                        requested.display()
                    ));
                }
                requested
            }
            None => resolve_scene_autosave_recovery(&dir, manifest.as_ref())
                .map(|candidate| candidate.voxl_path)
                .ok_or_else(|| "No autosaved scene file found".to_string())?,
        };

        if !target.exists() {
            return Err("No autosaved scene file found".to_string());
        }
        std::fs::read(&target).map_err(|err| format!("Failed reading autosaved scene: {err}"))
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
    // Geometry (restored session state or first-launch maximize) was already
    // applied at window creation, so showing here causes no resize flash.
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(true);
        if !is_visible {
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

/// Open a URL in the default system browser (cross-platform).
#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/c", "start", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg(&url)
        .spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn();

    result.map_err(|e| format!("Failed to open URL in browser: {e}"))?;
    Ok(())
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

        app.manage(window_state::WindowStateTracker::default());

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
                Ok(window) => {
                    // Restore the previous session's geometry while the window
                    // is still hidden; first launch keeps the maximized default.
                    match window_state::load(&app_handle) {
                        Some(state) => window_state::restore(&window, &state),
                        None => {
                            let _ = window.maximize();
                        }
                    }
                    window_state::track(&window);

                    // On macOS, reveal immediately so a frontend startup hiccup
                    // can't leave the app invisible when created as hidden.
                    #[cfg(target_os = "macos")]
                    {
                        if let Err(error) = window.show() {
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
            stage_mesh_binary_start,
            allocate_mesh_stage_path,
            append_mesh_stage_chunk,
            finish_mesh_stage_write,
            scene_file_begin_atomic_write,
            scene_file_commit_atomic,
            scene_file_discard_atomic_temp,
            stage_mesh_file_path,
            stage_mesh_binary_set,
            stage_mesh_binary_chunk,
            slice_solid_native_to_temp_path,
            cancel_slicing,
            run_island_scan_native,
            mesh_minima::scan_mesh_minima,
            mesh_minima::scan_mesh_minima_from_path,
            mesh_minima::scan_voxel_islands_from_path,
            mesh_minima::scan_islands_from_path,
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
            scene_autosave_resolve_recovery,
            scene_autosave_delete_sidecar,
            reveal_in_file_manager,
            open_external_url,
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
            mesh_repair::mesh_hollow_preview_read_blocked_voxel_indices,
            mesh_repair::mesh_hollow_preview_select_removed_voxels_in_polygon,
            mesh_repair::mesh_hollow_preview_read_cavity_positions,
            mesh_repair::mesh_hollow_staged_read_cavity_positions,
            mesh_repair::mesh_punch_staged,
            mesh_repair::mesh_punch_capture_staged_source,
            mesh_repair::mesh_punch_from_captured_source,
            mesh_repair::mesh_punch_read_positions,
            mesh_repair::mesh_repair_read_positions,
            mesh_repair::load_stl_file,
            mesh_repair::stat_source_file,
            mesh_repair::stage_fullres_mesh_from_source,
            mesh_repair::splice_fullres_mesh_into_stage_file,
            mesh_repair::stage_fullres_mesh_into_staged,
            sdf::compute_sdf_from_staged,
            sdf::compute_heightmap_from_staged,
            sdf::invalidate_sdf_cache,
            astar::run_astar_pathfinding,
            updater_channel::check_updates,
            updater_channel::perform_update,
            updater_channel::get_saved_update_channel,
            updater_channel::save_update_channel
        ])
        .build(tauri::generate_context!())
        .expect("error while running DragonFruit desktop app")
        .run(|app_handle, event| {
            // CloseRequested does not fire on macOS Cmd+Q, so also flush the
            // tracked window state when the app itself is quitting.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                window_state::save(app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    // -----------------------------------------------------------------------
    // Shared writer-test scaffolding (Ph0.1 sub-phase A)
    // -----------------------------------------------------------------------

    /// `append_mesh_stage_chunk` owns ONE process-global appender, so every test
    /// that drives the writer must run alone. `cargo test` runs tests on
    /// parallel threads by default; without this they would evict each other's
    /// appenders and go flaky for the very reason sub-phase A exists.
    static WRITER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_writer_tests() -> std::sync::MutexGuard<'static, ()> {
        let guard = WRITER_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // A test that simulated a crash leaves the appender open; start clean.
        *super::staged_mesh_file_appender()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        guard
    }

    /// pid + process-wide sequence, same rationale as
    /// `allocate_mesh_stage_file_path`: nanos alone collide on Windows.
    fn unique_test_dir(tag: &str) -> std::path::PathBuf {
        static TEST_DIR_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "dragonfruit-test-{tag}-{}-{}",
            std::process::id(),
            TEST_DIR_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed creating test dir");
        dir
    }

    /// Mirrors the frontend's native VOXL write seam
    /// (`ExportManager.downloadFile` → `writeFileAtomicToNativePath`, which both
    /// autosave and explicit save funnel through) so the crash-safety invariant
    /// is asserted against the real writer rather than a paraphrase of it.
    /// `interrupt_after_bytes` models the process dying mid-write: chunks stop
    /// and nothing commits, exactly as a kill would leave things.
    fn voxl_write_seam(
        target: &std::path::Path,
        bytes: &[u8],
        interrupt_after_bytes: Option<usize>,
    ) -> Result<(), String> {
        let temp = super::sibling_commit_temp_path(target)?;
        let temp_text = temp.to_string_lossy().to_string();
        let cut = interrupt_after_bytes.unwrap_or(bytes.len()).min(bytes.len());

        super::stage_append_chunk(&temp_text, &bytes[..cut], true)?;
        if interrupt_after_bytes.is_some() {
            // Process dies here: no further chunks, no finish, no commit.
            return Ok(());
        }
        super::stage_append_chunk(&temp_text, &bytes[cut..], false)?;
        super::finish_stage_write(&temp_text)?;
        super::commit_scene_file_atomic(&temp, target)
    }

    /// **The data-loss regression.** Before sub-phase A the seam wrote straight
    /// to the destination with `truncate(true)` on chunk 0
    /// (`append_mesh_stage_chunk`), so a crash between truncate and the last
    /// chunk left a truncated scene file and no fallback — the user's project
    /// destroyed by an autosave tick or a Ctrl+S that never finished.
    #[test]
    fn interrupted_voxl_write_preserves_previous_good_file() {
        let _guard = lock_writer_tests();
        let dir = unique_test_dir("atomic-commit");
        let target = dir.join("MyPrint.voxl");

        let good: Vec<u8> = (0..64u32).flat_map(|i| i.to_le_bytes()).collect();
        voxl_write_seam(&target, &good, None).expect("initial good write failed");
        assert_eq!(
            std::fs::read(&target).expect("good file unreadable"),
            good,
            "the baseline write did not produce the expected file"
        );

        let replacement = vec![0xABu8; 4096];
        let _ = voxl_write_seam(&target, &replacement, Some(1024));

        assert_eq!(
            std::fs::read(&target).expect("previous good file no longer exists"),
            good,
            "an interrupted write destroyed the previous good scene file"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The happy path of the commit: the target becomes the temp's bytes and no
    /// `.tmp-` residue is left beside the user's project.
    #[test]
    fn commit_atomic_replaces_target_and_removes_temp() {
        let _guard = lock_writer_tests();
        let dir = unique_test_dir("atomic-replace");
        let target = dir.join("MyPrint.voxl");
        std::fs::write(&target, b"old contents").expect("seed write failed");

        let temp = super::sibling_commit_temp_path(&target).expect("temp alloc failed");
        std::fs::write(&temp, b"new contents").expect("temp write failed");
        super::commit_scene_file_atomic(&temp, &target).expect("commit failed");

        assert_eq!(std::fs::read(&target).unwrap(), b"new contents");
        assert!(!temp.exists(), "commit left a temp file beside the project");
        let residue: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(residue.is_empty(), "temp residue left behind: {residue:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Terminal failure must be strictly better than the old behaviour: the
    /// previous good target survives, the temp is cleaned up, and the caller
    /// gets an `Err` instead of a silently destroyed file.
    #[test]
    fn commit_atomic_leaves_target_intact_when_rename_fails() {
        let _guard = lock_writer_tests();
        let dir = unique_test_dir("atomic-fail");
        // A directory can never be replaced by a file rename on any platform.
        let target = dir.join("MyPrint.voxl");
        std::fs::create_dir_all(&target).expect("failed creating blocking directory");
        std::fs::write(target.join("sentinel.txt"), b"still here").expect("sentinel write failed");

        let temp = super::sibling_commit_temp_path(&target).expect("temp alloc failed");
        std::fs::write(&temp, b"new contents").expect("temp write failed");

        let result = super::commit_scene_file_atomic(&temp, &target);
        assert!(result.is_err(), "commit onto a directory should fail");
        assert_eq!(
            std::fs::read(target.join("sentinel.txt")).unwrap(),
            b"still here",
            "a failed commit damaged the previous target"
        );
        assert!(!temp.exists(), "a failed commit left its temp behind");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Same collision geometry as the two allocator races already pinned below:
    /// the commit temp is created with truncate, so two same-tick allocations
    /// sharing a name would let one in-flight save overwrite another's staging
    /// file and then rename the wrong bytes over the user's project.
    #[test]
    fn sibling_commit_temp_paths_are_unique_under_concurrent_allocation() {
        const THREADS: usize = 8;
        const ALLOCS_PER_THREAD: usize = 64;

        let dir = unique_test_dir("temp-uniqueness");
        let target = std::sync::Arc::new(dir.join("MyPrint.voxl"));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
        let handles: Vec<_> = (0..THREADS)
            .map(|_| {
                let barrier = std::sync::Arc::clone(&barrier);
                let target = std::sync::Arc::clone(&target);
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..ALLOCS_PER_THREAD)
                        .map(|_| {
                            super::sibling_commit_temp_path(&target)
                                .expect("commit temp allocation failed")
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();

        let mut all_paths = std::collections::HashSet::new();
        for handle in handles {
            for path in handle.join().expect("allocator thread panicked") {
                assert_eq!(
                    path.parent(),
                    target.parent(),
                    "commit temp must be a sibling of the target, or the rename is not atomic"
                );
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .expect("commit temp path has a UTF-8 file name")
                    .to_string();
                assert!(
                    name.starts_with("MyPrint.voxl.tmp-"),
                    "commit temp name lost its contract: {name}"
                );
                assert!(
                    super::is_scene_commit_temp_path(&path),
                    "discard guard no longer recognizes its own temp: {name}"
                );
                assert!(all_paths.insert(path), "duplicate commit temp allocated");
            }
        }
        assert_eq!(all_paths.len(), THREADS * ALLOCS_PER_THREAD);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **Finding N2.** Two chunked writes to different paths used to evict each
    /// other from the single process-global appender and re-truncate on every
    /// switch-back — writer A's committed chunks destroyed, its next chunk
    /// landing at offset 0, both files corrupt, and no error anywhere.
    #[test]
    fn concurrent_stage_writes_error_instead_of_truncating() {
        let _guard = lock_writer_tests();
        let dir = unique_test_dir("stage-contention");
        let path_a = dir.join("a.bin").to_string_lossy().to_string();
        let path_b = dir.join("b.bin").to_string_lossy().to_string();

        // Writer A opens and writes its first chunk.
        super::stage_append_chunk(&path_a, &[0xAA; 512], true).expect("writer A chunk 0 failed");
        // Writer B interleaves with its own first chunk (evicts A's appender).
        super::stage_append_chunk(&path_b, &[0xBB; 512], true).expect("writer B chunk 0 failed");
        // A resumes mid-sequence. This is the corruption point.
        let resumed = super::stage_append_chunk(&path_a, &[0xAA; 512], false);

        assert!(
            resumed.is_err(),
            "an interleaved mid-sequence chunk was accepted — it silently re-truncated '{path_a}'"
        );
        let message = resumed.unwrap_err();
        assert!(
            message.contains("concurrent mesh-stage write detected"),
            "contention error lost its identity: {message}"
        );

        *super::staged_mesh_file_appender()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Guard on the contention backstop itself: it must not fire on the ordinary
    /// sequence of a *second* stage write.
    ///
    /// `stage_mesh_file_path` flushes the appender but deliberately does not
    /// close it, and an aborted slice never reaches that call at all — so the
    /// previous stage file's appender is routinely still open when the next
    /// slice's first chunk arrives. That chunk must truncate its own new file,
    /// not be rejected as an interleave, or the second slice of every session
    /// (and every slice after an abort) would fail.
    ///
    /// This is what `sliceExportOrchestrator.handleMeshFileChunk`'s
    /// `x-mesh-stage-offset` header buys: chunk 0 is identifiable.
    #[test]
    fn sequential_stage_writes_after_an_abandoned_one_still_succeed() {
        let _guard = lock_writer_tests();
        let dir = unique_test_dir("stage-sequential");
        let first = dir.join("stage-1.bin").to_string_lossy().to_string();
        let second = dir.join("stage-2.bin").to_string_lossy().to_string();

        // Slice 1 streams and is abandoned (aborted) — appender left open.
        super::stage_append_chunk(&first, &[0x11; 256], true).expect("stage 1 chunk 0 failed");
        super::stage_append_chunk(&first, &[0x11; 256], false).expect("stage 1 chunk 1 failed");

        // Slice 2 starts a brand-new stage file while that appender is open.
        super::stage_append_chunk(&second, &[0x22; 256], true).expect(
            "a new stage write was rejected as an interleave — the backstop is too aggressive",
        );
        super::stage_append_chunk(&second, &[0x22; 256], false).expect("stage 2 chunk 1 failed");
        super::finish_stage_write(&second).expect("stage 2 finish failed");

        assert_eq!(
            std::fs::read(&second).unwrap().len(),
            512,
            "chunk 0 of a new stage file must truncate, not append to stale bytes"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **User invariant: autosave ALWAYS writes `.voxl`.** `is_scene_file_path`
    /// also accepts the plugin scene extensions, so a project saved in a plugin
    /// format used to be handed back verbatim as the autosave target — VOXL
    /// bytes written into a file whose extension promises a foreign format.
    #[test]
    fn autosave_target_is_always_voxl_for_plugin_scene_extensions() {
        for ext in super::BUILTIN_PLUGIN_SCENE_EXTENSIONS {
            let candidate = std::path::PathBuf::from(format!("C:/projects/MyPrint.{ext}"));
            assert!(
                super::is_scene_file_path(&candidate),
                "test fixture is not a recognised scene file: {}",
                candidate.display()
            );
            assert!(
                !super::is_voxl_autosave_target(&candidate),
                "autosave would have written VOXL bytes into a .{ext} file"
            );
        }

        assert!(super::is_voxl_autosave_target(std::path::Path::new(
            "C:/projects/MyPrint.voxl"
        )));
        assert!(super::is_voxl_autosave_target(std::path::Path::new(
            "C:/projects/MyPrint.VOXL"
        )));
        assert!(!super::is_voxl_autosave_target(std::path::Path::new(
            "C:/projects/MyPrint.stl"
        )));
        assert!(!super::is_voxl_autosave_target(std::path::Path::new(
            "C:/projects/MyPrint"
        )));
    }

    /// **RED — NOT OWNED BY Ph0.1. DO NOT "FIX" BY LOOSENING TRUNCATE.**
    ///
    /// Corollary of finding N2. `writeChunkedToNativePath`'s `finally` always
    /// calls `finish_mesh_stage_write` (nativeSlicerBridge.ts:597-607), which
    /// drops the appender, and every call restarts at offset 0 — so *every*
    /// call re-opens with `truncate(true)`. `streamZipToNativePath`
    /// (ExportManager.ts:655-706) makes three sequential calls to the same path
    /// and its docstring (:642-654) asserts append-on-subsequent. That
    /// assertion is false: native 3MF export emits only its postamble.
    ///
    /// This test reproduces that call shape exactly and asserts the docstring's
    /// contract, so it fails. It is `#[ignore]`d rather than deleted so the
    /// suite stays green while the defect stays on the record.
    ///
    /// Owner: the 3MF export team — fix in `streamZipToNativePath` (e.g. a
    /// single write sequence, or an explicit append mode), NOT by weakening
    /// `append_mesh_stage_chunk`'s truncate-on-fresh-appender semantics, which
    /// mesh staging and Ph0.1's atomic commit both depend on.
    #[test]
    #[ignore = "RED: pins the known native-3MF truncation defect (N2 corollary); owned by the 3MF export team, not Ph0.1"]
    fn native_3mf_sequential_writes_append_instead_of_truncating() {
        let _guard = lock_writer_tests();
        let dir = unique_test_dir("3mf-corollary");
        let path = dir.join("model.3mf").to_string_lossy().to_string();

        // Exactly what streamZipToNativePath does: three separate
        // writeChunkedToNativePath calls to one path, each starting at offset 0
        // and each closing the appender in its `finally`.
        for payload in [b"PREAMBLE".as_slice(), b"XMLXMLXML", b"POSTAMBLE"] {
            super::stage_append_chunk(&path, payload, true).expect("3mf chunk write failed");
            super::finish_stage_write(&path).expect("3mf finish failed");
        }

        let written = std::fs::read(&path).expect("3mf output unreadable");
        assert_eq!(
            written, b"PREAMBLEXMLXMLXMLPOSTAMBLE",
            "native 3MF export is emitting only its last write — the ZIP has no local headers and no model data"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two same-tick allocations used to return the SAME stage path (nanos-only
    /// name), and the append-mode consumer would interleave both writers into
    /// one file with no error. The barrier maximizes same-tick pressure; the
    /// process-wide sequence must keep every path distinct regardless.
    #[test]
    fn mesh_stage_paths_are_unique_under_concurrent_allocation() {
        const THREADS: usize = 8;
        const ALLOCS_PER_THREAD: usize = 64;

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
        let handles: Vec<_> = (0..THREADS)
            .map(|_| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..ALLOCS_PER_THREAD)
                        .map(|_| {
                            super::allocate_mesh_stage_file_path()
                                .expect("stage path allocation failed")
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();

        let mut all_paths = std::collections::HashSet::new();
        for handle in handles {
            for path in handle.join().expect("allocator thread panicked") {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .expect("stage path has a UTF-8 file name")
                    .to_string();
                assert!(
                    name.starts_with("dragonfruit-mesh-stage-") && name.ends_with(".bin"),
                    "stage file name lost its contract: {name}"
                );
                assert!(all_paths.insert(path), "duplicate stage path allocated");
            }
        }
        assert_eq!(all_paths.len(), THREADS * ALLOCS_PER_THREAD);
    }

    /// Same collision geometry as the mesh-stage race, clobber-flavored: the
    /// slice-export writer creates/truncates, so two same-tick allocations
    /// sharing a nanos-only name would silently replace one export with the
    /// other. Also locks the sweeper contract: every generated path must stay
    /// recognizable to `is_dragonfruit_temp_artifact`, or exports stop being
    /// cleaned up.
    #[test]
    fn temp_artifact_paths_are_unique_under_concurrent_allocation() {
        const THREADS: usize = 8;
        const ALLOCS_PER_THREAD: usize = 64;

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
        let handles: Vec<_> = (0..THREADS)
            .map(|_| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..ALLOCS_PER_THREAD)
                        .map(|_| super::temp_artifact_path("goo"))
                        .collect::<Vec<_>>()
                })
            })
            .collect();

        let mut all_paths = std::collections::HashSet::new();
        for handle in handles {
            for path in handle.join().expect("allocator thread panicked") {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .expect("artifact path has a UTF-8 file name")
                    .to_string();
                assert!(
                    name.starts_with("dragonfruit-slice-") && name.ends_with(".goo"),
                    "artifact file name lost its contract: {name}"
                );
                assert!(
                    super::is_dragonfruit_temp_artifact(&path),
                    "temp sweeper no longer recognizes artifact: {name}"
                );
                assert!(all_paths.insert(path), "duplicate artifact path allocated");
            }
        }
        assert_eq!(all_paths.len(), THREADS * ALLOCS_PER_THREAD);
    }

    // -----------------------------------------------------------------------
    // Ph0.1 sub-phase B — sidecar target policy + recovery-discovery parity
    // -----------------------------------------------------------------------

    /// Builds a project folder with a real scene file in it, plus a separate
    /// recovery dir, mirroring the two real locations at runtime.
    fn autosave_fixture(tag: &str, project_file: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = unique_test_dir(tag);
        let project_dir = root.join("projects");
        let recovery_dir = root.join("recovery");
        std::fs::create_dir_all(&project_dir).expect("failed creating project dir");
        std::fs::create_dir_all(&recovery_dir).expect("failed creating recovery dir");
        let project = project_dir.join(project_file);
        std::fs::write(&project, voxl_payload(b"project")).expect("failed seeding project file");
        (root, recovery_dir, project)
    }

    /// A minimally-valid VOXL payload: the 4-byte magic plus filler. The
    /// recovery resolver magic-checks every candidate, so fixtures must carry it.
    fn voxl_payload(tail: &[u8]) -> Vec<u8> {
        let mut bytes = b"VOXL".to_vec();
        bytes.extend_from_slice(tail);
        bytes
    }

    /// **User item 5, the lock.** An autosave tick must never target the file the
    /// user saves to. Before sub-phase B `scene_autosave_get_paths` returned the
    /// project path verbatim, so every tick overwrote the user's project with a
    /// scene state they never asked to save.
    #[test]
    fn autosave_target_never_equals_the_project_path() {
        let (root, recovery_dir, project) = autosave_fixture("b-never-project", "MyPrint.voxl");
        let project_text = project.to_string_lossy().to_string();

        for candidate in [
            project_text.as_str(),
            // Already-sidecar-shaped names must not collapse onto themselves.
            root.join("projects/MyPrint_autosave.voxl")
                .to_string_lossy()
                .to_string()
                .as_str(),
        ] {
            let target = super::resolve_scene_autosave_target(&recovery_dir, Some(candidate));
            assert_ne!(
                target.voxl_path,
                std::path::Path::new(candidate),
                "autosave targeted the user's own project file: {candidate}"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// **Invariant (b).** Whatever the project's extension, the autosave target
    /// ends in `.voxl` — autosave emits VOXL bytes and must never put them in a
    /// file whose extension promises a foreign format.
    #[test]
    fn autosave_target_always_ends_in_voxl() {
        let root = unique_test_dir("b-always-voxl");
        let project_dir = root.join("projects");
        std::fs::create_dir_all(&project_dir).expect("failed creating project dir");

        let mut names: Vec<String> = vec!["MyPrint.voxl".to_string(), "MyPrint.VOXL".to_string()];
        names.extend(
            super::BUILTIN_PLUGIN_SCENE_EXTENSIONS
                .iter()
                .map(|ext| format!("MyPrint.{ext}")),
        );

        for name in names {
            let project = project_dir.join(&name);
            std::fs::write(&project, voxl_payload(b"p")).expect("seed failed");
            let target = super::resolve_scene_autosave_target(
                &root.join("recovery"),
                Some(project.to_string_lossy().as_ref()),
            );
            let ext = target
                .voxl_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            assert_eq!(
                ext,
                "voxl",
                "autosave target for '{name}' does not end in .voxl: {}",
                target.voxl_path.display()
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// **Invariant (c).** The target always carries the `_autosave` marker, so a
    /// recovery file is self-describing in Explorer and can never be mistaken for
    /// a project. It is also what gates payload deletion
    /// (`is_deletable_autosave_payload`).
    #[test]
    fn autosave_target_always_contains_the_autosave_marker() {
        let (root, recovery_dir, project) = autosave_fixture("b-marker", "MyPrint.voxl");

        for preferred in [
            Some(project.to_string_lossy().to_string()),
            Some("   ".to_string()),
            None,
        ] {
            let target =
                super::resolve_scene_autosave_target(&recovery_dir, preferred.as_deref());
            let name = target
                .voxl_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            assert!(
                name.contains("_autosave"),
                "autosave target is not self-describing: {name}"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// **User item 5, the payoff.** A saved/opened project gets its recovery copy
    /// beside it — local and obvious — not in a hidden app-data path.
    #[test]
    fn sidecar_lands_beside_the_project_as_stem_autosave_voxl() {
        let (root, recovery_dir, project) = autosave_fixture("b-sidecar", "MyPrint.voxl");

        let target = super::resolve_scene_autosave_target(
            &recovery_dir,
            Some(project.to_string_lossy().as_ref()),
        );

        assert_eq!(target.origin, super::SCENE_AUTOSAVE_ORIGIN_SIDECAR);
        assert_eq!(target.fallback_reason, None);
        assert_eq!(
            target.voxl_path,
            project.parent().unwrap().join("MyPrint_autosave.voxl"),
            "the sidecar did not land beside the project"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A plugin-format project still gets a correctly-named VOXL sidecar in its
    /// own folder rather than being exiled to the recovery dir.
    #[test]
    fn sidecar_is_derived_for_plugin_scene_extensions_too() {
        let ext = super::BUILTIN_PLUGIN_SCENE_EXTENSIONS
            .first()
            .expect("no plugin scene extensions registered");
        let (root, recovery_dir, project) =
            autosave_fixture("b-plugin-ext", &format!("MyPrint.{ext}"));

        let target = super::resolve_scene_autosave_target(
            &recovery_dir,
            Some(project.to_string_lossy().as_ref()),
        );

        assert_eq!(target.origin, super::SCENE_AUTOSAVE_ORIGIN_SIDECAR);
        assert_eq!(
            target.voxl_path,
            project.parent().unwrap().join("MyPrint_autosave.voxl"),
            "a plugin-format project did not get a .voxl sidecar beside it"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// **Binding user directive.** Any failure of the sidecar target falls back
    /// to the default recovery location and says why — never fail an autosave
    /// over a folder-permission question, and never lie about where it went.
    #[test]
    fn sidecar_falls_back_to_recovery_dir_when_the_project_folder_is_unusable() {
        let root = unique_test_dir("b-fallback");
        let recovery_dir = root.join("recovery");
        std::fs::create_dir_all(&recovery_dir).expect("failed creating recovery dir");
        let generic = recovery_dir.join(super::SCENE_AUTOSAVE_VOXL_FILE);

        // Parent directory does not exist (deleted folder / unreachable share).
        let missing = root.join("gone/MyPrint.voxl");
        let target =
            super::resolve_scene_autosave_target(&recovery_dir, Some(missing.to_string_lossy().as_ref()));
        assert_eq!(target.voxl_path, generic);
        assert_eq!(target.origin, super::SCENE_AUTOSAVE_ORIGIN_RECOVERY_DIR);
        assert_eq!(target.fallback_reason, Some("parent-missing"));

        // Not a scene file at all.
        let not_scene = root.join("notes.txt");
        std::fs::write(&not_scene, b"hi").expect("seed failed");
        let target = super::resolve_scene_autosave_target(
            &recovery_dir,
            Some(not_scene.to_string_lossy().as_ref()),
        );
        assert_eq!(target.voxl_path, generic);
        assert_eq!(target.fallback_reason, Some("not-a-scene-file"));

        // No project at all (untitled scene) keeps today's behaviour exactly.
        let target = super::resolve_scene_autosave_target(&recovery_dir, None);
        assert_eq!(target.voxl_path, generic);
        assert_eq!(target.fallback_reason, Some("no-project"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The writability probe must use a real syscall — a metadata guess passes on
    /// read-only volumes and on network shares that deny writes.
    #[test]
    fn writability_probe_rejects_a_directory_that_cannot_be_written() {
        let root = unique_test_dir("b-probe");
        let usable = root.join("usable");
        std::fs::create_dir_all(&usable).expect("failed creating dir");

        assert!(
            super::probe_directory_writable(&usable.join("MyPrint_autosave.voxl")).is_none(),
            "a writable folder was reported unusable"
        );
        assert!(
            !usable.join("MyPrint_autosave.voxl").exists(),
            "the probe left its scratch file behind"
        );
        let residue: Vec<_> = std::fs::read_dir(&usable)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(residue.is_empty(), "the probe left residue: {residue:?}");

        assert_eq!(
            super::probe_directory_writable(&root.join("absent/MyPrint_autosave.voxl")),
            Some("parent-missing"),
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// **The parity requirement.** Path control without discovery is a
    /// regression: a manifest would advertise a sidecar the reader could not
    /// open. Resolution order is manifest → sidecar-from-project → legacy generic.
    #[test]
    fn recovery_discovery_prefers_manifest_then_sidecar_then_generic() {
        let (root, recovery_dir, project) = autosave_fixture("b-discovery", "MyPrint.voxl");
        let sidecar = project.parent().unwrap().join("MyPrint_autosave.voxl");
        let generic = recovery_dir.join(super::SCENE_AUTOSAVE_VOXL_FILE);
        std::fs::write(&sidecar, voxl_payload(b"sidecar")).expect("sidecar seed failed");
        std::fs::write(&generic, voxl_payload(b"generic")).expect("generic seed failed");

        let manifest = super::SceneAutosaveManifest {
            saved_at: "2026-07-26T00:00:00.000Z".to_string(),
            clean: false,
            voxl_path: Some(sidecar.to_string_lossy().to_string()),
            origin: Some(super::SCENE_AUTOSAVE_ORIGIN_SIDECAR.to_string()),
            project_path: Some(project.to_string_lossy().to_string()),
            payload_bytes: None,
            fallback_reason: None,
            last_error: None,
        };

        // 1. The manifest is authoritative.
        let found = super::resolve_scene_autosave_recovery(&recovery_dir, Some(&manifest))
            .expect("no recovery candidate found");
        assert_eq!(found.voxl_path, sidecar);
        assert_eq!(found.origin, super::SCENE_AUTOSAVE_ORIGIN_SIDECAR);

        // 2. A manifest whose `voxlPath` no longer resolves falls through to the
        //    sidecar derived from `projectPath` (project moved, or an older build
        //    wrote no `voxlPath` at all).
        let mut stale = manifest.clone();
        stale.voxl_path = Some(root.join("gone/MyPrint_autosave.voxl").to_string_lossy().to_string());
        let found = super::resolve_scene_autosave_recovery(&recovery_dir, Some(&stale))
            .expect("no recovery candidate found via project path");
        assert_eq!(found.voxl_path, sidecar);

        // 3. With neither, the legacy generic location still recovers.
        let mut legacy = manifest.clone();
        legacy.voxl_path = None;
        legacy.project_path = None;
        let found = super::resolve_scene_autosave_recovery(&recovery_dir, Some(&legacy))
            .expect("no recovery candidate found in the legacy location");
        assert_eq!(found.voxl_path, generic);

        // 4. Nothing on disk ⇒ no prompt.
        std::fs::remove_file(&generic).expect("generic cleanup failed");
        assert!(super::resolve_scene_autosave_recovery(&recovery_dir, Some(&legacy)).is_none());
        assert!(super::resolve_scene_autosave_recovery(&recovery_dir, None).is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Back-compat lock: a manifest written before sub-phase B has none of the
    /// new fields and must still parse and still recover from the generic path.
    #[test]
    fn recovery_discovery_reads_a_legacy_pre_sidecar_manifest() {
        let root = unique_test_dir("b-legacy-manifest");
        let recovery_dir = root.join("recovery");
        std::fs::create_dir_all(&recovery_dir).expect("failed creating recovery dir");
        // The pre-Ph0.1 payload name, which is never written any more.
        let legacy = recovery_dir.join(super::SCENE_AUTOSAVE_LEGACY_VOXL_FILE);
        std::fs::write(&legacy, voxl_payload(b"legacy")).expect("legacy seed failed");

        let legacy_json = r#"{"savedAt":"2026-07-01T12:00:00.000Z","clean":false}"#;
        let manifest: super::SceneAutosaveManifest =
            serde_json::from_str(legacy_json).expect("a pre-Ph0.1 manifest no longer parses");
        assert_eq!(manifest.voxl_path, None);

        let found = super::resolve_scene_autosave_recovery(&recovery_dir, Some(&manifest))
            .expect("a pre-Ph0.1 autosave became unrecoverable");
        assert_eq!(found.voxl_path, legacy);
        assert_eq!(found.origin, super::SCENE_AUTOSAVE_ORIGIN_RECOVERY_DIR);
        assert_eq!(found.saved_at.as_deref(), Some("2026-07-01T12:00:00.000Z"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A payload that is not VOXL (truncated, foreign, or a leftover of some
    /// other tool) must not be advertised as recoverable.
    #[test]
    fn recovery_discovery_skips_candidates_that_are_not_voxl() {
        let (root, recovery_dir, project) = autosave_fixture("b-magic", "MyPrint.voxl");
        let sidecar = project.parent().unwrap().join("MyPrint_autosave.voxl");
        let generic = recovery_dir.join(super::SCENE_AUTOSAVE_VOXL_FILE);
        std::fs::write(&sidecar, b"NOPE-not-a-voxl").expect("sidecar seed failed");
        std::fs::write(&generic, voxl_payload(b"generic")).expect("generic seed failed");

        let manifest = super::SceneAutosaveManifest {
            saved_at: "2026-07-26T00:00:00.000Z".to_string(),
            clean: false,
            voxl_path: Some(sidecar.to_string_lossy().to_string()),
            origin: Some(super::SCENE_AUTOSAVE_ORIGIN_SIDECAR.to_string()),
            project_path: Some(project.to_string_lossy().to_string()),
            payload_bytes: None,
            fallback_reason: None,
            last_error: None,
        };

        let found = super::resolve_scene_autosave_recovery(&recovery_dir, Some(&manifest))
            .expect("recovery gave up instead of falling through a bad payload");
        assert_eq!(
            found.voxl_path, generic,
            "a non-VOXL payload was advertised as recoverable"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The reader accepts only paths the resolver itself produced — never an
    /// arbitrary caller-supplied path. Same discipline as
    /// `scene_file_discard_atomic_temp`'s guard.
    #[test]
    fn recovery_read_rejects_paths_outside_the_candidate_list() {
        let (root, recovery_dir, project) = autosave_fixture("b-candidate-guard", "MyPrint.voxl");
        let sidecar = project.parent().unwrap().join("MyPrint_autosave.voxl");
        std::fs::write(&sidecar, voxl_payload(b"sidecar")).expect("sidecar seed failed");

        let manifest = super::SceneAutosaveManifest {
            saved_at: "2026-07-26T00:00:00.000Z".to_string(),
            clean: false,
            voxl_path: Some(sidecar.to_string_lossy().to_string()),
            origin: Some(super::SCENE_AUTOSAVE_ORIGIN_SIDECAR.to_string()),
            project_path: Some(project.to_string_lossy().to_string()),
            payload_bytes: None,
            fallback_reason: None,
            last_error: None,
        };

        let candidates = super::scene_autosave_recovery_candidates(&recovery_dir, Some(&manifest));
        assert!(super::is_allowed_recovery_read(&candidates, &sidecar));
        // The user's own project is never a recovery candidate.
        assert!(!super::is_allowed_recovery_read(&candidates, &project));
        assert!(!super::is_allowed_recovery_read(
            &candidates,
            std::path::Path::new("C:/Windows/System32/config/SAM")
        ));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Cleanup gate: only a file this policy could have produced may be deleted
    /// through the payload-deletion seam.
    #[test]
    fn only_autosave_payloads_are_deletable() {
        let recovery_dir = std::path::Path::new("C:/appdata/autosave");
        assert!(super::is_deletable_autosave_payload(
            recovery_dir,
            std::path::Path::new("C:/projects/MyPrint_autosave.voxl")
        ));
        assert!(super::is_deletable_autosave_payload(
            recovery_dir,
            &recovery_dir.join(super::SCENE_AUTOSAVE_VOXL_FILE)
        ));
        // The pre-Ph0.1 payload name has no marker; it is deletable only because
        // it sits at the one well-known legacy location.
        assert!(super::is_deletable_autosave_payload(
            recovery_dir,
            &recovery_dir.join(super::SCENE_AUTOSAVE_LEGACY_VOXL_FILE)
        ));
        assert!(!super::is_deletable_autosave_payload(
            recovery_dir,
            std::path::Path::new("C:/projects/scene.voxl")
        ));
        // The user's project, and anything else, never.
        assert!(!super::is_deletable_autosave_payload(
            recovery_dir,
            std::path::Path::new("C:/projects/MyPrint.voxl")
        ));
        assert!(!super::is_deletable_autosave_payload(
            recovery_dir,
            std::path::Path::new("C:/projects/MyPrint_autosave.stl")
        ));
    }

    /// **Save-As cleanup (user item 6).** A sidecar left beside the *old* project
    /// after Save As is an orphan that implies unsaved work which does not exist.
    #[test]
    fn sidecar_for_a_project_is_deleted_by_name_and_nothing_else_is() {
        let (root, _recovery, project) = autosave_fixture("b-saveas-cleanup", "MyPrint.voxl");
        let sidecar = project.parent().unwrap().join("MyPrint_autosave.voxl");
        let neighbour = project.parent().unwrap().join("OtherPrint_autosave.voxl");
        std::fs::write(&sidecar, voxl_payload(b"s")).expect("sidecar seed failed");
        std::fs::write(&neighbour, voxl_payload(b"n")).expect("neighbour seed failed");

        super::delete_sidecar_for_project(&project).expect("sidecar deletion failed");

        assert!(!sidecar.exists(), "the orphaned sidecar was not deleted");
        assert!(project.exists(), "deletion touched the user's project");
        assert!(neighbour.exists(), "deletion touched an unrelated sidecar");

        // Idempotent: a project that never autosaved is not an error.
        super::delete_sidecar_for_project(&project).expect("second deletion should be a no-op");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// **Inherited from sub-phase A.** A crashed write leaves a
    /// `<target>.tmp-<pid>-<seq>` sibling beside the user's project. Sweep them,
    /// but only files matching A's exact pattern and only where we already write.
    #[test]
    fn stale_commit_temps_are_swept_conservatively() {
        let root = unique_test_dir("b-temp-sweep");
        let stale = root.join("MyPrint.voxl.tmp-424242-7");
        let ours = root.join(format!("MyPrint.voxl.tmp-{}-0", std::process::id()));
        let innocent = root.join("MyPrint.voxl");
        let lookalike = root.join("MyPrint.voxl.tmp-notapid-0");
        for path in [&stale, &ours, &innocent, &lookalike] {
            std::fs::write(path, b"x").expect("seed failed");
        }

        // Nothing is old enough yet, so a fresh crash residue is left alone —
        // an in-flight write from another instance must never be deleted.
        assert_eq!(super::sweep_stale_scene_commit_temps(&root, 3600), 0);
        assert!(stale.exists());

        // With the age gate satisfied, only other processes' temps go.
        assert_eq!(super::sweep_stale_scene_commit_temps(&root, 0), 1);
        assert!(!stale.exists(), "a stale foreign temp survived the sweep");
        assert!(ours.exists(), "the sweep deleted this process's own live temp");
        assert!(innocent.exists(), "the sweep deleted a real scene file");
        assert!(lookalike.exists(), "the sweep deleted a non-matching file");

        let _ = std::fs::remove_dir_all(&root);
    }
}
