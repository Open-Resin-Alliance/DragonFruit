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

pub use crate::analysis::{analyze, minimal_analysis, MeshAnalysis};
pub use crate::core::mesh::{IndexedMesh, Vec3};
pub use crate::hollowing::{
    hollow_voxel, punch_cylinders, DrainHoleSpec, HolePunchOptions, HolePunchOutcome,
    HolePunchReport, HolePunchSpec, HollowMode, HollowOptions, HollowOutcome, HollowReport,
    HollowSession, OpenFace,
};
pub use crate::repair::{classify_support_split, repair, RepairOptions, RepairOutcome};
pub use crate::report::MeshHealthReport;

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

#[derive(Debug, thiserror::Error)]
pub enum MeshRepairError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported file extension: {0}")]
    UnsupportedFormat(String),
    #[error("parse error: {0}")]
    Parse(String),
}
