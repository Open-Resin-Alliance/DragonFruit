//! ShrinkWrap: resample a damaged mesh into a closed one that still looks like it.
//!
//! The last resort, and deliberately **not** part of [`crate::repair`]. Every other pass in this
//! crate edits the mesh it is handed; this one rebuilds the surface, which is the only way to
//! guarantee a closed result on input whose topology cannot be repaired at all. The reference
//! engine has the same shape — its `ShrinkWrap::run` is a separate command that its automatic
//! repair path never calls.
//!
//! It is a **signed distance field and a marching-tetrahedra isosurface**, not an occupancy grid
//! with voxel faces drawn on it. That distinction is the whole of the output quality:
//!
//! - An occupancy grid can only put the surface on voxel boundaries, so every triangle is
//!   axis-aligned and the result is a staircase. A distance field puts it wherever the field
//!   crosses zero, which is *between* lattice points, and the interpolation finds it.
//! - Occupancy has no notion of distance, so the surface lands a voxel away from the original. A
//!   distance field crosses zero *at* the original, so at a fine voxel the wrap sits on the input
//!   rather than beside it. This is what makes 0.05–0.1 mm usable.
//!
//! The field is narrow-band: only lattice points within a few voxels of a triangle are stored, so
//! the memory is proportional to the surface area over the voxel size rather than to the bounding
//! box volume. A dense grid at 0.05 mm on a 50 mm model would be 10^9 cells; the band is a few
//! million.
//!
//! At those resolutions the isosurface is far denser than anything downstream wants, so the last
//! step simplifies it to a budget. That is not an optimisation, it is what makes the resolution
//! usable — the reference engine's ShrinkWrap pulls a simplifier for the same reason.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::core::bvh::Bvh;
use crate::core::mesh::{Aabb, IndexedMesh, Vec3};
use crate::stl_budget::TriangleBudget;

/// Resolution, offsets and the triangle budget the result is simplified to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShrinkWrapOptions {
    /// Voxel size in mesh units. Detail finer than this does not survive, and the surface error is
    /// a fraction of it.
    pub voxel_mm: f32,
    /// Push the surface out by this much before extracting it, which is what closes gaps: two
    /// sheets of a hole up to twice this wide meet and merge. Costs that much inflation.
    pub gap_fill_mm: f32,
    /// Push it out by this much more. Additive with `gap_fill_mm`; kept separate because the
    /// reference engine's dialog has both and callers reach for one or the other.
    pub thickness_mm: f32,
    /// Simplify the isosurface to at most this many triangles. Zero keeps all of it, which at a
    /// fine voxel is tens of millions.
    pub max_triangles: usize,
}

impl Default for ShrinkWrapOptions {
    fn default() -> Self {
        Self {
            voxel_mm: 0.1,
            // One voxel of offset by default: enough to close a hairline crack, small enough that
            // the inflation is invisible at this resolution.
            gap_fill_mm: 0.1,
            thickness_mm: 0.0,
            max_triangles: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ShrinkWrapOutcome {
    pub mesh: IndexedMesh,
    pub report: ShrinkWrapReport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShrinkWrapReport {
    pub input_triangles: usize,
    /// Triangles before simplification.
    pub isosurface_triangles: usize,
    pub output_triangles: usize,
    pub voxel_mm: f32,
    pub offset_mm: f32,
    pub band_points: usize,
    pub ms: f64,
    /// True when the caller's sink stopped the run at a phase boundary, so the mesh in the outcome
    /// is the input untouched rather than a partial resample. A partially-built isosurface shares
    /// nothing with the input — every triangle is new — so there is no meaningful halfway result to
    /// hand back.
    pub cancelled: bool,
}

/// Announces a pass's phases to a caller's sink and counts them.
///
/// Mirrors the `(name, index) -> continue` shape of
/// [`crate::repair::repair_with_progress`], so the same Tauri sink and the same kind of progress
/// display drive both passes. `index` is the 1-based position among the phases announced so far;
/// the later phases are conditional, so a total is not known to the pass itself.
struct PhaseSink<'a> {
    sink: Option<&'a mut dyn FnMut(&str, usize) -> bool>,
    index: usize,
}

impl<'a> PhaseSink<'a> {
    fn new(sink: Option<&'a mut dyn FnMut(&str, usize) -> bool>) -> Self {
        Self { sink, index: 0 }
    }

    /// Announces the next phase, returning false once the caller has asked to stop.
    fn phase(&mut self, name: &str) -> bool {
        self.index += 1;
        match self.sink.as_mut() {
            Some(sink) => sink(name, self.index),
            None => true,
        }
    }
}

/// The outcome of a run the caller stopped, before any work that could describe it ran.
///
/// `mesh` is the input unchanged, so a cancelled remesh leaves the scene as it was.
fn cancelled_outcome(
    mesh: &IndexedMesh,
    voxel: f32,
    offset: f32,
    started: std::time::Instant,
) -> ShrinkWrapOutcome {
    ShrinkWrapOutcome {
        report: ShrinkWrapReport {
            input_triangles: mesh.triangles.len(),
            isosurface_triangles: 0,
            output_triangles: 0,
            voxel_mm: voxel,
            offset_mm: offset,
            band_points: 0,
            ms: started.elapsed().as_secs_f64() * 1000.0,
            cancelled: true,
        },
        mesh: mesh.clone(),
    }
}

/// The six tetrahedra a cube splits into, corner indices being
/// `0:(0,0,0) 1:(1,0,0) 2:(1,1,0) 3:(0,1,0) 4:(0,0,1) 5:(1,0,1) 6:(1,1,1) 7:(0,1,1)`.
const TETS: [[usize; 4]; 6] = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
];

const CORNERS: [(i32, i32, i32); 8] = [
    (0, 0, 0),
    (1, 0, 0),
    (1, 1, 0),
    (0, 1, 0),
    (0, 0, 1),
    (1, 0, 1),
    (1, 1, 1),
    (0, 1, 1),
];

/// Closest point of a triangle to `p`. Standard region test: vertex, edge or face.
fn closest_on_triangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    let ab = b.sub(a);
    let ac = c.sub(a);
    let ap = p.sub(a);
    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = p.sub(b);
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let t = d1 / (d1 - d3);
        return a.add(ab.scale(t));
    }
    let cp = p.sub(c);
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let t = d2 / (d2 - d6);
        return a.add(ac.scale(t));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return b.add(c.sub(b).scale(t));
    }
    let denom = 1.0 / (va + vb + vc);
    a.add(ab.scale(vb * denom)).add(ac.scale(vc * denom))
}

/// The narrow band of lattice points near the surface, each holding its signed distance.
///
/// Three passes over sets the size of the answer, rather than one pass over every triangle's
/// grown bounding box. The old shape was what made this 137 s on 1.38M triangles: each triangle
/// looked at every lattice point in its box grown by the band — 729 points for a triangle that
/// covers eight — and every point near a triangle was reached again by each of its neighbours. The
/// redundancy is about fifty to one, and it is redundancy rather than parallelism that dominates,
/// which is also why the naive version cannot simply be spread across threads: each thread would
/// need a map holding tens of millions of entries that mostly duplicate its neighbours'.
///
/// - Mark the cells each triangle actually covers, in parallel over triangles.
/// - Grow that set by the band, in parallel over the marked cells.
/// - Distance every band point once, in parallel, with a BVH query for the triangles near it.
///
/// The sign comes from the nearest triangle's own normal, not from a parity ray cast. Parity is
/// meaningless on the input this exists for — an open or mis-oriented mesh — while "which side of
/// the nearest triangle am I on" is a local question a triangle can answer on its own.
fn build_band(
    mesh: &IndexedMesh,
    bvh: &crate::core::bvh::Bvh,
    voxel: f32,
    band_voxels: i32,
    phases: &mut PhaseSink<'_>,
) -> Option<ahash::AHashMap<(i32, i32, i32), f32>> {
    use rayon::prelude::*;

    // 1. The cells each triangle passes through. A triangle covers about half its own bounding box
    //    in two dimensions, so this is proportional to its area over the voxel size.
    if !phases.phase("band_mark") {
        return None;
    }
    let surface: ahash::AHashSet<(i32, i32, i32)> = mesh
        .triangles
        .par_iter()
        .fold(ahash::AHashSet::new, |mut acc, t| {
            let a = mesh.positions[t[0] as usize];
            let b = mesh.positions[t[1] as usize];
            let c = mesh.positions[t[2] as usize];
            let lo = |v: f32| (v / voxel).floor() as i32;
            let hi = |v: f32| (v / voxel).ceil() as i32;
            let (i0, i1) = (lo(a.x.min(b.x).min(c.x)), hi(a.x.max(b.x).max(c.x)));
            let (j0, j1) = (lo(a.y.min(b.y).min(c.y)), hi(a.y.max(b.y).max(c.y)));
            let (k0, k1) = (lo(a.z.min(b.z).min(c.z)), hi(a.z.max(b.z).max(c.z)));
            for i in i0..=i1 {
                for j in j0..=j1 {
                    for k in k0..=k1 {
                        acc.insert((i, j, k));
                    }
                }
            }
            acc
        })
        .reduce(ahash::AHashSet::new, |mut a, b| {
            a.extend(b);
            a
        });

    // 2. Grow it by the band.
    if !phases.phase("band_grow") {
        return None;
    }
    let band_cells: ahash::AHashSet<(i32, i32, i32)> = surface
        .par_iter()
        .fold(ahash::AHashSet::new, |mut acc, &(i, j, k)| {
            for di in -band_voxels..=band_voxels {
                for dj in -band_voxels..=band_voxels {
                    for dk in -band_voxels..=band_voxels {
                        acc.insert((i + di, j + dj, k + dk));
                    }
                }
            }
            acc
        })
        .reduce(ahash::AHashSet::new, |mut a, b| {
            a.extend(b);
            a
        });

    // 3. One distance per band point, each looking only at the triangles near it. A point the
    //    query finds nothing for is dropped rather than kept: it is outside the band, and a field
    //    value of infinity there would manufacture a surface out of nothing — measured as a third
    //    component on a fixture that has two.
    let reach = band_voxels as f32 * voxel;
    let query_reach = reach + voxel;
    if !phases.phase("band_distance") {
        return None;
    }
    let points: Vec<(i32, i32, i32)> = band_cells.into_iter().collect();
    let computed: Vec<((i32, i32, i32), f32)> = points
        .par_iter()
        .filter_map(|&(i, j, k)| {
            let p = Vec3::new(i as f32 * voxel, j as f32 * voxel, k as f32 * voxel);
            let mut best = f32::INFINITY;
            let mut signed = 0.0f32;
            let mut bb = Aabb::empty();
            bb.expand(Vec3::new(
                p.x - query_reach,
                p.y - query_reach,
                p.z - query_reach,
            ));
            bb.expand(Vec3::new(
                p.x + query_reach,
                p.y + query_reach,
                p.z + query_reach,
            ));
            bvh.query_aabb(mesh, &bb, |f| {
                let t = mesh.triangles[f as usize];
                let a = mesh.positions[t[0] as usize];
                let b = mesh.positions[t[1] as usize];
                let c = mesh.positions[t[2] as usize];
                let q = closest_on_triangle(p, a, b, c);
                let d = p.sub(q).length();
                if d < best {
                    best = d;
                    let n = b.sub(a).cross(c.sub(a));
                    let nlen = n.length();
                    signed = if nlen > 1e-20 && p.sub(q).dot(n.scale(1.0 / nlen)) >= 0.0 {
                        d
                    } else {
                        -d
                    };
                }
            });
            best.is_finite().then_some(((i, j, k), signed))
        })
        .collect();

    let mut band: ahash::AHashMap<(i32, i32, i32), f32> = ahash::AHashMap::with_capacity(computed.len());
    for (key, value) in computed {
        band.insert(key, value);
    }
    Some(band)
}

/// The isosurface of the band at `iso`, as a triangle soup, by marching through the six tetrahedra
/// of every cell whose eight corners are all in the band.
///
/// Every emitted triangle is oriented toward the positive side of the field, taken from the
/// centroid of the tetrahedron's positive corners. That is what makes the result consistently
/// outward without a 16-case table.
fn marching_tetrahedra(band: &ahash::AHashMap<(i32, i32, i32), f32>, voxel: f32, iso: f32) -> Vec<[Vec3; 3]> {
    use rayon::prelude::*;

    // Each cell is independent — its triangles depend only on its own eight corners — so this is a
    // map over the band with a concatenation, and the result comes out in whatever order the
    // threads finish. Order does not matter: the weld keys on position.
    let keys: Vec<(i32, i32, i32)> = band.keys().copied().collect();
    keys.par_iter()
        .map(|&(i, j, k)| {
            let mut out: Vec<[Vec3; 3]> = Vec::new();
            polygonize_cell(band, voxel, iso, i, j, k, &mut out);
            out
        })
        .reduce(Vec::new, |mut a, b| {
            a.extend(b);
            a
        })
}

/// Every triangle the six tetrahedra of one cell contribute.
fn polygonize_cell(
    band: &ahash::AHashMap<(i32, i32, i32), f32>,
    voxel: f32,
    iso: f32,
    i: i32,
    j: i32,
    k: i32,
    out: &mut Vec<[Vec3; 3]>,
) {
    let mut corner_p = [Vec3::ZERO; 8];
    let mut corner_d = [0.0f32; 8];
    for (ci, (dx, dy, dz)) in CORNERS.iter().enumerate() {
        match band.get(&(i + dx, j + dy, k + dz)) {
            Some(d) => {
                corner_p[ci] = Vec3::new(
                    (i + dx) as f32 * voxel,
                    (j + dy) as f32 * voxel,
                    (k + dz) as f32 * voxel,
                );
                corner_d[ci] = *d;
            }
            None => return,
        }
    }
        for tet in TETS {
            let p = [
                corner_p[tet[0]],
                corner_p[tet[1]],
                corner_p[tet[2]],
                corner_p[tet[3]],
            ];
            let d = [
                corner_d[tet[0]],
                corner_d[tet[1]],
                corner_d[tet[2]],
                corner_d[tet[3]],
            ];
            let positive = d.iter().filter(|v| **v >= iso).count();
            if positive == 0 || positive == 4 {
                continue;
            }
            let mut crossings: Vec<Vec3> = Vec::with_capacity(4);
            for (ea, eb) in [(0usize, 1usize), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)] {
                if (d[ea] < iso) != (d[eb] < iso) {
                    // Interpolate from the lexicographically smaller corner. The same lattice edge
                    // is reached by several tetrahedra and from either end, and computing t from a
                    // different end gives a point that differs in the last bits — which the weld
                    // then fails to merge, leaving the surface open. One canonical end makes the
                    // point bit-identical everywhere it appears.
                    let forward =
                        (p[ea].x, p[ea].y, p[ea].z) <= (p[eb].x, p[eb].y, p[eb].z);
                    let (pa, pb, da, db) = if forward {
                        (p[ea], p[eb], d[ea], d[eb])
                    } else {
                        (p[eb], p[ea], d[eb], d[ea])
                    };
                    let t = (iso - da) / (db - da);
                    crossings.push(pa.add(pb.sub(pa).scale(t)));
                }
            }
            if crossings.len() < 3 {
                continue;
            }
            // Centroid of the positive side, to orient each triangle away from it.
            let mut sum = Vec3::ZERO;
            for (ci, v) in d.iter().enumerate() {
                if *v >= iso {
                    sum = sum.add(p[ci]);
                }
            }
            let toward = sum.scale(1.0 / positive as f32);
            let emit = |a: Vec3, b: Vec3, c: Vec3, out: &mut Vec<[Vec3; 3]>| {
                let mid = a.add(b).add(c).scale(1.0 / 3.0);
                let n = b.sub(a).cross(c.sub(a));
                if n.dot(toward.sub(mid)) >= 0.0 {
                    out.push([a, b, c]);
                } else {
                    out.push([a, c, b]);
                }
            };
            if crossings.len() == 3 {
                emit(crossings[0], crossings[1], crossings[2], out);
            } else {
                // Four crossings make a quad. Order them around their own centroid so the two
                // triangles do not cross each other.
                let centre = crossings
                    .iter()
                    .fold(Vec3::ZERO, |s, p| s.add(*p))
                    .scale(0.25);
                let n = crossings[1].sub(crossings[0]).cross(crossings[2].sub(crossings[0]));
                let nn = n.scale(1.0 / n.length().max(1e-20));
                let u = crossings[0].sub(centre);
                let uu = u.scale(1.0 / u.length().max(1e-20));
                let vv = nn.cross(uu);
                let mut q = crossings.clone();
                q.sort_by(|a, b| {
                    let ang = |p: Vec3| {
                        let r = p.sub(centre);
                        r.dot(vv).atan2(r.dot(uu))
                    };
                    ang(*a).partial_cmp(&ang(*b)).unwrap_or(std::cmp::Ordering::Equal)
                });
                emit(q[0], q[1], q[2], out);
                emit(q[0], q[2], q[3], out);
            }
        }
}

/// Merge the soup into shared vertices. The interpolation for a shared lattice edge is computed
/// from the same two corners but may be traversed in either order, so the positions agree only to
/// rounding and the key is quantised well below a voxel.
fn weld(soup: Vec<[Vec3; 3]>, voxel: f32) -> IndexedMesh {
    let cell = (voxel * 1e-3).max(1e-9);
    let key = |p: Vec3| -> (i64, i64, i64) {
        (
            (p.x / cell).round() as i64,
            (p.y / cell).round() as i64,
            (p.z / cell).round() as i64,
        )
    };
    let mut seen: ahash::AHashMap<(i64, i64, i64), u32> = ahash::AHashMap::new();
    let mut positions: Vec<Vec3> = Vec::new();
    let mut triangles: Vec<[u32; 3]> = Vec::with_capacity(soup.len());
    for t in soup {
        let mut ids = [0u32; 3];
        let mut degenerate = false;
        for (slot, p) in t.iter().enumerate() {
            let k = key(*p);
            let next = positions.len() as u32;
            let id = *seen.entry(k).or_insert_with(|| {
                positions.push(*p);
                next
            });
            ids[slot] = id;
        }
        if ids[0] == ids[1] || ids[1] == ids[2] || ids[0] == ids[2] {
            degenerate = true;
        }
        if !degenerate {
            triangles.push(ids);
        }
    }
    IndexedMesh {
        positions,
        triangles,
    }
}

/// Light Taubin smoothing: a positive then a negative Laplacian step, which removes the lattice
/// ripple an isosurface carries without the volume loss a plain Laplacian would cause.
fn taubin(mesh: &mut IndexedMesh, iterations: usize) {
    let n = mesh.positions.len();
    if n == 0 || mesh.triangles.is_empty() {
        return;
    }
    let mut neighbours: Vec<Vec<u32>> = vec![Vec::new(); n];
    for t in &mesh.triangles {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            neighbours[a as usize].push(b);
            neighbours[b as usize].push(a);
        }
    }
    let (lambda, mu) = (0.5f32, -0.53f32);
    let mut scratch = mesh.positions.clone();
    for _ in 0..iterations {
        for factor in [lambda, mu] {
            let positions = &mesh.positions;
            scratch.par_iter_mut().enumerate().for_each(|(v, slot)| {
                if neighbours[v].is_empty() {
                    *slot = positions[v];
                    return;
                }
                let mut sum = Vec3::ZERO;
                for &w in &neighbours[v] {
                    sum = sum.add(positions[w as usize]);
                }
                let avg = sum.scale(1.0 / neighbours[v].len() as f32);
                *slot = positions[v].add(avg.sub(positions[v]).scale(factor));
            });
            std::mem::swap(&mut mesh.positions, &mut scratch);
        }
    }
}


/// Drop detached pieces that are a small part of the whole, and return how many went.
///
/// A resample has nothing to preserve the way the repair pipeline does. The surface here is new, so
/// a piece that is a small fraction of the largest one is an artifact of the marching rather than
/// something the model has, and leaving it is what a user sees as floating debris: measured on a
/// damaged export, the voxel path produced 559 pieces against 302 in its input, so it was adding
/// them.
///
/// The repair pipeline's own noise rule is absolute-only, because its relative form once deleted
/// 88,912 support faces from a supported model. There are no supports here. The input is one
/// model's geometry and support struts are separate meshes, which is why the relative rule is the
/// right one at this seam and the wrong one at that.
pub(crate) fn prune_detached_pieces(mesh: &mut IndexedMesh) -> usize {
    use crate::repair::triangle_components;
    if mesh.triangles.len() < 8 {
        return 0;
    }
    let components = triangle_components(mesh);
    let count = components.iter().copied().max().unwrap_or(0) as usize + 1;
    if count < 2 {
        return 0;
    }
    let mut sizes = vec![0usize; count];
    for &c in &components {
        sizes[c as usize] += 1;
    }
    let total = mesh.triangles.len();
    let mut removed = 0;
    let kept: Vec<[u32; 3]> = mesh
        .triangles
        .iter()
        .enumerate()
        .filter_map(|(face, tri)| {
            let size = sizes[components[face] as usize];
            // Fewer than four triangles is a scrap by any measure; under a twentieth of the whole
            // is a scrap beside the model.
            if size < 4 || size * 20 < total {
                removed += 1;
                None
            } else {
                Some(*tri)
            }
        })
        .collect();
    if removed == 0 {
        return 0;
    }
    mesh.triangles = kept;
    // Vertices the removal orphaned would otherwise sit in the file as unreferenced points.
    let mut used = vec![false; mesh.positions.len()];
    for tri in &mesh.triangles {
        for &v in tri.iter() {
            used[v as usize] = true;
        }
    }
    let mut remap = vec![u32::MAX; mesh.positions.len()];
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for (index, keep) in used.iter().enumerate() {
        if *keep {
            remap[index] = positions.len() as u32;
            positions.push(mesh.positions[index]);
        }
    }
    for tri in mesh.triangles.iter_mut() {
        for v in tri.iter_mut() {
            *v = remap[*v as usize];
        }
    }
    mesh.positions = positions;
    removed
}

/// Orient a closed isosurface by propagating winding across its edges, then turn the whole thing
/// outward if the field came out inward.
///
/// Deliberately not [`crate::repair::repair_orientation`]. That pass refuses when the volume moves
/// more than one percent, which is the right guard for a repair that might invert a solid — and the
/// wrong one here, because correcting a winding *is* a volume correction. On a wrapped cube it
/// reverted the fix and left 2,400 edges unsatisfied, on a surface an independent propagation
/// settles to zero. An isosurface of a scalar field is orientable by construction, so the
/// assignment always exists and there is nothing to guard against.
fn orient_by_propagation(mesh: &mut IndexedMesh) {
    use crate::core::halfedge::Topology;
    let topo = Topology::build(mesh);
    let n = mesh.triangles.len();
    let mut adjacency: Vec<Vec<(usize, bool)>> = vec![Vec::new(); n];
    for info in topo.edges.values() {
        if info.directed.len() != 2 {
            continue;
        }
        let (a0, _, f0) = info.directed[0];
        let (a1, _, f1) = info.directed[1];
        if f0 == f1 {
            continue;
        }
        // Opposite traversals agree; the same traversal means one of the two is turned over.
        let agree = a0 != a1;
        adjacency[f0 as usize].push((f1 as usize, agree));
        adjacency[f1 as usize].push((f0 as usize, agree));
    }
    let mut side = vec![0u8; n];
    let mut queue = std::collections::VecDeque::new();
    for seed in 0..n {
        if side[seed] != 0 {
            continue;
        }
        side[seed] = 1;
        queue.push_back(seed);
        while let Some(x) = queue.pop_front() {
            for &(y, agree) in &adjacency[x] {
                if side[y] == 0 {
                    side[y] = if agree { side[x] } else { 3 - side[x] };
                    queue.push_back(y);
                }
            }
        }
    }
    for f in 0..n {
        if side[f] == 2 {
            mesh.triangles[f].swap(1, 2);
        }
    }
    if mesh.signed_volume() < 0.0 {
        for t in mesh.triangles.iter_mut() {
            t.swap(1, 2);
        }
    }
}

/// Resample `mesh` into a closed surface at the requested resolution.
///
/// Never called from [`crate::repair`]. This is the escape hatch for input whose topology cannot be
/// repaired: a mesh with a frustrated seam, a hollowed model whose interior has been turned inside
/// out, or anything else where the local passes have to refuse rather than damage the object.
pub fn shrink_wrap(mesh: &IndexedMesh, options: &ShrinkWrapOptions) -> ShrinkWrapOutcome {
    shrink_wrap_with_progress(mesh, options, None)
}

/// Resample `mesh`, telling `sink` about each phase as it starts.
///
/// The bands and the isosurface take tens of seconds on a large model, so a caller with a UI needs
/// to know which phase it is in rather than watching a spinner. `sink` is called with the phase's
/// name and its 1-based position, and its return value says whether to carry on, mirroring
/// [`crate::repair::repair_with_progress`].
///
/// Returning `false` stops the run at that phase boundary — never halfway through one, because a
/// partially-built isosurface describes nothing — and the outcome is then the input mesh unchanged
/// with [`ShrinkWrapReport::cancelled`] set. A caller that stops the run has made no change to the
/// geometry it handed in.
pub fn shrink_wrap_with_progress(
    mesh: &IndexedMesh,
    options: &ShrinkWrapOptions,
    sink: Option<&mut dyn FnMut(&str, usize) -> bool>,
) -> ShrinkWrapOutcome {
    let started = std::time::Instant::now();
    let voxel = options.voxel_mm.max(1e-4);
    let offset = options.gap_fill_mm + options.thickness_mm;

    // The band has to reach past the isosurface. Extracting at an offset of n voxels puts the
    // surface n voxels off the mesh, and a band of three would not contain its own crossing — the
    // result fragments into pieces that never meet. Measured with a half-millimetre fill at a
    // tenth-millimetre voxel: eight components where there should have been one.
    let band_voxels = 3 + (offset / voxel).ceil().max(0.0) as i32;
    let mut phases = PhaseSink::new(sink);

    let bvh = Bvh::build(mesh);
    let band = match build_band(mesh, &bvh, voxel, band_voxels, &mut phases) {
        Some(band) => band,
        None => return cancelled_outcome(mesh, voxel, offset, started),
    };
    if !phases.phase("marching") {
        return cancelled_outcome(mesh, voxel, offset, started);
    }
    let soup = marching_tetrahedra(&band, voxel, offset);
    let isosurface_triangles = soup.len();
    if !phases.phase("weld") {
        return cancelled_outcome(mesh, voxel, offset, started);
    }
    let mut out = weld(soup, voxel);
    if !phases.phase("smooth") {
        return cancelled_outcome(mesh, voxel, offset, started);
    }
    taubin(&mut out, 3);
    crate::topology_passes::split_pinched_vertices(&mut out);
    if !phases.phase("orient") {
        return cancelled_outcome(mesh, voxel, offset, started);
    }
    orient_by_propagation(&mut out);
    // Close what is left. The isosurface is closed where the band contains it, but where the model
    // is thinner than the offset the two offset surfaces meet and leave small openings — 1,810
    // boundary edges of 1.28M on the cones before simplification — and closing them is what the
    // hole pass is for. The simplification opens more by collapsing edges across them, so it runs
    // again after that too.
    if !phases.phase("closing") {
        return cancelled_outcome(mesh, voxel, offset, started);
    }
    crate::holes::holes_all(&mut out, 64);
    orient_by_propagation(&mut out);

    let before_simplify = out.triangles.len();
    if options.max_triangles > 0 && before_simplify > options.max_triangles {
        if !phases.phase("simplify") {
            return cancelled_outcome(mesh, voxel, offset, started);
        }
        let diag = mesh.bbox().diag() as f64;
        out = crate::repair::decimate_indexed_to_budget(
            out,
            &TriangleBudget {
                budget_tris: options.max_triangles,
                target_error: (voxel as f64) * 0.5,
                soft_ceiling_tris: options.max_triangles * 2,
                is_decimated: true,
                bbox_diagonal_mm: diag,
                enable_per_section_decimation: false,
            },
        )
        .mesh;
        // Simplification collapses edges, which can open the surface it just closed.
        if !phases.phase("closing_after_simplify") {
            return cancelled_outcome(mesh, voxel, offset, started);
        }
        crate::holes::holes_all(&mut out, 64);
        orient_by_propagation(&mut out);
    }

    // Before the outcome is built, so the report's count matches the mesh it describes.
    let pruned = prune_detached_pieces(&mut out);
    if pruned > 0 {
        orient_by_propagation(&mut out);
    }

    ShrinkWrapOutcome {
        report: ShrinkWrapReport {
            input_triangles: mesh.triangles.len(),
            isosurface_triangles,
            output_triangles: out.triangles.len(),
            voxel_mm: voxel,
            offset_mm: offset,
            band_points: band.len(),
            ms: started.elapsed().as_secs_f64() * 1000.0,
            cancelled: false,
        },
        mesh: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two pieces: a body of forty triangles and a scrap of one, far apart. The scrap is what a
    /// band isosurface leaves behind where the band thins, and the body is what the user drew.
    #[test]
    fn a_detached_scrap_goes_and_the_body_stays() {
        let mut positions: Vec<Vec3> = Vec::new();
        let mut triangles: Vec<[u32; 3]> = Vec::new();
        // A fan of forty, which is a body beside a scrap by any measure.
        positions.push(Vec3::new(0.0, 0.0, 0.0));
        for step in 0..41 {
            let angle = step as f32 * 0.1;
            positions.push(Vec3::new(angle.cos(), angle.sin(), 0.0));
        }
        for step in 0..40u32 {
            triangles.push([0, 1 + step, 2 + step]);
        }
        // A single triangle a long way off.
        let base = positions.len() as u32;
        positions.push(Vec3::new(50.0, 0.0, 0.0));
        positions.push(Vec3::new(51.0, 0.0, 0.0));
        positions.push(Vec3::new(50.0, 1.0, 0.0));
        triangles.push([base, base + 1, base + 2]);

        let mut mesh = IndexedMesh { positions, triangles };
        let before = mesh.triangles.len();
        let removed = prune_detached_pieces(&mut mesh);
        assert_eq!(removed, 1, "the scrap is the one triangle");
        assert_eq!(mesh.triangles.len(), before - 1);
        assert_eq!(mesh.positions.len(), 42, "the scrap's vertices go with it");
    }

    fn cube(offset: Vec3, size: f32) -> IndexedMesh {
        let p = [
            offset,
            Vec3::new(offset.x + size, offset.y, offset.z),
            Vec3::new(offset.x + size, offset.y + size, offset.z),
            Vec3::new(offset.x, offset.y + size, offset.z),
            Vec3::new(offset.x, offset.y, offset.z + size),
            Vec3::new(offset.x + size, offset.y, offset.z + size),
            Vec3::new(offset.x + size, offset.y + size, offset.z + size),
            Vec3::new(offset.x, offset.y + size, offset.z + size),
        ];
        let t = vec![
            [0u32, 2, 1], [0, 3, 2],
            [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4],
            [3, 7, 6], [3, 6, 2],
            [0, 4, 7], [0, 7, 3],
            [1, 2, 6], [1, 6, 5],
        ];
        IndexedMesh {
            positions: p.to_vec(),
            triangles: t,
        }
    }

    fn defects(mesh: &IndexedMesh) -> crate::evaluate::MeshDefects {
        crate::evaluate::evaluate(mesh)
    }

    /// Distance from `p` to the nearest point of `mesh`, by brute force. Only for tests.
    fn distance_to_mesh(mesh: &IndexedMesh, p: Vec3) -> f32 {
        let mut best = f32::INFINITY;
        for t in &mesh.triangles {
            let q = closest_on_triangle(
                p,
                mesh.positions[t[0] as usize],
                mesh.positions[t[1] as usize],
                mesh.positions[t[2] as usize],
            );
            best = best.min(p.sub(q).length());
        }
        best
    }

    /// An independent BFS orientation, to tell a non-orientable surface from a propagation that is
    /// not doing its job. Returns the residual after applying the assignment it computes.
    fn bfs_residual(mesh: &IndexedMesh) -> usize {
        use crate::core::halfedge::Topology;
        let topo = Topology::build(mesh);
        let n = mesh.triangles.len();
        let mut adj: Vec<Vec<(usize, bool)>> = vec![Vec::new(); n];
        for info in topo.edges.values() {
            if info.directed.len() != 2 {
                continue;
            }
            let (a0, _, f0) = info.directed[0];
            let (a1, _, f1) = info.directed[1];
            if f0 == f1 {
                continue;
            }
            let agree = a0 != a1;
            adj[f0 as usize].push((f1 as usize, agree));
            adj[f1 as usize].push((f0 as usize, agree));
        }
        let mut side = vec![0u8; n];
        let mut queue = std::collections::VecDeque::new();
        for seed in 0..n {
            if side[seed] != 0 {
                continue;
            }
            side[seed] = 1;
            queue.push_back(seed);
            while let Some(x) = queue.pop_front() {
                for &(y, agree) in &adj[x] {
                    if side[y] == 0 {
                        side[y] = if agree { side[x] } else { 3 - side[x] };
                        queue.push_back(y);
                    }
                }
            }
        }
        let mut m = mesh.clone();
        for f in 0..n {
            if side[f] == 2 {
                m.triangles[f].swap(1, 2);
            }
        }
        crate::evaluate::evaluate(&m).inconsistent_edges
    }

    /// The result has to be closed and consistently wound, whatever the input was.
    #[test]
    fn a_closed_cube_comes_back_closed() {
        let mesh = cube(Vec3::new(0.0, 0.0, 0.0), 10.0);
        let out = shrink_wrap(&mesh, &ShrinkWrapOptions::default());
        let d = defects(&out.mesh);
        eprintln!("[wrap] independent bfs residual {}", bfs_residual(&out.mesh));
        let a = crate::analysis::analyze(&out.mesh);
        assert_eq!(
            d.bad_edges, 0,
            "wrapped surface must have no open or odd edges: {d:?} tris {} degenerate {} duplicate {}",
            out.mesh.triangles.len(),
            a.degenerate_triangles,
            a.duplicate_triangles
        );
        assert_eq!(d.inconsistent_edges, 0, "{d:?}");
        assert_eq!(d.non_manifold_edges, 0, "{d:?}");
        assert!(out.mesh.signed_volume() > 0.0, "winding is outward");
    }

    /// And it has to still look like the cube. This is the property an occupancy grid cannot
    /// give: its surface sits on voxel boundaries, a voxel away from the input, and every triangle
    /// is axis-aligned. A distance field crosses zero at the input, so the wrap has to land on it.
    #[test]
    fn the_wrapped_surface_sits_on_the_original() {
        let size = 10.0;
        let mesh = cube(Vec3::new(0.0, 0.0, 0.0), size);
        let voxel = 0.1;
        let out = shrink_wrap(
            &mesh,
            &ShrinkWrapOptions {
                voxel_mm: voxel,
                gap_fill_mm: 0.0,
                thickness_mm: 0.0,
                max_triangles: 0,
            },
        );
        // Sample the middle of each face, a place the wrap has to have reproduced.
        let samples = [
            Vec3::new(size / 2.0, size / 2.0, 0.0),
            Vec3::new(size / 2.0, size / 2.0, size),
            Vec3::new(size / 2.0, 0.0, size / 2.0),
            Vec3::new(size / 2.0, size, size / 2.0),
            Vec3::new(0.0, size / 2.0, size / 2.0),
            Vec3::new(size, size / 2.0, size / 2.0),
        ];
        for p in samples {
            let d = distance_to_mesh(&out.mesh, p);
            assert!(
                d < voxel,
                "the wrap is {d} from the original at {p:?}, more than one voxel of {voxel}"
            );
        }
    }

    /// Count connected components over shared edges. Gap fill is an offset, so whether it worked is
    /// a question about connectivity — both a merged and an unmerged result are watertight, so
    /// defect counts cannot tell them apart.
    fn component_count(mesh: &IndexedMesh) -> usize {
        fn find(parent: &mut [u32], mut x: u32) -> u32 {
            while parent[x as usize] != x {
                parent[x as usize] = parent[parent[x as usize] as usize];
                x = parent[x as usize];
            }
            x
        }
        let n = mesh.triangles.len();
        let mut parent: Vec<u32> = (0..n as u32).collect();
        let mut owner: ahash::AHashMap<(u32, u32), u32> = ahash::AHashMap::new();
        for (i, t) in mesh.triangles.iter().enumerate() {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let key = if a < b { (a, b) } else { (b, a) };
                match owner.entry(key) {
                    std::collections::hash_map::Entry::Occupied(e) => {
                        let (ra, rb) = (find(&mut parent, i as u32), find(&mut parent, *e.get()));
                        if ra != rb {
                            parent[ra as usize] = rb;
                        }
                    }
                    std::collections::hash_map::Entry::Vacant(e) => {
                        e.insert(i as u32);
                    }
                }
            }
        }
        let mut roots = ahash::AHashSet::new();
        for i in 0..n as u32 {
            roots.insert(find(&mut parent, i));
        }
        roots.len()
    }

    /// Two slabs a hair apart. A gap fill wider than the gap merges them into one closed solid; one
    /// that is not leaves them separate. Both come out watertight, so connectivity is the only
    /// thing that distinguishes them.
    #[test]
    fn a_gap_fill_merges_what_it_covers() {
        let gap = 0.4;
        let mut mesh = cube(Vec3::new(0.0, 0.0, 0.0), 4.0);
        let second = cube(Vec3::new(0.0, 0.0, 4.0 + gap), 4.0);
        let base = mesh.positions.len() as u32;
        mesh.positions.extend_from_slice(&second.positions);
        mesh.triangles.extend(
            second
                .triangles
                .iter()
                .map(|t| [t[0] + base, t[1] + base, t[2] + base]),
        );
        assert_eq!(component_count(&mesh), 2, "two separate solids to begin with");

        let unfilled = shrink_wrap(
            &mesh,
            &ShrinkWrapOptions {
                voxel_mm: 0.1,
                gap_fill_mm: 0.0,
                thickness_mm: 0.0,
                max_triangles: 0,
            },
        );
        assert_eq!(
            component_count(&unfilled.mesh),
            2,
            "with no fill the two slabs stay apart"
        );
        assert_eq!(defects(&unfilled.mesh).bad_edges, 0);

        let filled = shrink_wrap(
            &mesh,
            &ShrinkWrapOptions {
                voxel_mm: 0.1,
                gap_fill_mm: 0.5,
                thickness_mm: 0.0,
                max_triangles: 0,
            },
        );
        assert_eq!(
            component_count(&filled.mesh),
            1,
            "a fill wider than the gap has to merge them"
        );
        assert_eq!(defects(&filled.mesh).bad_edges, 0);
    }

    /// The simplification step is what makes a fine voxel usable.
    #[test]
    fn a_budget_caps_the_output() {
        let mesh = cube(Vec3::new(0.0, 0.0, 0.0), 10.0);
        let out = shrink_wrap(
            &mesh,
            &ShrinkWrapOptions {
                voxel_mm: 0.1,
                gap_fill_mm: 0.0,
                thickness_mm: 0.0,
                max_triangles: 500,
            },
        );
        assert!(
            out.mesh.triangles.len() <= 2000,
            "budget 500 produced {} triangles — the simplification honours it and the closing pass \
             after it adds a few back",
            out.mesh.triangles.len()
        );
        assert!(defects(&out.mesh).bad_edges == 0);
    }

    /// The progress sink hears every phase, in the engine's order, with 1-based positions — which
    /// is what the frontend bar is a fraction of.
    #[test]
    fn progress_reports_every_phase_in_order() {
        let mesh = cube(Vec3::new(0.0, 0.0, 0.0), 10.0);
        let mut seen: Vec<(String, usize)> = Vec::new();
        let mut sink = |name: &str, index: usize| {
            seen.push((name.to_string(), index));
            true
        };
        let out = shrink_wrap_with_progress(
            &mesh,
            &ShrinkWrapOptions {
                voxel_mm: 0.1,
                gap_fill_mm: 0.0,
                thickness_mm: 0.0,
                max_triangles: 500,
            },
            Some(&mut sink),
        );

        let names: Vec<&str> = seen.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "band_mark",
                "band_grow",
                "band_distance",
                "marching",
                "weld",
                "smooth",
                "orient",
                "closing",
                "simplify",
                "closing_after_simplify",
            ],
        );
        for (offset, (_, index)) in seen.iter().enumerate() {
            assert_eq!(*index, offset + 1, "phases are numbered 1-based and in order");
        }
        assert!(!out.report.cancelled);
        assert!(!out.mesh.triangles.is_empty());
    }

    /// A cancel at a phase boundary leaves the caller's mesh untouched. There is no half-built
    /// isosurface to hand back, so the outcome is the input with `cancelled` set.
    #[test]
    fn a_cancel_returns_the_input_unchanged() {
        let mesh = cube(Vec3::new(0.0, 0.0, 0.0), 10.0);
        let mut seen = 0usize;
        // Continue through the first phase, then stop at the second boundary.
        let mut sink = |_name: &str, _index: usize| {
            seen += 1;
            seen < 2
        };
        let out = shrink_wrap_with_progress(&mesh, &ShrinkWrapOptions::default(), Some(&mut sink));

        assert!(out.report.cancelled);
        assert_eq!(out.report.output_triangles, 0);
        assert_eq!(out.mesh.triangles, mesh.triangles);
    }
}
