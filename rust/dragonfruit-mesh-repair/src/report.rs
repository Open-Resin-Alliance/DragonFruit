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
    pub fully_repaired: bool,
    pub total_ms: f64,
}

/// Ph1 CP3 — cheap per-section topology stats.
///
/// **The honesty contract, which is the whole point of this type:** every field
/// this tier may or may not compute is an `Option`. A field that was NOT
/// measured is `None` — serialized as JSON `null` and rendered `—` — and is
/// NEVER reported as `0` or `false`. The trap this replaces is real and shipped:
/// `minimal_analysis` returns `is_watertight: false // not computed`, which a
/// reader cannot distinguish from a measured "this mesh has holes".
///
/// The tier is deliberately `Topology::build`-shaped: boundary edges, boundary
/// loops (= holes), non-manifold edges/vertices, winding and components. The
/// self-intersection pass is a BVH-per-triangle sweep and is NOT run here; its
/// field is therefore always `None` at this tier, by construction rather than
/// by accident.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionStats {
    /// Always measured — the section is defined by its triangle range.
    pub triangle_count: usize,
    /// Always measured (distinct vertices referenced by this section).
    pub vertex_count: usize,
    #[serde(default)]
    pub connected_components: Option<usize>,
    #[serde(default)]
    pub boundary_edges: Option<usize>,
    /// Boundary loops — the "holes" red-line signal.
    #[serde(default)]
    pub boundary_loops: Option<usize>,
    #[serde(default)]
    pub largest_boundary_loop: Option<usize>,
    /// The second red-line signal.
    #[serde(default)]
    pub non_manifold_edges: Option<usize>,
    #[serde(default)]
    pub non_manifold_vertices: Option<usize>,
    #[serde(default)]
    pub inconsistent_winding_edges: Option<usize>,
    /// `Some(true)`/`Some(false)` only when the topology tier actually ran.
    #[serde(default)]
    pub is_watertight: Option<bool>,
    /// NEVER measured at this tier — always `None`. Present so the UI has a
    /// field to render `—` for and so a deeper tier can fill it in without a
    /// schema change. Do not "helpfully" default this to 0.
    #[serde(default)]
    pub self_intersection_triangles: Option<usize>,
    pub elapsed_ms: f64,
}

/// One maximal run of consecutive MODEL triangles, in **source-file** indices.
/// The support section is the complement of the union of these runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriangleRun {
    pub start: u32,
    pub len: u32,
}

/// Ph1 CP3/CP4 — everything the import-time classify pass learned about a mesh.
///
/// Separate from [`MeshHealthReport`] because it describes the SOURCE FILE, not
/// a repair: the run map is expressed in file indices so Ph3's splice — which
/// re-reads the original file record by record — can stream the model runs
/// alone.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportClassification {
    /// `None` when no reliable model/support partition was found. The mesh is
    /// then wholly model, and `model_runs` is empty (NOT "one run covering
    /// everything" — absence of a split is not a split).
    #[serde(default)]
    pub model_triangle_count: Option<usize>,
    #[serde(default)]
    pub likely_support_geometry: bool,
    #[serde(default)]
    pub connected_components: Option<usize>,
    #[serde(default)]
    pub model_section: Option<SectionStats>,
    #[serde(default)]
    pub support_section: Option<SectionStats>,
    /// Model runs in SOURCE-FILE triangle indices, ascending and disjoint.
    #[serde(default)]
    pub model_runs: Vec<TriangleRun>,
    /// Triangle count as the FILE numbers them (before non-finite drops), which
    /// is the space `model_runs` addresses.
    #[serde(default)]
    pub source_triangle_count: usize,
    /// Triangles the intake dropped for carrying a non-finite coordinate. The
    /// run map already compensates for them; this is reported so the UI can say
    /// so rather than leaving the user to wonder where the triangles went.
    #[serde(default)]
    pub dropped_nonfinite_triangles: usize,
    /// `None` = the manifold check was DELIBERATELY NOT RUN (size-guarded out of
    /// the classify path, or the backend is disabled). Never `Some(false)` for a
    /// mesh nobody looked at.
    #[serde(default)]
    pub model_is_manifold: Option<bool>,
    #[serde(default)]
    pub model_manifold_status: Option<String>,
    /// True when the manifold check was skipped by the size guard specifically
    /// — lets the UI distinguish "too big to check quickly" from "backend off".
    #[serde(default)]
    pub manifold_check_size_guarded: bool,
    pub classify_ms: f64,
    pub section_stats_ms: f64,
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
            model_is_manifold: None,
            model_manifold_status: None,
            residual_issues: Vec::new(),
            fully_repaired: false,
            total_ms: 0.0,
        }
    }
}
