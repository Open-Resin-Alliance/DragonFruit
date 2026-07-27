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
    analyze, classify_import, classify_support_split, hollow_voxel, io, punch_cylinders, repair,
    ClassifyImportOptions, HolePunchOptions, HollowOptions, HollowSession, ImportClassification,
    IndexedMesh, RepairOptions, SectionStats, Vec3,
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
    /// P5-2 (D5): opt-in for the lossy Tier-3 convex-hull rescue. The frontend
    /// sets this from the multi-component consent dialog. Default false.
    allow_hull_rescue: Option<bool>,
    /// Ph1(e): the caller already knows this mesh carries support geometry —
    /// the frontend forwards the previous report's `likely_support_geometry` on
    /// a re-repair so the verdict (and the user's support checkbox) survives a
    /// pass that can no longer re-derive it. Default false.
    assume_support_geometry: Option<bool>,
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
            allow_hull_rescue: dto.allow_hull_rescue.unwrap_or(defaults.allow_hull_rescue),
            assume_support_geometry: dto
                .assume_support_geometry
                .unwrap_or(defaults.assume_support_geometry),
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

/// Parses a binary or ASCII STL file in Rust and returns the vertex positions,
/// per-vertex normals, the import-time classification and its run map as a flat
/// byte buffer.
///
/// Byte layout: the 32-byte `DFST` header documented at
/// [`STL_RESPONSE_HEADER_BYTES`], followed by little-endian f32 positions and
/// normals, the run map, and the classification JSON.
///
/// Processing the file in Rust avoids loading the entire raw STL into the
/// webview's memory space, which can save ~1 GB for a large binary STL.
#[tauri::command]
pub async fn load_stl_file(
    file_path: String,
    js_heap_size_limit: Option<f64>,
) -> Result<Response, String> {
    load_stl_file_bytes(&file_path, js_heap_size_limit, None).map(Response::new)
}

/// The body of [`load_stl_file`], as a plain synchronous function so the tests
/// can drive the whole import — governor, classify, DFST encode — without a
/// Tauri runtime.
///
/// `budget_override` exists ONLY for tests: the real budget comes from the
/// machine's RAM, so there is no other way to exercise the over-budget
/// (decimating) branch against a small deterministic fixture. Production passes
/// `None` and the governor is untouched.
fn load_stl_file_bytes(
    file_path: &str,
    js_heap_size_limit: Option<f64>,
    budget_override: Option<u64>,
) -> Result<Vec<u8>, String> {
    use dragonfruit_mesh_repair::io;

    let path = std::path::Path::new(file_path);

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
        if let Some(forced) = budget_override {
            return crate::stl_budget::TriangleBudget {
                budget_tris: forced,
                reason: crate::stl_budget::BudgetReason::Ceiling,
            };
        }
        let inputs = crate::stl_budget::BudgetInputs {
            ram_total_bytes: ram_total,
            ram_available_bytes: ram_available,
            heap_limit_bytes: heap_limit,
            source_triangles,
            // Per-model today; plate-level rebalancing is a documented
            // follow-up (imports are per-file at this boundary).
            concurrent_model_count: 1,
            // D8: a native STL import keeps exactly one copy of its geometry.
            // Multi-body 3MF (which retains `merged` + `splitBodies`) does not
            // reach this governor until Ph8 — that phase sets this to 2.
            retained_geometry_copies: 1,
        };
        let budget = crate::stl_budget::compute_triangle_budget(&inputs);
        // Log `ram_total_bytes` + `source_triangles` off the struct itself (not
        // the `ram_total` / `source_triangles` locals) so their documented
        // "logged for diagnosis" purpose is a genuine field read — otherwise
        // dead-code analysis flags both fields as never-read in the production
        // binary (P6 hygiene).
        log::info!(
            "[STL budget governor] budget={} tris, reason={}, inputs{{ram_total={}, ram_avail={}, heap_limit={}, bytes_per_tri={}, source_tris={}}}",
            budget.budget_tris,
            budget.reason.as_str(),
            inputs.ram_total_bytes,
            ram_available,
            heap_limit,
            crate::stl_budget::BYTES_PER_TRIANGLE_HEAP,
            inputs.source_triangles,
        );
        budget
    };

    if header_len == header.len() {
        let triangle_count = u32::from_le_bytes(header[80..84].try_into().unwrap()) as u64;
        let expected_binary_size = 84u64.saturating_add(triangle_count.saturating_mul(50));
        if expected_binary_size == file_size {
            drop(file);
            let budget = make_budget(triangle_count);

            // Ph1 wiring (a): the FULL-RESOLUTION mesh is welded and classified
            // FIRST, for both branches. The decimating branch used to go
            // straight from the streamed soup into meshopt, which meant the only
            // mesh that ever existed at full resolution was consumed before
            // anything could ask what its triangles WERE. Classification is
            // structural; it has to happen here or not at all.
            let soup = load_binary_stl_soup(path, triangle_count as u32)?;
            let (mut mesh, _stats, dropped_file_indices) =
                IndexedMesh::from_triangle_soup_tracked(&soup, io::DEFAULT_MERGE_EPSILON);
            drop(soup);
            let classification =
                classify_import_at_full_res(&mut mesh, triangle_count as usize, dropped_file_indices);

            if triangle_count <= budget.budget_tris {
                // At/under budget → keep verbatim (NO decimation). The former
                // hard 6M gate is gone; the budget scales with the machine.
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
                    Some(&classification),
                );
            }
            // Over budget → query-first decimation TO budget.
            let outcome =
                decimate_indexed_to_budget(mesh, budget.budget_tris as usize, DECIMATION_OPTIONS);
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
                Some(&classification),
            );
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
    //
    // `file_triangle_count` is the count as PARSED (the run map's index space);
    // `source_tris` stays the WELDED count, because that is what this branch has
    // always reported as the original count and fed to the governor. The two
    // differ only when the file carried non-finite triangles.
    let (mut mesh, _stats, dropped_file_indices, file_triangle_count) = io::stl::load_tracked(path)
        .map_err(|e| format!("Failed to load STL '{}': {e}", file_path))?;
    let source_tris = mesh.triangles.len() as u64;
    let budget = make_budget(source_tris);
    let classification =
        classify_import_at_full_res(&mut mesh, file_triangle_count, dropped_file_indices);
    if source_tris <= budget.budget_tris {
        return encode_stl_response(
            &mesh,
            source_tris as u32,
            false,
            0.0,
            budget.budget_tris as u32,
            Some(&classification),
        );
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
        Some(&classification),
    )
}

/// Ph1 wiring (a) — run the import-time classification over the FULL-RESOLUTION
/// welded mesh and log its cost in the governor's idiom.
///
/// Reorders `mesh` model-section-first as a side effect (that is
/// `classify_import`'s contract), so the encoded response is already in section
/// order and the frontend does not have to stage the whole mesh back to Rust to
/// learn what its triangles are.
///
/// NOT size-gated, deliberately and permanently: the P6 `>= 3M` skip this phase
/// removes is exactly the defect of treating a structural question as an
/// optional nicety. The one thing that IS size-gated lives inside
/// `classify_import` — the manifold validity check — and reports `None` rather
/// than a verdict when it declines.
fn classify_import_at_full_res(
    mesh: &mut IndexedMesh,
    source_triangle_count: usize,
    dropped_file_indices: Vec<u32>,
) -> ImportClassification {
    let dropped = dropped_file_indices.len();
    let classification = classify_import(
        mesh,
        &ClassifyImportOptions {
            source_triangle_count,
            dropped_file_indices,
            compute_section_stats: true,
        },
    );
    log::info!(
        "[STL classify] {} source tris ({} dropped non-finite) -> model={:?}, components={:?}, runs={}, manifold={:?}{}, classify {:.0} ms + stats {:.0} ms",
        source_triangle_count,
        dropped,
        classification.model_triangle_count,
        classification.connected_components,
        classification.model_runs.len(),
        classification.model_is_manifold,
        if classification.manifold_check_size_guarded {
            " (size-guarded)"
        } else {
            ""
        },
        classification.classify_ms,
        classification.section_stats_ms,
    );
    classification
}

const STL_RESPONSE_MAGIC: &[u8; 4] = b"DFST";
/// The `DFST` response header — **32 bytes** since the Ph1 wiring.
///
/// ```text
///   off  size  field
///     0     4  magic "DFST"
///     4     4  flags u32          bit0 = this payload is a reduced preview
///     8     4  originalTriangleCount u32
///    12     4  outputTriangleCount   u32   (triangles actually in the payload)
///    16     4  achievedError f32          (0 for a verbatim load)
///    20     4  budgetTriangles u32        (governor budget; 0 when unreported)
///    24     4  runMapEntryCount u32       (Ph1 — entries PRESENT below)
///    28     4  classificationJsonBytes u32 (Ph1 — 0 when absent)
/// ```
///
/// Payload, tightly packed after the header:
/// `positions (n·36 B) | normals (n·36 B) | run map (entries·8 B) | classification JSON`.
///
/// The run map precedes the JSON so it stays 4-byte aligned — the frontend
/// builds a `Uint32Array` view directly over the IPC buffer, and a
/// variable-length JSON block in front of it would break that alignment for no
/// benefit. The two counts at 24/28 make the total length exactly derivable,
/// which is what `useStlGeometry.ts`'s equality check asserts.
///
/// **Offsets 0..23 are unchanged from the 24-byte Phase-2a header.** The
/// extension is purely additive, but the frontend's exact-length assertion is
/// NOT tolerant of a length it cannot derive, so `NATIVE_STL_HEADER_BYTES` and
/// that assertion must move in the same commit as this constant. A mismatched
/// pair does not degrade — imports break outright.
const STL_RESPONSE_HEADER_BYTES: usize = 32;
const STL_RESPONSE_FLAG_PREVIEW: u32 = 1;

/// Ph1 wiring (c) — hard cap on the run map carried in one response.
///
/// 64 KiB = 8 192 `(start, len)` pairs. The same number caps the VOXL `RUNM`
/// chunk (`voxlRunMap.ts`, `IMPORT_RUN_MAP_MAX_ENTRIES`), deliberately: a map
/// that cannot be persisted is a map the splice would have to recompute on the
/// next load anyway, so transporting it now would buy one session of speed at
/// the cost of two behaviours to reason about.
///
/// A map this large means thousands of interleaved model/support components.
/// The classification itself is unaffected — only the map is dropped, and the
/// classification JSON still reports `run_count`, so a reader can tell "no
/// split" (`run_count == 0`) from "too fragmented to carry"
/// (`run_count > runMapEntryCount`) and fall back to recomputing.
const STL_RESPONSE_RUN_MAP_MAX_BYTES: usize = 64 * 1024;
const STL_RESPONSE_RUN_MAP_MAX_ENTRIES: usize = STL_RESPONSE_RUN_MAP_MAX_BYTES / 8;

/// The classification as it crosses the IPC boundary.
///
/// Borrowed, and WITHOUT `model_runs` — the run map travels as a binary block
/// instead. Serializing it as JSON would cost a full `serde_json::Value`
/// materialization of a vector that can hold millions of entries on a
/// fragmented mesh, to produce a text encoding ~5× the size of the binary one.
#[derive(serde::Serialize)]
struct ImportClassificationWire<'a> {
    model_triangle_count: Option<usize>,
    likely_support_geometry: bool,
    connected_components: Option<usize>,
    model_section: Option<&'a SectionStats>,
    support_section: Option<&'a SectionStats>,
    source_triangle_count: usize,
    dropped_nonfinite_triangles: usize,
    model_is_manifold: Option<bool>,
    model_manifold_status: Option<&'a str>,
    manifold_check_size_guarded: bool,
    classify_ms: f64,
    section_stats_ms: f64,
    /// Runs the classifier PRODUCED. Compare against the header's
    /// `runMapEntryCount` to detect a map dropped for exceeding the cap.
    run_count: usize,
}

impl<'a> From<&'a ImportClassification> for ImportClassificationWire<'a> {
    fn from(c: &'a ImportClassification) -> Self {
        Self {
            model_triangle_count: c.model_triangle_count,
            likely_support_geometry: c.likely_support_geometry,
            connected_components: c.connected_components,
            model_section: c.model_section.as_ref(),
            support_section: c.support_section.as_ref(),
            source_triangle_count: c.source_triangle_count,
            dropped_nonfinite_triangles: c.dropped_nonfinite_triangles,
            model_is_manifold: c.model_is_manifold,
            model_manifold_status: c.model_manifold_status.as_deref(),
            manifold_check_size_guarded: c.manifold_check_size_guarded,
            classify_ms: c.classify_ms,
            section_stats_ms: c.section_stats_ms,
            run_count: c.model_runs.len(),
        }
    }
}

fn encode_stl_response(
    mesh: &IndexedMesh,
    original_triangle_count: u32,
    is_preview: bool,
    achieved_error: f32,
    budget_triangles: u32,
    classification: Option<&ImportClassification>,
) -> Result<Vec<u8>, String> {
    let tri_count = mesh.triangles.len();
    let positions_len = tri_count * 9 * std::mem::size_of::<f32>();
    let normals_len = tri_count * 9 * std::mem::size_of::<f32>();

    let classification_json = classification
        .map(|c| serde_json::to_vec(&ImportClassificationWire::from(c)))
        .transpose()
        .map_err(|e| format!("serialize import classification: {e}"))?
        .unwrap_or_default();
    let run_entries: &[dragonfruit_mesh_repair::TriangleRun] = match classification {
        Some(c) if c.model_runs.len() <= STL_RESPONSE_RUN_MAP_MAX_ENTRIES => &c.model_runs,
        Some(c) => {
            log::warn!(
                "[STL classify] run map dropped: {} runs exceed the {}-entry transport cap; the splice will recompute it",
                c.model_runs.len(),
                STL_RESPONSE_RUN_MAP_MAX_ENTRIES,
            );
            &[]
        }
        None => &[],
    };
    let run_map_len = run_entries.len() * 8;

    let response_len = STL_RESPONSE_HEADER_BYTES
        .checked_add(positions_len)
        .and_then(|size| size.checked_add(normals_len))
        .and_then(|size| size.checked_add(run_map_len))
        .and_then(|size| size.checked_add(classification_json.len()))
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
    result.extend_from_slice(&(run_entries.len() as u32).to_le_bytes());
    result.extend_from_slice(&(classification_json.len() as u32).to_le_bytes());
    result.resize(STL_RESPONSE_HEADER_BYTES + positions_len + normals_len, 0);
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

    for run in run_entries {
        result.extend_from_slice(&run.start.to_le_bytes());
        result.extend_from_slice(&run.len.to_le_bytes());
    }
    result.extend_from_slice(&classification_json);
    debug_assert_eq!(result.len(), response_len);

    log::info!(
        "[load_stl_file] {} triangles, {} MB positions + {} MB normals, {} run entries, {} B classification",
        tri_count,
        positions_len / (1024 * 1024),
        normals_len / (1024 * 1024),
        run_entries.len(),
        classification_json.len(),
    );

    Ok(result)
}

fn read_binary_stl_vertex(record: &[u8; 50], offset: usize) -> Vec3 {
    let read_f32 = |at: usize| f32::from_le_bytes(record[at..at + 4].try_into().unwrap());
    Vec3::new(read_f32(offset), read_f32(offset + 4), read_f32(offset + 8))
}

// STL-import P6 hygiene: the streamed-bucketed preview loader below (and its
// three helpers) was orphaned from production by P2a's query-first governor,
// which replaced it, but is KEPT for the legacy baseline tests in
// `stl_preview_tests` / `p0_fullres_red_harness`. Gated to test builds so it no
// longer emits dead-code warnings in the production binary while the tests that
// exercise it still compile. (`read_binary_stl_vertex` above stays un-gated — it
// has production callers in `load_binary_stl_soup` / `splice_fullres_stl_stream`.)
#[cfg(test)]
struct PreviewTempDir(PathBuf);

#[cfg(test)]
impl Drop for PreviewTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
fn load_binary_stl_preview(
    path: &std::path::Path,
    triangle_count: u32,
    target_triangles: usize,
) -> Result<IndexedMesh, String> {
    let bucket_divisions = if triangle_count < 1_000_000 { 1 } else { 4 };
    let bucket_count = bucket_divisions * bucket_divisions * bucket_divisions;
    let (bbox_min, bbox_max) = binary_stl_bounds(path, triangle_count)?;
    let extent = bbox_max.sub(bbox_min);
    // pid + nanos alone is NOT unique: Windows SystemTime granularity is
    // coarse enough that two calls on the parallel test threadpool land in
    // the same tick, collide on the name, and the second `create_dir` fails
    // with os error 183 (observed intermittently 2026-07-20, islands CP1
    // verification). A process-wide counter makes uniqueness deterministic.
    // NOTE: `allocate_mesh_stage_path` (main.rs) has the same latent pattern
    // in PRODUCTION — tracked as a separate task, not fixed here.
    static PREVIEW_WORKSPACE_SEQ: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);
    let temp_path = std::env::temp_dir().join(format!(
        "dragonfruit-stl-preview-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        PREVIEW_WORKSPACE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
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
    // The error-bound-binds soft ceiling (2× budget) must itself never exceed
    // the absolute preview cap: a decimation-resistant model whose error bound
    // holds above budget must still not be accepted above MAX (else it re-opens
    // the import-OOM regression the governor ceiling closes).
    let soft_ceiling_tris = budget_tris
        .saturating_mul(SOFT_CEILING_BUDGET_MULTIPLE)
        .min(crate::stl_budget::MAX_BUDGET_TRIANGLES as usize);

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
///
/// The Ph1 wiring took this off the production path: `load_stl_file` now has to
/// hold the full-resolution welded mesh long enough to CLASSIFY it, so it
/// performs the weld itself and calls `decimate_indexed_to_budget` directly.
/// The three steps are otherwise identical, so the P2a decimation-policy
/// characterizations keep measuring exactly what they always did through this
/// test-only wrapper rather than being rewritten around the change.
#[cfg(test)]
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
/// Ph3 — a run map that does not describe the file it is paired with. Refused,
/// never "best-effort" applied: a mis-ordered or out-of-range map does not
/// produce a slightly-wrong partition, it produces a confidently wrong one.
pub(crate) const FULLRES_RUN_MAP_INVALID_PREFIX: &str = "FULLRES_RUN_MAP_INVALID";

/// Ph3 — which half of a classified import a single splice pass stages.
///
/// The slicing engine takes ONE split index, so the staged buffer has to be
/// `[all model triangles | all support triangles]` across every model in the
/// scene. A spliced model therefore contributes to the staged buffer TWICE —
/// once in the model pass, once in the support pass — with the WebView
/// collector's own model triangles in between. See the four-pass interleave in
/// `sliceExportOrchestrator.ts`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SpliceSection {
    /// Every triangle in file order. Byte-identical to the pre-Ph3 splice, and
    /// the only section a source with no model/support split can produce.
    All,
    /// Only triangles named by the model run map.
    Model,
    /// Only triangles the model run map does NOT name.
    Support,
}

impl SpliceSection {
    fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.unwrap_or("all") {
            "all" => Ok(Self::All),
            "model" => Ok(Self::Model),
            "support" => Ok(Self::Support),
            other => Err(format!(
                "unknown splice section '{other}' (expected 'all', 'model' or 'support')"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Model => "model",
            Self::Support => "support",
        }
    }
}

/// Where the model run map used by a splice pass came from. Reported back so a
/// slow job is explainable rather than mysterious, and so a test can assert
/// that a recompute happened rather than inferring it from a triangle count.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum RunMapSource {
    /// `SpliceSection::All` — no map is consulted at all.
    NotRequired,
    /// The caller supplied the map (in-session, or rehydrated from `RUNM`).
    Provided,
    /// The map was re-derived from the source file by re-running
    /// `classify_import`, because the caller had none it could trust.
    Recomputed,
    /// A recompute found no model/support split: the whole file is model.
    NoSplit,
}

impl RunMapSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not-required",
            Self::Provided => "provided",
            Self::Recomputed => "recomputed",
            Self::NoSplit => "no-split",
        }
    }
}

/// Decodes the flat `[start0, len0, start1, len1, …]` run array the frontend
/// transports (the same encoding as the DFST response and the `RUNM` chunk)
/// into pairs. An odd length is a damaged map, not a short one.
fn decode_flat_run_map(flat: &[u32]) -> Result<Vec<(u32, u32)>, String> {
    if flat.len() % 2 != 0 {
        return Err(format!(
            "{FULLRES_RUN_MAP_INVALID_PREFIX}: run map has {} values, which is not a whole \
             number of (start, len) pairs",
            flat.len(),
        ));
    }
    Ok(flat.chunks_exact(2).map(|pair| (pair[0], pair[1])).collect())
}

/// Turns the model run map into the ascending, disjoint SOURCE-FILE segments a
/// given section must stage.
///
/// `model_runs` is `None` when the source has no model/support split at all.
/// That absence is NOT "a run covering everything" in the classification — the
/// classifier is deliberate about the difference — but it is exactly that for
/// the splice, because a file with no support section is wholly model. This
/// function is the single place the two meanings are translated, so no consumer
/// has to hold both in its head.
fn section_emit_segments(
    section: SpliceSection,
    model_runs: Option<&[(u32, u32)]>,
    triangle_count: u64,
) -> Result<Vec<(u64, u64)>, String> {
    if triangle_count == 0 {
        return Ok(Vec::new());
    }
    if section == SpliceSection::All {
        return Ok(vec![(0, triangle_count)]);
    }

    let Some(model_runs) = model_runs else {
        return Ok(match section {
            SpliceSection::Model => vec![(0, triangle_count)],
            SpliceSection::Support => Vec::new(),
            SpliceSection::All => unreachable!(),
        });
    };

    // Validate as we normalize. Ascending + disjoint + in-range is the whole
    // contract; violating any of it means the map describes some other file.
    let mut model: Vec<(u64, u64)> = Vec::with_capacity(model_runs.len());
    let mut cursor: u64 = 0;
    for &(start, len) in model_runs {
        if len == 0 {
            continue;
        }
        let start = u64::from(start);
        let len = u64::from(len);
        let end = start + len;
        if start < cursor {
            return Err(format!(
                "{FULLRES_RUN_MAP_INVALID_PREFIX}: run starting at {start} overlaps or precedes \
                 the previous run (which ended at {cursor}) — the map must be ascending and \
                 disjoint",
            ));
        }
        if end > triangle_count {
            return Err(format!(
                "{FULLRES_RUN_MAP_INVALID_PREFIX}: run {start}..{end} runs past the {triangle_count} \
                 triangles in this file — the map describes a different file",
            ));
        }
        model.push((start, len));
        cursor = end;
    }

    if model.is_empty() {
        // An explicitly-supplied EMPTY map paired with a section request is a
        // contradiction: the caller asked to split by a map that names nothing.
        // "No split" arrives as `None`, never as an empty vector.
        return Err(format!(
            "{FULLRES_RUN_MAP_INVALID_PREFIX}: section '{}' was requested with an empty run map; \
             a source with no model/support split must be spliced whole",
            section.as_str(),
        ));
    }

    Ok(match section {
        SpliceSection::Model => model,
        SpliceSection::Support => {
            let mut out: Vec<(u64, u64)> = Vec::with_capacity(model.len() + 1);
            let mut at: u64 = 0;
            for (start, len) in model {
                if start > at {
                    out.push((at, start - at));
                }
                at = start + len;
            }
            if at < triangle_count {
                out.push((at, triangle_count - at));
            }
            out
        }
        SpliceSection::All => unreachable!(),
    })
}

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
    /// Triangles this pass actually appended.
    pub staged_triangle_count: u64,
    /// Triangles in the source file, as its own header numbers them — the index
    /// space the run map addresses. `staged + skipped == source` is the
    /// arithmetic that makes a partition checkable instead of trusted.
    pub source_triangle_count: u64,
    /// Triangles the section filter excluded from this pass.
    pub skipped_triangle_count: u64,
    /// Which section was staged: `all` | `model` | `support`.
    pub section: String,
    /// Where the run map came from: `not-required` | `provided` | `recomputed`
    /// | `no-split`.
    pub run_map_source: String,
    /// World bounds of the STAGED triangles only. `[0,0,0]`/`[0,0,0]` when the
    /// pass staged nothing (an empty support section) — callers must gate any
    /// bounds merge on `stagedTriangleCount > 0` rather than trusting these.
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

/// Verifies the file at `path` still matches an import-time fingerprint.
/// `None` skips the comparison (existence is still required — a missing or
/// unreadable file is always `FULLRES_SOURCE_MISSING`). Returns the actual
/// stat on success. Extracted from the P1 splice so the islands sideload
/// (mesh_minima.rs, CP3) shares one comparison and one error convention.
pub(crate) fn verify_source_fingerprint(
    path: &std::path::Path,
    expected: Option<(u64, f64)>,
) -> Result<SourceFileStat, String> {
    let actual = stat_file_fingerprint(path)?;
    if let Some((expected_size, expected_mtime_ms)) = expected {
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
    Ok(actual)
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
    /// Ph3 — which half of the classified import this pass stages.
    pub section: SpliceSection,
    /// Ph3 — model-section runs in SOURCE-FILE triangle indices, ascending and
    /// disjoint. `None` means the source has NO model/support split, which the
    /// splice reads as "wholly model" (see `section_emit_segments`). Ignored
    /// entirely for [`SpliceSection::All`].
    pub model_runs: Option<Vec<(u32, u32)>>,
}

#[derive(Debug)]
struct FullResSpliceStats {
    /// Triangles handed to the sink.
    staged_triangle_count: u64,
    /// Triangles the source file declares in its header.
    source_triangle_count: u64,
    world_min: [f32; 3],
    world_max: [f32; 3],
}

/// Streams the binary STL at `source_path`, reprojects every vertex by
/// `w = M · (v_raw − C_pre)` in f64, and hands world-space f32 triangle chunks
/// (9 floats per triangle) to `sink`. O(chunk) memory; the full soup is never
/// materialised. `sample` receives (triangle_index, world_triangle) for any
/// index listed in `sample_indices` (R2 verification seam).
///
/// Ph3: `params.section` selects which triangles are emitted. Triangles outside
/// the requested section are SEEKED PAST rather than read and discarded, so a
/// model pass plus a support pass together read the file's records exactly once
/// between them (plus two header reads and a handful of seeks). Bounds and the
/// staged count describe the emitted triangles only.
fn splice_fullres_stl_stream(
    params: &FullResSpliceParams<'_>,
    sample_indices: &[u64],
    mut sample: impl FnMut(u64, [[f32; 3]; 3]),
    mut sink: impl FnMut(&[f32]) -> Result<(), String>,
) -> Result<FullResSpliceStats, String> {
    let path = params.source_path;
    let actual = verify_source_fingerprint(path, params.expected_fingerprint)?;

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

    let segments = section_emit_segments(
        params.section,
        params.model_runs.as_deref(),
        triangle_count,
    )?;

    let mut world_min = [f32::INFINITY; 3];
    let mut world_max = [f32::NEG_INFINITY; 3];
    let mut chunk: Vec<f32> = Vec::with_capacity(FULLRES_SPLICE_CHUNK_TRIANGLES * 9);
    let mut record = [0u8; STL_RECORD_BYTES];
    let mut sample_cursor = 0usize;
    let mut staged_triangle_count = 0u64;
    // Next file-triangle index the reader is positioned at.
    let mut reader_at = 0u64;

    for (segment_start, segment_len) in segments {
        if segment_start > reader_at {
            let skip_bytes = (segment_start - reader_at) * STL_RECORD_BYTES as u64;
            let skip_bytes = i64::try_from(skip_bytes).map_err(|_| {
                format!(
                    "Binary STL '{}' is too large to seek within ({skip_bytes} bytes)",
                    path.display()
                )
            })?;
            reader.seek_relative(skip_bytes).map_err(|e| {
                format!(
                    "Failed seeking to triangle {segment_start} of '{}': {e}",
                    path.display()
                )
            })?;
            reader_at = segment_start;
        }

        for offset in 0..segment_len {
            let triangle_index = segment_start + offset;
            reader.read_exact(&mut record).map_err(|e| {
                format!(
                    "Truncated binary STL '{}' at triangle {triangle_index}: {e}",
                    path.display()
                )
            })?;
            reader_at = triangle_index + 1;
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

            // Sampled indices are ascending, but a filtered pass skips over
            // some of them — advance past anything this section did not stage
            // rather than stalling the cursor on it.
            while sample_cursor < sample_indices.len()
                && sample_indices[sample_cursor] < triangle_index
            {
                sample_cursor += 1;
            }
            if sample_cursor < sample_indices.len()
                && sample_indices[sample_cursor] == triangle_index
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
            staged_triangle_count += 1;
            if chunk.len() >= FULLRES_SPLICE_CHUNK_TRIANGLES * 9 {
                sink(&chunk)?;
                chunk.clear();
            }
        }
    }
    if !chunk.is_empty() {
        sink(&chunk)?;
    }

    if staged_triangle_count == 0 {
        // An empty section is legitimate (a plate whose model runs cover every
        // triangle has no support section). Report neutral bounds rather than
        // infinities, which serialize to JSON `null` and would arrive at the
        // frontend as a hole in a `[number, number, number]`.
        world_min = [0.0; 3];
        world_max = [0.0; 3];
    }

    Ok(FullResSpliceStats {
        staged_triangle_count,
        source_triangle_count: triangle_count,
        world_min,
        world_max,
    })
}

// --- Ph3: the run-map recompute ---------------------------------------------
//
// `resolveImportRunMap` (importRunMap.ts) is the frontend's single sanctioned
// reader of a model's run map, and it returns one of four `recompute` reasons:
// `over-cap` (the classifier produced more runs than the 8 192-entry transport
// and persistence cap carries), `not-persisted` (the model's split is known but
// no map was ever written — a pre-Ph1 VOXL), `chunk-missing` (a summary expects
// a `RUNM` chunk an older writer dropped) and `chunk-damaged` (the chunk's
// length contradicts its summary).
//
// All four have the SAME remedy and it lives here: re-derive the map from the
// source file the splice is about to read anyway. They differ in diagnosis, not
// in cure, so the reason is carried through purely so a slow job is explainable.
//
// The recomputed map deliberately never crosses back into the WebView. The
// 64 KiB cap exists precisely because a pathological map is unbounded; handing
// the frontend the thing the cap refused would defeat it. It is memoised
// Rust-side instead, so the model pass and the support pass of one job share a
// single classify rather than paying for two.

/// Identity of a memoised recompute. Fingerprint-keyed, so a source file edited
/// between two slices re-classifies instead of serving a map for the old bytes.
#[derive(Clone, PartialEq, Eq)]
struct RecomputedRunMapKey {
    path: String,
    size_bytes: u64,
    mtime_ms_bits: u64,
}

/// `None` in the payload = the recompute found NO model/support split.
type RecomputedRunMap = Option<Arc<Vec<(u32, u32)>>>;

static RECOMPUTED_RUN_MAP: OnceLock<Mutex<Option<(RecomputedRunMapKey, RecomputedRunMap)>>> =
    OnceLock::new();

fn recomputed_run_map_cache(
) -> &'static Mutex<Option<(RecomputedRunMapKey, RecomputedRunMap)>> {
    RECOMPUTED_RUN_MAP.get_or_init(|| Mutex::new(None))
}

/// Re-derives a source file's model run map by re-running the import
/// classification over it. Returns `None` when the file has no model/support
/// split at all.
///
/// Cost is the classify itself — measured at 3 774 ms for 11.2M triangles on
/// the adversarial lattice (`classify_import`'s own doc table). That is the
/// honest price of a map that was never carried; the single-entry memo below is
/// what keeps a job from paying it twice for the same model.
fn recompute_import_model_runs(
    path: &std::path::Path,
    stat: &SourceFileStat,
    reason: Option<&str>,
) -> Result<RecomputedRunMap, String> {
    let key = RecomputedRunMapKey {
        path: path.to_string_lossy().into_owned(),
        size_bytes: stat.size_bytes,
        mtime_ms_bits: stat.mtime_ms.to_bits(),
    };

    if let Ok(cache) = recomputed_run_map_cache().lock() {
        if let Some((cached_key, cached)) = cache.as_ref() {
            if *cached_key == key {
                return Ok(cached.clone());
            }
        }
    }

    let started = std::time::Instant::now();
    let (mut mesh, _stats, dropped_file_indices, file_triangle_count) = io::stl::load_tracked(path)
        .map_err(|e| {
            format!(
                "{FULLRES_SOURCE_MISSING_PREFIX}: cannot re-read '{}' to recompute its import \
                 run map: {e}",
                path.display()
            )
        })?;
    let classification = classify_import(
        &mut mesh,
        &ClassifyImportOptions {
            source_triangle_count: file_triangle_count,
            dropped_file_indices,
            // Section topology stats are for the UI; the splice needs the map
            // and nothing else, and this pass is already the expensive one.
            compute_section_stats: false,
        },
    );

    let recomputed: RecomputedRunMap = match classification.model_triangle_count {
        Some(_) => Some(Arc::new(
            classification
                .model_runs
                .iter()
                .map(|run| (run.start, run.len))
                .collect(),
        )),
        // Absence of a split, recorded as absence. The splice translates it to
        // "wholly model" at `section_emit_segments`, in one place.
        None => None,
    };

    log::info!(
        "[fullres splice] recomputed the import run map for '{}' in {:.0} ms \
         ({} source triangles, model={:?}, runs={}) — reason: {}",
        path.display(),
        started.elapsed().as_secs_f64() * 1000.0,
        file_triangle_count,
        classification.model_triangle_count,
        recomputed.as_ref().map_or(0, |runs| runs.len()),
        reason.unwrap_or("unspecified"),
    );

    if let Ok(mut cache) = recomputed_run_map_cache().lock() {
        *cache = Some((key, recomputed.clone()));
    }
    Ok(recomputed)
}

/// Resolves the model runs a section-aware splice pass will use: nothing for a
/// whole-file pass, the caller's map when it had one, else a recompute.
fn resolve_splice_model_runs(
    path: &std::path::Path,
    stat: &SourceFileStat,
    section: SpliceSection,
    provided: Option<Vec<u32>>,
    reason: Option<&str>,
) -> Result<(Option<Vec<(u32, u32)>>, RunMapSource), String> {
    if section == SpliceSection::All {
        return Ok((None, RunMapSource::NotRequired));
    }
    if let Some(flat) = provided {
        return Ok((Some(decode_flat_run_map(&flat)?), RunMapSource::Provided));
    }
    match recompute_import_model_runs(path, stat, reason)? {
        Some(runs) => Ok((
            Some(runs.as_ref().clone()),
            RunMapSource::Recomputed,
        )),
        None => Ok((None, RunMapSource::NoSplit)),
    }
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
/// called `stage_mesh_binary_start` first. Atomic per pass: on any failure the
/// staged buffer is truncated back to its pre-splice length.
///
/// **Ph3 — `section` is what makes the engine's single split index able to
/// describe a spliced scene.** The slicer takes one boundary, so the staged
/// buffer must be `[every model triangle | every support triangle]`. The
/// orchestrator therefore drives four passes: this command with
/// `section: 'model'` for each spliced model, then the WebView collector's
/// model triangles, then this command with `section: 'support'`, then the
/// collector's support triangles and the generated supports/rafts. Omitting
/// `section` (or passing `'all'`) reproduces the pre-Ph3 whole-file pass
/// byte-for-byte, which is what a source with no model/support split gets.
///
/// `model_runs` is the flat `[start0, len0, …]` map in SOURCE-FILE indices.
/// Omit it on a sectioned pass to have the map recomputed from the file — see
/// `resolve_splice_model_runs`. `run_map_recompute_reason` only labels the log
/// line; the remedy is identical for all four of `resolveImportRunMap`'s
/// reasons.
#[tauri::command]
pub async fn stage_fullres_mesh_from_source(
    source_path: String,
    matrix16: Vec<f64>,
    c_pre: Vec<f64>,
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
    quantization: FullResQuantizationBounds,
    section: Option<String>,
    model_runs: Option<Vec<u32>>,
    run_map_recompute_reason: Option<String>,
) -> Result<FullResSpliceSummary, String> {
    let started = std::time::Instant::now();
    let path = std::path::PathBuf::from(&source_path);
    let expected_fingerprint =
        expected_size_bytes.and_then(|size| expected_mtime_ms.map(|mtime| (size, mtime)));
    let section = SpliceSection::parse(section.as_deref())?;
    // Verify BEFORE any recompute: re-classifying a file that turns out to be
    // stale would spend seconds to produce a map for bytes we then refuse.
    let stat = verify_source_fingerprint(&path, expected_fingerprint)?;
    let (resolved_runs, run_map_source) = resolve_splice_model_runs(
        &path,
        &stat,
        section,
        model_runs,
        run_map_recompute_reason.as_deref(),
    )?;

    let params = FullResSpliceParams {
        source_path: &path,
        matrix16_col_major: parse_matrix16(&matrix16)?,
        c_pre: parse_vec3_f64(&c_pre, "cPre")?,
        expected_fingerprint,
        flip_winding_on_negative_determinant: true,
        section,
        model_runs: resolved_runs,
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
                "[stage_fullres_mesh_from_source] spliced {} of {} full-res triangles from '{}' \
                 (section {}, run map {}) in {:.1} ms (world z {:.3}..{:.3})",
                stats.staged_triangle_count,
                stats.source_triangle_count,
                source_path,
                section.as_str(),
                run_map_source.as_str(),
                splice_ms,
                stats.world_min[2],
                stats.world_max[2],
            );
            Ok(FullResSpliceSummary {
                staged_triangle_count: stats.staged_triangle_count,
                source_triangle_count: stats.source_triangle_count,
                skipped_triangle_count: stats
                    .source_triangle_count
                    .saturating_sub(stats.staged_triangle_count),
                section: section.as_str().to_string(),
                run_map_source: run_map_source.as_str().to_string(),
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
        // Ph3: mesh export is deliberately WHOLE-file. Its output is one STL /
        // 3MF of everything the user has on the plate, triangle order is
        // irrelevant to both serializers, and there is no split index for a
        // section boundary to mean anything to. Sectioning here would buy
        // nothing and cost a second read of the file.
        section: SpliceSection::All,
        model_runs: None,
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
                stats.staged_triangle_count,
                source_path,
                stage_file_path,
                splice_ms,
            );
            Ok(FullResSpliceSummary {
                staged_triangle_count: stats.staged_triangle_count,
                source_triangle_count: stats.source_triangle_count,
                skipped_triangle_count: 0,
                section: SpliceSection::All.as_str().to_string(),
                run_map_source: RunMapSource::NotRequired.as_str().to_string(),
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

// --- Phase 4: full-resolution routing for the permanent mutators -------------
//
// hollowing apply/preview, manual repair-in-place, and hole-punch apply all
// PERMANENTLY replace the scene geometry with an output built from whatever
// they are handed. For a `_isNativePreview` model that input is the ~2M
// decimated preview — so today mutating a >budget import bakes the decimation
// forever (unlike slicing, which re-reads per job). This command re-sources the
// ORIGINAL file for those mutators, exactly as P1 does for slicing/export, but
// in the frame + encoding the mutators consume.
//
// FRAME: the mutators stage the model's centered LOCAL geometry soup
// (`stageGeometryToStagedMesh` → the un-transformed `model.geometry.geometry`
// position buffer, which at import is `v_raw − C_pre`); rotation/scale are
// supplied to the mutators separately (hollow `rotationQuat`, mm-param scaling).
// So the reprojection here is `v_local = I · (v_raw − C_pre)` — P1's world-space
// formula with an identity matrix and no winding flip.
//
// ENCODING: the mutators read `STAGED_MESH` via `io::staged::load_positions_le`
// (raw f32 LE, 9 per triangle) — the `stage_mesh_binary_set` encoding, NOT the
// slicing u16 transport `stage_fullres_mesh_from_source` writes. This command
// therefore emits raw f32 and REPLACES the staged buffer (fresh set), mirroring
// `stage_mesh_binary_set`. Full-res bytes never enter the WebView (plan §C.2);
// only the mutation output returns as the new scene geometry.

/// Column-major identity matrix (THREE.Matrix4.elements order).
const IDENTITY_MATRIX16: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0, //
];

// --- Ph3b: hollow section-awareness ------------------------------------------
//
// Ph3 gave the SLICING splice a section, because the slicer's single split index
// needed one. The permanent mutators kept splicing the whole file, so hollowing
// a pre-supported import voxelised the supports along with the model body — an
// honest suboptimality Ph3 recorded rather than half-wired.
//
// Ph3b closes it with the plan's design: stage the MODEL section, hollow it,
// re-append the untouched SUPPORT section. Both halves come off the same
// `splice_fullres_stl_stream` walk in the same LOCAL frame, so "untouched" is
// literal — the support bytes the frontend re-appends are the source file's own
// records, reprojected by `v_local = v_raw − T_center` and nothing else.
//
// The two passes are checkable rather than trusted: the model pass reports
// `skipped_triangle_count`, the support pass reports `staged_triangle_count`,
// and the frontend refuses to re-append unless they are equal.

/// One LOCAL-frame mutator splice pass. Shared by the staging command (which
/// publishes the soup as `STAGED_MESH`) and the section read-back (which hands
/// it to the frontend for re-append), so the two cannot drift in frame,
/// winding or section semantics.
pub(crate) struct MutatorSpliceRequest<'a> {
    pub path: &'a std::path::Path,
    /// The vector subtracted from each raw vertex. For the mutators this is
    /// `T_center = C_pre − geometry.center`, NOT `C_pre` — see
    /// `fullResMutatorStaging.ts`. Getting it wrong fails as a whole-model shift
    /// in Y by half the model height.
    pub c_pre: [f64; 3],
    pub expected_fingerprint: Option<(u64, f64)>,
    pub section: SpliceSection,
    pub model_runs: Option<Vec<(u32, u32)>>,
    /// Carried into the log line only; the summary reports it back so a test can
    /// assert a recompute happened rather than infer it from a triangle count.
    pub run_map_source: RunMapSource,
}

/// Streams one section of the source file into a raw f32 LE triangle soup in the
/// local mutator frame. Identity matrix, no winding flip — the encoding
/// `io::staged::load_positions_le` reads and the encoding the mutators' own
/// output uses, so a re-appended support block is byte-compatible with a
/// hollowed model block.
fn mutator_splice_soup(
    request: &MutatorSpliceRequest<'_>,
) -> Result<(FullResSpliceStats, Vec<u8>), String> {
    let params = FullResSpliceParams {
        source_path: request.path,
        matrix16_col_major: IDENTITY_MATRIX16,
        c_pre: request.c_pre,
        expected_fingerprint: request.expected_fingerprint,
        // Identity transform → positive determinant → no winding flip; the
        // mutator soup preserves the source triangle winding exactly.
        flip_winding_on_negative_determinant: false,
        section: request.section,
        model_runs: request.model_runs.clone(),
    };
    let mut soup_bytes: Vec<u8> = Vec::new();
    let stats = splice_fullres_stl_stream(
        &params,
        &[],
        |_, _| {},
        |floats| {
            soup_bytes.extend_from_slice(bytemuck::cast_slice::<f32, u8>(floats));
            Ok(())
        },
    )?;
    Ok((stats, soup_bytes))
}

/// Turns the command-level arguments shared by both mutator commands into a
/// request, resolving the run map exactly as the slicing splice does
/// (`resolve_splice_model_runs`: nothing for a whole-file pass, the caller's map
/// when it had one, else a fingerprint-memoised recompute).
fn build_mutator_splice_request<'a>(
    path: &'a std::path::Path,
    c_pre: &[f64],
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
    section: Option<String>,
    model_runs: Option<Vec<u32>>,
    run_map_recompute_reason: Option<&str>,
) -> Result<MutatorSpliceRequest<'a>, String> {
    let expected_fingerprint =
        expected_size_bytes.and_then(|size| expected_mtime_ms.map(|mtime| (size, mtime)));
    let section = SpliceSection::parse(section.as_deref())?;
    // Verify BEFORE any recompute: re-classifying a file that turns out to be
    // stale would spend seconds to produce a map for bytes we then refuse.
    let stat = verify_source_fingerprint(path, expected_fingerprint)?;
    let (resolved_runs, run_map_source) = resolve_splice_model_runs(
        path,
        &stat,
        section,
        model_runs,
        run_map_recompute_reason,
    )?;
    Ok(MutatorSpliceRequest {
        path,
        c_pre: parse_vec3_f64(c_pre, "cPre")?,
        expected_fingerprint,
        section,
        model_runs: resolved_runs,
        run_map_source,
    })
}

fn mutator_splice_summary(
    request: &MutatorSpliceRequest<'_>,
    stats: &FullResSpliceStats,
    splice_ms: f64,
) -> FullResSpliceSummary {
    FullResSpliceSummary {
        staged_triangle_count: stats.staged_triangle_count,
        source_triangle_count: stats.source_triangle_count,
        skipped_triangle_count: stats
            .source_triangle_count
            .saturating_sub(stats.staged_triangle_count),
        section: request.section.as_str().to_string(),
        run_map_source: request.run_map_source.as_str().to_string(),
        world_min: stats.world_min,
        world_max: stats.world_max,
        splice_ms,
    }
}

/// Mutator splice: streams the original binary STL, reprojects to the local
/// centered frame (`v_local = v_raw − C_pre`), and REPLACES the in-memory
/// staged mesh (`STAGED_MESH`) with raw f32 LE triangle soup that the
/// `*_staged` mutator commands read. Atomic: on any failure the previously
/// staged buffer is left untouched (the frontend degrades to re-staging the
/// preview geometry).
///
/// **Ph3b — `section` is what keeps hollowing off the supports.** Passing
/// `'model'` stages only the triangles the run map names, so the voxel grid, the
/// cavity and the shell all describe the model body alone. The complement is
/// read back separately by [`read_fullres_mesh_section_positions`] and
/// re-appended to the mutation output by the caller. Omitting `section` (or
/// passing `'all'`) reproduces the pre-Ph3b whole-file pass byte-for-byte, which
/// is what a source with no model/support split gets and what every non-hollow
/// mutator still asks for.
///
/// `model_runs` is the flat `[start0, len0, …]` map in SOURCE-FILE indices; omit
/// it on a sectioned pass to have the map recomputed from the file.
#[tauri::command]
pub async fn stage_fullres_mesh_into_staged(
    source_path: String,
    c_pre: Vec<f64>,
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
    section: Option<String>,
    model_runs: Option<Vec<u32>>,
    run_map_recompute_reason: Option<String>,
) -> Result<FullResSpliceSummary, String> {
    let started = std::time::Instant::now();
    let path = std::path::PathBuf::from(&source_path);
    let request = build_mutator_splice_request(
        &path,
        &c_pre,
        expected_size_bytes,
        expected_mtime_ms,
        section,
        model_runs,
        run_map_recompute_reason.as_deref(),
    )?;

    // Accumulate the soup in Rust memory, then publish it as the staged mesh
    // only on success (`?` below aborts before the publish block, so a
    // missing/stale source leaves the prior staged buffer intact). The soup is
    // the same materialization the mutator performs anyway when it loads the
    // staged positions — no extra WebView residency (plan §C.2).
    let (stats, soup_bytes) = mutator_splice_soup(&request)?;

    // Publish (replace) the staged mesh; clear any file-backed staging so the
    // mutator reads this in-memory buffer via `read_staging_bytes`.
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
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))? = Some(soup_bytes);

    let splice_ms = started.elapsed().as_secs_f64() * 1_000.0;
    log::info!(
        "[stage_fullres_mesh_into_staged] spliced {} of {} full-res triangles from '{}' into the \
         staged mesh (section {}, run map {}) in {:.1} ms (local z {:.3}..{:.3})",
        stats.staged_triangle_count,
        stats.source_triangle_count,
        source_path,
        request.section.as_str(),
        request.run_map_source.as_str(),
        splice_ms,
        stats.world_min[2],
        stats.world_max[2],
    );
    Ok(mutator_splice_summary(&request, &stats, splice_ms))
}

/// Ph3b — the SUPPORT read-back. Streams one section of the original STL in the
/// LOCAL mutator frame and returns it as raw f32 LE triangle soup (9 floats per
/// triangle), the same encoding `mesh_repair_read_positions` returns and the
/// same frame the mutation output comes back in — so the caller can concatenate
/// the two and get one coherent mesh.
///
/// This is the only place in the arc where full-resolution source bytes cross
/// into the WebView, and it is unavoidable rather than an oversight: the point
/// of Ph3b is that the support section survives the mutation *verbatim*, and the
/// mutation's output IS the model's new scene geometry. The bytes were always
/// going to land there — before Ph3b they arrived voxelised.
///
/// Returns the section's triangles only. The caller must have staged the
/// complementary section with the SAME `model_runs`, and must verify that this
/// pass's triangle count equals that pass's `skippedTriangleCount` before
/// re-appending; the two counts disagreeing means the map does not describe the
/// file, which is a wrong mesh rather than a slow one.
#[tauri::command]
pub async fn read_fullres_mesh_section_positions(
    source_path: String,
    c_pre: Vec<f64>,
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
    section: Option<String>,
    model_runs: Option<Vec<u32>>,
    run_map_recompute_reason: Option<String>,
) -> Result<Response, String> {
    let started = std::time::Instant::now();
    let path = std::path::PathBuf::from(&source_path);
    let request = build_mutator_splice_request(
        &path,
        &c_pre,
        expected_size_bytes,
        expected_mtime_ms,
        section,
        model_runs,
        run_map_recompute_reason.as_deref(),
    )?;
    let (stats, soup_bytes) = mutator_splice_soup(&request)?;
    log::info!(
        "[read_fullres_mesh_section_positions] read {} of {} full-res triangles from '{}' \
         (section {}, run map {}) in {:.1} ms",
        stats.staged_triangle_count,
        stats.source_triangle_count,
        source_path,
        request.section.as_str(),
        request.run_map_source.as_str(),
        started.elapsed().as_secs_f64() * 1_000.0,
    );
    Ok(Response::new(soup_bytes))
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

    #[test]
    fn repair_options_carry_the_frontend_support_verdict() {
        // Ph1(e): the reclassification fix is only reachable if the DTO
        // actually transports the frontend's flag. Omitting it must keep the
        // engine default (off) — a fresh import has no prior verdict.
        let seeded = parse_options(r#"{"assumeSupportGeometry": true}"#)
            .expect("well-formed JSON parses");
        assert!(seeded.assume_support_geometry);

        let unseeded =
            parse_options(r#"{"allowHullRescue": true}"#).expect("well-formed JSON parses");
        assert!(!unseeded.assume_support_geometry);
        assert!(!parse_options("")
            .expect("empty input falls back to defaults")
            .assume_support_geometry);
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
                section: SpliceSection::All,
                model_runs: None,
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
                staged_triangle_count, stats.staged_triangle_count,
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
            section: SpliceSection::All,
            model_runs: None,
        };
        let stats = splice_fullres_stl_stream(&params, &[], |_, _| {}, |_| Ok(()))
            .expect("full-res splice stream");
        assert_eq!(stats.staged_triangle_count, total);

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
            section: SpliceSection::All,
            model_runs: None,
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
        assert_eq!(stats.staged_triangle_count, total);
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
            section: SpliceSection::All,
            model_runs: None,
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
        assert_eq!(stats.staged_triangle_count, total);
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

    // --- Phase 4: full-res routing for the permanent mutators -------------
    //
    // CONTRACT (plan Phase 4, this brief CP1): the permanent mutators
    // (hollow apply/preview, repair-in-place, hole-punch apply) stage the
    // model's LOCAL centered geometry soup into `STAGED_MESH` as raw f32 and
    // read it back via `io::staged::load_positions_le`. For a `_isNativePreview`
    // model the scene geometry is the ~2M decimated preview, so today a mutation
    // bakes the decimation forever. `stage_fullres_mesh_into_staged` re-sources
    // the ORIGINAL file into that same buffer in the local frame
    // (`v_local = v_raw − C_pre`, identity orientation, raw f32).

    /// Structural CP1 proof: the mutator splice stages the FULL-RES triangle
    /// count (not the ~2M preview) and reprojects into the model's local
    /// centered frame `v_local = v_raw − C_pre`. The RED counterpart — what a
    /// mutator consumes TODAY — is the preview core below, which yields far
    /// fewer than `total` triangles; this test pins the difference.
    #[test]
    fn p4_mutator_splice_stages_full_resolution_local_frame() {
        let (path, grid, total) = ensure_lattice_stl("8m", 8_000_000);
        assert!(total > P0C_PREVIEW_GATE_TRIANGLES, "asset must take the >6M preview path");

        // RED baseline: what the mutator gets WITHOUT full-res routing — the
        // decimated preview the scene geometry actually holds.
        let preview = load_binary_stl_preview(&path, total as u32, 2_000_000)
            .expect("preview import core");
        let preview_tris = preview.triangles.len() as u64;
        drop(preview);
        assert!(
            preview_tris < total,
            "the preview a mutator consumes today ({preview_tris}) must be fewer than \
             the original {total} — otherwise there is nothing to fix"
        );

        // Stored import datum: the analytic full-lattice bbox center (x 40..160,
        // y 25..145, z 0..5.76). The mutator splice uses the LOCAL frame — an
        // identity matrix, no scene transform, no winding flip.
        let c_pre = [100.0, 85.0, 2.88];
        let params = FullResSpliceParams {
            source_path: &path,
            matrix16_col_major: IDENTITY_MATRIX16,
            c_pre,
            expected_fingerprint: None,
            flip_winding_on_negative_determinant: false,
            section: SpliceSection::All,
            model_runs: None,
        };

        let samples = [0u64, total / 2, total - 1];
        let mut sampled: Vec<[[f32; 3]; 3]> = Vec::new();
        let mut staged_f32_bytes: u64 = 0;
        let stats = splice_fullres_stl_stream(
            &params,
            &samples,
            |_, world| sampled.push(world),
            |floats| {
                staged_f32_bytes += (floats.len() * 4) as u64;
                Ok(())
            },
        )
        .expect("mutator full-res splice stream");

        // Raw f32 soup: 36 bytes per triangle (9 floats). Count must equal the
        // ORIGINAL, so the mutator operates on full resolution.
        assert_eq!(staged_f32_bytes % 36, 0, "staged bytes must be whole f32 triangles");
        assert_eq!(
            staged_f32_bytes / 36,
            total,
            "the mutator staged input must carry the ORIGINAL triangle count ({total}), \
             not the {preview_tris}-triangle preview"
        );
        assert_eq!(stats.staged_triangle_count, total);

        // Local-frame reprojection: identity means v_local = v_raw − C_pre.
        for (sample_index, &tri_index) in samples.iter().enumerate() {
            let raw = lattice_triangle(grid, tri_index);
            let staged = sampled[sample_index];
            for (vertex_index, &v_raw) in raw.iter().enumerate() {
                let want = [
                    v_raw[0] as f64 - c_pre[0],
                    v_raw[1] as f64 - c_pre[1],
                    v_raw[2] as f64 - c_pre[2],
                ];
                let got = staged[vertex_index];
                let distance = ((got[0] as f64 - want[0]).powi(2)
                    + (got[1] as f64 - want[1]).powi(2)
                    + (got[2] as f64 - want[2]).powi(2))
                .sqrt();
                assert!(
                    distance <= 1e-4,
                    "triangle {tri_index} vertex {vertex_index}: staged {got:?} is \
                     {distance:.6} mm from v_raw − C_pre = {want:?} (tolerance 1e-4 mm)"
                );
            }
        }
    }

    /// Heavy CP2/CP4 structural check: hollow the 8M off-origin lattice through
    /// the mutator splice → `HollowReport.source_triangle_count` reflects the
    /// ORIGINAL count, not the decimated preview. Ignored (voxelizes 8M
    /// triangles; heavy-asset convention) — run explicitly:
    ///   cargo test p4_hollow_consumes_full_resolution -- --ignored --nocapture
    #[test]
    #[ignore = "P4 heavy asset — run with --ignored --nocapture"]
    fn p4_hollow_consumes_full_resolution_source() {
        let (path, _grid, total) = ensure_lattice_stl("8m", 8_000_000);
        assert!(total > P0C_PREVIEW_GATE_TRIANGLES);

        let c_pre = [100.0, 85.0, 2.88];
        let params = FullResSpliceParams {
            source_path: &path,
            matrix16_col_major: IDENTITY_MATRIX16,
            c_pre,
            expected_fingerprint: None,
            flip_winding_on_negative_determinant: false,
            section: SpliceSection::All,
            model_runs: None,
        };
        let mut soup: Vec<f32> = Vec::with_capacity((total as usize) * 9);
        splice_fullres_stl_stream(&params, &[], |_, _| {}, |floats| {
            soup.extend_from_slice(floats);
            Ok(())
        })
        .expect("mutator full-res splice stream");

        let mesh = io::staged::load_positions_le(bytemuck::cast_slice::<f32, u8>(&soup))
            .expect("load staged full-res positions");
        drop(soup);

        let options = HollowOptions {
            // Coarse grid to keep the heavy run tractable; the source count is
            // resolution-independent.
            voxel_resolution: 48,
            preview_cavity_only: true,
            preview_voxel_spheres: true,
            internal_chamfer_passes: 0,
            smooth_internal_surfaces: false,
            ..HollowOptions::default()
        };
        let outcome = hollow_voxel(mesh, &options);
        eprintln!(
            "[p4][hollow] source_triangle_count = {} (original {total}, preview would be ~2M)",
            outcome.report.source_triangle_count,
        );
        assert_eq!(
            outcome.report.source_triangle_count, total as usize,
            "hollow must consume the full-res source, not the decimated preview"
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

// ─────────────────────────────────────────────────────────────────────────────
// Ph1 WIRING — `load_stl_file` → classify → DFST transport
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod ph1_import_wiring_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// A deterministic model+support plate, small enough to run in a unit test
    /// and shaped to satisfy every guard in `classify_and_reorder_detailed`:
    /// ONE high-poly model shell well above the raft cut, plus 200 low-poly
    /// support posts that touch the base.
    ///
    /// The file order is deliberately INTERLEAVED — model half, all supports,
    /// model half — so a run map that merely recorded "the first N triangles"
    /// would be visibly wrong.
    const SUPPORT_POSTS: usize = 200;
    /// Sized so the model shell clears the classifier's `model_min_tris` floor
    /// and out-densities the posts by far more than 4x per component, while the
    /// support section still out-TOTALS it — which is what
    /// `compute_likely_support_geometry` actually asks for, and what a real
    /// pre-supported plate looks like.
    const MODEL_GRID: usize = 8;
    /// 6 faces x MODEL_GRID^2 quads x 2 triangles.
    pub(super) const MODEL_TRIS: usize = 6 * MODEL_GRID * MODEL_GRID * 2;
    pub(super) const SUPPORT_TRIS: usize = SUPPORT_POSTS * 12;
    const _: () = assert!(SUPPORT_TRIS > MODEL_TRIS);

    fn axis_box_triangles(min: [f32; 3], max: [f32; 3]) -> Vec<[[f32; 3]; 3]> {
        let [x0, y0, z0] = min;
        let [x1, y1, z1] = max;
        vec![
            [[x0, y0, z0], [x1, y1, z0], [x1, y0, z0]],
            [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
            [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1]],
            [[x0, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1]],
            [[x0, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            [[x0, y1, z0], [x1, y1, z1], [x1, y1, z0]],
            [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
            [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
            [[x0, y0, z0], [x0, y1, z1], [x0, y1, z0]],
            [[x1, y0, z0], [x1, y1, z1], [x1, y0, z1]],
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
        ]
    }

    /// A box whose six faces are each subdivided into `n x n` quads, so it is
    /// ONE connected component with enough triangles to clear the classifier's
    /// `model_min_tris` floor. Seam vertices are computed by the same lerp on
    /// both adjoining faces, so they weld exactly.
    fn subdivided_box_triangles(min: [f32; 3], max: [f32; 3], n: usize) -> Vec<[[f32; 3]; 3]> {
        let lerp = |a: f32, b: f32, i: usize| a + (b - a) * (i as f32 / n as f32);
        let mut out = Vec::with_capacity(6 * n * n * 2);
        // (axis held constant, its value, then the two varying axes)
        let faces: [(usize, f32, usize, usize); 6] = [
            (2, min[2], 0, 1),
            (2, max[2], 0, 1),
            (1, min[1], 0, 2),
            (1, max[1], 0, 2),
            (0, min[0], 1, 2),
            (0, max[0], 1, 2),
        ];
        for (fixed_axis, fixed_value, au, av) in faces {
            for i in 0..n {
                for j in 0..n {
                    let corner = |iu: usize, iv: usize| -> [f32; 3] {
                        let mut p = [0.0f32; 3];
                        p[fixed_axis] = fixed_value;
                        p[au] = lerp(min[au], max[au], iu);
                        p[av] = lerp(min[av], max[av], iv);
                        p
                    };
                    let a = corner(i, j);
                    let b = corner(i + 1, j);
                    let c = corner(i + 1, j + 1);
                    let d = corner(i, j + 1);
                    out.push([a, b, c]);
                    out.push([a, c, d]);
                }
            }
        }
        out
    }

    /// Writes the fixture as a binary STL. When `nan_at_file_index` is set, the
    /// triangle at that FILE index gets a NaN coordinate — the intake drops it,
    /// which shifts every later welded index by one relative to the file and is
    /// exactly the shift the run map has to compensate for.
    pub(super) fn write_support_plate_stl(path: &Path, nan_at_file_index: Option<usize>) -> usize {
        let model = subdivided_box_triangles([40.0, 25.0, 2.0], [140.0, 125.0, 12.0], MODEL_GRID);
        assert_eq!(model.len(), MODEL_TRIS);
        let mut supports = Vec::with_capacity(SUPPORT_TRIS);
        for k in 0..SUPPORT_POSTS {
            let ix = (k % 20) as f32;
            let iy = (k / 20) as f32;
            let x = 41.0 + ix * 4.0;
            let y = 26.0 + iy * 4.0;
            supports.extend(axis_box_triangles([x, y, 0.0], [x + 0.4, y + 0.4, 1.0]));
        }
        assert_eq!(supports.len(), SUPPORT_TRIS);

        let half = MODEL_TRIS / 2;
        let mut triangles: Vec<[[f32; 3]; 3]> = Vec::with_capacity(MODEL_TRIS + SUPPORT_TRIS);
        triangles.extend_from_slice(&model[..half]);
        triangles.extend_from_slice(&supports);
        triangles.extend_from_slice(&model[half..]);

        if let Some(index) = nan_at_file_index {
            triangles[index][0][0] = f32::NAN;
        }

        let file = std::fs::File::create(path).expect("create fixture STL");
        let mut out = BufWriter::with_capacity(1 << 20, file);
        out.write_all(&[0u8; 80]).unwrap();
        out.write_all(&(triangles.len() as u32).to_le_bytes()).unwrap();
        let mut record = [0u8; 50];
        for tri in &triangles {
            let mut at = 12;
            for vertex in tri {
                for component in vertex {
                    record[at..at + 4].copy_from_slice(&component.to_le_bytes());
                    at += 4;
                }
            }
            out.write_all(&record).unwrap();
        }
        out.flush().unwrap();
        triangles.len()
    }


    /// Writes the same fixture as an ASCII STL, which takes the OTHER branch of
    /// `load_stl_file` — the one that goes through `io::stl::load_tracked`.
    fn write_support_plate_ascii_stl(path: &Path) -> usize {
        let model = subdivided_box_triangles([40.0, 25.0, 2.0], [140.0, 125.0, 12.0], MODEL_GRID);
        let mut supports = Vec::with_capacity(SUPPORT_TRIS);
        for k in 0..SUPPORT_POSTS {
            let ix = (k % 20) as f32;
            let iy = (k / 20) as f32;
            let x = 41.0 + ix * 4.0;
            let y = 26.0 + iy * 4.0;
            supports.extend(axis_box_triangles([x, y, 0.0], [x + 0.4, y + 0.4, 1.0]));
        }
        let half = MODEL_TRIS / 2;
        let mut triangles: Vec<[[f32; 3]; 3]> = Vec::with_capacity(MODEL_TRIS + SUPPORT_TRIS);
        triangles.extend_from_slice(&model[..half]);
        triangles.extend_from_slice(&supports);
        triangles.extend_from_slice(&model[half..]);

        let file = std::fs::File::create(path).expect("create ASCII fixture");
        let mut out = BufWriter::with_capacity(1 << 20, file);
        writeln!(out, "solid plate").unwrap();
        for tri in &triangles {
            writeln!(out, "facet normal 0 0 0").unwrap();
            writeln!(out, "outer loop").unwrap();
            for v in tri {
                writeln!(out, "vertex {} {} {}", v[0], v[1], v[2]).unwrap();
            }
            writeln!(out, "endloop").unwrap();
            writeln!(out, "endfacet").unwrap();
        }
        writeln!(out, "endsolid plate").unwrap();
        out.flush().unwrap();
        triangles.len()
    }

    /// Ph1 wiring (a) — the ASCII / non-standard-binary branch classifies too.
    /// It reaches `classify_import` through `io::stl::load_tracked` rather than
    /// the streamed soup, so it is a genuinely separate path and not covered by
    /// the binary tests above.
    #[test]
    fn ascii_import_classifies_and_transports_the_result() {
        let fixture = fixture_path("ascii");
        let total = write_support_plate_ascii_stl(&fixture.0);

        let bytes = load_stl_file_bytes(fixture.0.to_str().unwrap(), None, None)
            .expect("ASCII import must succeed");
        let decoded = decode_stl_response(&bytes);

        assert!(!decoded.is_preview);
        let c = &decoded.classification;
        assert_eq!(c["source_triangle_count"].as_u64().unwrap() as usize, total);
        assert_eq!(
            c["model_triangle_count"].as_u64().unwrap() as usize,
            MODEL_TRIS,
        );
        assert!(c["likely_support_geometry"].as_bool().unwrap());
        assert!(!decoded.run_map.is_empty(), "the ASCII branch emits a run map too");
        let mapped: usize = decoded.run_map.iter().map(|&(_, len)| len as usize).sum();
        assert_eq!(mapped, MODEL_TRIS);
    }

    pub(super) struct FixtureFile(pub(super) PathBuf);

    impl Drop for FixtureFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// pid + monotonic sequence, per the established temp-naming discipline —
    /// coarse Windows clock granularity makes a nanos-only name collide between
    /// concurrently-scheduled tests.
    pub(super) fn fixture_path(label: &str) -> FixtureFile {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        FixtureFile(std::env::temp_dir().join(format!(
            "dragonfruit-ph1-wiring-{label}-{}-{seq}.stl",
            std::process::id()
        )))
    }

    /// The frontend's view of a DFST response, decoded by the same rules
    /// `useStlGeometry.ts` uses. A Rust-side decoder means the wire format has
    /// an executable spec on both ends of the IPC rather than one end and a
    /// comment.
    struct DecodedResponse {
        is_preview: bool,
        original_triangle_count: u32,
        output_triangle_count: u32,
        run_map: Vec<(u32, u32)>,
        classification: serde_json::Value,
    }

    fn decode_stl_response(bytes: &[u8]) -> DecodedResponse {
        assert!(bytes.len() >= STL_RESPONSE_HEADER_BYTES, "response too short");
        assert_eq!(&bytes[0..4], STL_RESPONSE_MAGIC, "bad magic");
        let u32_at = |off: usize| u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        let flags = u32_at(4);
        let original_triangle_count = u32_at(8);
        let output_triangle_count = u32_at(12);
        let run_map_entries = u32_at(24) as usize;
        let classification_bytes = u32_at(28) as usize;

        let geometry_len = output_triangle_count as usize * 18 * 4;
        let expected =
            STL_RESPONSE_HEADER_BYTES + geometry_len + run_map_entries * 8 + classification_bytes;
        assert_eq!(
            bytes.len(),
            expected,
            "response length must be exactly derivable from the header",
        );

        let run_base = STL_RESPONSE_HEADER_BYTES + geometry_len;
        let run_map = (0..run_map_entries)
            .map(|i| {
                let at = run_base + i * 8;
                (
                    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()),
                    u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()),
                )
            })
            .collect();
        let json_base = run_base + run_map_entries * 8;
        let classification = if classification_bytes == 0 {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes[json_base..json_base + classification_bytes])
                .expect("classification JSON must parse")
        };

        DecodedResponse {
            is_preview: (flags & STL_RESPONSE_FLAG_PREVIEW) != 0,
            original_triangle_count,
            output_triangle_count,
            run_map,
            classification,
        }
    }

    /// Ph1 wiring (a) + (d) — the classification exists on the VERBATIM branch
    /// and reaches the frontend. Before the wiring, `classify_import` had no
    /// call site outside the mesh-repair crate's own tests, so an import
    /// returned geometry and nothing else.
    #[test]
    fn verbatim_import_classifies_and_transports_the_result() {
        let fixture = fixture_path("verbatim");
        let total = write_support_plate_stl(&fixture.0, None);

        let bytes = load_stl_file_bytes(fixture.0.to_str().unwrap(), None, None)
            .expect("import must succeed");
        let decoded = decode_stl_response(&bytes);

        assert!(!decoded.is_preview, "at-budget import must stay verbatim");
        assert_eq!(decoded.original_triangle_count as usize, total);
        assert_eq!(decoded.output_triangle_count as usize, total);

        let c = &decoded.classification;
        assert!(c.is_object(), "classification block must be present");
        assert_eq!(c["source_triangle_count"].as_u64().unwrap() as usize, total);
        assert_eq!(
            c["model_triangle_count"].as_u64().unwrap() as usize,
            MODEL_TRIS,
            "the model section is the subdivided shell, not the whole file",
        );
        assert!(
            c["likely_support_geometry"].as_bool().unwrap(),
            "200 low-poly base-touching posts is a pre-supported plate",
        );
        assert_eq!(
            c["connected_components"].as_u64().unwrap() as usize,
            SUPPORT_POSTS + 1,
        );
        assert_eq!(c["dropped_nonfinite_triangles"].as_u64().unwrap(), 0);
    }

    /// The honesty contract, end to end: a field the cheap tier does not
    /// compute crosses the wire as `null`, never as a measured-looking `0`.
    #[test]
    fn transported_section_stats_keep_unmeasured_fields_null() {
        let fixture = fixture_path("unmeasured");
        write_support_plate_stl(&fixture.0, None);

        let bytes = load_stl_file_bytes(fixture.0.to_str().unwrap(), None, None).unwrap();
        let c = decode_stl_response(&bytes).classification;

        for section in ["model_section", "support_section"] {
            let s = &c[section];
            assert!(s.is_object(), "{section} must be present");
            assert!(
                s["self_intersection_triangles"].is_null(),
                "{section}: the BVH sweep never runs at this tier — it must be null, not 0",
            );
            assert!(
                s["boundary_edges"].is_u64(),
                "{section}: the topology tier DID run, so its fields are measured",
            );
            assert!(s["is_watertight"].is_boolean(), "{section}: measured verdict");
        }
    }

    /// Ph1 wiring (a) on the DECIMATING branch — the branch that previously
    /// destroyed the full-resolution mesh before anything could classify it.
    /// The classification describes the SOURCE; the geometry is the preview.
    #[test]
    fn over_budget_import_classifies_the_full_res_source_not_the_preview() {
        let fixture = fixture_path("decimated");
        let total = write_support_plate_stl(&fixture.0, None);
        let budget = 1_000u64;

        let bytes = load_stl_file_bytes(fixture.0.to_str().unwrap(), None, Some(budget)).unwrap();
        let decoded = decode_stl_response(&bytes);

        assert!(decoded.is_preview, "over-budget import must be a preview");
        assert!(
            (decoded.output_triangle_count as usize) < total,
            "preview must actually be smaller than the source",
        );
        let c = &decoded.classification;
        assert_eq!(
            c["source_triangle_count"].as_u64().unwrap() as usize,
            total,
            "the classification is of the FULL-RES source",
        );
        assert_eq!(
            c["model_triangle_count"].as_u64().unwrap() as usize,
            MODEL_TRIS,
        );
        assert!(c["likely_support_geometry"].as_bool().unwrap());
    }

    /// Ph1 wiring (c) — the transported run map addresses triangles as the
    /// SOURCE FILE numbers them. A triangle dropped at intake for a non-finite
    /// coordinate shifts every later welded index by one; only compensating for
    /// the drop POSITION (a count cannot) keeps the map addressing the right
    /// records when the splice re-reads the file.
    #[test]
    fn transported_run_map_addresses_source_file_triangles() {
        let dropped_at = 100usize; // inside the leading model block
        let fixture = fixture_path("runmap");
        let total = write_support_plate_stl(&fixture.0, Some(dropped_at));

        let bytes = load_stl_file_bytes(fixture.0.to_str().unwrap(), None, None).unwrap();
        let decoded = decode_stl_response(&bytes);
        let c = &decoded.classification;

        assert_eq!(c["dropped_nonfinite_triangles"].as_u64().unwrap(), 1);
        assert_eq!(c["source_triangle_count"].as_u64().unwrap() as usize, total);
        assert_eq!(
            c["run_count"].as_u64().unwrap() as usize,
            decoded.run_map.len(),
            "no cap was hit, so every run the classifier produced is present",
        );
        assert!(!decoded.run_map.is_empty(), "a split must emit a run map");

        // Ascending, disjoint, inside the FILE's index space.
        let mut previous_end = 0u32;
        for &(start, len) in &decoded.run_map {
            assert!(len > 0, "empty run");
            assert!(start >= previous_end, "runs must be ascending and disjoint");
            previous_end = start + len;
            assert!(
                previous_end as usize <= total,
                "run [{start}, {previous_end}) escapes the file's {total} triangles",
            );
        }

        let mapped: usize = decoded.run_map.iter().map(|&(_, len)| len as usize).sum();
        assert_eq!(
            mapped,
            c["model_triangle_count"].as_u64().unwrap() as usize,
            "the runs must cover exactly the model section",
        );

        // THE point of the compensation: the dropped file triangle is not a
        // model triangle any more, so no run may claim it — and the runs on
        // either side of it must still address the file, not the welded mesh.
        let covers_dropped = decoded
            .run_map
            .iter()
            .any(|&(start, len)| (dropped_at as u32) >= start && (dropped_at as u32) < start + len);
        assert!(
            !covers_dropped,
            "the run map claims file triangle {dropped_at}, which the intake dropped",
        );
        assert!(
            decoded.run_map.len() >= 3,
            "the interleaved fixture plus the drop must split into >=3 runs, got {:?}",
            decoded.run_map,
        );
    }

    /// The cap is a transport property, not a classification one: a map too
    /// large to carry is dropped, but `run_count` still reports what the
    /// classifier found so the reader knows to recompute rather than assuming
    /// "no split".
    #[test]
    fn run_map_over_the_cap_is_dropped_but_reported() {
        let mut classification = ImportClassification {
            model_triangle_count: Some(4),
            source_triangle_count: 8,
            ..Default::default()
        };
        classification.model_runs = (0..(STL_RESPONSE_RUN_MAP_MAX_ENTRIES + 1) as u32)
            .map(|i| dragonfruit_mesh_repair::TriangleRun {
                start: i * 2,
                len: 1,
            })
            .collect();

        let mesh = IndexedMesh::from_triangle_soup(
            &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            io::DEFAULT_MERGE_EPSILON,
        );
        let bytes = encode_stl_response(&mesh, 1, false, 0.0, 0, Some(&classification)).unwrap();
        let decoded = decode_stl_response(&bytes);

        assert!(decoded.run_map.is_empty(), "over-cap map must not be carried");
        assert_eq!(
            decoded.classification["run_count"].as_u64().unwrap() as usize,
            STL_RESPONSE_RUN_MAP_MAX_ENTRIES + 1,
            "the count must survive so the reader can tell 'too big' from 'no split'",
        );
    }
}

/// Ph3 — the run-map splice. These exercise `splice_fullres_stl_stream`'s
/// section filter and `resolve_splice_model_runs`'s recompute against the SAME
/// deliberately-interleaved model/support plate the Ph1 wiring tests use, so
/// "the first N triangles" cannot pass by accident.
#[cfg(test)]
mod ph3_run_map_splice_tests {
    use super::ph1_import_wiring_tests::{
        fixture_path, write_support_plate_stl, MODEL_TRIS, SUPPORT_TRIS,
    };
    use super::*;

    /// Whole-file params for the plate, in the identity frame (the section
    /// filter is what is under test, not the reprojection — that is R2's job).
    fn plate_params<'a>(
        path: &'a std::path::Path,
        section: SpliceSection,
        model_runs: Option<Vec<(u32, u32)>>,
    ) -> FullResSpliceParams<'a> {
        FullResSpliceParams {
            source_path: path,
            matrix16_col_major: IDENTITY_MATRIX16,
            c_pre: [0.0, 0.0, 0.0],
            expected_fingerprint: None,
            flip_winding_on_negative_determinant: false,
            section,
            model_runs,
        }
    }

    fn stream_section(
        path: &std::path::Path,
        section: SpliceSection,
        model_runs: Option<Vec<(u32, u32)>>,
    ) -> Result<(FullResSpliceStats, Vec<f32>), String> {
        let params = plate_params(path, section, model_runs);
        let mut soup: Vec<f32> = Vec::new();
        let stats = splice_fullres_stl_stream(&params, &[], |_, _| {}, |floats| {
            soup.extend_from_slice(floats);
            Ok(())
        })?;
        Ok((stats, soup))
    }

    /// The map the classifier produces for the plate fixture, obtained the same
    /// way production does — by classifying the file.
    pub(super) fn plate_model_runs(path: &std::path::Path) -> Vec<(u32, u32)> {
        let stat = stat_file_fingerprint(path).expect("stat fixture");
        // Clear the memo so this helper measures the file rather than whatever
        // a previous test left behind.
        if let Ok(mut cache) = recomputed_run_map_cache().lock() {
            *cache = None;
        }
        recompute_import_model_runs(path, &stat, Some("test"))
            .expect("recompute")
            .expect("the plate fixture has a model/support split")
            .as_ref()
            .clone()
    }

    /// PH3 RED #1. The model pass must stage the model RUNS, not a prefix.
    ///
    /// The fixture writes `model[..half] | supports | model[half..]`, so a
    /// splice that ignored the run map would stage all
    /// `MODEL_TRIS + SUPPORT_TRIS` triangles — which is exactly what the
    /// pre-Ph3 stream did, and what this asserts against.
    #[test]
    fn splice_streams_model_runs_only() {
        let fixture = fixture_path("ph3-model-section");
        let total = write_support_plate_stl(&fixture.0, None);
        assert_eq!(total, MODEL_TRIS + SUPPORT_TRIS);

        let runs = plate_model_runs(&fixture.0);
        assert!(
            runs.len() >= 2,
            "the fixture is interleaved, so the model section must need more than one run \
             (got {runs:?})",
        );

        let (stats, soup) = stream_section(&fixture.0, SpliceSection::Model, Some(runs.clone()))
            .expect("model pass");
        assert_eq!(stats.source_triangle_count, total as u64);
        assert_eq!(
            stats.staged_triangle_count, MODEL_TRIS as u64,
            "the model pass must stage exactly the run-map sum, not the whole file",
        );
        assert_eq!(soup.len(), MODEL_TRIS * 9);

        // The model shell sits at z >= 2.0; every support post spans z 0..1.
        // A prefix-splice would drag posts into the model block, which shows up
        // here and nowhere in a triangle count.
        let min_z = soup
            .chunks_exact(3)
            .map(|v| v[2])
            .fold(f32::INFINITY, f32::min);
        assert!(
            min_z >= 2.0 - 1e-5,
            "the model section must not contain support geometry (min z {min_z})",
        );
    }

    /// PH3 RED #2. Model + support must reconstruct the file exactly: every
    /// triangle staged once, none staged twice. This is the regression gate the
    /// plan names — "total staged triangle count identical to Ph1's".
    #[test]
    fn splice_sections_partition_the_source_exactly() {
        let fixture = fixture_path("ph3-partition");
        let total = write_support_plate_stl(&fixture.0, None) as u64;
        let runs = plate_model_runs(&fixture.0);

        let (model, model_soup) =
            stream_section(&fixture.0, SpliceSection::Model, Some(runs.clone())).expect("model");
        let (support, support_soup) =
            stream_section(&fixture.0, SpliceSection::Support, Some(runs)).expect("support");
        let (whole, whole_soup) = stream_section(&fixture.0, SpliceSection::All, None).expect("whole");

        assert_eq!(whole.staged_triangle_count, total);
        assert_eq!(
            model.staged_triangle_count + support.staged_triangle_count,
            total,
            "the two sections must partition the file — nothing dropped, nothing duplicated",
        );
        // `skipped` is what the command reports; here it is `source - staged`,
        // and each pass must have skipped exactly the other pass's block.
        assert_eq!(
            model.source_triangle_count - model.staged_triangle_count,
            support.staged_triangle_count,
        );
        assert_eq!(
            support.source_triangle_count - support.staged_triangle_count,
            model.staged_triangle_count,
        );
        assert_eq!(support.staged_triangle_count, SUPPORT_TRIS as u64);

        // Same triangles, reordered — the concatenation is a permutation of the
        // whole-file soup, so the section split cannot have altered geometry.
        let mut rejoined: Vec<f32> = model_soup;
        rejoined.extend_from_slice(&support_soup);
        assert_eq!(rejoined.len(), whole_soup.len());
        let sum_of = |v: &[f32]| v.iter().map(|f| *f as f64).sum::<f64>();
        assert!((sum_of(&rejoined) - sum_of(&whole_soup)).abs() < 1e-3);
    }

    /// PH3 RED #3. `resolveImportRunMap` returns `recompute` for four distinct
    /// reasons; all four land here, and the remedy is one code path. With no
    /// map supplied, a sectioned pass must re-derive it from the file rather
    /// than degrade to "everything is model".
    #[test]
    fn splice_recomputes_map_when_absent() {
        let fixture = fixture_path("ph3-recompute");
        let total = write_support_plate_stl(&fixture.0, None) as u64;
        let stat = stat_file_fingerprint(&fixture.0).expect("stat");

        for reason in ["over-cap", "not-persisted", "chunk-missing", "chunk-damaged"] {
            if let Ok(mut cache) = recomputed_run_map_cache().lock() {
                *cache = None;
            }
            let (runs, source) =
                resolve_splice_model_runs(&fixture.0, &stat, SpliceSection::Model, None, Some(reason))
                    .expect("recompute resolves");
            assert_eq!(
                source,
                RunMapSource::Recomputed,
                "reason '{reason}' must produce a recomputed map, not a silent whole-file pass",
            );
            let runs = runs.expect("the plate has a split");
            let mapped: u64 = runs.iter().map(|(_, len)| u64::from(*len)).sum();
            assert_eq!(mapped, MODEL_TRIS as u64);

            let (stats, _) = stream_section(&fixture.0, SpliceSection::Model, Some(runs))
                .expect("model pass on the recomputed map");
            assert_eq!(stats.staged_triangle_count, MODEL_TRIS as u64);
            assert_eq!(stats.source_triangle_count, total);
        }
    }

    /// The memo is what keeps one job's model pass and support pass from paying
    /// for two classifies, and it is fingerprint-keyed so an edited file is
    /// never served the old map.
    #[test]
    fn recomputed_run_map_is_memoised_per_fingerprint() {
        let fixture = fixture_path("ph3-memo");
        write_support_plate_stl(&fixture.0, None);
        let stat = stat_file_fingerprint(&fixture.0).expect("stat");
        if let Ok(mut cache) = recomputed_run_map_cache().lock() {
            *cache = None;
        }

        let first =
            recompute_import_model_runs(&fixture.0, &stat, Some("over-cap")).expect("first recompute");
        {
            let cache = recomputed_run_map_cache().lock().expect("memo");
            let (key, _) = cache.as_ref().expect("memo populated");
            assert_eq!(key.size_bytes, stat.size_bytes);
            assert_eq!(key.mtime_ms_bits, stat.mtime_ms.to_bits());
        }
        let second =
            recompute_import_model_runs(&fixture.0, &stat, Some("over-cap")).expect("memo hit");
        assert_eq!(first.as_deref(), second.as_deref());

        // A different fingerprint for the same path must miss.
        let stale = SourceFileStat {
            size_bytes: stat.size_bytes + 1,
            mtime_ms: stat.mtime_ms,
        };
        let refreshed = recompute_import_model_runs(&fixture.0, &stale, Some("over-cap"))
            .expect("re-derive under a new fingerprint");
        assert_eq!(first.as_deref(), refreshed.as_deref());
        let cache = recomputed_run_map_cache().lock().expect("memo");
        assert_eq!(
            cache.as_ref().expect("memo populated").0.size_bytes,
            stale.size_bytes,
            "the memo must now hold the newer key",
        );
    }

    /// A map that does not describe the file it is paired with is REFUSED. It
    /// would not produce a slightly-wrong partition — it would produce a
    /// confidently wrong one, which is the failure class this arc exists to
    /// remove.
    #[test]
    fn splice_refuses_a_run_map_that_cannot_describe_the_file() {
        let fixture = fixture_path("ph3-invalid-map");
        let total = write_support_plate_stl(&fixture.0, None) as u32;

        let out_of_range =
            stream_section(&fixture.0, SpliceSection::Model, Some(vec![(total - 1, 5)]))
                .expect_err("a run past the end of the file must be refused");
        assert!(
            out_of_range.starts_with(FULLRES_RUN_MAP_INVALID_PREFIX),
            "{out_of_range}",
        );

        let overlapping =
            stream_section(&fixture.0, SpliceSection::Model, Some(vec![(10, 20), (15, 5)]))
                .expect_err("overlapping runs must be refused");
        assert!(
            overlapping.starts_with(FULLRES_RUN_MAP_INVALID_PREFIX),
            "{overlapping}",
        );

        let empty = stream_section(&fixture.0, SpliceSection::Model, Some(Vec::new()))
            .expect_err("an empty map paired with a section request is a contradiction");
        assert!(empty.starts_with(FULLRES_RUN_MAP_INVALID_PREFIX), "{empty}");

        assert!(
            decode_flat_run_map(&[1, 2, 3]).is_err(),
            "an odd-length flat map is damaged, not short",
        );
    }

    /// The absence of a split is not a split covering everything — but for the
    /// SPLICE it is, and `section_emit_segments` is the one place that
    /// translation happens.
    #[test]
    fn a_source_with_no_split_stages_wholly_as_model() {
        let model = section_emit_segments(SpliceSection::Model, None, 100).expect("model");
        assert_eq!(model, vec![(0, 100)]);
        let support = section_emit_segments(SpliceSection::Support, None, 100).expect("support");
        assert!(support.is_empty());

        // Complement arithmetic, including both edges.
        let leading = section_emit_segments(SpliceSection::Support, Some(&[(0, 10)]), 100).unwrap();
        assert_eq!(leading, vec![(10, 90)]);
        let trailing = section_emit_segments(SpliceSection::Support, Some(&[(90, 10)]), 100).unwrap();
        assert_eq!(trailing, vec![(0, 90)]);
        let interleaved =
            section_emit_segments(SpliceSection::Support, Some(&[(10, 10), (40, 10)]), 100).unwrap();
        assert_eq!(interleaved, vec![(0, 10), (20, 20), (50, 50)]);
        let exact = section_emit_segments(SpliceSection::Support, Some(&[(0, 100)]), 100).unwrap();
        assert!(
            exact.is_empty(),
            "a model section covering the file leaves no support section",
        );
    }
}

/// Ph3b — hollow section-awareness, Rust half.
///
/// Ph3 gave the SLICING splice a section parameter. The permanent mutators kept
/// splicing the whole file, so hollowing a pre-supported import voxelised the
/// supports along with the model body. These exercise the two commands that fix
/// it, against the same interleaved plate fixture Ph1/Ph3 use — so "the first N
/// triangles" cannot pass by accident.
#[cfg(test)]
mod ph3b_hollow_section_tests {
    use super::ph1_import_wiring_tests::{
        fixture_path, write_support_plate_stl, MODEL_TRIS, SUPPORT_TRIS,
    };
    use super::ph3_run_map_splice_tests::plate_model_runs;
    use super::*;

    /// PH3b RED #1. The mutator splice must stage the MODEL section only when
    /// asked, in the local mutator frame (identity matrix, no winding flip).
    /// Before Ph3b `mutator_splice_soup` did not exist and
    /// `stage_fullres_mesh_into_staged` hard-coded `SpliceSection::All`.
    #[test]
    fn mutator_splice_stages_the_model_section_only() {
        let fixture = fixture_path("ph3b-model-section");
        let total = write_support_plate_stl(&fixture.0, None);
        assert_eq!(total, MODEL_TRIS + SUPPORT_TRIS);
        let runs = plate_model_runs(&fixture.0);

        let (stats, soup) = mutator_splice_soup(&MutatorSpliceRequest {
            path: &fixture.0,
            c_pre: [0.0, 0.0, 0.0],
            expected_fingerprint: None,
            section: SpliceSection::Model,
            model_runs: Some(runs),
            run_map_source: RunMapSource::Provided,
        })
        .expect("model pass");

        assert_eq!(stats.source_triangle_count, total as u64);
        assert_eq!(
            stats.staged_triangle_count, MODEL_TRIS as u64,
            "hollowing must see the model runs, not the whole plate",
        );
        assert_eq!(soup.len(), MODEL_TRIS * 9 * 4, "raw f32 LE, 9 floats/triangle");

        // The model shell sits at z >= 2.0; every support post spans z 0..1. A
        // prefix splice would drag posts into the block that gets voxelised,
        // which shows up here and in no triangle count.
        let floats: &[f32] = bytemuck::cast_slice(&soup);
        let min_z = floats.chunks_exact(3).map(|v| v[2]).fold(f32::INFINITY, f32::min);
        assert!(
            min_z >= 2.0 - 1e-5,
            "the hollowed section must contain no support geometry (min z {min_z})",
        );
    }

    /// PH3b RED #2. The support read-back must be EXACTLY the complement of what
    /// the model pass skipped, and the two together must reconstruct the file.
    /// This is the arithmetic the frontend asserts on before it re-appends —
    /// without it, "supports are preserved" would be a claim rather than a check.
    #[test]
    fn mutator_sections_partition_the_source_for_re_append() {
        let fixture = fixture_path("ph3b-partition");
        let total = write_support_plate_stl(&fixture.0, None) as u64;
        let runs = plate_model_runs(&fixture.0);

        let request = |section: SpliceSection| MutatorSpliceRequest {
            path: &fixture.0,
            c_pre: [0.0, 0.0, 0.0],
            expected_fingerprint: None,
            section,
            model_runs: Some(runs.clone()),
            run_map_source: RunMapSource::Provided,
        };

        let (model, model_soup) =
            mutator_splice_soup(&request(SpliceSection::Model)).expect("model");
        let (support, support_soup) =
            mutator_splice_soup(&request(SpliceSection::Support)).expect("support");
        let (whole, whole_soup) = mutator_splice_soup(&MutatorSpliceRequest {
            path: &fixture.0,
            c_pre: [0.0, 0.0, 0.0],
            expected_fingerprint: None,
            section: SpliceSection::All,
            model_runs: None,
            run_map_source: RunMapSource::NotRequired,
        })
        .expect("whole");

        assert_eq!(whole.staged_triangle_count, total);
        assert_eq!(support.staged_triangle_count, SUPPORT_TRIS as u64);
        assert_eq!(
            model.source_triangle_count - model.staged_triangle_count,
            support.staged_triangle_count,
            "the support read-back must be exactly what the model pass skipped — this is the \
             equality the re-append is gated on",
        );

        // Concatenating in re-append order reproduces the file's bytes as a
        // permutation: the split cannot have altered geometry.
        let mut rejoined = model_soup;
        rejoined.extend_from_slice(&support_soup);
        assert_eq!(rejoined.len(), whole_soup.len());
        let sum_of = |bytes: &[u8]| {
            bytemuck::cast_slice::<u8, f32>(bytes)
                .iter()
                .map(|f| *f as f64)
                .sum::<f64>()
        };
        assert!((sum_of(&rejoined) - sum_of(&whole_soup)).abs() < 1e-3);
    }

    /// The mutator's LOCAL frame is `v_local = v_raw − T_center` with an identity
    /// matrix and NO winding flip — the same contract Phase 4 established for the
    /// whole-file mutator splice. Sectioning must not quietly change it, because
    /// a frame error here fails as a whole-model shift that looks like a
    /// placement bug.
    #[test]
    fn mutator_section_keeps_the_local_frame_and_winding() {
        let fixture = fixture_path("ph3b-frame");
        write_support_plate_stl(&fixture.0, None);
        let runs = plate_model_runs(&fixture.0);
        let c_pre = [1.5, -2.25, 0.75];

        let (_, centered) = mutator_splice_soup(&MutatorSpliceRequest {
            path: &fixture.0,
            c_pre,
            expected_fingerprint: None,
            section: SpliceSection::Model,
            model_runs: Some(runs.clone()),
            run_map_source: RunMapSource::Provided,
        })
        .expect("centered model pass");
        let (_, raw) = mutator_splice_soup(&MutatorSpliceRequest {
            path: &fixture.0,
            c_pre: [0.0, 0.0, 0.0],
            expected_fingerprint: None,
            section: SpliceSection::Model,
            model_runs: Some(runs),
            run_map_source: RunMapSource::Provided,
        })
        .expect("raw model pass");

        let centered: &[f32] = bytemuck::cast_slice(&centered);
        let raw: &[f32] = bytemuck::cast_slice(&raw);
        assert_eq!(centered.len(), raw.len());
        for (index, (c, r)) in centered.iter().zip(raw.iter()).enumerate() {
            let axis = index % 3;
            assert!(
                (*c as f64 - (*r as f64 - c_pre[axis])).abs() < 1e-3,
                "vertex float {index} (axis {axis}) is not v_raw − c_pre",
            );
        }
    }

    /// Absence of a section request must reproduce the pre-Ph3b whole-file
    /// mutator splice byte for byte. A model with no support section is the
    /// common case, and it must not start paying for a section walk.
    #[test]
    fn a_mutator_splice_without_a_section_is_the_whole_file() {
        let fixture = fixture_path("ph3b-whole");
        let total = write_support_plate_stl(&fixture.0, None) as u64;

        let (stats, soup) = mutator_splice_soup(&MutatorSpliceRequest {
            path: &fixture.0,
            c_pre: [0.0, 0.0, 0.0],
            expected_fingerprint: None,
            section: SpliceSection::All,
            model_runs: None,
            run_map_source: RunMapSource::NotRequired,
        })
        .expect("whole pass");
        assert_eq!(stats.staged_triangle_count, total);
        assert_eq!(soup.len() as u64, total * 9 * 4);
        assert_eq!(SpliceSection::parse(None).expect("default"), SpliceSection::All);
    }
}
