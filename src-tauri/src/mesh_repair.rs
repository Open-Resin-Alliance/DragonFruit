//! Tauri IPC surface for `dragonfruit-mesh-repair`.
//!
//! Commands:
//! - `mesh_analyze_from_path` — parse a mesh file and return the analysis JSON.
//! - `mesh_repair_from_path` — parse + repair, replace the staging buffer with
//!   repaired positions, return the health report JSON.
//! - `mesh_repair_staged` — repair whatever is currently in the staging buffer
//!   (in-memory or on-disk), replace the buffer with the cleaned mesh, return
//!   the report JSON.
//! - `mesh_classify_staged` — classify-only pass over staged mesh (no repair),
//!   optionally reorders model/support sections and returns a report JSON.
//! - `mesh_repair_read_positions` — raw-binary response of the current staged
//!   positions (little-endian f32, 9 per triangle), for frontend hydration.

use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use dragonfruit_mesh_repair::{
    analyze, classify_support_split, hollow_voxel, io, punch_cylinders, repair, HolePunchOptions,
    HollowOptions, HollowSession, IndexedMesh, RepairOptions, Vec3,
};
use rayon::prelude::*;
use serde::Deserialize;
use tauri::ipc::Response;

use crate::{
    staged_mesh, staged_mesh_file_appender, staged_mesh_file_path, staged_mesh_stats,
    StageMeshStats,
};

static HOLLOW_PREVIEW_SOURCE_MESH: OnceLock<Mutex<Option<Arc<IndexedMesh>>>> = OnceLock::new();
static HOLLOW_PREVIEW_SESSION: OnceLock<Mutex<Option<Arc<HollowSession>>>> = OnceLock::new();
static HOLLOW_PREVIEW_RESULT_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
static HOLLOW_PREVIEW_INFILL_RESULT_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
static HOLLOW_PREVIEW_REMOVED_VOXEL_CENTER_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> =
    OnceLock::new();
static HOLLOW_PREVIEW_REMOVED_VOXEL_INDEX_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
static HOLLOW_PREVIEW_BLOCKED_VOXEL_CENTER_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> =
    OnceLock::new();
/// Cavity interior mesh from the staged hollow path.
static HOLLOW_STAGED_CAVITY_RESULT_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
/// Cavity interior mesh from the preview hollow path.
static HOLLOW_PREVIEW_CAVITY_RESULT_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
static PUNCH_SOURCE_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
static PUNCH_RESULT_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();

fn hollow_preview_source_mesh() -> &'static Mutex<Option<Arc<IndexedMesh>>> {
    HOLLOW_PREVIEW_SOURCE_MESH.get_or_init(|| Mutex::new(None))
}

fn hollow_preview_session() -> &'static Mutex<Option<Arc<HollowSession>>> {
    HOLLOW_PREVIEW_SESSION.get_or_init(|| Mutex::new(None))
}

fn hollow_preview_result_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    HOLLOW_PREVIEW_RESULT_BYTES.get_or_init(|| Mutex::new(None))
}

fn hollow_preview_infill_result_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    HOLLOW_PREVIEW_INFILL_RESULT_BYTES.get_or_init(|| Mutex::new(None))
}

fn hollow_preview_removed_voxel_center_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    HOLLOW_PREVIEW_REMOVED_VOXEL_CENTER_BYTES.get_or_init(|| Mutex::new(None))
}

fn hollow_preview_removed_voxel_index_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    HOLLOW_PREVIEW_REMOVED_VOXEL_INDEX_BYTES.get_or_init(|| Mutex::new(None))
}

fn hollow_preview_blocked_voxel_center_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    HOLLOW_PREVIEW_BLOCKED_VOXEL_CENTER_BYTES.get_or_init(|| Mutex::new(None))
}

fn hollow_staged_cavity_result_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    HOLLOW_STAGED_CAVITY_RESULT_BYTES.get_or_init(|| Mutex::new(None))
}

fn hollow_preview_cavity_result_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    HOLLOW_PREVIEW_CAVITY_RESULT_BYTES.get_or_init(|| Mutex::new(None))
}

fn punch_source_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    PUNCH_SOURCE_BYTES.get_or_init(|| Mutex::new(None))
}

fn punch_result_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    PUNCH_RESULT_BYTES.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RepairOptionsDto {
    weld_epsilon: Option<f32>,
    fill_holes_max_edges: Option<usize>,
    keep_largest_n_components: Option<usize>,
    repair_orientation: Option<bool>,
    resolve_self_intersections: Option<bool>,
    solidify_fragmented_components: Option<bool>,
    solidify_component_threshold: Option<usize>,
    solidify_self_intersection_threshold: Option<usize>,
}

impl From<RepairOptionsDto> for RepairOptions {
    fn from(dto: RepairOptionsDto) -> Self {
        let defaults = RepairOptions::default();
        RepairOptions {
            weld_epsilon: dto.weld_epsilon.unwrap_or(defaults.weld_epsilon),
            fill_holes_max_edges: dto
                .fill_holes_max_edges
                .unwrap_or(defaults.fill_holes_max_edges),
            keep_largest_n_components: dto
                .keep_largest_n_components
                .or(defaults.keep_largest_n_components),
            repair_orientation: dto
                .repair_orientation
                .unwrap_or(defaults.repair_orientation),
            resolve_self_intersections: dto
                .resolve_self_intersections
                .unwrap_or(defaults.resolve_self_intersections),
            solidify_fragmented_components: dto
                .solidify_fragmented_components
                .unwrap_or(defaults.solidify_fragmented_components),
            solidify_component_threshold: dto
                .solidify_component_threshold
                .unwrap_or(defaults.solidify_component_threshold),
            solidify_self_intersection_threshold: dto
                .solidify_self_intersection_threshold
                .unwrap_or(defaults.solidify_self_intersection_threshold),
        }
    }
}

fn parse_options(options_json: &str) -> RepairOptions {
    if options_json.trim().is_empty() {
        return RepairOptions::default();
    }
    serde_json::from_str::<RepairOptionsDto>(options_json)
        .unwrap_or_default()
        .into()
}

fn parse_hollow_options(options_json: &str) -> HollowOptions {
    if options_json.trim().is_empty() {
        return HollowOptions::default();
    }

    serde_json::from_str::<HollowOptions>(options_json).unwrap_or_default()
}

fn parse_hole_punch_options(options_json: &str) -> HolePunchOptions {
    if options_json.trim().is_empty() {
        return HolePunchOptions::default();
    }

    serde_json::from_str::<HolePunchOptions>(options_json).unwrap_or_default()
}

#[tauri::command]
pub async fn mesh_analyze_from_path(file_path: String) -> Result<String, String> {
    let path = PathBuf::from(file_path);
    if !path.exists() {
        return Err(format!(
            "mesh_analyze_from_path: not found: {}",
            path.display()
        ));
    }
    let mesh = tauri::async_runtime::spawn_blocking(move || {
        io::load_mesh_from_path(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("analyze task panicked: {e}"))??;
    let analysis = analyze(&mesh);
    serde_json::to_string(&analysis).map_err(|e| format!("serialize analysis: {e}"))
}

#[tauri::command]
pub async fn mesh_repair_from_path(
    file_path: String,
    options_json: String,
) -> Result<String, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!(
            "mesh_repair_from_path: not found: {}",
            path.display()
        ));
    }
    let options = parse_options(&options_json);
    let source_path = file_path.clone();
    let (mesh, mut report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::load_mesh_from_path(&path).map_err(|e| e.to_string())?;
        let outcome = repair(mesh, &options);
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("repair task panicked: {e}"))??;
    report.source_path = Some(source_path);
    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize report: {e}"))
}

#[tauri::command]
pub async fn mesh_repair_staged(options_json: String) -> Result<String, String> {
    let options = parse_options(&options_json);
    let bytes = read_staging_bytes()?;
    let (mesh, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let outcome = repair(mesh, &options);
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("repair task panicked: {e}"))??;
    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize report: {e}"))
}

/// Runs a lightweight model/support section classifier over the current staged
/// mesh without executing the heavy repair pipeline.
#[tauri::command]
pub async fn mesh_classify_staged() -> Result<String, String> {
    let bytes = read_staging_bytes()?;
    let (mesh, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let outcome = classify_support_split(mesh);
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("classify task panicked: {e}"))??;

    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize report: {e}"))
}

/// Analyses the current staged positions buffer without modifying it.
/// Used by the frontend to inspect mesh health before committing to a repair.
#[tauri::command]
pub async fn mesh_analyze_staged() -> Result<String, String> {
    let bytes = read_staging_bytes()?;
    let analysis = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        Ok::<_, String>(analyze(&mesh))
    })
    .await
    .map_err(|e| format!("analyze task panicked: {e}"))??;
    serde_json::to_string(&analysis).map_err(|e| format!("serialize analysis: {e}"))
}

/// Applies voxel hollowing to the current staged mesh.
/// Replaces staged positions with the hollowed result and returns a JSON report.
#[tauri::command]
pub async fn mesh_hollow_staged(options_json: String) -> Result<String, String> {
    let options = parse_hollow_options(&options_json);
    let bytes = read_staging_bytes()?;
    let (mesh, cavity_bytes, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let outcome = hollow_voxel(mesh, &options);
        let cavity_bytes = outcome.cavity_mesh.as_ref().map(|cm| {
            let soup = cm.to_triangle_soup();
            bytemuck::cast_slice::<f32, u8>(&soup).to_vec()
        });
        Ok::<_, String>((outcome.mesh, cavity_bytes, outcome.report))
    })
    .await
    .map_err(|e| format!("hollow task panicked: {e}"))??;

    *hollow_staged_cavity_result_bytes()
        .lock()
        .map_err(|e| format!("hollow staged cavity result lock poisoned: {e}"))? = cavity_bytes;

    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize hollow report: {e}"))
}

/// Captures the current staged mesh bytes as the source for repeated
/// non-mutating hollow previews.
#[tauri::command]
pub async fn mesh_hollow_preview_capture_staged_source() -> Result<(), String> {
    let bytes = read_staging_bytes()?;
    let source_mesh = tauri::async_runtime::spawn_blocking(move || {
        io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("hollow preview capture task panicked: {e}"))??;

    *hollow_preview_source_mesh()
        .lock()
        .map_err(|e| format!("hollow preview source lock poisoned: {e}"))? =
        Some(Arc::new(source_mesh));
    *hollow_preview_session()
        .lock()
        .map_err(|e| format!("hollow preview session lock poisoned: {e}"))? = None;
    *hollow_preview_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview result lock poisoned: {e}"))? = None;
    *hollow_preview_infill_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview infill result lock poisoned: {e}"))? = None;
    *hollow_preview_removed_voxel_center_bytes()
        .lock()
        .map_err(|e| format!("hollow preview removed voxel center result lock poisoned: {e}"))? =
        None;
    *hollow_preview_removed_voxel_index_bytes()
        .lock()
        .map_err(|e| format!("hollow preview removed voxel index result lock poisoned: {e}"))? =
        None;
    Ok(())
}

/// Runs voxel hollowing against the captured preview source mesh without
/// mutating the regular staged mesh buffer.
#[tauri::command]
pub async fn mesh_hollow_preview_from_captured_source(
    options_json: String,
) -> Result<String, String> {
    let options = parse_hollow_options(&options_json);
    let source_mesh = hollow_preview_source_mesh()
        .lock()
        .map_err(|e| format!("hollow preview source lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No captured hollow preview source — call mesh_hollow_preview_capture_staged_source first"
                .to_string()
        })?;

    let cached_session = hollow_preview_session()
        .lock()
        .map_err(|e| format!("hollow preview session lock poisoned: {e}"))?
        .clone();

    let session = if let Some(session) = cached_session {
        if session.voxel_resolution() == options.voxel_resolution
            && session.rotation_quat() == options.rotation_quat
        {
            session
        } else {
            let source_mesh_for_build = source_mesh.clone();
            let resolution = options.voxel_resolution;
            let rotation = options.rotation_quat;
            let session = tauri::async_runtime::spawn_blocking(move || {
                Ok::<_, String>(Arc::new(HollowSession::with_rotation(
                    (*source_mesh_for_build).clone(),
                    resolution,
                    rotation,
                )))
            })
            .await
            .map_err(|e| format!("hollow preview session build panicked: {e}"))??;
            *hollow_preview_session()
                .lock()
                .map_err(|e| format!("hollow preview session lock poisoned: {e}"))? =
                Some(session.clone());
            session
        }
    } else {
        let source_mesh_for_build = source_mesh.clone();
        let resolution = options.voxel_resolution;
        let rotation = options.rotation_quat;
        let session = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, String>(Arc::new(HollowSession::with_rotation(
                (*source_mesh_for_build).clone(),
                resolution,
                rotation,
            )))
        })
        .await
        .map_err(|e| format!("hollow preview session build panicked: {e}"))??;
        *hollow_preview_session()
            .lock()
            .map_err(|e| format!("hollow preview session lock poisoned: {e}"))? =
            Some(session.clone());
        session
    };

    let (
        positions_bytes,
        cavity_bytes,
        infill_positions_bytes,
        removed_voxel_center_bytes,
        removed_voxel_index_bytes,
        blocked_voxel_center_bytes,
        report,
    ) = tauri::async_runtime::spawn_blocking(move || {
        let outcome = session.run(&options);
        let soup = outcome.mesh.to_triangle_soup();
        let bytes: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&soup).to_vec();
        let cavity_bytes = outcome.cavity_mesh.as_ref().map(|cm| {
            let soup = cm.to_triangle_soup();
            bytemuck::cast_slice::<f32, u8>(&soup).to_vec()
        });
        let infill_bytes = outcome.preview_infill_mesh.map(|mesh| {
            let soup = mesh.to_triangle_soup();
            bytemuck::cast_slice::<f32, u8>(&soup).to_vec()
        });
        let removed_voxel_center_bytes =
            bytemuck::cast_slice::<f32, u8>(&outcome.removed_voxel_centers).to_vec();
        let removed_voxel_index_bytes =
            bytemuck::cast_slice::<u32, u8>(&outcome.removed_voxel_indices).to_vec();
        let blocked_voxel_center_bytes =
            bytemuck::cast_slice::<f32, u8>(&outcome.blocked_voxel_centers).to_vec();
        Ok::<_, String>((
            bytes,
            cavity_bytes,
            infill_bytes,
            removed_voxel_center_bytes,
            removed_voxel_index_bytes,
            blocked_voxel_center_bytes,
            outcome.report,
        ))
    })
    .await
    .map_err(|e| format!("hollow preview task panicked: {e}"))??;

    *hollow_preview_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview result lock poisoned: {e}"))? = Some(positions_bytes);
    if let Some(cb) = cavity_bytes {
        *hollow_preview_cavity_result_bytes()
            .lock()
            .map_err(|e| format!("hollow preview cavity result lock poisoned: {e}"))? = Some(cb);
    }
    *hollow_preview_infill_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview infill result lock poisoned: {e}"))? =
        infill_positions_bytes;
    *hollow_preview_removed_voxel_center_bytes()
        .lock()
        .map_err(|e| format!("hollow preview removed voxel center result lock poisoned: {e}"))? =
        Some(removed_voxel_center_bytes);
    *hollow_preview_removed_voxel_index_bytes()
        .lock()
        .map_err(|e| format!("hollow preview removed voxel index result lock poisoned: {e}"))? =
        Some(removed_voxel_index_bytes);
    *hollow_preview_blocked_voxel_center_bytes()
        .lock()
        .map_err(|e| format!("hollow preview blocked voxel center result lock poisoned: {e}"))? =
        Some(blocked_voxel_center_bytes);

    serde_json::to_string(&report).map_err(|e| format!("serialize hollow preview report: {e}"))
}

#[tauri::command]
pub async fn mesh_hollow_apply_from_captured_source(
    options_json: String,
) -> Result<String, String> {
    let options = parse_hollow_options(&options_json);
    let source_mesh = hollow_preview_source_mesh()
        .lock()
        .map_err(|e| format!("hollow preview source lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No captured hollow preview source — call mesh_hollow_preview_capture_staged_source first"
                .to_string()
        })?;

    let cached_session = hollow_preview_session()
        .lock()
        .map_err(|e| format!("hollow preview session lock poisoned: {e}"))?
        .clone();

    let session = if let Some(session) = cached_session {
        if session.voxel_resolution() == options.voxel_resolution
            && session.rotation_quat() == options.rotation_quat
        {
            session
        } else {
            let source_mesh_for_build = source_mesh.clone();
            let resolution = options.voxel_resolution;
            let rotation = options.rotation_quat;
            let session = tauri::async_runtime::spawn_blocking(move || {
                Ok::<_, String>(Arc::new(HollowSession::with_rotation(
                    (*source_mesh_for_build).clone(),
                    resolution,
                    rotation,
                )))
            })
            .await
            .map_err(|e| format!("hollow apply session build panicked: {e}"))??;
            *hollow_preview_session()
                .lock()
                .map_err(|e| format!("hollow preview session lock poisoned: {e}"))? =
                Some(session.clone());
            session
        }
    } else {
        let source_mesh_for_build = source_mesh.clone();
        let resolution = options.voxel_resolution;
        let rotation = options.rotation_quat;
        let session = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, String>(Arc::new(HollowSession::with_rotation(
                (*source_mesh_for_build).clone(),
                resolution,
                rotation,
            )))
        })
        .await
        .map_err(|e| format!("hollow apply session build panicked: {e}"))??;
        *hollow_preview_session()
            .lock()
            .map_err(|e| format!("hollow preview session lock poisoned: {e}"))? =
            Some(session.clone());
        session
    };

    let (mesh, cavity_bytes, report) = tauri::async_runtime::spawn_blocking(move || {
        let outcome = session.run(&options);
        let cavity_bytes = outcome.cavity_mesh.as_ref().map(|cm| {
            let soup = cm.to_triangle_soup();
            bytemuck::cast_slice::<f32, u8>(&soup).to_vec()
        });
        Ok::<_, String>((outcome.mesh, cavity_bytes, outcome.report))
    })
    .await
    .map_err(|e| format!("hollow apply task panicked: {e}"))??;

    *hollow_staged_cavity_result_bytes()
        .lock()
        .map_err(|e| format!("hollow staged cavity result lock poisoned: {e}"))? = cavity_bytes;

    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize hollow apply report: {e}"))
}

/// Returns the most recent non-mutating hollow preview positions as raw
/// little-endian bytes.
#[tauri::command]
pub async fn mesh_hollow_preview_read_positions() -> Result<Response, String> {
    let bytes = hollow_preview_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow preview result — call mesh_hollow_preview_from_captured_source first"
                .to_string()
        })?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn mesh_hollow_preview_read_infill_positions() -> Result<Response, String> {
    let bytes = hollow_preview_infill_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview infill result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow preview infill result — call mesh_hollow_preview_from_captured_source first"
                .to_string()
        })?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn mesh_hollow_preview_read_removed_voxel_centers() -> Result<Response, String> {
    let bytes = hollow_preview_removed_voxel_center_bytes()
        .lock()
        .map_err(|e| format!("hollow preview removed voxel center result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow preview removed voxel center result — call mesh_hollow_preview_from_captured_source first"
                .to_string()
        })?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn mesh_hollow_preview_read_removed_voxel_indices() -> Result<Response, String> {
    let bytes = hollow_preview_removed_voxel_index_bytes()
        .lock()
        .map_err(|e| format!("hollow preview removed voxel index result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow preview removed voxel index result — call mesh_hollow_preview_from_captured_source first"
                .to_string()
        })?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn mesh_hollow_preview_read_blocked_voxel_centers() -> Result<Response, String> {
    let bytes = hollow_preview_blocked_voxel_center_bytes()
        .lock()
        .map_err(|e| format!("hollow preview blocked voxel center result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow preview blocked voxel center result — call mesh_hollow_preview_from_captured_source first"
                .to_string()
        })?;
    Ok(Response::new(bytes))
}

/// Reads the cavity interior mesh positions from the last preview hollow operation.
#[tauri::command]
pub async fn mesh_hollow_preview_read_cavity_positions() -> Result<Response, String> {
    let bytes = hollow_preview_cavity_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview cavity result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow preview cavity result — call mesh_hollow_preview_from_captured_source first"
                .to_string()
        })?;
    Ok(Response::new(bytes))
}

/// Reads the cavity interior mesh positions from the last staged hollow operation.
#[tauri::command]
pub async fn mesh_hollow_staged_read_cavity_positions() -> Result<Response, String> {
    let bytes = hollow_staged_cavity_result_bytes()
        .lock()
        .map_err(|e| format!("hollow staged cavity result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow staged cavity result — call mesh_hollow_staged first".to_string()
        })?;
    Ok(Response::new(bytes))
}

/// Applies manual cylindrical hole punches to the current staged mesh.
#[tauri::command]
pub async fn mesh_punch_staged(options_json: String) -> Result<String, String> {
    let options = parse_hole_punch_options(&options_json);
    let bytes = read_staging_bytes()?;
    let (mesh, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let outcome = punch_cylinders(mesh, &options);
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("punch task panicked: {e}"))??;

    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize punch report: {e}"))
}

/// Captures the current staged mesh bytes as the source for repeated
/// non-mutating hole-punch runs.
#[tauri::command]
pub async fn mesh_punch_capture_staged_source() -> Result<(), String> {
    let bytes = read_staging_bytes()?;
    *punch_source_bytes()
        .lock()
        .map_err(|e| format!("punch source lock poisoned: {e}"))? = Some(bytes);
    *punch_result_bytes()
        .lock()
        .map_err(|e| format!("punch result lock poisoned: {e}"))? = None;
    Ok(())
}

/// Runs hole punching against the captured source mesh without mutating the
/// regular staged mesh buffer.
#[tauri::command]
pub async fn mesh_punch_from_captured_source(options_json: String) -> Result<String, String> {
    let options = parse_hole_punch_options(&options_json);
    let source_bytes = punch_source_bytes()
        .lock()
        .map_err(|e| format!("punch source lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No captured punch source — call mesh_punch_capture_staged_source first".to_string()
        })?;

    let (positions_bytes, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&source_bytes).map_err(|e| e.to_string())?;
        let outcome = punch_cylinders(mesh, &options);
        let soup = outcome.mesh.to_triangle_soup();
        let bytes: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&soup).to_vec();
        Ok::<_, String>((bytes, outcome.report))
    })
    .await
    .map_err(|e| format!("punch task panicked: {e}"))??;

    *punch_result_bytes()
        .lock()
        .map_err(|e| format!("punch result lock poisoned: {e}"))? = Some(positions_bytes);

    serde_json::to_string(&report).map_err(|e| format!("serialize punch report: {e}"))
}

/// Returns the most recent non-mutating punch result positions as raw
/// little-endian bytes.
#[tauri::command]
pub async fn mesh_punch_read_positions() -> Result<Response, String> {
    let bytes = punch_result_bytes()
        .lock()
        .map_err(|e| format!("punch result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No punch result — call mesh_punch_from_captured_source first".to_string()
        })?;
    Ok(Response::new(bytes))
}

/// Returns the current staged positions buffer as raw little-endian bytes.
/// Used by the frontend to hydrate a `THREE.BufferGeometry` after a repair.
#[tauri::command]
pub async fn mesh_repair_read_positions() -> Result<Response, String> {
    let bytes = read_staging_bytes()?;
    Ok(Response::new(bytes))
}

/// Parses a binary or ASCII STL file in Rust and returns the vertex positions
/// and per-vertex normals as a flat byte buffer.
///
/// Byte layout: a 16-byte `DFST` header containing flags and the original/output
/// triangle counts, followed by little-endian f32 positions and normals.
///
/// Processing the file in Rust avoids loading the entire raw STL into the
/// webview's memory space, which can save ~1 GB for a large binary STL.
#[tauri::command]
pub async fn load_stl_file(file_path: String) -> Result<Response, String> {
    use dragonfruit_mesh_repair::io;

    let path = std::path::Path::new(&file_path);

    log::info!("[load_stl_file] Starting native STL load: {file_path}");

    // The current IPC format expands every triangle to positions plus normals
    // (72 bytes/triangle), before Three.js builds its BVH and uploads buffers.
    // Reject inputs that cannot fit that representation before the repair
    // loader reads and indexes the entire STL in memory.
    const MAX_NATIVE_STL_TRIANGLES: u64 = 6_000_000;
    const PREVIEW_TARGET_TRIANGLES: usize = 2_000_000;
    const MAX_NATIVE_ASCII_STL_BYTES: u64 = 300_000_000;
    let file_size = std::fs::metadata(path)
        .map_err(|e| format!("Failed to inspect STL '{}': {e}", file_path))?
        .len();
    let mut header = [0u8; 84];
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open STL '{}': {e}", file_path))?;
    let header_len = file
        .read(&mut header)
        .map_err(|e| format!("Failed to read STL header '{}': {e}", file_path))?;

    if header_len == header.len() {
        let triangle_count = u32::from_le_bytes(header[80..84].try_into().unwrap()) as u64;
        let expected_binary_size = 84u64.saturating_add(triangle_count.saturating_mul(50));
        if expected_binary_size == file_size && triangle_count > MAX_NATIVE_STL_TRIANGLES {
            drop(file);
            let preview =
                load_binary_stl_preview(path, triangle_count as u32, PREVIEW_TARGET_TRIANGLES)?;
            log::info!(
                "[load_stl_file] Streaming preview complete: {} -> {} triangles",
                triangle_count,
                preview.triangles.len()
            );
            return encode_stl_response(&preview, triangle_count as u32, true).map(Response::new);
        }
    }
    if file_size > MAX_NATIVE_ASCII_STL_BYTES && header.starts_with(b"solid") {
        return Err(format!(
            "ASCII STL is too large for the current renderer ({:.2} GB on disk; limit {:.2} GB). Decimate or convert it before importing.",
            file_size as f64 / 1_000_000_000.0,
            MAX_NATIVE_ASCII_STL_BYTES as f64 / 1_000_000_000.0,
        ));
    }
    drop(file);

    let mesh =
        io::stl::load(path).map_err(|e| format!("Failed to load STL '{}': {e}", file_path))?;

    let tri_count = mesh.triangles.len();
    encode_stl_response(&mesh, tri_count as u32, false).map(Response::new)
}

const STL_RESPONSE_MAGIC: &[u8; 4] = b"DFST";
const STL_RESPONSE_HEADER_BYTES: usize = 16;
const STL_RESPONSE_FLAG_PREVIEW: u32 = 1;

fn encode_stl_response(
    mesh: &IndexedMesh,
    original_triangle_count: u32,
    is_preview: bool,
) -> Result<Vec<u8>, String> {
    let tri_count = mesh.triangles.len();
    let positions_len = tri_count * 9 * std::mem::size_of::<f32>();
    let normals_len = tri_count * 9 * std::mem::size_of::<f32>();
    let response_len = STL_RESPONSE_HEADER_BYTES
        .checked_add(positions_len)
        .and_then(|size| size.checked_add(normals_len))
        .ok_or_else(|| "STL response size overflow".to_string())?;
    let mut result = Vec::new();
    result.try_reserve_exact(response_len).map_err(|_| {
        format!(
            "Not enough memory for the STL response ({:.2} GB)",
            response_len as f64 / 1_000_000_000.0
        )
    })?;
    result.extend_from_slice(STL_RESPONSE_MAGIC);
    result.extend_from_slice(
        &(if is_preview {
            STL_RESPONSE_FLAG_PREVIEW
        } else {
            0
        })
        .to_le_bytes(),
    );
    result.extend_from_slice(&original_triangle_count.to_le_bytes());
    result.extend_from_slice(&(tri_count as u32).to_le_bytes());
    result.resize(response_len, 0);
    let (position_output, normal_output) =
        result[STL_RESPONSE_HEADER_BYTES..].split_at_mut(positions_len);
    position_output
        .par_chunks_mut(9 * std::mem::size_of::<f32>())
        .zip(mesh.triangles.par_iter())
        .for_each(|(output, triangle)| {
            let vertices = [
                mesh.positions[triangle[0] as usize],
                mesh.positions[triangle[1] as usize],
                mesh.positions[triangle[2] as usize],
            ];
            for (vertex_output, vertex) in output.chunks_exact_mut(12).zip(vertices) {
                vertex_output[0..4].copy_from_slice(&vertex.x.to_le_bytes());
                vertex_output[4..8].copy_from_slice(&vertex.y.to_le_bytes());
                vertex_output[8..12].copy_from_slice(&vertex.z.to_le_bytes());
            }
        });
    normal_output
        .par_chunks_mut(9 * std::mem::size_of::<f32>())
        .zip(mesh.triangles.par_iter())
        .for_each(|(output, triangle)| {
            let p0 = mesh.positions[triangle[0] as usize];
            let p1 = mesh.positions[triangle[1] as usize];
            let p2 = mesh.positions[triangle[2] as usize];
            let face_normal = p1.sub(p0).cross(p2.sub(p0));
            let len = face_normal.length();
            let normal = if len > 1e-10 {
                face_normal.scale(1.0 / len)
            } else {
                Vec3::ZERO
            };
            for normal_output in output.chunks_exact_mut(12) {
                normal_output[0..4].copy_from_slice(&normal.x.to_le_bytes());
                normal_output[4..8].copy_from_slice(&normal.y.to_le_bytes());
                normal_output[8..12].copy_from_slice(&normal.z.to_le_bytes());
            }
        });

    log::info!(
        "[load_stl_file] {} triangles, {} MB positions + {} MB normals",
        tri_count,
        positions_len / (1024 * 1024),
        normals_len / (1024 * 1024),
    );

    Ok(result)
}

fn read_binary_stl_vertex(record: &[u8; 50], offset: usize) -> Vec3 {
    let read_f32 = |at: usize| f32::from_le_bytes(record[at..at + 4].try_into().unwrap());
    Vec3::new(read_f32(offset), read_f32(offset + 4), read_f32(offset + 8))
}

struct PreviewTempDir(PathBuf);

impl Drop for PreviewTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn binary_stl_bounds(path: &std::path::Path, triangle_count: u32) -> Result<(Vec3, Vec3), String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open STL preview source: {e}"))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    reader
        .seek(SeekFrom::Start(84))
        .map_err(|e| format!("Failed seeking STL: {e}"))?;
    let mut record = [0u8; 50];
    let mut min = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut max = Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for triangle_index in 0..triangle_count {
        reader
            .read_exact(&mut record)
            .map_err(|e| format!("Truncated binary STL at triangle {triangle_index}: {e}"))?;
        for offset in [12, 24, 36] {
            let vertex = read_binary_stl_vertex(&record, offset);
            min = min.min(vertex);
            max = max.max(vertex);
        }
    }
    Ok((min, max))
}

fn simplify_preview_region(
    path: &std::path::Path,
    triangle_count: usize,
    target_ratio: f64,
) -> Result<IndexedMesh, String> {
    let bucket_file =
        std::fs::File::open(path).map_err(|e| format!("Failed opening STL preview bucket: {e}"))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, bucket_file);
    let mut record = [0u8; 50];
    let mut soup = Vec::with_capacity(triangle_count * 9);
    for _ in 0..triangle_count {
        reader
            .read_exact(&mut record)
            .map_err(|e| format!("Failed reading STL preview bucket: {e}"))?;
        for offset in [12, 24, 36] {
            let vertex = read_binary_stl_vertex(&record, offset);
            soup.extend_from_slice(&[vertex.x, vertex.y, vertex.z]);
        }
    }

    let chunk = IndexedMesh::from_triangle_soup(&soup, 1e-8);
    let indices: Vec<u32> = chunk
        .triangles
        .iter()
        .flat_map(|triangle| triangle.iter().copied())
        .collect();
    let target_index_count =
        ((indices.len() as f64 * target_ratio).floor() as usize).max(3) / 3 * 3;
    let vertex_bytes: &[u8] = bytemuck::cast_slice(&chunk.positions);
    let vertices = meshopt::VertexDataAdapter::new(vertex_bytes, std::mem::size_of::<Vec3>(), 0)
        .map_err(|e| format!("Failed preparing preview simplifier: {e}"))?;
    let simplified = meshopt::simplify(
        &indices,
        &vertices,
        target_index_count,
        1.0,
        meshopt::SimplifyOptions::LockBorder | meshopt::SimplifyOptions::Regularize,
        None,
    );
    let selected = if simplified.is_empty() {
        &indices
    } else {
        &simplified
    };
    let mut output = IndexedMesh {
        positions: Vec::with_capacity(selected.len()),
        triangles: Vec::with_capacity(selected.len() / 3),
    };
    for triangle in selected.chunks_exact(3) {
        let base = output.positions.len() as u32;
        output.positions.push(chunk.positions[triangle[0] as usize]);
        output.positions.push(chunk.positions[triangle[1] as usize]);
        output.positions.push(chunk.positions[triangle[2] as usize]);
        output.triangles.push([base, base + 1, base + 2]);
    }
    Ok(output)
}

fn load_binary_stl_preview(
    path: &std::path::Path,
    triangle_count: u32,
    target_triangles: usize,
) -> Result<IndexedMesh, String> {
    let bucket_divisions = if triangle_count < 1_000_000 { 1 } else { 4 };
    let bucket_count = bucket_divisions * bucket_divisions * bucket_divisions;
    let (bbox_min, bbox_max) = binary_stl_bounds(path, triangle_count)?;
    let extent = bbox_max.sub(bbox_min);
    let temp_path = std::env::temp_dir().join(format!(
        "dragonfruit-stl-preview-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    std::fs::create_dir(&temp_path)
        .map_err(|e| format!("Failed creating STL preview workspace: {e}"))?;
    let temp_dir = PreviewTempDir(temp_path);
    let mut writers: Vec<Option<BufWriter<std::fs::File>>> =
        (0..bucket_count).map(|_| None).collect();
    let mut bucket_counts = vec![0usize; bucket_count];
    let file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open STL preview source: {e}"))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    reader
        .seek(SeekFrom::Start(84))
        .map_err(|e| format!("Failed seeking STL: {e}"))?;
    let mut record = [0u8; 50];
    let total = triangle_count as usize;
    for triangle_index in 0..total {
        reader
            .read_exact(&mut record)
            .map_err(|e| format!("Truncated binary STL at triangle {triangle_index}: {e}"))?;
        let a = read_binary_stl_vertex(&record, 12);
        let b = read_binary_stl_vertex(&record, 24);
        let c = read_binary_stl_vertex(&record, 36);
        let centroid = a.add(b).add(c).scale(1.0 / 3.0);
        let axis_bucket = |value: f32, min: f32, span: f32| -> usize {
            if span <= 1e-9 {
                0
            } else {
                (((value - min) / span) * bucket_divisions as f32)
                    .floor()
                    .clamp(0.0, (bucket_divisions - 1) as f32) as usize
            }
        };
        let x = axis_bucket(centroid.x, bbox_min.x, extent.x);
        let y = axis_bucket(centroid.y, bbox_min.y, extent.y);
        let z = axis_bucket(centroid.z, bbox_min.z, extent.z);
        let bucket = x + bucket_divisions * (y + bucket_divisions * z);
        if writers[bucket].is_none() {
            let bucket_file = std::fs::File::create(temp_dir.0.join(format!("{bucket}.bin")))
                .map_err(|e| format!("Failed creating STL preview bucket: {e}"))?;
            writers[bucket] = Some(BufWriter::with_capacity(64 * 1024, bucket_file));
        }
        writers[bucket]
            .as_mut()
            .unwrap()
            .write_all(&record)
            .map_err(|e| format!("Failed writing STL preview bucket: {e}"))?;
        bucket_counts[bucket] += 1;
    }
    for writer in writers.iter_mut().flatten() {
        writer
            .flush()
            .map_err(|e| format!("Failed flushing STL preview bucket: {e}"))?;
    }
    drop(writers);

    let target_ratio = (target_triangles as f64 / triangle_count as f64).min(1.0);
    let mut output = IndexedMesh {
        positions: Vec::with_capacity(target_triangles.saturating_mul(3)),
        triangles: Vec::with_capacity(target_triangles),
    };
    let regions: Vec<(usize, usize)> = bucket_counts
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, count)| *count > 0)
        .collect();
    let worker_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(2)
        .min(4);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(worker_count)
        .thread_name(|index| format!("stl-preview-{index}"))
        .build()
        .map_err(|e| format!("Failed creating STL preview worker pool: {e}"))?;
    let simplified_regions: Vec<Result<(usize, usize, IndexedMesh), String>> = pool.install(|| {
        regions
            .par_iter()
            .map(|&(bucket, count)| {
                simplify_preview_region(
                    &temp_dir.0.join(format!("{bucket}.bin")),
                    count,
                    target_ratio,
                )
                .map(|mesh| (bucket, count, mesh))
            })
            .collect()
    });
    for region in simplified_regions {
        let (bucket, bucket_triangle_count, region) = region?;
        let vertex_base = output.positions.len() as u32;
        output.positions.extend(region.positions);
        output.triangles.extend(
            region
                .triangles
                .into_iter()
                .map(|[a, b, c]| [a + vertex_base, b + vertex_base, c + vertex_base]),
        );
        log::info!(
            "[load_stl_file] Topology-safe preview region {}/{}: {} source triangles, {} total output triangles",
            bucket + 1,
            bucket_count,
            bucket_triangle_count,
            output.triangles.len()
        );
    }

    if output.triangles.is_empty() {
        Err("Could not build a bounded preview for this STL".to_string())
    } else {
        Ok(output)
    }
}

#[cfg(test)]
mod stl_preview_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn streaming_preview_is_nonempty_and_bounded() {
        let grid_size = 80u32;
        let triangle_count = grid_size * grid_size * 2;
        let path = std::env::temp_dir().join(format!(
            "dragonfruit-stl-preview-{}.stl",
            std::process::id()
        ));
        let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        file.write_all(&[0u8; 80]).unwrap();
        file.write_all(&triangle_count.to_le_bytes()).unwrap();
        for y in 0..grid_size {
            for x in 0..grid_size {
                let x = x as f32;
                let y = y as f32;
                for vertices in [
                    [[x, y, 0.0], [x + 1.0, y, 0.0], [x + 1.0, y + 1.0, 0.0]],
                    [[x, y, 0.0], [x + 1.0, y + 1.0, 0.0], [x, y + 1.0, 0.0]],
                ] {
                    file.write_all(&[0u8; 12]).unwrap();
                    for vertex in vertices {
                        for component in vertex {
                            file.write_all(&component.to_le_bytes()).unwrap();
                        }
                    }
                    file.write_all(&[0u8; 2]).unwrap();
                }
            }
        }
        file.flush().unwrap();
        drop(file);

        let preview = load_binary_stl_preview(&path, triangle_count, 500).unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(!preview.triangles.is_empty());
        assert!(preview.triangles.len() <= 500);
    }

    #[test]
    #[ignore = "requires DRAGONFRUIT_LARGE_STL_TEST_PATH"]
    fn streaming_preview_external_stl() {
        let path = std::path::PathBuf::from(
            std::env::var("DRAGONFRUIT_LARGE_STL_TEST_PATH")
                .expect("DRAGONFRUIT_LARGE_STL_TEST_PATH must point to a binary STL"),
        );
        let mut file = std::fs::File::open(&path).unwrap();
        let mut header = [0u8; 84];
        file.read_exact(&mut header).unwrap();
        let triangle_count = u32::from_le_bytes(header[80..84].try_into().unwrap());
        let preview = load_binary_stl_preview(&path, triangle_count, 2_000_000).unwrap();
        eprintln!(
            "previewed {triangle_count} triangles as {} triangles / {} vertices",
            preview.triangles.len(),
            preview.positions.len()
        );
        assert!(!preview.triangles.is_empty());
        assert!(preview.triangles.len() <= 2_000_000);
    }
}

// --- internal helpers ----------------------------------------------------

fn read_staging_bytes() -> Result<Vec<u8>, String> {
    // Prefer the in-memory staging buffer if present.
    if let Some(bytes) = staged_mesh()
        .lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))?
        .clone()
    {
        return Ok(bytes);
    }

    // Otherwise, flush any outstanding appender and read the on-disk path.
    {
        let mut appender_lock = staged_mesh_file_appender()
            .lock()
            .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;
        if let Some(appender) = appender_lock.as_mut() {
            use std::io::Write;
            appender
                .writer
                .flush()
                .map_err(|e| format!("flush staged mesh appender: {e}"))?;
        }
    }
    let path = staged_mesh_file_path()
        .lock()
        .map_err(|e| format!("staged mesh file-path lock poisoned: {e}"))?
        .clone();
    match path {
        Some(p) => std::fs::read(&p).map_err(|e| format!("read staged mesh file '{p}': {e}")),
        None => {
            Err("No staged mesh buffer — call stage_mesh_* or mesh_repair_from_path first".into())
        }
    }
}

fn replace_staging_with_mesh(mesh: &IndexedMesh) -> Result<(), String> {
    let soup = mesh.to_triangle_soup();
    let bytes: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&soup).to_vec();

    // Clear any file-based staging; we put everything in-memory for the
    // repaired mesh since it's already fully materialised.
    *staged_mesh_file_appender()
        .lock()
        .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))? = None;
    *staged_mesh_file_path()
        .lock()
        .map_err(|e| format!("staged mesh file-path lock poisoned: {e}"))? = None;
    *staged_mesh_stats()
        .lock()
        .map_err(|e| format!("staged mesh stats lock poisoned: {e}"))? = StageMeshStats {
        chunks_received: 1,
        append_ns_total: 0,
    };
    *staged_mesh()
        .lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))? = Some(bytes);
    Ok(())
}
