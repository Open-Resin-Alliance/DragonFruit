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
    //
    // Clamped, because the crossing has to lie *on* the edge it is a crossing of. `same_sign`
    // lets a near-coplanar triangle through — three signed distances of order 1e-9 are not all
    // above its 1e-7 epsilon, so the test does not reject them — and then `d_odd` and `d_a` can
    // differ by far less than either of them. That makes the ratio enormous, and it placed
    // intersection points thousands of units off the mesh: measured on 3DBenchy, 80 of 15,813 new
    // vertices landed outside the original bounding box and stretched its diagonal from 82.9 to
    // 147,829, taking the surface area up 1,444%.
    let t_a = d_odd / (d_odd - d_a);
    let t_b = d_odd / (d_odd - d_b);
    // Finiteness first, then the clamp. A vertex exactly on the other plane makes the denominator
    // zero, and this check is what rejects it — clamping first would map the infinity to a bound and
    // let a degenerate pair through as if it were a real crossing. That is how a pair of triangles
    // that only touch came to be reported as intersecting.
    if !t_a.is_finite() || !t_b.is_finite() {
        return None;
    }
    let t_a = t_a.clamp(0.0, 1.0);
    let t_b = t_b.clamp(0.0, 1.0);
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
    let u = ((t - pick.lo_t) / span).clamp(0.0, 1.0);
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
    /// Per-face origin: `face_origin[fi]` is the index in the *pre-refinement*
    /// triangle list that new face `fi` was derived from.  For unrefined faces
    /// this equals `fi` itself; for CDT sub-triangles it is the index of the
    /// original face that was split.  Used by callers to carry per-face
    /// metadata (e.g. component labels, interior flags) through refinement.
    pub face_origin: Vec<u32>,
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

    // 1. Collect per-face intersection segments by walking intersecting pairs. Each chord is
    //    clipped to the face it is recorded on, so a face only ever carries segments that are
    //    actually part of it.
    let (per_face, crossing_pairs) = collect_face_segments(mesh);
    stats.intersecting_pairs = crossing_pairs;

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
    let mut face_origin: Vec<u32> =
        Vec::with_capacity(mesh.triangles.len() + stats.intersecting_pairs * 2);
    for (fi, tri) in mesh.triangles.iter().enumerate() {
        match replacement.get(&(fi as u32)) {
            Some(sub) => {
                // All sub-triangles produced from face fi inherit fi's origin.
                for _ in sub {
                    face_origin.push(fi as u32);
                }
                new_triangles.extend_from_slice(sub);
            }
            None => {
                face_origin.push(fi as u32);
                new_triangles.push(*tri);
            }
        }
    }
    mesh.triangles = new_triangles;
    stats.face_origin = face_origin;
    stats.tri_count_after = mesh.triangles.len();
    stats
}

/// An orthonormal frame in a triangle's own plane: origin `p0`, axes `u` and `v` with `u × v` along
/// the face normal — so a positive 2D orientation is the face's own orientation, which is what the
/// emitters below rely on to turn a 2D sub-triangle back into a face-consistent 3D one.
fn face_frame(tri: [Vec3; 3]) -> Option<(Vec3, Vec3, Vec3)> {
    let p0 = tri[0];
    let normal = tri[1].sub(p0).cross(tri[2].sub(p0));
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
    let u = nn.cross(up);
    let ul = u.length();
    if ul < 1e-12 {
        return None;
    }
    let u = u.scale(1.0 / ul);
    let v = nn.cross(u);
    Some((p0, u, v))
}

/// Clip a chord to the face it was recorded on, in that face's own plane.
///
/// A crossing pair's chord is found by overlapping the two triangles' intervals along the planes'
/// intersection line, projected onto one axis. That overlap is *necessary* but not sufficient: the
/// interval math is done on nearly-coplanar configurations too, where the crossing points it
/// interpolates between are not on the triangles at all. Measured on a 407k-triangle file, **half**
/// of the chords a face carries (`8,066` of `15,307`) lie entirely outside the face they were
/// recorded on, and of the rest most have at least one endpoint outside it.
///
/// Handing those points to the face's triangulation is not a small error: the CDT triangulates the
/// *convex hull* of the points it is given, so a point outside the face drags surface out with it.
/// The refinement's own coverage check reads a median of 1.16 and a maximum of 744 times the face's
/// area — it is emitting triangles the face never had, over and against the holes it is supposed to
/// be closing.
///
/// So the chord is clipped to the face here: the part outside is dropped, and an endpoint that
/// falls outside lands exactly on the face's boundary, which is where an intersection that leaves
/// the face through an edge belongs. Returns `None` when nothing of the chord is inside.
fn clip_segment_to_face(tri: [Vec3; 3], a: Vec3, b: Vec3) -> Option<(Vec3, Vec3)> {
    let (origin, u, v) = face_frame(tri)?;
    let to_2d = |p: Vec3| -> (f64, f64) {
        let r = p.sub(origin);
        (r.dot(u) as f64, r.dot(v) as f64)
    };
    let from_2d = |x: f64, y: f64| -> Vec3 { origin.add(u.scale(x as f32)).add(v.scale(y as f32)) };
    let corners_2d = [to_2d(tri[0]), to_2d(tri[1]), to_2d(tri[2])];
    let (pa, pb) = (to_2d(a), to_2d(b));
    let turn = |o: (f64, f64), p: (f64, f64), q: (f64, f64)| -> f64 {
        (p.0 - o.0) * (q.1 - o.1) - (p.1 - o.1) * (q.0 - o.0)
    };
    // Half-planes of the ring, oriented inward.
    let sgn = if turn(corners_2d[0], corners_2d[1], corners_2d[2]) >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for i in 0..3 {
        let (e0, e1) = (corners_2d[i], corners_2d[(i + 1) % 3]);
        let d0 = sgn * turn(e0, e1, pa);
        let d1 = sgn * turn(e0, e1, pb);
        if d0 < 0.0 && d1 < 0.0 {
            return None;
        }
        if d0 < 0.0 || d1 < 0.0 {
            let t = d0 / (d0 - d1);
            if d0 < 0.0 {
                if t > t0 {
                    t0 = t;
                }
            } else if t < t1 {
                t1 = t;
            }
        }
    }
    if t1 <= t0 {
        return None;
    }
    let at = |t: f64| -> Vec3 {
        let x = pa.0 + (pb.0 - pa.0) * t;
        let y = pa.1 + (pb.1 - pa.1) * t;
        from_2d(x, y)
    };
    // Only an endpoint that was outside is moved: the common case is a chord already inside the
    // face, and reconstructing it through the frame would displace it for no reason.
    let ca = if t0 > 0.0 { at(t0) } else { a };
    let cb = if t1 < 1.0 { at(t1) } else { b };
    Some((ca, cb))
}

/// For every pair of triangles (i < j) whose AABBs overlap, compute their
/// intersection segment (if any) and record it on *both* face's segment lists.
/// Uses the BVH for pruning.
fn collect_face_segments(mesh: &IndexedMesh) -> (Vec<Vec<(Vec3, Vec3)>>, usize) {
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
            bvh.query_aabb(mesh, &bb, |other| candidates.push(other));
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

    // Phase 2: clip each segment to both faces it was recorded on, then flatten.
    //
    // The clipping is per face, because the same chord is a different segment in each: the part of
    // it outside face i is exactly the part to drop for face i, and its endpoint lands on face i's
    // boundary, not on face j's. `clip_segment_to_face` carries the measurements.
    let mut per_face: Vec<Vec<(Vec3, Vec3)>> = vec![Vec::new(); n];
    let mut pairs = 0usize;
    for (fi, hits) in per_i.into_iter().enumerate() {
        if hits.is_empty() {
            continue;
        }
        let tri_i = mesh.tri_positions(fi as u32);
        for (fj, (a, b)) in hits {
            let kept_i = clip_segment_to_face(tri_i, a, b);
            let kept_j = clip_segment_to_face(mesh.tri_positions(fj), a, b);
            if kept_i.is_none() && kept_j.is_none() {
                continue;
            }
            // A pair counts as crossing when the chord is on at least one of the two faces. A pair
            // whose chord is on neither is what the interval math reports for two triangles that
            // nearly share a plane, and the coplanar case is deliberately not handled here.
            pairs += 1;
            if let Some(seg) = kept_i {
                per_face[fi].push(seg);
            }
            if let Some(seg) = kept_j {
                per_face[fj as usize].push(seg);
            }
        }
    }
    (per_face, pairs)
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

    // The boundary ring in order: the three corners, with every point that landed on an edge
    // inserted between them by its parameter along it. Both the direct path and the CDT's outer
    // boundary come from this, so the two cannot disagree about where the ring is.
    let ring = ring_order(&pts, &on_edge);
    let n_ring = ring.len();
    // A corner is a ring point too. It used to be excluded — only points with an edge id counted —
    // which sent every chord that ends *at* a corner to the CDT as if it were an interior chord,
    // even though the corner is a vertex of the ring the CDT is already given. On the file measured
    // below that is most of them: a chord runs from one point on the ring to another.
    let mut on_ring: Vec<bool> = vec![true, true, true];
    for pi in 3..pts.len() {
        on_ring.push(on_edge[pi].is_some());
    }

    let mut edges: Vec<(usize, usize)> = Vec::with_capacity(n_ring + segments.len());
    for i in 0..n_ring {
        edges.push((ring[i], ring[(i + 1) % n_ring]));
    }

    // Interior segment edges.
    //
    // When a face is intersected by multiple other faces their intersection
    // segments may cross each other in the face's local 2D plane. CDT
    // requires non-crossing constraints and panics/errors otherwise — this
    // is the main cause of `skipped_faces` on highly fragmented meshes.
    // Greedily drop any candidate segment that properly crosses an already-
    // accepted one.  The dropped segments stay unresolved, but the face at
    // least gets a valid partial refinement instead of being skipped entirely.
    let segment_pair_locals = filter_non_crossing_segments_2d(segment_pair_locals, &pts);

    // A chord whose two endpoints lie on the same ring edge *is* a piece of that edge, and it has
    // nothing to split. It is not an unlikely shape: the other triangle's plane running along the
    // face's own edge makes exactly this chord, and a chord from the face's corner to a point the
    // clip put on an edge next to it is the same thing again. Dropping it keeps the points it ends
    // on — the ring is still built with them, which is what the face across the edge needs in order
    // to be split at the same place — and a constraint that duplicates a boundary edge is exactly
    // what the CDT answers with an empty triangulation, or with nothing at all.
    //
    // Adjacency along the ring is not the test. With two points on one edge, the chord between them
    // spans a point that lies between them, which is a ring vertex this face has to keep.
    let segment_pair_locals: Vec<(usize, usize)> = segment_pair_locals
        .into_iter()
        .filter(|&(a, b)| {
            if !on_ring[a] || !on_ring[b] {
                return true;
            }
            !share_a_ring_edge(a, b, &on_edge)
        })
        .collect();
    edges.extend(segment_pair_locals.iter().copied());

    let boundary_chords: Vec<(usize, usize)> = segment_pair_locals
        .iter()
        .copied()
        .filter(|(a, b)| on_ring[*a] && on_ring[*b])
        .collect();
    let interior_chords: Vec<(usize, usize)> = segment_pair_locals
        .iter()
        .copied()
        .filter(|(a, b)| !(on_ring[*a] && on_ring[*b]))
        .collect();

    // 3b. A face whose chords all start and end on its own boundary is triangulated directly: split
    //     the boundary ring along each chord and triangulate each piece.
    //
    //     The CDT is not asked for this case because it gets it wrong. With extra points sitting
    //     collinear on the boundary — which is the common case, since an intersection segment enters
    //     and leaves a face through its edges — it returns a triangulation missing a whole region:
    //     25% of one face on a two-triangle fixture, and 8,123 of 14,751 faces on 3DBenchy, where
    //     the loss shows up as 0.29% of the surface area. Splitting a convex ring along a chord
    //     keeps both pieces convex, so triangulating them is exact.
    //
    //     A chord with an endpoint strictly inside the face cannot be handled this way, so any face
    //     with one goes to the CDT. If the CDT then fails the face used to be kept whole, which
    //     leaves it crossing neighbours that were split and is what makes the result worse than the
    //     input on a dense tangle. It now falls back to the chords that do end on the ring: a
    //     partial exact refinement beats none.
    //
    //     A face with no chords left at all still takes this path: its ring may carry points the
    //     face across an edge was split at, and connecting them is the whole of what this face owes
    //     that neighbour. Refining a face to itself is cheap and keeps the ring conforming.
    if interior_chords.is_empty() {
        if let Some(out) = triangulate_ring_pieces(&ring, &pts, &segment_pair_locals, &global_idx, &local_of)
        {
            return Some(out);
        }
    }

    // What to do when the CDT cannot produce a usable triangulation. Keeping the face whole is
    // what leaves it crossing neighbours that have already been split, which is why a dense tangle
    // came out worse than it went in. The chords that do end on the ring are still handled exactly,
    // so refine along those even if the rest has to stay unresolved.
    let ring_fallback = |chords: &[(usize, usize)]| -> Option<Vec<[u32; 3]>> {
        if chords.is_empty() {
            None
        } else {
            triangulate_ring_pieces(&ring, &pts, chords, &global_idx, &local_of)
        }
    };

    // 4. Run CDT (catch panic defensively; the crate has a few rough edges).
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        cdt::triangulate_with_edges(&pts, &edges)
    }));
    let tris = match result {
        Ok(Ok(t)) => t,
        Ok(Err(_)) => return ring_fallback(&boundary_chords),
        Err(_) => return ring_fallback(&boundary_chords),
    };
    if tris.is_empty() {
        return ring_fallback(&boundary_chords);
    }

    // 5. Ensure CCW in 2D → outward normal in 3D (our (u, v, n) frame is
    //    right-handed so CCW projects to face-normal direction). Flip any
    //    triangle that comes out CW.
    let mut global_back: AHashMap<u32, usize> = AHashMap::new();
    for (i, &g) in global_idx.iter().enumerate() {
        global_back.entry(g).or_insert(i);
    }
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
        return ring_fallback(&boundary_chords);
    }
    // Repair the region the CDT dropped.
    //
    // What the triangulation drops shows up in the output as a boundary loop, exactly like a hole in a mesh,
    // and the same zipper that closes a break-through closes it: the loop's two sides are welded to each
    // other, which covers the missing region exactly and introduces no vertex the face did not already have.
    //
    // The loops have to be told apart, though. Every face has one: its own rim, which is a loop of edges
    // with nothing on the other side because the neighbouring face's triangles are not in this face's
    // output. This used to zip that one too, welding the whole face to itself — with the chords clipped and
    // carrying their real vertices the triangulation covers the face (median 1.000, and no face above 1.001
    // on the file measured below), and the zipper then put a second copy of every triangle behind it
    // (coverage 2.000). The walk below is directed, so the rim comes out counter-clockwise — the direction
    // the emitters force on every sub-triangle — and a dropped region comes out clockwise.
    let back = |g: u32| -> Option<usize> { global_back.get(&g).copied() };
    let mut present: ahash::AHashSet<(usize, usize)> = ahash::AHashSet::new();
    for t in &out {
        if let (Some(a), Some(b), Some(c)) = (back(t[0]), back(t[1]), back(t[2])) {
            present.insert((a, b));
            present.insert((b, c));
            present.insert((c, a));
        }
    }
    let mut boundary: Vec<(usize, usize)> = present
        .iter()
        .copied()
        .filter(|&(a, b)| !present.contains(&(b, a)))
        .collect();
    // The walk below starts from whichever edge comes first, and `present` is a hash set: sorting
    // is what keeps the same mesh refining to the same triangles on every run.
    boundary.sort_unstable();
    if !boundary.is_empty() {
        let mut next: AHashMap<usize, Vec<usize>> = AHashMap::new();
        for &(a, b) in &boundary {
            next.entry(a).or_default().push(b);
        }
        let mut visited: ahash::AHashSet<(usize, usize)> = ahash::AHashSet::new();
        let mut added: Vec<[u32; 3]> = Vec::new();
        for &(start, second) in &boundary {
            if visited.contains(&(start, second)) {
                continue;
            }
            let mut loop_locals: Vec<usize> = vec![start, second];
            visited.insert((start, second));
            let mut cur = second;
            while cur != start {
                let Some(candidates) = next.get(&cur) else {
                    break;
                };
                let Some(&nx) = candidates.iter().find(|&&v| !visited.contains(&(cur, v))) else {
                    break;
                };
                visited.insert((cur, nx));
                loop_locals.push(nx);
                cur = nx;
            }
            if cur != start || loop_locals.len() < 4 {
                continue;
            }
            loop_locals.pop(); // the walk closed on the vertex it started from
            if signed_area_of_loop(&loop_locals, &pts) >= 0.0 {
                continue; // the face's own rim, which is not a hole
            }
            // The zipper works in 3D; the local points are 2D, so they go in with z = 0.
            let flat3: Vec<[f64; 3]> = pts.iter().map(|p| [p.0, p.1, 0.0]).collect();
            let global_loop: Vec<u32> = loop_locals.iter().map(|&i| global_idx[i]).collect();
            if let Some(zip) = zip_loop_sides_flat(&flat3, &loop_locals, &global_loop) {
                added.extend(zip);
            }
        }
        out.extend(added);
    }
    Some(out)
}

/// `zip_loop_sides` over local indices: the loop is given as local indices and the triangles come back in the
/// caller's global indices.
fn zip_loop_sides_flat(
    flat: &[[f64; 3]],
    locals: &[usize],
    global: &[u32],
) -> Option<Vec<[u32; 3]>> {
    let n = locals.len();
    if n < 4 {
        return None;
    }
    let d2 = |a: [f64; 3], b: [f64; 3]| -> f64 {
        let (x, y) = (a[0] - b[0], a[1] - b[1]);
        x * x + y * y
    };
    let quarter = (n / 4).max(1);
    let mut best: Option<(f64, usize, usize)> = None;
    for i in 0..n {
        for j in (i + 1)..n {
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue;
            }
            let (arc_a, arc_b) = (j - i, n - (j - i));
            if arc_a < quarter || arc_b < quarter {
                continue;
            }
            let d = d2(flat[locals[i]], flat[locals[j]]);
            if best.as_ref().map_or(true, |(bd, _, _)| d < *bd) {
                best = Some((d, i, j));
            }
        }
    }
    let (_, i0, j0) = best?;
    let side_a: Vec<usize> = (i0..=j0).collect();
    let mut side_b: Vec<usize> = (j0..n).chain(0..=i0).collect();
    side_b.reverse();
    if side_a.len() < 2 || side_b.len() < 2 {
        return None;
    }
    // `side_a`/`side_b` hold positions *within the loop*, so `global` is indexed by those directly.
    let g = |k: usize| -> u32 { global[k] };
    let (mut p, mut q) = (0usize, 0usize);
    let (na, nb) = (side_a.len(), side_b.len());
    let mut out: Vec<[u32; 3]> = Vec::new();
    while p + 1 < na || q + 1 < nb {
        let advance_a = match (p + 1 < na, q + 1 < nb) {
            (true, false) => true,
            (false, true) => false,
            (true, true) => (p + 1) as f64 * nb as f64 <= (q + 1) as f64 * na as f64,
            (false, false) => break,
        };
        if advance_a {
            let t = [g(side_a[p]), g(side_a[p + 1]), g(side_b[q])];
            // The two sides of the loop start and end at the same vertex, so the last step on either side
            // pairs the shared end with itself. That triangle is zero-area by construction — dropping it
            // loses no geometry — and keeping it is not harmless: a face naming one vertex twice counts its
            // zero-length edge twice, which reads as a non-manifold edge.
            if t[0] != t[1] && t[1] != t[2] && t[0] != t[2] {
                out.push(t);
            }
            p += 1;
        } else {
            let t = [g(side_a[p]), g(side_b[q]), g(side_b[q + 1])];
            if t[0] != t[1] && t[1] != t[2] && t[0] != t[2] {
                out.push(t);
            }
            q += 1;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// The two ring edges a corner belongs to: the one ending at it and the one leaving it.
fn corner_ring_edges(corner: usize) -> [u8; 2] {
    [((corner + 2) % 3) as u8, corner as u8]
}

/// Whether a local point lies on the given ring edge — a corner lies on both of the edges it ends.
fn lies_on_ring_edge(point: usize, edge: u8, on_edge: &[Option<u8>]) -> bool {
    if point < 3 {
        corner_ring_edges(point).contains(&edge)
    } else {
        on_edge[point] == Some(edge)
    }
}

/// Whether two points both lie on one ring edge, which makes the segment between them a piece of
/// that edge rather than a chord across the face.
fn share_a_ring_edge(a: usize, b: usize, on_edge: &[Option<u8>]) -> bool {
    (0..3u8).any(|e| lies_on_ring_edge(a, e, on_edge) && lies_on_ring_edge(b, e, on_edge))
}

/// The face's boundary ring in order: each corner, then the points that landed on the edge leaving
/// it, sorted by their parameter along that edge.
fn ring_order(pts: &[(f64, f64)], on_edge: &[Option<u8>]) -> Vec<usize> {
    let mut ring: Vec<usize> = Vec::with_capacity(pts.len());
    for ei in 0..3usize {
        ring.push(ei);
        let a = pts[ei];
        let b = pts[(ei + 1) % 3];
        let mut inserts: Vec<(f64, usize)> = Vec::new();
        for (pi, oe) in on_edge.iter().enumerate() {
            if pi >= 3 && *oe == Some(ei as u8) {
                inserts.push((param_on_segment(pts[pi], a, b), pi));
            }
        }
        inserts.sort_by(|x, y| x.0.total_cmp(&y.0));
        for (_, pi) in inserts {
            ring.push(pi);
        }
    }
    ring
}

/// The signed area of a closed loop of local points, by the shoelace formula: positive when the
/// loop runs the way the face's own frame turns.
fn signed_area_of_loop(loop_locals: &[usize], pts: &[(f64, f64)]) -> f64 {
    let mut twice = 0.0;
    for i in 0..loop_locals.len() {
        let p = pts[loop_locals[i]];
        let q = pts[loop_locals[(i + 1) % loop_locals.len()]];
        twice += p.0 * q.1 - q.0 * p.1;
    }
    twice * 0.5
}

/// Split the face's boundary ring along each chord and triangulate every piece.
///
/// Exact for any chord whose endpoints both lie on the ring: splitting a convex ring along a chord
/// leaves both pieces convex, so triangulating each is a triangulation of it. The CDT is not used
/// here because with extra points sitting collinear on the boundary it returns a triangulation
/// missing a whole region. Returns `None` if the chords do not split the ring cleanly or the output
/// fails the coverage check.
fn triangulate_ring_pieces(
    ring: &[usize],
    pts: &[(f64, f64)],
    chords: &[(usize, usize)],
    global_idx: &[u32],
    local_of: &AHashMap<u32, usize>,
) -> Option<Vec<[u32; 3]>> {
    let mut pieces: Vec<Vec<usize>> = vec![ring.to_vec()];
    for &(la, lb) in chords {
        let Some(at) = pieces
            .iter()
            .position(|p| p.contains(&la) && p.contains(&lb))
        else {
            return None;
        };
        let piece = pieces.swap_remove(at);
        let ia = piece.iter().position(|&v| v == la).unwrap();
        let ib = piece.iter().position(|&v| v == lb).unwrap();
        let (i, j) = if ia < ib { (ia, ib) } else { (ib, ia) };
        let first: Vec<usize> = piece[i..=j].to_vec();
        let mut second: Vec<usize> = piece[j..].to_vec();
        second.extend_from_slice(&piece[..=i]);
        if first.len() < 3 || second.len() < 3 {
            return None;
        }
        pieces.push(first);
        pieces.push(second);
    }
    let mut out: Vec<[u32; 3]> = Vec::new();
    for piece in &pieces {
        triangulate_convex_piece(piece, pts, global_idx, &mut out);
    }
    if out.is_empty() {
        return None;
    }
    // Coverage, for the same reason the CDT's output is not trusted blindly: a triangulation
    // that does not cover the face it replaces is not a refinement of it. This path is exact by
    // construction — the ring is convex and each piece is cut into ears — but the check is what
    // keeps it that way if the pieces are ever built differently, and it costs one pass over the
    // output.
    //
    // What is compared against is the *ring polygon*, not the three corners: the points on the
    // boundary sit on it only to within the tolerance that found them there, so the polygon they
    // make bulges past the corner triangle by about that much. Measured on a real face, the corner
    // triangle's area misses the ring polygon's by 1.9e-6 relative — just over the tolerance below,
    // which refused the whole face — while the triangulation matched the ring polygon itself to the
    // digit.
    let expected = signed_area_of_loop(ring, pts).abs();
    let covered: f64 = out
        .iter()
        .map(|t| {
            let (a, b, c) = (
                local_of[&t[0]] as usize,
                local_of[&t[1]] as usize,
                local_of[&t[2]] as usize,
            );
            signed_area_2d(pts[a], pts[b], pts[c]).abs()
        })
        .sum();
    // What the sum is allowed to miss. A ring point that the on-edge tolerance put on an edge can
    // sit that far off it, and the sliver between the edge and the point is what the sum then
    // differs by — at most that distance times the edge for each of them, hence the perimeter term.
    // The relative term is for shape: it is two orders below the losses this check exists to catch
    // (the failures it found on real files were 2.9%, 25% and 74% of a face).
    let perimeter: f64 = (0..ring.len())
        .map(|i| {
            let (p, q) = (pts[ring[i]], pts[ring[(i + 1) % ring.len()]]);
            (p.0 - q.0).hypot(p.1 - q.1)
        })
        .sum();
    let slack = edge_tol_for_triangle(pts) * perimeter + expected * 1e-4;
    if expected > 0.0 && (covered - expected).abs() > slack {
        return None;
    }
    Some(out)
}

/// The signed area of a 2D triangle: positive when `a → b → c` turns the way the face's own frame
/// turns, which is the orientation every emitter here is written against.
fn signed_area_2d(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    ((b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)) * 0.5
}

/// Triangulate one convex piece by cutting an ear at a time.
///
/// Two things make this pick the ear it does, and both are load-bearing:
///
/// - **The ear has to be empty, boundary included.** A point the on-edge tolerance accepted can
///   still sit slightly off the edge it was accepted on, which makes the ring polygon *not* convex
///   by that much: the corner ear then contains those points — or has them on its own edge — and
///   emitting it first both covers their slivers twice and leaves the points out of the output
///   altogether, which is the T-junction this whole path exists to avoid. Measured on a real face,
///   the corner ear plus the slivers behind it came to 1.6e-8 more than the polygon's own area.
///   Cutting an ear only when no other vertex is inside it *or on it* leaves those points to be cut
///   into, and the slivers collapse into a remainder with no area.
/// - **The largest one goes first.** A fan from the piece's first vertex emits a zero-area triangle
///   for every point collinear with that vertex, and a zero-area triangle has no normal: the winding
///   pass that grades this mesh compares face normals, and measured in the pipeline a fan's flat
///   triangles took the refinement from 2 connected components to 924. Spending area first leaves a
///   flat ear for when there is genuinely nothing else left, and then it is dropped, not emitted.
fn triangulate_convex_piece(
    piece: &[usize],
    pts: &[(f64, f64)],
    global_idx: &[u32],
    out: &mut Vec<[u32; 3]>,
) {
    let mut poly: Vec<usize> = piece.to_vec();
    while poly.len() > 3 {
        let n = poly.len();
        let mut best: Option<(f64, usize)> = None;
        for i in 0..n {
            let (a, b, c) = (poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]);
            let area = signed_area_2d(pts[a], pts[b], pts[c]);
            if area <= 0.0 {
                continue; // collinear or reflex: not a corner anything can be cut from
            }
            let taken = poly.iter().any(|&v| {
                v != a && v != b && v != c && point_in_triangle(pts[v], pts[a], pts[b], pts[c])
            });
            if taken {
                continue;
            }
            if best.as_ref().map_or(true, |(best_area, _)| area > *best_area) {
                best = Some((area, i));
            }
        }
        let Some((_, i)) = best else {
            // No ear left with any area: what remains is collinear, so there is nothing to cover.
            return;
        };
        let (a, b, c) = (poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]);
        push_face(out, pts, global_idx, a, b, c);
        poly.remove(i);
    }
    if poly.len() == 3 {
        let (a, b, c) = (poly[0], poly[1], poly[2]);
        if signed_area_2d(pts[a], pts[b], pts[c]).abs() > 0.0 {
            push_face(out, pts, global_idx, a, b, c);
        }
    }
}

/// Whether `p` is inside the triangle `a, b, c` **or on its boundary**, which is assumed to be
/// positively oriented. On the boundary counts, and that is the point of it: a point the on-edge
/// tolerance put on an edge makes the ring polygon convex only to within that tolerance, and an ear
/// that reaches *across* such a point — the corner ear of a face whose edge carries one — covers the
/// sliver twice and leaves the point out of the output, which is the T-junction this path exists to
/// avoid. Rejecting that ear leaves the point to be cut into, which the largest-area rule then does
/// first.
fn point_in_triangle(p: (f64, f64), a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> bool {
    signed_area_2d(a, b, p) >= 0.0 && signed_area_2d(b, c, p) >= 0.0 && signed_area_2d(c, a, p) >= 0.0
}

/// Emit one local sub-triangle as a global face, oriented the way the face is.
fn push_face(
    out: &mut Vec<[u32; 3]>,
    pts: &[(f64, f64)],
    global_idx: &[u32],
    a: usize,
    b: usize,
    c: usize,
) {
    let (ga, gb, gc) = (global_idx[a], global_idx[b], global_idx[c]);
    if ga == gb || gb == gc || ga == gc {
        return; // degenerate global triangle — skip
    }
    if signed_area_2d(pts[a], pts[b], pts[c]) >= 0.0 {
        out.push([ga, gb, gc]);
    } else {
        out.push([ga, gc, gb]);
    }
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

/// Returns `true` iff segments (a,b) and (c,d) properly cross — i.e. they
/// intersect at an interior point, not at a shared or coincident endpoint.
fn segments_2d_properly_cross(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> bool {
    let ab = (b.0 - a.0, b.1 - a.1);
    let cd = (d.0 - c.0, d.1 - c.1);
    let denom = ab.0 * cd.1 - ab.1 * cd.0;
    if denom.abs() < 1e-15 {
        return false; // parallel / collinear
    }
    let ac = (c.0 - a.0, c.1 - a.1);
    let t = (ac.0 * cd.1 - ac.1 * cd.0) / denom;
    let u = (ac.0 * ab.1 - ac.1 * ab.0) / denom;
    const EPS: f64 = 1e-9;
    t > EPS && t < 1.0 - EPS && u > EPS && u < 1.0 - EPS
}

/// Greedy crossing filter for interior CDT constraint edges.
///
/// Keeps segments in order, discarding any candidate that properly crosses
/// an already-accepted segment.  O(n²) in the number of interior segments
/// per face — fine in practice since most faces have only a handful of
/// constraint segments.
fn filter_non_crossing_segments_2d(
    segs: Vec<(usize, usize)>,
    pts: &[(f64, f64)],
) -> Vec<(usize, usize)> {
    let mut kept: Vec<(usize, usize)> = Vec::with_capacity(segs.len());
    'candidate: for (a, b) in segs {
        for &(c, d) in &kept {
            // Shared endpoint is fine — CDT handles T-intersections.
            if a == c || a == d || b == c || b == d {
                continue;
            }
            if segments_2d_properly_cross(pts[a], pts[b], pts[c], pts[d]) {
                continue 'candidate;
            }
        }
        kept.push((a, b));
    }
    kept
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
        // Both triangles cross, so both are counted. This read 1 while the counter
        // carried an `other < fi` guard that scored a crossing pair as one triangle.
        assert_eq!(count_self_intersections(&mesh), 2);
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

    /// Co-refinement splits triangles along the curve where they cross, so the surface area must
    /// come out unchanged and every point it adds has to lie on the surface it came from.
    ///
    /// Area pins the direct triangulation. The CDT drops a whole region on a face whose extra
    /// points sit collinear on its boundary — the common case, since an intersection segment enters
    /// and leaves through the edges — which cost this fixture 25% of one face and 3DBenchy 0.29% of
    /// its surface. A face whose chords all start and end on its own boundary is now split and
    /// fanned directly instead of being handed to the CDT.
    ///
    /// The bounding box pins the clamp. The edge-crossing parameter was unclamped, so a
    /// near-coplanar pair could put the crossing a thousand edge-lengths off the mesh: on 3DBenchy
    /// 80 of 15,813 new vertices landed outside the input box, stretching its diagonal from 82.9 to
    /// 147,829 and taking the area up 1,444%.
    #[test]
    fn corefine_preserves_area_and_keeps_points_on_the_mesh() {
        fn area(mesh: &IndexedMesh) -> f64 {
            mesh.triangles
                .iter()
                .map(|t| {
                    let a = mesh.positions[t[0] as usize];
                    let b = mesh.positions[t[1] as usize];
                    let c = mesh.positions[t[2] as usize];
                    b.sub(a).cross(c.sub(a)).length() as f64 * 0.5
                })
                .sum()
        }
        let mut mesh = IndexedMesh {
            positions: vec![
                v(-1.0, -1.0, 0.0),
                v(2.0, -1.0, 0.0),
                v(-1.0, 2.0, 0.0),
                v(-1.0, 0.0, -1.0),
                v(1.0, 0.0, -1.0),
                v(0.0, 0.0, 1.0),
            ],
            triangles: vec![[0, 1, 2], [3, 4, 5]],
        };
        let bbox = mesh.bbox();
        let original = mesh.positions.len();
        let before = area(&mesh);
        let stats = corefine_self_intersections(&mut mesh);
        assert!(stats.new_vertices > 0, "the crossing should add points");
        let after = area(&mesh);
        assert!(
            (after - before).abs() < before * 1e-6,
            "corefinement must not change the surface area: {before} -> {after}"
        );
        for p in mesh.positions[original..].iter() {
            assert!(
                p.x >= bbox.min.x && p.y >= bbox.min.y && p.z >= bbox.min.z,
                "a new point landed below the mesh's own box: {p:?}"
            );
            assert!(
                p.x <= bbox.max.x && p.y <= bbox.max.y && p.z <= bbox.max.z,
                "a new point landed above the mesh's own box: {p:?}"
            );
        }
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

    /// Subtriangles the refinement must not introduce: a face with no area has no normal, and the
    /// winding pass that grades the refinement compares normals.
    fn degenerate_triangles(mesh: &IndexedMesh) -> usize {
        mesh.triangles
            .iter()
            .filter(|t| {
                let a = mesh.positions[t[0] as usize];
                let b = mesh.positions[t[1] as usize];
                let c = mesh.positions[t[2] as usize];
                b.sub(a).cross(c.sub(a)).length() < 1e-12
            })
            .count()
    }

    fn area_of(mesh: &IndexedMesh) -> f64 {
        mesh.triangles
            .iter()
            .map(|t| {
                let a = mesh.positions[t[0] as usize];
                let b = mesh.positions[t[1] as usize];
                let c = mesh.positions[t[2] as usize];
                b.sub(a).cross(c.sub(a)).length() as f64 * 0.5
            })
            .sum()
    }

    /// A chord that runs along the face's own edge. The face and the crossing triangle share a
    /// line, not a vertex, so the pair is a crossing pair, and the segment the other triangle makes
    /// inside the face lies *on* one of its edges — its own edge, extended or shortened.
    ///
    /// The numbers come from a face measured on a real file: the face is 0.7 across, and the
    /// crossing line runs from its corner 0 to a point on the edge 0→1, 28% of the way along.
    ///
    /// This is the case that made the refinement skip the face. The chord ends at a corner, and a
    /// corner carried no edge id, so the chord was not a boundary chord: it went to the CDT as an
    /// interior constraint duplicating a boundary edge, the CDT answered with nothing, and the
    /// fallback had no boundary chord to fall back to. The face was kept whole and stayed crossed —
    /// which is the shape of the whole failure: one side of a crossing split, the other not.
    #[test]
    fn corefine_splits_a_face_whose_chord_runs_along_its_own_edge() {
        let f0 = v(0.0, 0.0, 0.0);
        let f1 = v(1.1730049, 0.072470046, 0.0);
        let f2 = v(0.010028733, 0.019275592, 0.0);
        let cut = v(0.8326541, 0.05144266, 0.0);
        // The crossing triangle, built around the face's corner 0: two vertices above the face's
        // plane and one below, all on the vertical plane through the corner and the cut point, so
        // the segment it makes in the face's plane runs along that line. Its vertices stand off
        // the corner in both directions, which is what makes the intersection pass *through* the
        // corner instead of ending at a vertex of its own.
        let u = cut.scale(1.0 / cut.length());
        let above_a = u.scale(-0.5).add(v(0.0, 0.0, 0.5));
        let above_b = u.scale(1.5).add(v(0.0, 0.0, 0.5));
        let below = u.scale(0.5).add(v(0.0, 0.0, -0.5));
        let mut mesh = IndexedMesh {
            positions: vec![f0, f1, f2, above_a, above_b, below],
            triangles: vec![[0, 1, 2], [3, 4, 5]],
        };

        let before = area_of(&mesh);
        let crossings_before = count_self_intersections(&mesh);
        assert!(crossings_before > 0, "the fixture has to be crossed");
        let degenerate_before = degenerate_triangles(&mesh);

        let stats = corefine_self_intersections(&mut mesh);
        assert_eq!(
            stats.skipped_faces, 0,
            "no face of this fixture may be skipped"
        );
        assert_eq!(
            count_self_intersections(&mesh),
            0,
            "the crossing has to be resolved: the split face and the split triangle meet at the \
             chord, and neither crosses the other"
        );
        let after = area_of(&mesh);
        assert!(
            (after - before).abs() < before * 1e-6,
            "a refinement splits surface, it does not add or lose it: {before} -> {after}"
        );
        assert_eq!(
            degenerate_triangles(&mesh),
            degenerate_before,
            "and it must not introduce a face with no area"
        );
        // And the face is split at the point the chord ends on, which is what the face across that
        // edge needs in order to match it: the edge f0→f1 is two edges in the output, not one. The
        // partner triangle references the point either way, so the count has to be taken on the
        // edge itself.
        let on_the_edge = |p: Vec3| -> Option<f32> {
            let along = p.sub(f0);
            let edge = f1.sub(f0);
            let t = along.dot(edge) / edge.dot(edge);
            (t > 1e-3 && t < 1.0 - 1e-3 && along.sub(edge.scale(t)).length() < 1e-5).then_some(t)
        };
        let mut cut_at: Vec<f32> = Vec::new();
        for t in &mesh.triangles {
            for i in 0..3 {
                let p = mesh.positions[t[i] as usize];
                if let Some(along) = on_the_edge(p) {
                    cut_at.push(along);
                }
            }
        }
        cut_at.sort_by(f32::total_cmp);
        cut_at.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        assert_eq!(
            cut_at.len(),
            1,
            "the face's own edge carries the point the chord ends on, exactly once: {cut_at:?}"
        );
    }

    /// The clip that keeps a face's triangulation inside the face.
    ///
    /// A crossing pair's chord comes from overlapping the two triangles' intervals along the planes'
    /// intersection line, projected onto one axis. That overlap is a necessary condition and not a
    /// sufficient one — with a vertex nearly on the other plane the interval is computed from the
    /// wrong edges — and on the file this work was measured against, half the chords a face carried
    /// (`8,066` of `15,307`) were entirely outside it, with most of the rest reaching outside.
    ///
    /// Handing those points to the face's triangulation is not a near miss. The CDT triangulates the
    /// convex *hull* of the points it is given, so an endpoint outside the face drags surface out
    /// with it: the refinement's own coverage check read a median of 1.16 times the face's area and
    /// a maximum of 744 — on a pass whose job is to close holes rather than open them.
    #[test]
    fn a_chord_is_clipped_to_the_face_it_belongs_to() {
        let f0 = v(0.0, 0.0, 0.0);
        let f1 = v(1.0, 0.0, 0.0);
        let f2 = v(0.0, 1.0, 0.0);
        let tri = [f0, f1, f2];
        let same = |a: Vec3, b: Vec3| a.sub(b).length() < 1e-6;
        let inside = |p: Vec3| -> bool {
            let area = |a: Vec3, b: Vec3, c: Vec3| a.sub(c).cross(b.sub(c)).length() * 0.5;
            (area(p, f1, f2) + area(f0, p, f2) + area(f0, f1, p) - area(f0, f1, f2)).abs() < 1e-6
        };

        // Wholly inside: untouched.
        let (a, b) = clip_segment_to_face(tri, v(0.1, 0.1, 0.0), v(0.4, 0.2, 0.0))
            .expect("a chord inside the face survives");
        assert!(same(a, v(0.1, 0.1, 0.0)) && same(b, v(0.4, 0.2, 0.0)));

        // Out through one edge: the part outside is dropped and the endpoint lands *on* the edge.
        let (a, b) = clip_segment_to_face(tri, v(-0.5, 0.25, 0.0), v(0.5, 0.25, 0.0))
            .expect("a chord that leaves the face keeps the part inside it");
        assert!(same(a, v(0.0, 0.25, 0.0)), "clipped to the edge, got {a:?}");
        assert!(same(b, v(0.5, 0.25, 0.0)), "the inside end is untouched");

        // Past a corner: both ends move, and what is left is inside.
        let (a, b) = clip_segment_to_face(tri, v(-1.0, -1.0, 0.0), v(0.6, 0.6, 0.0))
            .expect("this one crosses the face");
        assert!(
            inside(a) && inside(b),
            "both ends have to be in the face: {a:?} {b:?}"
        );

        // Wholly outside: nothing to refine along.
        assert!(clip_segment_to_face(tri, v(-1.0, -1.0, 0.0), v(-0.4, -1.0, 0.0)).is_none());
        assert!(clip_segment_to_face(tri, v(2.0, 2.0, 0.0), v(3.0, 3.0, 0.0)).is_none());
    }
}

