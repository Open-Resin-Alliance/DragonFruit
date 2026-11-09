//! Structured mesh-health report. Serialized to JSON for both the CLI and
//! the Tauri IPC layer; consumed by the frontend "Mesh Health" UI.

use serde::{Deserialize, Serialize};

use crate::analysis::MeshAnalysis;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshHealthReport {
    pub version: u32,
    pub source_path: Option<String>,
    pub pre: MeshAnalysis,
    pub post: MeshAnalysis,
    pub steps: Vec<RepairStepReport>,
    /// Heuristic flag indicating this imported mesh is likely support-only or
    /// strongly support-dominant geometry.
    #[serde(default)]
    pub likely_support_geometry: bool,
    /// When the manifold repair pipeline produced a mixed model+support output,
    /// the first `model_triangle_count` triangles in the repaired geometry are
    /// the model body; the remainder are support geometry. `None` means the
    /// geometry has no spatial split (all one group, or repair did not run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_triangle_count: Option<usize>,
    /// Result of feeding the model section (the first `model_triangle_count`
    /// triangles, or the whole mesh when there is no split) through the
    /// `manifold_csg` backend and checking its status. `Some(true)` = a valid
    /// manifold (`NoError`), `Some(false)` = the CSG backend reported *any*
    /// non-manifold status — not just an open/non-closed mesh but also
    /// non-finite vertices, out-of-bounds indices, etc. (the UI renders such a
    /// model red), `None` = the check did not run (manifold backend disabled or
    /// no geometry).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_is_manifold: Option<bool>,
    /// The specific `manifold_csg` status string when `model_is_manifold` is
    /// `Some(false)` (e.g. `manifold3d status: NotManifold`), for diagnostics.
    /// `None` when the model is a valid manifold or the check did not run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_manifold_status: Option<String>,
    /// If any defect classes remain after repair, they are listed here as
    /// human-readable strings so the UI can surface them.
    pub residual_issues: Vec<String>,
    /// Set when the mesh was repaired as a plate: one entry per part, each with its own verdict.
    /// Empty for a single-object mesh, which is most of them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<MeshPartReport>,
    pub fully_repaired: bool,
    /// Set when the mesh the caller is handed came from the rebuild route rather than from the local
    /// pipeline: the surface was resolved into a solid, which is a different object rather than the
    /// same one repaired. A report that does not say so is describing the wrong mesh, which is why
    /// this is a field and not a line in `residual_issues`.
    #[serde(default)]
    pub rebuilt: bool,
    /// True when the caller asked the repair to stop and it stopped at a stage
    /// boundary. The mesh is then partly repaired, and `fully_repaired` describes
    /// what is actually in it rather than what the run intended.
    pub cancelled: bool,
    pub total_ms: f64,
}

/// One part of a plate, and what repairing it on its own came to.
///
/// The whole-file verdict is one answer for a file that is many objects; this is the answer per
/// object, which is the one a user can act on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshPartReport {
    pub index: usize,
    pub triangles_before: usize,
    pub triangles_after: usize,
    pub fully_repaired: bool,
    pub residual_issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairStepReport {
    pub name: String,
    pub changed: u32,
    pub notes: Option<String>,
    pub elapsed_ms: f64,
}

impl MeshHealthReport {
    pub const VERSION: u32 = 1;

    pub fn new(pre: MeshAnalysis) -> Self {
        Self {
            version: Self::VERSION,
            source_path: None,
            pre: pre.clone(),
            post: pre,
            steps: Vec::new(),
            likely_support_geometry: false,
            model_triangle_count: None,
            model_is_manifold: None,
            model_manifold_status: None,
            residual_issues: Vec::new(),
            parts: Vec::new(),
            fully_repaired: false,
            rebuilt: false,
            cancelled: false,
            total_ms: 0.0,
        }
    }
}
