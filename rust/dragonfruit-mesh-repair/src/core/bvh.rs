//! Axis-aligned bounding volume hierarchy over the triangles of an
//! [`IndexedMesh`]. Built bottom-up with a simple median split; fast enough
//! to construct on multi-million-triangle meshes without fuss, and good
//! enough for self-intersection queries and ray casts.

use crate::core::mesh::{Aabb, IndexedMesh, Vec3};

#[derive(Clone, Debug)]
enum Node {
    Leaf { face: u32, bbox: Aabb },
    Internal { bbox: Aabb, left: u32, right: u32 },
}

pub struct Bvh {
    nodes: Vec<Node>,
    root: u32,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ClosestPointHit {
    pub face: u32,
    pub point: Vec3,
    pub normal: Vec3,
    pub distance: f32,
}

impl Bvh {
    pub fn build(mesh: &IndexedMesh) -> Self {
        let mut nodes = Vec::with_capacity(mesh.triangles.len() * 2);
        let mut prims: Vec<(u32, Aabb, Vec3)> = mesh
            .triangles
            .iter()
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
        let root = Self::build_rec(&mut nodes, &mut prims);
        Self { nodes, root }
    }

    fn build_rec(nodes: &mut Vec<Node>, prims: &mut [(u32, Aabb, Vec3)]) -> u32 {
        if prims.len() == 1 {
            let (face, bb, _) = prims[0];
            let idx = nodes.len() as u32;
            nodes.push(Node::Leaf { face, bbox: bb });
            return idx;
        }
        // Split along the axis with the largest centroid spread.
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
        let left = Self::build_rec(nodes, left_slice);
        let right = Self::build_rec(nodes, right_slice);
        let mut bbox = node_bbox(nodes, left);
        bbox.union(&node_bbox(nodes, right));
        let idx = nodes.len() as u32;
        nodes.push(Node::Internal { bbox, left, right });
        idx
    }

    /// Visit every face whose AABB overlaps `query`.
    pub fn query_aabb<F: FnMut(u32)>(&self, query: &Aabb, mut visit: F) {
        self.query_rec(self.root, query, &mut visit);
    }

    fn query_rec<F: FnMut(u32)>(&self, node: u32, query: &Aabb, visit: &mut F) {
        match self.nodes[node as usize] {
            Node::Leaf { face, ref bbox } => {
                if bbox.overlaps(query) {
                    visit(face);
                }
            }
            Node::Internal {
                ref bbox,
                left,
                right,
            } => {
                if !bbox.overlaps(query) {
                    return;
                }
                self.query_rec(left, query, visit);
                self.query_rec(right, query, visit);
            }
        }
    }

    /// Find the closest point on the mesh within `max_distance`.
    ///
    /// Traversal prunes nodes whose AABB cannot improve the current result.
    /// Equal-distance hits resolve to the lower face index for deterministic
    /// diagnostics.
    pub fn closest_point(
        &self,
        mesh: &IndexedMesh,
        point: Vec3,
        max_distance: f32,
    ) -> Option<ClosestPointHit> {
        if !max_distance.is_finite() || max_distance < 0.0 {
            return None;
        }
        let mut best: Option<(u32, Vec3, f32)> = None;
        let mut best_distance_sq = max_distance * max_distance;
        self.closest_point_rec(mesh, self.root, point, &mut best_distance_sq, &mut best);
        best.map(|(face, closest, distance_sq)| ClosestPointHit {
            face,
            point: closest,
            normal: mesh.tri_normal(face),
            distance: distance_sq.sqrt(),
        })
    }

    fn closest_point_rec(
        &self,
        mesh: &IndexedMesh,
        node: u32,
        point: Vec3,
        best_distance_sq: &mut f32,
        best: &mut Option<(u32, Vec3, f32)>,
    ) {
        match self.nodes[node as usize] {
            Node::Leaf { face, ref bbox } => {
                if point_aabb_distance_sq(point, bbox) > *best_distance_sq {
                    return;
                }
                let [a, b, c] = mesh.tri_positions(face);
                let closest = closest_point_on_triangle(point, a, b, c);
                let distance_sq = closest.sub(point).dot(closest.sub(point));
                let improves = distance_sq < *best_distance_sq
                    || (distance_sq == *best_distance_sq
                        && best.map(|current| face < current.0).unwrap_or(true));
                if improves {
                    *best_distance_sq = distance_sq;
                    *best = Some((face, closest, distance_sq));
                }
            }
            Node::Internal { left, right, .. } => {
                let left_distance = point_aabb_distance_sq(point, &node_bbox(&self.nodes, left));
                let right_distance = point_aabb_distance_sq(point, &node_bbox(&self.nodes, right));
                let (first, first_distance, second, second_distance) =
                    if left_distance <= right_distance {
                        (left, left_distance, right, right_distance)
                    } else {
                        (right, right_distance, left, left_distance)
                    };
                if first_distance <= *best_distance_sq {
                    self.closest_point_rec(mesh, first, point, best_distance_sq, best);
                }
                if second_distance <= *best_distance_sq {
                    self.closest_point_rec(mesh, second, point, best_distance_sq, best);
                }
            }
        }
    }

    /// Cast a ray and count intersections. Returns the hit count; used for
    /// outward-normal voting (odd = inside, even = outside on a closed mesh).
    pub fn ray_hit_count(&self, mesh: &IndexedMesh, origin: Vec3, dir: Vec3) -> u32 {
        let inv_dir = Vec3::new(
            if dir.x.abs() > 1e-20 {
                1.0 / dir.x
            } else {
                f32::INFINITY
            },
            if dir.y.abs() > 1e-20 {
                1.0 / dir.y
            } else {
                f32::INFINITY
            },
            if dir.z.abs() > 1e-20 {
                1.0 / dir.z
            } else {
                f32::INFINITY
            },
        );
        let mut count = 0u32;
        self.ray_rec(mesh, self.root, origin, dir, inv_dir, &mut count);
        count
    }

    fn ray_rec(
        &self,
        mesh: &IndexedMesh,
        node: u32,
        origin: Vec3,
        dir: Vec3,
        inv_dir: Vec3,
        count: &mut u32,
    ) {
        match self.nodes[node as usize] {
            Node::Leaf { face, ref bbox } => {
                if !ray_aabb(origin, inv_dir, bbox) {
                    return;
                }
                let [a, b, c] = mesh.tri_positions(face);
                if ray_tri(origin, dir, a, b, c).is_some() {
                    *count += 1;
                }
            }
            Node::Internal {
                ref bbox,
                left,
                right,
            } => {
                if !ray_aabb(origin, inv_dir, bbox) {
                    return;
                }
                self.ray_rec(mesh, left, origin, dir, inv_dir, count);
                self.ray_rec(mesh, right, origin, dir, inv_dir, count);
            }
        }
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
        let inv_dir = Vec3::new(
            if dir.x.abs() > 1e-20 {
                1.0 / dir.x
            } else {
                f32::INFINITY
            },
            if dir.y.abs() > 1e-20 {
                1.0 / dir.y
            } else {
                f32::INFINITY
            },
            if dir.z.abs() > 1e-20 {
                1.0 / dir.z
            } else {
                f32::INFINITY
            },
        );
        let mut count = 0u32;
        self.ray_rec_excluding(mesh, self.root, origin, dir, inv_dir, skip_face, &mut count);
        count
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
        let inv_dir = Vec3::new(
            if dir.x.abs() > 1e-20 {
                1.0 / dir.x
            } else {
                f32::INFINITY
            },
            if dir.y.abs() > 1e-20 {
                1.0 / dir.y
            } else {
                f32::INFINITY
            },
            if dir.z.abs() > 1e-20 {
                1.0 / dir.z
            } else {
                f32::INFINITY
            },
        );
        let mut count = 0u32;
        self.ray_rec_with_filter(
            mesh,
            self.root,
            origin,
            dir,
            inv_dir,
            include_face,
            &mut count,
        );
        count
    }

    fn ray_rec_excluding(
        &self,
        mesh: &IndexedMesh,
        node: u32,
        origin: Vec3,
        dir: Vec3,
        inv_dir: Vec3,
        skip_face: u32,
        count: &mut u32,
    ) {
        match self.nodes[node as usize] {
            Node::Leaf { face, ref bbox } => {
                if face == skip_face {
                    return;
                }
                if !ray_aabb(origin, inv_dir, bbox) {
                    return;
                }
                let [a, b, c] = mesh.tri_positions(face);
                if ray_tri(origin, dir, a, b, c).is_some() {
                    *count += 1;
                }
            }
            Node::Internal {
                ref bbox,
                left,
                right,
            } => {
                if !ray_aabb(origin, inv_dir, bbox) {
                    return;
                }
                self.ray_rec_excluding(mesh, left, origin, dir, inv_dir, skip_face, count);
                self.ray_rec_excluding(mesh, right, origin, dir, inv_dir, skip_face, count);
            }
        }
    }

    fn ray_rec_with_filter<F>(
        &self,
        mesh: &IndexedMesh,
        node: u32,
        origin: Vec3,
        dir: Vec3,
        inv_dir: Vec3,
        include_face: &F,
        count: &mut u32,
    ) where
        F: Fn(u32) -> bool,
    {
        match self.nodes[node as usize] {
            Node::Leaf { face, ref bbox } => {
                if !include_face(face) {
                    return;
                }
                if !ray_aabb(origin, inv_dir, bbox) {
                    return;
                }
                let [a, b, c] = mesh.tri_positions(face);
                if ray_tri(origin, dir, a, b, c).is_some() {
                    *count += 1;
                }
            }
            Node::Internal {
                ref bbox,
                left,
                right,
            } => {
                if !ray_aabb(origin, inv_dir, bbox) {
                    return;
                }
                self.ray_rec_with_filter(mesh, left, origin, dir, inv_dir, include_face, count);
                self.ray_rec_with_filter(mesh, right, origin, dir, inv_dir, include_face, count);
            }
        }
    }
}

fn point_aabb_distance_sq(point: Vec3, bbox: &Aabb) -> f32 {
    let axis_distance = |value: f32, min: f32, max: f32| {
        if value < min {
            min - value
        } else if value > max {
            value - max
        } else {
            0.0
        }
    };
    let dx = axis_distance(point.x, bbox.min.x, bbox.max.x);
    let dy = axis_distance(point.y, bbox.min.y, bbox.max.y);
    let dz = axis_distance(point.z, bbox.min.z, bbox.max.z);
    dx * dx + dy * dy + dz * dz
}

fn closest_point_on_triangle(point: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    // Real-Time Collision Detection, Christer Ericson, section 5.1.5.
    let ab = b.sub(a);
    let ac = c.sub(a);
    let ap = point.sub(a);
    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }

    let bp = point.sub(b);
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return a.add(ab.scale(d1 / (d1 - d3)));
    }

    let cp = point.sub(c);
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return a.add(ac.scale(d2 / (d2 - d6)));
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let edge = c.sub(b);
        return b.add(edge.scale((d4 - d3) / ((d4 - d3) + (d5 - d6))));
    }

    let denominator = 1.0 / (va + vb + vc);
    let v = vb * denominator;
    let w = vc * denominator;
    a.add(ab.scale(v)).add(ac.scale(w))
}

fn node_bbox(nodes: &[Node], idx: u32) -> Aabb {
    match nodes[idx as usize] {
        Node::Leaf { ref bbox, .. } => *bbox,
        Node::Internal { ref bbox, .. } => *bbox,
    }
}

#[inline]
fn ray_aabb(origin: Vec3, inv_dir: Vec3, bbox: &Aabb) -> bool {
    let t1 = (bbox.min.x - origin.x) * inv_dir.x;
    let t2 = (bbox.max.x - origin.x) * inv_dir.x;
    let t3 = (bbox.min.y - origin.y) * inv_dir.y;
    let t4 = (bbox.max.y - origin.y) * inv_dir.y;
    let t5 = (bbox.min.z - origin.z) * inv_dir.z;
    let t6 = (bbox.max.z - origin.z) * inv_dir.z;
    let tmin = t1.min(t2).max(t3.min(t4)).max(t5.min(t6));
    let tmax = t1.max(t2).min(t3.max(t4)).min(t5.max(t6));
    tmax >= tmin.max(0.0)
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
