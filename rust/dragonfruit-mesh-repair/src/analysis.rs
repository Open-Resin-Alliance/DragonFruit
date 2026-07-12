//! Analysis layer: produces a [`MeshAnalysis`] report describing all
//! detected defect classes without mutating the mesh. Intentionally
//! O(n log n) or better wherever possible.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::core::bvh::{tri_tri_intersect, Bvh};
use crate::core::halfedge::Topology;
use crate::core::mesh::{Aabb, IndexedMesh};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshAnalysis {
    pub vertex_count: usize,
    pub triangle_count: usize,
    pub bbox_min: [f32; 3],
    pub bbox_max: [f32; 3],
    pub signed_volume: f64,

    pub duplicate_vertices: usize,
    pub degenerate_triangles: usize,
    pub duplicate_triangles: usize,
    pub non_manifold_edges: usize,
    pub non_manifold_vertices: usize,
    pub boundary_edges: usize,
    pub boundary_loops: usize,
    pub largest_boundary_loop: usize,
    pub inconsistent_winding_edges: usize,
    pub self_intersection_triangles: usize,
    pub connected_components: usize,
    pub is_watertight: bool,
    pub is_oriented: bool,

    pub timings_ms: AnalysisTimings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnalysisTimings {
    pub topology_ms: f64,
    pub self_intersections_ms: f64,
    pub components_ms: f64,
    pub total_ms: f64,
}

pub fn analyze(mesh: &IndexedMesh) -> MeshAnalysis {
    let t_start = std::time::Instant::now();

    let bbox = mesh.bbox();
    let signed_volume = mesh.signed_volume();

    let t_topo = std::time::Instant::now();
    let topo = Topology::build(mesh);
    let topology_ms = t_topo.elapsed().as_secs_f64() * 1000.0;

    let mut degenerate_triangles = 0usize;
    let mut duplicate_triangles = {
        let mut set: ahash::AHashSet<(u32, u32, u32)> =
            ahash::AHashSet::with_capacity(mesh.triangles.len());
        let mut dups = 0usize;
        for tri in &mesh.triangles {
            let mut s = *tri;
            s.sort();
            let key = (s[0], s[1], s[2]);
            if !set.insert(key) {
                dups += 1;
            }
        }
        dups
    };
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
            degenerate_triangles += 1;
            continue;
        }
        if mesh.tri_area(fi as u32) <= 1e-16 {
            degenerate_triangles += 1;
        }
    }
    // Any triangle that is both degenerate and duplicate was double-counted;
    // clamp duplicates to the sensible upper bound.
    if duplicate_triangles > mesh.triangles.len() {
        duplicate_triangles = mesh.triangles.len();
    }

    let non_manifold_edges = topo.non_manifold_edges().len();
    let boundary_edges_vec = topo.boundary_edges();
    let boundary_edges = boundary_edges_vec.len();
    let boundary_loops_vec = topo.boundary_loops();
    let largest_boundary_loop = boundary_loops_vec
        .iter()
        .map(|l| l.len())
        .max()
        .unwrap_or(0);
    let boundary_loops = boundary_loops_vec.len();
    let inconsistent_winding_edges = topo.inconsistent_edges();

    let non_manifold_vertices = count_non_manifold_vertices(mesh, &topo);

    let t_components = std::time::Instant::now();
    let connected_components = count_components(mesh);
    let components_ms = t_components.elapsed().as_secs_f64() * 1000.0;

    let t_si = std::time::Instant::now();
    let self_intersection_triangles = count_self_intersections(mesh);
    let self_intersections_ms = t_si.elapsed().as_secs_f64() * 1000.0;

    let is_watertight = boundary_edges == 0 && non_manifold_edges == 0;
    let is_oriented = inconsistent_winding_edges == 0 && signed_volume >= 0.0;

    let total_ms = t_start.elapsed().as_secs_f64() * 1000.0;

    MeshAnalysis {
        vertex_count: mesh.vertex_count(),
        triangle_count: mesh.triangle_count(),
        bbox_min: if bbox.min.x.is_finite() {
            [bbox.min.x, bbox.min.y, bbox.min.z]
        } else {
            [0.0; 3]
        },
        bbox_max: if bbox.max.x.is_finite() {
            [bbox.max.x, bbox.max.y, bbox.max.z]
        } else {
            [0.0; 3]
        },
        signed_volume,
        duplicate_vertices: 0, // by construction from_triangle_soup welds; leave 0 unless raw load.
        degenerate_triangles,
        duplicate_triangles,
        non_manifold_edges,
        non_manifold_vertices,
        boundary_edges,
        boundary_loops,
        largest_boundary_loop,
        inconsistent_winding_edges,
        self_intersection_triangles,
        connected_components,
        is_watertight,
        is_oriented,
        timings_ms: AnalysisTimings {
            topology_ms,
            self_intersections_ms,
            components_ms,
            total_ms,
        },
    }
}

/// Lightweight analysis that skips self-intersection detection (the most
/// expensive phase). Suitable for classify-only paths where we only need
/// basic topology stats to populate a report, not full defect diagnosis.
pub fn analyze_lightweight(mesh: &IndexedMesh) -> MeshAnalysis {
    let t_start = std::time::Instant::now();

    let bbox = mesh.bbox();
    let signed_volume = mesh.signed_volume();

    let t_topo = std::time::Instant::now();
    let topo = Topology::build(mesh);
    let topology_ms = t_topo.elapsed().as_secs_f64() * 1000.0;

    let mut degenerate_triangles = 0usize;
    let mut duplicate_triangles = {
        let mut set: ahash::AHashSet<(u32, u32, u32)> =
            ahash::AHashSet::with_capacity(mesh.triangles.len());
        let mut dups = 0usize;
        for tri in &mesh.triangles {
            let mut s = *tri;
            s.sort();
            let key = (s[0], s[1], s[2]);
            if !set.insert(key) {
                dups += 1;
            }
        }
        dups
    };
    for tri in &mesh.triangles {
        if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
            degenerate_triangles += 1;
            continue;
        }
    }
    if duplicate_triangles > mesh.triangles.len() {
        duplicate_triangles = mesh.triangles.len();
    }

    let non_manifold_edges = topo.non_manifold_edges().len();
    let boundary_edges_vec = topo.boundary_edges();
    let boundary_edges = boundary_edges_vec.len();
    let boundary_loops_vec = topo.boundary_loops();
    let largest_boundary_loop = boundary_loops_vec
        .iter()
        .map(|l| l.len())
        .max()
        .unwrap_or(0);
    let boundary_loops = boundary_loops_vec.len();
    let inconsistent_winding_edges = topo.inconsistent_edges();

    let non_manifold_vertices = count_non_manifold_vertices(mesh, &topo);

    let t_components = std::time::Instant::now();
    let connected_components = count_components(mesh);
    let components_ms = t_components.elapsed().as_secs_f64() * 1000.0;

    // Skip self-intersection detection — the expensive BVH-based pass.
    let self_intersection_triangles = 0;
    let self_intersections_ms = 0.0;

    let is_watertight = boundary_edges == 0 && non_manifold_edges == 0;
    let is_oriented = inconsistent_winding_edges == 0 && signed_volume >= 0.0;

    let total_ms = t_start.elapsed().as_secs_f64() * 1000.0;

    MeshAnalysis {
        vertex_count: mesh.vertex_count(),
        triangle_count: mesh.triangle_count(),
        bbox_min: if bbox.min.x.is_finite() {
            [bbox.min.x, bbox.min.y, bbox.min.z]
        } else {
            [0.0; 3]
        },
        bbox_max: if bbox.max.x.is_finite() {
            [bbox.max.x, bbox.max.y, bbox.max.z]
        } else {
            [0.0; 3]
        },
        signed_volume,
        duplicate_vertices: 0,
        degenerate_triangles,
        duplicate_triangles,
        non_manifold_edges,
        non_manifold_vertices,
        boundary_edges,
        boundary_loops,
        largest_boundary_loop,
        inconsistent_winding_edges,
        self_intersection_triangles,
        connected_components,
        is_watertight,
        is_oriented,
        timings_ms: AnalysisTimings {
            topology_ms,
            self_intersections_ms,
            components_ms,
            total_ms,
        },
    }
}

/// Minimal analysis for classification-only paths. Only computes O(n) cheap
/// stats (bbox, volume, vertex/triangle counts) and accepts the component
/// count from the caller (already computed by the classifier's own
/// `triangle_components` pass). Skips half-edge topology, self-intersection
/// detection, duplicate/degenerate detection, and boundary-loop extraction.
/// Runs in a single pass over positions + a single pass over triangles.
pub fn minimal_analysis(mesh: &IndexedMesh, component_count: usize) -> MeshAnalysis {
    let t_start = std::time::Instant::now();

    let bbox = mesh.bbox();
    let signed_volume = mesh.signed_volume();

    let total_ms = t_start.elapsed().as_secs_f64() * 1000.0;

    let is_watertight = false; // not computed
    let is_oriented = signed_volume >= 0.0;

    MeshAnalysis {
        vertex_count: mesh.vertex_count(),
        triangle_count: mesh.triangle_count(),
        bbox_min: if bbox.min.x.is_finite() {
            [bbox.min.x, bbox.min.y, bbox.min.z]
        } else {
            [0.0; 3]
        },
        bbox_max: if bbox.max.x.is_finite() {
            [bbox.max.x, bbox.max.y, bbox.max.z]
        } else {
            [0.0; 3]
        },
        signed_volume,
        duplicate_vertices: 0,
        degenerate_triangles: 0,
        duplicate_triangles: 0,
        non_manifold_edges: 0,
        non_manifold_vertices: 0,
        boundary_edges: 0,
        boundary_loops: 0,
        largest_boundary_loop: 0,
        inconsistent_winding_edges: 0,
        self_intersection_triangles: 0,
        connected_components: component_count,
        is_watertight,
        is_oriented,
        timings_ms: AnalysisTimings {
            topology_ms: 0.0,
            self_intersections_ms: 0.0,
            components_ms: 0.0,
            total_ms,
        },
    }
}

fn count_non_manifold_vertices(mesh: &IndexedMesh, topo: &Topology) -> usize {
    let mut count = 0usize;
    for (vi, faces) in topo.vertex_faces.iter().enumerate() {
        if faces.len() < 2 {
            continue;
        }
        let vi = vi as u32;
        let n = faces.len();
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(p: &mut [usize], i: usize) -> usize {
            let mut r = i;
            while p[r] != r {
                r = p[r];
            }
            let mut cur = i;
            while p[cur] != r {
                let next = p[cur];
                p[cur] = r;
                cur = next;
            }
            r
        }
        for i in 0..n {
            for j in (i + 1)..n {
                let fa = mesh.triangles[faces[i] as usize];
                let fb = mesh.triangles[faces[j] as usize];
                let oa: [u32; 2] = {
                    let mut out = [0u32; 2];
                    let mut k = 0;
                    for &v in &fa {
                        if v != vi && k < 2 {
                            out[k] = v;
                            k += 1;
                        }
                    }
                    out
                };
                let ob: [u32; 2] = {
                    let mut out = [0u32; 2];
                    let mut k = 0;
                    for &v in &fb {
                        if v != vi && k < 2 {
                            out[k] = v;
                            k += 1;
                        }
                    }
                    out
                };
                let shared = oa.iter().any(|a| ob.contains(a));
                if shared {
                    let ri = find(&mut parent, i);
                    let rj = find(&mut parent, j);
                    if ri != rj {
                        parent[ri] = rj;
                    }
                }
            }
        }
        let roots: ahash::AHashSet<usize> = (0..n).map(|i| find(&mut parent, i)).collect();
        if roots.len() > 1 {
            count += 1;
        }
    }
    count
}

fn count_components(mesh: &IndexedMesh) -> usize {
    let n = mesh.positions.len();
    if n == 0 {
        return 0;
    }
    let mut parent: Vec<u32> = (0..n as u32).collect();
    fn find(p: &mut [u32], i: u32) -> u32 {
        let mut r = i;
        while p[r as usize] != r {
            r = p[r as usize];
        }
        let mut cur = i;
        while p[cur as usize] != r {
            let next = p[cur as usize];
            p[cur as usize] = r;
            cur = next;
        }
        r
    }
    for tri in &mesh.triangles {
        let [a, b, c] = *tri;
        let ra = find(&mut parent, a);
        let rb = find(&mut parent, b);
        if ra != rb {
            parent[ra as usize] = rb;
        }
        // Re-find both a and c roots — after the previous union, either root
        // may have shifted, so we must not use stale values.
        let ra = find(&mut parent, a);
        let rc = find(&mut parent, c);
        if ra != rc {
            parent[ra as usize] = rc;
        }
    }
    // Count only vertices that belong to at least one triangle.
    let mut used = vec![false; n];
    for tri in &mesh.triangles {
        used[tri[0] as usize] = true;
        used[tri[1] as usize] = true;
        used[tri[2] as usize] = true;
    }
    let mut seen: ahash::AHashSet<u32> = ahash::AHashSet::new();
    for i in 0..n as u32 {
        if used[i as usize] {
            seen.insert(find(&mut parent, i));
        }
    }
    seen.len()
}

/// Count triangles that have at least one non-shared-edge intersection with
/// another triangle. Parallel over triangles; each BVH query is independent.
pub fn count_self_intersections(mesh: &IndexedMesh) -> usize {
    if mesh.triangles.len() < 2 {
        return 0;
    }
    let bvh = Bvh::build(mesh);

    let counters: Vec<usize> = (0..mesh.triangles.len())
        .into_par_iter()
        .map(|fi| {
            let [a, b, c] = mesh.tri_positions(fi as u32);
            let mut bb = Aabb::empty();
            bb.expand(a);
            bb.expand(b);
            bb.expand(c);
            let tri_a = [a, b, c];
            let tri_verts = mesh.triangles[fi];

            let mut hit = false;
            bvh.query_aabb(&bb, |other| {
                if hit || other == fi as u32 || other < fi as u32 {
                    // Dedupe: count each pair once, from the lower index.
                    return;
                }
                let other_verts = mesh.triangles[other as usize];
                // Skip if the two triangles share any index (edge/vertex
                // adjacency is not self-intersection).
                for vi in tri_verts {
                    if other_verts.contains(&vi) {
                        return;
                    }
                }
                let [oa, ob, oc] = mesh.tri_positions(other);
                if tri_tri_intersect(tri_a, [oa, ob, oc]) {
                    hit = true;
                }
            });
            if hit {
                1
            } else {
                0
            }
        })
        .collect();

    counters.iter().sum()
}
