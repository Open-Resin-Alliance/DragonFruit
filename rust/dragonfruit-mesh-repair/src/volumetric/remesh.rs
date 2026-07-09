//! Feature-aware incremental remesher (Botsch–Kobbelt) with a
//! curvature-adaptive sizing field and dihedral feature protection.
//!
//! The core loop is the commodity algorithm: split edges > 4/3·L, collapse
//! edges < 4/5·L (guarded by the link condition — violating it silently
//! breaks manifoldness), flip toward valence 6, tangentially smooth, and
//! reproject onto the reference surface. The novel/local parts are the
//! sizing field and feature handling, tuned for slicer input.
//!
//! Input contract: closed 2-manifold (DC output). Boundary or non-manifold
//! edges are never operated on (skipped defensively), so a valid input stays
//! valid after every pass.

use crate::core::bvh::Bvh;
use crate::core::mesh::{IndexedMesh, Vec3};
use ahash::{AHashMap, AHashSet};
use smallvec::SmallVec;

pub struct RemeshParams {
    /// Stop decimating once at or below this many live triangles.
    pub target_triangles: usize,
    /// Dihedral angle (degrees) above which an edge is a protected feature.
    pub feature_angle_deg: f32,
    /// Sizing-field clamp (absolute lengths, mm).
    pub sizing_min: f32,
    pub sizing_max: f32,
    /// Outer quality iterations before the decimation loop.
    pub iterations: usize,
    /// Snap vertices back onto the reference surface after smoothing, but
    /// only when the reference is within this distance — gap-fill regions
    /// synthesized by the wrap must not get dragged onto a distant hole rim.
    pub reproject_max_dist: f32,
}

impl Default for RemeshParams {
    fn default() -> Self {
        Self {
            target_triangles: usize::MAX,
            feature_angle_deg: 35.0,
            sizing_min: 0.05,
            sizing_max: 10.0,
            iterations: 4,
            reproject_max_dist: f32::INFINITY,
        }
    }
}

/// Remesh `mesh`, optionally reprojecting onto `reference` (the original
/// input surface + its BVH). Returns a compacted mesh.
pub fn remesh(
    mesh: &IndexedMesh,
    reference: Option<(&IndexedMesh, &Bvh)>,
    params: &RemeshParams,
) -> IndexedMesh {
    let mut em = EditMesh::from_indexed(mesh);
    em.compute_sizing(params);

    for _ in 0..params.iterations {
        em.split_pass(params, 1.0);
        em.collapse_pass(params, 1.0);
        em.flip_pass(params);
        em.smooth_pass(params, reference);
    }
    // Decimation: same loop with the sizing field scaled up until the
    // triangle budget is met.
    let mut scale = 1.0f32;
    let mut rounds = 0;
    while em.live_triangles() > params.target_triangles && rounds < 24 {
        scale *= 1.4;
        em.collapse_pass(params, scale);
        em.flip_pass(params);
        em.smooth_pass(params, reference);
        rounds += 1;
    }
    em.compact()
}

const DELETED: u32 = u32::MAX;

struct EditMesh {
    pos: Vec<Vec3>,
    tri: Vec<[u32; 3]>, // [DELETED; 3]-marked when removed
    vert_faces: Vec<SmallVec<[u32; 8]>>,
    vert_alive: Vec<bool>,
    /// Per-vertex sizing target L(x).
    sizing: Vec<f32>,
    live_tris: usize,
}

impl EditMesh {
    fn from_indexed(mesh: &IndexedMesh) -> Self {
        let mut vert_faces = vec![SmallVec::<[u32; 8]>::new(); mesh.positions.len()];
        for (fi, t) in mesh.triangles.iter().enumerate() {
            for &v in t {
                vert_faces[v as usize].push(fi as u32);
            }
        }
        Self {
            pos: mesh.positions.clone(),
            tri: mesh.triangles.clone(),
            vert_faces,
            vert_alive: vec![true; mesh.positions.len()],
            sizing: vec![0.0; mesh.positions.len()],
            live_tris: mesh.triangles.len(),
        }
    }

    fn live_triangles(&self) -> usize {
        self.live_tris
    }

    fn face_alive(&self, f: u32) -> bool {
        self.tri[f as usize][0] != DELETED
    }

    fn face_normal(&self, f: u32) -> Vec3 {
        let [a, b, c] = self.tri[f as usize];
        let pa = self.pos[a as usize];
        let pb = self.pos[b as usize];
        let pc = self.pos[c as usize];
        let n = pb.sub(pa).cross(pc.sub(pa));
        let len = n.length();
        if len > 1e-20 {
            n.scale(1.0 / len)
        } else {
            Vec3::ZERO
        }
    }

    /// A face is degenerate when its area is vanishing *relative to its edge
    /// lengths* (needle/cap sliver). Its normal is numerical noise: it must
    /// never seed feature classification or fold/knife guards, or the sliver
    /// locks itself in place (noisy dihedral ⇒ spurious feature edges ⇒
    /// corner-locked vertices ⇒ the cleanup collapse is forbidden forever).
    fn face_degenerate(&self, f: u32) -> bool {
        let [a, b, c] = self.tri[f as usize];
        let pa = self.pos[a as usize];
        let pb = self.pos[b as usize];
        let pc = self.pos[c as usize];
        let e0 = pb.sub(pa);
        let e1 = pc.sub(pb);
        let e2 = pa.sub(pc);
        let n_len = e0.cross(pc.sub(pa)).length(); // 2 × area
        let e_max2 = e0.dot(e0).max(e1.dot(e1)).max(e2.dot(e2));
        n_len < 1e-4 * e_max2.max(1e-20)
    }

    /// Faces incident to the undirected edge (u, v).
    fn edge_faces(&self, u: u32, v: u32) -> SmallVec<[u32; 2]> {
        let mut out = SmallVec::new();
        let (small, big) = if self.vert_faces[u as usize].len() <= self.vert_faces[v as usize].len()
        {
            (u, v)
        } else {
            (v, u)
        };
        for &f in &self.vert_faces[small as usize] {
            if !self.face_alive(f) {
                continue;
            }
            let t = self.tri[f as usize];
            if t.contains(&big) {
                out.push(f);
            }
        }
        out
    }

    /// One-ring vertex neighbors of `v`.
    fn neighbors(&self, v: u32) -> SmallVec<[u32; 12]> {
        let mut out: SmallVec<[u32; 12]> = SmallVec::new();
        for &f in &self.vert_faces[v as usize] {
            if !self.face_alive(f) {
                continue;
            }
            for &w in &self.tri[f as usize] {
                if w != v && !out.contains(&w) {
                    out.push(w);
                }
            }
        }
        out
    }

    fn valence(&self, v: u32) -> usize {
        self.neighbors(v).len()
    }

    /// Collect unique live undirected edges.
    fn edges(&self) -> Vec<(u32, u32)> {
        let mut set: AHashSet<(u32, u32)> = AHashSet::with_capacity(self.live_tris * 3 / 2);
        for t in &self.tri {
            if t[0] == DELETED {
                continue;
            }
            for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                set.insert(if a < b { (a, b) } else { (b, a) });
            }
        }
        let mut v: Vec<_> = set.into_iter().collect();
        v.sort_unstable();
        v
    }

    /// Dihedral-based feature classification of the current mesh.
    /// Returns (feature edge set, per-vertex feature-edge count).
    fn classify_features(&self, angle_deg: f32) -> (AHashSet<(u32, u32)>, Vec<u8>) {
        let cos_thresh = angle_deg.to_radians().cos();
        let mut feature: AHashSet<(u32, u32)> = AHashSet::new();
        let mut count = vec![0u8; self.pos.len()];
        for (u, v) in self.edges() {
            let fs = self.edge_faces(u, v);
            if fs.len() != 2 {
                continue;
            }
            // Degenerate slivers have noise normals — never features.
            if self.face_degenerate(fs[0]) || self.face_degenerate(fs[1]) {
                continue;
            }
            let n0 = self.face_normal(fs[0]);
            let n1 = self.face_normal(fs[1]);
            if n0 == Vec3::ZERO || n1 == Vec3::ZERO {
                continue;
            }
            if n0.dot(n1) < cos_thresh {
                feature.insert((u, v));
                count[u as usize] = count[u as usize].saturating_add(1);
                count[v as usize] = count[v as usize].saturating_add(1);
            }
        }
        (feature, count)
    }

    /// Curvature-adaptive sizing field (Dunyach-style): L ≈ sqrt(6ε/κ) with
    /// κ estimated from dihedral angle over edge length, ε from the local
    /// edge scale. Clamped to the params bounds.
    fn compute_sizing(&mut self, params: &RemeshParams) {
        let mut mean_edge = 0.0f64;
        let mut n_edges = 0usize;
        let edges = self.edges();
        let mut kappa = vec![0.0f32; self.pos.len()];
        for &(u, v) in &edges {
            let len = self.pos[u as usize].sub(self.pos[v as usize]).length();
            mean_edge += len as f64;
            n_edges += 1;
            let fs = self.edge_faces(u, v);
            if fs.len() == 2 && len > 1e-12 {
                let n0 = self.face_normal(fs[0]);
                let n1 = self.face_normal(fs[1]);
                let angle = n0.dot(n1).clamp(-1.0, 1.0).acos();
                let k = angle / len;
                kappa[u as usize] = kappa[u as usize].max(k);
                kappa[v as usize] = kappa[v as usize].max(k);
            }
        }
        let mean_edge = if n_edges > 0 {
            (mean_edge / n_edges as f64) as f32
        } else {
            params.sizing_min
        };
        let eps = 0.1 * mean_edge; // approximation tolerance
        for v in 0..self.pos.len() {
            let k = kappa[v].max(1e-6);
            let l = (6.0 * eps / k).sqrt();
            self.sizing[v] = l.clamp(params.sizing_min, params.sizing_max);
        }
    }

    fn edge_target(&self, u: u32, v: u32, scale: f32) -> f32 {
        0.5 * (self.sizing[u as usize] + self.sizing[v as usize]) * scale
    }

    // ---- passes -----------------------------------------------------------

    fn split_pass(&mut self, _params: &RemeshParams, scale: f32) {
        let edges = self.edges();
        for (u, v) in edges {
            if !self.vert_alive[u as usize] || !self.vert_alive[v as usize] {
                continue;
            }
            let target = self.edge_target(u, v, scale);
            let len = self.pos[u as usize].sub(self.pos[v as usize]).length();
            if len > 4.0 / 3.0 * target {
                self.split_edge(u, v);
            }
        }
    }

    fn split_edge(&mut self, u: u32, v: u32) -> Option<u32> {
        let fs = self.edge_faces(u, v);
        if fs.len() != 2 {
            return None;
        }
        let mid = self.pos[u as usize].add(self.pos[v as usize]).scale(0.5);
        let m = self.pos.len() as u32;
        self.pos.push(mid);
        self.vert_alive.push(true);
        self.vert_faces.push(SmallVec::new());
        let s = 0.5 * (self.sizing[u as usize] + self.sizing[v as usize]);
        self.sizing.push(s);

        for f in fs {
            let t = self.tri[f as usize];
            // Rotate so the edge (u, v) or (v, u) is (t0, t1).
            let (t0, t1, t2) = if (t[0] == u && t[1] == v) || (t[0] == v && t[1] == u) {
                (t[0], t[1], t[2])
            } else if (t[1] == u && t[2] == v) || (t[1] == v && t[2] == u) {
                (t[1], t[2], t[0])
            } else {
                (t[2], t[0], t[1])
            };
            // Replace face (t0,t1,t2) with (t0,m,t2) and (m,t1,t2) — winding
            // preserved.
            self.remove_face(f);
            self.add_face([t0, m, t2]);
            self.add_face([m, t1, t2]);
        }
        Some(m)
    }

    fn collapse_pass(&mut self, params: &RemeshParams, scale: f32) {
        let (feature, fcount) = self.classify_features(params.feature_angle_deg);
        let edges = self.edges();
        for (u, v) in edges {
            if !self.vert_alive[u as usize] || !self.vert_alive[v as usize] {
                continue;
            }
            let target = self.edge_target(u, v, scale);
            let len = self.pos[u as usize].sub(self.pos[v as usize]).length();
            if len >= 4.0 / 5.0 * target {
                continue;
            }
            // Feature rules: never collapse across a feature. Moving `u`
            // into `v` is allowed if u is featureless, or the edge itself is
            // a feature line and u is a regular feature vertex (2 feature
            // edges — not a corner). Exception: an edge this much shorter
            // than the sizing floor is numerical debris, not geometry —
            // always collapsible, or degenerate slivers survive forever.
            let degenerate_edge = len < 0.1 * params.sizing_min;
            let ek = if u < v { (u, v) } else { (v, u) };
            let u_feat = fcount[u as usize];
            let allowed = degenerate_edge
                || if u_feat == 0 {
                    true
                } else {
                    feature.contains(&ek) && u_feat == 2
                };
            if !allowed {
                continue;
            }
            // Resulting edge must not immediately need a split.
            self.try_collapse(u, v, params, scale);
        }
    }

    /// Collapse `u` into `v` if the link condition holds and no incident
    /// face folds over. Returns true on success.
    fn try_collapse(&mut self, u: u32, v: u32, params: &RemeshParams, scale: f32) -> bool {
        let fs = self.edge_faces(u, v);
        if fs.len() != 2 {
            return false; // boundary or non-manifold: leave it alone
        }
        // Opposite vertices of the edge's two faces.
        let mut opposite: SmallVec<[u32; 2]> = SmallVec::new();
        for &f in &fs {
            for &w in &self.tri[f as usize] {
                if w != u && w != v {
                    opposite.push(w);
                }
            }
        }
        if opposite.len() != 2 || opposite[0] == opposite[1] {
            return false;
        }
        // Link condition: common neighbors of u and v must be exactly the
        // two opposite vertices, or the collapse pinches the mesh.
        let nu = self.neighbors(u);
        let nv = self.neighbors(v);
        let mut common = 0;
        for &w in &nu {
            if nv.contains(&w) {
                if !opposite.contains(&w) {
                    return false;
                }
                common += 1;
            }
        }
        if common != 2 {
            return false;
        }
        // Fold-over guard: every surviving face of u must keep a sane normal
        // after u moves to v's position, and must not become oversized.
        // Faces that are *already* degenerate slivers are exempt from the
        // rotation checks — their normals are noise, and rejecting on them
        // would permanently block the very collapse that cleans them up.
        let pv = self.pos[v as usize];
        for &f in &self.vert_faces[u as usize] {
            if !self.face_alive(f) || fs.contains(&f) {
                continue;
            }
            let was_degenerate = self.face_degenerate(f);
            let t = self.tri[f as usize];
            let before = self.face_normal(f);
            let p = |w: u32| if w == u { pv } else { self.pos[w as usize] };
            let (pa, pb, pc) = (p(t[0]), p(t[1]), p(t[2]));
            let after = {
                let n = pb.sub(pa).cross(pc.sub(pa));
                let len = n.length();
                if len < 1e-20 && !was_degenerate {
                    return false; // degenerate result
                }
                n.scale(1.0 / len.max(1e-20))
            };
            if !was_degenerate && before != Vec3::ZERO && before.dot(after) < 0.1 {
                return false;
            }
            // Collapsing must not create edges so long the split pass undoes
            // it next round.
            for &w in &t {
                if w != u {
                    let target = self.edge_target(w, v, scale);
                    if pv.sub(self.pos[w as usize]).length() > 4.0 / 3.0 * target.max(1e-12) {
                        return false;
                    }
                }
            }
        }
        let _ = params;

        // Knife-edge guard: the per-face rotation check above bounds each
        // op, but successive collapses can still walk a thin-wall face past
        // 180° in steps — the resulting knife fold passes every topological
        // gate yet renders backfacing and double-counts slicer winding.
        // Reject the collapse if any two post-collapse faces around u/v
        // would share an edge with nearly opposite normals.
        {
            let post_faces: SmallVec<[(u32, [u32; 3]); 16]> = self.vert_faces[u as usize]
                .iter()
                .chain(self.vert_faces[v as usize].iter())
                .filter(|&&f| self.face_alive(f) && !fs.contains(&f))
                .map(|&f| {
                    let mut t = self.tri[f as usize];
                    for w in &mut t {
                        if *w == u {
                            *w = v;
                        }
                    }
                    (f, t)
                })
                .collect();
            // Returns ZERO for degenerate (sliver) triples — their direction
            // is noise and must not trigger knife rejections.
            let normal_of = |t: &[u32; 3]| -> Vec3 {
                let (pa, pb, pc) = (
                    self.pos[t[0] as usize],
                    self.pos[t[1] as usize],
                    self.pos[t[2] as usize],
                );
                let e0 = pb.sub(pa);
                let e1 = pc.sub(pb);
                let e2 = pa.sub(pc);
                let n = e0.cross(pc.sub(pa));
                let len = n.length();
                let e_max2 = e0.dot(e0).max(e1.dot(e1)).max(e2.dot(e2));
                if len > 1e-4 * e_max2.max(1e-20) {
                    n.scale(1.0 / len)
                } else {
                    Vec3::ZERO
                }
            };
            for (i, (fa, ta)) in post_faces.iter().enumerate() {
                for (fb, tb) in post_faces.iter().skip(i + 1) {
                    if fa == fb {
                        continue;
                    }
                    let shared = ta.iter().filter(|w| tb.contains(w)).count();
                    if shared < 2 {
                        continue;
                    }
                    let na = normal_of(ta);
                    let nb = normal_of(tb);
                    if na != Vec3::ZERO && nb != Vec3::ZERO && na.dot(nb) < -0.9 {
                        return false;
                    }
                }
            }
            // Rewired faces must also be checked against their *unchanged*
            // neighbors across the ring edge that contains neither u nor v —
            // that neighbor isn't in `post_faces`, and it is exactly where
            // thin-wall folds kept forming.
            for &f in &self.vert_faces[u as usize] {
                if !self.face_alive(f) || fs.contains(&f) {
                    continue;
                }
                let was_degenerate = self.face_degenerate(f);
                let t = self.tri[f as usize];
                let (x, y) = {
                    let mut others = t.iter().copied().filter(|&w| w != u);
                    (others.next().unwrap(), others.next().unwrap())
                };
                let mut nt = t;
                for w in &mut nt {
                    if *w == u {
                        *w = v;
                    }
                }
                let nf = normal_of(&nt);
                if nf == Vec3::ZERO {
                    if was_degenerate {
                        continue; // sliver stays sliver: cleanup handles it
                    }
                    return false;
                }
                for &g in &self.edge_faces(x, y) {
                    if g == f {
                        continue;
                    }
                    // Neighbor unchanged unless it also touches u (then it
                    // was covered by the pairwise check above).
                    if self.tri[g as usize].contains(&u) || self.face_degenerate(g) {
                        continue;
                    }
                    let ng = self.face_normal(g);
                    if ng != Vec3::ZERO && nf.dot(ng) < -0.9 {
                        return false;
                    }
                }
            }
        }

        // Execute: retire the two edge faces, rewire u's remaining faces to v.
        for &f in &fs {
            self.remove_face(f);
        }
        let faces: SmallVec<[u32; 8]> = self.vert_faces[u as usize].clone();
        for f in faces {
            if !self.face_alive(f) {
                continue;
            }
            let mut t = self.tri[f as usize];
            for w in &mut t {
                if *w == u {
                    *w = v;
                }
            }
            // Rewire in place (faster than remove+add; adjacency updated).
            self.tri[f as usize] = t;
            if !self.vert_faces[v as usize].contains(&f) {
                self.vert_faces[v as usize].push(f);
            }
        }
        self.vert_faces[u as usize].clear();
        self.vert_alive[u as usize] = false;
        true
    }

    fn flip_pass(&mut self, params: &RemeshParams) {
        let (feature, _) = self.classify_features(params.feature_angle_deg);
        let edges = self.edges();
        for (u, v) in edges {
            if !self.vert_alive[u as usize] || !self.vert_alive[v as usize] {
                continue;
            }
            let ek = if u < v { (u, v) } else { (v, u) };
            if feature.contains(&ek) {
                continue;
            }
            self.try_flip(u, v);
        }
    }

    /// Flip edge (u, v) if it strictly improves valence deviation and does
    /// not fold or duplicate an edge.
    fn try_flip(&mut self, u: u32, v: u32) -> bool {
        let fs = self.edge_faces(u, v);
        if fs.len() != 2 {
            return false;
        }
        let (f1, f2) = (fs[0], fs[1]);
        // Orient: f1 traverses u→v, f2 traverses v→u.
        let traverses = |f: u32, a: u32, b: u32| -> bool {
            let t = self.tri[f as usize];
            (t[0] == a && t[1] == b) || (t[1] == a && t[2] == b) || (t[2] == a && t[0] == b)
        };
        let (f1, f2) = if traverses(f1, u, v) { (f1, f2) } else { (f2, f1) };
        if !traverses(f1, u, v) || !traverses(f2, v, u) {
            return false; // inconsistent winding around this edge
        }
        let opp = |f: u32| -> u32 {
            *self.tri[f as usize]
                .iter()
                .find(|&&w| w != u && w != v)
                .unwrap()
        };
        let a = opp(f1);
        let b = opp(f2);
        if a == b {
            return false;
        }
        // New edge must not already exist.
        if self.neighbors(a).contains(&b) {
            return false;
        }
        // Valence improvement (target 6 on a closed surface).
        let dev = |val: i64| (val - 6) * (val - 6);
        let (vu, vv, va, vb) = (
            self.valence(u) as i64,
            self.valence(v) as i64,
            self.valence(a) as i64,
            self.valence(b) as i64,
        );
        let before = dev(vu) + dev(vv) + dev(va) + dev(vb);
        let after = dev(vu - 1) + dev(vv - 1) + dev(va + 1) + dev(vb + 1);
        if after >= before {
            return false;
        }
        // Fold-over guard: both new faces must roughly agree with the old
        // pair's average normal.
        let n_old = {
            let n = self.face_normal(f1).add(self.face_normal(f2));
            let len = n.length();
            if len < 1e-12 {
                return false;
            }
            n.scale(1.0 / len)
        };
        let (pu, pv, pa, pb) = (
            self.pos[u as usize],
            self.pos[v as usize],
            self.pos[a as usize],
            self.pos[b as usize],
        );
        // Boundary cycle u→b→v→a; new faces (u, b, a) and (b, v, a).
        let n1 = pb.sub(pu).cross(pa.sub(pu));
        let n2 = pv.sub(pb).cross(pa.sub(pb));
        let l1 = n1.length();
        let l2 = n2.length();
        if l1 < 1e-20 || l2 < 1e-20 {
            return false;
        }
        let n1 = n1.scale(1.0 / l1);
        let n2 = n2.scale(1.0 / l2);
        if n1.dot(n_old) < 0.1 || n2.dot(n_old) < 0.1 {
            return false;
        }
        // Knife-edge guard: the new faces must not sit nearly opposite any
        // unchanged neighbor across their boundary edges (see try_collapse).
        for (na, e0, e1) in [(n1, u, b), (n1, a, u), (n2, b, v), (n2, v, a)] {
            for &g in &self.edge_faces(e0, e1) {
                if g == f1 || g == f2 {
                    continue;
                }
                let ng = self.face_normal(g);
                if ng != Vec3::ZERO && na.dot(ng) < -0.9 {
                    return false;
                }
            }
        }
        if n1.dot(n2) < -0.9 {
            return false;
        }
        self.remove_face(f1);
        self.remove_face(f2);
        self.add_face([u, b, a]);
        self.add_face([b, v, a]);
        true
    }

    fn smooth_pass(&mut self, params: &RemeshParams, reference: Option<(&IndexedMesh, &Bvh)>) {
        let (_, fcount) = self.classify_features(params.feature_angle_deg);
        let n = self.pos.len();
        let mut moved: Vec<(u32, Vec3)> = Vec::new();
        for v in 0..n as u32 {
            if !self.vert_alive[v as usize] {
                continue;
            }
            // Feature vertices stay put: that is what preserves the feature
            // (dihedral classification is recomputed from geometry).
            if fcount[v as usize] > 0 {
                continue;
            }
            let nbrs = self.neighbors(v);
            if nbrs.len() < 3 {
                continue;
            }
            let mut centroid = Vec3::ZERO;
            for &w in &nbrs {
                centroid = centroid.add(self.pos[w as usize]);
            }
            centroid = centroid.scale(1.0 / nbrs.len() as f32);
            // Vertex normal (average of incident face normals).
            let mut vn = Vec3::ZERO;
            for &f in &self.vert_faces[v as usize] {
                if self.face_alive(f) {
                    vn = vn.add(self.face_normal(f));
                }
            }
            let vl = vn.length();
            if vl < 1e-12 {
                continue;
            }
            let vn = vn.scale(1.0 / vl);
            // Tangential component only — normal drift shrinks volume.
            let d = centroid.sub(self.pos[v as usize]).scale(0.5);
            let dt = d.sub(vn.scale(vn.dot(d)));
            let mut p = self.pos[v as usize].add(dt);
            if let Some((rmesh, rbvh)) = reference {
                let (d2, _, q) = rbvh.closest_point(rmesh, p);
                if d2.sqrt() <= params.reproject_max_dist {
                    p = q;
                }
            }
            moved.push((v, p));
        }
        // Apply with a fold-over revert: skip the move if any incident face
        // flips against its previous normal.
        for (v, p) in moved {
            let old = self.pos[v as usize];
            let mut ok = true;
            let before: SmallVec<[(u32, Vec3); 8]> = self.vert_faces[v as usize]
                .iter()
                .filter(|&&f| self.face_alive(f))
                .map(|&f| (f, self.face_normal(f)))
                .collect();
            self.pos[v as usize] = p;
            for (f, nb) in &before {
                let na = self.face_normal(*f);
                if na == Vec3::ZERO || (nb != &Vec3::ZERO && nb.dot(na) < 0.05) {
                    ok = false;
                    break;
                }
            }
            if !ok {
                self.pos[v as usize] = old;
            }
        }
    }

    // ---- structural helpers ----------------------------------------------

    fn add_face(&mut self, t: [u32; 3]) {
        let f = self.tri.len() as u32;
        self.tri.push(t);
        for &v in &t {
            self.vert_faces[v as usize].push(f);
        }
        self.live_tris += 1;
    }

    fn remove_face(&mut self, f: u32) {
        let t = self.tri[f as usize];
        if t[0] == DELETED {
            return;
        }
        for &v in &t {
            self.vert_faces[v as usize].retain(|x| *x != f);
        }
        self.tri[f as usize] = [DELETED; 3];
        self.live_tris -= 1;
    }

    fn compact(&self) -> IndexedMesh {
        let mut remap: AHashMap<u32, u32> = AHashMap::new();
        let mut out = IndexedMesh::new();
        for t in &self.tri {
            if t[0] == DELETED {
                continue;
            }
            let mut nt = [0u32; 3];
            for (i, &v) in t.iter().enumerate() {
                let nv = *remap.entry(v).or_insert_with(|| {
                    out.positions.push(self.pos[v as usize]);
                    (out.positions.len() - 1) as u32
                });
                nt[i] = nv;
            }
            out.triangles.push(nt);
        }
        out
    }
}
