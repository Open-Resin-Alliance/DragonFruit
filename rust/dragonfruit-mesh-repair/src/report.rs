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
    /// Whether the model section's own topology is manifold: no edge and no vertex
    /// carries more than two faces. `Some(false)` means those counts are non-zero,
    /// and the UI renders such a model red. A boundary is not a defect, so an open
    /// surface is still a manifold; this is not `manifold_csg`'s opinion of whether
    /// it can build a solid. `None` when no geometry was measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_is_manifold: Option<bool>,
    /// What is non-manifold about the model section when `model_is_manifold` is
    /// `Some(false)`, as counts a user can act on (e.g. "3 non-manifold edge(s),
    /// 0 non-manifold vertex(es)"). `None` when the section is manifold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_manifold_status: Option<String>,
    /// If any defect classes remain after repair, they are listed here as
    /// human-readable strings so the UI can surface them.
    pub residual_issues: Vec<String>,
    pub fully_repaired: bool,
    pub total_ms: f64,
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
            fully_repaired: false,
            total_ms: 0.0,
        }
    }
}
