//! Mesh arrangement / co-refinement primitives.
//!
//! This module is the foundation for *real* self-intersection repair. The
//! goal is to turn a self-intersecting input mesh into an equivalent mesh
//! with the same surface but zero triangle-triangle crossings, by splitting
//! each offending triangle along the intersection curves. Once that's done,
//! inside/outside classification (generalized winding number) can extract
//! a watertight boundary.
//!
//! Implementation status (incremental):
//! - [x] Tri-tri intersection *segment* (not just bool) — [`tri_tri_segment`].
//! - [x] Per-face 2D constrained Delaunay to incorporate intersection edges
//!   — [`corefine_self_intersections`].
//! - [ ] Generalized winding-number classification.
//! - [ ] Boundary extraction with consistent outward orientation.
//!
//! Once co-refinement lands and holds up on real meshes, the winding-cull
//! heuristic in `repair.rs` is superseded and will be removed.

use ahash::AHashMap;
use rayon::prelude::*;

use crate::core::bvh::Bvh;
use crate::core::mesh::{Aabb, IndexedMesh, Vec3};

/// A closed line segment in 3D.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Segment {
    pub a: Vec3,
    pub b: Vec3,
}

impl Segment {
    #[inline]
    pub fn length(&self) -> f32 {
        self.b.sub(self.a).length()
    }
}

/// Compute the intersection segment of two triangles, if it exists.
///
/// Returns `None` when:
/// - the triangles don't intersect,
/// - they intersect only at a single point (vertex-touching / edge-touching),
/// - they are coplanar (coplanar overlap handling is future work),
/// - or either triangle is degenerate.
///
/// Non-coplanar generic case only. Tolerance-based; not exact predicates —
/// good enough for float inputs from STL/OBJ but not bit-robust for
/// pathological nearly-coplanar pairs. A future iteration will plug in
/// adaptive predicates (à la Shewchuk) where needed.
pub fn tri_tri_segment(t0: [Vec3; 3], t1: [Vec3; 3]) -> Option<Segment> {
    const EPS: f32 = 1e-7;

    // Plane of t1.
    let n1 = t1[1].sub(t1[0]).cross(t1[2].sub(t1[0]));
    let n1_len_sq = n1.dot(n1);
    if n1_len_sq < EPS * EPS {
        return None; // degenerate t1
    }
    let d1 = -n1.dot(t1[0]);

    // Signed distances of t0 vertices to plane of t1.
    let d0_0 = n1.dot(t0[0]) + d1;
    let d0_1 = n1.dot(t0[1]) + d1;
    let d0_2 = n1.dot(t0[2]) + d1;
    if same_sign(d0_0, d0_1, d0_2, EPS) {
        return None;
    }

    // Plane of t0.
    let n0 = t0[1].sub(t0[0]).cross(t0[2].sub(t0[0]));
    let n0_len_sq = n0.dot(n0);
    if n0_len_sq < EPS * EPS {
        return None; // degenerate t0
    }
    let d0 = -n0.dot(t0[0]);

    // Signed distances of t1 vertices to plane of t0.
    let d1_0 = n0.dot(t1[0]) + d0;
    let d1_1 = n0.dot(t1[1]) + d0;
    let d1_2 = n0.dot(t1[2]) + d0;
    if same_sign(d1_0, d1_1, d1_2, EPS) {
        return None;
    }

    // Line of intersection of the two planes.
    let line_dir = n0.cross(n1);
    let line_dir_len_sq = line_dir.dot(line_dir);
    if line_dir_len_sq < EPS * EPS {
        // Planes are (nearly) parallel. Since we passed the same-sign tests,
        // some vertices must be very close to the other plane — treat as a
        // coplanar/degenerate contact we're not handling yet.
        return None;
    }

    // Project onto the axis of largest |line_dir| component for stability.
    let axis = dominant_axis(line_dir);

    let i0 = tri_interval_on_line(t0, [d0_0, d0_1, d0_2], axis)?;
    let i1 = tri_interval_on_line(t1, [d1_0, d1_1, d1_2], axis)?;

    // Overlap.
    let lo = i0.lo_t.max(i1.lo_t);
    let hi = i0.hi_t.min(i1.hi_t);
    if hi - lo <= EPS {
        return None;
    }

    let a = lerp_on_axis(&i0, &i1, lo);
    let b = lerp_on_axis(&i0, &i1, hi);
    if a.sub(b).length() < EPS {
        return None;
    }
    Some(Segment { a, b })
}

#[inline]
fn same_sign(a: f32, b: f32, c: f32, eps: f32) -> bool {
    (a > eps && b > eps && c > eps) || (a < -eps && b < -eps && c < -eps)
}

#[inline]
fn dominant_axis(v: Vec3) -> u8 {
    let ax = v.x.abs();
    let ay = v.y.abs();
    let az = v.z.abs();
    if ax >= ay && ax >= az {
        0
    } else if ay >= az {
        1
    } else {
        2
    }
}

#[inline]
fn coord(v: Vec3, axis: u8) -> f32 {
    match axis {
        0 => v.x,
        1 => v.y,
        _ => v.z,
    }
}

/// Interval of a triangle's intersection with the plane-plane line,
/// expressed as two 3D endpoints and their projection `t` onto `axis`.
#[derive(Copy, Clone, Debug)]
struct LineInterval {
    p_lo: Vec3,
    p_hi: Vec3,
    lo_t: f32,
    hi_t: f32,
}

/// Find where the triangle crosses the other plane, and project those two
/// crossing points onto `axis` to get a scalar interval.
fn tri_interval_on_line(t: [Vec3; 3], d: [f32; 3], axis: u8) -> Option<LineInterval> {
    // Identify the "odd one out" vertex — the one with the unique sign
    // relative to the other two. Both edges from it cross the plane.
    let (odd, a, b) = if (d[0] > 0.0) == (d[1] > 0.0) {
        (2usize, 0usize, 1usize)
    } else if (d[0] > 0.0) == (d[2] > 0.0) {
        (1, 0, 2)
    } else {
        (0, 1, 2)
    };

    let p_odd = t[odd];
    let p_a = t[a];
    let p_b = t[b];
    let d_odd = d[odd];
    let d_a = d[a];
    let d_b = d[b];

    // Parameter along edge from odd→a where plane is crossed.
    let t_a = d_odd / (d_odd - d_a);
    let t_b = d_odd / (d_odd - d_b);
    if !t_a.is_finite() || !t_b.is_finite() {
        return None;
    }
    let cross_a = Vec3::new(
        p_odd.x + (p_a.x - p_odd.x) * t_a,
        p_odd.y + (p_a.y - p_odd.y) * t_a,
        p_odd.z + (p_a.z - p_odd.z) * t_a,
    );
    let cross_b = Vec3::new(
        p_odd.x + (p_b.x - p_odd.x) * t_b,
        p_odd.y + (p_b.y - p_odd.y) * t_b,
        p_odd.z + (p_b.z - p_odd.z) * t_b,
    );

    let ta = coord(cross_a, axis);
    let tb = coord(cross_b, axis);
    let (lo_t, hi_t, p_lo, p_hi) = if ta <= tb {
        (ta, tb, cross_a, cross_b)
    } else {
        (tb, ta, cross_b, cross_a)
    };
    Some(LineInterval {
        p_lo,
        p_hi,
        lo_t,
        hi_t,
    })
}

/// Given two intervals on the same line (axis-aligned parameter `t`), pick a
/// 3D point on the overlapping portion by linearly interpolating along
/// whichever interval contains `t`.
fn lerp_on_axis(i0: &LineInterval, i1: &LineInterval, t: f32) -> Vec3 {
    // Choose the interval whose span is most robust (longer axis-projected
    // span means smaller relative error).
    let span0 = (i0.hi_t - i0.lo_t).abs();
    let span1 = (i1.hi_t - i1.lo_t).abs();
    let pick = if span0 >= span1 { i0 } else { i1 };
    let span = pick.hi_t - pick.lo_t;
    if span.abs() < 1e-20 {
        return pick.p_lo;
    }
    let u = (t - pick.lo_t) / span;
    Vec3::new(
        pick.p_lo.x + (pick.p_hi.x - pick.p_lo.x) * u,
        pick.p_lo.y + (pick.p_hi.y - pick.p_lo.y) * u,
        pick.p_lo.z + (pick.p_hi.z - pick.p_lo.z) * u,
    )
}

// --- co-refinement ------------------------------------------------------

/// Summary of a co-refinement pass.
#[derive(Debug, Clone, Default)]
pub struct CorefineStats {
    /// Number of triangle pairs found to intersect.
    pub intersecting_pairs: usize,
    /// Number of faces that were refined (replaced by sub-triangles).
    pub refined_faces: usize,
    /// Number of faces that failed to refine (e.g. CDT error); these are
    /// kept as-is in the output.
    pub skipped_faces: usize,
    /// Triangle count before refinement.
    pub tri_count_before: usize,
    /// Triangle count after refinement.
    pub tri_count_after: usize,
    /// New vertices added (intersection endpoints on face interiors).
    pub new_vertices: usize,
}

/// Co-refine a mesh so that intersecting triangles are split along their
/// intersection curves. After this pass, no triangle crosses another (up to
/// the tolerance of the 2D constrained Delaunay triangulator); shared edges
/// and vertices remain valid.
///
/// This does NOT change inside/outside classification — interior faces are
/// still present. Follow up with winding-number extraction (future work) to
/// get a watertight boundary.
///
/// Coplanar overlap between triangles is currently treated as non-intersecting;
/// a robust coplanar co-refinement pass is a later iteration.
pub fn corefine_self_intersections(mesh: &mut IndexedMesh) -> CorefineStats {
    let mut stats = CorefineStats {
        tri_count_before: mesh.triangles.len(),
        ..Default::default()
    };
    if mesh.triangles.len() < 2 {
        stats.tri_count_after = mesh.triangles.len();
        return stats;
    }

    // 1. Collect per-face intersection segments by walking intersecting pairs.
    let per_face = collect_face_segments(mesh);
    stats.intersecting_pairs = per_face.iter().map(|s| s.len()).sum::<usize>() / 2;

    if stats.intersecting_pairs == 0 {
        stats.tri_count_after = mesh.triangles.len();
        return stats;
    }

    // 2. Register all unique segment endpoint positions as shared vertices,
    //    so neighbouring refined faces stitch along the same indices.
    let vertex_epsilon = {
        let bb = mesh.bbox();
        (bb.diag().max(1e-4)) * 1e-6
    };
    let mut endpoint_indices: Vec<Vec<[u32; 2]>> = Vec::with_capacity(per_face.len());
    endpoint_indices.resize_with(per_face.len(), Vec::new);

    let new_vertex_count_before = mesh.positions.len();
    {
        let mut registry: SpatialVertexRegistry = SpatialVertexRegistry::new(vertex_epsilon);
        // Seed with existing positions so segment endpoints landing on an
        // existing vertex dedup to it.
        for (i, p) in mesh.positions.iter().enumerate() {
            registry.register_existing(*p, i as u32);
        }
        for (fi, segs) in per_face.iter().enumerate() {
            for &(a, b) in segs {
                let ia = registry.register_or_insert(a, &mut mesh.positions);
                let ib = registry.register_or_insert(b, &mut mesh.positions);
                endpoint_indices[fi].push([ia, ib]);
            }
        }
    }
    stats.new_vertices = mesh.positions.len() - new_vertex_count_before;

    // 3. Per-face CDT refinement. Parallel over faces with segments.
    let faces_to_refine: Vec<u32> = (0..mesh.triangles.len() as u32)
        .filter(|fi| !per_face[*fi as usize].is_empty())
        .collect();

    // Build refinement output per face: Vec of new triangles (global indices).
    let refined: Vec<(u32, Option<Vec<[u32; 3]>>)> = faces_to_refine
        .par_iter()
        .map(|&fi| {
            let tri = mesh.triangles[fi as usize];
            let segs = &endpoint_indices[fi as usize];
            let new_tris = refine_face_with_segments(mesh, tri, segs);
            (fi, new_tris)
        })
        .collect();

    // 4. Apply. Build a new triangle list: non-refined faces kept as-is,
    //    refined faces replaced.
    let mut replacement: AHashMap<u32, Vec<[u32; 3]>> = AHashMap::with_capacity(refined.len());
    for (fi, opt) in refined {
        match opt {
            Some(tris) => {
                stats.refined_faces += 1;
                replacement.insert(fi, tris);
            }
            None => {
                stats.skipped_faces += 1;
            }
        }
    }

    let mut new_triangles: Vec<[u32; 3]> =
        Vec::with_capacity(mesh.triangles.len() + stats.intersecting_pairs * 2);
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        match replacement.get(&(fi as u32)) {
            Some(sub) => new_triangles.extend_from_slice(sub),
            None => new_triangles.push(*tri),
        }
    }
    mesh.triangles = new_triangles;
    stats.tri_count_after = mesh.triangles.len();
    stats
}

/// For every pair of triangles (i < j) whose AABBs overlap, compute their
/// intersection segment (if any) and record it on *both* face's segment lists.
/// Uses the BVH for pruning.
fn collect_face_segments(mesh: &IndexedMesh) -> Vec<Vec<(Vec3, Vec3)>> {
    let n = mesh.triangles.len();
    let bvh = Bvh::build(mesh);

    // Phase 1: parallel, per-face find candidate partners (fj > fi).
    // Returns for each fi: Vec<(fj, segment)>.
    let per_i: Vec<Vec<(u32, (Vec3, Vec3))>> = (0..n as u32)
        .into_par_iter()
        .map(|fi| {
            let [a, b, c] = mesh.tri_positions(fi);
            let mut bb = Aabb::empty();
            bb.expand(a);
            bb.expand(b);
            bb.expand(c);
            let tri_a = [a, b, c];
            let verts_a = mesh.triangles[fi as usize];

            let mut found: Vec<(u32, (Vec3, Vec3))> = Vec::new();
            let mut candidates: Vec<u32> = Vec::new();
            bvh.query_aabb(&bb, |other| candidates.push(other));
            for fj in candidates {
                if fj <= fi {
                    continue;
                }
                let verts_b = mesh.triangles[fj as usize];
                // Skip edge/vertex adjacency — shared topology is not a crossing.
                let mut shares = false;
                for vi in verts_a {
                    if verts_b.contains(&vi) {
                        shares = true;
                        break;
                    }
                }
                if shares {
                    continue;
                }
                let [oa, ob, oc] = mesh.tri_positions(fj);
                if let Some(seg) = tri_tri_segment(tri_a, [oa, ob, oc]) {
                    found.push((fj, (seg.a, seg.b)));
                }
            }
            found
        })
        .collect();

    // Phase 2: flatten into per-face lists on both sides of each pair.
    let mut per_face: Vec<Vec<(Vec3, Vec3)>> = vec![Vec::new(); n];
    for (fi, hits) in per_i.into_iter().enumerate() {
        for (fj, seg) in hits {
            per_face[fi].push(seg);
            per_face[fj as usize].push(seg);
        }
    }
    per_face
}

/// Spatial hash of 3D positions with a tolerance, mapping to global vertex
/// indices. Used during co-refinement so that the same segment endpoint in
/// two neighbouring refined faces resolves to the same mesh vertex.
struct SpatialVertexRegistry {
    // Key is quantised (i32, i32, i32); value is a small bucket of (pos, idx).
    // Checking the 27 neighbouring buckets covers tolerance overlap.
    buckets: AHashMap<(i32, i32, i32), smallvec::SmallVec<[(Vec3, u32); 2]>>,
    eps: f32,
    inv_cell: f32,
}

impl SpatialVertexRegistry {
    fn new(epsilon: f32) -> Self {
        let cell = epsilon.max(1e-10);
        Self {
            buckets: AHashMap::new(),
            eps: epsilon,
            inv_cell: 1.0 / cell,
        }
    }
    fn key(&self, p: Vec3) -> (i32, i32, i32) {
        (
            (p.x * self.inv_cell).floor() as i32,
            (p.y * self.inv_cell).floor() as i32,
            (p.z * self.inv_cell).floor() as i32,
        )
    }
    fn find(&self, p: Vec3) -> Option<u32> {
        let (kx, ky, kz) = self.key(p);
        let eps2 = self.eps * self.eps;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(bucket) = self.buckets.get(&(kx + dx, ky + dy, kz + dz)) {
                        for &(q, idx) in bucket {
                            if p.sub(q).dot(p.sub(q)) <= eps2 {
                                return Some(idx);
                            }
                        }
                    }
                }
            }
        }
        None
    }
    fn register_existing(&mut self, p: Vec3, idx: u32) {
        let key = self.key(p);
        self.buckets.entry(key).or_default().push((p, idx));
    }
    fn register_or_insert(&mut self, p: Vec3, positions: &mut Vec<Vec3>) -> u32 {
        if let Some(idx) = self.find(p) {
            return idx;
        }
        let idx = positions.len() as u32;
        positions.push(p);
        self.register_existing(p, idx);
        idx
    }
}

/// Refine one triangular face along a set of interior segments. Projects the
/// face (and segment endpoints) to a 2D plane, runs constrained Delaunay,
/// and returns the resulting sub-triangles using the mesh's global vertex
/// indices.
///
/// Correctly handles the common case where a segment endpoint lies on a
/// boundary edge of the face (which is almost always true — the intersection
/// line enters/exits a triangle through its edges): the boundary edge is
/// subdivided at that point rather than fed to the CDT as a mid-edge
/// interior vertex (which would cause `PointOnFixedEdge`).
///
/// Returns `None` if the CDT fails (degenerate geometry, near-duplicate
/// points, etc.); caller keeps the original triangle unchanged.
fn refine_face_with_segments(
    mesh: &IndexedMesh,
    tri: [u32; 3],
    segments: &[[u32; 2]],
) -> Option<Vec<[u32; 3]>> {
    let p0 = mesh.positions[tri[0] as usize];
    let p1 = mesh.positions[tri[1] as usize];
    let p2 = mesh.positions[tri[2] as usize];
    let e1 = p1.sub(p0);
    let e2 = p2.sub(p0);
    let normal = e1.cross(e2);
    let nlen = normal.length();
    if nlen < 1e-12 {
        return None; // degenerate face
    }
    let nn = normal.scale(1.0 / nlen);
    // Pick a stable up-vector not parallel to nn.
    let up = if nn.x.abs() < 0.9 {
        Vec3::new(1.0, 0.0, 0.0)
    } else {
        Vec3::new(0.0, 1.0, 0.0)
    };
    let u_axis = {
        let u = nn.cross(up);
        let l = u.length();
        if l < 1e-12 {
            return None;
        }
        u.scale(1.0 / l)
    };
    let v_axis = nn.cross(u_axis);
    // Local origin at p0.
    let to_2d = |p: Vec3| -> (f64, f64) {
        let rel = p.sub(p0);
        (rel.dot(u_axis) as f64, rel.dot(v_axis) as f64)
    };

    // 1. Build point list: 3 face corners first, then unique segment
    //    endpoints (deduped by global vertex index).
    let mut global_idx: Vec<u32> = vec![tri[0], tri[1], tri[2]];
    let mut pts: Vec<(f64, f64)> = vec![to_2d(p0), to_2d(p1), to_2d(p2)];
    let mut local_of: AHashMap<u32, usize> = AHashMap::with_capacity(3 + segments.len() * 2);
    local_of.insert(tri[0], 0);
    local_of.insert(tri[1], 1);
    local_of.insert(tri[2], 2);
    let mut segment_pair_locals: Vec<(usize, usize)> = Vec::with_capacity(segments.len());

    for &[ga, gb] in segments {
        if ga == gb {
            continue;
        }
        let la = resolve_local(ga, mesh, &mut global_idx, &mut pts, &mut local_of, &to_2d);
        let lb = resolve_local(gb, mesh, &mut global_idx, &mut pts, &mut local_of, &to_2d);
        if la != lb {
            segment_pair_locals.push((la, lb));
        }
    }

    // 2. Dedup: if any two points are essentially coincident in 2D (can
    //    happen when the face normal is nearly parallel to the frame's
    //    projection axis and distinct 3D vertices collapse), bail out —
    //    CDT will error otherwise.
    for i in 0..pts.len() {
        for j in (i + 1)..pts.len() {
            let dx = pts[i].0 - pts[j].0;
            let dy = pts[i].1 - pts[j].1;
            if dx * dx + dy * dy < 1e-18 {
                return None;
            }
        }
    }

    // 3. For every non-corner point, test whether it lies on one of the
    //    three boundary edges of the face. Sort those per-edge by the
    //    parameter along the edge, then build the boundary as a polyline
    //    so the CDT sees a fully-subdivided outer ring.
    let edge_tol = edge_tol_for_triangle(&pts);
    let mut on_edge: Vec<Option<u8>> = vec![None; pts.len()]; // edge id 0/1/2 or None
    for pi in 3..pts.len() {
        for ei in 0..3u8 {
            let a = pts[ei as usize];
            let b = pts[((ei + 1) % 3) as usize];
            if point_on_segment_2d(pts[pi], a, b, edge_tol) {
                on_edge[pi] = Some(ei);
                break;
            }
        }
    }

    let mut edges: Vec<(usize, usize)> = Vec::with_capacity(3 + pts.len());
    for ei in 0..3usize {
        let a = ei;
        let b = (ei + 1) % 3;
        let pa = pts[a];
        let pb = pts[b];
        let mut inserts: Vec<(f64, usize)> = Vec::new();
        for (pi, oe) in on_edge.iter().enumerate() {
            if *oe == Some(ei as u8) {
                inserts.push((param_on_segment(pts[pi], pa, pb), pi));
            }
        }
        inserts.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut prev = a;
        for (_, pi) in inserts {
            if pi != prev {
                edges.push((prev, pi));
                prev = pi;
            }
        }
        if prev != b {
            edges.push((prev, b));
        }
    }
    // Interior segment edges.
    for (la, lb) in segment_pair_locals {
        edges.push((la, lb));
    }

    // 4. Run CDT (catch panic defensively; the crate has a few rough edges).
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        cdt::triangulate_with_edges(&pts, &edges)
    }));
    let tris = match result {
        Ok(Ok(t)) => t,
        Ok(Err(_)) => return None,
        Err(_) => return None,
    };
    if tris.is_empty() {
        return None;
    }

    // 5. Ensure CCW in 2D → outward normal in 3D (our (u, v, n) frame is
    //    right-handed so CCW projects to face-normal direction). Flip any
    //    triangle that comes out CW.
    let mut out: Vec<[u32; 3]> = Vec::with_capacity(tris.len());
    for (a, b, c) in tris {
        let pa = pts[a];
        let pb = pts[b];
        let pc = pts[c];
        let cross = (pb.0 - pa.0) * (pc.1 - pa.1) - (pb.1 - pa.1) * (pc.0 - pa.0);
        let (ga, gb, gc) = (global_idx[a], global_idx[b], global_idx[c]);
        if ga == gb || gb == gc || ga == gc {
            continue; // degenerate global triangle — skip
        }
        if cross >= 0.0 {
            out.push([ga, gb, gc]);
        } else {
            out.push([ga, gc, gb]);
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

/// Map a global mesh vertex index to a local CDT point index. If not already
/// present, append its 2D projection to `pts` and its global index to
/// `global_idx`.
fn resolve_local<F: Fn(Vec3) -> (f64, f64)>(
    global: u32,
    mesh: &IndexedMesh,
    global_idx: &mut Vec<u32>,
    pts: &mut Vec<(f64, f64)>,
    local_of: &mut AHashMap<u32, usize>,
    to_2d: &F,
) -> usize {
    if let Some(&lo) = local_of.get(&global) {
        return lo;
    }
    let p = mesh.positions[global as usize];
    let li = global_idx.len();
    global_idx.push(global);
    pts.push(to_2d(p));
    local_of.insert(global, li);
    li
}

/// Tolerance for "point lies on segment" tests inside a triangle — scaled to
/// the triangle's bbox so it works for both tiny and huge faces.
fn edge_tol_for_triangle(pts: &[(f64, f64)]) -> f64 {
    if pts.len() < 3 {
        return 1e-9;
    }
    let (mut lo_x, mut lo_y) = pts[0];
    let (mut hi_x, mut hi_y) = pts[0];
    for &(x, y) in &pts[..3] {
        lo_x = lo_x.min(x);
        lo_y = lo_y.min(y);
        hi_x = hi_x.max(x);
        hi_y = hi_y.max(y);
    }
    let ext = ((hi_x - lo_x) * (hi_x - lo_x) + (hi_y - lo_y) * (hi_y - lo_y)).sqrt();
    (ext * 1e-6).max(1e-9)
}

/// Test whether point `p` lies on the segment `a-b` within `tol` (Euclidean).
fn point_on_segment_2d(p: (f64, f64), a: (f64, f64), b: (f64, f64), tol: f64) -> bool {
    let abx = b.0 - a.0;
    let aby = b.1 - a.1;
    let apx = p.0 - a.0;
    let apy = p.1 - a.1;
    let ab_len_sq = abx * abx + aby * aby;
    if ab_len_sq < 1e-30 {
        return false;
    }
    // Perpendicular distance (signed).
    let cross = abx * apy - aby * apx;
    let perp_sq = (cross * cross) / ab_len_sq;
    if perp_sq > tol * tol {
        return false;
    }
    // Check within segment extent (excluding endpoints, which are corners).
    let t = (apx * abx + apy * aby) / ab_len_sq;
    t > tol && t < 1.0 - tol
}

/// Parameter of projection of `p` onto segment `a-b` (0 at a, 1 at b).
fn param_on_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let abx = b.0 - a.0;
    let aby = b.1 - a.1;
    let apx = p.0 - a.0;
    let apy = p.1 - a.1;
    let ab_len_sq = abx * abx + aby * aby;
    if ab_len_sq < 1e-30 {
        return 0.0;
    }
    (apx * abx + apy * aby) / ab_len_sq
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Vec3 {
        Vec3::new(x, y, z)
    }

    #[test]
    fn perpendicular_triangles_cross() {
        // Triangle in XY plane (z=0), large.
        let t0 = [v(-1.0, -1.0, 0.0), v(2.0, -1.0, 0.0), v(-1.0, 2.0, 0.0)];
        // Triangle in XZ plane (y=0), straddles t0's plane in z.
        let t1 = [v(-1.0, 0.0, -1.0), v(1.0, 0.0, -1.0), v(0.0, 0.0, 1.0)];
        let seg = tri_tri_segment(t0, t1).expect("should intersect");
        // Intersection should lie on line y=0, z=0 (both planes' intersection).
        for p in [seg.a, seg.b] {
            assert!(p.y.abs() < 1e-5, "y = {} should be ~0", p.y);
            assert!(p.z.abs() < 1e-5, "z = {} should be ~0", p.z);
        }
        // Length should be nonzero.
        assert!(seg.length() > 1e-4);
    }

    #[test]
    fn disjoint_triangles_return_none() {
        let t0 = [v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 1.0, 0.0)];
        let t1 = [v(10.0, 10.0, 5.0), v(11.0, 10.0, 5.0), v(10.0, 11.0, 5.0)];
        assert!(tri_tri_segment(t0, t1).is_none());
    }

    #[test]
    fn coplanar_triangles_return_none() {
        // Coplanar, overlapping — not yet handled, should return None.
        let t0 = [v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 1.0, 0.0)];
        let t1 = [v(0.5, 0.5, 0.0), v(1.5, 0.5, 0.0), v(0.5, 1.5, 0.0)];
        assert!(tri_tri_segment(t0, t1).is_none());
    }

    #[test]
    fn vertex_touch_returns_none() {
        // t1 shares vertex v(0,0,0) with t0 but doesn't otherwise cross.
        let t0 = [v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 1.0, 0.0)];
        let t1 = [v(0.0, 0.0, 0.0), v(0.0, 0.0, 1.0), v(1.0, 0.0, 1.0)];
        // Single-point contact → None.
        let result = tri_tri_segment(t0, t1);
        assert!(
            result.is_none() || result.unwrap().length() < 1e-4,
            "vertex touch should not produce a real segment"
        );
    }

    #[test]
    fn parallel_offset_planes_return_none() {
        let t0 = [v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 1.0, 0.0)];
        let t1 = [v(0.0, 0.0, 1.0), v(1.0, 0.0, 1.0), v(0.0, 1.0, 1.0)];
        assert!(tri_tri_segment(t0, t1).is_none());
    }

    #[test]
    fn crossed_quads_produce_segment_length_matches() {
        // Vertical quad made of two tris crossing a horizontal quad.
        // Horizontal quad [-2,2]×[-2,2] at z=0.
        let h = [v(-2.0, -2.0, 0.0), v(2.0, -2.0, 0.0), v(2.0, 2.0, 0.0)];
        // Vertical strip along y=0, x in [-1,1], z in [-1,1].
        let vt = [v(-1.0, 0.0, -1.0), v(1.0, 0.0, -1.0), v(1.0, 0.0, 1.0)];
        let seg = tri_tri_segment(h, vt).expect("should intersect");
        // Expected segment lies on y=0, z=0, x in [-1, 1] (clipped to h tri).
        // Since h's second tri would be [v(-2,-2,0), v(2,2,0), v(-2,2,0)], and we're only
        // using the lower-right tri of h, the cross falls on the diagonal x=y constraint.
        for p in [seg.a, seg.b] {
            assert!(p.y.abs() < 1e-5);
            assert!(p.z.abs() < 1e-5);
        }
        assert!(seg.length() > 0.5);
    }

    // --- co-refinement -----------------------------------------------

    use crate::analysis::count_self_intersections;
    use crate::core::mesh::IndexedMesh;

    /// Two single triangles that cross through each other. After corefinement
    /// each should be split along the intersection segment and the result
    /// must contain NO self-intersecting pair.
    #[test]
    fn corefine_two_crossed_triangles_eliminates_intersections() {
        // Horizontal triangle around origin, z=0.
        let a0 = v(-1.0, -1.0, 0.0);
        let a1 = v(2.0, -1.0, 0.0);
        let a2 = v(-1.0, 2.0, 0.0);
        // Vertical triangle crossing through it along y=0.
        let b0 = v(-1.0, 0.0, -1.0);
        let b1 = v(1.0, 0.0, -1.0);
        let b2 = v(0.0, 0.0, 1.0);
        let mut mesh = IndexedMesh {
            positions: vec![a0, a1, a2, b0, b1, b2],
            triangles: vec![[0, 1, 2], [3, 4, 5]],
        };
        assert_eq!(count_self_intersections(&mesh), 1);
        let before = mesh.triangles.len();

        let stats = corefine_self_intersections(&mut mesh);
        assert_eq!(stats.intersecting_pairs, 1);
        assert_eq!(stats.refined_faces, 2, "both faces should refine");
        assert_eq!(stats.skipped_faces, 0, "no CDT failures expected");
        assert!(
            mesh.triangles.len() > before,
            "refinement should add triangles, got {} (was {before})",
            mesh.triangles.len()
        );

        let after = count_self_intersections(&mesh);
        assert_eq!(
            after, 0,
            "after corefinement no triangle should still intersect another; got {after}"
        );
    }

    /// Two non-intersecting triangles should be a no-op.
    #[test]
    fn corefine_disjoint_triangles_is_noop() {
        let mut mesh = IndexedMesh {
            positions: vec![
                v(0.0, 0.0, 0.0),
                v(1.0, 0.0, 0.0),
                v(0.0, 1.0, 0.0),
                v(10.0, 10.0, 5.0),
                v(11.0, 10.0, 5.0),
                v(10.0, 11.0, 5.0),
            ],
            triangles: vec![[0, 1, 2], [3, 4, 5]],
        };
        let before_tris = mesh.triangles.clone();
        let before_positions = mesh.positions.len();
        let stats = corefine_self_intersections(&mut mesh);
        assert_eq!(stats.intersecting_pairs, 0);
        assert_eq!(stats.refined_faces, 0);
        assert_eq!(
            mesh.triangles, before_tris,
            "disjoint mesh must be unchanged"
        );
        assert_eq!(mesh.positions.len(), before_positions);
    }

    /// Corefine a mesh where the same segment cuts through two adjacent
    /// faces — the new midpoint vertices should be shared (not duplicated)
    /// across the faces so the mesh stays watertight-adjacent.
    #[test]
    fn corefine_shares_new_vertices_across_adjacent_faces() {
        // Horizontal quad (two tris sharing the diagonal 0-2)
        // crossed by a single vertical tri through y=0.
        let h0 = v(-1.0, -1.0, 0.0);
        let h1 = v(1.0, -1.0, 0.0);
        let h2 = v(1.0, 1.0, 0.0);
        let h3 = v(-1.0, 1.0, 0.0);
        let vt0 = v(-2.0, 0.0, -1.0);
        let vt1 = v(2.0, 0.0, -1.0);
        let vt2 = v(0.0, 0.0, 1.0);
        let mut mesh = IndexedMesh {
            positions: vec![h0, h1, h2, h3, vt0, vt1, vt2],
            triangles: vec![
                [0, 1, 2], // lower-right tri
                [0, 2, 3], // upper-left tri
                [4, 5, 6], // vertical tri
            ],
        };
        let pre = count_self_intersections(&mesh);
        assert!(
            pre >= 2,
            "expected both horizontal tris to cross vertical, got {pre}"
        );

        let stats = corefine_self_intersections(&mut mesh);
        assert_eq!(stats.intersecting_pairs, 2);
        // Segment endpoints y=0,z=0 on the shared diagonal of the quad
        // should be registered once. Between the 2 crossings we get 4
        // segment endpoints in total, but several land on the diagonal
        // endpoint h0 (existing vertex). Net new vertices should be small.
        assert!(
            stats.new_vertices <= 4,
            "shared endpoints should dedup, got {}",
            stats.new_vertices
        );
        let post = count_self_intersections(&mesh);
        assert_eq!(
            post, 0,
            "corefinement should fully resolve crossings, got {post}"
        );
    }
}
