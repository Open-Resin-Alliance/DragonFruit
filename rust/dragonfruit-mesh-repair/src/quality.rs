//! Reusable mesh-quality scorecard (plan §Phase 5 step 4).
//!
//! [`MeshQualityScore`] is a compact, named, stable contract projected from the
//! richer [`MeshAnalysis`] the analysis layer already produces. It exists so
//! future downstream gates — a post-decimation validation gate and a
//! print-quality gate (both out of P5 scope) — can consume a small curated
//! scorecard rather than the whole analysis struct, without those consumers
//! being coupled to the full `MeshAnalysis` field set.
//!
//! Design (decision D1): this is *additive*. It does not retype or extend
//! `MeshAnalysis`, `Topology`, or `IndexedMesh` — the hollowing gate depends on
//! those. Six of the seven metric families are a pure projection of fields
//! `analysis::analyze()` already computes; only sliver detection is net-new
//! (see [`count_sliver_triangles`]).

use serde::{Deserialize, Serialize};

use crate::analysis::MeshAnalysis;
use crate::core::mesh::IndexedMesh;

/// Aspect-ratio threshold (minimum-altitude / longest-edge) below which a
/// non-zero-area triangle is considered a sliver. 0.02 ≈ a 1:50 thinness — a
/// needle far too thin to carry meaningful surface, but not exactly
/// zero-area (that is `degenerate_triangles`). Right-triangle box tessellations
/// sit at ≈0.5, well clear of the threshold.
pub const SLIVER_MIN_ALTITUDE_RATIO: f32 = 0.02;

/// Compact, stable mesh-quality scorecard. All counts are absolute.
///
/// Six metrics project directly from [`MeshAnalysis`]; `sliver_triangles` is
/// the one net-new metric and is only populated by the geometry-aware
/// constructors ([`MeshQualityScore::from_mesh`] /
/// [`MeshQualityScore::from_analysis_and_mesh`]). The `From<&MeshAnalysis>`
/// projection cannot see per-triangle geometry, so it reports `0` slivers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MeshQualityScore {
    /// Closed surface: no boundary edges and no non-manifold edges.
    pub is_watertight: bool,
    /// Edges incident to exactly one face (open boundary).
    pub boundary_edges: usize,
    /// Edges incident to more than two faces.
    pub non_manifold_edges: usize,
    /// Triangles that intersect another non-adjacent triangle.
    pub self_intersections: usize,
    /// Connected components ("shells").
    pub shell_count: usize,
    /// Boundary loops (holes).
    pub hole_count: usize,
    /// Zero-area (index- or area-degenerate) triangles.
    pub degenerate_triangles: usize,
    /// Thin, non-zero-area triangles (net-new metric; see
    /// [`SLIVER_MIN_ALTITUDE_RATIO`]).
    pub sliver_triangles: usize,
}

impl MeshQualityScore {
    /// Project the six reused metrics from an existing analysis and combine
    /// them with a sliver count computed from the mesh geometry. Use this when
    /// an analysis is already in hand (avoids re-running `analyze`).
    pub fn from_analysis_and_mesh(analysis: &MeshAnalysis, mesh: &IndexedMesh) -> Self {
        let mut score = Self::from(analysis);
        score.sliver_triangles = count_sliver_triangles(mesh);
        score
    }

    /// Score a mesh from scratch — independent of repair, callable on any
    /// mesh. Runs a full [`analyze`](crate::analysis::analyze) plus the sliver
    /// pass.
    pub fn from_mesh(mesh: &IndexedMesh) -> Self {
        let analysis = crate::analysis::analyze(mesh);
        Self::from_analysis_and_mesh(&analysis, mesh)
    }
}

impl From<&MeshAnalysis> for MeshQualityScore {
    /// Projection of the six metric families that already exist on
    /// [`MeshAnalysis`]. `sliver_triangles` is left at `0` — it requires
    /// per-triangle geometry, which the analysis struct does not carry; use
    /// [`MeshQualityScore::from_mesh`] to populate it.
    fn from(a: &MeshAnalysis) -> Self {
        Self {
            is_watertight: a.is_watertight,
            boundary_edges: a.boundary_edges,
            non_manifold_edges: a.non_manifold_edges,
            self_intersections: a.self_intersection_triangles,
            shell_count: a.connected_components,
            hole_count: a.boundary_loops,
            degenerate_triangles: a.degenerate_triangles,
            sliver_triangles: 0,
        }
    }
}

/// Count thin, non-zero-area ("sliver") triangles. A triangle is a sliver when
/// its minimum altitude relative to its longest edge falls below
/// [`SLIVER_MIN_ALTITUDE_RATIO`]. Exactly-zero-area triangles are excluded
/// (they are already counted as `degenerate_triangles`). O(n), single pass.
pub fn count_sliver_triangles(mesh: &IndexedMesh) -> usize {
    let mut count = 0usize;
    for fi in 0..mesh.triangles.len() as u32 {
        let area = mesh.tri_area(fi);
        if area <= 1e-16 {
            // Zero-area / degenerate — accounted for separately.
            continue;
        }
        let [a, b, c] = mesh.tri_positions(fi);
        let e0 = b.sub(a).length();
        let e1 = c.sub(b).length();
        let e2 = a.sub(c).length();
        let max_edge = e0.max(e1).max(e2);
        if max_edge <= 0.0 {
            continue;
        }
        // min altitude = 2·area / longest edge; thinness = min_altitude / max_edge.
        let min_altitude = 2.0 * area / max_edge;
        if min_altitude / max_edge < SLIVER_MIN_ALTITUDE_RATIO {
            count += 1;
        }
    }
    count
}
