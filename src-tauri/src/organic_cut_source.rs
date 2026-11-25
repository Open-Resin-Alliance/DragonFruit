//! An organic cut session's state, held in the native mesh store as `Entry::Session`.
//!
//! The cut tool asks many times about one mesh while the user draws: a seam on every waypoint
//! drag, a membrane and a tenon preview whenever the drawing settles, and the cut itself. Parsing
//! the mesh and building the geodesic solver's graphs are the expensive part, and neither changes
//! until the mesh does, so a session keeps both between calls. They used to live in process-wide
//! slots holding one source for the whole app; as a store entry, each session is named by its id
//! and two of them never see each other's mesh.
//!
//! No Tauri types here, so `cargo test` drives it directly.

use std::fmt;
use std::sync::OnceLock;

use dragonfruit_mesh_repair::IndexedMesh;
use dragonfruit_organic_cut::GeodesicSolver;

/// The source mesh an organic cut session was opened on, and the geodesic solver built from it.
///
/// The session keeps its own parsed copy of the source, so the stored mesh it was opened from
/// can be dropped as soon as it is open.
pub struct OrganicCutSource {
    mesh: IndexedMesh,
    solver: OnceLock<GeodesicSolver>,
}

impl OrganicCutSource {
    pub fn new(mesh: IndexedMesh) -> Self {
        Self {
            mesh,
            solver: OnceLock::new(),
        }
    }

    /// The parsed source, for the previews that read it.
    pub fn mesh(&self) -> &IndexedMesh {
        &self.mesh
    }

    /// What the store counts for this entry: the parsed source. The solver is not counted yet;
    /// it is built on the first seam and holds a refined copy whose size depends on the mesh.
    pub fn byte_len(&self) -> usize {
        self.mesh.positions.len() * 12 + self.mesh.triangles.len() * 12
    }

    /// The geodesic solver for this source, built on first use. Building one is slow, so call
    /// this off the async runtime. Two calls on the same source wait for each other rather than
    /// build the same solver twice.
    pub fn solver(&self) -> &GeodesicSolver {
        self.solver
            .get_or_init(|| GeodesicSolver::build(self.mesh.clone()))
    }
}

impl fmt::Debug for OrganicCutSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OrganicCutSource")
            .field("triangles", &self.mesh.triangles.len())
            .field("solver_built", &self.solver.get().is_some())
            .finish_non_exhaustive()
    }
}
