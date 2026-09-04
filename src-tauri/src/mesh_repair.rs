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
// The organic cut feature now lives in its own crate.
use dragonfruit_organic_cut::{organic_cut, GeodesicSolver, OrganicCutOptions};
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
/// Captured source mesh for repeated non-mutating organic-cut runs.
static ORGANIC_CUT_SOURCE_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
/// All parts of the most recent organic cut (LE f32 soup each), in order — read
/// back by index via `mesh_organic_cut_read_part`. A multi-loop cut that frees
/// several pieces has >2 entries.
static ORGANIC_CUT_PARTS_BYTES: OnceLock<Mutex<Vec<Vec<u8>>>> = OnceLock::new();
/// Most recent geodesic loop polyline (LE f32 positions, 3 per point).
static ORGANIC_CUT_GEODESIC_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
/// Cached geodesic solver (mesh + topology + vertex graph) for the captured
/// source. Built once per source so dragging a waypoint re-queries the loop
/// without rebuilding the O(mesh) graphs each call. Cleared on (re)capture.
static ORGANIC_CUT_GEODESIC_SOLVER: OnceLock<Mutex<Option<Arc<GeodesicSolver>>>> = OnceLock::new();
/// Most recent contour-cut membrane preview (LE f32 triangle soup, 9 per tri).
static ORGANIC_CUT_MEMBRANE_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
/// Most recent registration-tenon preview (LE f32 triangle soup, tenon + mortise).
static ORGANIC_CUT_TENON_BYTES: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();

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

fn organic_cut_source_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    ORGANIC_CUT_SOURCE_BYTES.get_or_init(|| Mutex::new(None))
}

fn organic_cut_parts_bytes() -> &'static Mutex<Vec<Vec<u8>>> {
    ORGANIC_CUT_PARTS_BYTES.get_or_init(|| Mutex::new(Vec::new()))
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

fn organic_cut_tenon_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    ORGANIC_CUT_TENON_BYTES.get_or_init(|| Mutex::new(None))
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
    #[serde(alias = "assume_support_geometry")]
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
            assume_support_geometry: dto
                .assume_support_geometry
                .or(defaults.assume_support_geometry),
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
    /// Extra clearance in mm for the mortise-and-tenon joint, on top of the tenon's
    /// own tolerance. Zero — the default — means the halves meet exactly. Previewed
    /// with the same number the cut spends, or the preview lies about the fit. Was
    /// `thicknessMm` when the cut was a wafer whose thickness was structural.
    #[serde(default, alias = "thicknessMm")]
    joint_clearance_mm: f32,
    /// When true, the preview also builds the registration tenon (tenon + mortise) the
    /// cut would place, so the user sees it before cutting. Default off.
    #[serde(default)]
    generate_tenon: bool,
    /// Tenon base width in mm (model units are mm). Default 2.
    #[serde(default = "default_tenon_width")]
    tenon_width_mm: f32,
    /// Tenon depth in mm — how far the tenon pokes in. Default 2.5.
    #[serde(default = "default_tenon_depth")]
    tenon_depth_mm: f32,
    /// Requested tenon shape: "frustum" (default) or "dome". Default "frustum".
    #[serde(default = "default_tenon_shape")]
    tenon_shape: String,
    /// Edge fillet radius in mm (rounds the frustum corners + tip). Default 0.
    #[serde(default)]
    tenon_fillet_mm: f32,
    /// Tenon/mortise fit tolerance in mm — how much larger the mortise is carved on
    /// every face. 0 = press fit. Default 0.1 (slide fit).
    #[serde(default = "default_tenon_tolerance")]
    tenon_tolerance_mm: f32,
    /// Where the tenon sits on the cut face: the model-local point the user put the
    /// crosshair on. Absent = the natural middle of the cut.
    #[serde(default)]
    tenon_anchor: Option<[f32; 3]>,
    /// Flat-cut only: the plane the tenon is framed on, as `dot(normal, p) == offset`
    /// in model-local space — the exact plane the frontend previewed. Absent for a
    /// contour preview, which frames the tenon on the membrane instead.
    #[serde(default)]
    plane_normal: [f32; 3],
    #[serde(default)]
    plane_offset: f32,
    /// Flip which half gets the tenon vs the mortise (preview reflects the direction).
    #[serde(default)]
    tenon_swap_sides: bool,
    /// Tenon tilt (radians) — polar lean off the cut normal. Base stays glued; the
    /// body shears to lean. Default 0.
    #[serde(default)]
    tenon_tilt_rad: f32,
    /// Tenon roll (radians) — spin about the tenon's own axis. Default 0.
    #[serde(default)]
    tenon_roll_rad: f32,
}

fn default_density_one() -> f32 {
    1.0
}

fn default_tenon_width() -> f32 {
    2.0
}

fn default_tenon_depth() -> f32 {
    2.5
}

fn default_tenon_shape() -> String {
    "frustum".to_string()
}

fn default_tenon_tolerance() -> f32 {
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
            joint_clearance_mm: 0.0,
            generate_tenon: false,
            tenon_width_mm: 2.0,
            tenon_depth_mm: 2.5,
            tenon_shape: "frustum".to_string(),
            tenon_fillet_mm: 0.0,
            tenon_tolerance_mm: 0.1,
            tenon_anchor: None,
            plane_normal: [0.0; 3],
            plane_offset: 0.0,
            tenon_swap_sides: false,
            tenon_tilt_rad: 0.0,
            tenon_roll_rad: 0.0,
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
pub async fn mesh_classify_staged(options_json: Option<String>) -> Result<String, String> {
    let options = parse_options(&options_json.unwrap_or_default())?;
    let bytes = read_staging_bytes()?;
    let (mesh, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let outcome = classify_support_split(mesh, &options);
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

// --- organic cut ---------------------------------------------------------

/// Writes the EXACT inputs of an organic cut to disk when `DF_CUT_DUMP` names a
/// directory: the staged mesh as raw LE f32 soup (`cut-<n>.bin`) and the options
/// JSON (`cut-<n>.json`), numbered so a session keeps every attempt. The pair is
/// a complete, lossless replay of the cut — feed it to the `cut_replay` binary in
/// `dragonfruit-organic-cut` to reproduce a bad cut outside the app. Off unless
/// the variable is set; a write failure only warns (never breaks the cut).
fn dump_organic_cut_inputs(bytes: &[u8], options_json: &str) {
    let Some(dir) = std::env::var_os("DF_CUT_DUMP") else {
        return;
    };
    let dir = PathBuf::from(dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[cut] dump dir {}: {e}", dir.display());
        return;
    }
    let n = (0u32..)
        .find(|n| !dir.join(format!("cut-{n}.bin")).exists())
        .unwrap_or(0);
    if let Err(e) = std::fs::write(dir.join(format!("cut-{n}.bin")), bytes)
        .and_then(|()| std::fs::write(dir.join(format!("cut-{n}.json")), options_json))
    {
        eprintln!("[cut] dump cut-{n}: {e}");
        return;
    }
    eprintln!(
        "\n--- cut-{n} ---\n[cut] dumped inputs to {}/cut-{n}.{{bin,json}} ({} bytes of mesh)",
        dir.display(),
        bytes.len()
    );
}

/// Applies an organic cut to the current staged mesh, replacing the staged buffer
/// with the first part and stashing ALL parts for read-back (via
/// `mesh_organic_cut_read_part`). A multi-loop cut can produce more than two parts.
#[tauri::command]
pub async fn mesh_organic_cut_staged(options_json: String) -> Result<String, String> {
    let options = parse_organic_cut_options(&options_json);
    let bytes = read_staging_bytes()?;
    dump_organic_cut_inputs(&bytes, &options_json);
    let (parts, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let outcome = organic_cut(mesh, &options);
        Ok::<_, String>((outcome.parts, outcome.report))
    })
    .await
    .map_err(|e| format!("organic cut task panicked: {e}"))??;

    let parts_soup: Vec<Vec<u8>> = parts
        .iter()
        .map(|p| bytemuck::cast_slice::<f32, u8>(&p.to_triangle_soup()).to_vec())
        .collect();
    *organic_cut_parts_bytes()
        .lock()
        .map_err(|e| format!("organic cut parts lock poisoned: {e}"))? = parts_soup;

    // Keep the staged buffer pointed at the first part so existing read paths stay
    // valid (no-op cut → no parts → leave the staged mesh as-is).
    if let Some(first) = parts.first() {
        replace_staging_with_mesh(first)?;
    }
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
    organic_cut_parts_bytes()
        .lock()
        .map_err(|e| format!("organic cut parts lock poisoned: {e}"))?
        .clear();
    // Invalidate the cached geodesic solver — it belongs to the previous source.
    // The next geodesic call rebuilds it lazily for the new mesh.
    *organic_cut_geodesic_solver()
        .lock()
        .map_err(|e| format!("organic cut solver lock poisoned: {e}"))? = None;
    Ok(())
}

/// Runs an organic cut against the captured source mesh without mutating the
/// regular staged mesh buffer. Stashes ALL parts for read-back (via
/// `mesh_organic_cut_read_part`, driven by the report's `partCount`).
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
    dump_organic_cut_inputs(&source_bytes, &options_json);

    let (parts_soup, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&source_bytes).map_err(|e| e.to_string())?;
        let outcome = organic_cut(mesh, &options);
        let parts: Vec<Vec<u8>> = outcome
            .parts
            .iter()
            .map(|p| bytemuck::cast_slice::<f32, u8>(&p.to_triangle_soup()).to_vec())
            .collect();
        Ok::<_, String>((parts, outcome.report))
    })
    .await
    .map_err(|e| format!("organic cut task panicked: {e}"))??;

    *organic_cut_parts_bytes()
        .lock()
        .map_err(|e| format!("organic cut parts lock poisoned: {e}"))? = parts_soup;

    serde_json::to_string(&report).map_err(|e| format!("serialize organic cut report: {e}"))
}

/// Returns the most recent organic-cut part at `index` as raw LE f32 soup bytes.
/// Indices run `0..report.partCount`; a multi-loop cut that frees several pieces
/// exposes each as its own part. Out-of-range indices error.
#[tauri::command]
pub async fn mesh_organic_cut_read_part(index: usize) -> Result<Response, String> {
    let bytes = organic_cut_parts_bytes()
        .lock()
        .map_err(|e| format!("organic cut parts lock poisoned: {e}"))?
        .get(index)
        .cloned()
        .ok_or_else(|| format!("No organic cut part at index {index} — run a cut first"))?;
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
    // The cutter preview draws the wafer, whose thickness is no longer a setting —
    // it is sub-resolution either way, and the surface cut it now stands behind has
    // no thickness at all.
    let thickness_mm = dragonfruit_organic_cut::membrane::DEFAULT_CUTTER_THICKNESS_MM;
    let joint_clearance_mm = req.joint_clearance_mm.max(0.0);
    let generate_tenon = req.generate_tenon;
    let tenon_width_mm = req.tenon_width_mm;
    let tenon_depth_mm = req.tenon_depth_mm;
    let tenon_shape = dragonfruit_organic_cut::TenonShape::from_str_or_default(&req.tenon_shape);
    let tenon_fillet_mm = req.tenon_fillet_mm;
    let tenon_tolerance_mm = req.tenon_tolerance_mm;
    let tenon_at: dragonfruit_organic_cut::TenonAnchor = req
        .tenon_anchor
        .map(|p| Vec3::new(p[0], p[1], p[2]));
    let tenon_swap_sides = req.tenon_swap_sides;
    let tenon_tilt = dragonfruit_organic_cut::TenonTilt::new(req.tenon_tilt_rad, req.tenon_roll_rad);

    // Use the captured cut SOURCE mesh so the preview can apply the real loop
    // offset (needs surface normals) and show the REAL cutter slab — exactly what
    // cuts. Falls back to the bare-membrane preview if no source is captured yet.
    let source_bytes = organic_cut_source_bytes()
        .lock()
        .map_err(|e| format!("organic cut source lock poisoned: {e}"))?
        .clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        // The tenon preview needs the real source mesh (to probe wall clearance);
        // it's only available once the source is captured. Returns (soup, kind,
        // detail) — empty soup when no tenon (too thin / degenerate / no source).
        let mut tenon_soup: Vec<f32> = Vec::new();
        // How many of tenon_soup's triangles are the TENON (the rest are the mortise),
        // so the frontend can colour the two apart.
        let mut tenon_tris = 0usize;
        let mut tenon_kind = "none".to_string();
        let mut tenon_detail = String::new();
        // Whether the previewed tenon can actually be placed. A tenon that can't is
        // still built and still framed — drawn in the won't-fit colour, with its
        // gizmo — so `false` means "show it in red and refuse the cut", not "no
        // tenon". Defaults true so a cut with no tenon requested never blocks.
        let mut tenon_fits = true;
        // Placement frame for the aim/roll gizmo (anchor, axis, u, v, tip), in
        // model-local coords. None when no tenon is previewed.
        let mut tenon_frame: Option<dragonfruit_organic_cut::TenonFrameInfo> = None;

        let soup = if let Some(bytes) = source_bytes {
            let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
            if generate_tenon {
                if let Some(preview) =
                    dragonfruit_organic_cut::build_tenon_preview_soup(
                        &mesh,
                        &loop_pts,
                        membrane_smoothing,
                        density,
                        tenon_shape,
                        tenon_swap_sides,
                        tenon_tilt,
                        tenon_width_mm,
                        tenon_depth_mm,
                        tenon_fillet_mm,
                        // Same sum the cut spends, so the previewed fit is the real one.
                        tenon_tolerance_mm + joint_clearance_mm,
                        tenon_at,
                    )
                {
                    tenon_tris = preview.tenon_triangles;
                    tenon_soup = preview.soup;
                    tenon_kind = preview.kind.as_str().to_string();
                    tenon_fits = preview.fits;
                    tenon_detail = preview.detail;
                    tenon_frame = preview.frame;
                }
            }
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
        let tenon_bytes: Vec<u8> = bytemuck::cast_slice::<f32, u8>(&tenon_soup).to_vec();
        let joint_tris = tenon_soup.len() / 9;
        Ok::<_, String>((bytes, tri_count, tenon_bytes, joint_tris, tenon_tris, tenon_kind, tenon_fits, tenon_detail, tenon_frame))
    })
    .await
    .map_err(|e| format!("membrane preview task panicked: {e}"))??;

    let (bytes, tri_count, tenon_bytes, joint_tris, tenon_tris, tenon_kind, tenon_fits, tenon_detail, tenon_frame) = result;
    *organic_cut_membrane_bytes()
        .lock()
        .map_err(|e| format!("membrane lock poisoned: {e}"))? = Some(bytes);
    *organic_cut_tenon_bytes()
        .lock()
        .map_err(|e| format!("tenon lock poisoned: {e}"))? = Some(tenon_bytes);
    // tenon_detail is plain ASCII status text; escape quotes/backslashes for JSON.
    let tenon_detail_json = json_escape(&tenon_detail);
    // The gizmo frame (anchor/axis/u/v/tip, model-local) so the frontend can place
    // the aim + roll handles exactly on the previewed tenon. `null` when no tenon.
    let tenon_frame_json = match tenon_frame {
        Some(f) => format!(
            "{{\"anchor\":[{},{},{}],\"axis\":[{},{},{}],\"u\":[{},{},{}],\"v\":[{},{},{}],\"tip\":[{},{},{}],\"depth\":{},\"maxTiltRad\":{},\"halfDiagMm\":{}}}",
            f.anchor.x, f.anchor.y, f.anchor.z,
            f.axis.x, f.axis.y, f.axis.z,
            f.u.x, f.u.y, f.u.z,
            f.v.x, f.v.y, f.v.z,
            f.tip.x, f.tip.y, f.tip.z,
            f.depth,
            f.max_tilt,
            f.half_diag,
        ),
        None => "null".to_string(),
    };
    Ok(format!(
        "{{\"triangleCount\":{tri_count},\"jointTriangleCount\":{joint_tris},\"tenonTriangleCount\":{tenon_tris},\"tenonKind\":\"{tenon_kind}\",\"tenonFits\":{tenon_fits},\"tenonDetail\":\"{tenon_detail_json}\",\"tenonFrame\":{tenon_frame_json}}}"
    ))
}

/// Preview the registration tenon a FLAT cut would place, framed on the cut plane.
///
/// The contour preview builds a membrane from the loop and frames the tenon on it;
/// a flat cut has no membrane, so this takes the plane the frontend previewed and
/// frames the tenon on the cross-section it carves. Same ladder and same build as
/// the cut, so the preview is what lands. Writes the soup where
/// `mesh_organic_cut_read_tenon` picks it up, and reports the same JSON shape as the
/// membrane preview (with no membrane of its own: `triangleCount` is 0).
#[tauri::command]
pub async fn mesh_organic_cut_plane_tenon_preview(request_json: String) -> Result<String, String> {
    let req = parse_geodesic_request(&request_json);
    let normal = Vec3::new(req.plane_normal[0], req.plane_normal[1], req.plane_normal[2]);
    let offset = req.plane_offset;
    let generate_tenon = req.generate_tenon;
    let tenon_shape = dragonfruit_organic_cut::TenonShape::from_str_or_default(&req.tenon_shape);
    let tenon_tilt = dragonfruit_organic_cut::TenonTilt::new(req.tenon_tilt_rad, req.tenon_roll_rad);
    let tenon_at: dragonfruit_organic_cut::TenonAnchor = req
        .tenon_anchor
        .map(|p| Vec3::new(p[0], p[1], p[2]));
    let (tenon_width_mm, tenon_depth_mm, tenon_fillet_mm, tenon_tolerance_mm, tenon_swap_sides) = (
        req.tenon_width_mm,
        req.tenon_depth_mm,
        req.tenon_fillet_mm,
        req.tenon_tolerance_mm,
        req.tenon_swap_sides,
    );

    let source_bytes = organic_cut_source_bytes()
        .lock()
        .map_err(|e| format!("organic cut source lock poisoned: {e}"))?
        .clone();
    let Some(bytes) = source_bytes else {
        return Ok(NO_TENON_PREVIEW_JSON.to_string());
    };
    if !generate_tenon || normal.length() < 1e-6 {
        return Ok(NO_TENON_PREVIEW_JSON.to_string());
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let Some(frame) = dragonfruit_organic_cut::frame_from_plane(&mesh, normal, offset, tenon_at)
        else {
            return Ok::<_, String>(None);
        };
        let preview = dragonfruit_organic_cut::build_tenon_preview_at_frame(
            &mesh,
            frame,
            tenon_shape,
            tenon_swap_sides,
            tenon_tilt,
            tenon_width_mm,
            tenon_depth_mm,
            tenon_fillet_mm,
            tenon_tolerance_mm,
        );
        Ok(Some((
            preview.soup,
            preview.tenon_triangles,
            preview.kind.as_str().to_string(),
            preview.fits,
            preview.detail,
            preview.frame,
        )))
    })
    .await
    .map_err(|e| format!("plane tenon preview task panicked: {e}"))??;

    let Some((tenon_soup, tenon_tris, tenon_kind, tenon_fits, tenon_detail, tenon_frame)) = result else {
        return Ok(NO_TENON_PREVIEW_JSON.to_string());
    };
    let joint_tris = tenon_soup.len() / 9;
    *organic_cut_tenon_bytes()
        .lock()
        .map_err(|e| format!("tenon lock poisoned: {e}"))? =
        Some(bytemuck::cast_slice::<f32, u8>(&tenon_soup).to_vec());
    let tenon_detail_json = json_escape(&tenon_detail);
    let tenon_frame_json = match tenon_frame {
        Some(f) => format!(
            "{{\"anchor\":[{},{},{}],\"axis\":[{},{},{}],\"u\":[{},{},{}],\"v\":[{},{},{}],\"tip\":[{},{},{}],\"depth\":{},\"maxTiltRad\":{},\"halfDiagMm\":{}}}",
            f.anchor.x, f.anchor.y, f.anchor.z,
            f.axis.x, f.axis.y, f.axis.z,
            f.u.x, f.u.y, f.u.z,
            f.v.x, f.v.y, f.v.z,
            f.tip.x, f.tip.y, f.tip.z,
            f.depth,
            f.max_tilt,
            f.half_diag,
        ),
        None => "null".to_string(),
    };
    Ok(format!(
        "{{\"triangleCount\":0,\"jointTriangleCount\":{joint_tris},\"tenonTriangleCount\":{tenon_tris},\"tenonKind\":\"{tenon_kind}\",\"tenonFits\":{tenon_fits},\"tenonDetail\":\"{tenon_detail_json}\",\"tenonFrame\":{tenon_frame_json}}}"
    ))
}

/// The empty answer for a tenon preview: no tenon, no frame, no membrane.
const NO_TENON_PREVIEW_JSON: &str =
    "{\"triangleCount\":0,\"jointTriangleCount\":0,\"tenonTriangleCount\":0,\"tenonKind\":\"none\",\"tenonFits\":true,\"tenonDetail\":\"\",\"tenonFrame\":null}";

/// Returns the most recent registration-tenon preview as raw LE f32 triangle-soup
/// bytes (tenon followed by mortise). Empty when no tenon was previewed.
#[tauri::command]
pub async fn mesh_organic_cut_read_tenon() -> Result<Response, String> {
    let bytes = organic_cut_tenon_bytes()
        .lock()
        .map_err(|e| format!("tenon lock poisoned: {e}"))?
        .clone()
        .unwrap_or_default();
    Ok(Response::new(bytes))
}

/// Minimal JSON string-body escaper for the short ASCII status messages we embed
/// in hand-built response objects (quotes + backslashes only).
fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
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
    skip_classification: Option<bool>,
    model_triangle_count: Option<u32>,
) -> Result<Response, String> {
    use dragonfruit_mesh_repair::io;

    let path = std::path::Path::new(&file_path);

    log::info!("[load_stl_file] Starting native STL load: {file_path}");

    // The current IPC format expands every triangle to positions plus normals
    // (72 bytes/triangle), before Three.js builds its BVH and uploads buffers.
    // Reject inputs that cannot fit that representation before the repair
    // loader reads and indexes the entire STL in memory.
    const TRIGGER_TRIANGLES: u64 = 4_000_000;
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
        let force_decimate = skip_classification.unwrap_or(false) && model_triangle_count.is_some();
        if expected_binary_size == file_size && (triangle_count > TRIGGER_TRIANGLES || force_decimate) {
            let (bbox_min, bbox_max) = binary_stl_bounds(path, triangle_count as u32)?;
            let extent = bbox_max.sub(bbox_min);
            let bbox_diagonal_mm = extent.length() as f64;
            drop(file);

            let budget = dragonfruit_mesh_repair::stl_budget::compute_triangle_budget(
                triangle_count as usize,
                bbox_diagonal_mm,
                None,
            );

            let mesh = io::stl::load(path)
                .map_err(|e| format!("Failed to load STL '{}': {e}", file_path))?;
            
            let (mesh_to_decimate, model_tri_count) = if skip_classification.unwrap_or(false) && model_triangle_count.is_some() {
                let provided_count = model_triangle_count.unwrap();
                let count = provided_count.min(mesh.triangles.len() as u32) as usize;
                (mesh, count)
            } else {
                let classify_outcome = dragonfruit_mesh_repair::repair::classify_support_split(mesh, &dragonfruit_mesh_repair::RepairOptions::default());
                let count = classify_outcome.report.model_triangle_count.unwrap_or(classify_outcome.mesh.triangles.len());
                (classify_outcome.mesh, count)
            };
            
            let outcome = dragonfruit_mesh_repair::repair::decimate_sections_to_budget(mesh_to_decimate, model_tri_count, &budget);
            let preview = outcome.mesh;

            log::info!(
                "[load_stl_file] Preview complete: {} -> {} triangles (budget: {}, error: {:.4})",
                triangle_count,
                preview.triangles.len(),
                budget.budget_tris,
                outcome.achieved_error
            );
            return encode_stl_response(&preview, triangle_count as u32, true, Some(outcome.model_triangle_count as u32)).map(Response::new);
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
    encode_stl_response(&mesh, tri_count as u32, false, None).map(Response::new)
}

/// DragonFruit Streaming Transfer (DFST) Binary IPC Protocol Specification:
/// Header Length: 64 Bytes Total (Single header at index 0 per STL payload)
///
/// Byte Offsets:
///   0 ..  3 : ASCII Magic "DFST" (0x44465354)
///   4 ..  7 : Flags u32 (Bit 0: IS_PREVIEW)
///   8 .. 11 : Original Input Triangle Count (u32 LE)
///  12 .. 15 : Output Preview Triangle Count (u32 LE)
///  16 .. 31 : Reserved / Bounding Box Extents (16 bytes)
///  32 .. 35 : Model Section Triangle Count / Boundary Offset (u32 LE)
///  36 .. 63 : Reserved Metadata Padding (28 bytes)
///
/// Payload (starts at Byte 64):
///   64 .. 64 + (previewTriangleCount * 36) : Positions (Float32Array, 9 floats per triangle)
///   64 + (previewTriangleCount * 36) .. End : Normals (Float32Array, 9 floats per triangle)
const STL_RESPONSE_MAGIC: &[u8; 4] = b"DFST";
const STL_RESPONSE_HEADER_BYTES: usize = 64;
const STL_RESPONSE_FLAG_PREVIEW: u32 = 1;

fn encode_stl_response(
    mesh: &IndexedMesh,
    original_triangle_count: u32,
    is_preview: bool,
    model_triangle_count: Option<u32>,
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
    if let Some(mtc) = model_triangle_count {
        result[32..36].copy_from_slice(&mtc.to_le_bytes());
    }
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

// PRESERVED (Low-RAM Fallback / Feasibility Baseline):
// Legacy streaming disk-bucket preview generator from origin/dev.
// Kept in-place for future low-RAM system fallbacks and streaming decimation feasibility benchmarks.
// Superseded in active PLAN-3 path by in-memory engine (`decimate_sections_to_budget`).
#[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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
    fn test_load_stl_file_with_skip_classification() {
        use std::io::Write;
        use tauri::ipc::IpcResponse;

        let path = std::env::temp_dir().join("test_load_stl_file.stl");
        let mut file = std::fs::File::create(&path).unwrap();
        let mut header = [0u8; 84];
        header[80..84].copy_from_slice(&10u32.to_le_bytes());
        file.write_all(&header).unwrap();
        for _ in 0..10 {
            let record = [0u8; 50];
            file.write_all(&record).unwrap();
        }
        drop(file);
        
        let rt = tokio::runtime::Runtime::new().unwrap();
        let resp = rt.block_on(load_stl_file(path.to_str().unwrap().to_string(), Some(true), Some(6)));
        let response = resp.unwrap();
        let body = response.body().unwrap();
        let bytes = match body {
            tauri::ipc::InvokeResponseBody::Raw(b) => b,
            _ => panic!("Expected Raw body"),
        };
        let model_tri_count = u32::from_le_bytes(bytes[32..36].try_into().unwrap());
        assert_eq!(model_tri_count, 6);
    }
}
