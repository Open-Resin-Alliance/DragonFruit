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

use dragonfruit_mesh_core::mesh::{IndexedMesh, Vec3};

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
    let mut membrane = match seed_grid(&loop_pts, grid_divisions, true) {
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

/// Triangulate a closed 3D ring directly, with no plane and no projection.
///
/// The smallest-total-area triangulation of the ring, found by the classic dynamic
/// program: the best way to span `i..j` is the best way to span `i..k`, plus `k..j`,
/// plus the triangle that joins them, minimised over `k`. Cubic in the ring's length,
/// which is nothing at the few hundred vertices a cut face has, and it always
/// returns a triangulation — there is no configuration it can refuse, because it
/// never has to decide what "inside" means in 2D.
///
/// It is not a soap film: with no interior vertices it is as taut as a drum skin, and
/// on a deeply bowed rim it will not follow the surface the preview showed. That is
/// the trade for a cap that exists at all, and relaxation afterwards has nothing to
/// move. Used only when the grid seed refuses.
fn span_rim_in_3d(ring: &[Vec3]) -> Option<Membrane> {
    let n = ring.len();
    if n < 3 {
        return None;
    }
    let area = |i: usize, k: usize, j: usize| -> f32 {
        ring[k].sub(ring[i]).cross(ring[j].sub(ring[i])).length() * 0.5
    };
    // `cost[i][j]` spans the sub-ring i..=j; `via[i][j]` remembers the apex that did
    // it, so the triangles can be read back out afterwards.
    let mut cost = vec![vec![0.0f32; n]; n];
    let mut via = vec![vec![0usize; n]; n];
    for span in 2..n {
        for i in 0..n - span {
            let j = i + span;
            let mut best = (f32::INFINITY, i + 1);
            for k in i + 1..j {
                let c = cost[i][k] + cost[k][j] + area(i, k, j);
                if c < best.0 {
                    best = (c, k);
                }
            }
            cost[i][j] = best.0;
            via[i][j] = best.1;
        }
    }
    if !cost[0][n - 1].is_finite() {
        return None;
    }

    let mut triangles = Vec::with_capacity(n - 2);
    let mut stack = vec![(0usize, n - 1)];
    while let Some((i, j)) = stack.pop() {
        if j <= i + 1 {
            continue;
        }
        let k = via[i][j];
        triangles.push([i as u32, k as u32, j as u32]);
        stack.push((i, k));
        stack.push((k, j));
    }
    if triangles.is_empty() {
        return None;
    }
    Some(Membrane {
        vertices: ring.to_vec(),
        triangles,
        boundary: (0..n as u32).collect(),
    })
}

/// Span a soap film whose boundary is EXACTLY `ring` — same vertices, same order,
/// nothing inserted between them.
///
/// [`build_membrane_full`] cannot do this, by design. It densifies the rim so the
/// triangulator has short boundary edges, and its fan fallback subdivides them, so
/// what comes back is a REFINEMENT of the loop rather than the loop. That is right
/// for the wafer, whose rim only has to lie on the seam. It is wrong for a cap,
/// which is sewn to the cut surface's own edges: an extra vertex on the rim has no
/// counterpart on the other side of it, and that is a T-junction — a hole.
///
/// `ring` must already be a clean ring (no repeated point, no zero-length edge);
/// it comes from mesh topology, so nothing here is allowed to tidy it up.
pub fn build_membrane_on_ring(ring: &[Vec3], grid_divisions: f64, smoothing: f32) -> Option<Membrane> {
    if ring.len() < 3 {
        return None;
    }
    // No fan fallback here, deliberately. `seed_fan` spans a ring with ONE interior
    // vertex at the centroid, which is a cone, not a surface — and relaxing it cannot
    // help, because there is no interior to relax. On a flat little ring nobody
    // notices; on a real cut face it is a funnel of triangles radiating from a point,
    // visibly nothing like the flat sheet the user was shown, and it gets committed
    // to their scene without a word. A cap that cannot be spanned properly is a cap
    // that should send the cut to the wafer.
    let mut membrane = match seed_grid(ring, grid_divisions, false) {
        Some(m) => m,
        // The grid seed flattens the rim onto its best-fit plane before triangulating,
        // and a rim that wanders across a curved surface crosses ITSELF in that
        // projection — so the triangulator either refuses or hands back a cap that
        // cuts through the skin. That was every failing cut on the user's model.
        // Spanning the rim in 3D instead, with no projection anywhere, cannot hit
        // that: it is a triangulation of the ring itself.
        None => span_rim_in_3d(ring)?,
    };
    if membrane.boundary.len() != ring.len() {
        return None;
    }
    orient_membrane(&mut membrane);
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

/// An orthonormal frame for the loop's best-fit plane: `origin` + in-plane axes
/// `u`,`v`. Projects 3D → 2D `(u,v)` and back. (The plane normal is used only
/// while building the frame, so it isn't stored.)
struct PlaneFrame {
    origin: Vec3,
    u: Vec3,
    v: Vec3,
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
        Some(Self { origin, u, v })
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
/// With `densify_rim` off the boundary ring comes back as `loop_pts` itself, vertex
/// for vertex and in order — which a cap needs and the wafer does not (see
/// [`build_membrane_on_ring`]).
fn seed_grid(loop_pts: &[Vec3], grid_divisions: f64, densify_rim: bool) -> Option<Membrane> {
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
        let steps = if densify_rim { ((seg_len / spacing).floor() as usize).max(1) } else { 1 };
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
    // bottom, and the side wall is tenoned to the boundary ring — all consistent
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
pub fn closest_on_tri(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> (Vec3, f32) {
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

/// Area and centroid of the cross-section a plane carves through a closed mesh.
#[derive(Debug, Clone, Copy)]
pub struct PlaneSection {
    /// Total area of the section (mm²) — several disjoint faces are summed.
    pub area: f32,
    /// Area centroid of the section, ON the plane.
    pub centroid: Vec3,
}

/// Measure the cross-section of `mesh` at the plane `dot(normal, p) == offset`.
///
/// Walks the triangles that straddle the plane and accumulates the shoelace terms
/// of each crossing segment in the plane's own `(u, v)` basis. Chaining the
/// segments into closed rings is deliberately skipped: on a closed mesh the
/// segments already form those rings, and both area and centroid are sums over
/// them, so the totals come out the same without the fragile chaining step (which
/// is what breaks on a mesh with a T-vertex or a near-tangent triangle).
///
/// Segments are oriented by `normal × face_normal`, which is consistent across the
/// whole section, so disjoint faces (a plane through both legs of a figure) add
/// rather than cancel. Returns `None` when the plane misses the body or only
/// grazes it.
///
/// Note the centroid is the section's AREA centroid, which on a non-convex section
/// (a C, or two separate legs) can land in air. Callers that need a point inside
/// the material must check — here, the tenon's clearance probe does it for free: it
/// finds no material and the fit ladder reports the part too thin for a tenon.
pub fn plane_section(mesh: &IndexedMesh, normal: Vec3, offset: f32, u: Vec3, v: Vec3) -> Option<PlaneSection> {
    let nlen = normal.length();
    if nlen < 1e-9 {
        return None;
    }
    let n = normal.scale(1.0 / nlen);
    let offset = offset / nlen;

    // Shoelace accumulators, in plane coords: 2×signed area, and 6×area×centroid.
    let (mut a2, mut cx6, mut cy6) = (0.0f64, 0.0f64, 0.0f64);
    let mut crossed = false;

    for t in &mesh.triangles {
        let p = [
            mesh.positions[t[0] as usize],
            mesh.positions[t[1] as usize],
            mesh.positions[t[2] as usize],
        ];
        let d = [
            p[0].dot(n) - offset,
            p[1].dot(n) - offset,
            p[2].dot(n) - offset,
        ];
        // Collect where each edge crosses. A vertex exactly on the plane is taken
        // as belonging to the positive side, so a shared edge is counted once.
        let mut hits: Vec<Vec3> = Vec::with_capacity(2);
        for i in 0..3 {
            let j = (i + 1) % 3;
            let (di, dj) = (d[i], d[j]);
            if (di < 0.0) == (dj < 0.0) {
                continue;
            }
            let denom = di - dj;
            if denom.abs() < 1e-12 {
                continue;
            }
            let s = di / denom;
            hits.push(p[i].add(p[j].sub(p[i]).scale(s)));
        }
        if hits.len() != 2 {
            continue;
        }
        crossed = true;

        // Orient the segment consistently: along normal × face_normal.
        let face_n = p[1].sub(p[0]).cross(p[2].sub(p[0]));
        let dir = n.cross(face_n);
        let (s0, s1) = if hits[1].sub(hits[0]).dot(dir) >= 0.0 {
            (hits[0], hits[1])
        } else {
            (hits[1], hits[0])
        };

        let (x0, y0) = (s0.dot(u) as f64, s0.dot(v) as f64);
        let (x1, y1) = (s1.dot(u) as f64, s1.dot(v) as f64);
        let cross = x0 * y1 - x1 * y0;
        a2 += cross;
        cx6 += (x0 + x1) * cross;
        cy6 += (y0 + y1) * cross;
    }

    if !crossed || a2.abs() < 1e-9 {
        return None;
    }
    let area = (a2 * 0.5).abs() as f32;
    let cx = (cx6 / (3.0 * a2)) as f32;
    let cy = (cy6 / (3.0 * a2)) as f32;
    // Back to model space: the in-plane point plus the plane's own offset.
    let centroid = u.scale(cx).add(v.scale(cy)).add(n.scale(offset));
    Some(PlaneSection { area, centroid })
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

/// Put a failed cut's reason in front of what the SURFACE says about the seams,
/// when the surface has something more fundamental to say.
///
/// The geometric reasons (`why`) all assume the loops enclose something and the
/// cutter fell short. Sometimes they do not enclose anything at all: a loop round
/// a tentacle that fuses back to the body encircles a handle, and no cutter can
/// free a piece along it. Saying "move the waypoints" there sends the user to
/// chase a fault that is not theirs.
#[cfg(feature = "manifold")]
fn explain_failure(mesh: &IndexedMesh, loops: &[Vec<Vec3>], why: String) -> String {
    match crate::surface_cut::seams_enclose_a_piece(mesh, loops) {
        crate::surface_cut::SeamVerdict::NotSeparating if loops.len() == 1 => {
            "This loop does not enclose a piece. It goes round a part that is joined to the \
             body somewhere else as well — a tentacle that loops back, an arm that touches \
             down twice — and a single loop can never free one of those, whatever it cuts \
             with. Add a second loop around the other join and cut them together."
                .to_string()
        }
        crate::surface_cut::SeamVerdict::NotSeparating => {
            "These loops do not enclose a piece between them: the part they go round is \
             still joined to the body somewhere none of them crosses. Add a loop around \
             that join too."
                .to_string()
        }
        _ => why,
    }
}

/// How near the cut face an island vertex must be to count as sitting ON it, as a
/// multiple of the cutter thickness. The boolean leaves the two kerf walls half a
/// thickness apart, so a few thicknesses is generous while still excluding
/// anything the cut never touched.
const CUT_FACE_BAND_FACTOR: f32 = 4.0;

/// A freed island smaller across than this many kerf thicknesses is debris the
/// wafer shaved off, not a piece: it rides with the body. Ten kerfs is 1 mm at the
/// default thickness — far above the crumbs a cut leaves, far below anything worth
/// printing on its own.
const KERF_DEBRIS_DIAGONALS: f32 = 10.0;

/// Group the severed islands into exactly two parts by which SIDE of the cut face
/// each one is on (+normal side → A, −normal side → B). Islands on the same side
/// are concatenated into one `IndexedMesh`.
///
/// Only islands that actually SIT ON the cut face are grouped. Two traps make that
/// necessary, and both were seen on a real model:
///
/// - `decompose` returns every connected shell of the result, INCLUDING the ones
///   the model already had. A loose flake that shipped inside the STL is not a
///   piece the cut freed; counting it as one hands the user a scrap from the far
///   side of the model and calls the cut a success. Those orphans ride along with
///   the bigger part instead.
/// - The side cannot be read from an island's CENTROID. A model's centroid can sit
///   a hundred millimetres from the seam, where the nearest membrane triangle's
///   normal says nothing about which side the island is on — the freed spire and
///   the whole body both came out "+". Only points on the cut face itself carry
///   that information, so each island votes with the vertices it has there.
///
/// `Err` carries the message the user sees: too few pieces touching the cut face
/// (the seam never closed through the body), or all of them on one side.
fn split_into_two_sides(
    membrane: &Membrane,
    islands: Vec<IndexedMesh>,
    thickness: f32,
) -> Result<(IndexedMesh, IndexedMesh), String> {
    let membrane_mesh = IndexedMesh {
        positions: membrane.vertices.clone(),
        triangles: membrane.triangles.clone(),
    };
    let bvh = dragonfruit_mesh_core::bvh::Bvh::build(&membrane_mesh);
    let band = (thickness * CUT_FACE_BAND_FACTOR).max(1e-3);

    let (mut side_a, mut side_b, mut orphans) = (Vec::new(), Vec::new(), Vec::new());
    for island in islands {
        // Each vertex ON the cut face votes for its side; the majority wins. One
        // vertex would do on a clean kerf, but a rim that pokes out past the body
        // can put a stray vertex on the wrong side of the membrane's own normal.
        let mut vote = 0i64;
        for &v in &island.positions {
            match signed_side_on_cut_face(&bvh, &membrane_mesh, v, band) {
                Some(s) if s >= 0.0 => vote += 1,
                Some(_) => vote -= 1,
                None => {}
            }
        }
        match vote {
            0 => orphans.push(island),
            v if v > 0 => side_a.push(island),
            _ => side_b.push(island),
        }
    }

    let on_the_cut = side_a.len() + side_b.len();
    if on_the_cut < 2 {
        // The cut ran but nothing came apart. WHERE the two sides still hold on to
        // each other is the whole of what the user needs to know, and it is the one
        // thing the geometry can tell us — so ask it rather than guessing that the
        // seam must not have closed.
        let largest = side_a.first().or_else(|| side_b.first()).or_else(|| orphans.first());
        return Err(match largest.and_then(|body| find_surviving_join(body, membrane, band)) {
            Some((_, plus, minus)) if plus + minus <= JOIN_IS_LOCAL_HOPS => {
                "The cut face came out clean, but a thread of material still bridges the \
                 seam right beside it: the loop runs under an overhanging detail there, so \
                 the two sides never come apart. Nudge those waypoints past the detail."
                    .to_string()
            }
            Some(_) => {
                "The cut face came out clean, but the part is still attached somewhere \
                 else — one seam cannot free a piece that is joined in more than one \
                 place. Add a loop around the other join and cut them together."
                    .to_string()
            }
            None => {
                "The seam does not go all the way around the part. It runs across the \
                 surface without closing through the body, so nothing came free. Move the \
                 waypoints so the loop wraps right round what you want to separate."
                    .to_string()
            }
        });
    }
    if side_a.is_empty() || side_b.is_empty() {
        return Err(format!(
            "The seam does not go all the way around the part. The cut broke the \
             surface into {on_the_cut} pieces, but they all ended up on the same \
             side of the cut face, so there is nothing to separate. Move the waypoints \
             so the loop wraps right round what you want to free."
        ));
    }

    // Shells the cut never touched stay with the bigger part — they were never
    // attached to anything, and the user did not ask for them to come free.
    let tris = |ms: &[IndexedMesh]| ms.iter().map(|m| m.triangles.len()).sum::<usize>();
    if tris(&side_a) >= tris(&side_b) {
        side_a.append(&mut orphans);
    } else {
        side_b.append(&mut orphans);
    }
    Ok((concat_meshes(side_a), concat_meshes(side_b)))
}

/// Signed side of `p` relative to the cut face, or `None` when `p` is further than
/// `band` from it — i.e. not on the cut face at all. Signed by the nearest membrane
/// triangle's normal, which is meaningful precisely because `p` is right on it.
fn signed_side_on_cut_face(
    bvh: &dragonfruit_mesh_core::bvh::Bvh,
    membrane_mesh: &IndexedMesh,
    p: Vec3,
    band: f32,
) -> Option<f32> {
    let query = dragonfruit_mesh_core::mesh::Aabb {
        min: Vec3::new(p.x - band, p.y - band, p.z - band),
        max: Vec3::new(p.x + band, p.y + band, p.z + band),
    };
    let mut best_d2 = band * band;
    let mut best_signed = None;
    bvh.query_aabb(&query, |ti| {
        let t = &membrane_mesh.triangles[ti as usize];
        let a = membrane_mesh.positions[t[0] as usize];
        let b = membrane_mesh.positions[t[1] as usize];
        let c = membrane_mesh.positions[t[2] as usize];
        let (cp, d2) = closest_on_tri(p, a, b, c);
        if d2 <= best_d2 {
            best_d2 = d2;
            let n = b.sub(a).cross(c.sub(a));
            let nlen = n.length();
            if nlen > 1e-12 {
                best_signed = Some(p.sub(cp).dot(n.scale(1.0 / nlen)));
            }
        }
    });
    best_signed
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
    /// tenon can derive its placement frame from it (centroid anchor, average-normal
    /// axis, cross-section area). `part_a` is on this membrane's +normal side.
    pub membrane: Membrane,
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
    let dirs = boundary_outward_dirs(m);
    for i in 0..bn {
        let b = m.boundary[i] as usize;
        m.vertices[b] = m.vertices[b].add(dirs[i].scale(amount));
    }
}

/// The outward direction at each boundary vertex — see [`widen_membrane_boundary`]
/// for why it is derived from LOCAL 3D geometry rather than a global plane.
fn boundary_outward_dirs(m: &Membrane) -> Vec<Vec3> {
    let bn = m.boundary.len();
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

    dirs
}

/// How far the rim may hunt for the skin, as a multiple of the widen margin — 1 mm
/// at the default margin.
///
/// It has to cover two things: a smoothed seam dipping below the surface (0.14 mm
/// on the model that found this), and a seam running UNDER an overhanging detail —
/// a shingle, a scale, a fold — whose lip the rim must pass to reach open air. On
/// that model's turret the lip was thicker than half a millimetre, and a shorter
/// leash left the two sides bridged by exactly that ridge. It stays a leash rather
/// than an open walk because the rim only moves when it FINDS air (see the caller):
/// a vertex that runs out of leash is aimed into the body and stays put, so the cut
/// cannot creep outside the seam the user drew.
const WAFER_WIDEN_MAX_STEPS: u32 = 10;

/// Push the boundary ring outward until the rim is CLEAR OF MATERIAL — past the
/// last skin it crosses, not merely out of the first wall.
///
/// The fixed widen assumes the seam lies exactly on the surface, so `margin` alone
/// carries the rim outside. Two things break that assumption on a real model, and
/// either one leaves a ring of material bridging the two sides that no boolean can
/// separate:
///
/// - Seam smoothing cuts the corner at every wiggle and sinks the line BELOW the
///   skin, deeper than the margin.
/// - The seam runs under an overhanging detail — a roof shingle, a scale, a fold.
///   Here the rim can be perfectly outside the skin and still be bridged, because
///   the lip does not touch the rim: it passes OVER it.
///
/// So the rim does not ask "am I inside?" but "where does material stop along my
/// way out?", by ray-casting: the last surface the ray crosses within the leash is
/// the far side of whatever lies in the way, and the rim goes `margin` past it. A
/// rim with nothing ahead of it does not move.
///
/// The leash is what keeps the cut inside the seam the user drew. A rim vertex
/// whose way out is longer than the leash is aimed into the body rather than at
/// the air, and it stays exactly where it is — shoving it halfway would cut
/// material nobody asked to cut without freeing anything. The per-vertex distances
/// are dilated around the ring so a buried stretch carries its neighbours with it
/// instead of leaving a step in the rim.
fn push_boundary_out_of_the_skin(m: &mut Membrane, model: &IndexedMesh, margin: f32) {
    let bn = m.boundary.len();
    if bn < 3 || margin <= 0.0 || model.triangles.is_empty() {
        return;
    }
    let bvh = dragonfruit_mesh_core::bvh::Bvh::build(model);
    let dirs = boundary_outward_dirs(m);
    let cap = margin * WAFER_WIDEN_MAX_STEPS as f32;

    let mut extra = vec![0.0f32; bn];
    let mut stuck: Vec<Vec3> = Vec::new();
    for i in 0..bn {
        let p = m.vertices[m.boundary[i] as usize];
        if dirs[i].length() < 0.5 {
            continue; // no usable outward direction here
        }
        if let Some(exit) = last_exit_along(&bvh, model, p, dirs[i], cap) {
            extra[i] = exit + margin;
        } else if is_inside_model(&bvh, model, p) {
            // Buried, and no way out within the leash: this vertex is aimed into the
            // body. It stays put (see above), but it is exactly where a cut fails, so
            // the trace names it.
            stuck.push(p);
        }
    }
    if !stuck.is_empty() && std::env::var_os("DF_CUT_DEBUG").is_some() {
        eprintln!(
            "[cut] rim vertices with no way out within {cap:.2} mm: {} of {bn}{}",
            stuck.len(),
            stuck
                .iter()
                .take(6)
                .map(|p| format!(" ({:.2}, {:.2}, {:.2})", p.x, p.y, p.z))
                .collect::<String>()
        );
    }

    // Dilate over a ±2 window: a buried vertex pulls its neighbours out too, so the
    // rim gains a smooth bulge rather than a spike.
    let dilated: Vec<f32> = (0..bn)
        .map(|i| (0..5).fold(0.0f32, |acc, k| acc.max(extra[(i + bn + k - 2) % bn])))
        .collect();
    for i in 0..bn {
        let b = m.boundary[i] as usize;
        m.vertices[b] = m.vertices[b].add(dirs[i].scale(dilated[i]));
    }
}

/// How far along `dir` the ray from `p` last crosses the model's skin, within
/// `limit` mm. `None` when it crosses nothing — the way out is already clear, or
/// whatever is in the way is further off than the leash allows.
///
/// The LAST crossing is the one that matters: an overhanging lip is entered and
/// left again, and the rim has to end up past both.
fn last_exit_along(
    bvh: &dragonfruit_mesh_core::bvh::Bvh,
    model: &IndexedMesh,
    p: Vec3,
    dir: Vec3,
    limit: f32,
) -> Option<f32> {
    let far = p.add(dir.scale(limit));
    let query = dragonfruit_mesh_core::mesh::Aabb {
        min: p.min(far),
        max: p.max(far),
    };
    let mut last: Option<f32> = None;
    bvh.query_aabb(&query, |ti| {
        let t = &model.triangles[ti as usize];
        let hit = dragonfruit_mesh_core::bvh::ray_tri(
            p,
            dir,
            model.positions[t[0] as usize],
            model.positions[t[1] as usize],
            model.positions[t[2] as usize],
        );
        if let Some(d) = hit {
            if d > 1e-5 && d <= limit {
                last = Some(last.map_or(d, |b: f32| b.max(d)));
            }
        }
    });
    last
}

/// Is `p` inside the closed `model`? Ray parity through the BVH: a ray from an
/// interior point crosses the skin an odd number of times.
fn is_inside_model(bvh: &dragonfruit_mesh_core::bvh::Bvh, model: &IndexedMesh, p: Vec3) -> bool {
    // Irrational-ish direction, so the ray is unlikely to graze an edge or vertex —
    // the one case parity counting gets wrong.
    let dir = Vec3::new(0.577_35, 0.577_36, 0.577_34);
    bvh.ray_hit_count(model, p, dir) % 2 == 1
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
    mesh: &IndexedMesh,
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
    // the rim stays at the same height, on the seam. Where a smoothed seam sank
    // BELOW the skin, that fixed margin is not enough to reach the wall, so a
    // second pass keeps pushing exactly those vertices out until they clear it.
    let mut membrane = build_membrane_full(loop_pts, CONTOUR_SUBDIVISIONS, membrane_smoothing, grid_divisions)
        .ok_or_else(|| format!("could not build a membrane from the loop ({} points)", loop_pts.len()))?;
    widen_membrane_boundary(&mut membrane, DEFAULT_WAFER_WIDEN_MM);
    push_boundary_out_of_the_skin(&mut membrane, mesh, DEFAULT_WAFER_WIDEN_MM);
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

/// Distance from `p` to the nearest point of the membrane surface (unsigned).
fn distance_to_membrane(m: &Membrane, p: Vec3) -> f32 {
    let mut best = f32::INFINITY;
    for t in &m.triangles {
        let (_, d2) = closest_on_tri(
            p,
            m.vertices[t[0] as usize],
            m.vertices[t[1] as usize],
            m.vertices[t[2] as usize],
        );
        best = best.min(d2);
    }
    best.sqrt()
}

/// Stderr trace of what the contour cut actually produced, gated on `DF_CUT_DEBUG`.
///
/// It answers the question a wrong-looking cut always raises: which of these
/// islands did the CUT make? `decompose` returns every connected shell of the
/// result, including the ones the model already had — a model that ships as
/// several loose shells hands `split_into_two_sides` islands the wafer never
/// touched, and one of those can be classified as the freed piece. So we print
/// the shell count BEFORE the cut alongside each island's size, position, side
/// and, decisively, how far it sits from the membrane: a piece the cut freed has
/// vertices ON the cut face (≈0 mm), a pre-existing shell is far away.
#[cfg(feature = "manifold")]
fn debug_contour_split(
    model_mesh: &IndexedMesh,
    model: &manifold_csg::Manifold,
    membrane: &Membrane,
    slab: &IndexedMesh,
    islands: &[IndexedMesh],
    thickness: f32,
) {
    let p = |v: Vec3| format!("({:.2}, {:.2}, {:.2})", v.x, v.y, v.z);
    let band = (thickness * CUT_FACE_BAND_FACTOR).max(1e-3);
    let mb = {
        let mut b = dragonfruit_mesh_core::mesh::Aabb::empty();
        for &v in &membrane.vertices {
            b.expand(v);
        }
        b
    };
    eprintln!(
        "[cut] membrane: {} tris, area {:.2} mm², bbox {} .. {}",
        membrane.triangles.len(),
        membrane.area(),
        p(mb.min),
        p(mb.max)
    );
    eprintln!(
        "[cut] slab: {} tris, bbox {} .. {}",
        slab.triangles.len(),
        p(slab.bbox().min),
        p(slab.bbox().max)
    );
    eprintln!(
        "[cut] model shells BEFORE the boolean: {} — islands AFTER: {}",
        model.decompose().len(),
        islands.len()
    );

    // Does the wafer's rim poke OUT through the skin all the way round? Where it
    // does not, a bridge of material survives the difference and the cut cannot
    // separate, however clean the boolean is.
    {
        let bvh = dragonfruit_mesh_core::bvh::Bvh::build(model_mesh);
        // Irrational-ish direction so the ray is unlikely to graze an edge.
        let dir = Vec3::new(0.577_35, 0.577_36, 0.577_34);
        let bn = membrane.boundary.len();
        let stride = (bn / 200).max(1);
        let (mut tested, mut inside, mut deepest) = (0usize, 0usize, 0.0f32);
        for &bi in membrane.boundary.iter().step_by(stride) {
            let p = membrane.vertices[bi as usize];
            tested += 1;
            if bvh.ray_hit_count(model_mesh, p, dir) % 2 == 1 {
                inside += 1;
                deepest = deepest.max(distance_to_surface(&bvh, model_mesh, p));
            }
        }
        eprintln!(
            "[cut] wafer rim still INSIDE the model: {inside}/{tested} sampled seam vertices (deepest {deepest:.3} mm below the skin)"
        );
    }

    // Where does material still cross the cut face? Every membrane triangle sits in
    // the middle of the kerf, so after a clean difference NONE of them should be
    // buried in the largest island. The ones that are mark the holes through which
    // the two sides stay bridged; if there are none, the piece is held somewhere
    // else entirely and no cutter along this seam will ever free it.
    // Read it against the count BEFORE the cut: a membrane that was never in the
    // material to begin with (a film bulging out through the surface) would also
    // score zero here, and that is a different bug entirely.
    let centroid = |t: &[u32; 3]| {
        membrane.vertices[t[0] as usize]
            .add(membrane.vertices[t[1] as usize])
            .add(membrane.vertices[t[2] as usize])
            .scale(1.0 / 3.0)
    };
    let before = {
        let bvh = dragonfruit_mesh_core::bvh::Bvh::build(model_mesh);
        membrane
            .triangles
            .iter()
            .filter(|t| is_inside_model(&bvh, model_mesh, centroid(t)))
            .count()
    };
    if let Some(body) = islands.first() {
        let bvh = dragonfruit_mesh_core::bvh::Bvh::build(body);
        let after = membrane
            .triangles
            .iter()
            .filter(|t| is_inside_model(&bvh, body, centroid(t)))
            .count();
        eprintln!(
            "[cut] cut face buried in material: {before}/{} membrane triangles BEFORE the cut, {after} still after",
            membrane.triangles.len()
        );
        if after > 0 {
            let where_ = membrane
                .triangles
                .iter()
                .filter(|t| is_inside_model(&bvh, body, centroid(t)))
                .take(4)
                .map(|t| {
                    let c = centroid(t);
                    format!(" ({:.2}, {:.2}, {:.2})", c.x, c.y, c.z)
                })
                .collect::<String>();
            eprintln!("[cut] material survives ON the cut face at:{where_}");
        }
    }

    let mut on_the_cut = 0usize;
    for (i, island) in islands.iter().enumerate() {
        let c = mesh_centroid(island);
        // Sample at most ~2000 vertices: the nearest one tells us whether this
        // island touches the cut face at all.
        let stride = (island.positions.len() / 2000).max(1);
        let nearest = island
            .positions
            .iter()
            .step_by(stride)
            .map(|&v| distance_to_membrane(membrane, v))
            .fold(f32::INFINITY, f32::min);
        if nearest <= band {
            on_the_cut += 1;
        }
        eprintln!(
            "[cut]   island {i}: {} tris, centroid {} (side {:+.3}), nearest vertex to membrane {:.3} mm, bbox {} .. {}",
            island.triangles.len(),
            p(c),
            signed_side_distance(membrane, c),
            nearest,
            p(island.bbox().min),
            p(island.bbox().max)
        );
    }
    // With a clean cut face, whatever still holds the piece is somewhere else on
    // the model — see [`report_surviving_neck`].
    if on_the_cut < 2 {
        if let Some(body) = islands.first() {
            report_surviving_neck(body, membrane, band, "");
        }
    }
}

/// Where the two sides of a cut still hold on to each other, if they do: a point on
/// the surviving neck of material, and how many surface hops it sits from each side
/// of the cut face.
///
/// Walks the surface outward from both sides at once and takes the vertex nearest
/// to both fronts, away from the cut itself. The hop counts are the useful part: a
/// handful means the join is right beside the seam — a lip or an overhanging
/// shingle the wafer never got past — while hundreds mean the piece is genuinely
/// held somewhere else, and no single loop was ever going to free it.
fn find_surviving_join(body: &IndexedMesh, membrane: &Membrane, band: f32) -> Option<(Vec3, u32, u32)> {
    let mem_mesh = IndexedMesh {
        positions: membrane.vertices.clone(),
        triangles: membrane.triangles.clone(),
    };
    let mem_bvh = dragonfruit_mesh_core::bvh::Bvh::build(&mem_mesh);
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); body.positions.len()];
    for t in &body.triangles {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            neighbours[a as usize].push(b);
            neighbours[b as usize].push(a);
        }
    }
    let walk = |seeds: Vec<u32>| {
        let mut hops = vec![u32::MAX; body.positions.len()];
        let mut queue: std::collections::VecDeque<u32> = seeds.into_iter().collect();
        for &s in &queue {
            hops[s as usize] = 0;
        }
        while let Some(v) = queue.pop_front() {
            let d = hops[v as usize];
            for &n in &neighbours[v as usize] {
                if hops[n as usize] == u32::MAX {
                    hops[n as usize] = d + 1;
                    queue.push_back(n);
                }
            }
        }
        hops
    };
    let side_seeds = |want_positive: bool| {
        body.positions
            .iter()
            .enumerate()
            .filter(|(_, &v)| {
                matches!(signed_side_on_cut_face(&mem_bvh, &mem_mesh, v, band),
                    Some(s) if (s >= 0.0) == want_positive)
            })
            .map(|(i, _)| i as u32)
            .collect::<Vec<_>>()
    };
    let (from_plus, from_minus) = (walk(side_seeds(true)), walk(side_seeds(false)));
    let i = (0..body.positions.len())
        .filter(|&i| from_plus[i] > 3 && from_minus[i] > 3)
        .filter(|&i| from_plus[i] != u32::MAX && from_minus[i] != u32::MAX)
        .min_by_key(|&i| from_plus[i] + from_minus[i])?;
    Some((body.positions[i], from_plus[i], from_minus[i]))
}

/// A join found beyond this many surface hops from the cut face is somewhere ELSE
/// on the model, not a lip beside the seam. Around a centimetre of surface on the
/// meshes this runs on — far past any detail the rim could have cleared.
const JOIN_IS_LOCAL_HOPS: u32 = 12;

/// Print [`find_surviving_join`]'s answer, for the `DF_CUT_DEBUG` trace.
#[cfg(feature = "manifold")]
fn report_surviving_neck(body: &IndexedMesh, membrane: &Membrane, band: f32, label: &str) {
    match find_surviving_join(body, membrane, band) {
        Some((v, plus, minus)) => eprintln!(
            "[cut] {label}the two sides still meet around ({:.2}, {:.2}, {:.2}) ({plus} + {minus} hops from the cut face)",
            v.x, v.y, v.z
        ),
        None => eprintln!("[cut] {label}the two sides do not meet anywhere else"),
    }
}

/// Distance from `p` to the nearest surface point of `mesh`, via the BVH. Searches
/// a box around `p`, widening until it finds triangles. Diagnostics only.
#[cfg(feature = "manifold")]
fn distance_to_surface(
    bvh: &dragonfruit_mesh_core::bvh::Bvh,
    mesh: &IndexedMesh,
    p: Vec3,
) -> f32 {
    for r in [0.5f32, 2.0, 8.0, 32.0] {
        let query = dragonfruit_mesh_core::mesh::Aabb {
            min: Vec3::new(p.x - r, p.y - r, p.z - r),
            max: Vec3::new(p.x + r, p.y + r, p.z + r),
        };
        let mut best = f32::INFINITY;
        bvh.query_aabb(&query, |t| {
            let t = &mesh.triangles[t as usize];
            let (_, d2) = closest_on_tri(
                p,
                mesh.positions[t[0] as usize],
                mesh.positions[t[1] as usize],
                mesh.positions[t[2] as usize],
            );
            best = best.min(d2);
        });
        if best.is_finite() {
            return best.sqrt();
        }
    }
    f32::INFINITY
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
    if std::env::var_os("DF_CUT_DEBUG").is_some() {
        debug_contour_split(&refined, &model, &membrane, &slab, &islands, thickness_mm);
    }
    let (part_a, part_b) = split_into_two_sides(&membrane, islands, thickness_mm)
        .map_err(|why| explain_failure(mesh, &[loop_pts.to_vec()], why))?;

    Ok(ContourSplit { part_a, part_b, component_count, membrane_tris, membrane })
}

/// The result of a MULTI-loop contour split (≥2 loops union'd into one cutter).
/// Unlike [`ContourSplit`] there is no single membrane — each loop has its own,
/// returned in `membranes` so the caller can place one registration tenon per seam.
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
    /// caller can place a registration tenon at EACH seam (one tenon per cut).
    pub membranes: Vec<Membrane>,
}

/// Signed side of a whole mesh relative to the membrane: positive if the mesh's
/// centroid sits on the membrane's +normal side, negative otherwise. The
/// multi-loop tenon code uses this to pass the +normal-side part as `part_a` to
/// `apply_tenon` (the side convention the single-loop cut keeps by construction).
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
    if std::env::var_os("DF_CUT_DEBUG").is_some() {
        eprintln!("[cut] multi-loop: {} loops, islands AFTER: {component_count}", membranes.len());
        for (i, island) in islands.iter().enumerate() {
            let stride = (island.positions.len() / 2000).max(1);
            let nearest = membranes
                .iter()
                .map(|m| {
                    island
                        .positions
                        .iter()
                        .step_by(stride)
                        .map(|&v| distance_to_membrane(m, v))
                        .fold(f32::INFINITY, f32::min)
                })
                .fold(f32::INFINITY, f32::min);
            let c = mesh_centroid(island);
            eprintln!(
                "[cut]   island {i}: {} tris, centroid ({:.2}, {:.2}, {:.2}), nearest vertex to any seam {nearest:.3} mm, bbox diagonal {:.3} mm",
                island.triangles.len(),
                c.x,
                c.y,
                c.z,
                island.bbox().diag()
            );
        }
    }
    if std::env::var_os("DF_CUT_DEBUG").is_some() {
        if let Some(body) = islands.first() {
            let band = (thickness_mm * CUT_FACE_BAND_FACTOR).max(1e-3);
            for (i, m) in membranes.iter().enumerate() {
                report_surviving_neck(body, m, band, &format!("loop {i}: "));
            }
        }
    }
    if component_count < 2 {
        return Err(format!(
            "multi-loop cutter did not sever the model (got {component_count} component) — \
             at least one loop must wrap all the way through the material it encircles"
        ));
    }
    let (part_a, part_b) = group_largest_vs_rest(&membranes, islands, thickness_mm)
        .map_err(|islands| -> String {
            // Same question as the single-loop cut: where do the two sides still hold
            // on to each other? Report the most LOCAL join across the seams — that is
            // the one standing in the way.
            let band = (thickness_mm * CUT_FACE_BAND_FACTOR).max(1e-3);
            let closest = islands.first().and_then(|body| {
                membranes
                    .iter()
                    .filter_map(|m| find_surviving_join(body, m, band))
                    .min_by_key(|(_, plus, minus)| plus + minus)
            });
            match closest {
                Some((_, plus, minus)) if plus + minus <= JOIN_IS_LOCAL_HOPS => {
                    "The cut faces came out clean, but a thread of material still bridges one \
                     of the seams right beside it: that loop runs under an overhanging detail, \
                     so nothing comes apart. Nudge those waypoints past the detail."
                        .to_string()
                }
                _ => "The cut broke the model into pieces, but none of them came off a seam — \
                      nothing the loops encircle came free. Move the waypoints so each loop \
                      wraps right round what you want to separate."
                    .to_string(),
            }
        })
        .map_err(|why| explain_failure(mesh, loops, why))?;

    Ok(ContourSplitMulti { part_a, part_b, component_count, membrane_tris, membranes })
}

/// Group severed islands into two parts: the LARGEST component (the body) as
/// `part_a`, and the pieces the cut actually freed as `part_b`. Used by the
/// multi-loop cut, where there is no single membrane normal to classify sides by,
/// so size decides which one is the body.
///
/// An island only counts as freed if it SITS ON one of the cut faces. Without that
/// test a shell the model already carried — the 548-triangle flake inside the
/// user's tower — comes out of `decompose` looking exactly like a freed piece, and
/// being neither the largest nor on any seam it was handed over as the result of
/// the cut. Orphans now ride along with the body. Returns `None` when the cut freed
/// nothing.
fn group_largest_vs_rest(
    membranes: &[Membrane],
    islands: Vec<IndexedMesh>,
    thickness: f32,
) -> Result<(IndexedMesh, IndexedMesh), Vec<IndexedMesh>> {
    if islands.len() < 2 {
        return Err(islands);
    }
    let band = (thickness * CUT_FACE_BAND_FACTOR).max(1e-3);
    let faces: Vec<(IndexedMesh, dragonfruit_mesh_core::bvh::Bvh)> = membranes
        .iter()
        .map(|m| {
            let mesh = IndexedMesh {
                positions: m.vertices.clone(),
                triangles: m.triangles.clone(),
            };
            let bvh = dragonfruit_mesh_core::bvh::Bvh::build(&mesh);
            (mesh, bvh)
        })
        .collect();
    let on_a_cut_face = |island: &IndexedMesh| {
        island.positions.iter().any(|&v| {
            faces
                .iter()
                .any(|(mesh, bvh)| signed_side_on_cut_face(bvh, mesh, v, band).is_some())
        })
    };

    // A chip the wafer shaved off the seam is not a piece anyone asked for: it comes
    // off the cut face like a real piece, but it is kerf-sized. The user's roof gave
    // a 16-triangle crumb 0.4 mm across, handed over as a solid of its own.
    let debris_diag = thickness * KERF_DEBRIS_DIAGONALS;
    let is_freed = |island: &IndexedMesh| {
        island.bbox().diag() > debris_diag && on_a_cut_face(island)
    };

    if !islands.iter().skip(1).any(is_freed) {
        return Err(islands); // handed back so the caller can say WHY nothing came free
    }
    let mut it = islands.into_iter();
    let largest = it.next().expect("checked non-empty"); // sorted largest-first
    let (freed, orphans): (Vec<IndexedMesh>, Vec<IndexedMesh>) =
        it.partition(|island| is_freed(island));
    let mut body = vec![largest];
    body.extend(orphans);
    Ok((concat_meshes(body), concat_meshes(freed)))
}

/// Convert a `manifold` solid back to an `IndexedMesh`. Returns `None` only on a
/// malformed/empty conversion (matches `organic_cut.rs::manifold_to_indexed`).
/// `pub(crate)` so the tenon module can convert its boolean results back too.
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
    // Edge-topology helpers: a canonical (min,max) key for an undirected edge,
    // used to count how many faces share each edge.
    type EdgeKey = (u32, u32);

    #[inline]
    fn ekey(a: u32, b: u32) -> EdgeKey {
        if a < b { (a, b) } else { (b, a) }
    }

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

    /// Worst (smallest) triangle angle in radians, over the whole membrane.
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
        let m = seed_grid(&loop_pts, DEFAULT_GRID_DIVISIONS, true).expect("grid seed should build");
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
        let grid = seed_grid(&loop_pts, DEFAULT_GRID_DIVISIONS, true).expect("grid");
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
        let m = seed_grid(&loop_pts, DEFAULT_GRID_DIVISIONS, true).expect("grid seed on saddle");
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

        // The islands sit ON the cut face, half a kerf either side of it, exactly as
        // the boolean leaves them — that contact is what tells us their side.
        let above1 = axis_aligned_slab(Vec3::new(0.0, 0.0, 5.05), Vec3::new(2.0, 2.0, 8.0));
        let above2 = axis_aligned_slab(Vec3::new(8.0, 8.0, 5.05), Vec3::new(9.0, 9.0, 8.0));
        let below1 = axis_aligned_slab(Vec3::new(0.0, 0.0, 1.0), Vec3::new(2.0, 2.0, 4.95));
        let below2 = axis_aligned_slab(Vec3::new(8.0, 8.0, 1.0), Vec3::new(9.0, 9.0, 4.95));
        let islands = vec![above1.clone(), below1.clone(), above2.clone(), below2.clone()];

        let (part_a, part_b) =
            split_into_two_sides(&membrane, islands, DEFAULT_CUTTER_THICKNESS_MM)
                .expect("should group into 2 sides");
        // Each side has two slabs → 24 tris; both parts non-empty and equal here.
        assert!(part_a.triangle_count() > 0 && part_b.triangle_count() > 0);
        let total = part_a.triangle_count() + part_b.triangle_count();
        assert_eq!(total, 4 * 12, "all four island slabs should survive grouping");
    }

    #[test]
    fn split_into_two_sides_errors_when_all_on_one_side() {
        // If every island is on the SAME side of the membrane, the cut didn't
        // separate the body → Err (the caller reports it, no fallback).
        let membrane = build_membrane(&square_loop(10.0), 1).expect("membrane"); // z=0
        let above1 = axis_aligned_slab(Vec3::new(0.0, 0.0, 0.05), Vec3::new(2.0, 2.0, 3.0));
        let above2 = axis_aligned_slab(Vec3::new(8.0, 8.0, 0.05), Vec3::new(9.0, 9.0, 3.0));
        let err = split_into_two_sides(
            &membrane,
            vec![above1, above2],
            DEFAULT_CUTTER_THICKNESS_MM,
        )
        .expect_err("both islands on one side cannot be separated");
        assert!(err.contains("same side"), "{err}");
    }

    #[test]
    fn a_loose_shell_the_cut_never_touched_is_not_the_freed_piece() {
        // A shell that shipped inside the STL sits nowhere near the cut face. It is
        // not a piece the cut freed, so it rides along with the bigger part instead
        // of being handed to the user as the result of the cut.
        let membrane = build_membrane(&square_loop(10.0), 1).expect("membrane"); // z=0
        let one_side = axis_aligned_slab(Vec3::new(0.0, 0.0, 0.05), Vec3::new(9.0, 9.0, 3.0));
        let other1 = axis_aligned_slab(Vec3::new(0.0, 0.0, -3.0), Vec3::new(2.0, 2.0, -0.05));
        let other2 = axis_aligned_slab(Vec3::new(8.0, 8.0, -3.0), Vec3::new(9.0, 9.0, -0.05));
        let stray = axis_aligned_slab(Vec3::new(100.0, 100.0, 100.0), Vec3::new(101.0, 101.0, 101.0));

        let (part_a, part_b) = split_into_two_sides(
            &membrane,
            vec![one_side, other1, other2, stray],
            DEFAULT_CUTTER_THICKNESS_MM,
        )
        .expect("two sides touch the cut face");

        let mut sizes = [part_a.triangle_count(), part_b.triangle_count()];
        sizes.sort();
        assert_eq!(
            sizes,
            [12, 36],
            "the stray shell must join the bigger side, never come out as the freed piece"
        );
    }

    #[test]
    fn a_seam_that_sank_below_the_skin_still_severs() {
        // A smoothed seam does not sit exactly on the surface: it cuts the corner at
        // every wiggle and sinks below the skin — on the user's tower, by 0.14 mm,
        // more than the fixed widen margin. The rim has to hunt its way out, or a
        // ring of material bridges the two sides and nothing separates. Here every
        // waypoint is pulled 0.3 mm INTO the cube and the cut must still sever it.
        let model = cube(10.0);
        let axis = Vec3::new(5.0, 5.0, 0.0);
        let loop_pts: Vec<Vec3> = dense_equator_loop(10.0, 8)
            .into_iter()
            .map(|p| {
                let inward = Vec3::new(axis.x - p.x, axis.y - p.y, 0.0);
                let l = inward.length();
                if l > 1e-6 { p.add(inward.scale(0.3 / l)) } else { p }
            })
            .collect();

        let split = contour_split(&model, &loop_pts, DEFAULT_CUTTER_THICKNESS_MM, DEFAULT_MEMBRANE_SMOOTHING, 1.0)
            .expect("a seam sunk below the skin must still sever the cube");
        assert!(split.part_a.triangle_count() > 0, "part A empty");
        assert!(split.part_b.triangle_count() > 0, "part B empty");
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
        // End-to-end: the loop sits on the model faces,
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
