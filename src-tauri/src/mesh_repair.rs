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
static HOLLOW_PREVIEW_BLOCKED_VOXEL_INDEX_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
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

fn hollow_preview_blocked_voxel_index_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    HOLLOW_PREVIEW_BLOCKED_VOXEL_INDEX_BYTES.get_or_init(|| Mutex::new(None))
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

/// Clears every hollow-preview buffer derived from the captured source mesh
/// (session cache, all result/removed/blocked/cavity byte buffers). Called
/// whenever a new source mesh is captured so stale data from a previous
/// model/session can never be served alongside a fresh one.
fn reset_hollow_preview_derived_state() -> Result<(), String> {
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
    *hollow_preview_blocked_voxel_center_bytes()
        .lock()
        .map_err(|e| format!("hollow preview blocked voxel center result lock poisoned: {e}"))? =
        None;
    *hollow_preview_blocked_voxel_index_bytes()
        .lock()
        .map_err(|e| format!("hollow preview blocked voxel index result lock poisoned: {e}"))? =
        None;
    *hollow_preview_cavity_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview cavity result lock poisoned: {e}"))? = None;
    *hollow_staged_cavity_result_bytes()
        .lock()
        .map_err(|e| format!("hollow staged cavity result lock poisoned: {e}"))? = None;
    Ok(())
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

fn parse_options(options_json: &str) -> Result<RepairOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(RepairOptions::default());
    }
    serde_json::from_str::<RepairOptionsDto>(options_json)
        .map(RepairOptions::from)
        .map_err(|e| format!("invalid repair options JSON: {e}"))
}

fn parse_hollow_options(options_json: &str) -> Result<HollowOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(HollowOptions::default());
    }
    serde_json::from_str::<HollowOptions>(options_json)
        .map_err(|e| format!("invalid hollow options JSON: {e}"))
}

fn parse_hole_punch_options(options_json: &str) -> Result<HolePunchOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(HolePunchOptions::default());
    }
    serde_json::from_str::<HolePunchOptions>(options_json)
        .map_err(|e| format!("invalid hole punch options JSON: {e}"))
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
    let options = parse_options(&options_json)?;
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
    let options = parse_options(&options_json)?;
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
    let options = parse_hollow_options(&options_json)?;
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
    reset_hollow_preview_derived_state()?;
    Ok(())
}

/// Runs voxel hollowing against the captured preview source mesh without
/// mutating the regular staged mesh buffer.
#[tauri::command]
pub async fn mesh_hollow_preview_from_captured_source(
    options_json: String,
) -> Result<String, String> {
    let options = parse_hollow_options(&options_json)?;
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
        blocked_voxel_index_bytes,
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
        let blocked_voxel_index_bytes =
            bytemuck::cast_slice::<u32, u8>(&outcome.blocked_voxel_indices).to_vec();
        Ok::<_, String>((
            bytes,
            cavity_bytes,
            infill_bytes,
            removed_voxel_center_bytes,
            removed_voxel_index_bytes,
            blocked_voxel_center_bytes,
            blocked_voxel_index_bytes,
            outcome.report,
        ))
    })
    .await
    .map_err(|e| format!("hollow preview task panicked: {e}"))??;

    *hollow_preview_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview result lock poisoned: {e}"))? = Some(positions_bytes);
    *hollow_preview_cavity_result_bytes()
        .lock()
        .map_err(|e| format!("hollow preview cavity result lock poisoned: {e}"))? = cavity_bytes;
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
    *hollow_preview_blocked_voxel_index_bytes()
        .lock()
        .map_err(|e| format!("hollow preview blocked voxel index result lock poisoned: {e}"))? =
        Some(blocked_voxel_index_bytes);

    serde_json::to_string(&report).map_err(|e| format!("serialize hollow preview report: {e}"))
}

#[tauri::command]
pub async fn mesh_hollow_apply_from_captured_source(
    options_json: String,
) -> Result<String, String> {
    let options = parse_hollow_options(&options_json)?;
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

#[tauri::command]
pub async fn mesh_hollow_preview_read_blocked_voxel_indices() -> Result<Response, String> {
    let bytes = hollow_preview_blocked_voxel_index_bytes()
        .lock()
        .map_err(|e| format!("hollow preview blocked voxel index result lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow preview blocked voxel index result — call mesh_hollow_preview_from_captured_source first"
                .to_string()
        })?;
    Ok(Response::new(bytes))
}

/// Request payload for `mesh_hollow_preview_select_removed_voxels_in_polygon`.
/// All fields are in the same spaces the frontend lasso resolver used before
/// the projection moved to Rust: `polygon` in container pixels, `view_proj` a
/// column-major `projectionMatrix * matrixWorldInverse`, and the model
/// transform (`geometry_center`/`scale`/`rotation_quat`/`position`) matching
/// `resolveBlockedHollowVoxelMarqueeSelection`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectRemovedVoxelsRequest {
    polygon: Vec<[f32; 2]>,
    view_proj: [f32; 16],
    rect_width: f32,
    rect_height: f32,
    geometry_center: [f32; 3],
    scale: [f32; 3],
    rotation_quat: [f32; 4],
    position: [f32; 3],
    options: HollowOptions,
}

/// Selects the full through-depth set of removed (cavity) voxels whose
/// projected screen point falls inside the lasso polygon, operating on the
/// cached hollow-preview session so the result is immune to the boundary
/// filter and viewport cap that narrow the rendered/exported voxel subset.
/// Returns the grid indices as raw little-endian `u32` bytes.
#[tauri::command]
pub async fn mesh_hollow_preview_select_removed_voxels_in_polygon(
    request_json: String,
) -> Result<Response, String> {
    let request: SelectRemovedVoxelsRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("invalid select-removed-voxels request JSON: {e}"))?;

    let session = hollow_preview_session()
        .lock()
        .map_err(|e| format!("hollow preview session lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No hollow preview session — call mesh_hollow_preview_from_captured_source first"
                .to_string()
        })?;

    let indices = tauri::async_runtime::spawn_blocking(move || {
        let selected = session.select_removed_voxels_in_polygon(
            &request.options,
            &request.polygon,
            &request.view_proj,
            request.rect_width,
            request.rect_height,
            Vec3::new(
                request.geometry_center[0],
                request.geometry_center[1],
                request.geometry_center[2],
            ),
            Vec3::new(request.scale[0], request.scale[1], request.scale[2]),
            request.rotation_quat,
            Vec3::new(request.position[0], request.position[1], request.position[2]),
        );
        Ok::<Vec<u32>, String>(selected)
    })
    .await
    .map_err(|e| format!("hollow select task panicked: {e}"))??;

    let bytes = bytemuck::cast_slice::<u32, u8>(&indices).to_vec();
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
    let options = parse_hole_punch_options(&options_json)?;
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
    let options = parse_hole_punch_options(&options_json)?;
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
pub async fn load_stl_file(
    file_path: String,
    js_heap_size_limit: Option<f64>,
) -> Result<Response, String> {
    use dragonfruit_mesh_repair::io;

    let path = std::path::Path::new(&file_path);

    log::info!("[load_stl_file] Starting native STL load: {file_path}");

    // ASCII STLs are ~7× larger on disk than binary; the byte cap guards the
    // full-file parse against OOM before any triangle-count is known.
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

    // Governor inputs shared by the binary and ASCII paths. Memory is queried
    // ONCE per import (no runtime feedback loop); `jsHeapSizeLimit` is the
    // WebView-side constraint forwarded by the frontend (0 / None when the
    // WebView doesn't expose `performance.memory`).
    let (ram_total, ram_available) = crate::stl_budget::query_system_memory();
    let heap_limit = js_heap_size_limit
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value as u64)
        .unwrap_or(0);
    let make_budget = |source_triangles: u64| {
        let budget = crate::stl_budget::compute_triangle_budget(&crate::stl_budget::BudgetInputs {
            ram_total_bytes: ram_total,
            ram_available_bytes: ram_available,
            heap_limit_bytes: heap_limit,
            source_triangles,
            // Per-model today; plate-level rebalancing is a documented
            // follow-up (imports are per-file at this boundary).
            concurrent_model_count: 1,
        });
        log::info!(
            "[STL budget governor] budget={} tris, reason={}, inputs{{ram_total={}, ram_avail={}, heap_limit={}, bytes_per_tri={}, source_tris={}}}",
            budget.budget_tris,
            budget.reason.as_str(),
            ram_total,
            ram_available,
            heap_limit,
            crate::stl_budget::BYTES_PER_TRIANGLE_HEAP,
            source_triangles,
        );
        budget
    };

    if header_len == header.len() {
        let triangle_count = u32::from_le_bytes(header[80..84].try_into().unwrap()) as u64;
        let expected_binary_size = 84u64.saturating_add(triangle_count.saturating_mul(50));
        if expected_binary_size == file_size {
            drop(file);
            let budget = make_budget(triangle_count);
            if triangle_count <= budget.budget_tris {
                // At/under budget → keep verbatim (NO decimation). The former
                // hard 6M gate is gone; the budget scales with the machine.
                let mesh = io::stl::load(path)
                    .map_err(|e| format!("Failed to load STL '{}': {e}", file_path))?;
                log::info!(
                    "[load_stl_file] Native load kept verbatim: {} triangles (≤ budget {})",
                    mesh.triangles.len(),
                    budget.budget_tris,
                );
                return encode_stl_response(
                    &mesh,
                    triangle_count as u32,
                    false,
                    0.0,
                    budget.budget_tris as u32,
                )
                .map(Response::new);
            }
            // Over budget → query-first decimation TO budget.
            let outcome = decimate_binary_stl_to_budget(
                path,
                triangle_count as u32,
                budget.budget_tris as usize,
            )?;
            log::info!(
                "[load_stl_file] Query-first decimation: {} -> {} triangles (budget {}, achieved_error {:.6})",
                triangle_count,
                outcome.mesh.triangles.len(),
                budget.budget_tris,
                outcome.achieved_error,
            );
            return encode_stl_response(
                &outcome.mesh,
                triangle_count as u32,
                true,
                outcome.achieved_error,
                budget.budget_tris as u32,
            )
            .map(Response::new);
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

    // ASCII (or non-standard binary): parse fully, then apply the SAME
    // governor policy to the loaded mesh.
    let mesh =
        io::stl::load(path).map_err(|e| format!("Failed to load STL '{}': {e}", file_path))?;
    let source_tris = mesh.triangles.len() as u64;
    let budget = make_budget(source_tris);
    if source_tris <= budget.budget_tris {
        return encode_stl_response(&mesh, source_tris as u32, false, 0.0, budget.budget_tris as u32)
            .map(Response::new);
    }
    let outcome = decimate_indexed_to_budget(mesh, budget.budget_tris as usize, DECIMATION_OPTIONS);
    log::info!(
        "[load_stl_file] Query-first decimation (ASCII): {} -> {} triangles (budget {}, achieved_error {:.6})",
        source_tris,
        outcome.mesh.triangles.len(),
        budget.budget_tris,
        outcome.achieved_error,
    );
    encode_stl_response(
        &outcome.mesh,
        source_tris as u32,
        true,
        outcome.achieved_error,
        budget.budget_tris as u32,
    )
    .map(Response::new)
}

const STL_RESPONSE_MAGIC: &[u8; 4] = b"DFST";
// 24-byte header: magic(4) + flags(4) + original_count(4) + output_count(4)
// + achieved_error f32(4) + budget_tris u32(4). The two trailing fields were
// added for Phase 2a (query-first decimation) so the frontend/badge can show
// the ACTUAL decimation error + governor budget; they are 0 for verbatim
// loads. Additive: the decoder in useStlGeometry.ts reads them at offsets
// 16/20 and the payload now starts at offset 24.
const STL_RESPONSE_HEADER_BYTES: usize = 24;
const STL_RESPONSE_FLAG_PREVIEW: u32 = 1;

fn encode_stl_response(
    mesh: &IndexedMesh,
    original_triangle_count: u32,
    is_preview: bool,
    achieved_error: f32,
    budget_triangles: u32,
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
    result.extend_from_slice(&achieved_error.to_le_bytes());
    result.extend_from_slice(&budget_triangles.to_le_bytes());
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

// --- Phase 2a: query-first, budget-governed decimation ----------------------
//
// Replaces the legacy fixed 6M-gate → 2M-target pair (which slashed a mesh a
// hair over 6M by two-thirds) with a continuous policy: a mesh at/under the
// governor budget is kept verbatim; a mesh over budget is decimated TO budget
// in a SINGLE meshopt call, reading back the achieved count AND error. The
// query is the decimation: meshopt reduces toward the count target but never
// past the error bound, so if the error bound binds first the returned count
// is the mesh's own safe-reduction floor. This whole-mesh call also removes
// the legacy per-bucket `LockBorder` seam-locking that was itself a floor
// inflator (P0: the bucketed 12M lattice floored at 6.22M).

/// Initial tight relative error bound for the query-first simplify. meshopt's
/// target/result error is RELATIVE to mesh extents (max axis) and lies in
/// [0,1]; the legacy path passed 1.0 (100% = effectively unbounded). ~0.002
/// (0.2 %) protects thin support struts/tips — high-curvature features resist
/// collapse under a tight bound — while the budget count is spent on
/// collapsible bulk surfaces (slabs, pads). This is the "error bound protects
/// features, count budget is the resource backstop" split.
const DECIMATION_TIGHT_ERROR: f32 = 0.002;

/// Stepped relative-error tiers, escalated ONLY when an error-bounded result
/// exceeds the soft ceiling (plan: 0.3 % → 1 %). Entry 0 is the tight bound.
const DECIMATION_ERROR_TIERS: [f32; 3] = [DECIMATION_TIGHT_ERROR, 0.003, 0.01];

/// Accept an error-bounded result up to this multiple of budget before
/// escalating the error tier (governor-derived headroom, plan ≤ 2× budget).
const SOFT_CEILING_BUDGET_MULTIPLE: usize = 2;

/// meshopt options for the query-first simplify. Regularize + LockBorder
/// DECISION (measured A/B on the 8M/12M off-origin lattice via
/// `p2a_regularize_lockborder_ab` --ignored, 2026-07-19): at budget = ⅔ source
/// all four option sets {none, LockBorder, Regularize, LockBorder|Regularize}
/// hit the SAME triangle count, but Regularize RAISED the achieved error
/// (8M: 0.000481 → 0.000532; 12M: 0.000396 → 0.000432) with zero count
/// benefit — i.e. it spends fidelity to resample without buying any budget, so
/// it is REJECTED. LockBorder is kept: it locks the mesh's outer topological
/// border (a real edge to preserve) with no measured cost here, and unlike the
/// legacy per-BUCKET LockBorder it does not lock interior seams (the whole-mesh
/// call has no buckets), so it does not inflate the floor. `Prune` is NEVER
/// set: it deletes disconnected components, which on a pre-supported plate
/// would delete exactly the struts/contact tips the remediation preserves.
const DECIMATION_OPTIONS: meshopt::SimplifyOptions = meshopt::SimplifyOptions::LockBorder;

/// Result of a query-first decimation: the reduced mesh plus meshopt's
/// achieved relative error (relative to mesh extents, [0,1]) for the honesty
/// badge (Phase 2b consumes it; surfaced verbatim, never hidden).
struct DecimationOutcome {
    mesh: IndexedMesh,
    achieved_error: f32,
}

/// Streams a binary STL's vertex soup WITHOUT materializing the whole file as
/// a byte buffer (unlike `io::stl::load`'s `read_to_end`) — preserves the
/// memory profile of the legacy streaming preview for very large inputs.
fn load_binary_stl_soup(path: &std::path::Path, triangle_count: u32) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open STL source for decimation: {e}"))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    reader
        .seek(SeekFrom::Start(84))
        .map_err(|e| format!("Failed seeking STL: {e}"))?;
    let mut record = [0u8; 50];
    let mut soup: Vec<f32> = Vec::new();
    soup.try_reserve_exact(triangle_count as usize * 9).map_err(|_| {
        format!(
            "Not enough memory to load {triangle_count} triangles for decimation"
        )
    })?;
    for triangle_index in 0..triangle_count {
        reader
            .read_exact(&mut record)
            .map_err(|e| format!("Truncated binary STL at triangle {triangle_index}: {e}"))?;
        for offset in [12, 24, 36] {
            let vertex = read_binary_stl_vertex(&record, offset);
            soup.extend_from_slice(&[vertex.x, vertex.y, vertex.z]);
        }
    }
    Ok(soup)
}

/// Query-first decimation of an already-indexed mesh TO a triangle budget in a
/// SINGLE meshopt call, escalating the error tier only if the error bound
/// binds so hard the result blows the soft ceiling. Returns the achieved
/// count (implicit in the mesh) and achieved error.
fn decimate_indexed_to_budget(
    mesh: IndexedMesh,
    budget_tris: usize,
    options: meshopt::SimplifyOptions,
) -> DecimationOutcome {
    let source_tris = mesh.triangles.len();
    if source_tris <= budget_tris {
        // Defensive: the caller gates on budget, but never decimate up.
        return DecimationOutcome {
            mesh,
            achieved_error: 0.0,
        };
    }

    let indices: Vec<u32> = mesh
        .triangles
        .iter()
        .flat_map(|triangle| triangle.iter().copied())
        .collect();
    let vertex_bytes: &[u8] = bytemuck::cast_slice(&mesh.positions);
    let vertices = match meshopt::VertexDataAdapter::new(vertex_bytes, std::mem::size_of::<Vec3>(), 0)
    {
        Ok(adapter) => adapter,
        // Vertex layout is fixed (Vec3, tight stride) — this cannot fail in
        // practice; if it ever did, return the source unchanged rather than 0.
        Err(_) => {
            return DecimationOutcome {
                mesh,
                achieved_error: f32::NAN,
            }
        }
    };

    let target_index_count = budget_tris.max(1).saturating_mul(3).min(indices.len());
    let soft_ceiling_tris = budget_tris.saturating_mul(SOFT_CEILING_BUDGET_MULTIPLE);

    let mut selected: Vec<u32> = Vec::new();
    let mut achieved_error = 1.0f32;
    for &error in DECIMATION_ERROR_TIERS.iter() {
        let mut tier_error = 0.0f32;
        let simplified = meshopt::simplify(
            &indices,
            &vertices,
            target_index_count,
            error,
            options,
            Some(&mut tier_error),
        );
        let tier_count = simplified.len() / 3;
        selected = simplified;
        achieved_error = tier_error;
        // Count target bound (at/under budget) or error-bounded result already
        // under the soft ceiling → done. Otherwise escalate the error tier.
        if tier_count <= soft_ceiling_tris {
            break;
        }
    }

    // meshopt returns an empty buffer if it cannot simplify at all — fall back
    // to the source (legacy behavior) rather than emit an empty mesh.
    if selected.is_empty() {
        return DecimationOutcome {
            mesh,
            achieved_error: 1.0,
        };
    }

    let triangles: Vec<[u32; 3]> = selected
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect();
    // The simplified indices reference the ORIGINAL vertex buffer; keep it.
    // `encode_stl_response` reads only referenced positions (per-triangle
    // expansion), so unreferenced verts cost transient Rust memory only, never
    // IPC bytes.
    DecimationOutcome {
        mesh: IndexedMesh {
            positions: mesh.positions,
            triangles,
        },
        achieved_error,
    }
}

/// Streams a binary STL and decimates it to `budget_tris` (query-first).
fn decimate_binary_stl_to_budget(
    path: &std::path::Path,
    triangle_count: u32,
    budget_tris: usize,
) -> Result<DecimationOutcome, String> {
    let soup = load_binary_stl_soup(path, triangle_count)?;
    let mesh = IndexedMesh::from_triangle_soup(&soup, io::DEFAULT_MERGE_EPSILON);
    drop(soup);
    Ok(decimate_indexed_to_budget(mesh, budget_tris, DECIMATION_OPTIONS))
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

// --- Phase 1: full-resolution output splice (STL import decimation remediation) ---
//
// >6M-triangle binary STL imports are represented in the scene by a decimated
// preview; output paths (slicing staging, mesh export) must NOT consume that
// preview. These commands re-read the ORIGINAL file from disk, reproject each
// raw vertex by `w = M · (v_raw − C_pre)` (f64 math, f32 output — decision memo
// `agents/Claude/STL-import-perf/20260718-P0-Decision-memo-fullres-sourcing.md`
// §2.2/§4.3), and write the result directly into the staging surface the
// output path consumes. The bytes never enter the WebView (plan §C.2).
//
// `C_pre` is the STORED import-time pre-centering bbox center captured by the
// frontend at import. It must never be recomputed from the full mesh here —
// the islands sideload's frame bug came from substituting a scene-side center
// (memo §2.3).

/// Byte size of one binary-STL triangle record.
const STL_RECORD_BYTES: usize = 50;
/// Triangles processed per streaming chunk (~2.25 MB of f32 world floats).
const FULLRES_SPLICE_CHUNK_TRIANGLES: usize = 65_536;

/// Typed-error prefixes the frontend matches on to drive the degrade-to-preview
/// warning path. Never silently fall back Rust-side.
pub(crate) const FULLRES_SOURCE_MISSING_PREFIX: &str = "FULLRES_SOURCE_MISSING";
pub(crate) const FULLRES_SOURCE_STALE_PREFIX: &str = "FULLRES_SOURCE_STALE";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullResQuantizationBounds {
    pub min_x: f32,
    pub min_y: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_y: f32,
    pub max_z: f32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFileStat {
    pub size_bytes: u64,
    pub mtime_ms: f64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullResSpliceSummary {
    pub staged_triangle_count: u64,
    pub world_min: [f32; 3],
    pub world_max: [f32; 3],
    pub splice_ms: f64,
}

fn stat_file_fingerprint(path: &std::path::Path) -> Result<SourceFileStat, String> {
    let meta = std::fs::metadata(path).map_err(|e| {
        format!(
            "{FULLRES_SOURCE_MISSING_PREFIX}: cannot stat '{}': {e}",
            path.display()
        )
    })?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Ok(SourceFileStat {
        size_bytes: meta.len(),
        mtime_ms: mtime_ms,
    })
}

/// Returns the on-disk size + mtime for an import source file, captured by the
/// frontend at import time as the staleness fingerprint for full-res re-reads.
#[tauri::command]
pub async fn stat_source_file(file_path: String) -> Result<SourceFileStat, String> {
    stat_file_fingerprint(std::path::Path::new(&file_path))
}

pub(crate) struct FullResSpliceParams<'a> {
    pub source_path: &'a std::path::Path,
    /// Scene transform matrix, column-major (THREE.Matrix4.elements order),
    /// `M = T·R·S` exactly as the WebView bake composes it.
    pub matrix16_col_major: [f64; 16],
    /// Import-time pre-centering bbox center, raw-file frame (memo §2.2).
    pub c_pre: [f64; 3],
    /// Expected (size, mtimeMs) captured at import. `None` skips the staleness
    /// comparison (file existence is still required).
    pub expected_fingerprint: Option<(u64, f64)>,
    /// Reproduce the JS bake's winding flip for negative-determinant
    /// transforms (rasterLayerZipExport.ts appendModelTrianglesInRange, #334).
    /// Slicing passes true; mesh export (which never flips) passes false.
    pub flip_winding_on_negative_determinant: bool,
}

struct FullResSpliceStats {
    triangle_count: u64,
    world_min: [f32; 3],
    world_max: [f32; 3],
}

/// Streams the binary STL at `source_path`, reprojects every vertex by
/// `w = M · (v_raw − C_pre)` in f64, and hands world-space f32 triangle chunks
/// (9 floats per triangle) to `sink`. O(chunk) memory; the full soup is never
/// materialised. `sample` receives (triangle_index, world_triangle) for any
/// index listed in `sample_indices` (R2 verification seam).
fn splice_fullres_stl_stream(
    params: &FullResSpliceParams<'_>,
    sample_indices: &[u64],
    mut sample: impl FnMut(u64, [[f32; 3]; 3]),
    mut sink: impl FnMut(&[f32]) -> Result<(), String>,
) -> Result<FullResSpliceStats, String> {
    let path = params.source_path;
    let actual = stat_file_fingerprint(path)?;
    if let Some((expected_size, expected_mtime_ms)) = params.expected_fingerprint {
        // mtime tolerance: FAT/zip round-trips can quantise to 2 s; the
        // frontend captures ms from the same stat call, so exact match is the
        // norm — allow sub-2s drift only when the size matches exactly.
        let mtime_delta_ms = (actual.mtime_ms - expected_mtime_ms).abs();
        if actual.size_bytes != expected_size || mtime_delta_ms > 2_000.0 {
            return Err(format!(
                "{FULLRES_SOURCE_STALE_PREFIX}: '{}' changed since import \
                 (size {} -> {}, mtime {:.0} -> {:.0})",
                path.display(),
                expected_size,
                actual.size_bytes,
                expected_mtime_ms,
                actual.mtime_ms,
            ));
        }
    }

    let file = std::fs::File::open(path).map_err(|e| {
        format!(
            "{FULLRES_SOURCE_MISSING_PREFIX}: cannot open '{}': {e}",
            path.display()
        )
    })?;
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, file);
    let mut header = [0u8; 84];
    reader
        .read_exact(&mut header)
        .map_err(|e| format!("Failed reading STL header '{}': {e}", path.display()))?;
    let triangle_count = u32::from_le_bytes(header[80..84].try_into().unwrap()) as u64;
    let expected_binary_size = 84u64.saturating_add(triangle_count.saturating_mul(50));
    if triangle_count == 0 || expected_binary_size != actual.size_bytes {
        // Preview models can only originate from binary STLs (the >6M gate
        // lives in the binary branch of load_stl_file), so a non-binary file
        // here means the source was replaced — the stale class, not a format
        // we silently accept.
        return Err(format!(
            "{FULLRES_SOURCE_STALE_PREFIX}: '{}' is not the binary STL that was imported \
             (header count {} does not match {} bytes on disk)",
            path.display(),
            triangle_count,
            actual.size_bytes,
        ));
    }

    let m = &params.matrix16_col_major;
    // Column-major: m[0] m[4] m[8]  m[12]
    //               m[1] m[5] m[9]  m[13]
    //               m[2] m[6] m[10] m[14]
    let det3 = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9])
        + m[8] * (m[1] * m[6] - m[2] * m[5]);
    let flip_winding = params.flip_winding_on_negative_determinant && det3 < 0.0;
    let c_pre = params.c_pre;

    let transform = |v: [f32; 3]| -> [f32; 3] {
        let x = v[0] as f64 - c_pre[0];
        let y = v[1] as f64 - c_pre[1];
        let z = v[2] as f64 - c_pre[2];
        [
            (m[0] * x + m[4] * y + m[8] * z + m[12]) as f32,
            (m[1] * x + m[5] * y + m[9] * z + m[13]) as f32,
            (m[2] * x + m[6] * y + m[10] * z + m[14]) as f32,
        ]
    };

    let mut world_min = [f32::INFINITY; 3];
    let mut world_max = [f32::NEG_INFINITY; 3];
    let mut chunk: Vec<f32> = Vec::with_capacity(FULLRES_SPLICE_CHUNK_TRIANGLES * 9);
    let mut record = [0u8; STL_RECORD_BYTES];
    let mut sample_cursor = 0usize;

    for triangle_index in 0..triangle_count {
        reader.read_exact(&mut record).map_err(|e| {
            format!(
                "Truncated binary STL '{}' at triangle {triangle_index}: {e}",
                path.display()
            )
        })?;
        let raw = [
            read_binary_stl_vertex(&record, 12),
            read_binary_stl_vertex(&record, 24),
            read_binary_stl_vertex(&record, 36),
        ];
        let world = [
            transform([raw[0].x, raw[0].y, raw[0].z]),
            transform([raw[1].x, raw[1].y, raw[1].z]),
            transform([raw[2].x, raw[2].y, raw[2].z]),
        ];
        for vertex in &world {
            for axis in 0..3 {
                if vertex[axis] < world_min[axis] {
                    world_min[axis] = vertex[axis];
                }
                if vertex[axis] > world_max[axis] {
                    world_max[axis] = vertex[axis];
                }
            }
        }

        if sample_cursor < sample_indices.len() && sample_indices[sample_cursor] == triangle_index
        {
            sample(triangle_index, world);
            sample_cursor += 1;
        }

        let ordered: [[f32; 3]; 3] = if flip_winding {
            [world[0], world[2], world[1]]
        } else {
            world
        };
        for vertex in &ordered {
            chunk.extend_from_slice(vertex);
        }
        if chunk.len() >= FULLRES_SPLICE_CHUNK_TRIANGLES * 9 {
            sink(&chunk)?;
            chunk.clear();
        }
    }
    if !chunk.is_empty() {
        sink(&chunk)?;
    }

    Ok(FullResSpliceStats {
        triangle_count,
        world_min,
        world_max,
    })
}

fn parse_matrix16(matrix16: &[f64]) -> Result<[f64; 16], String> {
    <[f64; 16]>::try_from(matrix16)
        .map_err(|_| format!("matrix16 must have 16 elements, got {}", matrix16.len()))
}

fn parse_vec3_f64(values: &[f64], label: &str) -> Result<[f64; 3], String> {
    <[f64; 3]>::try_from(values)
        .map_err(|_| format!("{label} must have 3 elements, got {}", values.len()))
}

/// Quantizes world-space f32 floats into u16 LE bytes with exactly the same
/// arithmetic as the WebView transport (`quantizeMeshChunkToUint16`,
/// sliceExportOrchestrator.ts): f64 normalize → clamp 0..1 → round × 65535.
fn quantize_world_floats_to_u16_bytes(
    floats: &[f32],
    bounds: &FullResQuantizationBounds,
    out: &mut Vec<u8>,
) {
    let mins = [bounds.min_x as f64, bounds.min_y as f64, bounds.min_z as f64];
    let spans = [
        (bounds.max_x as f64 - bounds.min_x as f64).max(0.0),
        (bounds.max_y as f64 - bounds.min_y as f64).max(0.0),
        (bounds.max_z as f64 - bounds.min_z as f64).max(0.0),
    ];
    out.reserve(floats.len() * 2);
    for (index, value) in floats.iter().enumerate() {
        let axis = index % 3;
        let span = spans[axis];
        let q: u16 = if !span.is_finite() || span <= 0.0 {
            0
        } else {
            let normalized = ((*value as f64) - mins[axis]) / span;
            (normalized.clamp(0.0, 1.0) * 65_535.0).round() as u16
        };
        out.extend_from_slice(&q.to_le_bytes());
    }
}

/// Slicing splice: streams the original STL from `source_path`, reprojects to
/// world space, quantizes with the job's transport bounds, and APPENDS directly
/// into the in-memory staged mesh (`STAGED_MESH`). The orchestrator must have
/// called `stage_mesh_binary_start` first and must splice BEFORE streaming the
/// remaining models' chunks so model triangles stay contiguous at the front of
/// the staged buffer (model_triangle_count contract). Atomic per model: on any
/// failure the staged buffer is truncated back to its pre-splice length.
#[tauri::command]
pub async fn stage_fullres_mesh_from_source(
    source_path: String,
    matrix16: Vec<f64>,
    c_pre: Vec<f64>,
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
    quantization: FullResQuantizationBounds,
) -> Result<FullResSpliceSummary, String> {
    let started = std::time::Instant::now();
    let params = FullResSpliceParams {
        source_path: std::path::Path::new(&source_path),
        matrix16_col_major: parse_matrix16(&matrix16)?,
        c_pre: parse_vec3_f64(&c_pre, "cPre")?,
        expected_fingerprint: expected_size_bytes
            .and_then(|size| expected_mtime_ms.map(|mtime| (size, mtime))),
        flip_winding_on_negative_determinant: true,
    };

    let baseline_len = {
        let staged = staged_mesh()
            .lock()
            .map_err(|e| format!("staged mesh lock poisoned: {e}"))?;
        staged
            .as_ref()
            .map(|vec| vec.len())
            .ok_or("Staged mesh not started. Call stage_mesh_binary_start before the full-res splice.")?
    };

    let mut quantized_chunk: Vec<u8> = Vec::new();
    let result = splice_fullres_stl_stream(
        &params,
        &[],
        |_, _| {},
        |floats| {
            quantized_chunk.clear();
            quantize_world_floats_to_u16_bytes(floats, &quantization, &mut quantized_chunk);
            let mut staged = staged_mesh()
                .lock()
                .map_err(|e| format!("staged mesh lock poisoned: {e}"))?;
            let vec = staged
                .as_mut()
                .ok_or("Staged mesh buffer disappeared during full-res splice.")?;
            vec.extend_from_slice(&quantized_chunk);
            Ok(())
        },
    );

    match result {
        Ok(stats) => {
            let splice_ms = started.elapsed().as_secs_f64() * 1_000.0;
            log::info!(
                "[stage_fullres_mesh_from_source] spliced {} full-res triangles from '{}' in {:.1} ms (world z {:.3}..{:.3})",
                stats.triangle_count,
                source_path,
                splice_ms,
                stats.world_min[2],
                stats.world_max[2],
            );
            Ok(FullResSpliceSummary {
                staged_triangle_count: stats.triangle_count,
                world_min: stats.world_min,
                world_max: stats.world_max,
                splice_ms,
            })
        }
        Err(error) => {
            // Atomicity: drop any partial append so a degrade-to-preview
            // retry can restage this model through the WebView path.
            if let Ok(mut staged) = staged_mesh().lock() {
                if let Some(vec) = staged.as_mut() {
                    vec.truncate(baseline_len);
                }
            }
            Err(error)
        }
    }
}

/// Mesh-export splice: streams the original STL, reprojects to world space,
/// and APPENDS raw f32 LE triangles (36 bytes each) to the export staging file
/// consumed by `export_mesh_file`. Called after the WebView finishes writing
/// the non-preview geometry (triangle order in the staging file is
/// irrelevant to STL/3MF serialization).
#[tauri::command]
pub async fn splice_fullres_mesh_into_stage_file(
    source_path: String,
    stage_file_path: String,
    matrix16: Vec<f64>,
    c_pre: Vec<f64>,
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
) -> Result<FullResSpliceSummary, String> {
    let started = std::time::Instant::now();
    let params = FullResSpliceParams {
        source_path: std::path::Path::new(&source_path),
        matrix16_col_major: parse_matrix16(&matrix16)?,
        c_pre: parse_vec3_f64(&c_pre, "cPre")?,
        expected_fingerprint: expected_size_bytes
            .and_then(|size| expected_mtime_ms.map(|mtime| (size, mtime))),
        // The JS export bake applies matrixWorld verbatim without a winding
        // flip — mirror that exactly.
        flip_winding_on_negative_determinant: false,
    };

    // Release any WebView chunk appender still holding this staging file so
    // the append below starts from the fully-flushed state (same protocol as
    // export_mesh_file).
    {
        let mut lock = staged_mesh_file_appender()
            .lock()
            .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;
        let matches = lock
            .as_ref()
            .map_or(false, |appender| appender.path == stage_file_path);
        if matches {
            if let Some(appender) = lock.as_mut() {
                appender
                    .writer
                    .flush()
                    .map_err(|e| format!("Failed flushing staging appender: {e}"))?;
            }
            *lock = None;
        }
    }

    let stage_path = std::path::PathBuf::from(&stage_file_path);
    if let Some(parent) = stage_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating mesh stage directory: {e}"))?;
    }
    let baseline_len = std::fs::metadata(&stage_path).map(|m| m.len()).unwrap_or(0);
    let stage_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stage_path)
        .map_err(|e| format!("Failed opening mesh stage file '{stage_file_path}': {e}"))?;
    let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, stage_file);

    let result = splice_fullres_stl_stream(
        &params,
        &[],
        |_, _| {},
        |floats| {
            writer
                .write_all(bytemuck::cast_slice::<f32, u8>(floats))
                .map_err(|e| format!("Failed appending full-res export bytes: {e}"))
        },
    )
    .and_then(|stats| {
        writer
            .flush()
            .map_err(|e| format!("Failed flushing full-res export bytes: {e}"))?;
        Ok(stats)
    });

    match result {
        Ok(stats) => {
            let splice_ms = started.elapsed().as_secs_f64() * 1_000.0;
            log::info!(
                "[splice_fullres_mesh_into_stage_file] spliced {} full-res triangles from '{}' into '{}' in {:.1} ms",
                stats.triangle_count,
                source_path,
                stage_file_path,
                splice_ms,
            );
            Ok(FullResSpliceSummary {
                staged_triangle_count: stats.triangle_count,
                world_min: stats.world_min,
                world_max: stats.world_max,
                splice_ms,
            })
        }
        Err(error) => {
            // Atomicity: trim any partial append off the staging file.
            drop(writer);
            if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&stage_path) {
                let _ = file.set_len(baseline_len);
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hollow_options_parsing_rejects_malformed_json_instead_of_defaulting() {
        // Wrong type: previously produced HollowOptions::default() (resolution
        // 64, 2mm shell) and the destructive hollow ran anyway.
        assert!(parse_hollow_options(r#"{"voxelResolution": "192"}"#).is_err());
        // Truncated JSON.
        assert!(parse_hollow_options(r#"{"voxelResolution": 192"#).is_err());
    }

    #[test]
    fn hollow_options_parsing_accepts_empty_and_valid_input() {
        let defaults = parse_hollow_options("").expect("empty input falls back to defaults");
        assert_eq!(defaults.voxel_resolution, HollowOptions::default().voxel_resolution);

        let parsed = parse_hollow_options(r#"{"voxelResolution": 128, "shellThicknessMm": 1.5}"#)
            .expect("well-formed JSON parses");
        assert_eq!(parsed.voxel_resolution, 128);
        assert!((parsed.shell_thickness_mm - 1.5).abs() < 1e-6);
    }

    #[test]
    fn repair_and_punch_options_parsing_reject_malformed_json() {
        assert!(parse_options(r#"{"weldEpsilon": "tiny"}"#).is_err());
        assert!(parse_hole_punch_options(r#"{"punches": {}}"#).is_err());
    }
}

/// P0c RED HARNESS — STL import decimation remediation (plan:
/// `agents/Claude/STL-import-perf/20260718-Implementation-Plan-*.md`, Phase 0
/// steps 4–5). Test-only code (`#[cfg(test)]`): the deterministic off-origin
/// lattice asset generator, the §D9 import wall-time baseline, and the R2
/// deferred-red splice-contract test. Everything here is `#[ignore]`d so the
/// pinned `cargo test` baseline (8 passed / 1 ignored) gains ignored entries
/// only. Run pieces explicitly:
///
/// ```text
/// cargo test p0_fullres_red_harness -- --ignored --nocapture
/// ```
#[cfg(test)]
mod p0_fullres_red_harness {
    use super::*;
    use std::path::Path;
    use std::time::Instant;

    // --- Deterministic pre-supported-plate-like lattice -------------------
    //
    // Shape: one 120×120×1 mm base slab + a G×G grid of thin vertical struts,
    // each capped by a small "tip" box hovering TIP_GAP_MM above the strut top
    // (a detached contact tip, the feature class that unbounded decimation and
    // inflated weld steps destroy). Strut heights vary deterministically so
    // the simplifier has structure to chew on.
    //
    // OFF-ORIGIN BY CONSTRUCTION: the lattice bbox min corner sits exactly at
    // LATTICE_ORIGIN_MM = (40, 25, 0), like a real plate export. The islands
    // sideload frame bug survived precisely because origin-centered test
    // meshes hide `center` mix-ups (decision memo §2.3) — assets generated
    // here must never be origin-centered.
    //
    // Triangle enumeration order is STABLE and part of the contract (R2
    // samples triangles by index): slab box tris 0..12, then per grid cell
    // (row-major i, then j): 12 strut-box tris, 12 tip-box tris.

    /// Test-local mirror of the `MAX_NATIVE_STL_TRIANGLES` const inside
    /// `load_stl_file` (function-scoped there; production code is fenced for
    /// P0). Assets above this count take the streaming-preview path.
    const P0C_PREVIEW_GATE_TRIANGLES: u64 = 6_000_000;

    const LATTICE_ORIGIN_MM: [f32; 3] = [40.0, 25.0, 0.0];
    const LATTICE_PLATE_MM: f32 = 120.0;
    const LATTICE_SLAB_MM: f32 = 1.0;
    const LATTICE_TIP_GAP_MM: f32 = 0.06; // 60 µm — support-tip-gap scale
    const LATTICE_TIP_HEIGHT_MM: f32 = 0.3;

    /// Struts per side for a requested total triangle count.
    fn lattice_grid_for_target(target_triangles: u64) -> u32 {
        let cells = (target_triangles.saturating_sub(12)) / 24;
        (((cells as f64).sqrt().floor()) as u32).max(1)
    }

    fn lattice_triangle_count(grid: u32) -> u64 {
        12 + 24 * (grid as u64) * (grid as u64)
    }

    /// Triangle `t` (0..12) of an axis-aligned box, in a fixed order.
    fn box_tri(min: [f32; 3], max: [f32; 3], t: u64) -> [[f32; 3]; 3] {
        let [x0, y0, z0] = min;
        let [x1, y1, z1] = max;
        match t {
            0 => [[x0, y0, z0], [x1, y1, z0], [x1, y0, z0]],
            1 => [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
            2 => [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1]],
            3 => [[x0, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            4 => [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1]],
            5 => [[x0, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            6 => [[x0, y1, z0], [x1, y1, z1], [x1, y1, z0]],
            7 => [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
            8 => [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
            9 => [[x0, y0, z0], [x0, y1, z1], [x0, y1, z0]],
            10 => [[x1, y0, z0], [x1, y1, z1], [x1, y0, z1]],
            _ => [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
        }
    }

    /// (strut box, tip box) for grid cell (i, j), as (min, max) pairs.
    fn lattice_cell_boxes(grid: u32, i: u32, j: u32) -> ([[f32; 3]; 2], [[f32; 3]; 2]) {
        let pitch = LATTICE_PLATE_MM / grid as f32;
        let cx = LATTICE_ORIGIN_MM[0] + (i as f32 + 0.5) * pitch;
        let cy = LATTICE_ORIGIN_MM[1] + (j as f32 + 0.5) * pitch;
        let slab_top = LATTICE_ORIGIN_MM[2] + LATTICE_SLAB_MM;
        // Deterministic height variation, 3.0–4.4 mm in 0.35 mm steps.
        let h = 3.0 + 0.35 * ((i as u64 * 31 + j as u64 * 17) % 5) as f32;
        let hw = 0.2 * pitch; // strut half-width
        let tw = 0.275 * pitch; // tip half-width (slightly wider, like a contact tip)
        let strut = [
            [cx - hw, cy - hw, slab_top],
            [cx + hw, cy + hw, slab_top + h],
        ];
        let tip_z0 = slab_top + h + LATTICE_TIP_GAP_MM;
        let tip = [
            [cx - tw, cy - tw, tip_z0],
            [cx + tw, cy + tw, tip_z0 + LATTICE_TIP_HEIGHT_MM],
        ];
        (strut, tip)
    }

    /// Triangle `index` (0..lattice_triangle_count(grid)) of the lattice, in
    /// raw-file (off-origin) coordinates. Single source of truth for both the
    /// STL writer and R2's sampled-vertex reprojection reference.
    fn lattice_triangle(grid: u32, index: u64) -> [[f32; 3]; 3] {
        if index < 12 {
            let slab_min = LATTICE_ORIGIN_MM;
            let slab_max = [
                LATTICE_ORIGIN_MM[0] + LATTICE_PLATE_MM,
                LATTICE_ORIGIN_MM[1] + LATTICE_PLATE_MM,
                LATTICE_ORIGIN_MM[2] + LATTICE_SLAB_MM,
            ];
            return box_tri(slab_min, slab_max, index);
        }
        let k = index - 12;
        let cell = k / 24;
        let within = k % 24;
        let i = (cell / grid as u64) as u32;
        let j = (cell % grid as u64) as u32;
        let (strut, tip) = lattice_cell_boxes(grid, i, j);
        if within < 12 {
            box_tri(strut[0], strut[1], within)
        } else {
            box_tri(tip[0], tip[1], within - 12)
        }
    }

    /// Streams the lattice to `path` as a binary STL (zeroed normals — every
    /// DragonFruit reader derives normals from vertices). Returns the
    /// triangle count written. Never materializes the soup in memory.
    fn write_lattice_stl(path: &Path, grid: u32) -> std::io::Result<u64> {
        let total = lattice_triangle_count(grid);
        assert!(u32::try_from(total).is_ok(), "triangle count exceeds STL u32");
        let file = std::fs::File::create(path)?;
        let mut out = BufWriter::with_capacity(8 * 1024 * 1024, file);
        out.write_all(&[0u8; 80])?;
        out.write_all(&(total as u32).to_le_bytes())?;
        let mut record = [0u8; 50];
        for index in 0..total {
            let tri = lattice_triangle(grid, index);
            let mut at = 12;
            for vertex in tri {
                for component in vertex {
                    record[at..at + 4].copy_from_slice(&component.to_le_bytes());
                    at += 4;
                }
            }
            out.write_all(&record)?;
            record[12..48].fill(0);
        }
        out.flush()?;
        Ok(total)
    }

    /// Resolve (and lazily generate) a cached lattice STL of ~`target`
    /// triangles under the OS temp dir. Reused across runs when the on-disk
    /// size matches; the repo temp sweeper only matches `dragonfruit-slice-*`,
    /// so these survive until manually deleted.
    fn ensure_lattice_stl(label: &str, target_triangles: u64) -> (PathBuf, u32, u64) {
        // Several un-ignored P1 tests share the cached 8M asset and may run
        // concurrently on the test threadpool — serialize the check+generate
        // so a half-written file is never picked up as reusable.
        static LATTICE_GEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LATTICE_GEN_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let grid = lattice_grid_for_target(target_triangles);
        let total = lattice_triangle_count(grid);
        let expected_bytes = 84 + 50 * total;
        let path = match std::env::var("DRAGONFRUIT_LATTICE_STL_PATH") {
            Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => std::env::temp_dir().join(format!("dragonfruit-p0c-lattice-{label}.stl")),
        };
        let reusable = std::fs::metadata(&path)
            .map(|m| m.len() == expected_bytes)
            .unwrap_or(false);
        if !reusable {
            let started = Instant::now();
            let written = write_lattice_stl(&path, grid).expect("write lattice STL");
            eprintln!(
                "[p0c] generated {} ({} triangles, {:.1} MB) in {:.2}s",
                path.display(),
                written,
                expected_bytes as f64 / 1_048_576.0,
                started.elapsed().as_secs_f64(),
            );
        } else {
            eprintln!("[p0c] reusing cached {}", path.display());
        }
        (path, grid, total)
    }

    // --- Deliverable 1: asset generator (env-driven) ----------------------

    /// Writes an off-origin lattice STL for manual/e2e verification.
    /// Invocation (from `src-tauri/`):
    ///
    /// ```text
    /// DRAGONFRUIT_LATTICE_STL_OUT=%TEMP%/plate-8m.stl \
    /// DRAGONFRUIT_LATTICE_STL_TRIS=8000000 \
    ///   cargo test generate_offorigin_lattice_stl_asset -- --ignored --nocapture
    /// ```
    ///
    /// Defaults: ~8M triangles into `%TEMP%/dragonfruit-p0c-lattice-8m.stl`.
    /// The ASSET is never committed (plan §C.4) — only this generator is.
    #[test]
    #[ignore = "P0 asset generator — run explicitly with --ignored --nocapture"]
    fn generate_offorigin_lattice_stl_asset() {
        let target: u64 = std::env::var("DRAGONFRUIT_LATTICE_STL_TRIS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8_000_000);
        let grid = lattice_grid_for_target(target);
        let total = lattice_triangle_count(grid);
        let path = match std::env::var("DRAGONFRUIT_LATTICE_STL_OUT") {
            Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => std::env::temp_dir().join(format!(
                "dragonfruit-p0c-lattice-{}m.stl",
                (target as f64 / 1_000_000.0).round() as u64
            )),
        };
        let started = Instant::now();
        let written = write_lattice_stl(&path, grid).expect("write lattice STL");
        assert_eq!(written, total);
        eprintln!(
            "[p0c] wrote {} — {} triangles (grid {}×{}), {:.1} MB, {:.2}s",
            path.display(),
            written,
            grid,
            grid,
            (84 + 50 * written) as f64 / 1_048_576.0,
            started.elapsed().as_secs_f64(),
        );
    }

    /// Harness self-check (fast, green): determinism, exact off-origin bbox
    /// min, and count arithmetic. Ignored only to keep the pinned baseline
    /// count (8 passed / 1 ignored) unchanged during the P0 window.
    #[test]
    #[ignore = "P0 harness self-check — run explicitly with --ignored"]
    fn lattice_generator_is_deterministic_and_off_origin() {
        let grid = lattice_grid_for_target(30_000);
        assert_eq!(grid, 35);
        let total = lattice_triangle_count(grid);
        assert_eq!(total, 12 + 24 * 35 * 35); // 29_412

        let dir = std::env::temp_dir();
        let path_a = dir.join(format!("dragonfruit-p0c-selfcheck-a-{}.stl", std::process::id()));
        let path_b = dir.join(format!("dragonfruit-p0c-selfcheck-b-{}.stl", std::process::id()));
        assert_eq!(write_lattice_stl(&path_a, grid).unwrap(), total);
        assert_eq!(write_lattice_stl(&path_b, grid).unwrap(), total);
        let bytes_a = std::fs::read(&path_a).unwrap();
        let bytes_b = std::fs::read(&path_b).unwrap();
        assert_eq!(bytes_a.len() as u64, 84 + 50 * total);
        assert!(bytes_a == bytes_b, "generator must be byte-deterministic");

        // Off-origin guarantee: bbox min EXACTLY at (40, 25, 0).
        let (min, max) = binary_stl_bounds(&path_a, total as u32).unwrap();
        assert_eq!((min.x, min.y, min.z), (40.0, 25.0, 0.0));
        assert_eq!((max.x, max.y), (160.0, 145.0));
        // Tallest strut variant: 1.0 slab + 4.4 strut + 0.06 gap + 0.3 tip.
        assert!((max.z - 5.76).abs() < 1e-4, "max.z = {}", max.z);

        std::fs::remove_file(&path_a).ok();
        std::fs::remove_file(&path_b).ok();
    }

    // --- Deliverable 1: §D9 import wall-time baseline ---------------------

    /// Times the native import core for a >6M binary STL — exactly the code
    /// `load_stl_file` runs for oversized files: `binary_stl_bounds` (bounds
    /// pass) + `load_binary_stl_preview` bucketing + per-region weld +
    /// meshopt simplify (`load_binary_stl_preview` calls the bounds pass
    /// internally, so one call covers the full core). Feeds the plan §D9
    /// gate: Phase-1 import wall-time must stay within +10% of this number.
    ///
    /// ```text
    /// cargo test import_core_wall_time_baseline_12m -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "P0 §D9 wall-time baseline — run explicitly with --ignored --nocapture"]
    fn import_core_wall_time_baseline_12m_lattice() {
        let (path, _grid, total) = ensure_lattice_stl("12m", 12_000_000);
        assert!(total > P0C_PREVIEW_GATE_TRIANGLES, "asset must take the >6M preview path");

        let started = Instant::now();
        let preview = load_binary_stl_preview(&path, total as u32, 2_000_000)
            .expect("import core (bounds + bucket + simplify)");
        let elapsed = started.elapsed();
        eprintln!(
            "[p0c][D9-baseline] import core: {} -> {} triangles in {:.3}s ({})",
            total,
            preview.triangles.len(),
            elapsed.as_secs_f64(),
            path.display(),
        );
        assert!(!preview.triangles.is_empty());
    }

    // --- Deliverable 2: R2 — the full-res splice contract (DEFERRED RED) --

    /// The Phase-1 splice contract (decision memo §4.3 / plan Phase 1):
    /// stream the ORIGINAL STL from `sourcePath` Rust-side and stage
    /// `w = M · (v_raw − C_pre)` where `M = T·R·S` (the scene transform,
    /// applied scale-first exactly as the WebView bake composes it) and
    /// `C_pre` is the STORED import-time pre-centering bbox center — supplied
    /// by the caller, NEVER recomputed from the full mesh (the islands
    /// sideload's frame bug — memo §2.3 — came from substituting a scene-side
    /// center; do not copy its datum).
    struct FullResSpliceRequest<'a> {
        source_stl: &'a Path,
        /// Import-time pre-centering bbox center, raw-file frame (memo §2.2).
        c_pre: [f64; 3],
        translation: [f64; 3],
        rotation_quat_xyzw: [f64; 4],
        scale: [f64; 3],
        /// Triangle indices (raw-file order) whose world-space vertices the
        /// splice must report back for verification.
        sample_triangle_indices: &'a [u64],
    }

    struct FullResSpliceOutcome {
        /// Triangles staged for the slicer — must equal the SOURCE count.
        staged_triangle_count: u64,
        /// World-space vertices of the sampled triangles, captured BEFORE
        /// transport encoding (quantized_u16 adds ~2–3 µm, far above this
        /// contract's 1e-4 mm tolerance; quantization is covered by Phase 1's
        /// separate frame-delta test).
        sampled_world_triangles: Vec<[[f32; 3]; 3]>,
    }

    type FullResSplice = fn(&FullResSpliceRequest) -> Result<FullResSpliceOutcome, String>;

    /// Column-major `M = T·R·S` (THREE.Matrix4.elements order) from the
    /// decomposed transform R2 supplies — the same composition the WebView
    /// bake performs (`composeModelMatrix`, rasterLayerZipExport.ts).
    fn matrix16_col_major_from_trs(
        translation: [f64; 3],
        quat_xyzw: [f64; 4],
        scale: [f64; 3],
    ) -> [f64; 16] {
        let [qx, qy, qz, qw] = quat_xyzw;
        let (xx, yy, zz) = (qx * qx, qy * qy, qz * qz);
        let (xy, xz, yz) = (qx * qy, qx * qz, qy * qz);
        let (wx, wy, wz) = (qw * qx, qw * qy, qw * qz);
        // Rotation columns (column-major).
        let r0 = [1.0 - 2.0 * (yy + zz), 2.0 * (xy + wz), 2.0 * (xz - wy)];
        let r1 = [2.0 * (xy - wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz + wx)];
        let r2 = [2.0 * (xz + wy), 2.0 * (yz - wx), 1.0 - 2.0 * (xx + yy)];
        [
            r0[0] * scale[0], r0[1] * scale[0], r0[2] * scale[0], 0.0,
            r1[0] * scale[1], r1[1] * scale[1], r1[2] * scale[1], 0.0,
            r2[0] * scale[2], r2[1] * scale[2], r2[2] * scale[2], 0.0,
            translation[0], translation[1], translation[2], 1.0,
        ]
    }

    /// Phase 1 wiring (landed): routes the contract test through the
    /// PRODUCTION splice core — `splice_fullres_stl_stream` feeding the
    /// production u16 staging quantizer, exactly the pipeline
    /// `stage_fullres_mesh_from_source` runs. The staged triangle count is
    /// measured from the bytes the production sink encoding actually emitted
    /// (18 bytes per staged quantized triangle), never trusted from the
    /// source header. Sampled vertices are captured at the stream's
    /// pre-quantization seam, matching the R2 contract's own documented
    /// terms: its 1e-4 mm tolerance was specified PRE-quantization
    /// (quantized-u16 transport adds ~2-3 µm, covered by the separate
    /// Phase-1 frame-delta test).
    fn phase1_fullres_splice() -> Option<FullResSplice> {
        Some(|request| {
            let matrix16 = matrix16_col_major_from_trs(
                request.translation,
                request.rotation_quat_xyzw,
                request.scale,
            );
            let params = FullResSpliceParams {
                source_path: request.source_stl,
                matrix16_col_major: matrix16,
                c_pre: request.c_pre,
                expected_fingerprint: None,
                flip_winding_on_negative_determinant: true,
            };
            // Build-volume-style transport bounds generously covering the
            // transformed lattice (bounds correctness itself is exercised by
            // the quantizer-parity + frame-delta tests).
            let bounds = FullResQuantizationBounds {
                min_x: -300.0,
                min_y: -300.0,
                min_z: -300.0,
                max_x: 300.0,
                max_y: 300.0,
                max_z: 300.0,
            };
            let mut sampled: Vec<[[f32; 3]; 3]> = Vec::new();
            let mut staged_bytes: u64 = 0;
            let mut scratch: Vec<u8> = Vec::new();
            let stats = splice_fullres_stl_stream(
                &params,
                request.sample_triangle_indices,
                |_, world| sampled.push(world),
                |floats| {
                    scratch.clear();
                    quantize_world_floats_to_u16_bytes(floats, &bounds, &mut scratch);
                    staged_bytes += scratch.len() as u64;
                    Ok(())
                },
            )?;
            assert_eq!(staged_bytes % 18, 0, "staged bytes must be whole u16 triangles");
            let staged_triangle_count = staged_bytes / 18;
            assert_eq!(
                staged_triangle_count, stats.triangle_count,
                "sink-measured staged count must match the stream's triangle count",
            );
            Ok(FullResSpliceOutcome {
                staged_triangle_count,
                sampled_world_triangles: sampled,
            })
        })
    }

    fn rotate_quat_f64(v: [f64; 3], q: [f64; 4]) -> [f64; 3] {
        let [qx, qy, qz, qw] = q;
        let t = [
            2.0 * (qy * v[2] - qz * v[1]),
            2.0 * (qz * v[0] - qx * v[2]),
            2.0 * (qx * v[1] - qy * v[0]),
        ];
        [
            v[0] + qw * t[0] + (qy * t[2] - qz * t[1]),
            v[1] + qw * t[1] + (qz * t[0] - qx * t[2]),
            v[2] + qw * t[2] + (qx * t[1] - qy * t[0]),
        ]
    }

    /// f64 reference reprojection: `w = T + R·(S·(v_raw − C_pre))`.
    fn expected_world(
        v_raw: [f32; 3],
        c_pre: [f64; 3],
        translation: [f64; 3],
        quat: [f64; 4],
        scale: [f64; 3],
    ) -> [f64; 3] {
        let local = [
            (v_raw[0] as f64 - c_pre[0]) * scale[0],
            (v_raw[1] as f64 - c_pre[1]) * scale[1],
            (v_raw[2] as f64 - c_pre[2]) * scale[2],
        ];
        let rotated = rotate_quat_f64(local, quat);
        [
            rotated[0] + translation[0],
            rotated[1] + translation[1],
            rotated[2] + translation[2],
        ]
    }

    /// R2 — given the generated OFF-ORIGIN ~8M lattice + a scene transform +
    /// C_pre, the staged output must carry the ORIGINAL triangle count (not
    /// the ~2M preview) and sampled vertices must land on
    /// `M · (v_raw − C_pre)` within 1e-4 mm (pre-quantization).
    ///
    /// Red run captured at Phase-1 start with the stub unwired (panic at the
    /// deferred-red marker, orchestrator-recorded); GREEN as of the Phase-1
    /// wiring above. Un-ignored: this is now a standing contract test for the
    /// production splice core (it lazily generates/reuses the cached ~8M
    /// lattice asset in %TEMP% on first run).
    #[test]
    fn r2_fullres_splice_preserves_count_and_reprojects_within_100nm() {
        let splice = match phase1_fullres_splice() {
            Some(f) => f,
            None => panic!(
                "RED (deferred): Phase 1 has not landed the full-res splice command; \
                 wire it into phase1_fullres_splice() and capture this test's red run \
                 before implementing (plan §D1)"
            ),
        };

        let (path, grid, total) = ensure_lattice_stl("8m", 8_000_000);
        assert!(total > P0C_PREVIEW_GATE_TRIANGLES, "asset must take the >6M preview path");

        // Analytic full-lattice bbox center, standing in for the STORED
        // import-time C_pre (x: 40..160, y: 25..145, z: 0..5.76). In
        // production this value comes from the persisted import datum — the
        // contract is parametric in C_pre, and the splice must apply exactly
        // the value it is handed.
        let c_pre = [100.0, 85.0, 2.88];
        // Non-trivial scene transform: rotation 30° about Z, non-uniform
        // scale (applied BEFORE rotation, matching the WebView bake), and a
        // translation — chosen to catch composition-order and frame bugs.
        let half_angle = 30.0_f64.to_radians() / 2.0;
        let quat = [0.0, 0.0, half_angle.sin(), half_angle.cos()];
        let scale = [1.25, 1.0, 0.8];
        let translation = [10.0, -4.0, 2.5];

        let samples = [0u64, total / 2, total - 1];
        let outcome = splice(&FullResSpliceRequest {
            source_stl: &path,
            c_pre,
            translation,
            rotation_quat_xyzw: quat,
            scale,
            sample_triangle_indices: &samples,
        })
        .expect("full-res splice");

        assert_eq!(
            outcome.staged_triangle_count, total,
            "staged output must carry the ORIGINAL triangle count ({total}), \
             not a decimated preview",
        );

        assert_eq!(outcome.sampled_world_triangles.len(), samples.len());
        for (sample_index, &tri_index) in samples.iter().enumerate() {
            let raw = lattice_triangle(grid, tri_index);
            let staged = outcome.sampled_world_triangles[sample_index];
            for (vertex_index, &v_raw) in raw.iter().enumerate() {
                let want = expected_world(v_raw, c_pre, translation, quat, scale);
                let got = staged[vertex_index];
                let distance = ((got[0] as f64 - want[0]).powi(2)
                    + (got[1] as f64 - want[1]).powi(2)
                    + (got[2] as f64 - want[2]).powi(2))
                .sqrt();
                assert!(
                    distance <= 1e-4,
                    "triangle {tri_index} vertex {vertex_index}: staged {got:?} is \
                     {distance:.6} mm from M·(v_raw − C_pre) = {want:?} (tolerance 1e-4 mm) \
                     — frame reproduction is broken (memo §2.2/§2.3)",
                );
            }
        }
    }

    // --- Phase 1: golden encoding parity ---------------------------------

    /// The Rust splice quantizer must be byte-compatible with the WebView
    /// transport quantizer (`quantizeMeshChunkToUint16`,
    /// sliceExportOrchestrator.ts): f64 normalize → clamp 0..1 → round ×
    /// 65535, u16 LE. Expected values below are the JS formula evaluated by
    /// hand, including the half-way rounding case (JS `Math.round(32767.5)`
    /// = 32768; after the clamp all inputs are non-negative, so Rust's
    /// round-half-away-from-zero agrees). This pins the SPLICED path's
    /// staged bytes to what the scene-geometry path would have produced for
    /// identical world floats.
    #[test]
    fn p1_splice_quantizer_matches_webview_transport_encoding() {
        let bounds = FullResQuantizationBounds {
            min_x: -100.0,
            min_y: -50.0,
            min_z: 0.0,
            max_x: 100.0,
            max_y: 50.0,
            max_z: 200.0,
        };
        let floats: [f32; 12] = [
            -100.0, -50.0, 0.0, // exact minimums → 0
            100.0, 50.0, 200.0, // exact maximums → 65535
            0.0, 0.0, 100.0, // exact mid-spans → the 32767.5 rounding case
            -150.0, 75.0, 250.0, // out-of-bounds → clamped
        ];
        let mut out = Vec::new();
        quantize_world_floats_to_u16_bytes(&floats, &bounds, &mut out);
        let quantized: Vec<u16> = out
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(
            quantized,
            vec![0, 0, 0, 65535, 65535, 65535, 32768, 32768, 32768, 0, 65535, 65535],
        );

        // Degenerate span → 0 (same as the JS guard).
        let degenerate = FullResQuantizationBounds {
            min_x: 5.0,
            min_y: 0.0,
            min_z: 0.0,
            max_x: 5.0,
            max_y: 1.0,
            max_z: 1.0,
        };
        let mut degenerate_out = Vec::new();
        quantize_world_floats_to_u16_bytes(&[5.0, 0.5, 0.5], &degenerate, &mut degenerate_out);
        assert_eq!(degenerate_out[0..2], [0, 0]);
    }

    // --- Phase 1: frame-delta test (spliced vs preview-path bounds) ------

    /// Records the world-space bounds delta between the full-res spliced
    /// staging and the preview path on the off-origin 8M lattice, under the
    /// same non-trivial transform and the SAME stored C_pre datum (the
    /// preview bbox center — the value the scene actually uses). Invariant
    /// asserted: meshopt keeps a subset of original vertices, so the preview
    /// world bounds must be contained in the spliced full-res world bounds
    /// (within f32 tolerance). The recorded deltas feed the Phase-4 punch
    /// `centerNorm` migration.
    #[test]
    fn p1_frame_delta_spliced_bounds_contain_preview_bounds() {
        let (path, _grid, total) = ensure_lattice_stl("8m", 8_000_000);
        assert!(total > P0C_PREVIEW_GATE_TRIANGLES);

        // Preview path: exactly the import core `load_stl_file` runs.
        let preview = load_binary_stl_preview(&path, total as u32, 2_000_000)
            .expect("preview import core");

        // The stored import datum: the preview's own pre-centering bbox
        // center (what processGeometry measures and Phase 1 persists).
        let mut raw_min = [f64::INFINITY; 3];
        let mut raw_max = [f64::NEG_INFINITY; 3];
        for position in &preview.positions {
            for (axis, value) in [position.x, position.y, position.z].into_iter().enumerate() {
                let value = value as f64;
                if value < raw_min[axis] {
                    raw_min[axis] = value;
                }
                if value > raw_max[axis] {
                    raw_max[axis] = value;
                }
            }
        }
        let c_pre = [
            (raw_min[0] + raw_max[0]) * 0.5,
            (raw_min[1] + raw_max[1]) * 0.5,
            (raw_min[2] + raw_max[2]) * 0.5,
        ];

        // Same non-trivial transform as R2.
        let half_angle = 30.0_f64.to_radians() / 2.0;
        let quat = [0.0, 0.0, half_angle.sin(), half_angle.cos()];
        let scale = [1.25, 1.0, 0.8];
        let translation = [10.0, -4.0, 2.5];
        let matrix16 = matrix16_col_major_from_trs(translation, quat, scale);

        // Preview-path world bounds: transform every preview vertex with the
        // same formula the bake applies.
        let transform_vertex = |v: [f32; 3]| -> [f32; 3] {
            let x = v[0] as f64 - c_pre[0];
            let y = v[1] as f64 - c_pre[1];
            let z = v[2] as f64 - c_pre[2];
            let m = &matrix16;
            [
                (m[0] * x + m[4] * y + m[8] * z + m[12]) as f32,
                (m[1] * x + m[5] * y + m[9] * z + m[13]) as f32,
                (m[2] * x + m[6] * y + m[10] * z + m[14]) as f32,
            ]
        };
        let mut preview_min = [f32::INFINITY; 3];
        let mut preview_max = [f32::NEG_INFINITY; 3];
        for position in &preview.positions {
            let world = transform_vertex([position.x, position.y, position.z]);
            for axis in 0..3 {
                if world[axis] < preview_min[axis] {
                    preview_min[axis] = world[axis];
                }
                if world[axis] > preview_max[axis] {
                    preview_max[axis] = world[axis];
                }
            }
        }
        drop(preview);

        // Spliced path: the production streaming core, same datum.
        let params = FullResSpliceParams {
            source_path: &path,
            matrix16_col_major: matrix16,
            c_pre,
            expected_fingerprint: None,
            flip_winding_on_negative_determinant: true,
        };
        let stats = splice_fullres_stl_stream(&params, &[], |_, _| {}, |_| Ok(()))
            .expect("full-res splice stream");
        assert_eq!(stats.triangle_count, total);

        // Containment invariant (subset-of-vertices ⇒ subset-of-bounds).
        const EPS: f32 = 1e-3;
        for axis in 0..3 {
            assert!(
                stats.world_min[axis] <= preview_min[axis] + EPS,
                "axis {axis}: spliced min {} must not exceed preview min {}",
                stats.world_min[axis],
                preview_min[axis],
            );
            assert!(
                stats.world_max[axis] >= preview_max[axis] - EPS,
                "axis {axis}: spliced max {} must not fall below preview max {}",
                stats.world_max[axis],
                preview_max[axis],
            );
        }

        // Recorded deltas (run with --nocapture to view; quoted in the P1
        // AAR and consumed by the Phase-4 punch-migration design).
        let center = |min: &[f32; 3], max: &[f32; 3], axis: usize| {
            (min[axis] as f64 + max[axis] as f64) * 0.5
        };
        let extent =
            |min: &[f32; 3], max: &[f32; 3], axis: usize| max[axis] as f64 - min[axis] as f64;
        eprintln!("[p1][frame-delta] spliced-vs-preview world bounds on the 8M lattice:");
        for (axis, label) in ["x", "y", "z"].iter().enumerate() {
            eprintln!(
                "[p1][frame-delta]   {label}: center Δ {:+.6} mm, extent Δ {:+.6} mm (spliced {:.6}..{:.6}, preview {:.6}..{:.6})",
                center(&stats.world_min, &stats.world_max, axis)
                    - center(&preview_min, &preview_max, axis),
                extent(&stats.world_min, &stats.world_max, axis)
                    - extent(&preview_min, &preview_max, axis),
                stats.world_min[axis],
                stats.world_max[axis],
                preview_min[axis],
                preview_max[axis],
            );
        }
        eprintln!(
            "[p1][frame-delta]   z-range: spliced {:.6}..{:.6} vs preview {:.6}..{:.6} (top Δ {:+.6} mm)",
            stats.world_min[2],
            stats.world_max[2],
            preview_min[2],
            preview_max[2],
            stats.world_max[2] as f64 - preview_max[2] as f64,
        );
    }

    // --- Phase 1: splice wall-time measurement ----------------------------

    /// Measures the full production splice cost (streaming re-read +
    /// reprojection + u16 staging quantization) on the 12M asset — the
    /// output-time price of Option A. Companion to the §D9 import baseline.
    ///
    /// ```text
    /// cargo test p1_splice_wall_time_12m -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "P1 splice wall-time measurement — run explicitly with --ignored --nocapture"]
    fn p1_splice_wall_time_12m_lattice() {
        let (path, _grid, total) = ensure_lattice_stl("12m", 12_000_000);
        let c_pre = [100.0, 85.0, 2.88];
        let matrix16 = matrix16_col_major_from_trs(
            [0.0, 0.0, 2.88],
            [0.0, 0.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
        );
        let bounds = FullResQuantizationBounds {
            min_x: -100.0,
            min_y: -100.0,
            min_z: 0.0,
            max_x: 100.0,
            max_y: 100.0,
            max_z: 150.0,
        };
        let params = FullResSpliceParams {
            source_path: &path,
            matrix16_col_major: matrix16,
            c_pre,
            expected_fingerprint: None,
            flip_winding_on_negative_determinant: true,
        };
        let mut staged_bytes = 0u64;
        let mut scratch: Vec<u8> = Vec::new();
        let started = Instant::now();
        let stats = splice_fullres_stl_stream(
            &params,
            &[],
            |_, _| {},
            |floats| {
                scratch.clear();
                quantize_world_floats_to_u16_bytes(floats, &bounds, &mut scratch);
                staged_bytes += scratch.len() as u64;
                Ok(())
            },
        )
        .expect("12M splice");
        let elapsed = started.elapsed();
        assert_eq!(stats.triangle_count, total);
        eprintln!(
            "[p1][splice-wall-time] {} triangles ({:.1} MB staged) in {:.3}s",
            total,
            staged_bytes as f64 / 1_048_576.0,
            elapsed.as_secs_f64(),
        );
    }

    // --- Phase 1: structural floor test ----------------------------------

    /// End-to-end structural assert for the reported defect class: splice
    /// the 8M off-origin lattice through the PRODUCTION path (streaming
    /// re-read → reproject → u16 staging encoding), decode the staged bytes
    /// exactly as the engine transport does, and rasterize the floor-contact
    /// layer with the real slicing engine. Every support column must have
    /// nonzero floor pixels beneath it (the generator knows its column
    /// positions).
    #[test]
    fn p1_floor_contact_layer_covers_support_columns_after_splice() {
        let (path, grid, total) = ensure_lattice_stl("8m", 8_000_000);

        // Scene-style placement: bottom on the plate (world z = raw z), XY
        // centered on the build plate.
        let c_pre = [100.0, 85.0, 2.88];
        let translation = [0.0, 0.0, 2.88];
        let matrix16 =
            matrix16_col_major_from_trs(translation, [0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0]);
        let bounds = FullResQuantizationBounds {
            min_x: -100.0,
            min_y: -100.0,
            min_z: 0.0,
            max_x: 100.0,
            max_y: 100.0,
            max_z: 150.0,
        };

        // Splice through the production stream + staging quantizer.
        let params = FullResSpliceParams {
            source_path: &path,
            matrix16_col_major: matrix16,
            c_pre,
            expected_fingerprint: None,
            flip_winding_on_negative_determinant: true,
        };
        let mut staged: Vec<u8> = Vec::with_capacity((total as usize) * 18);
        let mut scratch: Vec<u8> = Vec::new();
        let stats = splice_fullres_stl_stream(
            &params,
            &[],
            |_, _| {},
            |floats| {
                scratch.clear();
                quantize_world_floats_to_u16_bytes(floats, &bounds, &mut scratch);
                staged.extend_from_slice(&scratch);
                Ok(())
            },
        )
        .expect("full-res splice stream");
        assert_eq!(stats.triangle_count, total);
        assert_eq!(staged.len() as u64, total * 18);

        // Decode the staged u16 stream the way the engine transport does.
        let mins = [bounds.min_x as f64, bounds.min_y as f64, bounds.min_z as f64];
        let spans = [
            (bounds.max_x - bounds.min_x) as f64,
            (bounds.max_y - bounds.min_y) as f64,
            (bounds.max_z - bounds.min_z) as f64,
        ];
        let mut world_floats: Vec<f32> = Vec::with_capacity((total as usize) * 9);
        for (index, pair) in staged.chunks_exact(2).enumerate() {
            let axis = index % 3;
            let q = u16::from_le_bytes([pair[0], pair[1]]) as f64;
            world_floats.push((mins[axis] + (q / 65_535.0) * spans[axis]) as f32);
        }
        drop(staged);

        let mut triangles = dragonfruit_slicing_engine::geometry::parse_triangles(&world_floats);
        drop(world_floats);

        let job: dragonfruit_slicing_engine::SliceJobV3 = serde_json::from_value(serde_json::json!({
            "output_format": ".png",
            "source_width_px": 2000u32,
            "source_height_px": 2000u32,
            "width_px": 2000u32,
            "height_px": 2000u32,
            "build_width_mm": 200.0f32,
            "build_depth_mm": 200.0f32,
            "layer_height_mm": 0.05f32,
            "total_layers": 120u32,
            "model_triangle_count": total as u32,
            // Parsed-triangle input is passed to the rasterizer directly;
            // the job's own flat soup is unused here but non-optional.
            "triangles_xyz": Vec::<f32>::new(),
            "metadata_json": "{}",
        }))
        .expect("floor-test slice job");
        dragonfruit_slicing_engine::geometry::project_triangles_inplace(&mut triangles, &job);

        // Floor-contact layer: z = 0.025 mm (layer 0), inside the 1 mm slab.
        let layer_z = 0.5_f32 * 0.05;
        let layer_indices: Vec<usize> = triangles
            .iter()
            .enumerate()
            .filter(|(_, tri)| tri.z_min <= layer_z && layer_z <= tri.z_max)
            .map(|(index, _)| index)
            .collect();
        assert!(!layer_indices.is_empty(), "floor layer must have candidate triangles");

        let mask =
            dragonfruit_slicing_engine::raster::rasterize_layer(&job, &triangles, &layer_indices, 0);
        let width = job.effective_render_width_px() as usize;
        let height = job.source_height_px as usize;
        assert_eq!(mask.len(), width * height);

        // World mm → pixel, mirroring project_triangles_inplace (no mirror).
        let to_px = |x_mm: f32, y_mm: f32| -> (usize, usize) {
            let tx = (x_mm + 100.0) / 200.0;
            let ty = (y_mm + 100.0) / 200.0;
            let px = (tx * (width as f32 - 1.0)).round().clamp(0.0, width as f32 - 1.0) as usize;
            let py = ((1.0 - ty) * (height as f32 - 1.0))
                .round()
                .clamp(0.0, height as f32 - 1.0) as usize;
            (px, py)
        };

        // Every sampled support column must have floor pixels beneath it.
        let stride = (grid / 24).max(1);
        let mut checked = 0usize;
        for i in (0..grid).step_by(stride as usize) {
            for j in (0..grid).step_by(stride as usize) {
                let (strut, _tip) = lattice_cell_boxes(grid, i, j);
                let cx = (strut[0][0] + strut[1][0]) * 0.5 - 100.0;
                let cy = (strut[0][1] + strut[1][1]) * 0.5 - 85.0;
                let (px, py) = to_px(cx, cy);
                assert!(
                    mask[py * width + px] > 0,
                    "floor-contact layer has NO pixels under support column ({i},{j}) at world ({cx:.3},{cy:.3}) — the import-decimation defect signature",
                );
                checked += 1;
            }
        }
        assert!(checked >= 4, "column sampling must cover the plate");

        // Sanity: outside the plate stays void.
        let (out_px, out_py) = to_px(-90.0, -90.0);
        assert_eq!(mask[out_py * width + out_px], 0, "pixels outside the plate must stay void");

        let nonzero = mask.iter().filter(|value| **value > 0).count();
        eprintln!(
            "[p1][floor-test] {checked} sampled support columns all have floor coverage; nonzero floor pixels: {nonzero}",
        );
    }

    // --- Phase 2a: no-cliff + query-first decimation ----------------------
    //
    // The no-cliff contract (plan Phase 2 step 2): a mesh just OVER budget
    // must lose ≈0 triangles — reduction ratio near 1.0 at the boundary, no
    // 3× fidelity discontinuity. RED (captured 2026-07-19, orchestrator log):
    //   [p2a][no-cliff][RED] source 6048108 → 3590720 tris (budget 6000000,
    //   ratio-to-budget 0.598) — the legacy fixed 2M gate slashes a mesh a
    //   hair over 6M to 3.59M; assert ≥ 0.9 × budget FAILED.
    // GREEN below routes the same asset through the governor-budget query-first
    // decimator, which keeps it at ~budget. These tests lazily generate a
    // ~302 MB asset and run meshopt, so they are `#[ignore]` (heavy-asset
    // convention, like the §D9 baseline); run explicitly:
    //   cargo test p2a_ -- --ignored --nocapture

    /// GREEN: a ~6.05M mesh (just over budget) stays near-verbatim under the
    /// query-first decimator — the fixed-2M cliff is dead.
    #[test]
    #[ignore = "P2a heavy asset — run with --ignored --nocapture"]
    fn p2a_no_cliff_mesh_just_over_budget_stays_near_verbatim() {
        let (path, _grid, total) = ensure_lattice_stl("6p05m", 6_050_000);
        assert!(
            total > 6_000_000,
            "asset must sit just over the legacy 6M gate ({total})"
        );

        // Budget just BELOW the source, so the source is "just over budget".
        let budget: usize = (total as usize) - 200_000;
        let outcome = decimate_binary_stl_to_budget(&path, total as u32, budget)
            .expect("query-first budget decimation");
        let output = outcome.mesh.triangles.len();

        let ratio = output as f64 / budget as f64;
        eprintln!(
            "[p2a][no-cliff][GREEN] source {total} → {output} tris (budget {budget}, \
             ratio-to-budget {ratio:.3}, achieved_error {:.6})",
            outcome.achieved_error,
        );
        // meshopt never reduces BELOW the count target, so a correct policy
        // lands at ≥ budget; the legacy 2M cliff landed at ~0.6 × budget.
        assert!(
            output as f64 >= budget as f64 * 0.9,
            "no-cliff: a mesh just over budget dropped to {output} (< 0.9 × budget \
             {budget}) — the fixed-gate cliff must stay dead"
        );
    }

    /// Query-first on collapsible bulk: at a small budget the whole-mesh
    /// simplify reaches the COUNT target (the lattice's slab/pad surfaces
    /// collapse cheaply) while the tight error bound keeps the strut/tip
    /// structure — output lands AT budget with achieved_error well under the
    /// tight bound. (This is the effective-simplify case; the error-bound-binds
    /// branch is exercised deterministically by the synthetic test below.
    /// Note: the whole-mesh call has NO per-bucket border locking, so it does
    /// NOT reproduce the P0 6.22M bucketing floor — that floor was an artifact
    /// of the legacy per-region LockBorder, which this policy removes.)
    #[test]
    #[ignore = "P2a heavy asset — run with --ignored --nocapture"]
    fn p2a_query_first_reaches_budget_on_collapsible_bulk() {
        let (path, _grid, total) = ensure_lattice_stl("6p05m", 6_050_000);
        let budget: usize = 500_000;
        let outcome = decimate_binary_stl_to_budget(&path, total as u32, budget)
            .expect("query-first budget decimation");
        let output = outcome.mesh.triangles.len();
        let soft_ceiling = budget * SOFT_CEILING_BUDGET_MULTIPLE;
        eprintln!(
            "[p2a][query-first] source {total} → {output} tris (budget {budget}, \
             soft ceiling {soft_ceiling}, achieved_error {:.6})",
            outcome.achieved_error,
        );
        // meshopt never reduces below the count target; the tight error bound
        // keeps achieved error small (features preserved).
        assert!(
            output >= budget && output <= soft_ceiling,
            "output {output} must land in [budget {budget}, soft ceiling {soft_ceiling}]"
        );
        assert!(
            outcome.achieved_error.is_finite()
                && outcome.achieved_error >= 0.0
                && outcome.achieved_error <= DECIMATION_ERROR_TIERS[DECIMATION_ERROR_TIERS.len() - 1],
            "achieved error must be reported and within the tier ceiling: {}",
            outcome.achieved_error
        );
    }

    /// Query-first ERROR-bound branch (fast, synthetic, deterministic): a few
    /// large well-separated tetrahedra are incompressible under a tight error
    /// bound (any collapse of a bbox-scale tet is a huge relative error). With
    /// a budget below their triangle count the ERROR bound binds first, so the
    /// output lands ABOVE budget but under the soft ceiling, with achieved
    /// error ≤ the tight bound — exactly the "mesh reports its safe-reduction
    /// floor" behavior the policy relies on.
    #[test]
    fn p2a_query_first_error_bound_binds_above_budget() {
        // Three large tetrahedra, each spanning ~10 mm, spaced 100 mm apart so
        // every tet is bbox-scale ⇒ every collapse is a large relative error.
        let tets = [[0.0f32, 0.0, 0.0], [100.0, 0.0, 0.0], [0.0, 100.0, 0.0]];
        let mut soup: Vec<f32> = Vec::new();
        for base in tets {
            let s = 10.0f32;
            let v = [
                [base[0], base[1], base[2]],
                [base[0] + s, base[1], base[2]],
                [base[0], base[1] + s, base[2]],
                [base[0], base[1], base[2] + s],
            ];
            for face in [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] {
                for &vi in &face {
                    soup.extend_from_slice(&v[vi]);
                }
            }
        }
        let mesh = IndexedMesh::from_triangle_soup(&soup, io::DEFAULT_MERGE_EPSILON);
        let source = mesh.triangles.len(); // 12
        let budget = 7usize; // below source; the error bound must protect the tets
        let soft_ceiling = budget * SOFT_CEILING_BUDGET_MULTIPLE; // 14
        let outcome = decimate_indexed_to_budget(mesh, budget, DECIMATION_OPTIONS);
        let output = outcome.mesh.triangles.len();
        eprintln!(
            "[p2a][query-first-synthetic] source {source} → {output} tris \
             (budget {budget}, soft ceiling {soft_ceiling}, achieved_error {:.6})",
            outcome.achieved_error,
        );
        assert!(
            output > budget,
            "error bound must bind: output {output} should exceed budget {budget}"
        );
        assert!(
            output <= soft_ceiling,
            "error-bounded output {output} must stay under the soft ceiling {soft_ceiling}"
        );
        assert!(
            outcome.achieved_error <= DECIMATION_TIGHT_ERROR + 1e-6,
            "achieved error {} must respect the tight bound {DECIMATION_TIGHT_ERROR}",
            outcome.achieved_error
        );
    }

    /// A/B measurement (not a pass/fail gate): the Regularize + LockBorder
    /// decision for `DECIMATION_OPTIONS`, run on the 8M + 12M off-origin
    /// lattices. Prints achieved count + error for each option set at a fixed
    /// budget so the choice is made by measured triangle/feature outcome
    /// (numbers quoted in the Phase-2a AAR / the DECIMATION_OPTIONS comment).
    #[test]
    #[ignore = "P2a option A/B measurement — run with --ignored --nocapture"]
    fn p2a_regularize_lockborder_ab() {
        use meshopt::SimplifyOptions;
        let option_sets = [
            ("none", SimplifyOptions::None),
            ("LockBorder", SimplifyOptions::LockBorder),
            ("Regularize", SimplifyOptions::Regularize),
            (
                "LockBorder|Regularize",
                SimplifyOptions::LockBorder.union(SimplifyOptions::Regularize),
            ),
        ];
        for (label, target) in [("8m", 8_000_000u64), ("12m", 12_000_000u64)] {
            let (path, _grid, total) = ensure_lattice_stl(label, target);
            let budget = (total as usize) * 2 / 3; // force real reduction
            for (name, options) in option_sets.iter().copied() {
                // Fresh soup+index per run so each option starts from source.
                let soup = load_binary_stl_soup(&path, total as u32).unwrap();
                let mesh = IndexedMesh::from_triangle_soup(&soup, io::DEFAULT_MERGE_EPSILON);
                drop(soup);
                let started = Instant::now();
                let outcome = decimate_indexed_to_budget(mesh, budget, options);
                eprintln!(
                    "[p2a][AB][{label}] {name:<22} budget {budget} → {} tris, \
                     achieved_error {:.6}, {:.3}s",
                    outcome.mesh.triangles.len(),
                    outcome.achieved_error,
                    started.elapsed().as_secs_f64(),
                );
            }
        }
    }

    /// §D9 wall-time: the worst-case import core under the NEW policy
    /// (streaming soup → weld → query-first single simplify, with error-tier
    /// re-runs possible) on the 12M asset, at a budget that forces decimation.
    /// Compared in the AAR against the P0 baseline (1.75–1.79 s) + 10 % gate.
    #[test]
    #[ignore = "P2a §D9 wall-time — run with --ignored --nocapture"]
    fn p2a_import_core_wall_time_12m_lattice() {
        let (path, _grid, total) = ensure_lattice_stl("12m", 12_000_000);
        // Budget ≈ the legacy 6M gate, so the 12M asset is decimated (the
        // realistic worst case: full weld + simplify + possible tier re-runs).
        let budget: usize = 6_000_000;

        let started = Instant::now();
        let soup = load_binary_stl_soup(&path, total as u32).expect("soup");
        let after_soup = started.elapsed();
        let mesh = IndexedMesh::from_triangle_soup(&soup, io::DEFAULT_MERGE_EPSILON);
        drop(soup);
        let after_weld = started.elapsed();
        let outcome = decimate_indexed_to_budget(mesh, budget, DECIMATION_OPTIONS);
        let elapsed = started.elapsed();
        eprintln!(
            "[p2a][D9] import core (new policy): {total} → {} tris in {:.3}s \
             (budget {budget}, achieved_error {:.6}) | breakdown: soup {:.3}s, \
             weld {:.3}s, simplify {:.3}s",
            outcome.mesh.triangles.len(),
            elapsed.as_secs_f64(),
            outcome.achieved_error,
            after_soup.as_secs_f64(),
            (after_weld - after_soup).as_secs_f64(),
            (elapsed - after_weld).as_secs_f64(),
        );
        assert!(!outcome.mesh.triangles.is_empty());
    }
}
