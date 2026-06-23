//! DragonFruit mesh repair engine.
//!
//! Clean-room implementation of analysis + repair operations for triangle
//! meshes, targeted at high-performance native execution under Tauri.
//! See `1_Documentation/` and session plan for architecture notes.

pub mod analysis;
pub mod arrangement;
pub mod core;
pub mod hollowing;
pub mod io;
pub mod repair;
pub mod report;
pub mod support_reconstruction;

pub use crate::analysis::{analyze, minimal_analysis, MeshAnalysis};
pub use crate::core::mesh::{IndexedMesh, Vec3};
pub use crate::hollowing::{
    hollow_voxel, punch_cylinders, DrainHoleSpec, HolePunchOptions, HolePunchOutcome,
    HolePunchReport, HolePunchSpec, HollowMode, HollowOptions, HollowOutcome, HollowReport,
    HollowSession, OpenFace,
};
pub use crate::repair::{classify_support_split, repair, RepairOptions, RepairOutcome};
pub use crate::report::MeshHealthReport;
pub use crate::support_reconstruction::{
    reconstruct_supports, InferredSupportGraph, SupportReconstructionError,
    SupportReconstructionOptions, SupportReconstructionRequest, SupportReconstructionResult,
    SUPPORT_RECONSTRUCTION_ANALYZER_VERSION, SUPPORT_RECONSTRUCTION_SCHEMA_VERSION,
};

use std::path::Path;

/// High-level entry point: load a mesh from disk, analyze it, and return
/// the analysis without mutating the file.
pub fn analyze_path<P: AsRef<Path>>(path: P) -> Result<MeshAnalysis, MeshRepairError> {
    let mesh = crate::io::load_mesh_from_path(path.as_ref())?;
    Ok(analyze(&mesh))
}

/// High-level entry point: load a mesh from disk, run the repair pipeline,
/// and return the repaired mesh + report. The repaired mesh is *not* written
/// back to `path`; use [`io::write_positions_file`] to stage output for IPC.
pub fn repair_path<P: AsRef<Path>>(
    path: P,
    options: &RepairOptions,
) -> Result<RepairOutcome, MeshRepairError> {
    let mesh = crate::io::load_mesh_from_path(path.as_ref())?;
    Ok(repair(mesh, options))
}

/// Load separate model/support meshes and run the experimental reconstruction
/// research harness. Inputs are interpreted in the same coordinate system.
pub fn reconstruct_supports_path<P: AsRef<Path>, Q: AsRef<Path>>(
    model_path: P,
    support_path: Q,
    plate_z_mm: f32,
    options: &SupportReconstructionOptions,
) -> Result<SupportReconstructionResult, Box<dyn std::error::Error>> {
    let model = crate::io::load_mesh_from_path(model_path.as_ref())?;
    let support = crate::io::load_mesh_from_path(support_path.as_ref())?;
    Ok(reconstruct_supports(SupportReconstructionRequest {
        model,
        support,
        plate_z_mm,
        options: options.clone(),
    })?)
}

#[derive(Debug, thiserror::Error)]
pub enum MeshRepairError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported file extension: {0}")]
    UnsupportedFormat(String),
    #[error("parse error: {0}")]
    Parse(String),
}
