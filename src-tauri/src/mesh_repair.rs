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

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use dragonfruit_mesh_repair::{
    analyze, classify_support_split, hollow_voxel, io, punch_cylinders, repair, HolePunchOptions,
    HollowOptions, HollowSession, IndexedMesh, RepairOptions, Vec3,
};
// The organic cut feature now lives in its own crate.
use dragonfruit_organic_cut::{organic_cut, GeodesicSolver, OrganicCutOptions};
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
/// Captured source mesh for repeated non-mutating organic-cut runs.
static ORGANIC_CUT_SOURCE_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
/// Result of the most recent organic cut: the two split parts (LE f32 soup).
static ORGANIC_CUT_PART_A_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
static ORGANIC_CUT_PART_B_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
/// Most recent geodesic loop polyline (LE f32 positions, 3 per point).
static ORGANIC_CUT_GEODESIC_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
/// Cached geodesic solver (mesh + topology + vertex graph) for the captured
/// source. Built once per source so dragging a waypoint re-queries the loop
/// without rebuilding the O(mesh) graphs each call. Cleared on (re)capture.
static ORGANIC_CUT_GEODESIC_SOLVER: OnceLock<Mutex<Option<Arc<GeodesicSolver>>>> = OnceLock::new();
/// Most recent contour-cut membrane preview (LE f32 triangle soup, 9 per tri).
static ORGANIC_CUT_MEMBRANE_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();

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

fn organic_cut_source_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    ORGANIC_CUT_SOURCE_BYTES.get_or_init(|| Mutex::new(None))
}

fn organic_cut_part_a_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    ORGANIC_CUT_PART_A_BYTES.get_or_init(|| Mutex::new(None))
}

fn organic_cut_part_b_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    ORGANIC_CUT_PART_B_BYTES.get_or_init(|| Mutex::new(None))
}

fn organic_cut_geodesic_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    ORGANIC_CUT_GEODESIC_BYTES.get_or_init(|| Mutex::new(None))
}

fn organic_cut_geodesic_solver() -> &'static Mutex<Option<Arc<GeodesicSolver>>> {
    ORGANIC_CUT_GEODESIC_SOLVER.get_or_init(|| Mutex::new(None))
}

fn organic_cut_membrane_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    ORGANIC_CUT_MEMBRANE_BYTES.get_or_init(|| Mutex::new(None))
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

fn parse_organic_cut_options(options_json: &str) -> OrganicCutOptions {
    if options_json.trim().is_empty() {
        return OrganicCutOptions::default();
    }

    serde_json::from_str::<OrganicCutOptions>(options_json).unwrap_or_default()
}

#[derive(Deserialize)]
struct GeodesicWaypointDto {
    position: [f32; 3],
}

fn default_smoothing_half() -> f32 {
    0.5
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeodesicRequestDto {
    #[serde(default)]
    points: Vec<GeodesicWaypointDto>,
    #[serde(default)]
    close: bool,
    /// Seam smoothing 0..1 (line corner-rounding). Default 0.5.
    #[serde(default = "default_smoothing_half")]
    smoothing: f32,
    /// Membrane smoothing 0..1 (cutter-surface relaxation). Default 0.5.
    #[serde(default = "default_smoothing_half")]
    membrane_smoothing: f32,
    /// Cut resolution multiplier (1..4). Default 1.0. Lets the preview reflect
    /// the cut density live.
    #[serde(default = "default_density_one")]
    density: f32,
    /// Cutter thickness in mm. Default 0.1 (the cut's default kerf). Lets the
    /// cutter preview show the REAL slab thickness, not a zero-width sheet.
    #[serde(default = "default_thickness_tenth")]
    thickness_mm: f32,
}

fn default_density_one() -> f32 {
    1.0
}

fn default_thickness_tenth() -> f32 {
    0.1
}

impl Default for GeodesicRequestDto {
    fn default() -> Self {
        Self {
            points: Vec::new(),
            close: false,
            smoothing: 0.5,
            membrane_smoothing: 0.5,
            density: 1.0,
            thickness_mm: 0.1,
        }
    }
}

fn parse_geodesic_request(json: &str) -> GeodesicRequestDto {
    if json.trim().is_empty() {
        return GeodesicRequestDto::default();
    }
    serde_json::from_str::<GeodesicRequestDto>(json).unwrap_or_default()
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
        if session.voxel_resolution() == options.voxel_resolution {
            session
        } else {
            let source_mesh_for_build = source_mesh.clone();
            let resolution = options.voxel_resolution;
            let session = tauri::async_runtime::spawn_blocking(move || {
                Ok::<_, String>(Arc::new(HollowSession::new(
                    (*source_mesh_for_build).clone(),
                    resolution,
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
        let session = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, String>(Arc::new(HollowSession::new(
                (*source_mesh_for_build).clone(),
                resolution,
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
        if session.voxel_resolution() == options.voxel_resolution {
            session
        } else {
            let source_mesh_for_build = source_mesh.clone();
            let resolution = options.voxel_resolution;
            let session = tauri::async_runtime::spawn_blocking(move || {
                Ok::<_, String>(Arc::new(HollowSession::new(
                    (*source_mesh_for_build).clone(),
                    resolution,
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
        let session = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, String>(Arc::new(HollowSession::new(
                (*source_mesh_for_build).clone(),
                resolution,
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

// --- organic cut ---------------------------------------------------------

/// Applies an organic cut to the current staged mesh, replacing the staged
/// buffer with part A and stashing both parts for read-back.
///
/// M1: the cut is a no-op (both parts equal the source mesh); this proves the
/// stage → cut → read-two-parts → render round-trip end to end.
#[tauri::command]
pub async fn mesh_organic_cut_staged(options_json: String) -> Result<String, String> {
    let options = parse_organic_cut_options(&options_json);
    let bytes = read_staging_bytes()?;
    let (part_a, part_b, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let outcome = organic_cut(mesh, &options);
        Ok::<_, String>((outcome.part_a, outcome.part_b, outcome.report))
    })
    .await
    .map_err(|e| format!("organic cut task panicked: {e}"))??;

    let part_a_soup: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&part_a.to_triangle_soup()).to_vec();
    let part_b_soup: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&part_b.to_triangle_soup()).to_vec();

    *organic_cut_part_a_bytes()
        .lock()
        .map_err(|e| format!("organic cut part A lock poisoned: {e}"))? = Some(part_a_soup);
    *organic_cut_part_b_bytes()
        .lock()
        .map_err(|e| format!("organic cut part B lock poisoned: {e}"))? = Some(part_b_soup);

    // Keep the staged buffer pointed at part A so existing read paths stay valid.
    replace_staging_with_mesh(&part_a)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize organic cut report: {e}"))
}

/// Captures the current staged mesh bytes as the source for repeated
/// non-mutating organic-cut runs.
#[tauri::command]
pub async fn mesh_organic_cut_capture_staged_source() -> Result<(), String> {
    let bytes = read_staging_bytes()?;
    *organic_cut_source_bytes()
        .lock()
        .map_err(|e| format!("organic cut source lock poisoned: {e}"))? = Some(bytes);
    *organic_cut_part_a_bytes()
        .lock()
        .map_err(|e| format!("organic cut part A lock poisoned: {e}"))? = None;
    *organic_cut_part_b_bytes()
        .lock()
        .map_err(|e| format!("organic cut part B lock poisoned: {e}"))? = None;
    // Invalidate the cached geodesic solver — it belongs to the previous source.
    // The next geodesic call rebuilds it lazily for the new mesh.
    *organic_cut_geodesic_solver()
        .lock()
        .map_err(|e| format!("organic cut solver lock poisoned: {e}"))? = None;
    Ok(())
}

/// Runs an organic cut against the captured source mesh without mutating the
/// regular staged mesh buffer. Stashes both parts for read-back.
#[tauri::command]
pub async fn mesh_organic_cut_from_captured_source(options_json: String) -> Result<String, String> {
    let options = parse_organic_cut_options(&options_json);
    let source_bytes = organic_cut_source_bytes()
        .lock()
        .map_err(|e| format!("organic cut source lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No captured organic cut source — call mesh_organic_cut_capture_staged_source first"
                .to_string()
        })?;

    let (part_a_soup, part_b_soup, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&source_bytes).map_err(|e| e.to_string())?;
        let outcome = organic_cut(mesh, &options);
        let a: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&outcome.part_a.to_triangle_soup()).to_vec();
        let b: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&outcome.part_b.to_triangle_soup()).to_vec();
        Ok::<_, String>((a, b, outcome.report))
    })
    .await
    .map_err(|e| format!("organic cut task panicked: {e}"))??;

    *organic_cut_part_a_bytes()
        .lock()
        .map_err(|e| format!("organic cut part A lock poisoned: {e}"))? = Some(part_a_soup);
    *organic_cut_part_b_bytes()
        .lock()
        .map_err(|e| format!("organic cut part B lock poisoned: {e}"))? = Some(part_b_soup);

    serde_json::to_string(&report).map_err(|e| format!("serialize organic cut report: {e}"))
}

/// Returns the most recent organic-cut part A positions as raw LE bytes.
#[tauri::command]
pub async fn mesh_organic_cut_read_part_a() -> Result<Response, String> {
    let bytes = organic_cut_part_a_bytes()
        .lock()
        .map_err(|e| format!("organic cut part A lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| "No organic cut result — run a cut first".to_string())?;
    Ok(Response::new(bytes))
}

/// Returns the most recent organic-cut part B positions as raw LE bytes.
#[tauri::command]
pub async fn mesh_organic_cut_read_part_b() -> Result<Response, String> {
    let bytes = organic_cut_part_b_bytes()
        .lock()
        .map_err(|e| format!("organic cut part B lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| "No organic cut result — run a cut first".to_string())?;
    Ok(Response::new(bytes))
}

/// Computes a surface-following (Stage-1 edge-path) loop through the given
/// waypoints against the captured organic-cut source mesh, and stores the
/// resulting polyline for read-back. Returns the point count as JSON.
///
/// The frontend sends `{ points: [{position:[x,y,z]}...], close: bool }` in the
/// model's local space (same space as the cut). The returned polyline is LE f32
/// (3 floats per point) and can be rendered directly as the on-surface seam.
#[tauri::command]
pub async fn mesh_organic_cut_geodesic_loop(request_json: String) -> Result<String, String> {
    let req = parse_geodesic_request(&request_json);
    if req.points.len() < 2 {
        // Not enough points yet — clear any stale polyline and report 0.
        *organic_cut_geodesic_bytes()
            .lock()
            .map_err(|e| format!("geodesic lock poisoned: {e}"))? = None;
        return Ok("{\"pointCount\":0}".to_string());
    }

    let (bytes, count) = compute_geodesic_loop_bytes(&req).await?;
    *organic_cut_geodesic_bytes()
        .lock()
        .map_err(|e| format!("geodesic lock poisoned: {e}"))? = Some(bytes);
    Ok(format!("{{\"pointCount\":{count}}}"))
}

/// Single-round-trip geodesic: computes the loop and returns the raw LE f32
/// polyline bytes DIRECTLY as the response body, skipping the separate
/// stash + read-back command pair. This is the hot path used while dragging a
/// waypoint — one IPC hop per frame instead of two. Returns an empty body for
/// <2 points. (Also stashes the bytes so a later `read_geodesic` still works.)
#[tauri::command]
pub async fn mesh_organic_cut_geodesic_loop_bytes(request_json: String) -> Result<Response, String> {
    let req = parse_geodesic_request(&request_json);
    if req.points.len() < 2 {
        *organic_cut_geodesic_bytes()
            .lock()
            .map_err(|e| format!("geodesic lock poisoned: {e}"))? = None;
        return Ok(Response::new(Vec::new()));
    }

    let (bytes, _count) = compute_geodesic_loop_bytes(&req).await?;
    *organic_cut_geodesic_bytes()
        .lock()
        .map_err(|e| format!("geodesic lock poisoned: {e}"))? = Some(bytes.clone());
    Ok(Response::new(bytes))
}

/// Fetches the cached geodesic solver, building it once from the captured source
/// if absent. Building (parse + topology + vertex graph) is O(mesh) and dominates
/// a single query, so caching it makes dragging a waypoint cheap — each query is
/// then only Dijkstra + path straightening.
async fn geodesic_solver_or_build() -> Result<Arc<GeodesicSolver>, String> {
    let cached = organic_cut_geodesic_solver()
        .lock()
        .map_err(|e| format!("organic cut solver lock poisoned: {e}"))?
        .clone();
    if let Some(s) = cached {
        return Ok(s);
    }
    let source_bytes = organic_cut_source_bytes()
        .lock()
        .map_err(|e| format!("organic cut source lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| {
            "No captured source — call mesh_organic_cut_capture_staged_source first".to_string()
        })?;
    let built = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&source_bytes).map_err(|e| e.to_string())?;
        Ok::<_, String>(Arc::new(GeodesicSolver::build(mesh)))
    })
    .await
    .map_err(|e| format!("geodesic solver build panicked: {e}"))??;
    *organic_cut_geodesic_solver()
        .lock()
        .map_err(|e| format!("organic cut solver lock poisoned: {e}"))? = Some(built.clone());
    Ok(built)
}

/// Computes the geodesic loop for a request against the cached solver, returning
/// the flat LE f32 polyline bytes plus the point count. Shared by the JSON and
/// raw-bytes command variants. Caller must have validated `points.len() >= 2`.
async fn compute_geodesic_loop_bytes(req: &GeodesicRequestDto) -> Result<(Vec<u8>, usize), String> {
    let solver = geodesic_solver_or_build().await?;
    let waypoints: Vec<Vec3> = req
        .points
        .iter()
        .map(|p| Vec3::new(p.position[0], p.position[1], p.position[2]))
        .collect();
    let close = req.close;
    let smoothing = req.smoothing;

    tauri::async_runtime::spawn_blocking(move || {
        let loop_pts = solver
            .surface_loop_smoothed(&waypoints, close, smoothing)
            .ok_or_else(|| "geodesic loop could not be computed".to_string())?;
        let flat: Vec<f32> = loop_pts.iter().flat_map(|v| [v.x, v.y, v.z]).collect();
        let bytes: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&flat).to_vec();
        Ok::<_, String>((bytes, loop_pts.len()))
    })
    .await
    .map_err(|e| format!("geodesic task panicked: {e}"))?
}

/// Returns the most recent geodesic loop polyline as raw LE f32 bytes.
#[tauri::command]
pub async fn mesh_organic_cut_read_geodesic() -> Result<Response, String> {
    let bytes = organic_cut_geodesic_bytes()
        .lock()
        .map_err(|e| format!("geodesic lock poisoned: {e}"))?
        .clone()
        .unwrap_or_default();
    Ok(Response::new(bytes))
}

/// Builds the contour-cut MEMBRANE for the given loop and stashes it as a
/// triangle soup for previewing. Uses the same loop the cut would (the dense
/// geodesic points the frontend passes here), so what's rendered IS the cutter
/// surface. Returns `{"triangleCount":N}`; read the bytes via
/// `mesh_organic_cut_read_membrane`.
#[tauri::command]
pub async fn mesh_organic_cut_membrane_preview(request_json: String) -> Result<String, String> {
    let req = parse_geodesic_request(&request_json);
    if req.points.len() < 3 {
        *organic_cut_membrane_bytes()
            .lock()
            .map_err(|e| format!("membrane lock poisoned: {e}"))? = None;
        return Ok("{\"triangleCount\":0}".to_string());
    }

    let loop_pts: Vec<Vec3> = req
        .points
        .iter()
        .map(|p| Vec3::new(p.position[0], p.position[1], p.position[2]))
        .collect();
    let membrane_smoothing = req.membrane_smoothing;
    let density = req.density;
    let thickness_mm = req.thickness_mm;

    // Use the captured cut SOURCE mesh so the preview can apply the real loop
    // offset (needs surface normals) and show the REAL cutter slab — exactly what
    // cuts. Falls back to the bare-membrane preview if no source is captured yet.
    let source_bytes = organic_cut_source_bytes()
        .lock()
        .map_err(|e| format!("organic cut source lock poisoned: {e}"))?
        .clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let soup = if let Some(bytes) = source_bytes {
            let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
            dragonfruit_organic_cut::membrane::build_cutter_preview_soup(
                &mesh,
                &loop_pts,
                thickness_mm,
                membrane_smoothing,
                density,
            )
            .ok_or_else(|| "cutter could not be built from the loop".to_string())?
        } else {
            // No captured source yet → bare membrane on the raw loop (no offset).
            dragonfruit_organic_cut::membrane::build_membrane_preview_soup_full(
                &loop_pts,
                membrane_smoothing,
                density,
            )
            .ok_or_else(|| "membrane could not be built from the loop".to_string())?
        };
        let tri_count = soup.len() / 9;
        let bytes: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&soup).to_vec();
        Ok::<_, String>((bytes, tri_count))
    })
    .await
    .map_err(|e| format!("membrane preview task panicked: {e}"))??;

    let (bytes, tri_count) = result;
    *organic_cut_membrane_bytes()
        .lock()
        .map_err(|e| format!("membrane lock poisoned: {e}"))? = Some(bytes);
    Ok(format!("{{\"triangleCount\":{tri_count}}}"))
}

/// Returns the most recent membrane preview as raw LE f32 triangle-soup bytes.
#[tauri::command]
pub async fn mesh_organic_cut_read_membrane() -> Result<Response, String> {
    let bytes = organic_cut_membrane_bytes()
        .lock()
        .map_err(|e| format!("membrane lock poisoned: {e}"))?
        .clone()
        .unwrap_or_default();
    Ok(Response::new(bytes))
}

/// Returns the current staged positions buffer as raw little-endian bytes.
/// Used by the frontend to hydrate a `THREE.BufferGeometry` after a repair.
#[tauri::command]
pub async fn mesh_repair_read_positions() -> Result<Response, String> {
    let bytes = read_staging_bytes()?;
    Ok(Response::new(bytes))
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
