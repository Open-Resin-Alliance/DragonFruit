//! Axis-aligned bounding volume hierarchy over the triangles of an
//! [`IndexedMesh`].
//!
//! Flat and leaf-batched, because the ambient-occlusion bake is the heaviest ray
//! consumer in the app — eight rays for every vertex of every model in the scene
//! — and the layout this replaced stored one triangle per node in an enum. A
//! 2.1M-triangle model built 4.3M of those nodes (~150 MB) about 21 levels deep,
//! so a ray missed cache on most of its visits: measured 1761 ns per ray against
//! 133 ns on a 150k-triangle model, i.e. the cost tracked the model rather than
//! the work. Nodes are now 32 bytes in flat arrays with up to [`LEAF_FACES`]
//! triangles each, and traversal is ordered by the near child's entry distance
//! and pruned at the caller's distance cutoff.

use crate::mesh::{Aabb, IndexedMesh, Vec3};
use rayon::prelude::*;

/// Triangles per leaf. Larger leaves cost more triangle tests per visited leaf
/// and save node visits and cache misses; 8 measured best over `1, 2, 4, 16`.
const LEAF_FACES: usize = 8;
/// Marks [`FlatNode::b`] as a leaf's face count rather than a right child.
const LEAF_FLAG: u32 = 1 << 31;
/// Traversal stack depth. A binary tree over `faces / LEAF_FACES` leaves is
/// `log2(that) + 1` deep, so this covers any mesh a u32 face index can address.
const STACK_DEPTH: usize = 64;

#[derive(Clone, Copy, Debug)]
struct FlatNode {
    min: [f32; 3],
    max: [f32; 3],
    /// Internal: left child index. Leaf: first index into `faces`.
    a: u32,
    /// Internal: right child index. Leaf: `LEAF_FLAG | face count`.
    b: u32,
}

impl FlatNode {
    #[inline]
    fn is_leaf(&self) -> bool {
        self.b & LEAF_FLAG != 0
    }

    #[inline]
    fn face_count(&self) -> usize {
        (self.b & !LEAF_FLAG) as usize
    }
}

pub struct Bvh {
    nodes: Vec<FlatNode>,
    /// Triangle indices, grouped by leaf.
    faces: Vec<u32>,
    root: u32,
}

impl Bvh {
    pub fn build(mesh: &IndexedMesh) -> Self {
        let count = mesh.triangles.len();
        let mut prims: Vec<(u32, Aabb, Vec3)> = mesh
            .triangles
            .par_iter()
            .enumerate()
            .map(|(i, tri)| {
                let a = mesh.positions[tri[0] as usize];
                let b = mesh.positions[tri[1] as usize];
                let c = mesh.positions[tri[2] as usize];
                let mut bb = Aabb::empty();
                bb.expand(a);
                bb.expand(b);
                bb.expand(c);
                let centroid = a.add(b).add(c).scale(1.0 / 3.0);
                (i as u32, bb, centroid)
            })
            .collect();

        let mut nodes = Vec::with_capacity(count / LEAF_FACES * 2 + 2);
        let mut faces = vec![0u32; count];
        let mut written = 0usize;
        let root = if count == 0 {
            0
        } else {
            build_rec(&mut nodes, &mut faces, &mut written, &mut prims, 0)
        };
        Self { nodes, faces, root }
    }

    /// Visit every face whose own bounding box overlaps `query`.
    ///
    /// Takes the mesh because the leaf it lives in may cover neighbours that do
    /// not overlap; the caller sees exactly the faces the per-face test accepts.
    pub fn query_aabb<F: FnMut(u32)>(&self, mesh: &IndexedMesh, query: &Aabb, mut visit: F) {
        if self.nodes.is_empty() {
            return;
        }
        let mut stack = [0u32; STACK_DEPTH];
        let mut depth = 1usize;
        stack[0] = self.root;
        while depth > 0 {
            depth -= 1;
            let node = self.nodes[stack[depth] as usize];
            if !aabb_overlaps(&node, query) {
                continue;
            }
            if node.is_leaf() {
                for k in 0..node.face_count() {
                    let face = self.faces[node.a as usize + k];
                    if face_aabb(mesh, face).overlaps(query) {
                        visit(face);
                    }
                }
            } else {
                stack[depth] = node.a;
                stack[depth + 1] = node.b;
                depth += 2;
            }
        }
    }

    /// Cast a ray and count intersections. Returns the hit count; used for
    /// outward-normal voting (odd = inside, even = outside on a closed mesh).
    pub fn ray_hit_count(&self, mesh: &IndexedMesh, origin: Vec3, dir: Vec3) -> u32 {
        self.traverse_count(mesh, origin, dir, &|_| true)
    }

    /// Like [`ray_hit_count`] but excludes `skip_face` from the hit count.
    /// Use this when the ray origin is on `skip_face` to prevent self-hits.
    pub fn ray_hit_count_excluding(
        &self,
        mesh: &IndexedMesh,
        origin: Vec3,
        dir: Vec3,
        skip_face: u32,
    ) -> u32 {
        self.traverse_count(mesh, origin, dir, &|face| face != skip_face)
    }

    /// Cast a ray and count intersections while including only faces that
    /// satisfy `include_face`.
    ///
    /// This is used by higher-level repair passes that need to ignore entire
    /// subsets of faces (for example: all faces of the component currently
    /// being classified).
    pub fn ray_hit_count_with_filter<F>(
        &self,
        mesh: &IndexedMesh,
        origin: Vec3,
        dir: Vec3,
        include_face: &F,
    ) -> u32
    where
        F: Fn(u32) -> bool,
    {
        self.traverse_count(mesh, origin, dir, include_face)
    }

    /// Is anything hit within `max_distance` along `dir`?
    ///
    /// Unlike [`ray_hit_count`] this stops at the first hit and ignores geometry
    /// past the cutoff, which is what a visibility query needs: ambient occlusion
    /// asks whether the sky is blocked *nearby*, not how many walls exist along
    /// an infinite ray. The cutoff also prunes the traversal, which is most of
    /// why the bake is affordable.
    pub fn ray_occluded_within(
        &self,
        mesh: &IndexedMesh,
        origin: Vec3,
        dir: Vec3,
        max_distance: f32,
    ) -> bool {
        if self.nodes.is_empty() {
            return false;
        }
        let inv_dir = inverse_direction(dir);
        let entry = node_entry(origin, inv_dir, &self.nodes[self.root as usize], max_distance);
        if entry.is_infinite() {
            return false;
        }
        let mut stack = [0u32; STACK_DEPTH];
        let mut tmin = [0.0f32; STACK_DEPTH];
        let mut depth = 1usize;
        stack[0] = self.root;
        tmin[0] = entry;
        while depth > 0 {
            depth -= 1;
            let node = self.nodes[stack[depth] as usize];
            if node.is_leaf() {
                for k in 0..node.face_count() {
                    let face = self.faces[node.a as usize + k];
                    let [a, b, c] = mesh.tri_positions(face);
                    if let Some(t) = ray_tri(origin, dir, a, b, c) {
                        if (0.0..=max_distance).contains(&t) {
                            return true;
                        }
                    }
                }
                continue;
            }
            // Push the farther child first so the nearer one is visited next:
            // occlusion usually hits within a few triangles, and stopping early
            // is what keeps this bounded.
            let near = node_entry(origin, inv_dir, &self.nodes[node.a as usize], max_distance);
            let far = node_entry(origin, inv_dir, &self.nodes[node.b as usize], max_distance);
            let (first, first_t, second, second_t) = if near <= far {
                (node.a, near, node.b, far)
            } else {
                (node.b, far, node.a, near)
            };
            if !second_t.is_infinite() {
                stack[depth] = second;
                tmin[depth] = second_t;
                depth += 1;
            }
            if !first_t.is_infinite() {
                stack[depth] = first;
                tmin[depth] = first_t;
                depth += 1;
            }
        }
        false
    }

    /// Distance to the nearest hit within `max_distance`, or `None`.
    ///
    /// Ambient occlusion wants *how close* the blocking geometry is, not merely
    /// whether there is any: measured on a real model, the deepest crevices are
    /// occluded by geometry within half a millimetre while a flat base under a
    /// mass of detail is only occluded by geometry several millimetres away. A
    /// boolean query cannot tell those apart. Unlike [`Self::ray_occluded_within`]
    /// this cannot stop at the first hit, so it prunes against the best distance
    /// found so far instead.
    ///
    /// `saturate_at` is the distance below which the caller stops distinguishing
    /// hits: one found at or under it ends the search. Ambient occlusion passes the
    /// top of its falloff plateau, where the weight is full strength, so a nearer
    /// hit cannot shade any darker, and the traversal stops instead of proving
    /// *which* triangle is nearest. Worth about a tenth of the bake measured on a
    /// 2.8M-face model, not more, because the rays that decide a value usually
    /// cross the taper rather than landing inside the plateau.
    pub fn ray_nearest_within(
        &self,
        mesh: &IndexedMesh,
        origin: Vec3,
        dir: Vec3,
        max_distance: f32,
        saturate_at: f32,
    ) -> Option<f32> {
        if self.nodes.is_empty() {
            return None;
        }
        let saturate = saturate_at.min(max_distance);
        let inv_dir = inverse_direction(dir);
        let mut best = max_distance;
        let mut found = false;
        let entry = node_entry(origin, inv_dir, &self.nodes[self.root as usize], best);
        if entry.is_infinite() {
            return None;
        }
        let mut stack = [0u32; STACK_DEPTH];
        let mut depth = 1usize;
        stack[0] = self.root;
        while depth > 0 {
            depth -= 1;
            let node = self.nodes[stack[depth] as usize];
            if node_entry(origin, inv_dir, &node, best).is_infinite() {
                continue;
            }
            if node.is_leaf() {
                for k in 0..node.face_count() {
                    let face = self.faces[node.a as usize + k];
                    let [a, b, c] = mesh.tri_positions(face);
                    if let Some(t) = ray_tri(origin, dir, a, b, c) {
                        if t >= 0.0 {
                            if t <= saturate {
                                return Some(t);
                            }
                            if t < best {
                                best = t;
                                found = true;
                            }
                        }
                    }
                }
                continue;
            }
            // Near child first: the far one is likelier to be pruned once the
            // near one has tightened `best`.
            let near = node_entry(origin, inv_dir, &self.nodes[node.a as usize], best);
            let far = node_entry(origin, inv_dir, &self.nodes[node.b as usize], best);
            let (first, second) = if near <= far {
                (node.a, node.b)
            } else {
                (node.b, node.a)
            };
            stack[depth] = second;
            depth += 1;
            stack[depth] = first;
            depth += 1;
        }
        if found {
            Some(best)
        } else {
            None
        }
    }

    fn traverse_count<F>(&self, mesh: &IndexedMesh, origin: Vec3, dir: Vec3, include_face: &F) -> u32
    where
        F: Fn(u32) -> bool,
    {
        if self.nodes.is_empty() {
            return 0;
        }
        let inv_dir = inverse_direction(dir);
        let mut count = 0u32;
        let mut stack = [0u32; STACK_DEPTH];
        let mut depth = 1usize;
        stack[0] = self.root;
        while depth > 0 {
            depth -= 1;
            let node = self.nodes[stack[depth] as usize];
            if node_entry(origin, inv_dir, &node, f32::INFINITY).is_infinite() {
                continue;
            }
            if node.is_leaf() {
                for k in 0..node.face_count() {
                    let face = self.faces[node.a as usize + k];
                    if !include_face(face) {
                        continue;
                    }
                    let [a, b, c] = mesh.tri_positions(face);
                    if ray_tri(origin, dir, a, b, c).is_some() {
                        count += 1;
                    }
                }
            } else {
                stack[depth] = node.a;
                stack[depth + 1] = node.b;
                depth += 2;
            }
        }
        count
    }
}

/// Recursively split `prims` into nodes, appending leaves to `nodes` and their
/// face indices to `faces`. `written` is the next free slot in `faces`.
fn build_rec(
    nodes: &mut Vec<FlatNode>,
    faces: &mut [u32],
    written: &mut usize,
    prims: &mut [(u32, Aabb, Vec3)],
    _depth: u32,
) -> u32 {
    let mut bbox = Aabb::empty();
    for &(_, bb, _) in prims.iter() {
        bbox.union(&bb);
    }

    if prims.len() <= LEAF_FACES {
        let first = *written as u32;
        for &(face, _, _) in prims.iter() {
            faces[*written] = face;
            *written += 1;
        }
        let idx = nodes.len() as u32;
        nodes.push(FlatNode {
            min: [bbox.min.x, bbox.min.y, bbox.min.z],
            max: [bbox.max.x, bbox.max.y, bbox.max.z],
            a: first,
            b: LEAF_FLAG | prims.len() as u32,
        });
        return idx;
    }

    // Split along the axis with the largest centroid spread, at the median.
    let mut cmin = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut cmax = Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for &(_, _, c) in prims.iter() {
        cmin = cmin.min(c);
        cmax = cmax.max(c);
    }
    let ext = cmax.sub(cmin);
    let axis = if ext.x >= ext.y && ext.x >= ext.z {
        0
    } else if ext.y >= ext.z {
        1
    } else {
        2
    };
    let mid = prims.len() / 2;
    prims.select_nth_unstable_by(mid, |a, b| {
        let (av, bv) = match axis {
            0 => (a.2.x, b.2.x),
            1 => (a.2.y, b.2.y),
            _ => (a.2.z, b.2.z),
        };
        av.partial_cmp(&bv).unwrap_or(std::cmp::Ordering::Equal)
    });
    let (left_slice, right_slice) = prims.split_at_mut(mid);

    let left = build_rec(nodes, faces, written, left_slice, _depth + 1);
    let right = build_rec(nodes, faces, written, right_slice, _depth + 1);

    let idx = nodes.len() as u32;
    nodes.push(FlatNode {
        min: [bbox.min.x, bbox.min.y, bbox.min.z],
        max: [bbox.max.x, bbox.max.y, bbox.max.z],
        a: left,
        b: right,
    });
    idx
}

#[inline]
fn inverse_direction(dir: Vec3) -> Vec3 {
    let axis = |v: f32| if v.abs() > 1e-20 { 1.0 / v } else { f32::INFINITY };
    Vec3::new(axis(dir.x), axis(dir.y), axis(dir.z))
}

/// Distance along the ray at which it enters `node`, or infinity if it misses or
/// enters beyond `max_distance`.
#[inline]
fn node_entry(origin: Vec3, inv_dir: Vec3, node: &FlatNode, max_distance: f32) -> f32 {
    let t1 = (node.min[0] - origin.x) * inv_dir.x;
    let t2 = (node.max[0] - origin.x) * inv_dir.x;
    let t3 = (node.min[1] - origin.y) * inv_dir.y;
    let t4 = (node.max[1] - origin.y) * inv_dir.y;
    let t5 = (node.min[2] - origin.z) * inv_dir.z;
    let t6 = (node.max[2] - origin.z) * inv_dir.z;
    let tmin = t1.min(t2).max(t3.min(t4)).max(t5.min(t6)).max(0.0);
    let tmax = t1.max(t2).min(t3.max(t4)).min(t5.max(t6));
    if tmax < tmin || tmin > max_distance {
        f32::INFINITY
    } else {
        tmin
    }
}

#[inline]
fn aabb_overlaps(node: &FlatNode, query: &Aabb) -> bool {
    node.min[0] <= query.max.x
        && node.max[0] >= query.min.x
        && node.min[1] <= query.max.y
        && node.max[1] >= query.min.y
        && node.min[2] <= query.max.z
        && node.max[2] >= query.min.z
}

#[inline]
fn face_aabb(mesh: &IndexedMesh, face: u32) -> Aabb {
    let [a, b, c] = mesh.tri_positions(face);
    let mut bb = Aabb::empty();
    bb.expand(a);
    bb.expand(b);
    bb.expand(c);
    bb
}

/// Möller–Trumbore triangle intersection; returns `t >= 0` if hit in front.
pub fn ray_tri(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Option<f32> {
    const EPS: f32 = 1e-8;
    let e1 = b.sub(a);
    let e2 = c.sub(a);
    let p = dir.cross(e2);
    let det = e1.dot(p);
    if det.abs() < EPS {
        return None;
    }
    let inv_det = 1.0 / det;
    let s = origin.sub(a);
    let u = s.dot(p) * inv_det;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = s.cross(e1);
    let v = dir.dot(q) * inv_det;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = e2.dot(q) * inv_det;
    if t >= 0.0 {
        Some(t)
    } else {
        None
    }
}

/// Triangle/triangle intersection test (no coplanar degenerate handling;
/// shared edges are treated as non-intersecting). Sufficient for counting
/// self-intersections as a repair signal.
pub fn tri_tri_intersect(t0: [Vec3; 3], t1: [Vec3; 3]) -> bool {
    // If the two triangles share any vertex (positionally identical), skip —
    // edge/vertex sharing is not a self-intersection.
    for a in &t0 {
        for b in &t1 {
            if (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9 && (a.z - b.z).abs() < 1e-9 {
                return false;
            }
        }
    }
    tri_tri_intersect_inner(t0, t1)
}

fn signed_dist(p: Vec3, n: Vec3, d: f32) -> f32 {
    p.dot(n) + d
}

fn tri_tri_intersect_inner(t0: [Vec3; 3], t1: [Vec3; 3]) -> bool {
    // Plane of t1.
    let n1 = t1[1].sub(t1[0]).cross(t1[2].sub(t1[0]));
    let n1_len2 = n1.dot(n1);
    if n1_len2 < 1e-20 {
        return false;
    }
    let d1 = -n1.dot(t1[0]);
    let d00 = signed_dist(t0[0], n1, d1);
    let d01 = signed_dist(t0[1], n1, d1);
    let d02 = signed_dist(t0[2], n1, d1);
    if (d00 > 0.0 && d01 > 0.0 && d02 > 0.0) || (d00 < 0.0 && d01 < 0.0 && d02 < 0.0) {
        return false;
    }

    let n0 = t0[1].sub(t0[0]).cross(t0[2].sub(t0[0]));
    let n0_len2 = n0.dot(n0);
    if n0_len2 < 1e-20 {
        return false;
    }
    let d0 = -n0.dot(t0[0]);
    let d10 = signed_dist(t1[0], n0, d0);
    let d11 = signed_dist(t1[1], n0, d0);
    let d12 = signed_dist(t1[2], n0, d0);
    if (d10 > 0.0 && d11 > 0.0 && d12 > 0.0) || (d10 < 0.0 && d11 < 0.0 && d12 < 0.0) {
        return false;
    }

    // Intersect along the line of intersection of the two planes.
    let dir = n0.cross(n1);
    let axis = {
        let ax = dir.x.abs();
        let ay = dir.y.abs();
        let az = dir.z.abs();
        if ax >= ay && ax >= az {
            0
        } else if ay >= az {
            1
        } else {
            2
        }
    };
    let proj = |v: Vec3| match axis {
        0 => v.x,
        1 => v.y,
        _ => v.z,
    };

    let iv0 = interval_on_line(proj(t0[0]), proj(t0[1]), proj(t0[2]), d00, d01, d02);
    let iv1 = interval_on_line(proj(t1[0]), proj(t1[1]), proj(t1[2]), d10, d11, d12);
    let (a0, b0) = iv0;
    let (a1, b1) = iv1;
    let lo = a0.max(a1);
    let hi = b0.min(b1);
    lo <= hi
}

fn interval_on_line(p0: f32, p1: f32, p2: f32, d0: f32, d1: f32, d2: f32) -> (f32, f32) {
    // Find two edges crossing the plane and compute their intersection
    // parameter along the axis.
    let mut hits: smallvec::SmallVec<[f32; 2]> = smallvec::SmallVec::new();
    let edges = [(p0, d0, p1, d1), (p1, d1, p2, d2), (p2, d2, p0, d0)];
    for (pa, da, pb, db) in edges {
        if da * db <= 0.0 && (da - db).abs() > 1e-20 {
            let t = da / (da - db);
            hits.push(pa + (pb - pa) * t);
        }
    }
    if hits.len() < 2 {
        return (f32::INFINITY, f32::NEG_INFINITY);
    }
    let mut lo = hits[0];
    let mut hi = hits[0];
    for &h in &hits[1..] {
        if h < lo {
            lo = h;
        }
        if h > hi {
            hi = h;
        }
    }
    (lo, hi)
}
