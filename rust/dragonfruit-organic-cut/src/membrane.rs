//! Contour ("wafer") cut — split a mesh into two parts along a *curved* surface
//! that follows the user-drawn geodesic loop, instead of a flat plane.
//!
//! The geometric idea (see `.scratch/organic-cut-wafer-handoff.md`):
//!   1. Build a **membrane**: a triangulated surface spanning the loop, relaxed
//!      into a minimal (soap-film) surface so it bows with the loop's contour.
//!   2. Thicken it into a **razor-thin watertight slab** (~0.01 mm) — the cutter.
//!   3. `model.difference(&cutter).decompose()` → two parts that mate along the
//!      contoured seam (the slab is sub-resolution so the mate is physically zero).
//!
//! This module is built **test-first**. Before the membrane (the hard part) is
//! written, we prove the *split crux* in isolation (M4c): that differencing a
//! thin watertight slab from a solid and decomposing yields exactly TWO
//! components. Everything downstream depends on that being true, so it is
//! validated on a trivial cube first — see the tests at the bottom.

#![cfg(feature = "manifold")]

use dragonfruit_mesh_core::bvh::Bvh;
use dragonfruit_mesh_core::mesh::{Aabb, IndexedMesh, Vec3};

/// Default cutter thickness in mm. This is an ABSOLUTE minimum, independent of
/// model size — a bigger model must NOT lose a bigger chunk. It only needs to be
/// (a) below print resolution so the mate is physically negligible, and (b) thick
/// enough that the boolean engine resolves the two slab faces apart.
///
/// 0.1 mm: thin enough that the slice looks like a near-zero-thickness cut (the
/// goal — parts mate cleanly), yet thick enough that the boolean engine resolves
/// the two slab faces apart at model scale. (0.01 mm went degenerate on large
/// models; 1.0 mm was a too-thick proving value.)
pub const DEFAULT_CUTTER_THICKNESS_MM: f32 = 0.1;

/// A triangulated open surface (a "patch") whose boundary is the user's loop.
///
/// `boundary` is the ORDERED ring of vertex indices that lie on the loop (in
/// loop order, not repeating the first at the end). These vertices are pinned
/// during relaxation and stitched into the slab side wall. Every other vertex is
/// interior and free to move. Triangles index into `vertices`.
///
/// Note: after subdivision the boundary ring includes the edge-midpoints created
/// ALONG the loop, so it stays a dense, exact sampling of the loop polyline —
/// the seam follows the loop precisely and the slab can be sealed completely.
#[derive(Clone, Debug)]
pub struct Membrane {
    pub vertices: Vec<Vec3>,
    pub triangles: Vec<[u32; 3]>,
    pub boundary: Vec<u32>,
}

impl Membrane {
    /// Sum of triangle areas — a cheap proxy for "how relaxed" the membrane is
    /// (a minimal surface minimizes area, so this should DECREASE during relax).
    pub fn area(&self) -> f32 {
        let mut total = 0.0;
        for t in &self.triangles {
            let a = self.vertices[t[0] as usize];
            let b = self.vertices[t[1] as usize];
            let c = self.vertices[t[2] as usize];
            total += b.sub(a).cross(c.sub(a)).length() * 0.5;
        }
        total
    }
}

/// Build a relaxed minimal-surface membrane spanning the closed `loop_pts`.
///
/// Pipeline (handoff §4 steps 1-2):
///   1. **Seed**: loop centroid as a single interior apex → fan-triangulate the
///      loop into a spanning disk.
///   2. **Subdivide**: midpoint-subdivide every triangle `subdivisions` times so
///      there are enough interior vertices to relax into a smooth surface.
///   3. **Relax**: Laplacian (umbrella) smoothing of interior vertices, boundary
///      pinned — the surface bows to follow the loop's 3D contour (soap-film).
///
/// `loop_pts` must be the ordered, de-duplicated loop (NOT repeating the first
/// point at the end — closure is implicit). Returns `None` if the loop is
/// degenerate (< 3 distinct points).
pub fn build_membrane(loop_pts: &[Vec3], subdivisions: u32) -> Option<Membrane> {
    build_membrane_smoothed(loop_pts, subdivisions, DEFAULT_MEMBRANE_SMOOTHING)
}

/// Default membrane smoothing (0..1). 0.5 reproduces the original 60 relaxation
/// passes; 0 = no relaxation (raw faceted grid), 1 = very smooth/taut surface.
pub const DEFAULT_MEMBRANE_SMOOTHING: f32 = 0.5;

/// Default membrane grid resolution (cells across the loop's larger bbox dim).
/// The preview and a 1× cut use this; higher values give a denser cutter mesh.
pub const DEFAULT_GRID_DIVISIONS: f64 = 24.0;

/// As [`build_membrane`] but with explicit `smoothing` (0..1) controlling the
/// soap-film relaxation strength (how smooth/taut the cutter surface is). Uses
/// the default grid resolution.
pub fn build_membrane_smoothed(
    loop_pts: &[Vec3],
    subdivisions: u32,
    smoothing: f32,
) -> Option<Membrane> {
    build_membrane_full(loop_pts, subdivisions, smoothing, DEFAULT_GRID_DIVISIONS)
}

/// As [`build_membrane_smoothed`] but with explicit `grid_divisions` controlling
/// the membrane mesh density (poly count of the cutter). Higher = denser. Only
/// the contour CUT raises this; the live preview stays at the default so editing
/// is light.
pub fn build_membrane_full(
    loop_pts: &[Vec3],
    subdivisions: u32,
    smoothing: f32,
    grid_divisions: f64,
) -> Option<Membrane> {
    let loop_pts = dedupe_loop(loop_pts);
    if loop_pts.len() < 3 {
        return None;
    }

    // Grid seed (constrained Delaunay over a uniform interior point grid) →
    // well-shaped, near-uniform triangles with NO fan apex. Falls back to the
    // centroid fan + subdivision only if CDT fails (degenerate/odd loop).
    let mut membrane = match seed_grid(&loop_pts, grid_divisions) {
        Some(m) => m,
        None => {
            let mut fan = seed_fan(&loop_pts)?;
            for _ in 0..subdivisions {
                subdivide(&mut fan);
            }
            fan
        }
    };
    // Unify triangle winding across the whole patch. CDT orients each triangle by
    // its 2D sign, which can leave NEIGHBOURING triangles inconsistently wound on
    // a bowed/non-convex membrane. A mixed-winding surface is closed and non-self-
    // intersecting yet still `NotManifold` to the boolean engine — this was the
    // dragon failure (topology 0/0/0, no self-X, still rejected). Flood-fill from
    // one triangle so every neighbour agrees.
    orient_membrane(&mut membrane);
    // Minimal-surface relaxation bows the (flat) grid to follow the loop contour.
    // `smoothing` scales the pass count: 0.5 → 60 (original), 1 → 120, 2 → 240.
    let passes = (smoothing.clamp(0.0, 2.0) * 120.0).round() as usize;
    if passes > 0 {
        relax(&mut membrane, passes, 0.5);
    }
    Some(membrane)
}

/// The subdivision level `contour_split` uses — shared so the preview shows the
/// SAME membrane the cut will use.
pub const CONTOUR_SUBDIVISIONS: u32 = 3;

/// Build the membrane EXACTLY as `contour_split` would, and return it as a flat
/// triangle soup (9 f32 per triangle, model-local space) for previewing in the
/// scene. `None` if the loop is degenerate. This is the single source of truth
/// for "what surface will the contour cut use" — render it to see the cutter.
pub fn build_membrane_preview_soup(loop_pts: &[Vec3]) -> Option<Vec<f32>> {
    build_membrane_preview_soup_smoothed(loop_pts, DEFAULT_MEMBRANE_SMOOTHING)
}

/// As [`build_membrane_preview_soup`] but with explicit membrane `smoothing`, so
/// the preview reflects the slider value.
pub fn build_membrane_preview_soup_smoothed(loop_pts: &[Vec3], smoothing: f32) -> Option<Vec<f32>> {
    build_membrane_preview_soup_full(loop_pts, smoothing, 1.0)
}

/// As [`build_membrane_preview_soup_smoothed`] but also reflecting the cut
/// `density` multiplier, so the preview matches the cut resolution live.
pub fn build_membrane_preview_soup_full(
    loop_pts: &[Vec3],
    smoothing: f32,
    density: f32,
) -> Option<Vec<f32>> {
    let grid_divisions = DEFAULT_GRID_DIVISIONS * (density.clamp(1.0, 4.0) as f64);
    let membrane = build_membrane_full(loop_pts, CONTOUR_SUBDIVISIONS, smoothing, grid_divisions)?;
    Some(membrane_to_soup(&membrane))
}

/// Flatten a membrane's indexed triangles into a raw triangle soup.
fn membrane_to_soup(m: &Membrane) -> Vec<f32> {
    let mut soup = Vec::with_capacity(m.triangles.len() * 9);
    for t in &m.triangles {
        for &vi in t {
            let v = m.vertices[vi as usize];
            soup.extend_from_slice(&[v.x, v.y, v.z]);
        }
    }
    soup
}

/// Remove consecutive duplicate points (within epsilon) and a trailing point
/// that repeats the first (some callers close the loop explicitly).
fn dedupe_loop(pts: &[Vec3]) -> Vec<Vec3> {
    const EPS: f32 = 1e-5;
    let mut out: Vec<Vec3> = Vec::with_capacity(pts.len());
    for &p in pts {
        if let Some(&last) = out.last() {
            if p.sub(last).length() < EPS {
                continue;
            }
        }
        out.push(p);
    }
    // Drop a trailing point equal to the first (explicit closure).
    if out.len() >= 2 {
        let first = out[0];
        if out[out.len() - 1].sub(first).length() < EPS {
            out.pop();
        }
    }
    out
}

/// Seed a spanning disk: centroid apex + a fan of triangles to each loop edge.
/// Vertices `0..n` are the loop (boundary, pinned); vertex `n` is the centroid.
fn seed_fan(loop_pts: &[Vec3]) -> Option<Membrane> {
    let n = loop_pts.len();
    if n < 3 {
        return None;
    }
    let mut centroid = Vec3::ZERO;
    for &p in loop_pts {
        centroid = centroid.add(p);
    }
    centroid = centroid.scale(1.0 / n as f32);

    let mut vertices = loop_pts.to_vec();
    let apex = n as u32;
    vertices.push(centroid);

    let mut triangles = Vec::with_capacity(n);
    for i in 0..n {
        let a = i as u32;
        let b = ((i + 1) % n) as u32;
        // Wind apex→a→b consistently around the fan.
        triangles.push([apex, a, b]);
    }
    // Boundary ring = the loop vertices in order (0..n).
    let boundary = (0..n as u32).collect();
    Some(Membrane { vertices, triangles, boundary })
}

/// An orthonormal frame for the loop's best-fit plane: `origin` + axes `u`,`v`
/// (in-plane) and `n` (normal). Projects 3D → 2D `(u,v)` and back.
struct PlaneFrame {
    origin: Vec3,
    u: Vec3,
    v: Vec3,
    n: Vec3,
}

impl PlaneFrame {
    /// Build from a point cloud via PCA-style best-fit normal (same math family
    /// as organic_cut's `best_fit_plane_normal`), with an arbitrary in-plane basis.
    fn fit(pts: &[Vec3]) -> Option<Self> {
        let n_pts = pts.len();
        if n_pts < 3 {
            return None;
        }
        let mut origin = Vec3::ZERO;
        for &p in pts {
            origin = origin.add(p);
        }
        origin = origin.scale(1.0 / n_pts as f32);

        // Covariance (symmetric) → smallest-eigenvector normal via the classic
        // "largest cross product of covariance rows" trick.
        let (mut xx, mut xy, mut xz, mut yy, mut yz, mut zz) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
        for &p in pts {
            let d = p.sub(origin);
            let (dx, dy, dz) = (d.x as f64, d.y as f64, d.z as f64);
            xx += dx * dx;
            xy += dx * dy;
            xz += dx * dz;
            yy += dy * dy;
            yz += dy * dz;
            zz += dz * dz;
        }
        let det_x = yy * zz - yz * yz;
        let det_y = xx * zz - xz * xz;
        let det_z = xx * yy - xy * xy;
        let det_max = det_x.max(det_y).max(det_z);
        if det_max <= 1e-12 {
            return None; // collinear / degenerate
        }
        let normal = if det_max == det_x {
            Vec3::new(det_x as f32, (xz * yz - xy * zz) as f32, (xy * yz - xz * yy) as f32)
        } else if det_max == det_y {
            Vec3::new((xz * yz - xy * zz) as f32, det_y as f32, (xy * xz - yz * xx) as f32)
        } else {
            Vec3::new((xy * yz - xz * yy) as f32, (xy * xz - yz * xx) as f32, det_z as f32)
        };
        let nlen = normal.length();
        if nlen < 1e-9 {
            return None;
        }
        let n = normal.scale(1.0 / nlen);

        // Pick an in-plane u axis not parallel to n, then v = n × u.
        let seed = if n.x.abs() < 0.9 { Vec3::new(1.0, 0.0, 0.0) } else { Vec3::new(0.0, 1.0, 0.0) };
        let mut u = seed.sub(n.scale(seed.dot(n)));
        let ulen = u.length();
        if ulen < 1e-9 {
            return None;
        }
        u = u.scale(1.0 / ulen);
        let v = n.cross(u);
        Some(Self { origin, u, v, n })
    }

    #[inline]
    fn to_2d(&self, p: Vec3) -> (f64, f64) {
        let d = p.sub(self.origin);
        (d.dot(self.u) as f64, d.dot(self.v) as f64)
    }

    #[inline]
    fn to_3d(&self, uv: (f64, f64)) -> Vec3 {
        self.origin
            .add(self.u.scale(uv.0 as f32))
            .add(self.v.scale(uv.1 as f32))
    }
}

/// True if 2D point `p` is strictly inside the polygon `poly` (ray-casting).
fn point_in_polygon(p: (f64, f64), poly: &[(f64, f64)]) -> bool {
    let n = poly.len();
    let mut inside = false;
    let (px, py) = p;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        // Does the edge (j→i) straddle the horizontal ray at py, and is the
        // crossing to the right of px?
        if ((yi > py) != (yj > py))
            && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Grid seed: triangulate the loop with a uniform interior point grid via
/// constrained Delaunay (the `cdt` crate, as in `arrangement.rs`). Produces
/// well-shaped, near-uniform triangles — NO fan apex, NO slivers — which is what
/// makes the cut face a clean grid instead of a pinwheel.
///
/// Steps: best-fit plane → project loop to 2D → drop a uniform grid of interior
/// points (target spacing) inside the loop polygon → CDT with the loop as a
/// closed constraint (CDT returns only interior triangles) → lift back to 3D.
/// Returns `None` (caller falls back to `seed_fan`) if the loop is degenerate or
/// CDT fails.
fn seed_grid(loop_pts: &[Vec3], grid_divisions: f64) -> Option<Membrane> {
    let n = loop_pts.len();
    if n < 3 {
        return None;
    }
    let frame = PlaneFrame::fit(loop_pts)?;

    // Raw loop in 2D + its bbox (for spacing).
    let raw2d: Vec<(f64, f64)> = loop_pts.iter().map(|&p| frame.to_2d(p)).collect();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for &(x, y) in &raw2d {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }

    // Target grid spacing = a fraction of the loop's extent, so even a coarse
    // 4-point loop gets a real interior grid. ~`grid_divisions` cells across the
    // larger bbox dimension. Independent of how many points the user clicked.
    let grid_divisions = grid_divisions.max(1.0);
    let extent = (max_x - min_x).max(max_y - min_y).max(1e-4);
    let spacing = (extent / grid_divisions).max(1e-4);

    // Densify the boundary to ~`spacing` resolution so CDT has short rim edges
    // (otherwise long loop edges with no interior points force slivers). Each
    // densified boundary point also carries its 3D position (linear interpolation
    // of the loop verts → lies EXACTLY on the loop edge in 3D, keeping the seam
    // precise). These become the membrane's boundary ring, in order.
    let mut bnd2d: Vec<(f64, f64)> = Vec::new();
    let mut bnd3d: Vec<Vec3> = Vec::new();
    for i in 0..n {
        let a2 = raw2d[i];
        let b2 = raw2d[(i + 1) % n];
        let a3 = loop_pts[i];
        let b3 = loop_pts[(i + 1) % n];
        let seg_len = ((a2.0 - b2.0).powi(2) + (a2.1 - b2.1).powi(2)).sqrt();
        let steps = ((seg_len / spacing).floor() as usize).max(1);
        // Emit the start vertex + interior subdivisions; the next segment emits
        // its own start, so we don't duplicate the shared corner.
        for s in 0..steps {
            let t = s as f64 / steps as f64;
            bnd2d.push((a2.0 + (b2.0 - a2.0) * t, a2.1 + (b2.1 - a2.1) * t));
            bnd3d.push(a3.add(b3.sub(a3).scale(t as f32)));
        }
    }
    let bn = bnd2d.len();

    // Points list: densified boundary first (indices 0..bn = the boundary ring),
    // then interior grid points strictly inside, off the boundary (no rim slivers).
    let mut pts2d: Vec<(f64, f64)> = bnd2d.clone();
    let inset = spacing * 0.5;
    let mut y = min_y + spacing;
    let mut grid_row = 0;
    while y < max_y {
        let x_start = min_x + spacing + if grid_row % 2 == 1 { spacing * 0.5 } else { 0.0 };
        let mut x = x_start;
        while x < max_x {
            let p = (x, y);
            if point_in_polygon(p, &raw2d) && dist_to_polygon(p, &raw2d) > inset {
                pts2d.push(p);
            }
            x += spacing;
        }
        y += spacing;
        grid_row += 1;
    }

    // Densified boundary as closed constraint edges (i → i+1, wrapping the ring).
    let edges: Vec<(usize, usize)> = (0..bn).map(|i| (i, (i + 1) % bn)).collect();

    // Run CDT defensively (the crate can panic on tricky inputs).
    let tris = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        cdt::triangulate_with_edges(&pts2d, &edges)
    }))
    .ok()?
    .ok()?;
    if tris.is_empty() {
        return None;
    }

    // Lift every point back to 3D. Boundary points (0..bn) use their precise 3D
    // positions on the loop edges (bnd3d); interior points lift from the plane.
    let mut vertices: Vec<Vec3> = Vec::with_capacity(pts2d.len());
    for (i, &uv) in pts2d.iter().enumerate() {
        if i < bn {
            vertices.push(bnd3d[i]);
        } else {
            vertices.push(frame.to_3d(uv));
        }
    }

    // Orient triangles consistently (CCW in 2D → +n in 3D). Flip any CW ones.
    let mut triangles: Vec<[u32; 3]> = Vec::with_capacity(tris.len());
    for (a, b, c) in tris {
        let pa = pts2d[a];
        let pb = pts2d[b];
        let pc = pts2d[c];
        let cross = (pb.0 - pa.0) * (pc.1 - pa.1) - (pb.1 - pa.1) * (pc.0 - pa.0);
        if cross.abs() < 1e-18 {
            continue; // degenerate
        }
        if cross > 0.0 {
            triangles.push([a as u32, b as u32, c as u32]);
        } else {
            triangles.push([a as u32, c as u32, b as u32]);
        }
    }
    if triangles.is_empty() {
        return None;
    }

    let boundary = (0..bn as u32).collect();
    Some(Membrane { vertices, triangles, boundary })
}

/// Unify triangle winding across the membrane by flood-fill. Two triangles
/// sharing an edge are consistently wound iff they traverse that edge in OPPOSITE
/// directions; if they traverse it the same way, one must be flipped. BFS from
/// triangle 0, flipping neighbours as needed so the whole patch agrees.
fn orient_membrane(m: &mut Membrane) {
    let n = m.triangles.len();
    if n == 0 {
        return;
    }
    // Map each undirected edge → the (up to 2) triangles using it.
    let mut edge_tris: ahash::AHashMap<(u32, u32), smallvec::SmallVec<[usize; 2]>> =
        ahash::AHashMap::with_capacity(n * 3);
    for (fi, t) in m.triangles.iter().enumerate() {
        for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let k = if a < b { (a, b) } else { (b, a) };
            edge_tris.entry(k).or_default().push(fi);
        }
    }
    // Does triangle `fi` traverse directed edge (a→b)? (i.e. (a,b) appears in
    // winding order). Used to compare neighbour orientations.
    let traverses = |tri: [u32; 3], a: u32, b: u32| -> bool {
        (tri[0] == a && tri[1] == b)
            || (tri[1] == a && tri[2] == b)
            || (tri[2] == a && tri[0] == b)
    };

    let mut visited = vec![false; n];
    let mut queue = std::collections::VecDeque::new();
    visited[0] = true;
    queue.push_back(0usize);

    while let Some(fi) = queue.pop_front() {
        let tri = m.triangles[fi];
        for &(a, b) in &[(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
            let k = if a < b { (a, b) } else { (b, a) };
            if let Some(neighbours) = edge_tris.get(&k) {
                for &nf in neighbours {
                    if nf == fi || visited[nf] {
                        continue;
                    }
                    visited[nf] = true;
                    // `fi` traverses a→b; a CONSISTENT neighbour must traverse b→a.
                    // If it ALSO traverses a→b, it's wound the same way → flip it.
                    let nt = m.triangles[nf];
                    if traverses(nt, a, b) {
                        m.triangles[nf] = [nt[0], nt[2], nt[1]];
                    }
                    queue.push_back(nf);
                }
            }
        }
    }

    // The flood-fill makes winding CONSISTENT (all triangles agree with their
    // neighbours). Whether the patch faces "up" or "down" overall doesn't matter:
    // the slab copies this winding for the top sheet and reverses it for the
    // bottom, and the side wall is keyed to the boundary ring — all consistent
    // regardless of the global facing. (An earlier global-flip heuristic here was
    // buggy and inverted correctly-wound patches → removed.)
}

/// Shortest distance from 2D point `p` to any edge of the polygon.
fn dist_to_polygon(p: (f64, f64), poly: &[(f64, f64)]) -> f64 {
    let n = poly.len();
    let mut best = f64::MAX;
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        best = best.min(dist_point_segment_2d(p, a, b));
    }
    best
}

/// Distance from `p` to segment `a`–`b` in 2D.
fn dist_point_segment_2d(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (abx, aby) = (b.0 - a.0, b.1 - a.1);
    let (apx, apy) = (p.0 - a.0, p.1 - a.1);
    let len2 = abx * abx + aby * aby;
    let t = if len2 > 0.0 { ((apx * abx + apy * aby) / len2).clamp(0.0, 1.0) } else { 0.0 };
    let (cx, cy) = (a.0 + t * abx, a.1 + t * aby);
    ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt()
}

/// One round of 1→4 midpoint subdivision. Each triangle is split into four by
/// adding a vertex at the midpoint of each edge; shared edge-midpoints are
/// de-duplicated so the result stays a consistent (watertight-interior) mesh.
///
/// CRUCIAL: a midpoint of a BOUNDARY edge (a consecutive pair in the loop ring)
/// is itself a boundary vertex and is inserted into the ring between its two
/// endpoints. This keeps the membrane boundary an exact, ever-denser sampling of
/// the loop polyline — so it stays pinned to the loop AND the slab side wall can
/// be sealed all the way around. (The earlier bug: boundary midpoints were left
/// interior, leaving the loop edges unsealed → 72 open edges.)
fn subdivide(m: &mut Membrane) {
    use std::collections::HashMap;

    // Map an undirected edge (min,max vertex index) → its midpoint vertex index,
    // creating the midpoint on first request.
    let mut midpoint: HashMap<(u32, u32), u32> = HashMap::new();
    let mut mid = |m: &mut Membrane, a: u32, b: u32| -> u32 {
        let key = if a < b { (a, b) } else { (b, a) };
        if let Some(&idx) = midpoint.get(&key) {
            return idx;
        }
        let pa = m.vertices[a as usize];
        let pb = m.vertices[b as usize];
        let idx = m.vertices.len() as u32;
        m.vertices.push(pa.add(pb).scale(0.5));
        midpoint.insert(key, idx);
        idx
    };

    let old_tris = std::mem::take(&mut m.triangles);
    let mut new_tris = Vec::with_capacity(old_tris.len() * 4);
    for t in old_tris {
        let (a, b, c) = (t[0], t[1], t[2]);
        let ab = mid(m, a, b);
        let bc = mid(m, b, c);
        let ca = mid(m, c, a);
        new_tris.push([a, ab, ca]);
        new_tris.push([ab, b, bc]);
        new_tris.push([ca, bc, c]);
        new_tris.push([ab, bc, ca]);
    }
    m.triangles = new_tris;

    // Rebuild the boundary ring, inserting each boundary-edge midpoint in order.
    let old_boundary = std::mem::take(&mut m.boundary);
    let bn = old_boundary.len();
    let mut new_boundary = Vec::with_capacity(bn * 2);
    for i in 0..bn {
        let a = old_boundary[i];
        let b = old_boundary[(i + 1) % bn];
        let key = if a < b { (a, b) } else { (b, a) };
        let midpt = *midpoint
            .get(&key)
            .expect("every boundary edge is a triangle edge → has a midpoint");
        new_boundary.push(a);
        new_boundary.push(midpt);
    }
    m.boundary = new_boundary;
}

/// Laplacian (umbrella) relaxation toward a minimal surface. Each interior
/// vertex moves toward the centroid of its 1-ring neighbours; boundary vertices
/// are pinned. Converges when the total area change between passes is negligible.
///
/// This is the membrane analogue of `geodesic::straighten_path`'s relaxation,
/// but the vertices move freely in 3D (no reprojection) — the surface is free to
/// bow through the model interior, which is what makes it a soap-film.
fn relax(m: &mut Membrane, max_passes: usize, strength: f32) {
    // Build a 1-ring neighbour list once (the topology is fixed during relax).
    let neighbours = one_ring(m);
    // O(1) "is this vertex pinned?" lookup.
    let mut pinned = vec![false; m.vertices.len()];
    for &b in &m.boundary {
        pinned[b as usize] = true;
    }
    let mut prev_area = m.area();

    for _ in 0..max_passes {
        // Compute all targets from the CURRENT positions (Jacobi-style), then
        // apply — avoids order-dependence within a pass.
        let mut updated = m.vertices.clone();
        for v in 0..m.vertices.len() {
            if pinned[v] {
                continue;
            }
            let nbrs = &neighbours[v];
            if nbrs.is_empty() {
                continue;
            }
            let mut sum = Vec3::ZERO;
            for &nb in nbrs {
                sum = sum.add(m.vertices[nb as usize]);
            }
            let target = sum.scale(1.0 / nbrs.len() as f32);
            let cur = m.vertices[v];
            updated[v] = cur.add(target.sub(cur).scale(strength));
        }
        m.vertices = updated;

        let area = m.area();
        if (prev_area - area).abs() < prev_area * 1e-4 {
            break;
        }
        prev_area = area;
    }
}

/// Per-vertex 1-ring neighbour indices, derived from the triangle list.
fn one_ring(m: &Membrane) -> Vec<Vec<u32>> {
    use std::collections::BTreeSet;
    let mut sets: Vec<BTreeSet<u32>> = vec![BTreeSet::new(); m.vertices.len()];
    for t in &m.triangles {
        let (a, b, c) = (t[0], t[1], t[2]);
        sets[a as usize].insert(b);
        sets[a as usize].insert(c);
        sets[b as usize].insert(a);
        sets[b as usize].insert(c);
        sets[c as usize].insert(a);
        sets[c as usize].insert(b);
    }
    sets.into_iter().map(|s| s.into_iter().collect()).collect()
}

// ──────────────────────────────────────────────────────────────────────────
// Isotropic remeshing (Botsch–Kobbelt). Interleaved with relaxation, this turns
// the cheap fan seed into uniform, well-shaped triangles — the fix for the ugly
// cut faces caused by fan slivers. Each pass:
//   1. split  edges longer  than 4/3 * target   (fill stretched/sparse regions)
//   2. collapse edges shorter than 4/5 * target  (remove slivers/over-dense)
//   3. flip   edges toward valence balance        (kill skinny triangles)
//   4. tangential smooth interior verts            (even out spacing)
// Boundary (loop) vertices are pinned; boundary edges are never collapsed/flipped
// (only split, with the midpoint kept on the boundary ring) so the seam stays put.
//
// CURRENTLY DISABLED: `build_membrane` uses the simple `relax` (the stable "cut
// worked" path). This remesh is kept, fully tested, behind `relax_and_remesh`
// for when we revisit triangle quality. Each item carries `allow(dead_code)`
// because the non-test build doesn't call it yet.
// ──────────────────────────────────────────────────────────────────────────

#[allow(dead_code)]
type EdgeKey = (u32, u32);

#[inline]
#[allow(dead_code)]
fn ekey(a: u32, b: u32) -> EdgeKey {
    if a < b { (a, b) } else { (b, a) }
}

/// Mutable adjacency for one remesh pass: which faces touch each edge, plus
/// boundary lookups. Rebuilt cheaply (the membrane is a few thousand tris).
#[allow(dead_code)]
struct Adjacency {
    /// edge → up to two incident face indices.
    edge_faces: ahash::AHashMap<EdgeKey, smallvec::SmallVec<[u32; 2]>>,
    boundary_verts: ahash::AHashSet<u32>,
    boundary_edges: ahash::AHashSet<EdgeKey>,
}

impl Adjacency {
    fn build(m: &Membrane) -> Self {
        let mut edge_faces: ahash::AHashMap<EdgeKey, smallvec::SmallVec<[u32; 2]>> =
            ahash::AHashMap::with_capacity(m.triangles.len() * 3);
        for (fi, t) in m.triangles.iter().enumerate() {
            for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                edge_faces.entry(ekey(a, b)).or_default().push(fi as u32);
            }
        }
        let boundary_verts: ahash::AHashSet<u32> = m.boundary.iter().copied().collect();
        let mut boundary_edges = ahash::AHashSet::with_capacity(m.boundary.len());
        let bn = m.boundary.len();
        for i in 0..bn {
            boundary_edges.insert(ekey(m.boundary[i], m.boundary[(i + 1) % bn]));
        }
        Self { edge_faces, boundary_verts, boundary_edges }
    }

    #[inline]
    fn is_boundary_vert(&self, v: u32) -> bool {
        self.boundary_verts.contains(&v)
    }
    #[inline]
    fn is_boundary_edge(&self, k: EdgeKey) -> bool {
        self.boundary_edges.contains(&k)
    }
}

/// The "ideal" edge length for the membrane: the loop perimeter divided by a
/// target boundary-segment count. This makes triangle size uniform and scaled to
/// the loop, independent of the model's absolute size.
fn target_edge_length(m: &Membrane) -> f32 {
    let bn = m.boundary.len();
    if bn < 2 {
        return 1.0;
    }
    let mut perim = 0.0;
    for i in 0..bn {
        let a = m.vertices[m.boundary[i] as usize];
        let b = m.vertices[m.boundary[(i + 1) % bn] as usize];
        perim += b.sub(a).length();
    }
    // The boundary already samples the loop at ~bn points; match interior density
    // to that average boundary edge length so the whole mesh is isotropic.
    (perim / bn as f32).max(1e-4)
}

/// The third vertex of face `fi` that is not `a` or `b` (the apex across edge ab).
#[inline]
#[allow(dead_code)] // used by collapse/flip (added next)
fn opposite_vertex(tri: [u32; 3], a: u32, b: u32) -> Option<u32> {
    for &v in &tri {
        if v != a && v != b {
            return Some(v);
        }
    }
    None
}

/// Split every edge longer than `high` at its midpoint, in ONE pass. Computes the
/// set of long edges, assigns each a midpoint vertex, then rebuilds every triangle
/// according to how many of its three edges are split (adaptive 1→2/3/4 split).
/// Boundary-edge midpoints are inserted into the boundary ring (seam stays pinned
/// & sealed). Returns the number of edges split.
fn remesh_split(m: &mut Membrane, high: f32) -> usize {
    let adj = Adjacency::build(m);
    // 1. Pick long edges and create a midpoint vertex for each (deduplicated).
    let mut mid_of: ahash::AHashMap<EdgeKey, u32> = ahash::AHashMap::new();
    for &k in adj.edge_faces.keys() {
        let len = m.vertices[k.0 as usize].sub(m.vertices[k.1 as usize]).length();
        if len > high {
            let mp = m.vertices[k.0 as usize].add(m.vertices[k.1 as usize]).scale(0.5);
            let idx = m.vertices.len() as u32;
            m.vertices.push(mp);
            mid_of.insert(k, idx);
        }
    }
    if mid_of.is_empty() {
        return 0;
    }

    // 2. Rebuild every triangle based on which of its edges got a midpoint.
    let old_tris = std::mem::take(&mut m.triangles);
    let mut new_tris: Vec<[u32; 3]> = Vec::with_capacity(old_tris.len() * 2);
    for t in old_tris {
        let (a, b, c) = (t[0], t[1], t[2]);
        let mab = mid_of.get(&ekey(a, b)).copied();
        let mbc = mid_of.get(&ekey(b, c)).copied();
        let mca = mid_of.get(&ekey(c, a)).copied();
        emit_split_triangle(&mut new_tris, a, b, c, mab, mbc, mca);
    }
    m.triangles = new_tris;

    // 3. Rebuild the boundary ring, inserting midpoints for split boundary edges.
    let split_boundary: usize = adj
        .boundary_edges
        .iter()
        .filter(|k| mid_of.contains_key(k))
        .count();
    if split_boundary > 0 {
        let old = std::mem::take(&mut m.boundary);
        let bn = old.len();
        let mut nb = Vec::with_capacity(bn + split_boundary);
        for i in 0..bn {
            let a = old[i];
            let b = old[(i + 1) % bn];
            nb.push(a);
            if let Some(&mid) = mid_of.get(&ekey(a, b)) {
                nb.push(mid);
            }
        }
        m.boundary = nb;
    }
    mid_of.len()
}

/// Emit the adaptive split of triangle (a,b,c) given optional edge midpoints,
/// preserving winding (a→b→c). Handles all 8 cases (0..3 split edges) so the mesh
/// stays conforming (no T-junctions): a neighbour that split a shared edge forces
/// this triangle to use the same midpoint.
fn emit_split_triangle(
    out: &mut Vec<[u32; 3]>,
    a: u32,
    b: u32,
    c: u32,
    mab: Option<u32>,
    mbc: Option<u32>,
    mca: Option<u32>,
) {
    match (mab, mbc, mca) {
        (None, None, None) => out.push([a, b, c]),
        // One edge split → 2 triangles.
        (Some(m), None, None) => {
            out.push([a, m, c]);
            out.push([m, b, c]);
        }
        (None, Some(m), None) => {
            out.push([b, m, a]);
            out.push([m, c, a]);
        }
        (None, None, Some(m)) => {
            out.push([c, m, b]);
            out.push([m, a, b]);
        }
        // Two edges split → 3 triangles. Split the shared corner first.
        (Some(p), Some(q), None) => {
            // ab & bc split, shared vertex b.
            out.push([p, b, q]);
            out.push([a, p, q]);
            out.push([a, q, c]);
        }
        (None, Some(q), Some(r)) => {
            // bc & ca split, shared vertex c.
            out.push([q, c, r]);
            out.push([b, q, r]);
            out.push([b, r, a]);
        }
        (Some(p), None, Some(r)) => {
            // ab & ca split, shared vertex a.
            out.push([r, a, p]);
            out.push([c, r, p]);
            out.push([c, p, b]);
        }
        // All three split → 4 triangles (regular subdivision).
        (Some(p), Some(q), Some(r)) => {
            out.push([a, p, r]);
            out.push([p, b, q]);
            out.push([r, q, c]);
            out.push([p, q, r]);
        }
    }
}

/// Vertices incident to each vertex (1-ring), as a set, for link-condition tests.
fn vertex_neighbors(m: &Membrane) -> Vec<ahash::AHashSet<u32>> {
    let mut nb: Vec<ahash::AHashSet<u32>> = vec![ahash::AHashSet::new(); m.vertices.len()];
    for t in &m.triangles {
        let (a, b, c) = (t[0], t[1], t[2]);
        nb[a as usize].insert(b);
        nb[a as usize].insert(c);
        nb[b as usize].insert(a);
        nb[b as usize].insert(c);
        nb[c as usize].insert(a);
        nb[c as usize].insert(b);
    }
    nb
}

/// Faces incident to each vertex.
fn vertex_faces(m: &Membrane) -> Vec<smallvec::SmallVec<[u32; 8]>> {
    let mut vf: Vec<smallvec::SmallVec<[u32; 8]>> = vec![smallvec::SmallVec::new(); m.vertices.len()];
    for (fi, t) in m.triangles.iter().enumerate() {
        for &v in t {
            vf[v as usize].push(fi as u32);
        }
    }
    vf
}

/// Collapse edges shorter than `low`, removing slivers/over-dense regions. Each
/// collapse merges one endpoint into the other; the surviving position is chosen
/// to keep the boundary fixed (if one endpoint is on the boundary, collapse TO
/// it; never collapse a boundary edge or move a boundary vertex). Guarded by the
/// manifold link condition and an inversion/normal-flip check so the mesh stays
/// a valid, non-folded disk. Returns the number of collapses performed.
fn remesh_collapse(m: &mut Membrane, low: f32) -> usize {
    let adj = Adjacency::build(m);
    let neighbors = vertex_neighbors(m);
    let vfaces = vertex_faces(m);

    // Process a snapshot of candidate short edges; apply greedily, skipping any
    // whose endpoints were already touched this pass (keeps it conflict-free).
    let mut candidates: Vec<(f32, EdgeKey)> = Vec::new();
    for &k in adj.edge_faces.keys() {
        if adj.is_boundary_edge(k) {
            continue; // never collapse the seam
        }
        let len = m.vertices[k.0 as usize].sub(m.vertices[k.1 as usize]).length();
        if len < low {
            candidates.push((len, k));
        }
    }
    candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut removed_vert = vec![false; m.vertices.len()];
    let mut removed_face = vec![false; m.triangles.len()];
    let mut touched = vec![false; m.vertices.len()];
    // remap[v] = the vertex v was merged into (chase to resolve).
    let mut remap: Vec<u32> = (0..m.vertices.len() as u32).collect();
    let resolve = |remap: &Vec<u32>, mut v: u32| -> u32 {
        while remap[v as usize] != v {
            v = remap[v as usize];
        }
        v
    };

    let mut collapses = 0usize;
    for (_, (a0, b0)) in candidates {
        let a = resolve(&remap, a0);
        let b = resolve(&remap, b0);
        if a == b || removed_vert[a as usize] || removed_vert[b as usize] {
            continue;
        }
        if touched[a as usize] || touched[b as usize] {
            continue; // keep collapses non-overlapping within a pass
        }

        // Decide the survivor: prefer the boundary endpoint (its position is
        // sacred). If both interior, keep `a` and move it to the midpoint.
        let a_bnd = adj.is_boundary_vert(a);
        let b_bnd = adj.is_boundary_vert(b);
        if a_bnd && b_bnd {
            continue; // collapsing would merge two boundary verts — skip
        }
        let (keep, gone) = if b_bnd { (b, a) } else { (a, b) };
        let new_pos = if a_bnd || b_bnd {
            m.vertices[keep as usize] // boundary survivor stays put
        } else {
            m.vertices[a as usize].add(m.vertices[b as usize]).scale(0.5)
        };

        // Link condition: a & b must share EXACTLY the two opposite vertices of
        // the edge's two faces, else the collapse is non-manifold.
        let shared: Vec<u32> = neighbors[a as usize]
            .intersection(&neighbors[b as usize])
            .copied()
            .collect();
        if shared.len() != 2 {
            continue;
        }

        // Inversion guard: moving `gone`→new_pos must not flip any of gone's or
        // keep's surviving triangles (normal must not reverse, no zero area).
        if collapse_would_invert(m, &vfaces, &removed_face, keep, gone, new_pos, &remap, &resolve) {
            continue;
        }

        // Apply: retire `gone`, point it at `keep`, move `keep` to new_pos, and
        // drop the two faces that used edge (keep,gone).
        m.vertices[keep as usize] = new_pos;
        remap[gone as usize] = keep;
        removed_vert[gone as usize] = true;
        // Lock the ENTIRE neighbourhood of both endpoints for this pass. Adjacency
        // (`neighbors`, `vfaces`) is a start-of-pass snapshot; once we collapse
        // here, any collapse touching a neighbour would use stale topology and can
        // fuse two faces onto one edge (the 4-faces-per-edge bug). Conservative,
        // but the next pass picks up whatever this one deferred.
        touched[a as usize] = true;
        touched[b as usize] = true;
        for &nb in neighbors[a as usize].iter().chain(neighbors[b as usize].iter()) {
            touched[nb as usize] = true;
        }
        for &fi in &vfaces[gone as usize] {
            let t = m.triangles[fi as usize];
            let r = [resolve(&remap, t[0]), resolve(&remap, t[1]), resolve(&remap, t[2])];
            if r[0] == r[1] || r[1] == r[2] || r[2] == r[0] {
                removed_face[fi as usize] = true; // degenerate after merge → drop
            }
        }
        collapses += 1;
    }

    if collapses == 0 {
        return 0;
    }

    // Rebuild triangles with remapped indices, dropping removed/degenerate faces.
    let mut new_tris: Vec<[u32; 3]> = Vec::with_capacity(m.triangles.len());
    for (fi, t) in m.triangles.iter().enumerate() {
        if removed_face[fi] {
            continue;
        }
        let r = [resolve(&remap, t[0]), resolve(&remap, t[1]), resolve(&remap, t[2])];
        if r[0] == r[1] || r[1] == r[2] || r[2] == r[0] {
            continue;
        }
        new_tris.push(r);
    }
    m.triangles = new_tris;
    compact_vertices(m);
    collapses
}

/// Would merging `gone` into `keep` (at `new_pos`) flip or degenerate any of the
/// faces around `gone` that SURVIVE the collapse? Checks the triangle normal sign
/// is preserved and area stays non-trivial.
/// faces around EITHER endpoint that survive the collapse. After the collapse,
/// both `keep` and `gone` map to `keep` positioned at `new_pos`, so faces around
/// either can fold. Checks every such face: normal sign preserved, area non-zero.
#[allow(clippy::too_many_arguments)]
fn collapse_would_invert(
    m: &Membrane,
    vfaces: &[smallvec::SmallVec<[u32; 8]>],
    removed_face: &[bool],
    keep: u32,
    gone: u32,
    new_pos: Vec3,
    remap: &Vec<u32>,
    resolve: &impl Fn(&Vec<u32>, u32) -> u32,
) -> bool {
    // Post-collapse position of any vertex: anything resolving to keep OR equal to
    // gone lands at new_pos; everything else stays put.
    let pos = |v: u32| {
        if v == gone || v == keep || resolve(remap, v) == keep {
            new_pos
        } else {
            m.vertices[v as usize]
        }
    };
    // Inspect faces incident to BOTH endpoints (the moved vertex's full 1-ring).
    for &fi in vfaces[gone as usize].iter().chain(vfaces[keep as usize].iter()) {
        if removed_face[fi as usize] {
            continue;
        }
        let t = m.triangles[fi as usize];
        // Skip the two collapsing faces (those that contain BOTH keep and gone).
        if t.contains(&keep) && t.contains(&gone) {
            continue;
        }
        let before = {
            let a = m.vertices[t[0] as usize];
            let b = m.vertices[t[1] as usize];
            let c = m.vertices[t[2] as usize];
            b.sub(a).cross(c.sub(a))
        };
        let p0 = pos(t[0]);
        let p1 = pos(t[1]);
        let p2 = pos(t[2]);
        let after = p1.sub(p0).cross(p2.sub(p0));
        if after.length() < 1e-9 {
            return true; // would become degenerate
        }
        if before.dot(after) < 0.0 {
            return true; // normal flipped → fold
        }
    }
    false
}

/// Remove vertices no longer referenced by any triangle, remapping indices in the
/// triangle list and the boundary ring.
fn compact_vertices(m: &mut Membrane) {
    let mut used = vec![false; m.vertices.len()];
    for t in &m.triangles {
        for &v in t {
            used[v as usize] = true;
        }
    }
    let mut new_index = vec![u32::MAX; m.vertices.len()];
    let mut new_vertices = Vec::with_capacity(m.vertices.len());
    for (i, &u) in used.iter().enumerate() {
        if u {
            new_index[i] = new_vertices.len() as u32;
            new_vertices.push(m.vertices[i]);
        }
    }
    for t in m.triangles.iter_mut() {
        for v in t.iter_mut() {
            *v = new_index[*v as usize];
        }
    }
    // Boundary verts must all still be used (we never remove boundary verts).
    m.boundary.retain(|&v| new_index[v as usize] != u32::MAX);
    for v in m.boundary.iter_mut() {
        *v = new_index[*v as usize];
    }
    m.vertices = new_vertices;
}

/// Flip interior edges to improve triangle quality. For each interior edge (a,b)
/// shared by faces (a,b,c) and (b,a,d), consider replacing it with (c,d). Flip
/// when it increases the minimum angle of the two triangles (Delaunay-like) AND
/// doesn't fold the surface (normals preserved) AND (c,d) isn't already an edge.
/// Boundary edges are never flipped. Returns the number of flips performed.
fn remesh_flip(m: &mut Membrane) -> usize {
    let adj = Adjacency::build(m);
    let neighbors = vertex_neighbors(m);

    let mut touched_face = vec![false; m.triangles.len()];
    // Guard EVERY vertex of a flipped quad, so no later flip in this pass reuses
    // stale apex geometry and creates a duplicate edge (the 4-faces-per-edge bug).
    let mut touched_vert = vec![false; m.vertices.len()];
    // Live edge set so we never create an edge that already exists (even one made
    // by an earlier flip THIS pass — the snapshot `neighbors` would miss it).
    let mut live_edges: ahash::AHashSet<EdgeKey> =
        adj.edge_faces.keys().copied().collect();
    let mut flips = 0usize;

    // Snapshot interior edges with exactly two faces.
    let interior: Vec<(EdgeKey, u32, u32)> = adj
        .edge_faces
        .iter()
        .filter(|(k, f)| f.len() == 2 && !adj.is_boundary_edge(**k))
        .map(|(&k, f)| (k, f[0], f[1]))
        .collect();

    for (k, f0, f1) in interior {
        if touched_face[f0 as usize] || touched_face[f1 as usize] {
            continue;
        }
        let (a, b) = k;
        // Skip if any quad vertex was already involved in a flip this pass.
        if touched_vert[a as usize] || touched_vert[b as usize] {
            continue;
        }
        let t0 = m.triangles[f0 as usize];
        let t1 = m.triangles[f1 as usize];
        let c = match opposite_vertex(t0, a, b) {
            Some(v) => v,
            None => continue,
        };
        let d = match opposite_vertex(t1, a, b) {
            Some(v) => v,
            None => continue,
        };
        if c == d {
            continue;
        }
        if touched_vert[c as usize] || touched_vert[d as usize] {
            continue;
        }
        // Don't create a duplicate edge (c,d already exists → non-manifold). Use
        // the LIVE set + the snapshot neighbours (belt and braces).
        if live_edges.contains(&ekey(c, d)) || neighbors[c as usize].contains(&d) {
            continue;
        }

        let pa = m.vertices[a as usize];
        let pb = m.vertices[b as usize];
        let pc = m.vertices[c as usize];
        let pd = m.vertices[d as usize];

        // Quality: flip if it raises the minimum angle across the two triangles.
        let min_before = min_angle(pa, pb, pc).min(min_angle(pb, pa, pd));
        let min_after = min_angle(pc, pd, pa).min(min_angle(pd, pc, pb));
        if min_after <= min_before + 1e-4 {
            continue;
        }

        // Fold guard: the new triangles must keep the same orientation as the old
        // pair (no normal reversal). New faces are (c,b,d) and (c,d,a).
        let n_old = pb.sub(pa).cross(pc.sub(pa)); // old face (a,b,c)
        let n_new0 = pb.sub(pc).cross(pd.sub(pc)); // (c,b,d)
        let n_new1 = pd.sub(pc).cross(pa.sub(pc)); // (c,d,a)
        if n_old.dot(n_new0) <= 0.0 || n_old.dot(n_new1) <= 0.0 {
            continue;
        }

        // Apply the flip, preserving winding consistent with the originals.
        // The quad perimeter is a→c→b→d (c opposite ab in f0, d opposite in f1).
        // Replacing diagonal a-b with c-d splits it into (c,b,d) and (c,d,a),
        // both wound the same direction as the originals (verified by fold guard).
        m.triangles[f0 as usize] = [c, b, d];
        m.triangles[f1 as usize] = [c, d, a];
        touched_face[f0 as usize] = true;
        touched_face[f1 as usize] = true;
        touched_vert[a as usize] = true;
        touched_vert[b as usize] = true;
        touched_vert[c as usize] = true;
        touched_vert[d as usize] = true;
        // Update the live edge set: remove the old diagonal, add the new one.
        live_edges.remove(&ekey(a, b));
        live_edges.insert(ekey(c, d));
        flips += 1;
    }

    flips
}

/// Tangential smoothing: slide each interior vertex toward the centroid of its
/// 1-ring, but remove the component along the vertex normal so it stays ON the
/// surface (evens out spacing without flattening the bow). Boundary vertices are
/// pinned. One pass.
fn remesh_tangential_smooth(m: &mut Membrane, strength: f32) {
    let neighbors = one_ring(m);
    let normals = vertex_normals(m);
    let pinned: ahash::AHashSet<u32> = m.boundary.iter().copied().collect();

    let mut updated = m.vertices.clone();
    for v in 0..m.vertices.len() {
        if pinned.contains(&(v as u32)) {
            continue;
        }
        let nbrs = &neighbors[v];
        if nbrs.is_empty() {
            continue;
        }
        let mut sum = Vec3::ZERO;
        for &nb in nbrs {
            sum = sum.add(m.vertices[nb as usize]);
        }
        let centroid = sum.scale(1.0 / nbrs.len() as f32);
        let cur = m.vertices[v];
        let mut delta = centroid.sub(cur);
        // Project OUT the normal component → motion stays tangent to the surface.
        let n = normals[v];
        delta = delta.sub(n.scale(delta.dot(n)));
        updated[v] = cur.add(delta.scale(strength));
    }
    m.vertices = updated;
}

/// Full isotropic-remesh + relaxation driver (Botsch–Kobbelt). Alternates:
/// minimal-surface relaxation, split long edges, collapse short edges, flip for
/// quality, tangential smoothing — converging to a uniform, well-shaped membrane
/// that follows the loop's contour. Replaces the bare `relax` for the real cut.
fn relax_and_remesh(m: &mut Membrane, passes: usize) {
    let target = target_edge_length(m);
    let high = target * 4.0 / 3.0;
    let low = target * 4.0 / 5.0;

    // Safety net: each PASS is guarded as a unit (one clone per pass, not per op).
    // If a pass ends non-manifold, revert it. The ops are correct on their own;
    // this guarantees the invariant survives edge cases without the cost of a
    // clone+validate around every single operation.
    for _ in 0..passes {
        let snapshot = m.clone();
        relax(m, 4, 0.5); // positions only
        remesh_split(m, high);
        remesh_collapse(m, low);
        remesh_flip(m);
        remesh_tangential_smooth(m, 0.5); // positions only
        if !is_manifold_disk(m) {
            *m = snapshot; // a pass went bad → keep the last good state
        }
    }
    // Final relaxation to settle positions after the last topology change.
    relax(m, 8, 0.5);
}

/// Is the membrane a valid triangulated disk: no edge shared by >2 faces, every
/// boundary-ring edge by exactly 1, every other edge by exactly 2? Used as the
/// remesh safety net (revert any op that violates this).
fn is_manifold_disk(m: &Membrane) -> bool {
    let mut counts: ahash::AHashMap<EdgeKey, u32> = ahash::AHashMap::new();
    for t in &m.triangles {
        // Degenerate triangle → invalid.
        if t[0] == t[1] || t[1] == t[2] || t[2] == t[0] {
            return false;
        }
        for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *counts.entry(ekey(a, b)).or_insert(0) += 1;
        }
    }
    let bn = m.boundary.len();
    let boundary: ahash::AHashSet<EdgeKey> =
        (0..bn).map(|i| ekey(m.boundary[i], m.boundary[(i + 1) % bn])).collect();
    for (&e, &c) in &counts {
        if c > 2 {
            return false;
        }
        if boundary.contains(&e) {
            if c != 1 {
                return false;
            }
        } else if c != 2 {
            return false;
        }
    }
    // Every boundary edge must be present.
    boundary.iter().all(|e| counts.contains_key(e))
}

/// Smallest interior angle (radians) of triangle (a,b,c).
fn min_angle(a: Vec3, b: Vec3, c: Vec3) -> f32 {
    let ang = |p: Vec3, q: Vec3, r: Vec3| {
        let u = q.sub(p);
        let v = r.sub(p);
        let lu = u.length();
        let lv = v.length();
        if lu < 1e-12 || lv < 1e-12 {
            return 0.0;
        }
        (u.dot(v) / (lu * lv)).clamp(-1.0, 1.0).acos()
    };
    ang(a, b, c).min(ang(b, a, c)).min(ang(c, a, b))
}

/// Per-vertex area-weighted normals for the membrane (used to offset into a slab).
/// Each triangle contributes its (unnormalized) normal — whose magnitude is 2×
/// area — to its three vertices, so larger triangles weigh more. The result is
/// normalized per vertex. Degenerate vertices get a +Z fallback.
fn vertex_normals(m: &Membrane) -> Vec<Vec3> {
    let mut normals = vec![Vec3::ZERO; m.vertices.len()];
    for t in &m.triangles {
        let a = m.vertices[t[0] as usize];
        let b = m.vertices[t[1] as usize];
        let c = m.vertices[t[2] as usize];
        let face = b.sub(a).cross(c.sub(a)); // magnitude = 2*area
        for &vi in t {
            normals[vi as usize] = normals[vi as usize].add(face);
        }
    }
    for n in normals.iter_mut() {
        let len = n.length();
        *n = if len > 1e-9 { n.scale(1.0 / len) } else { Vec3::new(0.0, 0.0, 1.0) };
    }
    normals
}

/// How far to lift the cutter boundary off the model surface (along the surface
/// normal) so the slab fully clears it. Small + fixed: just enough to guarantee a
/// clean sever; well below print resolution so the mate stays physically zero.
pub const DEFAULT_BOUNDARY_CLEARANCE_MM: f32 = 0.05;

/// The membrane's single area-weighted average normal. Only the slab unit tests
/// use it now (the cut no longer lifts the boundary — the loop is offset off the
/// faces instead), so it's test-only.
#[cfg(test)]
fn membrane_average_normal(m: &Membrane) -> Vec3 {
    let mut avg = Vec3::ZERO;
    for t in &m.triangles {
        let a = m.vertices[t[0] as usize];
        let b = m.vertices[t[1] as usize];
        let c = m.vertices[t[2] as usize];
        avg = avg.add(b.sub(a).cross(c.sub(a)));
    }
    let l = avg.length();
    if l > 1e-9 { avg.scale(1.0 / l) } else { Vec3::new(0.0, 0.0, 1.0) }
}

/// Thicken a membrane into a closed, watertight ~`thickness_mm` slab — the cutter.
///
/// Construction (handoff §4 step 4):
///   - **Top sheet**: each membrane vertex offset `+half` along its normal.
///   - **Bottom sheet**: each membrane vertex offset `-half` along its normal,
///     triangles wound REVERSED so the sheet faces outward (downward).
///   - **Side wall**: a ring of quads (2 tris each) stitching top→bottom around
///     the boundary loop, closing the slab.
///
/// `boundary_clearance_mm` lifts the boundary ring a hair OFF the model surface,
/// each vertex along its own `boundary_normals[i]` (the model's outward surface
/// normal there). This makes the slab fully clear the surface so the difference
/// always severs, WITHOUT the old flat in-plane "overshoot" that lifted unevenly
/// on curved surfaces and left a coarse faceted rim. `boundary_normals` must be
/// one unit normal per boundary vertex, in `m.boundary` order (empty = no lift).
///
/// Returns an `IndexedMesh` ready for `to_manifold`. The side wall is stitched
/// around the membrane's full ordered `boundary` ring (which, after subdivision,
/// densely samples the loop), so the slab is sealed completely.
pub fn thicken_to_slab(
    m: &Membrane,
    thickness_mm: f32,
    boundary_clearance_mm: f32,
    boundary_normals: &[Vec3],
) -> IndexedMesh {
    let half = (thickness_mm.max(1e-4)) * 0.5;
    let n_verts = m.vertices.len();

    // Offset direction: a SINGLE consistent vector (the membrane's average normal),
    // NOT per-vertex normals. Per-vertex normals diverge on a curved surface, so
    // the +offset (top) and -offset (bottom) sheets can cross each other → a
    // self-intersecting slab that manifold rejects as NotManifold (topology is
    // clean but geometry folds). A uniform offset keeps the two sheets parallel
    // and congruent, so they can never intersect, no matter how the membrane bows.
    let mut avg_n = Vec3::ZERO;
    for t in &m.triangles {
        let a = m.vertices[t[0] as usize];
        let b = m.vertices[t[1] as usize];
        let c = m.vertices[t[2] as usize];
        avg_n = avg_n.add(b.sub(a).cross(c.sub(a))); // area-weighted face normal
    }
    let alen = avg_n.length();
    let offset_dir = if alen > 1e-9 { avg_n.scale(1.0 / alen) } else { Vec3::new(0.0, 0.0, 1.0) };

    // Lift each boundary vertex a hair OFF the surface along the model's outward
    // SURFACE normal there. This makes the slab boundary sit just outside the
    // body so the difference fully severs it, while the lift FOLLOWS the surface
    // contour (it's the real surface normal) — so there's no flat in-plane band
    // and no coarse rim left on the parts. Interior membrane vertices are NOT
    // moved (the cut face stays exactly on the smooth membrane).
    let bn_ring = m.boundary.len();
    let mut base = m.vertices.clone();
    if boundary_clearance_mm > 0.0 && boundary_normals.len() == bn_ring {
        for i in 0..bn_ring {
            let b = m.boundary[i] as usize;
            base[b] = m.vertices[b].add(boundary_normals[i].scale(boundary_clearance_mm));
        }
    }

    // Top sheet = base + half*offset_dir ; bottom sheet = base - half*offset_dir.
    // Uniform direction (see above) → the two sheets never cross.
    let up = offset_dir.scale(half);
    let mut positions: Vec<Vec3> = Vec::with_capacity(n_verts * 2);
    for i in 0..n_verts {
        positions.push(base[i].add(up));
    }
    for i in 0..n_verts {
        positions.push(base[i].sub(up));
    }
    let bottom = n_verts as u32; // index offset of the bottom sheet

    let bn = m.boundary.len();
    let mut triangles: Vec<[u32; 3]> = Vec::with_capacity(m.triangles.len() * 2 + bn * 2);
    // Top sheet: same winding as the membrane.
    for t in &m.triangles {
        triangles.push([t[0], t[1], t[2]]);
    }
    // Bottom sheet: reversed winding, shifted to the bottom index range.
    for t in &m.triangles {
        triangles.push([bottom + t[0], bottom + t[2], bottom + t[1]]);
    }
    // Side wall: stitch the boundary ring top→bottom. The wall must traverse each
    // top boundary edge OPPOSITE to how the top sheet traverses it (or the edge is
    // used twice in the same direction → non-manifold). Rather than ASSUME the top
    // sheet goes a→b (it depends on the membrane's global winding, which the
    // orientation flood-fill leaves arbitrary), DETECT the top sheet's direction
    // per edge and wind the wall accordingly. This makes the slab valid regardless
    // of the membrane's facing.
    let mut top_dir: ahash::AHashSet<(u32, u32)> = ahash::AHashSet::new();
    for t in &m.triangles {
        top_dir.insert((t[0], t[1]));
        top_dir.insert((t[1], t[2]));
        top_dir.insert((t[2], t[0]));
    }
    for i in 0..bn {
        let a = m.boundary[i];
        let b = m.boundary[(i + 1) % bn];
        let a2 = bottom + a;
        let b2 = bottom + b;
        // If the top sheet traverses this boundary edge a→b, the wall traverses
        // b→a (quad b,a,a2,b2). If the top sheet goes b→a, mirror it (a,b,b2,a2).
        if top_dir.contains(&(a, b)) {
            triangles.push([b, a, a2]);
            triangles.push([b, a2, b2]);
        } else {
            triangles.push([a, b, b2]);
            triangles.push([a, b2, a2]);
        }
    }

    IndexedMesh { positions, triangles }
}

/// An axis-aligned thin slab (box) used as the simplest possible cutter while we
/// validate the split crux. `lo`/`hi` are opposite corners; the box is closed
/// and watertight, wound outward. This is a *stand-in* for the real thickened
/// membrane — same role (a watertight wafer), trivial geometry.
///
/// Returned as an `IndexedMesh` so it goes through the exact same
/// `from_mesh_f32` path the real cutter will.
pub fn axis_aligned_slab(lo: Vec3, hi: Vec3) -> IndexedMesh {
    // 8 corners of the box.
    let c = [
        Vec3::new(lo.x, lo.y, lo.z), // 0
        Vec3::new(hi.x, lo.y, lo.z), // 1
        Vec3::new(hi.x, hi.y, lo.z), // 2
        Vec3::new(lo.x, hi.y, lo.z), // 3
        Vec3::new(lo.x, lo.y, hi.z), // 4
        Vec3::new(hi.x, lo.y, hi.z), // 5
        Vec3::new(hi.x, hi.y, hi.z), // 6
        Vec3::new(lo.x, hi.y, hi.z), // 7
    ];
    // 12 triangles (two per face), wound counter-clockwise when viewed from
    // OUTSIDE (outward-facing normals) — same winding convention as the cube in
    // organic_cut.rs's tests so manifold accepts it.
    let faces: [[usize; 3]; 12] = [
        [0, 2, 1],
        [0, 3, 2], // z = lo
        [4, 5, 6],
        [4, 6, 7], // z = hi
        [0, 1, 5],
        [0, 5, 4], // y = lo
        [3, 7, 6],
        [3, 6, 2], // y = hi
        [0, 4, 7],
        [0, 7, 3], // x = lo
        [1, 2, 6],
        [1, 6, 5], // x = hi
    ];
    let positions = c.to_vec();
    let triangles = faces.iter().map(|f| [f[0] as u32, f[1] as u32, f[2] as u32]).collect();
    IndexedMesh { positions, triangles }
}

/// Build a `manifold` solid from an `IndexedMesh` (xyz only). Mirrors the exact
/// conversion `organic_cut_plane` uses, so behavior is identical to the live cut.
pub fn to_manifold(mesh: &IndexedMesh) -> Result<manifold_csg::Manifold, String> {
    let positions: Vec<f32> = mesh.positions.iter().flat_map(|v| [v.x, v.y, v.z]).collect();
    let indices: Vec<u32> = mesh.triangles.iter().flat_map(|t| *t).collect();
    let m = manifold_csg::Manifold::from_mesh_f32(&positions, 3, &indices).map_err(|e| {
        // Enrich the error so we can SEE the defect on the real model: how many
        // edges aren't shared by exactly 2 faces (open boundary / non-manifold
        // junction), how many duplicate directed edges (winding flip), etc.
        let (open, nonmanifold, degenerate) = mesh_edge_defects(mesh);
        format!(
            "manifold rejected mesh: {e:?} (tris={}, openEdges={open}, \
             nonManifoldEdges={nonmanifold}, degenerateTris={degenerate})",
            mesh.triangles.len()
        )
    })?;
    if m.is_empty() || m.num_tri() == 0 {
        return Err("mesh produced an empty manifold (non-watertight?)".to_string());
    }
    Ok(m)
}

/// Count pairs of triangles that intersect but DON'T share a vertex (true self-
/// intersections / folds). Brute force O(n²) with an AABB pre-filter — fine for a
/// diagnostic on a ~2k-tri membrane. A clean surface returns 0.
fn count_self_intersections(mesh: &IndexedMesh) -> usize {
    let tris = &mesh.triangles;
    let n = tris.len();
    // Per-triangle AABB for cheap rejection.
    let aabb: Vec<(Vec3, Vec3)> = tris
        .iter()
        .map(|t| {
            let a = mesh.positions[t[0] as usize];
            let b = mesh.positions[t[1] as usize];
            let c = mesh.positions[t[2] as usize];
            (a.min(b).min(c), a.max(b).max(c))
        })
        .collect();
    let shares_vertex = |t0: &[u32; 3], t1: &[u32; 3]| t0.iter().any(|v| t1.contains(v));
    let mut count = 0usize;
    for i in 0..n {
        let (lo_i, hi_i) = aabb[i];
        for j in (i + 1)..n {
            let (lo_j, hi_j) = aabb[j];
            // AABB overlap test.
            if hi_i.x < lo_j.x || lo_i.x > hi_j.x
                || hi_i.y < lo_j.y || lo_i.y > hi_j.y
                || hi_i.z < lo_j.z || lo_i.z > hi_j.z
            {
                continue;
            }
            if shares_vertex(&tris[i], &tris[j]) {
                continue;
            }
            let ta = [
                mesh.positions[tris[i][0] as usize],
                mesh.positions[tris[i][1] as usize],
                mesh.positions[tris[i][2] as usize],
            ];
            let tb = [
                mesh.positions[tris[j][0] as usize],
                mesh.positions[tris[j][1] as usize],
                mesh.positions[tris[j][2] as usize],
            ];
            if tris_intersect(ta, tb) {
                count += 1;
            }
        }
    }
    count
}

/// Möller triangle-triangle intersection test (do two triangles overlap in 3D?).
fn tris_intersect(t1: [Vec3; 3], t2: [Vec3; 3]) -> bool {
    // Plane of t2.
    let n2 = t2[1].sub(t2[0]).cross(t2[2].sub(t2[0]));
    let d2 = -n2.dot(t2[0]);
    let dist1: [f32; 3] = [
        n2.dot(t1[0]) + d2,
        n2.dot(t1[1]) + d2,
        n2.dot(t1[2]) + d2,
    ];
    const EPS: f32 = 1e-6;
    if dist1[0].abs() < EPS && dist1[1].abs() < EPS && dist1[2].abs() < EPS {
        return false; // coplanar — ignore (shared seams etc.)
    }
    if (dist1[0] > EPS && dist1[1] > EPS && dist1[2] > EPS)
        || (dist1[0] < -EPS && dist1[1] < -EPS && dist1[2] < -EPS)
    {
        return false; // t1 entirely on one side of t2's plane
    }
    // Plane of t1.
    let n1 = t1[1].sub(t1[0]).cross(t1[2].sub(t1[0]));
    let d1 = -n1.dot(t1[0]);
    let dist2: [f32; 3] = [
        n1.dot(t2[0]) + d1,
        n1.dot(t2[1]) + d1,
        n1.dot(t2[2]) + d1,
    ];
    if (dist2[0] > EPS && dist2[1] > EPS && dist2[2] > EPS)
        || (dist2[0] < -EPS && dist2[1] < -EPS && dist2[2] < -EPS)
    {
        return false;
    }
    // Both straddle each other's planes → compute the intersection intervals on
    // the line L = plane1 ∩ plane2 and test overlap.
    let dir = n1.cross(n2);
    let axis = {
        let (ax, ay, az) = (dir.x.abs(), dir.y.abs(), dir.z.abs());
        if ax >= ay && ax >= az { 0 } else if ay >= az { 1 } else { 2 }
    };
    let proj = |p: Vec3| match axis {
        0 => p.x,
        1 => p.y,
        _ => p.z,
    };
    let interval = |t: [Vec3; 3], dist: [f32; 3]| -> Option<(f32, f32)> {
        // Vertices on opposite sides; find the two edge crossings.
        let mut pts = Vec::new();
        for (a, b) in [(0usize, 1usize), (1, 2), (2, 0)] {
            if (dist[a] > 0.0) != (dist[b] > 0.0) {
                let s = dist[a] / (dist[a] - dist[b]);
                let p = t[a].add(t[b].sub(t[a]).scale(s));
                pts.push(proj(p));
            }
        }
        if pts.len() < 2 {
            return None;
        }
        Some((pts[0].min(pts[1]), pts[0].max(pts[1])))
    };
    match (interval(t1, dist1), interval(t2, dist2)) {
        (Some((lo1, hi1)), Some((lo2, hi2))) => lo1 <= hi2 && lo2 <= hi1,
        _ => false,
    }
}

/// Diagnose why a mesh might be rejected: returns (open edges used by exactly 1
/// face, non-manifold edges used by >2 faces, degenerate triangles). For a closed
/// orientable manifold all three are 0.
fn mesh_edge_defects(mesh: &IndexedMesh) -> (usize, usize, usize) {
    let mut counts: ahash::AHashMap<(u32, u32), u32> = ahash::AHashMap::new();
    let mut degenerate = 0;
    for t in &mesh.triangles {
        if t[0] == t[1] || t[1] == t[2] || t[2] == t[0] {
            degenerate += 1;
            continue;
        }
        for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let k = if a < b { (a, b) } else { (b, a) };
            *counts.entry(k).or_insert(0) += 1;
        }
    }
    let open = counts.values().filter(|&&c| c == 1).count();
    let nonmanifold = counts.values().filter(|&&c| c > 2).count();
    (open, nonmanifold, degenerate)
}

/// Split a model solid by a thin watertight cutter and return the raw connected
/// components (the islands the difference produced).
///
/// We `difference` the thin wafer from the model (removing a razor-thin slot),
/// then `decompose` into connected components. A simple convex body gives 2; a
/// real organic model with concavities/thin features can give MORE (the cut
/// crosses the body in several disjoint places → several islands per side).
/// Grouping those islands back into two parts is the caller's job — see
/// [`split_into_two_sides`].
pub fn split_by_cutter(
    model: &manifold_csg::Manifold,
    cutter: &manifold_csg::Manifold,
) -> Vec<IndexedMesh> {
    let remaining = model.difference(cutter);
    let mut parts: Vec<IndexedMesh> = remaining
        .decompose()
        .iter()
        .filter_map(manifold_to_indexed)
        .filter(|m| !m.triangles.is_empty())
        .collect();
    // Largest component first (deterministic ordering).
    parts.sort_by(|a, b| b.triangles.len().cmp(&a.triangles.len()));
    parts
}

/// Decompose a mesh into its connected components (the disjoint solids it
/// contains), largest first. Returns `[mesh]` when it has a single component or the
/// manifold conversion fails — so the caller always gets at least the input back.
/// Used by the multi-loop cut to split the merged "everything but the body" mesh
/// back into one part per freed piece.
pub fn decompose_components(mesh: &IndexedMesh) -> Vec<IndexedMesh> {
    if mesh.triangles.is_empty() {
        return Vec::new();
    }
    match to_manifold(mesh) {
        Ok(m) => {
            let mut parts: Vec<IndexedMesh> = m
                .decompose()
                .iter()
                .filter_map(manifold_to_indexed)
                .filter(|p| !p.triangles.is_empty())
                .collect();
            if parts.is_empty() {
                return vec![mesh.clone()];
            }
            parts.sort_by(|a, b| b.triangles.len().cmp(&a.triangles.len()));
            parts
        }
        Err(_) => vec![mesh.clone()],
    }
}

/// Signed distance from `p` to the membrane surface: positive on the membrane's
/// +normal side, negative on the −normal side. Found by the nearest membrane
/// triangle, signing by that triangle's geometric normal. This is how we decide
/// which SIDE of the cut a severed island belongs to — robust to a membrane that
/// bows, unlike a single average plane.
fn signed_side_distance(m: &Membrane, p: Vec3) -> f32 {
    let mut best_d2 = f32::INFINITY;
    let mut best_signed = 0.0f32;
    for t in &m.triangles {
        let a = m.vertices[t[0] as usize];
        let b = m.vertices[t[1] as usize];
        let c = m.vertices[t[2] as usize];
        let (cp, d2) = closest_on_tri(p, a, b, c);
        if d2 < best_d2 {
            best_d2 = d2;
            // Sign by the triangle normal (consistent winding across the patch).
            let n = b.sub(a).cross(c.sub(a));
            let nlen = n.length();
            let dir = p.sub(cp);
            best_signed = if nlen > 1e-12 { dir.dot(n.scale(1.0 / nlen)) } else { dir.length() };
        }
    }
    best_signed
}

/// Closest point on triangle (a,b,c) to p, returning (point, squared distance).
/// Ericson's barycentric region test (same family as geodesic::closest_point_on_tri).
fn closest_on_tri(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> (Vec3, f32) {
    let ab = b.sub(a);
    let ac = c.sub(a);
    let ap = p.sub(a);
    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return (a, p.sub(a).dot(p.sub(a)));
    }
    let bp = p.sub(b);
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return (b, p.sub(b).dot(p.sub(b)));
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        let q = a.add(ab.scale(v));
        return (q, p.sub(q).dot(p.sub(q)));
    }
    let cp = p.sub(c);
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return (c, p.sub(c).dot(p.sub(c)));
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        let q = a.add(ac.scale(w));
        return (q, p.sub(q).dot(p.sub(q)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        let q = b.add(c.sub(b).scale(w));
        return (q, p.sub(q).dot(p.sub(q)));
    }
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    let q = a.add(ab.scale(v)).add(ac.scale(w));
    (q, p.sub(q).dot(p.sub(q)))
}

/// Centroid of a mesh's vertices (cheap proxy for "where is this island").
fn mesh_centroid(mesh: &IndexedMesh) -> Vec3 {
    if mesh.positions.is_empty() {
        return Vec3::ZERO;
    }
    let mut sum = Vec3::ZERO;
    for &p in &mesh.positions {
        sum = sum.add(p);
    }
    sum.scale(1.0 / mesh.positions.len() as f32)
}

/// Group the severed islands into exactly two parts by which SIDE of the membrane
/// each island sits on (+normal side → A, −normal side → B). Islands on the same
/// side are concatenated into one `IndexedMesh`. Returns `None` if, after
/// grouping, either side is empty (the cut didn't actually separate the body).
///
/// This is what makes the contour cut work on real organic models, where a single
/// seam can carve the body into many islands per side (the dragon's base gave 3-4
/// components — top + bottom + slivers — which this collapses to a clean 2).
fn split_into_two_sides(membrane: &Membrane, islands: Vec<IndexedMesh>) -> Option<(IndexedMesh, IndexedMesh)> {
    let mut side_a: Vec<IndexedMesh> = Vec::new();
    let mut side_b: Vec<IndexedMesh> = Vec::new();
    for island in islands {
        let c = mesh_centroid(&island);
        if signed_side_distance(membrane, c) >= 0.0 {
            side_a.push(island);
        } else {
            side_b.push(island);
        }
    }
    if side_a.is_empty() || side_b.is_empty() {
        return None;
    }
    Some((concat_meshes(side_a), concat_meshes(side_b)))
}

/// Concatenate several meshes into one (offsetting triangle indices). The pieces
/// stay disjoint islands within a single `IndexedMesh` — fine for a scene part.
fn concat_meshes(meshes: Vec<IndexedMesh>) -> IndexedMesh {
    let mut positions: Vec<Vec3> = Vec::new();
    let mut triangles: Vec<[u32; 3]> = Vec::new();
    for m in meshes {
        let base = positions.len() as u32;
        positions.extend_from_slice(&m.positions);
        for t in &m.triangles {
            triangles.push([t[0] + base, t[1] + base, t[2] + base]);
        }
    }
    IndexedMesh { positions, triangles }
}


/// Band half-width for [`refine_model_near_slab`], as a fraction of the model
/// bbox diagonal — how far from the cutter slab a model triangle must be to get
/// subdivided. Wide enough to catch every triangle the cut crosses.
pub const DEFAULT_REFINE_BAND_FRACTION: f32 = 0.02;

/// Target edge length for refined band triangles, as a fraction of the model bbox
/// diagonal. Band edges are split until below this (or the level cap). Smaller =
/// smoother cut edge, more triangles.
pub const DEFAULT_REFINE_TARGET_FRACTION: f32 = 0.006;

/// Max subdivision levels [`refine_model_near_slab`] applies — a hard cap so a
/// coarse model near a small cut can't explode the triangle count.
pub const DEFAULT_REFINE_MAX_LEVELS: u32 = 4;

/// Subdivide the model's triangles in a thin band around the cutter SLAB, BEFORE
/// the boolean, so the boolean has fine model triangles to clip → a smoother cut
/// edge (less of the coarse low-poly ridge along the seam).
///
/// This is pure conforming 1→4 midpoint subdivision: an edge is split iff BOTH
/// endpoints lie within `band` of the slab AND it is longer than `target`. The
/// midpoint of each split edge is created ONCE in a map keyed by the undirected
/// edge, so every triangle sharing that edge uses the SAME midpoint — the result
/// is watertight by construction (no T-junctions, no cross-mesh stitching, so it
/// cannot break the manifold boolean the way conforming-to-the-cutter would).
/// Only band triangles change; the rest of the model is returned verbatim.
pub fn refine_model_near_slab(
    mesh: &IndexedMesh,
    slab: &IndexedMesh,
    band: f32,
    target: f32,
    max_levels: u32,
) -> IndexedMesh {
    if mesh.triangles.is_empty() || slab.positions.is_empty() || max_levels == 0 {
        return mesh.clone();
    }
    let band = band.max(1e-5);
    let target = target.max(1e-5);
    let band_sq = band * band;

    // Spatial hash of the slab vertices (cell = band) for an O(1) "is this point
    // within `band` of the slab?" test. The slab densely samples exactly where the
    // cut crosses the surface, so proximity to a slab vertex ≈ "the cut passes
    // near here".
    let inv_cell = 1.0 / band;
    let mut grid: ahash::AHashMap<(i32, i32, i32), smallvec::SmallVec<[Vec3; 4]>> =
        ahash::AHashMap::new();
    for &p in &slab.positions {
        let key = (
            (p.x * inv_cell).floor() as i32,
            (p.y * inv_cell).floor() as i32,
            (p.z * inv_cell).floor() as i32,
        );
        grid.entry(key).or_default().push(p);
    }
    let near_slab = |p: Vec3| -> bool {
        let (cx, cy, cz) = (
            (p.x * inv_cell).floor() as i32,
            (p.y * inv_cell).floor() as i32,
            (p.z * inv_cell).floor() as i32,
        );
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(bucket) = grid.get(&(cx + dx, cy + dy, cz + dz)) {
                        for &q in bucket {
                            if p.sub(q).dot(p.sub(q)) <= band_sq {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        false
    };

    let mut positions = mesh.positions.clone();
    let mut triangles = mesh.triangles.clone();

    for _level in 0..max_levels {
        // Split set: undirected edge → its (single, shared) midpoint vertex index.
        // The split decision is a property of the EDGE alone (its midpoint near the
        // slab + length), so every triangle sharing the edge makes the same call —
        // that's what keeps the result watertight. We test the MIDPOINT (not the
        // endpoints): a big model triangle can straddle the cut with both corners
        // far away, so endpoint-proximity would miss it — the midpoint lands on the
        // seam, which is exactly where we want the resolution.
        let mut mid_of: ahash::AHashMap<(u32, u32), u32> = ahash::AHashMap::new();
        for t in &triangles {
            for &(u, v) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                let k = if u < v { (u, v) } else { (v, u) };
                if mid_of.contains_key(&k) {
                    continue;
                }
                let pu = positions[u as usize];
                let pv = positions[v as usize];
                let len = pu.sub(pv).length();
                if len <= target {
                    continue;
                }
                let mp = pu.add(pv).scale(0.5);
                if !near_slab(mp) {
                    continue; // edge doesn't pass near the cut → leave it
                }
                let idx = positions.len() as u32;
                positions.push(mp);
                mid_of.insert(k, idx);
            }
        }
        if mid_of.is_empty() {
            break;
        }

        // Rebuild every triangle by how many of its edges were split (adaptive
        // 1→2/3/4, conforming — shared split edges use the SAME midpoint).
        let old = std::mem::take(&mut triangles);
        let mut next: Vec<[u32; 3]> = Vec::with_capacity(old.len() * 2);
        for t in old {
            let (a, b, c) = (t[0], t[1], t[2]);
            let key = |x: u32, y: u32| if x < y { (x, y) } else { (y, x) };
            let mab = mid_of.get(&key(a, b)).copied();
            let mbc = mid_of.get(&key(b, c)).copied();
            let mca = mid_of.get(&key(c, a)).copied();
            emit_split_triangle(&mut next, a, b, c, mab, mbc, mca);
        }
        triangles = next;
    }

    IndexedMesh { positions, triangles }
}

/// The result of a successful contour split: two parts that mate along the
/// curved seam, plus diagnostics.
pub struct ContourSplit {
    pub part_a: IndexedMesh,
    pub part_b: IndexedMesh,
    /// Number of connected components `decompose` produced (2 on success).
    pub component_count: usize,
    /// Membrane triangle count (for diagnostics / reporting).
    pub membrane_tris: usize,
    /// The RAW seam membrane (before boundary-widening), kept so the registration
    /// key can derive its placement frame from it (centroid anchor, average-normal
    /// axis, cross-section area). `part_a` is on this membrane's +normal side.
    pub membrane: Membrane,
}

/// How far the cut loop sits OFF the model's faces, in mm. Each loop point is
/// moved this far along the model's outward surface normal there, so the membrane
/// built on the loop sits just outside the body and the cut runs clean to the
/// edge. One fixed distance — the only offset in the contour cut.
pub const DEFAULT_LOOP_OFFSET_MM: f32 = 0.1;

/// Number of ring-smoothing passes applied to the offset directions. Enough to
/// take the jaggedness out of low-poly per-vertex normals without flattening the
/// overall outward direction.
const OFFSET_DIR_SMOOTH_PASSES: u32 = 12;

/// Move each loop point `offset_mm` OFF the model's faces, along the model's
/// outward surface normal there. The per-point surface normals are first SMOOTHED
/// around the loop ring (Laplacian average with ring neighbours), because on a
/// low-poly model the raw nearest-triangle normals jump wildly between adjacent
/// loop points — offsetting along those raw directions shoots neighbouring points
/// in scattered directions and makes a JAGGED, spiky boundary ring (and the
/// membrane boundary is pinned, so relaxation can never smooth it out). Smoothing
/// the directions first gives a smooth offset ring → a smooth membrane.
///
/// Returns the offset loop in the same order; an empty/degenerate model returns
/// the loop unchanged.
///
/// Currently UNUSED: the cut builds the membrane on the raw seam loop so the
/// wafer's top edge sits on the on-surface seam line. Kept (with its tests) in
/// case a real model needs the off-surface offset back for robust severance.
#[allow(dead_code)]
fn offset_loop_off_faces(model: &IndexedMesh, loop_pts: &[Vec3], offset_mm: f32) -> Vec<Vec3> {
    if loop_pts.is_empty() || model.triangles.is_empty() || offset_mm <= 0.0 {
        return loop_pts.to_vec();
    }
    let bvh = Bvh::build(model);
    let diag = model.bbox().diag().max(1e-3);
    let base_r = (diag * 0.01).max(1e-4);

    // 1. Raw outward surface normal at each loop point (nearest model triangle's
    //    face normal). Fallback to +Z where nothing is found.
    let mut normals: Vec<Vec3> = loop_pts
        .iter()
        .map(|&p| {
            let mut best_d2 = f32::INFINITY;
            let mut normal = Vec3::new(0.0, 0.0, 1.0);
            let mut r = base_r;
            for _ in 0..4 {
                let query = Aabb {
                    min: Vec3::new(p.x - r, p.y - r, p.z - r),
                    max: Vec3::new(p.x + r, p.y + r, p.z + r),
                };
                let mut found = false;
                bvh.query_aabb(&query, |face| {
                    let [a, b, c] = model.tri_positions(face);
                    let (_, d2) = closest_on_tri(p, a, b, c);
                    if d2 < best_d2 {
                        best_d2 = d2;
                        let nrm = b.sub(a).cross(c.sub(a));
                        let nl = nrm.length();
                        if nl > 1e-12 {
                            normal = nrm.scale(1.0 / nl);
                        }
                    }
                    found = true;
                });
                if found {
                    break;
                }
                r *= 3.0;
            }
            normal
        })
        .collect();

    // 2. Smooth the directions around the loop ring so neighbours vary gently
    //    (kills the low-poly zigzag that makes a spiky boundary). Each pass:
    //    n[i] ← normalize(n[i-1] + 2·n[i] + n[i+1]) cyclically.
    let n = normals.len();
    if n >= 3 {
        for _ in 0..OFFSET_DIR_SMOOTH_PASSES {
            let mut next = normals.clone();
            for i in 0..n {
                let prev = normals[(i + n - 1) % n];
                let here = normals[i];
                let nxt = normals[(i + 1) % n];
                let avg = prev.add(here.scale(2.0)).add(nxt);
                let len = avg.length();
                next[i] = if len > 1e-9 { avg.scale(1.0 / len) } else { here };
            }
            normals = next;
        }
    }

    // 3. Offset each loop point along its smoothed direction.
    loop_pts
        .iter()
        .zip(normals.iter())
        .map(|(&p, &nrm)| p.add(nrm.scale(offset_mm)))
        .collect()
}

/// How much WIDER than the seam the wafer's footprint is, in mm. The membrane's
/// boundary ring is pushed outward (in the local membrane plane) by this — so the
/// wafer is `0.1 mm` wider than the model's cross-section (poking just past the
/// body wall so the cut severs cleanly), while the rim stays at the SAME height,
/// on the seam line. Wider, not taller.
pub const DEFAULT_WAFER_WIDEN_MM: f32 = 0.1;

/// Push the membrane's BOUNDARY ring outward by `amount` mm so the wafer is
/// `amount` wider than the model's cross-section — without lifting it (the rim
/// stays at the same height, on the seam). Operates on a membrane already built on
/// the RAW seam loop, so the input can't self-intersect; we only nudge its rim.
///
/// The outward direction at each boundary vertex is computed from LOCAL 3D
/// geometry (NOT a global best-fit plane, which flattens a bent loop and tangles
/// at concave/folded spots — the self-intersection bug): take the direction from
/// the vertex's INTERIOR neighbours toward the vertex (points away from the
/// membrane body), then remove the component along the local boundary tangent so
/// it's purely outward in the local surface. Directions are smoothed around the
/// ring so low-poly zigzag doesn't roughen the rim. Because each direction is
/// local, a bent loop can't fold — the widened membrane stays a valid mesh.
fn widen_membrane_boundary(m: &mut Membrane, amount: f32) {
    let bn = m.boundary.len();
    if bn < 3 || amount <= 0.0 {
        return;
    }
    let neighbours = one_ring(m);
    let is_boundary = {
        let mut s = vec![false; m.vertices.len()];
        for &b in &m.boundary {
            s[b as usize] = true;
        }
        s
    };

    // 1. Per-boundary-vertex outward direction (local, in 3D).
    let mut dirs: Vec<Vec3> = Vec::with_capacity(bn);
    for i in 0..bn {
        let b = m.boundary[i] as usize;
        let p = m.vertices[b];
        let prev = m.vertices[m.boundary[(i + bn - 1) % bn] as usize];
        let next = m.vertices[m.boundary[(i + 1) % bn] as usize];
        // Local boundary tangent.
        let mut t = next.sub(prev);
        let tl = t.length();
        if tl > 1e-9 {
            t = t.scale(1.0 / tl);
        }
        // Average of interior (non-boundary) neighbours → the membrane body side.
        let mut interior_avg = Vec3::ZERO;
        let mut count = 0u32;
        for &nb in &neighbours[b] {
            if !is_boundary[nb as usize] {
                interior_avg = interior_avg.add(m.vertices[nb as usize]);
                count += 1;
            }
        }
        // Gross outward = from interior toward the boundary vertex.
        let mut out = if count > 0 {
            p.sub(interior_avg.scale(1.0 / count as f32))
        } else {
            // No interior neighbour (tiny membrane): use the boundary normal proxy
            // perpendicular to the tangent via the prev→next chord midpoint.
            p.sub(prev.add(next).scale(0.5))
        };
        // Remove the tangent component → purely outward, in the local surface.
        out = out.sub(t.scale(out.dot(t)));
        let ol = out.length();
        dirs.push(if ol > 1e-9 { out.scale(1.0 / ol) } else { Vec3::ZERO });
    }

    // 2. Smooth the directions around the ring (kills low-poly zigzag).
    for _ in 0..6 {
        let mut next = dirs.clone();
        for i in 0..bn {
            let prev = dirs[(i + bn - 1) % bn];
            let here = dirs[i];
            let nxt = dirs[(i + 1) % bn];
            let avg = prev.add(here.scale(2.0)).add(nxt);
            let l = avg.length();
            next[i] = if l > 1e-9 { avg.scale(1.0 / l) } else { here };
        }
        dirs = next;
    }

    // 3. Push each boundary vertex outward by `amount`.
    for i in 0..bn {
        let b = m.boundary[i] as usize;
        m.vertices[b] = m.vertices[b].add(dirs[i].scale(amount));
    }
}

/// Build the contour-cut CUTTER (membrane + thickened slab) from the model and
/// loop, EXACTLY as the cut does — the single source of truth shared by
/// [`contour_split`] (the real cut) and [`build_cutter_preview_soup`] (the live
/// preview), so what the user sees is precisely what cuts: the loop offset off
/// the faces, the membrane built on it, thickened to the real `thickness_mm`.
///
/// Returns `(membrane, slab)`. `density` is the already-clamped resolution
/// multiplier. `Err` if the membrane can't be built from the loop.
fn build_contour_cutter(
    _mesh: &IndexedMesh,
    loop_pts: &[Vec3],
    thickness_mm: f32,
    membrane_smoothing: f32,
    density: f64,
) -> Result<(Membrane, IndexedMesh), String> {
    let grid_divisions = DEFAULT_GRID_DIVISIONS * density;
    // Build the membrane on the RAW seam loop (boundary exactly on the line — the
    // source of truth, and a raw loop can't self-intersect), THEN push only its
    // boundary ring 0.1 mm outward so the wafer is 0.1 mm wider than the body's
    // cross-section (poking just past the wall → clean sever) without lifting it:
    // the rim stays at the same height, on the seam. (`_mesh` unused now.)
    let mut membrane = build_membrane_full(loop_pts, CONTOUR_SUBDIVISIONS, membrane_smoothing, grid_divisions)
        .ok_or_else(|| format!("could not build a membrane from the loop ({} points)", loop_pts.len()))?;
    widen_membrane_boundary(&mut membrane, DEFAULT_WAFER_WIDEN_MM);
    let slab = thicken_to_slab(&membrane, thickness_mm, 0.0, &[]);
    Ok((membrane, slab))
}

/// Build the REAL cutter slab the contour cut would use and return it as a flat
/// triangle soup (9 f32 per triangle, model-local) for previewing in the scene.
/// Unlike the bare-membrane preview, this reflects the loop OFFSET (the slab sits
/// off the surface) AND the THICKNESS (it's a closed slab, not a sheet) — so the
/// preview shows exactly what cuts. `None` if the membrane can't be built.
pub fn build_cutter_preview_soup(
    mesh: &IndexedMesh,
    loop_pts: &[Vec3],
    thickness_mm: f32,
    membrane_smoothing: f32,
    density: f32,
) -> Option<Vec<f32>> {
    let density = density.clamp(1.0, 4.0) as f64;
    let (_, slab) = build_contour_cutter(mesh, loop_pts, thickness_mm, membrane_smoothing, density).ok()?;
    // Flatten the slab triangles into a soup.
    let mut soup = Vec::with_capacity(slab.triangles.len() * 9);
    for t in &slab.triangles {
        for &vi in t {
            let v = slab.positions[vi as usize];
            soup.extend_from_slice(&[v.x, v.y, v.z]);
        }
    }
    Some(soup)
}

/// End-to-end contour cut: build a soap-film membrane spanning `loop_pts`,
/// thicken it into a razor-thin cutter, and split `mesh` into two mating parts.
///
/// This is the single entry point `organic_cut` calls for a contour cut. It owns
/// all the membrane parameters (derived from the model's size) so callers only
/// pass the loop + thickness.
///
/// Returns `Err` (so the caller can fall back to the plane cut) when:
///   - the loop is degenerate (< 3 distinct points),
///   - `manifold` rejects the model or the cutter,
///   - the cut produced fewer than 2 islands, or all islands ended up on ONE
///     side of the membrane (the wafer didn't actually separate the body — e.g.
///     the loop didn't wrap all the way through it).
pub fn contour_split(
    mesh: &IndexedMesh,
    loop_pts: &[Vec3],
    thickness_mm: f32,
    membrane_smoothing: f32,
    density: f32,
) -> Result<ContourSplit, String> {
    let density = density.clamp(1.0, 4.0) as f64;

    // Build the cutter slab EXACTLY as the preview does (single source of truth):
    // offset the loop off the faces → membrane → thicken into the slab.
    let (membrane, slab) = build_contour_cutter(mesh, loop_pts, thickness_mm, membrane_smoothing, density)?;
    let membrane_tris = membrane.triangles.len();

    let cutter = to_manifold(&slab).map_err(|e| {
        let mem_mesh = IndexedMesh {
            positions: membrane.vertices.clone(),
            triangles: membrane.triangles.clone(),
        };
        format!(
            "cutter slab invalid: {e} | membraneSelfX={} slabSelfX={} memTris={}",
            count_self_intersections(&mem_mesh),
            count_self_intersections(&slab),
            membrane.triangles.len()
        )
    })?;

    // Subdivide the model's triangles in a band around the cutter slab BEFORE the
    // boolean, so the cut crosses fine triangles → a smoother cut edge instead of
    // the coarse low-poly ridge. Pure conforming subdivision (watertight by
    // construction), so it never breaks the boolean. Cut Resolution (`density`)
    // drives the target: higher density → smaller target edge + an extra level.
    let diag = mesh.bbox().diag().max(1e-3);
    let band = diag * DEFAULT_REFINE_BAND_FRACTION;
    let target = diag * DEFAULT_REFINE_TARGET_FRACTION / density as f32;
    let max_levels = DEFAULT_REFINE_MAX_LEVELS + (density.round() as u32).saturating_sub(1);
    let refined = refine_model_near_slab(mesh, &slab, band, target, max_levels);
    let model = to_manifold(&refined).map_err(|e| format!("model invalid: {e}"))?;

    let islands = split_by_cutter(&model, &cutter);
    let component_count = islands.len();
    if component_count < 2 {
        return Err(format!(
            "contour cutter did not sever the model (got {component_count} component) — \
             the loop likely didn't wrap all the way through the body"
        ));
    }
    let (part_a, part_b) = split_into_two_sides(&membrane, islands).ok_or_else(|| {
        format!(
            "contour cut produced {component_count} islands but they all fell on ONE side of \
             the membrane (the loop didn't pass through the body)"
        )
    })?;

    Ok(ContourSplit { part_a, part_b, component_count, membrane_tris, membrane })
}

/// The result of a MULTI-loop contour split (≥2 loops union'd into one cutter).
/// Unlike [`ContourSplit`] there is no single membrane — each loop has its own,
/// returned in `membranes` so the caller can place one registration key per seam.
pub struct ContourSplitMulti {
    /// The largest connected component left after the cut — the main body.
    pub part_a: IndexedMesh,
    /// Everything else (the freed piece(s)) concatenated into one mesh.
    pub part_b: IndexedMesh,
    /// How many connected components `decompose` produced (≥2 on success).
    pub component_count: usize,
    /// Total membrane triangle count across all loops (for diagnostics).
    pub membrane_tris: usize,
    /// The per-loop membranes (one per valid loop), in loop order. Kept so the
    /// caller can place a registration key at EACH seam (one key per cut).
    pub membranes: Vec<Membrane>,
}

/// Signed side of a whole mesh relative to the membrane: positive if the mesh's
/// centroid sits on the membrane's +normal side, negative otherwise. The
/// multi-loop key code uses this to pass the +normal-side part as `part_a` to
/// `apply_key` (the side convention the single-loop cut keeps by construction).
pub fn side_of_mesh(membrane: &Membrane, mesh: &IndexedMesh) -> f32 {
    signed_side_distance(membrane, mesh_centroid(mesh))
}

/// Contour cut along SEVERAL loops in ONE operation. Builds a cutter slab per
/// loop and differences them from the model one at a time, then decomposes into
/// connected components.
///
/// This frees a body that connects in several places — e.g. a tail joined to the
/// body at two posts, or both arms on opposite sides. Each loop wraps only solid,
/// so every membrane is simple and valid, and the per-slab differences carve all
/// the bridges. (Differencing slab-by-slab, rather than subtracting their union,
/// avoids the boolean backend collapsing a union of thin far-apart slabs to
/// nothing — which left the model unsevered.)
///
/// The components are grouped largest-vs-rest (see [`group_largest_vs_rest`]):
/// `part_a` is the biggest piece (the body), `part_b` is everything else (the
/// freed piece(s)). Returns `Err` when fewer than two loops are valid, a cutter is
/// invalid, or the cut leaves a single component (a loop didn't wrap through).
pub fn contour_split_multi(
    mesh: &IndexedMesh,
    loops: &[Vec<Vec3>],
    thickness_mm: f32,
    membrane_smoothing: f32,
    density: f32,
) -> Result<ContourSplitMulti, String> {
    let density = density.clamp(1.0, 4.0) as f64;

    // Build a cutter slab per loop. Keep each as its OWN manifold (we difference
    // them from the model one at a time below) plus a concatenated soup for the
    // seam-band refinement. We deliberately do NOT union the slabs into a single
    // cutter: union'ing thin, far-apart slabs (e.g. arms on opposite sides of the
    // body) can collapse to a degenerate/empty manifold in the boolean backend,
    // and differencing that severs nothing. `A − B − C` is equivalent to
    // `A − (B ∪ C)` but avoids that fragile union entirely.
    let mut slab_manifolds: Vec<manifold_csg::Manifold> = Vec::new();
    let mut combined_slab = IndexedMesh { positions: Vec::new(), triangles: Vec::new() };
    let mut membranes: Vec<Membrane> = Vec::new();
    let mut membrane_tris = 0usize;
    for (i, lp) in loops.iter().enumerate() {
        if lp.len() < 3 {
            continue;
        }
        let (membrane, slab) =
            build_contour_cutter(mesh, lp, thickness_mm, membrane_smoothing, density)
                .map_err(|e| format!("loop {i} cutter failed: {e}"))?;
        membrane_tris += membrane.triangles.len();
        let m = to_manifold(&slab).map_err(|e| format!("loop {i} slab invalid: {e}"))?;

        let base = combined_slab.positions.len() as u32;
        combined_slab.positions.extend_from_slice(&slab.positions);
        for t in &slab.triangles {
            combined_slab.triangles.push([t[0] + base, t[1] + base, t[2] + base]);
        }

        slab_manifolds.push(m);
        membranes.push(membrane);
    }
    if slab_manifolds.len() < 2 {
        return Err(format!(
            "multi-loop cut needs >=2 valid loops (got {})",
            slab_manifolds.len()
        ));
    }

    // Refine the model near the COMBINED slabs before the booleans (smoother cut
    // edges), exactly as the single-loop path does around its one slab.
    let diag = mesh.bbox().diag().max(1e-3);
    let band = diag * DEFAULT_REFINE_BAND_FRACTION;
    let target = diag * DEFAULT_REFINE_TARGET_FRACTION / density as f32;
    let max_levels = DEFAULT_REFINE_MAX_LEVELS + (density.round() as u32).saturating_sub(1);
    let refined = refine_model_near_slab(mesh, &combined_slab, band, target, max_levels);

    // Difference each slab from the model in turn, then decompose into the freed
    // solids. Each difference carves one loop's kerf; the model accumulates them.
    let mut cut_model = to_manifold(&refined).map_err(|e| format!("model invalid: {e}"))?;
    for sm in &slab_manifolds {
        cut_model = cut_model.difference(sm);
    }
    let mut islands: Vec<IndexedMesh> = cut_model
        .decompose()
        .iter()
        .filter_map(manifold_to_indexed)
        .filter(|m| !m.triangles.is_empty())
        .collect();
    islands.sort_by(|a, b| b.triangles.len().cmp(&a.triangles.len()));

    let component_count = islands.len();
    if component_count < 2 {
        return Err(format!(
            "multi-loop cutter did not sever the model (got {component_count} component) — \
             at least one loop must wrap all the way through the material it encircles"
        ));
    }
    let (part_a, part_b) = group_largest_vs_rest(islands)
        .ok_or_else(|| "multi-loop cut produced only one usable component".to_string())?;

    Ok(ContourSplitMulti { part_a, part_b, component_count, membrane_tris, membranes })
}

/// Group severed islands into two parts: the LARGEST component (the body) as
/// `part_a`, and ALL the others concatenated (the freed piece(s)) as `part_b`.
/// Used by the multi-loop cut, where there's no single membrane normal to classify
/// sides by. [`split_by_cutter`] already returns islands sorted largest-first, so
/// `part_a` is the body and `part_b` is the tail (plus any tiny kerf slivers, which
/// ride along with the freed piece). Returns `None` if fewer than two components.
fn group_largest_vs_rest(islands: Vec<IndexedMesh>) -> Option<(IndexedMesh, IndexedMesh)> {
    if islands.len() < 2 {
        return None;
    }
    let mut it = islands.into_iter();
    let largest = it.next()?; // sorted largest-first by split_by_cutter
    let rest: Vec<IndexedMesh> = it.collect();
    Some((largest, concat_meshes(rest)))
}

/// Convert a `manifold` solid back to an `IndexedMesh`. Returns `None` only on a
/// malformed/empty conversion (matches `organic_cut.rs::manifold_to_indexed`).
/// `pub(crate)` so the key module can convert its boolean results back too.
pub(crate) fn manifold_to_indexed(model: &manifold_csg::Manifold) -> Option<IndexedMesh> {
    if model.is_empty() || model.num_tri() == 0 {
        return None;
    }
    let (vp, np, ti) = model.to_mesh_f32();
    if np < 3 || ti.is_empty() || vp.is_empty() {
        return None;
    }
    let positions: Vec<Vec3> = vp.chunks_exact(np).map(|c| Vec3::new(c[0], c[1], c[2])).collect();
    let triangles: Vec<[u32; 3]> = ti.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    Some(IndexedMesh { positions, triangles })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Axis-aligned cube [0,size]^3 as an `IndexedMesh` (12 tris), wound outward.
    fn cube(size: f32) -> IndexedMesh {
        axis_aligned_slab(Vec3::ZERO, Vec3::new(size, size, size))
    }

    /// A DENSE loop around a `size`-cube's equator at z=`size`/2 — `steps` points
    /// per side, wrapping the four vertical faces. This is how a real cut loop
    /// looks (many surface points), unlike a 4-corner loop sitting on hard edges
    /// (which is degenerate for the surface-normal offset).
    fn dense_equator_loop(size: f32, steps: usize) -> Vec<Vec3> {
        let z = size / 2.0;
        let mut pts = Vec::with_capacity(steps * 4);
        let f = |i: usize| size * i as f32 / steps as f32;
        for i in 0..steps { pts.push(Vec3::new(f(i), 0.0, z)); }       // y=0
        for i in 0..steps { pts.push(Vec3::new(size, f(i), z)); }      // x=size
        for i in 0..steps { pts.push(Vec3::new(size - f(i), size, z)); } // y=size
        for i in 0..steps { pts.push(Vec3::new(0.0, size - f(i), z)); } // x=0
        pts
    }

    /// A flat square loop (4 points) in the z=0 plane, side `s`, ordered CCW.
    fn square_loop(s: f32) -> Vec<Vec3> {
        vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(s, 0.0, 0.0),
            Vec3::new(s, s, 0.0),
            Vec3::new(0.0, s, 0.0),
        ]
    }

    /// A NON-planar "tent" loop: a square whose two opposite corners are lifted
    /// in +z and the other two dropped in -z, so no plane contains it. A minimal
    /// surface spanning it must bow (saddle), not lie flat — the property that
    /// distinguishes a soap-film from a flat fill.
    fn saddle_loop(s: f32, h: f32) -> Vec<Vec3> {
        vec![
            Vec3::new(0.0, 0.0, h),
            Vec3::new(s, 0.0, -h),
            Vec3::new(s, s, h),
            Vec3::new(0.0, s, -h),
        ]
    }

    fn bbox(pts: &[Vec3]) -> (Vec3, Vec3) {
        let mut lo = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut hi = Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
        for &p in pts {
            lo = lo.min(p);
            hi = hi.max(p);
        }
        (lo, hi)
    }

    /// Validate that a membrane is a consistent triangulated disk: every interior
    /// edge is shared by exactly 2 faces, every boundary-ring edge by exactly 1,
    /// and there are no stray edges with >2 faces or 0. Returns Ok or a message.
    fn check_membrane_valid(m: &Membrane) -> Result<(), String> {
        use std::collections::HashMap;
        let mut counts: HashMap<(u32, u32), u32> = HashMap::new();
        for t in &m.triangles {
            for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *counts.entry(ekey(a, b)).or_insert(0) += 1;
            }
        }
        let boundary: std::collections::HashSet<(u32, u32)> = {
            let bn = m.boundary.len();
            (0..bn).map(|i| ekey(m.boundary[i], m.boundary[(i + 1) % bn])).collect()
        };
        for (&e, &c) in &counts {
            if c > 2 {
                return Err(format!("edge {e:?} shared by {c} faces (non-manifold)"));
            }
            let is_b = boundary.contains(&e);
            if is_b && c != 1 {
                return Err(format!("boundary edge {e:?} has {c} faces (expected 1)"));
            }
            if !is_b && c != 2 {
                return Err(format!("interior edge {e:?} has {c} faces (expected 2)"));
            }
        }
        // Every boundary edge must actually appear as a triangle edge.
        for e in &boundary {
            if !counts.contains_key(e) {
                return Err(format!("boundary edge {e:?} missing from triangles"));
            }
        }
        Ok(())
    }

    #[test]
    fn remesh_split_densifies_and_keeps_validity() {
        // Start from a coarse fan (edges ~7-10 long), split with a small target,
        // and assert the result is a valid manifold disk with more, shorter
        // triangles and the boundary intact.
        let mut m = seed_fan(&square_loop(10.0)).expect("seed");
        check_membrane_valid(&m).expect("seed should be valid");
        let tris_before = m.triangles.len();
        // Force splits: anything over 3 units long (the seed has none that short).
        let splits = remesh_split(&mut m, 3.0);
        assert!(splits > 0, "long edges should have been split");
        assert!(m.triangles.len() > tris_before, "triangle count should grow");
        check_membrane_valid(&m).expect("post-split mesh must stay a valid disk");
        // Boundary vertices are still all at z=0 (on the loop).
        for &b in &m.boundary {
            assert!(m.vertices[b as usize].z.abs() < 1e-5, "boundary left the loop plane");
        }
    }

    #[test]
    fn target_edge_length_matches_boundary_spacing() {
        // The target should equal the average boundary edge length (isotropic).
        // Test the helper directly on a fan+subdivided mesh (build_membrane now
        // uses the grid seed; target_edge_length belongs to the parked remesh).
        let mut m = seed_fan(&square_loop(12.0)).expect("seed");
        for _ in 0..2 {
            subdivide(&mut m);
        }
        let t = target_edge_length(&m);
        // Boundary ring after 2 subdivisions samples each side into 4 → spacing 3.
        assert!((t - 3.0).abs() < 0.5, "target {t} should be ~3 (12/4 per side)");
    }

    #[test]
    fn remesh_split_is_conforming_no_tjunctions() {
        // After splitting, no edge may be shared by >2 faces (T-junctions would
        // show up as that). check_membrane_valid covers it; assert on a saddle too.
        let mut m = build_membrane(&saddle_loop(10.0, 4.0), 1).expect("membrane");
        let target = target_edge_length(&m);
        remesh_split(&mut m, target * 4.0 / 3.0);
        check_membrane_valid(&m).expect("split saddle membrane must be conforming");
    }

    #[test]
    fn remesh_collapse_removes_short_edges_keeps_validity() {
        // Over-subdivide to create many short interior edges, then collapse with a
        // generous threshold. The mesh must stay a valid disk, lose triangles, and
        // keep its boundary unmoved.
        let mut m = build_membrane(&square_loop(10.0), 3).expect("membrane");
        check_membrane_valid(&m).expect("pre-collapse valid");
        let tris_before = m.triangles.len();
        let boundary_before: Vec<Vec3> =
            m.boundary.iter().map(|&b| m.vertices[b as usize]).collect();

        // Collapse anything shorter than a large target so many edges qualify.
        let low = target_edge_length(&m) * 1.5;
        let collapses = remesh_collapse(&mut m, low);
        assert!(collapses > 0, "short edges should have been collapsed");
        assert!(m.triangles.len() < tris_before, "triangle count should drop");
        check_membrane_valid(&m).expect("post-collapse mesh must stay a valid disk");

        // Boundary loop unchanged: every original boundary position still present.
        let boundary_after: std::collections::HashSet<[i32; 3]> = m
            .boundary
            .iter()
            .map(|&b| {
                let v = m.vertices[b as usize];
                [(v.x * 1e3) as i32, (v.y * 1e3) as i32, (v.z * 1e3) as i32]
            })
            .collect();
        for v in boundary_before {
            let key = [(v.x * 1e3) as i32, (v.y * 1e3) as i32, (v.z * 1e3) as i32];
            assert!(boundary_after.contains(&key), "a boundary vertex moved/was lost");
        }
    }

    #[test]
    fn relax_and_remesh_produces_valid_flat_membrane() {
        // The full driver on a FLAT loop must produce a valid disk with no folds
        // (every triangle normal points the same way). Isolates which op folds.
        let mut m = seed_fan(&square_loop(10.0)).expect("seed");
        for _ in 0..2 {
            subdivide(&mut m);
        }
        relax_and_remesh(&mut m, 10);
        check_membrane_valid(&m).expect("driver output must be a valid disk");
        // Flat loop in z=0 → all triangles should keep n.z of one sign.
        let mut pos = 0;
        let mut neg = 0;
        for t in &m.triangles {
            let a = m.vertices[t[0] as usize];
            let b = m.vertices[t[1] as usize];
            let c = m.vertices[t[2] as usize];
            let nz = b.sub(a).cross(c.sub(a)).z;
            if nz > 1e-5 {
                pos += 1;
            } else if nz < -1e-5 {
                neg += 1;
            }
        }
        assert!(pos == 0 || neg == 0, "membrane has folded triangles: {pos} up, {neg} down");
    }

    #[test]
    fn remesh_flip_improves_quality_keeps_validity() {
        // The fan seed (subdivided) has skinny pinwheel triangles near the apex.
        // Flipping should raise the overall minimum angle without breaking the mesh.
        let mut m = build_membrane(&square_loop(10.0), 2).expect("membrane");
        check_membrane_valid(&m).expect("pre-flip valid");

        let worst = |mm: &Membrane| -> f32 {
            mm.triangles
                .iter()
                .map(|t| {
                    min_angle(
                        mm.vertices[t[0] as usize],
                        mm.vertices[t[1] as usize],
                        mm.vertices[t[2] as usize],
                    )
                })
                .fold(f32::INFINITY, f32::min)
        };
        let worst_before = worst(&m);
        let flips = remesh_flip(&mut m);
        check_membrane_valid(&m).expect("post-flip mesh must stay a valid disk");
        if flips > 0 {
            assert!(
                worst(&m) >= worst_before - 1e-4,
                "flipping should not worsen the minimum angle ({} < {})",
                worst(&m),
                worst_before
            );
        }
    }

    #[test]
    fn remesh_collapse_does_not_invert_triangles() {
        // After collapsing, every triangle must keep a consistent (upward) normal
        // for a flat membrane — no folds introduced. Start from a SEED + subdivide
        // (not full build_membrane, which already remeshes) to isolate collapse.
        let mut m = seed_fan(&square_loop(10.0)).expect("seed");
        for _ in 0..3 {
            subdivide(&mut m);
        }
        let low = target_edge_length(&m) * 1.5;
        remesh_collapse(&mut m, low);
        for t in &m.triangles {
            let a = m.vertices[t[0] as usize];
            let b = m.vertices[t[1] as usize];
            let c = m.vertices[t[2] as usize];
            let n = b.sub(a).cross(c.sub(a));
            assert!(n.z > -1e-4, "triangle inverted after collapse (n.z={})", n.z);
        }
    }

    #[test]
    fn seed_spans_the_loop_with_pinned_boundary() {
        // Tests the SEED directly (build_membrane now remeshes, changing counts).
        let loop_pts = square_loop(10.0);
        let m = seed_fan(&loop_pts).expect("seed");
        // First N vertices are exactly the loop points (boundary ring 0..4).
        assert_eq!(m.boundary, vec![0, 1, 2, 3]);
        for i in 0..4 {
            assert!(m.vertices[i].sub(loop_pts[i]).length() < 1e-5, "boundary {i} moved");
        }
        // A seed (no subdivisions) is a fan: 4 triangles, 1 interior apex.
        assert_eq!(m.triangles.len(), 4);
        assert_eq!(m.vertices.len(), 5);
    }

    #[test]
    fn subdivision_grows_interior_and_boundary_keeps_loop() {
        // Tests subdivide() on the seed directly (build_membrane now remeshes).
        let loop_pts = square_loop(10.0);
        let m0 = seed_fan(&loop_pts).expect("m0");
        let mut m2 = seed_fan(&loop_pts).expect("m2");
        for _ in 0..2 {
            subdivide(&mut m2);
        }
        // Each subdivision quadruples triangle count.
        assert_eq!(m2.triangles.len(), m0.triangles.len() * 4 * 4);
        // The boundary RING densifies: each subdivision doubles it (each edge
        // gains a midpoint). 4 → 8 → 16 after two rounds.
        assert_eq!(m2.boundary.len(), 16, "boundary ring should densify to 16");
        // Every boundary vertex stays ON the original loop edges (z=0 here).
        for &b in &m2.boundary {
            assert!(m2.vertices[b as usize].z.abs() < 1e-5, "boundary left the loop plane");
        }
        // Many more interior vertices now.
        assert!(m2.vertices.len() > 20, "expected a dense interior, got {}", m2.vertices.len());
    }

    #[test]
    fn build_membrane_survives_a_dense_wiggly_nonplanar_loop() {
        // Mimics the real dragon loop: many points (like the dense geodesic),
        // uneven spacing, and out-of-plane wiggle. This is the case that made the
        // live preview vanish — the remesh must NOT panic and must return a valid
        // membrane.
        let n = 120;
        let mut loop_pts = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f32 / n as f32 * std::f32::consts::TAU;
            // Lumpy radius + vertical wiggle → non-planar, irregular like a real seam.
            let r = 30.0 + 6.0 * (3.0 * t).sin() + 3.0 * (7.0 * t).cos();
            let x = r * t.cos();
            let y = r * t.sin();
            let z = 4.0 * (2.0 * t).sin() + 2.0 * (5.0 * t).cos();
            loop_pts.push(Vec3::new(x, y, z));
        }
        let m = build_membrane(&loop_pts, 2).expect("dense wiggly membrane should build");
        check_membrane_valid(&m).expect("dense membrane must be a valid disk");
        assert!(m.triangles.len() > 10, "membrane should have real triangles");
        for v in &m.vertices {
            assert!(v.finite(), "non-finite vertex in dense membrane");
        }
    }

    #[test]
    fn build_membrane_remeshes_to_uniform_quality() {
        // The full build (seed → remesh) should yield a valid disk whose triangles
        // are reasonably uniform — the whole point of the remesh. Check the worst
        // angle is far better than the fan seed's slivers.
        let m = build_membrane(&square_loop(10.0), 2).expect("membrane");
        check_membrane_valid(&m).expect("built membrane must be a valid disk");
        let worst = m
            .triangles
            .iter()
            .map(|t| {
                min_angle(
                    m.vertices[t[0] as usize],
                    m.vertices[t[1] as usize],
                    m.vertices[t[2] as usize],
                )
            })
            .fold(f32::INFINITY, f32::min);
        // A fan seed has slivers near 0°; after remesh the worst angle should be
        // meaningfully positive (well above ~5°).
        assert!(worst > 0.08, "worst angle {worst} rad too small — remesh didn't improve quality");
    }

    /// Worst (smallest) triangle angle in radians, over the whole membrane.
    fn worst_angle(m: &Membrane) -> f32 {
        m.triangles
            .iter()
            .map(|t| {
                min_angle(
                    m.vertices[t[0] as usize],
                    m.vertices[t[1] as usize],
                    m.vertices[t[2] as usize],
                )
            })
            .fold(f32::INFINITY, f32::min)
    }

    #[test]
    fn grid_seed_makes_a_clean_uniform_disk() {
        // The grid seed must be a valid disk, with the loop as its exact boundary,
        // many interior vertices, and NO fan slivers (worst angle well above the
        // fan's ~0°).
        let loop_pts = square_loop(20.0);
        let m = seed_grid(&loop_pts, DEFAULT_GRID_DIVISIONS).expect("grid seed should build");
        check_membrane_valid(&m).expect("grid seed must be a valid disk");

        // Boundary ring is the DENSIFIED loop (more points than the 4 corners),
        // and every boundary vertex lies on the z=0 plane of the square loop.
        assert!(m.boundary.len() >= loop_pts.len(), "boundary should densify");
        for &b in &m.boundary {
            assert!(m.vertices[b as usize].z.abs() < 1e-4, "boundary left the loop plane");
        }
        // The 4 original corners are all present on the boundary.
        for &corner in &loop_pts {
            let found = m
                .boundary
                .iter()
                .any(|&b| m.vertices[b as usize].sub(corner).length() < 1e-4);
            assert!(found, "corner {corner:?} missing from densified boundary");
        }
        // Real interior grid (not a single apex).
        assert!(m.vertices.len() > m.boundary.len() + 8, "grid should add many interior pts");
        // No slivers: worst angle should be comfortably positive (> ~10°).
        let w = worst_angle(&m);
        assert!(w > 0.15, "grid worst angle {w} rad too small (slivers present)");
    }

    #[test]
    fn grid_seed_beats_the_fan_on_an_irregular_loop() {
        // On an IRREGULAR loop the centroid fan makes long thin slivers (apex far
        // from a stretched edge); the grid stays uniform. Use a tall thin
        // rectangle where the fan apex is far from the short edges.
        let loop_pts = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(40.0, 0.0, 0.0),
            Vec3::new(40.0, 4.0, 0.0),
            Vec3::new(0.0, 4.0, 0.0),
        ];
        let fan = seed_fan(&loop_pts).expect("fan");
        let grid = seed_grid(&loop_pts, DEFAULT_GRID_DIVISIONS).expect("grid");
        // The fan of a 40×4 rectangle has very thin triangles (worst angle small);
        // the grid should be far better.
        assert!(
            worst_angle(&grid) > worst_angle(&fan),
            "grid ({}) should beat fan ({}) on a stretched loop",
            worst_angle(&grid),
            worst_angle(&fan),
        );
        // And the grid's worst angle should be a usable value, not a sliver.
        assert!(worst_angle(&grid) > 0.1, "grid worst {} too small", worst_angle(&grid));
    }

    #[test]
    fn build_membrane_uses_grid_and_is_clean() {
        // The full build (grid seed + relax) must be a valid disk with good angles.
        let m = build_membrane(&square_loop(20.0), 2).expect("membrane");
        check_membrane_valid(&m).expect("built membrane must be valid");
        assert!(worst_angle(&m) > 0.1, "built membrane still has slivers");
    }

    /// Count edges traversed in the SAME direction by two triangles (inconsistent
    /// winding). 0 ⇒ the whole patch is consistently wound.
    fn inconsistent_winding_edges(m: &Membrane) -> usize {
        use std::collections::HashMap;
        let mut dir: HashMap<(u32, u32), u32> = HashMap::new();
        for t in &m.triangles {
            for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *dir.entry((a, b)).or_insert(0) += 1;
            }
        }
        // For each undirected edge, both directions should appear once (opposite
        // winding). A directed edge appearing twice = two tris wound the same way.
        dir.values().filter(|&&c| c > 1).count()
    }

    #[test]
    fn membrane_winding_is_consistent_after_orient() {
        // The orientation flood-fill must leave EVERY interior edge with opposite
        // winding between its two triangles (the condition manifold needs). This
        // was the dragon failure: clean topology + no self-X but mixed winding.
        for loop_pts in [square_loop(20.0), saddle_loop(20.0, 6.0)] {
            let m = build_membrane(&loop_pts, 2).expect("membrane");
            assert_eq!(
                inconsistent_winding_edges(&m),
                0,
                "membrane has inconsistent winding after orient"
            );
        }
    }

    #[test]
    fn grid_seed_handles_a_nonplanar_loop() {
        // A saddle loop (no plane contains it) must still triangulate cleanly via
        // the best-fit-plane projection, then relax bows it.
        let loop_pts = saddle_loop(20.0, 6.0);
        let m = seed_grid(&loop_pts, DEFAULT_GRID_DIVISIONS).expect("grid seed on saddle");
        check_membrane_valid(&m).expect("saddle grid must be valid");
        for v in &m.vertices {
            assert!(v.finite(), "non-finite vertex in saddle grid");
        }
    }

    #[test]
    fn relaxation_decreases_area_and_pins_boundary() {
        let loop_pts = square_loop(10.0);
        // Build an UNRELAXED reference at the same subdivision to compare area.
        let mut unrelaxed = seed_fan(&dedupe_loop(&loop_pts)).expect("seed");
        for _ in 0..3 {
            subdivide(&mut unrelaxed);
        }
        let area_before = unrelaxed.area();

        let mut relaxed = unrelaxed.clone();
        relax(&mut relaxed, 60, 0.5);
        let area_after = relaxed.area();

        assert!(
            area_after <= area_before + 1e-3,
            "relaxation should not increase area ({area_after} > {area_before})"
        );
        // Every boundary-ring vertex still pinned (unchanged from unrelaxed).
        for &b in &relaxed.boundary {
            assert!(
                relaxed.vertices[b as usize].sub(unrelaxed.vertices[b as usize]).length() < 1e-5,
                "boundary {b} moved during relax"
            );
        }
    }

    #[test]
    fn membrane_spans_a_nonplanar_saddle_loop_and_stays_bounded() {
        // The real test: a loop no plane contains. The membrane must span it and
        // stay within the loop's bounding box (a minimal surface over a loop
        // never bulges beyond the convex hull of its boundary in any axis).
        let loop_pts = saddle_loop(10.0, 4.0);
        let m = build_membrane(&loop_pts, 3).expect("saddle membrane");
        let (lo, hi) = bbox(&loop_pts);

        // Every vertex (incl. relaxed interior) stays within the loop bbox + eps.
        const EPS: f32 = 1e-3;
        for (i, v) in m.vertices.iter().enumerate() {
            assert!(
                v.x >= lo.x - EPS && v.x <= hi.x + EPS
                    && v.y >= lo.y - EPS && v.y <= hi.y + EPS
                    && v.z >= lo.z - EPS && v.z <= hi.z + EPS,
                "vertex {i} {v:?} escaped loop bbox [{lo:?},{hi:?}]"
            );
        }

        // The interior must actually use the z range (the loop spans z=-4..4); a
        // flat fill stuck at z=0 would NOT — prove the membrane bows. Check that
        // some INTERIOR vertex (not on the boundary ring) has |z| well above 0.
        let boundary: std::collections::HashSet<u32> = m.boundary.iter().copied().collect();
        let interior_max_z = (0..m.vertices.len() as u32)
            .filter(|v| !boundary.contains(v))
            .map(|v| m.vertices[v as usize].z.abs())
            .fold(0.0f32, f32::max);
        assert!(
            interior_max_z > 0.5,
            "interior should bow with the saddle (max |z| = {interior_max_z}), not lie flat"
        );

        // All vertices finite (no NaN blow-up from relaxation).
        for v in &m.vertices {
            assert!(v.finite(), "non-finite membrane vertex {v:?}");
        }
    }

    /// Count, for an indexed mesh, how many undirected edges are NOT shared by
    /// exactly 2 triangles. 0 ⇒ closed (every edge has two incident faces).
    fn open_edge_count(mesh: &IndexedMesh) -> usize {
        use std::collections::HashMap;
        let mut counts: HashMap<(u32, u32), u32> = HashMap::new();
        for t in &mesh.triangles {
            let edges = [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])];
            for (a, b) in edges {
                let key = if a < b { (a, b) } else { (b, a) };
                *counts.entry(key).or_insert(0) += 1;
            }
        }
        counts.values().filter(|&&c| c != 2).count()
    }

    /// Uniform boundary normals (= the membrane's average normal) for tests that
    /// thicken a slab without a model mesh to pull surface normals from.
    fn uniform_boundary_normals(m: &Membrane) -> Vec<Vec3> {
        let n = membrane_average_normal(m);
        vec![n; m.boundary.len()]
    }

    #[test]
    fn thickened_slab_is_closed_and_manifold_accepts_it() {
        // Flat loop first: thicken → must be a closed watertight solid.
        let loop_pts = square_loop(10.0);
        let m = build_membrane(&loop_pts, 3).expect("membrane");
        let slab = thicken_to_slab(&m, DEFAULT_CUTTER_THICKNESS_MM, DEFAULT_BOUNDARY_CLEARANCE_MM, &uniform_boundary_normals(&m));

        assert_eq!(open_edge_count(&slab), 0, "thickened slab must be closed (no open edges)");
        let solid = to_manifold(&slab).expect("manifold should accept the thickened slab");
        assert!(solid.volume() > 0.0, "slab should enclose positive volume");
    }

    #[test]
    fn thickened_grid_slab_on_a_dense_wiggly_loop_is_valid() {
        // Reproduce the dragon failure: a dense, irregular, NON-PLANAR loop (like
        // the real geodesic). The grid membrane is clean, but its thickened slab
        // must ALSO be watertight + manifold-acceptable, or the contour cut falls
        // back to the plane (which is what happened: NotManifold on tris=2576).
        // NON-CONVEX loop with a deep concave notch (like the dragon's tail bay)
        // + vertical wiggle. The concavity is the key: the radial boundary
        // overshoot and the grid both behave differently on concave polygons.
        let n = 120;
        let mut loop_pts = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f32 / n as f32 * std::f32::consts::TAU;
            // Deep inward dent over part of the loop → genuine concavity.
            let dent = if (t - 1.0).abs() < 0.9 { -18.0 * (1.0 - ((t - 1.0) / 0.9).abs()) } else { 0.0 };
            let r = 30.0 + dent + 4.0 * (3.0 * t).sin();
            let x = r * t.cos();
            let y = r * t.sin();
            let z = 5.0 * (2.0 * t).sin();
            loop_pts.push(Vec3::new(x, y, z));
        }
        let m = build_membrane(&loop_pts, 2).expect("grid membrane");
        check_membrane_valid(&m).expect("membrane itself must be valid");
        // The membrane must not self-intersect (a fold would make the slab invalid).
        let m_mesh = IndexedMesh { positions: m.vertices.clone(), triangles: m.triangles.clone() };
        assert_eq!(count_self_intersections(&m_mesh), 0, "membrane self-intersects");

        let slab = thicken_to_slab(&m, DEFAULT_CUTTER_THICKNESS_MM, DEFAULT_BOUNDARY_CLEARANCE_MM, &uniform_boundary_normals(&m));
        assert_eq!(open_edge_count(&slab), 0, "grid slab not watertight");
        assert!(to_manifold(&slab).is_ok(), "manifold rejected the grid slab");
    }

    #[test]
    fn thickened_saddle_slab_is_closed_and_manifold_accepts_it() {
        // The harder case: a non-planar membrane. Its thickening must STILL be a
        // valid watertight cutter (this is what feeds the real contour split).
        let loop_pts = saddle_loop(10.0, 4.0);
        let m = build_membrane(&loop_pts, 3).expect("saddle membrane");
        let slab = thicken_to_slab(&m, DEFAULT_CUTTER_THICKNESS_MM, DEFAULT_BOUNDARY_CLEARANCE_MM, &uniform_boundary_normals(&m));

        assert_eq!(open_edge_count(&slab), 0, "saddle slab must be closed");
        let solid = to_manifold(&slab).expect("manifold should accept the saddle slab");
        assert!(solid.volume() > 0.0, "saddle slab should enclose positive volume");
        assert!(solid.num_tri() > 0);
    }

    #[test]
    fn boundary_clearance_lifts_along_the_surface_normal() {
        // The clearance must lift each boundary vertex along its given surface
        // normal by the clearance amount (so the slab clears the surface), and
        // leave it put when clearance is 0.
        let loop_pts = square_loop(10.0);
        let m = build_membrane(&loop_pts, 1).expect("membrane");
        // Flat loop in z=0 → surface normal is +Z.
        let normals = vec![Vec3::new(0.0, 0.0, 1.0); m.boundary.len()];

        let no_lift = thicken_to_slab(&m, DEFAULT_CUTTER_THICKNESS_MM, 0.0, &normals);
        let lifted = thicken_to_slab(&m, DEFAULT_CUTTER_THICKNESS_MM, 0.5, &normals);

        // A boundary vertex's TOP-sheet position rises by clearance along +Z.
        // (Top sheet = base + half*offset_dir; both slabs share the same offset,
        // so the delta between them is exactly the clearance lift.)
        let b0 = m.boundary[0] as usize;
        let dz = lifted.positions[b0].z - no_lift.positions[b0].z;
        assert!((dz - 0.5).abs() < 1e-4, "boundary should lift 0.5 along +Z, got {dz}");

        // The lifted slab is still a valid watertight cutter.
        assert_eq!(open_edge_count(&lifted), 0, "lifted slab must stay closed");
        assert!(to_manifold(&lifted).is_ok(), "manifold must accept the lifted slab");
    }

    #[test]
    fn degenerate_loop_returns_none() {
        assert!(build_membrane(&[], 2).is_none());
        assert!(build_membrane(&[Vec3::ZERO, Vec3::new(1.0, 0.0, 0.0)], 2).is_none());
        // Three points but two coincident → only 2 distinct → None.
        let dup = vec![Vec3::ZERO, Vec3::ZERO, Vec3::new(1.0, 0.0, 0.0)];
        assert!(build_membrane(&dup, 2).is_none());
    }

    #[test]
    fn slab_is_watertight_and_manifold_accepts_it() {
        // A thin slab on its own must be a valid watertight solid, or it can
        // never be a cutter. This is the M4b precondition, proven on the box.
        let slab = axis_aligned_slab(Vec3::new(-1.0, -1.0, 4.99), Vec3::new(11.0, 11.0, 5.01));
        let m = to_manifold(&slab).expect("thin slab should be a valid manifold");
        assert!(!m.is_empty());
        assert!(m.num_tri() >= 12, "slab should have its 12 tris");
        assert!(m.volume() > 0.0, "slab should enclose positive volume");
    }

    #[test]
    fn cube_minus_thin_slab_decomposes_into_two_parts() {
        // THE CRUX (M4c). A thin wafer that fully spans the cube's cross-section
        // at z≈5, differenced from the cube, must decompose into EXACTLY two
        // connected components — the top lump and the bottom lump.
        let model = to_manifold(&cube(10.0)).expect("cube manifold");

        // Wafer: 0.01 mm thick at z=5, extended PAST the cube in x and y so it
        // fully severs the body (handoff §4 step 5 option A: the cutter must span
        // the whole cross-section or decompose won't split).
        let half = DEFAULT_CUTTER_THICKNESS_MM / 2.0;
        let wafer = to_manifold(&axis_aligned_slab(
            Vec3::new(-1.0, -1.0, 5.0 - half),
            Vec3::new(11.0, 11.0, 5.0 + half),
        ))
        .expect("wafer manifold");

        let parts = split_by_cutter(&model, &wafer);
        assert_eq!(
            parts.len(),
            2,
            "thin wafer through the cube must yield exactly 2 components, got {}",
            parts.len()
        );
        for (i, p) in parts.iter().enumerate() {
            assert!(p.triangles.len() > 0, "part {i} should be non-empty");
        }
    }

    #[test]
    fn contour_split_severs_a_cube_with_a_built_membrane() {
        // CAPSTONE: the full pipeline on a REAL membrane (not an axis-aligned box).
        // A DENSE loop around the cube's z=5 equator (like a real surface loop, not
        // 4 points on hard edges) → build membrane → thicken → split → 2 parts.
        let model = cube(10.0);
        let loop_pts = dense_equator_loop(10.0, 8);
        let split = contour_split(&model, &loop_pts, DEFAULT_CUTTER_THICKNESS_MM, DEFAULT_MEMBRANE_SMOOTHING, 1.0)
            .expect("contour split should sever the cube into 2 parts");
        assert_eq!(split.component_count, 2);
        assert!(split.part_a.triangle_count() > 0, "part A empty");
        assert!(split.part_b.triangle_count() > 0, "part B empty");
        assert!(split.membrane_tris > 0);
    }

    #[test]
    fn multi_loop_cut_severs_a_bar_at_two_bands() {
        // The multi-loop union cut: a tall bar with a dense ring loop at TWO heights
        // (z=10 and z=20). Each loop wraps all the way through the bar, so the
        // union of the two cutters slices the bar into three slabs (top / middle /
        // bottom) in ONE operation. This is the mechanism that frees a tail joined
        // to a body in two places: each loop cuts its own bridge, no membrane has to
        // span the gap between them.
        let size = 30.0_f32;
        let model = cube(size);
        // A dense ring at height `z` (reuses the equator-loop construction).
        let band = |z: f32| -> Vec<Vec3> {
            let steps = 8usize;
            let f = |i: usize| size * i as f32 / steps as f32;
            let mut pts = Vec::with_capacity(steps * 4);
            for i in 0..steps { pts.push(Vec3::new(f(i), 0.0, z)); }
            for i in 0..steps { pts.push(Vec3::new(size, f(i), z)); }
            for i in 0..steps { pts.push(Vec3::new(size - f(i), size, z)); }
            for i in 0..steps { pts.push(Vec3::new(0.0, size - f(i), z)); }
            pts
        };
        let loops = vec![band(10.0), band(20.0)];
        let split = contour_split_multi(
            &model,
            &loops,
            DEFAULT_CUTTER_THICKNESS_MM,
            DEFAULT_MEMBRANE_SMOOTHING,
            1.0,
        )
        .expect("two band loops should sever the bar");
        assert!(
            split.component_count >= 3,
            "two cuts across the bar make >=3 pieces, got {}",
            split.component_count
        );
        assert!(split.part_a.triangle_count() > 0, "body (part A) empty");
        assert!(split.part_b.triangle_count() > 0, "freed piece (part B) empty");
        assert!(split.membrane_tris > 0);
    }

    #[test]
    fn split_into_two_sides_groups_many_islands_by_membrane_side() {
        // The multi-island fix: a real cut yields several islands per side. Build
        // a flat membrane at z=5, then hand it FOUR islands — two above (z>5),
        // two below (z<5) — and assert they collapse to exactly two parts, one
        // per side, with the right triangle totals.
        let membrane = build_membrane(&square_loop(10.0), 1).expect("membrane");
        // Move the membrane to z=5 (square_loop is at z=0) so "above/below" is
        // unambiguous — shift every vertex up by 5.
        let mut membrane = membrane;
        for v in membrane.vertices.iter_mut() {
            v.z += 5.0;
        }

        let above1 = axis_aligned_slab(Vec3::new(0.0, 0.0, 6.0), Vec3::new(2.0, 2.0, 8.0));
        let above2 = axis_aligned_slab(Vec3::new(8.0, 8.0, 6.0), Vec3::new(9.0, 9.0, 8.0));
        let below1 = axis_aligned_slab(Vec3::new(0.0, 0.0, 1.0), Vec3::new(2.0, 2.0, 3.0));
        let below2 = axis_aligned_slab(Vec3::new(8.0, 8.0, 1.0), Vec3::new(9.0, 9.0, 3.0));
        let islands = vec![above1.clone(), below1.clone(), above2.clone(), below2.clone()];

        let (part_a, part_b) =
            split_into_two_sides(&membrane, islands).expect("should group into 2 sides");
        // Each side has two slabs → 24 tris; both parts non-empty and equal here.
        assert!(part_a.triangle_count() > 0 && part_b.triangle_count() > 0);
        let total = part_a.triangle_count() + part_b.triangle_count();
        assert_eq!(total, 4 * 12, "all four island slabs should survive grouping");
    }

    #[test]
    fn split_into_two_sides_errors_when_all_on_one_side() {
        // If every island is on the SAME side of the membrane, the cut didn't
        // separate the body → None (caller falls back to the plane).
        let membrane = build_membrane(&square_loop(10.0), 1).expect("membrane"); // z=0
        let above1 = axis_aligned_slab(Vec3::new(0.0, 0.0, 1.0), Vec3::new(2.0, 2.0, 3.0));
        let above2 = axis_aligned_slab(Vec3::new(8.0, 8.0, 1.0), Vec3::new(9.0, 9.0, 3.0));
        assert!(split_into_two_sides(&membrane, vec![above1, above2]).is_none());
    }

    #[test]
    fn contour_split_on_a_loop_that_misses_the_body_errors() {
        // A tiny loop near one corner doesn't wrap through the body → the cutter
        // can't sever it → contour_split returns Err (caller falls back to plane).
        let model = cube(10.0);
        let loop_pts = vec![
            Vec3::new(0.0, 0.5, 0.5),
            Vec3::new(0.0, 1.0, 0.5),
            Vec3::new(0.0, 1.0, 1.0),
            Vec3::new(0.0, 0.5, 1.0),
        ];
        let result = contour_split(&model, &loop_pts, DEFAULT_CUTTER_THICKNESS_MM, DEFAULT_MEMBRANE_SMOOTHING, 1.0);
        assert!(result.is_err(), "a loop that misses the body should error, not split");
    }

    #[test]
    fn wafer_that_misses_the_body_yields_one_part() {
        // Sanity / negative control: a wafer entirely ABOVE the cube removes
        // nothing, so decompose gives a single component (the whole cube). This
        // is the case the caller must detect (≠2) and fall back to the plane.
        let model = to_manifold(&cube(10.0)).expect("cube manifold");
        let half = DEFAULT_CUTTER_THICKNESS_MM / 2.0;
        let wafer = to_manifold(&axis_aligned_slab(
            Vec3::new(-1.0, -1.0, 50.0 - half),
            Vec3::new(11.0, 11.0, 50.0 + half),
        ))
        .expect("wafer manifold");

        let parts = split_by_cutter(&model, &wafer);
        assert_eq!(parts.len(), 1, "a wafer above the cube should leave 1 part");
    }

    #[test]
    fn contour_split_severs_with_loop_offset_off_the_faces() {
        // End-to-end: the loop is offset off the model faces (DEFAULT_LOOP_OFFSET_MM),
        // the membrane is built on the offset loop, and the cube still severs at every
        // density — the cut sits just outside the surface and runs clean to the
        // edge with no border/lip.
        let model = cube(10.0);
        let loop_pts = dense_equator_loop(10.0, 8);
        for density in [1.0_f32, 2.0, 4.0] {
            let split = contour_split(
                &model,
                &loop_pts,
                DEFAULT_CUTTER_THICKNESS_MM,
                DEFAULT_MEMBRANE_SMOOTHING,
                density,
            )
            .unwrap_or_else(|e| panic!("contour split should sever the cube at density {density}: {e}"));
            assert_eq!(split.component_count, 2, "density {density} should give 2 parts");
            assert!(split.part_a.triangle_count() > 0 && split.part_b.triangle_count() > 0);
        }
    }

    #[test]
    fn offset_loop_off_faces_pushes_points_along_the_surface_normal() {
        // A loop on the cube's z=5 side-face midlines must each move OUT along that
        // face's outward normal by the offset amount (off the faces).
        let model = cube(10.0);
        let loop_pts = vec![
            Vec3::new(5.0, 0.0, 5.0),  // face y=0  → normal -y
            Vec3::new(10.0, 5.0, 5.0), // face x=10 → normal +x
            Vec3::new(5.0, 10.0, 5.0), // face y=10 → normal +y
            Vec3::new(0.0, 5.0, 5.0),  // face x=0  → normal -x
        ];
        let off = offset_loop_off_faces(&model, &loop_pts, 0.5);
        assert!((off[0].y - (-0.5)).abs() < 1e-3, "y=0 point should move to y=-0.5, got {:?}", off[0]);
        assert!((off[1].x - 10.5).abs() < 1e-3, "x=10 point should move to x=10.5, got {:?}", off[1]);
        assert!((off[2].y - 10.5).abs() < 1e-3, "y=10 point should move to y=10.5, got {:?}", off[2]);
        assert!((off[3].x - (-0.5)).abs() < 1e-3, "x=0 point should move to x=-0.5, got {:?}", off[3]);
    }

    #[test]
    fn offset_loop_off_faces_is_a_noop_for_zero_offset() {
        let model = cube(10.0);
        let loop_pts = square_loop(10.0);
        assert_eq!(offset_loop_off_faces(&model, &loop_pts, 0.0), loop_pts);
    }

    #[test]
    fn widen_membrane_boundary_grows_footprint_keeps_height_no_self_x() {
        // Build a membrane on a flat square loop at z=0, widen its boundary, and
        // assert: (1) the boundary footprint grew outward, (2) the boundary stayed
        // at z=0 (wider, not taller), (3) the membrane is still a valid (non-self-
        // intersecting) mesh — the whole point of the 3D-local widen.
        let s = 10.0;
        let m0 = build_membrane(&square_loop(s), 2).expect("membrane");
        // Record the boundary bbox before.
        let bbox = |m: &Membrane| {
            let (mut lo, mut hi) = (Vec3::new(f32::MAX, f32::MAX, f32::MAX), Vec3::new(f32::MIN, f32::MIN, f32::MIN));
            for &bi in &m.boundary { let p = m.vertices[bi as usize]; lo = lo.min(p); hi = hi.max(p); }
            (lo, hi)
        };
        let (lo0, hi0) = bbox(&m0);

        let mut m = m0.clone();
        widen_membrane_boundary(&mut m, 0.3);
        let (lo1, hi1) = bbox(&m);

        // Footprint grew outward on both axes.
        assert!(lo1.x < lo0.x - 0.1 && lo1.y < lo0.y - 0.1, "min should move outward: {lo0:?} -> {lo1:?}");
        assert!(hi1.x > hi0.x + 0.1 && hi1.y > hi0.y + 0.1, "max should move outward: {hi0:?} -> {hi1:?}");
        // Height preserved: boundary stays on z=0.
        for &bi in &m.boundary {
            assert!(m.vertices[bi as usize].z.abs() < 1e-3, "boundary must stay at z=0 (wider, not taller)");
        }
        // Still a valid mesh — no self-intersections introduced.
        let soup = IndexedMesh { positions: m.vertices.clone(), triangles: m.triangles.clone() };
        assert_eq!(count_self_intersections(&soup), 0, "widened membrane must not self-intersect");
    }

    #[test]
    fn widen_membrane_boundary_is_a_noop_for_zero() {
        let mut m = build_membrane(&square_loop(10.0), 2).expect("membrane");
        let before: Vec<Vec3> = m.boundary.iter().map(|&b| m.vertices[b as usize]).collect();
        widen_membrane_boundary(&mut m, 0.0);
        let after: Vec<Vec3> = m.boundary.iter().map(|&b| m.vertices[b as usize]).collect();
        assert_eq!(before, after, "zero widen must leave the boundary unchanged");
    }

    // ── refine_model_near_slab (watertight seam-band subdivision) ───────────

    #[test]
    fn refine_model_near_slab_densifies_the_band() {
        // A closed cube with a thin slab through z=5: the band near the slab must
        // gain triangles, and the result must STAY WATERTIGHT (the whole point —
        // pure conforming subdivision can't open the mesh).
        let cube = cube(10.0);
        let slab = axis_aligned_slab(Vec3::new(-1.0, -1.0, 4.9), Vec3::new(11.0, 11.0, 5.1));
        assert_eq!(open_edge_count(&cube), 0, "cube starts closed");

        let before = cube.triangle_count();
        let refined = refine_model_near_slab(&cube, &slab, /*band*/ 2.0, /*target*/ 2.0, /*levels*/ 3);
        assert!(
            refined.triangle_count() > before,
            "band near the slab should be subdivided ({} → {})",
            before,
            refined.triangle_count()
        );
        assert_eq!(
            open_edge_count(&refined),
            0,
            "conforming subdivision MUST keep the mesh watertight (got {} open edges)",
            open_edge_count(&refined)
        );
    }

    #[test]
    fn refine_model_near_slab_leaves_far_triangles_alone() {
        let cube = cube(10.0);
        // Slab far above the cube → nothing in band → unchanged.
        let slab = axis_aligned_slab(Vec3::new(-1.0, -1.0, 99.9), Vec3::new(11.0, 11.0, 100.1));
        let refined = refine_model_near_slab(&cube, &slab, 2.0, 2.0, 3);
        assert_eq!(refined.triangle_count(), cube.triangle_count(), "far slab must not subdivide");
        assert_eq!(open_edge_count(&refined), 0);
    }

    #[test]
    fn contour_split_severs_with_seam_refinement_across_densities() {
        // End-to-end with the seam-band subdivision wired in: the cube severs into
        // 2 at every density and the refinement never breaks the boolean.
        let model = cube(10.0);
        let loop_pts = dense_equator_loop(10.0, 8);
        for density in [1.0_f32, 2.0, 4.0] {
            let split = contour_split(
                &model,
                &loop_pts,
                DEFAULT_CUTTER_THICKNESS_MM,
                DEFAULT_MEMBRANE_SMOOTHING,
                density,
            )
            .unwrap_or_else(|e| panic!("refined contour split should sever the cube at density {density}: {e}"));
            assert_eq!(split.component_count, 2, "density {density} should give 2 parts");
            assert!(split.part_a.triangle_count() > 0 && split.part_b.triangle_count() > 0);
        }
    }
}
