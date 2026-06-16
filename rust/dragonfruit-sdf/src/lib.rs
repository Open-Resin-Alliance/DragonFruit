//! Pre-computed sparse signed distance field (SDF) for support pathfinding.
//!
//! Replaces the lazy BVH-backed `SDFCache` on the frontend with a dense grid
//! pre-computed in Rust using rayon parallelism.  Once computed at model-load
//! time, every SDF query becomes an O(1) hash lookup — zero BVH overhead.
//!
//! ## Architecture
//!
//! - `grid`    — `SparseSdfGrid`: the spatial-hash-backed distance field
//! - `compute` — parallel SDF computation from an indexed triangle mesh
//!
//! ## Data Flow
//!
//! ```text
//! Model Load -> IndexedMesh -> compute_sdf_grid() -> SparseSdfGrid
//!                                                   -> serialize -> Tauri IPC -> frontend
//! ```
//!
//! The grid is computed in model-local space.  World-space queries on the
//! frontend transform through the inverse model matrix (identical to what the
//! current SDFCache does).  Moving/rotating the model on the build plate does
//! NOT invalidate the grid.

pub mod compute;
pub mod grid;
pub mod heightmap;

pub use compute::{compute_sdf_grid, SdfMeshInput};
pub use grid::{SdfCell, SparseSdfGrid};
pub use heightmap::{compute_heightmap, ClearanceHeightmap};

/// Options controlling SDF pre-computation.
#[derive(Debug, Clone)]
pub struct SdfOptions {
    /// Grid cell size in model-space mm.  Default 0.5.
    pub cell_size: f32,

    /// Thickness of the shell around the mesh surface (mm).  Only cells
    /// within this distance of any triangle are computed; cells farther
    /// away are implicitly clear (distance = +∞).  Default 8.0.
    pub shell_thickness: f32,

    /// When > 0, cells within `inner_shell` mm of the surface use
    /// `cell_size` resolution; cells between `inner_shell` and
    /// `shell_thickness` use `cell_size * coarse_factor` resolution.
    /// Default 3.0.
    pub inner_shell: f32,

    /// Multiplier for the coarse outer shell cell size.  Default 3 (1.5 mm
    /// when cell_size is 0.5).
    pub coarse_factor: u32,
}

impl Default for SdfOptions {
    fn default() -> Self {
        Self {
            cell_size: 0.5,
            shell_thickness: 8.0,
            inner_shell: 3.0,
            coarse_factor: 3,
        }
    }
}
