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
    /// If any defect classes remain after repair, they are listed here as
    /// human-readable strings so the UI can surface them.
    pub residual_issues: Vec<String>,
    pub fully_repaired: bool,
    pub total_ms: f64,
    /// Per-shell routing breakdown (deep-repair path only; all zero when the
    /// routing did not run). Fields are `serde(default)` so VERSION stays 1.
    #[serde(default)]
    pub shells_total: usize,
    #[serde(default)]
    pub shells_passthrough: usize,
    #[serde(default)]
    pub shells_local: usize,
    #[serde(default)]
    pub shells_unioned: usize,
    #[serde(default)]
    pub shells_wrapped: usize,
    #[serde(default)]
    pub shells_fallback: usize,
    /// Routing/wrap advisories: "thin_walls:…", "wrap_budget_exhausted",
    /// "cluster_kept_original:…".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wrap_flags: Vec<String>,
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
            residual_issues: Vec::new(),
            fully_repaired: false,
            total_ms: 0.0,
            shells_total: 0,
            shells_passthrough: 0,
            shells_local: 0,
            shells_unioned: 0,
            shells_wrapped: 0,
            shells_fallback: 0,
            wrap_flags: Vec::new(),
        }
    }
}
