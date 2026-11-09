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
//! - `mesh_shrinkwrap_staged` — resample the staged mesh into a closed one with
//!   the shrinkwrap resampler (deliberately separate from `repair`), replace the
//!   staging buffer with the result, return the report JSON.
//! - `mesh_tet_surface_staged` — resample the staged mesh by tetrahedralising its
//!   points and keeping the inside/outside boundary (the second surfacing mode,
//!   beside `mesh_shrinkwrap_staged`), replace the staging buffer with the result,
//!   return the report JSON.
//! - `mesh_repair_read_positions` — raw-binary response of the current staged
//!   positions (little-endian f32, 9 per triangle), for frontend hydration.
//! - `load_mesh_file` — parse `stl`/`obj`/`3mf` and return its bodies (one per
//!   build item for 3MF, a decimated single body for an oversized STL) in the
//!   `DFMX` wire format.

use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use dragonfruit_mesh_repair::{
    analyze, classify_support_split, hollow_voxel, io, punch_cylinders, repair_auto_with_progress,
    repair_separate_parts,
    shrink_wrap_with_progress, solid_remesh_with_progress, tet_surface_with_progress, HolePunchOptions,
    HollowOptions, HollowSession, IndexedMesh, RepairOptions, ShrinkWrapOptions, SolidRemeshOptions,
    TetWrapOptions,
    Vec3,
};
// The organic cut feature now lives in its own crate.
use dragonfruit_organic_cut::{organic_cut, GeodesicSolver, OrganicCutOptions};
use rayon::prelude::*;
use serde::Deserialize;
use tauri::ipc::Response;
use tauri::Emitter;

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
    weld_tolerance_mm: Option<f32>,
    fill_holes_max_edges: Option<usize>,
    keep_largest_n_components: Option<usize>,
    repair_orientation: Option<bool>,
    resolve_self_intersections: Option<bool>,
    cut_unsatisfiable_edges: Option<bool>,
    allow_rebuild: Option<bool>,
    #[serde(alias = "assume_support_geometry")]
    assume_support_geometry: Option<bool>,
}

impl From<RepairOptionsDto> for RepairOptions {
    fn from(dto: RepairOptionsDto) -> Self {
        let defaults = RepairOptions::default();
        RepairOptions {
            // Passed through as they arrive, `None` and all: the engine derives a tolerance the
            // caller did not name. The frontend is not better placed to pick these than the crate
            // is — it has no mesh in hand when it builds them.
            weld_tolerance_mm: dto.weld_tolerance_mm,
            fill_holes_max_edges: dto.fill_holes_max_edges,
            keep_largest_n_components: dto
                .keep_largest_n_components
                .or(defaults.keep_largest_n_components),
            repair_orientation: dto
                .repair_orientation
                .unwrap_or(defaults.repair_orientation),
            resolve_self_intersections: dto
                .resolve_self_intersections
                .unwrap_or(defaults.resolve_self_intersections),
            cut_unsatisfiable_edges: dto
                .cut_unsatisfiable_edges
                .unwrap_or(defaults.cut_unsatisfiable_edges),
            allow_rebuild: dto.allow_rebuild.unwrap_or(defaults.allow_rebuild),
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

fn parse_shrinkwrap_options(options_json: &str) -> Result<ShrinkWrapOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(ShrinkWrapOptions::default());
    }
    serde_json::from_str::<ShrinkWrapOptions>(options_json)
        .map_err(|e| format!("invalid shrinkwrap options JSON: {e}"))
}

fn parse_solid_remesh_options(options_json: &str) -> Result<SolidRemeshOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(SolidRemeshOptions::default());
    }
    serde_json::from_str::<SolidRemeshOptions>(options_json)
        .map_err(|e| format!("invalid shrink-wrap options JSON: {e}"))
}

fn parse_tet_wrap_options(options_json: &str) -> Result<TetWrapOptions, String> {
    if options_json.trim().is_empty() {
        return Ok(TetWrapOptions::default());
    }
    serde_json::from_str::<TetWrapOptions>(options_json)
        .map_err(|e| format!("invalid tet surface options JSON: {e}"))
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

/// Registers a cancel flag for this run, and returns it.
///
/// The frontend's token is what keeps two repairs from writing into each other's progress
/// display, and what a cancel is addressed to.
fn register_cancel(token: Option<&String>) -> Option<Arc<AtomicBool>> {
    token.map(|token| {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut registry) = cancels().lock() {
            registry.insert(token.clone(), flag.clone());
        }
        flag
    })
}

/// Forgets a finished run's cancel flag.
fn release_cancel(token: Option<&String>) {
    if let Some(token) = token {
        if let Ok(mut registry) = cancels().lock() {
            registry.remove(token);
        }
    }
}

/// The sink a repair runs with: it announces each stage to the frontend, and says no when
/// this run has been asked to stop.
fn progress_sink(
    event: &'static str,
    token: Option<String>,
    cancel: Option<Arc<AtomicBool>>,
    app: crate::DragonFruitAppHandle,
) -> impl FnMut(&str, usize) -> bool + Send + 'static {
    move |name: &str, index: usize| {
        if let Some(token) = token.as_deref() {
            let _ = app.emit(
                event,
                serde_json::json!({ "token": token, "name": name, "index": index }),
            );
        }
        cancel
            .as_ref()
            .map(|flag| !flag.load(Ordering::SeqCst))
            .unwrap_or(true)
    }
}

#[tauri::command]
pub async fn mesh_repair_from_path(
    file_path: String,
    options_json: String,
    progress_token: Option<String>,
    app: crate::DragonFruitAppHandle,
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
    let cancel = register_cancel(progress_token.as_ref());
    let token = progress_token.clone();
    let (mesh, mut report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::load_mesh_from_path(&path).map_err(|e| e.to_string())?;
        let mut sink = progress_sink("mesh-repair-progress", token, cancel, app);
        let outcome = repair_auto_with_progress(mesh, &options, Some(&mut sink));
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("repair task panicked: {e}"))??;
    release_cancel(progress_token.as_ref());
    report.source_path = Some(source_path);
    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize report: {e}"))
}

/// Repairs a plate part by part: the shells that meet stay together as one object, each object is
/// repaired on its own, and the result is staged as one mesh with a per-object verdict.
///
/// A plate is not one model — the reported one is 25 objects over 118 components — and repairing it
/// whole returns one verdict for all of them, which tells a user nothing they can act on. This is
/// the same flow the `parts` CLI command runs; the difference is that the app hands the joined
/// result back through the staging buffer instead of writing files.
#[tauri::command]
pub async fn mesh_repair_parts_from_path(
    file_path: String,
    options_json: String,
    progress_token: Option<String>,
    app: crate::DragonFruitAppHandle,
) -> Result<String, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!(
            "mesh_repair_parts_from_path: not found: {}",
            path.display()
        ));
    }
    let options = parse_options(&options_json)?;
    let source_path = file_path.clone();
    let cancel = register_cancel(progress_token.as_ref());
    let token = progress_token.clone();
    let parts = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::load_mesh_from_path(&path).map_err(|e| e.to_string())?;
        let mut announced = 0usize;
        let mut sink = |index: usize, name: &str| {
            announced = index;
            if let Some(token) = token.as_deref() {
                let _ = app.emit(
                    "mesh-repair-progress",
                    serde_json::json!({ "token": token, "name": name, "index": index }),
                );
            }
        };
        let parts =
            repair_separate_parts(&mesh, &options, Some(&mut sink)).ok_or_else(|| {
                "mesh_repair_parts_from_path: the mesh is one object, or its shells meet each other"
                    .to_string()
            })?;
        let _ = announced;
        Ok::<_, String>(parts)
    })
    .await
    .map_err(|e| format!("repair parts task panicked: {e}"))??;
    let cancelled = cancel
        .as_ref()
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false);
    release_cancel(progress_token.as_ref());
    let mesh = parts.combined_mesh();
    let mut report = parts.report(Some(source_path));
    report.cancelled = cancelled;
    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize report: {e}"))
}

/// Loads a mesh from a path and stages it, repairing nothing.
///
/// The webview refuses a `file://` fetch at the security boundary, so a model's file cannot be read
/// back from the UI directly. This is the first half of [`mesh_repair_from_path`] on its own, for
/// putting a model back to how it arrived.
#[tauri::command]
pub async fn mesh_load_from_path(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!(
            "mesh_load_from_path: not found: {}",
            path.display()
        ));
    }
    let mesh = tauri::async_runtime::spawn_blocking(move || {
        io::load_mesh_from_path(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("load task panicked: {e}"))??;
    replace_staging_with_mesh(&mesh)
}

/// Repairs in flight, by progress token.
///
/// A cancel flips the flag and the repair reads it at its next stage boundary, so a
/// cancel never lands halfway through a pass.
fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Asks the repair carrying this token to stop at its next stage boundary.
///
/// Returns whether a repair was actually carrying that token: a cancel that arrives
/// after the repair finished is not an error, it is a no-op.
#[tauri::command]
pub async fn mesh_repair_cancel(progress_token: String) -> Result<bool, String> {
    let registry = cancels().lock().map_err(|e| e.to_string())?;
    Ok(registry
        .get(&progress_token)
        .map(|flag| {
            flag.store(true, Ordering::SeqCst);
            true
        })
        .unwrap_or(false))
}

#[tauri::command]
pub async fn mesh_repair_staged(
    options_json: String,
    progress_token: Option<String>,
    app: crate::DragonFruitAppHandle,
) -> Result<String, String> {
    let options = parse_options(&options_json)?;
    let bytes = read_staging_bytes()?;

    let cancel = register_cancel(progress_token.as_ref());
    let token = progress_token.clone();

    let (mesh, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let mut sink = progress_sink("mesh-repair-progress", token, cancel, app);
        let outcome = repair_auto_with_progress(mesh, &options, Some(&mut sink));
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("repair task panicked: {e}"))??;
    release_cancel(progress_token.as_ref());

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

/// Resamples the current staged mesh with the shrinkwrap resampler.
///
/// Deliberately separate from `mesh_repair_staged`: shrinkwrap rebuilds the
/// surface from a signed distance field, so the result has no relation to the
/// input beyond its shape — every vertex is new. It exists for meshes whose
/// topology cannot be repaired, where `repair` has to refuse rather than damage
/// the object. Replaces the staged positions with the resampled mesh and returns
/// the report JSON (input/output triangles, voxel size, elapsed ms).
#[tauri::command]
pub async fn mesh_shrinkwrap_staged(
    options_json: String,
    progress_token: Option<String>,
    app: crate::DragonFruitAppHandle,
) -> Result<String, String> {
    let options = parse_shrinkwrap_options(&options_json)?;
    let bytes = read_staging_bytes()?;

    let cancel = register_cancel(progress_token.as_ref());
    let token = progress_token.clone();

    let (mesh, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let mut sink = progress_sink("mesh-shrinkwrap-progress", token, cancel, app);
        let outcome = shrink_wrap_with_progress(&mesh, &options, Some(&mut sink));
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("shrinkwrap task panicked: {e}"))??;
    release_cancel(progress_token.as_ref());

    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize shrinkwrap report: {e}"))
}

/// Resamples the current staged mesh by tetrahedralising its points and keeping the inside/outside
/// boundary — the second surfacing mode, beside [`mesh_shrinkwrap_staged`].
///
/// Where shrinkwrap resamples onto a uniform lattice, this decomposition follows the model's own
/// points, so it preserves detail a lattice would lose, and the boundary between two labels is
/// closed by construction, so it emits no debris where the band isosurface does. Like shrinkwrap it
/// rebuilds the surface rather than editing it, so it is deliberately separate from
/// `mesh_repair_staged`. Replaces the staged positions with the resampled mesh and returns the
/// report JSON (input/output triangles, decomposition size, per-phase elapsed ms).
#[tauri::command]
pub async fn mesh_tet_surface_staged(
    options_json: String,
    progress_token: Option<String>,
    app: crate::DragonFruitAppHandle,
) -> Result<String, String> {
    let options = parse_tet_wrap_options(&options_json)?;
    let bytes = read_staging_bytes()?;

    let cancel = register_cancel(progress_token.as_ref());
    let token = progress_token.clone();

    let (mesh, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let mut sink = progress_sink("mesh-tet-surface-progress", token, cancel, app);
        let outcome = tet_surface_with_progress(&mesh, &options, Some(&mut sink));
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("tet surface task panicked: {e}"))??;
    release_cancel(progress_token.as_ref());

    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize tet surface report: {e}"))
}

/// Rebuilds the current staged mesh's surface by resolving it into a solid — the third surfacing
/// mode, beside [`mesh_shrinkwrap_staged`] and [`mesh_tet_surface_staged`].
///
/// This is the mode the reference implementation's shrinkwrap uses: close what is open, boolean the
/// mesh with itself so the result is resolved and retriangulated, then drop scrap shells. It moves
/// the surface, where the tetrahedral mode conforms to it and hands it back. On a clean closed solid
/// it is a no-op, so it is for a mesh that is not one solid. Replaces the staged positions with the
/// rebuilt mesh and returns the report JSON.
#[tauri::command]
pub async fn mesh_solid_remesh_staged(
    options_json: String,
    progress_token: Option<String>,
    app: crate::DragonFruitAppHandle,
) -> Result<String, String> {
    let options = parse_solid_remesh_options(&options_json)?;
    let bytes = read_staging_bytes()?;

    let cancel = register_cancel(progress_token.as_ref());
    let token = progress_token.clone();

    let (mesh, report) = tauri::async_runtime::spawn_blocking(move || {
        let mesh = io::staged::load_positions_le(&bytes).map_err(|e| e.to_string())?;
        let mut sink = progress_sink("mesh-solid-remesh-progress", token, cancel, app);
        let outcome = solid_remesh_with_progress(&mesh, &options, Some(&mut sink));
        Ok::<_, String>((outcome.mesh, outcome.report))
    })
    .await
    .map_err(|e| format!("shrink-wrap task panicked: {e}"))??;
    release_cancel(progress_token.as_ref());

    replace_staging_with_mesh(&mesh)?;
    serde_json::to_string(&report).map_err(|e| format!("serialize shrink-wrap report: {e}"))
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

/// The STL-only step of a native load.
///
/// A binary STL announces its triangle count in its 84-byte header, so a file
/// too large to render can be found — and decimated — before the repair loader
/// reads and indexes the whole thing. This is also where an oversized ASCII STL
/// is refused, because its parser has to hold the file in memory.
///
/// `Ok(Some(bytes))` when the preview path produced a `DFMX` payload,
/// `Ok(None)` when the file is ordinary and the caller should load it normally,
/// `Err` for an input the renderer cannot take.
///
/// `forced_model_triangle_count` skips classification with a count the caller
/// already knows, re-decimating without repeating the classification pass; only
/// tests pass it, so the trigger is otherwise the file size alone.
fn stl_special_case_response(
    path: &std::path::Path,
    file_path: &str,
    forced_model_triangle_count: Option<u32>,
) -> Result<Option<Vec<u8>>, String> {
    use dragonfruit_mesh_repair::io;

    // The payload is 72 bytes/triangle before Three.js builds its BVH and
    // uploads buffers, so reject inputs that cannot fit that representation
    // before the repair loader reads and indexes the entire STL in memory.
    const TRIGGER_TRIANGLES: u64 = 4_000_000;
    const MAX_NATIVE_ASCII_STL_BYTES: u64 = 300_000_000;

    let file_size = std::fs::metadata(path)
        .map_err(|e| format!("Failed to inspect STL '{file_path}': {e}"))?
        .len();
    let mut header = [0u8; 84];
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open STL '{file_path}': {e}"))?;
    let header_len = file
        .read(&mut header)
        .map_err(|e| format!("Failed to read STL header '{file_path}': {e}"))?;

    if header_len == header.len() {
        let triangle_count = u32::from_le_bytes(header[80..84].try_into().unwrap()) as u64;
        let expected_binary_size = 84u64.saturating_add(triangle_count.saturating_mul(50));
        let force_decimate = forced_model_triangle_count.is_some();
        if expected_binary_size == file_size && (triangle_count > TRIGGER_TRIANGLES || force_decimate) {
            let (bbox_min, bbox_max) = binary_stl_bounds(path, triangle_count as u32)?;
            let bbox_diagonal_mm = bbox_max.sub(bbox_min).length() as f64;
            drop(file);

            let budget = dragonfruit_mesh_repair::stl_budget::compute_triangle_budget(
                triangle_count as usize,
                bbox_diagonal_mm,
                None,
            );

            // Through the dispatcher, not `io::stl::load`, so the model gets the
            // same coarse-face refinement every other import path applies.
            let mesh = io::load_mesh_from_path(path)
                .map_err(|e| format!("Failed to load STL '{file_path}': {e}"))?;

            let (mesh_to_decimate, model_tri_count) = match forced_model_triangle_count {
                Some(provided) => {
                    let count = provided.min(mesh.triangles.len() as u32) as usize;
                    (mesh, count)
                }
                None => {
                    let classify_outcome = dragonfruit_mesh_repair::repair::classify_support_split(
                        mesh,
                        &dragonfruit_mesh_repair::RepairOptions::default(),
                    );
                    let count = classify_outcome
                        .report
                        .model_triangle_count
                        .unwrap_or(classify_outcome.mesh.triangles.len());
                    (classify_outcome.mesh, count)
                }
            };

            let outcome = dragonfruit_mesh_repair::repair::decimate_sections_to_budget(
                mesh_to_decimate,
                model_tri_count,
                &budget,
            );
            let preview = outcome.mesh;

            log::info!(
                "[load_mesh_file] Preview complete: {} -> {} triangles (budget: {}, error: {:.4})",
                triangle_count,
                preview.triangles.len(),
                budget.budget_tris,
                outcome.achieved_error
            );
            return encode_mesh_bodies(
                std::slice::from_ref(&preview),
                triangle_count as u32,
                true,
                Some(outcome.model_triangle_count as u32),
                None,
                None,
            )
            .map(Some);
        }
    }
    if file_size > MAX_NATIVE_ASCII_STL_BYTES && header.starts_with(b"solid") {
        return Err(format!(
            "ASCII STL is too large for the current renderer ({:.2} GB on disk; limit {:.2} GB). Decimate or convert it before importing.",
            file_size as f64 / 1_000_000_000.0,
            MAX_NATIVE_ASCII_STL_BYTES as f64 / 1_000_000_000.0,
        ));
    }
    Ok(None)
}

/// Parse a mesh file of any supported format and return its bodies in the
/// `DFMX` wire format that [`encode_mesh_bodies`] writes: a 32-byte header, a
/// body table, then one positions+normals soup per body.
///
/// The format-agnostic entry point: it dispatches through
/// `io::load_mesh_bodies_from_path` (`stl`/`obj` give one body; `3mf` gives one
/// per build item expanded through its components, with transforms baked), so
/// refinement and the face normals are the same ones every other
/// import path gets. Materials and units are dropped, matching the renderer's
/// loaders. STL adds one format-specific step — [`stl_special_case_response`],
/// which turns a mesh too large to render into a decimated preview.
///
/// `classify` (default true) runs the model/support classifier on a single-body
/// load and returns its report in the payload's metadata tail. Pass `false` when
/// the caller will repair instead: that pass classifies too.
#[tauri::command]
pub async fn load_mesh_file(file_path: String, classify: Option<bool>) -> Result<Response, String> {
    let path = std::path::Path::new(&file_path);
    log::info!("[load_mesh_file] Starting native mesh load: {file_path}");

    let is_stl = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("stl"));
    if is_stl {
        if let Some(bytes) = stl_special_case_response(path, &file_path, None)? {
            return Ok(Response::new(bytes));
        }
    }

    // Through the dispatcher, not a format loader: `load_mesh_bodies_from_path`
    // refines coarse faces per body before anything derives data from the mesh,
    // and resolves a 3MF's build items into one body each.
    let bodies = io::load_mesh_bodies_from_path(path)
        .map_err(|e| format!("Failed to load mesh '{file_path}': {e}"))?;

    // Classify a single-body load here, when the caller asks, and ship the report
    // in the payload: the frontend then has nothing to stage or round-trip, the
    // geometry arrives section-ordered, and the report it would have produced is
    // already in hand. A caller that will repair passes `classify: false` — the
    // repair pass classifies too, and that report is the one that matters.
    let want_classify = classify.unwrap_or(true) && bodies.len() == 1;
    let (bodies, metadata_json) = if want_classify {
        classify_single_body(bodies.into_iter().next().expect("length checked above"))
    } else {
        (bodies, None)
    };

    let tri_count: usize = bodies.iter().map(|body| body.triangles.len()).sum();
    encode_mesh_bodies(&bodies, tri_count as u32, false, None, metadata_json.as_deref(), None)
        .map(Response::new)
}

/// Parse a mesh's bytes with the native loader, for a source that has no on-disk
/// path: a VOXL's embedded mesh chunk, or a file expanded out of a zip. The body
/// is the raw file (binary or ASCII STL today), exactly the bytes the path loader
/// would have read, and the response is the same `DFMX` payload `load_mesh_file`
/// writes, classification tail included.
///
/// A raw-body command cannot also take JSON arguments, so its one option rides in
/// a header: `x-mesh-classify: 0` skips the classifier for a caller that will
/// repair, because that pass classifies too. Absent means classify.
#[tauri::command]
pub async fn load_mesh_bytes(request: tauri::ipc::Request<'_>) -> Result<Response, String> {
    let classify = request
        .headers()
        .get("x-mesh-classify")
        .and_then(|value| value.to_str().ok())
        .map_or(true, |value| value.trim() != "0");
    let refine = request
        .headers()
        .get("x-mesh-refine")
        .and_then(|value| value.to_str().ok())
        .map_or(true, |value| value.trim() != "0");
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("load_mesh_bytes expects a raw binary body".into())
        }
    };
    log::info!(
        "[load_mesh_bytes] Starting native mesh load from {} bytes",
        bytes.len()
    );
    load_mesh_bytes_response(&bytes, classify, refine).map(Response::new)
}

/// Parse a mesh that sits at a known offset inside a file on disk.
///
/// This is a VOXL's embedded mesh chunk: the container stores it as a packed
/// (zlib) STL at a directory-recorded offset, and the frontend used to inflate all
/// of them in the webview before handing them over — 677 MB of heap and ~2 s of a
/// scene load that happens before any model work starts. The bytes never need to
/// cross: the range is read here, inflated here, and the same pipeline the
/// byte-source loader runs (parse, refine, classify, encode) produces the same
/// `DFMX` payload.
///
/// `compression` is the container's own code: 0 none, 1 zlib. Anything else is
/// refused rather than guessed, and a range that does not read exactly `length`
/// bytes is an error — the container has already been parsed by then, so a short
/// read means the file changed under it.
#[tauri::command]
pub async fn load_mesh_range(
    source_path: String,
    offset: u64,
    length: u64,
    compression: u16,
    classify: Option<bool>,
    refine: Option<bool>,
) -> Result<Response, String> {
    let started = std::time::Instant::now();
    let path = source_path.clone();
    let (bytes, read_ms) = tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(&path)
            .map_err(|e| format!("Failed to open '{path}': {e}"))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Failed to seek to {offset} in '{path}': {e}"))?;
        let mut raw = vec![0u8; length as usize];
        file.read_exact(&mut raw)
            .map_err(|e| format!("Failed to read {length} bytes at {offset} in '{path}': {e}"))?;
        let read_at = std::time::Instant::now();
        let bytes = match compression {
            0 => raw,
            // The container's zlib chunks: inflate where the parse happens, on this
            // side of the IPC.
            1 => {
                let mut soup = Vec::with_capacity(raw.len() * 3);
                flate2::read::ZlibDecoder::new(raw.as_slice())
                    .read_to_end(&mut soup)
                    .map_err(|e| format!("Failed to inflate the mesh chunk at {offset}: {e}"))?;
                soup
            }
            other => {
                return Err(format!(
                    "Unsupported mesh chunk compression {other} at {offset} in '{path}'"
                ))
            }
        };
        Ok((bytes, read_at.elapsed().as_millis()))
    })
    .await
    .map_err(|e| format!("mesh range task panicked: {e}"))??;

    let started_parse = std::time::Instant::now();
    let (bodies, metadata_json) = mesh_bodies(
        &bytes,
        classify.unwrap_or(true),
        refine.unwrap_or(true),
    )?;

    // Keep the mesh for its AO bake. The bake needs exactly this mesh, and sending
    // one back costs 36 bytes a triangle; a single body is the VOXL case, and only a
    // single body can be named by one token.
    let token = if bodies.len() == 1 {
        // One copy, and only of a welded mesh (13 MB for a 726k-triangle model): the
        // payload below must encode the same mesh the registry holds.
        Some(registry::register(bodies[0].clone()))
    } else {
        None
    };
    let tri_count: usize = bodies.iter().map(|body| body.triangles.len()).sum();
    log::info!(
        "[load_mesh_range] {} bytes at {offset} in {}ms (read+inflate), parsed in {}ms,          of {}ms total{}",
        bytes.len(),
        read_ms,
        started_parse.elapsed().as_millis(),
        started.elapsed().as_millis(),
        if token.is_some() { ", mesh kept for the bake" } else { "" },
    );
    encode_mesh_bodies(&bodies, tri_count as u32, false, None, metadata_json.as_deref(), token)
        .map(Response::new)
}

/// Parse a file's bytes, refine its coarse faces when asked, and classify when asked.
///
/// Split out of the encoders so a caller that wants to *keep* the refined mesh (the
/// range loader does, for the AO bake — see the `registry` module) gets the same
/// meshes the payload was built from, without a second parse.
///
/// `refine` is false for the mesh a VOXL stores. That payload is the scene geometry
/// the app already refined, and refinement is not idempotent: on the reported scene it
/// turned 81,282 triangles into 126,386 on the next load, so a `classification`
/// written for the first count could never address the second, every load re-ran the
/// classifier (which reorders the soup), and a save/load cycle grew the mesh by half.
/// Refining what is already refined is the one thing a reader must not do.
fn mesh_bodies(
    bytes: &[u8],
    classify: bool,
    refine: bool,
) -> Result<(Vec<IndexedMesh>, Option<String>), String> {
    let mesh = io::stl::parse_bytes(bytes)
        .map_err(|e| format!("Failed to parse mesh bytes: {e}"))?;
    let mesh = if refine { io::refine_coarse_faces(mesh) } else { mesh };
    Ok(if classify {
        classify_single_body(mesh)
    } else {
        (vec![mesh], None)
    })
}

/// The pipeline behind `load_mesh_bytes`: parse the file's bytes, refine, classify
/// when asked, and encode the same `DFMX` payload the path loader writes.
fn load_mesh_bytes_response(
    bytes: &[u8],
    classify: bool,
    refine: bool,
) -> Result<Vec<u8>, String> {
    let started = std::time::Instant::now();
    let (bodies, metadata_json) = mesh_bodies(bytes, classify, refine)?;

    let tri_count: usize = bodies.iter().map(|body| body.triangles.len()).sum();
    let encoded = encode_mesh_bodies(&bodies, tri_count as u32, false, None, metadata_json.as_deref(), None)?;
    // The other half of the import's per-model time: the frontend logs its own
    // round trip for the same call, and the wire between them measures 110-135
    // MB/s, so this line and that one together say where a model's load went.
    log::info!(
        "[load_mesh_bytes] parsed, refined and encoded in {}ms",
        started.elapsed().as_millis()
    );
    Ok(encoded)
}

/// Classify one body: section-ordered mesh plus the report as JSON.
///
/// Both loaders share this, so a file and a byte payload produce the same report
/// for the same mesh, and the report rides the `DFMX` metadata tail either way.
fn classify_single_body(mesh: IndexedMesh) -> (Vec<IndexedMesh>, Option<String>) {
    let started = std::time::Instant::now();
    let outcome = classify_support_split(mesh, &RepairOptions::default());
    log::info!(
        "[load_mesh] classified in {}ms (model section {:?} triangles)",
        started.elapsed().as_millis(),
        outcome.report.model_triangle_count,
    );
    // The report timestamps its own sub-steps, so the share each pass holds is
    // visible without a profiler: total minus the split step is the analysis and
    // manifold work around it.
    for step in &outcome.report.steps {
        log::info!("[load_mesh]   step {} in {:.1}ms", step.name, step.elapsed_ms);
    }
    log::info!(
        "[load_mesh]   native report total {:.1}ms",
        outcome.report.total_ms
    );
    (
        vec![outcome.mesh],
        serde_json::to_string(&outcome.report).ok(),
    )
}

/// DragonFruit Mesh Transfer (DFMX) Binary IPC Protocol Specification:
/// Format Version: 1
///
/// The one wire format a native load returns, for a single body (STL, OBJ) or
/// several (a 3MF). Versioned, so an encoding flag (quantized positions,
/// compression) can be added without breaking readers.
///
/// Header (32 bytes):
///   0 ..  3 : ASCII Magic "DFMX" (0x44464D58)
///   4 ..  7 : Version u32 LE (currently 1)
///   8 .. 11 : Flags u32 LE (Bit 0: IS_PREVIEW)
///  12 .. 15 : Body count u32 LE
///  16 .. 19 : Original input triangle count u32 LE
///  20 .. 23 : Model section triangle count u32 LE (0 when absent)
///  24 .. 27 : Metadata JSON byte length (u32 LE, 0 when absent)
///  28 .. 31 : Mesh token u32 LE (0 when the loader kept nothing): names the refined
///             mesh in the bake registry, so the AO bake can be asked for it instead
///             of being sent the soup back
///
/// Body table: `bodyCount` entries of 8 bytes each, in payload order:
///   0 .. 3 : Triangle count u32 LE
///   4 .. 7 : Length of this body's packed stream u32 LE
///
/// Payload: each body in table order, as a zlib stream. A body unpacks to its
/// soup: positions then normals, 9 f32 per triangle each (72 bytes/triangle). The
/// metadata JSON, when present, is the last `metadataLength` bytes of the payload
/// — a reader that does not know the key reads the bodies and ignores the tail.
/// The refined meshes a load just built, waiting for the AO bake that needs one.
///
/// A model's mesh crosses the IPC once (as `DFMX`) and then, until now and for the
/// same model, a second time *back* as a soup for the bake — 36 bytes a triangle,
/// 430 MB across a scene's models. The bake cannot avoid that by re-reading a range:
/// measured, re-deriving a mesh costs 230-480 ms of native CPU a model against an
/// upload that is already overlapped, which is the trade the bake gate and the soup
/// packing both lost. It can avoid it by *keeping* the mesh: the loader has it in
/// hand, a welded mesh is small (13 MB for a 726k-triangle model), and the bake needs
/// exactly that mesh — re-welding the same soup at the bake's own epsilon was measured
/// to produce the identical vertex set and a bit-identical field (rms 0.00000 over
/// 2.18M values on a real model), so the weld it currently pays for is redundant too.
///
/// Bounded: the oldest entry is dropped past `MESH_REGISTRY_CAP`, which a load never
/// reaches (a mesh is registered by its load and taken by its bake moments later).
mod registry {
    use dragonfruit_mesh_core::mesh::IndexedMesh;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex, OnceLock};

    const MESH_REGISTRY_CAP: usize = 8;

    static REGISTRY: OnceLock<Mutex<VecDeque<(u32, Arc<IndexedMesh>)>>> = OnceLock::new();
    static NEXT_TOKEN: OnceLock<Mutex<u32>> = OnceLock::new();

    /// Keep `mesh` for its bake and return the token that names it.
    pub(crate) fn register(mesh: IndexedMesh) -> u32 {
        let mut next = NEXT_TOKEN
            .get_or_init(|| Mutex::new(1))
            .lock()
            .expect("mesh registry token lock");
        let token = *next;
        *next = next.wrapping_add(1).max(1);

        let mut registry = REGISTRY
            .get_or_init(|| Mutex::new(VecDeque::new()))
            .lock()
            .expect("mesh registry lock");
        registry.push_back((token, Arc::new(mesh)));
        while registry.len() > MESH_REGISTRY_CAP {
            registry.pop_front();
        }
        token
    }

    /// The mesh a token names, if it is still registered.
    pub(crate) fn get(token: u32) -> Option<Arc<IndexedMesh>> {
        let registry = REGISTRY
            .get_or_init(|| Mutex::new(VecDeque::new()))
            .lock()
            .expect("mesh registry lock");
        registry
            .iter()
            .find(|(registered, _)| *registered == token)
            .map(|(_, mesh)| Arc::clone(mesh))
    }
}

/// The mesh a bake token names, checked against the corner count the caller has.
///
/// The check is the guard that makes the token safe: a caller's geometry is the mesh
/// it loaded, and a count that disagrees means the geometry was replaced or rewritten
/// since — a repair, a swap, a smoothing pass — so the field computed here would be
/// attached to a mesh it was never computed for. Refusing sends the caller back to
/// sending the soup, which is the path that cannot go stale.
pub(crate) fn mesh_for_bake(
    token: u32,
    expected_corners: usize,
) -> Result<std::sync::Arc<IndexedMesh>, String> {
    let mesh = registry::get(token)
        .ok_or_else(|| format!("mesh token {token} is no longer registered"))?;
    if expected_corners != 0 && mesh.triangles.len() * 3 != expected_corners {
        return Err(format!(
            "mesh token {token} has {} corners, the caller has {expected_corners}",
            mesh.triangles.len() * 3
        ));
    }
    Ok(mesh)
}

const MESH_RESPONSE_MAGIC: &[u8; 4] = b"DFMX";
/// Version 2: each body is a zlib stream holding that body's soup.
///
/// Version 1 wrote the soup raw, and a soup is 72 bytes a triangle — 910 MB across
/// the 15-model scene this is measured on, which is the largest single cost in a
/// scene load. Tauri's IPC does 189 MB/s with thirteen transfers in flight but only
/// ~75 MB/s effective during an import, because the transfer and the single main
/// thread that receives and prepares each model take turns; the volume is what the
/// load pays. The same soup deflates 2.7x at zlib level 1 (65.8 -> 24.2 MB on an
/// 869k-triangle model), and the renderer inflates it with the platform's
/// `DecompressionStream` — off the main thread, unlike `fflate`'s pool, which waits
/// on its workers through SharedArrayBuffer and blocks the thread it should free.
const MESH_RESPONSE_VERSION: u32 = 2;
const MESH_RESPONSE_HEADER_BYTES: usize = 32;
const MESH_RESPONSE_BODY_ENTRY_BYTES: usize = 8;
const MESH_RESPONSE_FLAG_PREVIEW: u32 = 1;
/// Positions plus normals, both 9 f32 per triangle.
const SOUP_BYTES_PER_TRIANGLE: usize = 9 * std::mem::size_of::<f32>() * 2;

fn encode_mesh_bodies(
    bodies: &[IndexedMesh],
    original_triangle_count: u32,
    is_preview: bool,
    model_triangle_count: Option<u32>,
    metadata_json: Option<&str>,
    mesh_token: Option<u32>,
) -> Result<Vec<u8>, String> {
    let total_triangles: usize = bodies.iter().map(|body| body.triangles.len()).sum();
    let metadata_len = metadata_json.map_or(0, str::len);
    // Each body is encoded and packed on its own: a body is the unit a reader turns
    // into a geometry, and packing bodies together would make one body's first byte
    // depend on another's.
    let packed: Vec<Vec<u8>> = bodies
        .iter()
        .map(encode_body_deflated)
        .collect::<Result<_, _>>()?;
    let packed_len: usize = packed.iter().map(Vec::len).sum();
    let response_len = MESH_RESPONSE_HEADER_BYTES
        .checked_add(bodies.len() * MESH_RESPONSE_BODY_ENTRY_BYTES)
        .and_then(|size| size.checked_add(packed_len))
        .and_then(|size| size.checked_add(metadata_len))
        .ok_or_else(|| "DFMX response size overflow".to_string())?;

    let mut result = Vec::new();
    result.try_reserve_exact(response_len).map_err(|_| {
        format!(
            "Not enough memory for the mesh response ({:.2} GB)",
            response_len as f64 / 1_000_000_000.0
        )
    })?;
    result.extend_from_slice(MESH_RESPONSE_MAGIC);
    result.extend_from_slice(&MESH_RESPONSE_VERSION.to_le_bytes());
    result.extend_from_slice(
        &(if is_preview {
            MESH_RESPONSE_FLAG_PREVIEW
        } else {
            0
        })
        .to_le_bytes(),
    );
    result.extend_from_slice(&(bodies.len() as u32).to_le_bytes());
    result.extend_from_slice(&original_triangle_count.to_le_bytes());
    result.extend_from_slice(&model_triangle_count.unwrap_or(0).to_le_bytes());
    result.extend_from_slice(&(metadata_len as u32).to_le_bytes());
    // The reserved slot is the registry token when the loader kept the mesh for the
    // bake (0 = nothing kept). See the `registry` module above.
    result.extend_from_slice(&mesh_token.unwrap_or(0).to_le_bytes());
    for (body, bytes) in bodies.iter().zip(&packed) {
        result.extend_from_slice(&(body.triangles.len() as u32).to_le_bytes());
        result.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    }
    for bytes in &packed {
        result.extend_from_slice(bytes);
    }
    if let Some(json) = metadata_json {
        result.extend_from_slice(json.as_bytes());
    }
    debug_assert_eq!(result.len(), response_len);

    log::info!(
        "[load_mesh] {} bodies, {} triangles, {:.1} MB payload ({:.1}x deflated), {} B metadata",
        bodies.len(),
        total_triangles,
        (response_len - MESH_RESPONSE_HEADER_BYTES) as f64 / 1_000_000.0,
        total_triangles as f64 * SOUP_BYTES_PER_TRIANGLE as f64 / packed_len.max(1) as f64,
        metadata_len,
    );
    Ok(result)
}

/// One body's soup, zlib-packed at the fastest level.
///
/// Level 1 rather than the default: the encoder runs per model on the import's
/// critical path, and on this data the difference is 2.7x against 3.6x for six
/// times the CPU (36 ms against 226 ms on an 869k-triangle model, measured with
/// Node's zlib on a real soup).
fn encode_body_deflated(body: &IndexedMesh) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let mut raw = vec![0u8; body.triangles.len() * SOUP_BYTES_PER_TRIANGLE];
    write_soup(body, &mut raw);
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder
        .write_all(&raw)
        .map_err(|e| format!("DFMX body compression failed: {e}"))?;
    encoder
        .finish()
        .map_err(|e| format!("DFMX body compression failed: {e}"))
}

/// Write a mesh's soup — positions (9 f32 per triangle), then one normal per
/// corner — into `out`, which must be exactly `triangleCount * 72` bytes.
///
/// Every corner carries its own triangle's geometric normal, so the viewport
/// shades the facets the file describes (see `dragonfruit_mesh_core::normals`).
/// The geometry a repair pass hands back gets the same normals from the
/// renderer's per-face recompute, so repairing a model no longer changes how it
/// looks.
fn write_soup(mesh: &IndexedMesh, out: &mut [u8]) {
    let positions_len = mesh.triangles.len() * 9 * std::mem::size_of::<f32>();
    let (position_output, normal_output) = out.split_at_mut(positions_len);
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
    // One face normal per triangle, written onto its three corners: see
    // `dragonfruit_mesh_core::normals` for why the welded average is gone.
    let normals = dragonfruit_mesh_core::normals::face_normals(mesh);
    normal_output
        .par_chunks_mut(9 * std::mem::size_of::<f32>())
        .zip(normals.par_iter())
        .for_each(|(output, normal)| {
            for normal_output in output.chunks_exact_mut(12) {
                normal_output[0..4].copy_from_slice(&normal.x.to_le_bytes());
                normal_output[4..8].copy_from_slice(&normal.y.to_le_bytes());
                normal_output[8..12].copy_from_slice(&normal.z.to_le_bytes());
            }
        });
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
            "[load_mesh_file] Topology-safe preview region {}/{}: {} source triangles, {} total output triangles",
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

    /// Parse the first body of an encoded `DFMX` response into (positions,
    /// normals) as f32 triples. These fixtures carry one body, so the soup
    /// starts right after the header and its single table entry.
    fn decode_positions_and_normals(bytes: &[u8]) -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
        use std::io::Read;

        let entry = MESH_RESPONSE_HEADER_BYTES;
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            MESH_RESPONSE_VERSION,
            "the fixture must be a current payload"
        );
        let tri_count =
            u32::from_le_bytes(bytes[entry..entry + 4].try_into().unwrap()) as usize;
        let packed_len =
            u32::from_le_bytes(bytes[entry + 4..entry + 8].try_into().unwrap()) as usize;
        let start = entry + MESH_RESPONSE_BODY_ENTRY_BYTES;

        // Bodies ship packed (version 2): unpack the one this fixture carries.
        let mut soup = Vec::with_capacity(tri_count * SOUP_BYTES_PER_TRIANGLE);
        flate2::read::ZlibDecoder::new(&bytes[start..start + packed_len])
            .read_to_end(&mut soup)
            .expect("the body must inflate");
        assert_eq!(soup.len(), tri_count * SOUP_BYTES_PER_TRIANGLE, "soup size");

        let floats = |offset: usize| -> Vec<[f32; 3]> {
            (0..tri_count * 3)
                .map(|v| {
                    let at = offset + v * 12;
                    [
                        f32::from_le_bytes(soup[at..at + 4].try_into().unwrap()),
                        f32::from_le_bytes(soup[at + 4..at + 8].try_into().unwrap()),
                        f32::from_le_bytes(soup[at + 8..at + 12].try_into().unwrap()),
                    ]
                })
                .collect()
        };
        (floats(0), floats(tri_count * 36))
    }

    /// A coarsely triangulated cylinder: every adjacent face pair differs by enough
    /// that a flat-shaded import is unmistakable.
    fn cylinder_mesh(sides: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        for z in [0.0f32, 1.0] {
            for i in 0..sides {
                let angle = std::f32::consts::TAU * i as f32 / sides as f32;
                positions.push(Vec3::new(angle.cos(), angle.sin(), z));
            }
        }
        let mut triangles = Vec::new();
        for i in 0..sides {
            let j = (i + 1) % sides;
            let (b0, b1) = (i as u32, j as u32);
            let (t0, t1) = ((sides + i) as u32, (sides + j) as u32);
            triangles.push([b0, b1, t1]);
            triangles.push([b0, t1, t0]);
        }
        IndexedMesh { positions, triangles }
    }

    /// The soup carries each triangle's own geometric normal, not an average.
    ///
    /// The viewport shades the facets the file describes, so a position two faces
    /// meet at is shaded by two normals. It used to be one: the encoder averaged
    /// the faces incident to a welded vertex, and later only those within a crease
    /// angle of the corner's own. That painted a smooth surface over the
    /// triangulation — a scan's facets and an imported edge both came out soft —
    /// and it disagreed with the geometry a repair pass hands back, which the
    /// renderer recomputes per face, so the same model changed its shading the
    /// moment it was repaired. `face_normals` owns the rule; this pins what the
    /// payload ships.
    #[test]
    fn imported_normals_are_each_face_own_geometric_normal() {
        let sides = 8;
        let mesh = cylinder_mesh(sides);
        let bytes = encode_mesh_bodies(std::slice::from_ref(&mesh), mesh.triangles.len() as u32, false, None, None, None)
            .unwrap();
        let (positions, normals) = decode_positions_and_normals(&bytes);

        // Read back from the payload's own numbers: every corner of a triangle
        // carries that triangle's geometric normal, right-handed with its winding.
        for tri in 0..mesh.triangles.len() {
            let a = positions[tri * 3];
            let b = positions[tri * 3 + 1];
            let c = positions[tri * 3 + 2];
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let cross = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let length = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
            assert!(length > 1e-6, "the fixture must not be degenerate");
            for corner in 0..3 {
                for axis in 0..3 {
                    let shipped = normals[tri * 3 + corner][axis];
                    let expected = cross[axis] / length;
                    assert!(
                        (shipped - expected).abs() < 1e-4,
                        "face {tri} corner {corner} axis {axis}: shipped {shipped}, expected \
                         {expected} - the payload is not the face's own normal"
                    );
                }
            }
        }

        // A shared position is therefore shaded by more than one normal.
        // Indexed by position, which is what the consumer sees, so this does not
        // depend on the builder's corner ordering.
        let mut shared: std::collections::HashMap<[i64; 3], Vec<[f32; 3]>> =
            std::collections::HashMap::new();
        for (corner, position) in positions.iter().enumerate() {
            let key = [
                (position[0] * 4096.0).round() as i64,
                (position[1] * 4096.0).round() as i64,
                (position[2] * 4096.0).round() as i64,
            ];
            shared.entry(key).or_default().push(normals[corner]);
        }
        let mut faceted = 0usize;
        for (key, list) in &shared {
            if list.len() < 2 {
                continue;
            }
            let differs = list.iter().any(|normal| {
                (0..3).any(|axis| (normal[axis] - list[0][axis]).abs() > 1e-6)
            });
            assert!(
                differs,
                "position {key:?} is shaded by one averaged normal ({:?}) - the mesh will render \
                 smooth over its own facets",
                list[0]
            );
            faceted += 1;
        }
        assert!(faceted >= sides, "the fixture must have shared vertices, got {faceted}");
    }

    /// The fold angle decides nothing: no two faces are averaged, however shallow.
    ///
    /// The crease rule this replaces averaged a shallow fold and split a hard one,
    /// so a scanned surface came out smooth and a right angle crisp — the angle is
    /// a property of the model's shape, not of what its shading should show. The
    /// second half of that rule is also what a repair pass disagreed with: it
    /// recomputes normals per face, so repairing a model changed how it looked.
    #[test]
    fn a_fold_keeps_its_two_normals_at_any_angle() {
        // Two quads sharing the edge x = 0, folded by `fold_deg` about it: a
        // floor to the left, a wall rising to the right at that angle. The two
        // crease vertices are shared, which is what the welding produces on a
        // model where an organic shape meets a base.
        let folded = |fold_deg: f32| -> IndexedMesh {
            let angle = fold_deg.to_radians();
            let (sin, cos) = angle.sin_cos();
            let positions = vec![
                Vec3::new(0.0, 0.0, 0.0),  // 0: crease
                Vec3::new(0.0, 1.0, 0.0),  // 1: crease
                Vec3::new(-1.0, 0.0, 0.0), // 2: floor
                Vec3::new(-1.0, 1.0, 0.0), // 3: floor
                Vec3::new(0.0, 1.0, 0.0),  // 4: wall
                Vec3::new(0.0, 0.0, 0.0),  // 5: wall
            ];
            let mut positions = positions;
            positions[4] = Vec3::new(cos, 1.0, sin);
            positions[5] = Vec3::new(cos, 0.0, sin);
            IndexedMesh {
                positions,
                triangles: vec![[0, 2, 3], [0, 3, 1], [1, 4, 5], [1, 5, 0]],
            }
        };

        // The two faces at the shared vertices keep their own normals at either
        // angle: up for the floor, turned by the fold for the wall.
        for fold_deg in [20.0f32, 90.0] {
            let mesh = folded(fold_deg);
            let bytes = encode_mesh_bodies(std::slice::from_ref(&mesh), mesh.triangles.len() as u32, false, None, None, None)
                .unwrap();
            let (_, normals) = decode_positions_and_normals(&bytes);
            let floor_normal = normals[0];
            let fold_normal = normals[2 * 3];
            assert!(
                floor_normal[2].abs() > 0.9,
                "the floor face should keep an upward normal, got {floor_normal:?}"
            );
            let dot: f32 = (0..3).map(|i| floor_normal[i] * fold_normal[i]).sum();
            assert!(
                dot < 0.999,
                "a {fold_deg} degree fold must not be averaged into one normal, got dot {dot}"
            );
        }
    }

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
        assert!(parse_options(r#"{"weldToleranceMm": "tiny"}"#).is_err());
        assert!(parse_hole_punch_options(r#"{"punches": {}}"#).is_err());
    }

    #[test]
    fn test_stl_preview_reports_its_model_triangle_count() {
        use std::io::Write;

        let path = std::env::temp_dir().join("test_stl_preview.stl");
        let mut file = std::fs::File::create(&path).unwrap();
        let mut header = [0u8; 84];
        header[80..84].copy_from_slice(&10u32.to_le_bytes());
        file.write_all(&header).unwrap();
        for _ in 0..10 {
            let record = [0u8; 50];
            file.write_all(&record).unwrap();
        }
        drop(file);

        // The forced count stands in for a re-decimation, so the preview path
        // runs on a 10-triangle fixture instead of a 4M-triangle one.
        let bytes = stl_special_case_response(&path, path.to_str().unwrap(), Some(6))
            .unwrap()
            .expect("the forced count should trigger the preview path");
        let _ = std::fs::remove_file(&path);

        assert_eq!(&bytes[0..4], b"DFMX");
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()) & 1, 1, "preview flag");
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 10, "original count");
        assert_eq!(u32::from_le_bytes(bytes[20..24].try_into().unwrap()), 6, "model count");
    }

    #[test]
    fn test_load_mesh_file_dispatches_by_extension() {
        use std::io::Write;
        use tauri::ipc::IpcResponse;

        let dir = std::env::temp_dir();
        let stl_path = dir.join("test_load_mesh_file.stl");
        let obj_path = dir.join("test_load_mesh_file.obj");

        // Binary STL with three degenerate (all-zero) triangles: a zero diagonal,
        // so the dispatcher's refinement no-ops and the count is exact.
        {
            let mut file = std::fs::File::create(&stl_path).unwrap();
            let mut header = [0u8; 84];
            header[80..84].copy_from_slice(&3u32.to_le_bytes());
            file.write_all(&header).unwrap();
            for _ in 0..3 {
                file.write_all(&[0u8; 50]).unwrap();
            }
        }
        // OBJ with one triangle, whose edges are far longer than the refinement
        // target, so the load proves it went through `io::load_mesh_from_path`.
        std::fs::write(&obj_path, b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let raw = |resp: Result<Response, String>| match resp.unwrap().body().unwrap() {
            tauri::ipc::InvokeResponseBody::Raw(b) => b,
            _ => panic!("Expected Raw body"),
        };
        // DFMX: body count at 12, body table at 32 (8 bytes each: triangles, then
        // the packed stream's length), then the packed bodies.
        let u32_at = |bytes: &[u8], at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let bodies = |bytes: &[u8]| u32_at(bytes, 12);
        let body_triangles = |bytes: &[u8], index: usize| u32_at(bytes, 32 + index * 8);
        let body_packed_len = |bytes: &[u8], index: usize| u32_at(bytes, 36 + index * 8);
        let described_len = |bytes: &[u8]| {
            let count = bodies(bytes) as usize;
            let metadata = u32_at(bytes, 24) as usize;
            (0..count).fold(32 + count * 8 + metadata, |sum, i| {
                sum + body_packed_len(bytes, i) as usize
            })
        };

        let stl = raw(rt.block_on(load_mesh_file(
            stl_path.to_str().unwrap().to_string(),
            Some(true),
        )));
        assert_eq!(&stl[0..4], b"DFMX");
        assert_eq!(u32_at(&stl, 4), MESH_RESPONSE_VERSION, "DFMX version");
        assert_eq!(bodies(&stl), 1);
        assert_eq!(body_triangles(&stl, 0), 3);
        assert_eq!(stl.len(), described_len(&stl));
        // A single-body load is classified natively, so its report rides the tail
        // and the frontend has nothing to stage back.
        let metadata_len = u32_at(&stl, 24) as usize;
        assert!(metadata_len > 0, "the single-body load should carry a report");
        let metadata = std::str::from_utf8(&stl[stl.len() - metadata_len..]).unwrap();
        // `model_triangle_count` is skipped when the classifier found no split, so
        // the identity assertion is the JSON envelope, not a particular key.
        assert!(
            metadata.starts_with("{\"version\""),
            "the tail should be the report JSON: {metadata}"
        );

        let obj = raw(rt.block_on(load_mesh_file(
            obj_path.to_str().unwrap().to_string(),
            None,
        )));
        assert_eq!(&obj[0..4], b"DFMX");
        assert_eq!(bodies(&obj), 1);
        assert!(
            body_triangles(&obj, 0) > 1,
            "the coarse OBJ should have been refined"
        );
        assert_eq!(obj.len(), described_len(&obj));

        // An unsupported extension is an error, not a panic.
        let bad = dir.join("test_load_mesh_file.xyz");
        assert!(rt
            .block_on(load_mesh_file(bad.to_str().unwrap().to_string(), None))
            .is_err());

        let _ = std::fs::remove_file(&stl_path);
        let _ = std::fs::remove_file(&obj_path);
    }

    /// A byte source has no path, so `load_mesh_bytes` carries the whole pipeline:
    /// parse, refine, classify, encode the same payload the path loader writes.
    /// The range loader: a container chunk read from a file, inflated and parsed.
    ///
    /// The same pipeline as the byte loader, so what this pins is the range
    /// arithmetic and the compression codes — a wrong offset or a zlib stream read
    /// as raw would decode to a mesh that is not the one in the file.
    #[test]
    fn test_load_mesh_range_reads_inflates_and_parses_a_chunk() {
        use std::io::Write;
        use tauri::ipc::IpcResponse;

        let mut stl = vec![0u8; 84];
        stl[80..84].copy_from_slice(&3u32.to_le_bytes());
        stl.extend(std::iter::repeat_n(0u8, 3 * 50));
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&stl).unwrap();
        let packed = encoder.finish().unwrap();

        let dir = std::env::temp_dir().join(format!("df-load-mesh-range-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("container.bin");
        {
            let mut file = std::fs::File::create(&path).unwrap();
            file.write_all(&[0xABu8; 64]).unwrap();
            file.write_all(&packed).unwrap();
        }
        let path = path.to_str().unwrap().to_string();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let raw = |resp: Result<Response, String>| match resp.unwrap().body().unwrap() {
            tauri::ipc::InvokeResponseBody::Raw(b) => b,
            _ => panic!("Expected Raw body"),
        };

        let bytes = raw(rt.block_on(load_mesh_range(
            path.clone(),
            64,
            packed.len() as u64,
            1,
            Some(false),
            Some(true),
        )));
        assert_eq!(&bytes[0..4], b"DFMX");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            MESH_RESPONSE_VERSION
        );
        assert_eq!(u32::from_le_bytes(bytes[32..36].try_into().unwrap()), 3, "triangles");

        // The same chunk read as raw bytes is not an STL, and a range that runs off
        // the end of the file is an error rather than a short payload.
        assert!(rt
            .block_on(load_mesh_range(path.clone(), 64, packed.len() as u64, 7, None, None))
            .is_err());
        assert!(rt
            .block_on(load_mesh_range(path.clone(), 64, 100_000_000, 1, None, None))
            .is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The bake token's guard: what it refuses is a geometry that moved on.
    #[test]
    fn test_mesh_for_bake_refuses_a_mesh_the_caller_no_longer_has() {
        let mesh = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            triangles: vec![[0, 1, 2]],
        };
        let token = registry::register(mesh);

        // The caller's count agrees: the mesh comes back.
        assert_eq!(
            mesh_for_bake(token, 3).expect("matching corners").triangles.len(),
            1
        );
        // A geometry that has grown or been replaced since: refused, so the caller
        // falls back to sending the soup rather than taking a stale field.
        assert!(mesh_for_bake(token, 9).is_err());
        // A token nobody registered (an evicted one, or a restart): refused.
        assert!(mesh_for_bake(token.wrapping_add(97), 3).is_err());
    }

    #[test]
    fn test_load_mesh_bytes_leaves_scene_geometry_unrefined_when_asked() {
        // One 100 mm triangle: its longest edge is 70x the refine threshold
        // (2% of the bbox diagonal), so the default pass splits it.
        let corners = [[0.0f32, 0.0, 0.0], [100.0, 0.0, 0.0], [0.0, 100.0, 0.0]];
        let mut stl = vec![0u8; 84];
        stl[80..84].copy_from_slice(&1u32.to_le_bytes());
        stl.extend(std::iter::repeat_n(0u8, 12)); // face normal
        for corner in corners {
            for value in corner {
                stl.extend_from_slice(&value.to_le_bytes());
            }
        }
        stl.extend_from_slice(&[0u8; 2]); // attribute byte count
        let triangle_count = |response: &[u8]| {
            u32::from_le_bytes(response[16..20].try_into().unwrap()) as usize
        };

        let refined = load_mesh_bytes_response(&stl, false, true).unwrap();
        assert!(triangle_count(&refined) > 1, "the coarse triangle should be split");

        // A VOXL payload is already the scene's refined geometry; re-refining it
        // invalidates the classification it carries and grows on every reload.
        let as_stored = load_mesh_bytes_response(&stl, false, false).unwrap();
        assert_eq!(triangle_count(&as_stored), 1);
    }

    #[test]
    fn test_load_mesh_bytes_parses_refines_and_classifies() {
        let mut stl = vec![0u8; 84];
        stl[80..84].copy_from_slice(&3u32.to_le_bytes());
        stl.extend(std::iter::repeat_n(0u8, 3 * 50));

        let classified = load_mesh_bytes_response(&stl, true, true).unwrap();
        assert_eq!(&classified[0..4], b"DFMX");
        assert_eq!(u32::from_le_bytes(classified[12..16].try_into().unwrap()), 1);
        let metadata_len = u32::from_le_bytes(classified[24..28].try_into().unwrap()) as usize;
        assert!(metadata_len > 0, "classify should attach a report");
        let json = std::str::from_utf8(&classified[classified.len() - metadata_len..]).unwrap();
        assert!(json.starts_with("{\"version\""));

        // A caller that will repair asks for no report and gets no tail.
        let plain = load_mesh_bytes_response(&stl, false, true).unwrap();
        assert_eq!(&plain[0..4], b"DFMX");
        assert_eq!(u32::from_le_bytes(plain[24..28].try_into().unwrap()), 0);
        let packed = u32::from_le_bytes(plain[36..40].try_into().unwrap()) as usize;
        assert_eq!(
            plain.len(),
            MESH_RESPONSE_HEADER_BYTES + MESH_RESPONSE_BODY_ENTRY_BYTES + packed
        );
        assert!(packed < 3 * 72, "the body ships packed, not as a raw soup");
    }

    #[test]
    fn test_encode_mesh_bodies_appends_metadata_at_the_tail() {
        let body = IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            triangles: vec![[0, 1, 2]],
        };
        let json = r#"{"model_triangle_count":1}"#;
        let bytes =
            encode_mesh_bodies(std::slice::from_ref(&body), 1, false, Some(1), Some(json), None).unwrap();

        let metadata_len = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
        assert_eq!(metadata_len, json.len(), "header carries the metadata length");
        let packed = u32::from_le_bytes(bytes[36..40].try_into().unwrap()) as usize;
        assert_eq!(
            bytes.len(),
            MESH_RESPONSE_HEADER_BYTES + MESH_RESPONSE_BODY_ENTRY_BYTES + packed + metadata_len,
            "tail sits after every body"
        );
        assert_eq!(&bytes[bytes.len() - metadata_len..], json.as_bytes());
    }

    #[test]
    fn test_encode_mesh_bodies_lays_out_every_body() {
        let bodies = vec![
            IndexedMesh {
                positions: vec![
                    Vec3::new(0.0, 0.0, 0.0),
                    Vec3::new(1.0, 0.0, 0.0),
                    Vec3::new(0.0, 1.0, 0.0),
                ],
                triangles: vec![[0, 1, 2]],
            },
            IndexedMesh {
                positions: vec![Vec3::new(0.0, 0.0, 0.0); 4],
                triangles: vec![[0, 1, 2], [0, 2, 3]],
            },
        ];
        let bytes = encode_mesh_bodies(&bodies, 3, false, None, None, None).unwrap();

        assert_eq!(&bytes[0..4], b"DFMX");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            MESH_RESPONSE_VERSION
        );
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 3);
        // Body table records each body's triangle count, in payload order.
        assert_eq!(u32::from_le_bytes(bytes[32..36].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 2);
        let packed0 = u32::from_le_bytes(bytes[36..40].try_into().unwrap()) as usize;
        let packed1 = u32::from_le_bytes(bytes[44..48].try_into().unwrap()) as usize;
        assert_eq!(
            bytes.len(),
            MESH_RESPONSE_HEADER_BYTES + 2 * MESH_RESPONSE_BODY_ENTRY_BYTES + packed0 + packed1
        );

        // Bodies are independent streams, each unpacking to its own soup: body 1's
        // vertices are the origin it was built with, so a reader that shared one
        // stream between them would see body 0's data here.
        use std::io::Read;
        let first = MESH_RESPONSE_HEADER_BYTES + 2 * MESH_RESPONSE_BODY_ENTRY_BYTES;
        let mut soup0 = Vec::new();
        flate2::read::ZlibDecoder::new(&bytes[first..first + packed0])
            .read_to_end(&mut soup0)
            .unwrap();
        let mut soup1 = Vec::new();
        flate2::read::ZlibDecoder::new(&bytes[first + packed0..first + packed0 + packed1])
            .read_to_end(&mut soup1)
            .unwrap();
        assert_eq!(soup0.len(), SOUP_BYTES_PER_TRIANGLE);
        assert_eq!(soup1.len(), 2 * SOUP_BYTES_PER_TRIANGLE);
        assert_eq!(f32::from_le_bytes(soup0[12..16].try_into().unwrap()), 1.0);
        assert!(soup1.iter().all(|byte| *byte == 0), "body 1 is the degenerate fixture");
    }
}
