//! Structured mesh-health report. Serialized to JSON for both the CLI and
//! the Tauri IPC layer; consumed by the frontend "Mesh Health" UI.

use serde::{Deserialize, Serialize};

use crate::analysis::MeshAnalysis;
use crate::quality::MeshQualityScore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshHealthReport {
    pub version: u32,
    pub source_path: Option<String>,
    pub pre: MeshAnalysis,
    pub post: MeshAnalysis,
    /// Compact before/after quality scorecard (plan §Phase 5 step 4). Projected
    /// from `pre`/`post` plus a sliver pass over the corresponding mesh; the
    /// repair pipeline overwrites both with geometry-aware scores. `#[serde(
    /// default)]` keeps the JSON contract backward-compatible for the frontend
    /// "Mesh Health" UI.
    #[serde(default)]
    pub quality_pre: MeshQualityScore,
    #[serde(default)]
    pub quality_post: MeshQualityScore,
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
        let quality = MeshQualityScore::from(&pre);
        Self {
            version: Self::VERSION,
            source_path: None,
            quality_pre: quality,
            quality_post: quality,
            pre: pre.clone(),
            post: pre,
            steps: Vec::new(),
            likely_support_geometry: false,
            model_triangle_count: None,
            residual_issues: Vec::new(),
            fully_repaired: false,
            total_ms: 0.0,
        }
    }
}
