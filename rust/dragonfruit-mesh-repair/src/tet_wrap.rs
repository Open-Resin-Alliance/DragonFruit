//! A second surfacing mode: tetrahedralise the model's points, decide which tetrahedra are inside,
//! and keep the boundary between the two.
//!
//! This is the shape the reference engine's shrinkwrap has, and it exists because the narrow-band
//! isosurface in `shrink_wrap` has two properties we cannot tune away. It loses fine detail to a
//! uniform lattice, and where the band thins it emits detached pieces, which is what a user sees as
//! floating debris. A label per cell has neither problem: the decomposition follows where the
//! model's own points are, so nothing is coarser than the input, and the boundary between two labels
//! is closed by construction, so there is nothing to detach.
//!
//! No facet constraints are given to TetGen, deliberately. A damaged export is a soup with
//! self-intersecting and non-manifold facets, which is exactly what a constrained tetrahedralisation
//! rejects; deciding inside from outside by winding number afterwards reaches the same end without
//! needing the soup to be admissible first.
//!
//! What this does not yet do is the graph cut. Every tetrahedron is labelled by the winding number at
//! its centroid, which is unambiguous for a cell well inside or well outside but not for one the
//! surface passes through. Resolving those optimally is the next step; measuring this first shows
//! what it is worth.

use crate::core::mesh::{IndexedMesh, Vec3};
use crate::core::bvh::{closest_point_on_triangle, Bvh};

/// How close the surface must come to a cell's centre before the label stops being a decision.
///
/// Measured in the cell's own inradius — the distance from its centre to its nearest face — because
/// that is the only length that means "inside this cell". A cell's *longest edge* was tried first
/// and is useless here: a decomposition of points that all lie on a surface is full of slivers, so
/// nearly every cell measured as straddling.
///
/// The surface passing through a cell is what the solver would need to resolve. Counting those sizes
/// that work: a handful needs a rule, tens of thousands needs a solver.
const AMBIGUOUS_INRADIUS_FRACTION: f64 = 1.0;

/// Merge vertices closer together than a rounding error, snapping to a grid fine enough that no
/// feature the mesh can carry is at risk.
///
/// A grid snap merges points that fall in the same cell but not two points either side of a cell
/// boundary, so this is not a distance query. It does not need to be: the points it is for are
/// copies of one position that differ in the last bits, and the cell is a millionth of the model.
pub(crate) fn snap_weld(mesh: &mut IndexedMesh) {
    let scale = mesh.bbox().diag().max(1e-9) as f64;
    let cell = scale * 1e-6;
    let mut map: ahash::AHashMap<[i64; 3], u32> =
        ahash::AHashMap::with_capacity(mesh.positions.len());
    let mut renumbered = vec![0u32; mesh.positions.len()];
    let mut kept: Vec<Vec3> = Vec::with_capacity(mesh.positions.len());
    for (v, p) in mesh.positions.iter().enumerate() {
        let key = [
            (p.x as f64 / cell).round() as i64,
            (p.y as f64 / cell).round() as i64,
            (p.z as f64 / cell).round() as i64,
        ];
        let next = kept.len() as u32;
        let slot = *map.entry(key).or_insert(next);
        if slot == next {
            kept.push(*p);
        }
        renumbered[v] = slot;
    }
    if kept.len() == mesh.positions.len() {
        return;
    }
    for tri in mesh.triangles.iter_mut() {
        for v in tri.iter_mut() {
            *v = renumbered[*v as usize];
        }
    }
    mesh.positions = kept;
}

/// How the decomposition is built, and what is done with the result.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TetWrapOptions {
    /// TetGen's own switches. The default reads the input as a piecewise linear complex, so the
    /// decomposition is constrained to contain the input's triangles rather than only its points.
    pub switches: String,
    /// Simplify the extracted surface to at most this many triangles. Zero keeps all of it.
    pub max_triangles: usize,
    /// Simplify the *input* by this much before decomposing it. Zero — the default — leaves the
    /// input alone, and that is deliberate.
    ///
    /// The scale is [`crate::repair::simplify_to_error`]'s, where 0.001 removes about a quarter of a
    /// dense model. Any value that does real work also *folds* it: collapsing a dense organic surface
    /// moves vertices across each other, and a constrained decomposition refuses facets that
    /// intersect. Measured on a 170k-triangle model, 0.001 collapsed it by 28 percent and the
    /// decomposition then produced nothing at all. So this mode conforms to what it is given, and the
    /// mode that both simplifies and resolves is [`crate::solid_remesh`].
    pub tolerance: f32,
}

impl Default for TetWrapOptions {
    fn default() -> Self {
        Self {
            switches: "pQ".to_string(),
            max_triangles: 0,
            tolerance: 0.0,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TetWrapReport {
    pub input_triangles: usize,
    pub points: usize,
    pub tetrahedra: usize,
    pub inside_tetrahedra: usize,
    /// Tetrahedra the surface passes through, where the label is a guess rather than a decision.
    /// The measure of how much a proper labelling would add.
    pub ambiguous_tetrahedra: usize,
    pub output_triangles: usize,
    /// Whole run.
    pub ms: f64,
    /// The tetrahedralisation alone. Worth reporting separately because it is the one part that is
    /// somebody else's code, and it is the part that would move to a GPU first.
    pub tetgen_ms: f64,
    /// Labelling every tetrahedron, which is the part that scales with the decomposition rather
    /// than the input, and the part a solver will add to.
    pub label_ms: f64,
    /// Walking the faces to keep the boundary.
    pub extract_ms: f64,
    /// True when the caller's sink stopped the run at a phase boundary, so the mesh in the outcome
    /// is the input untouched rather than a partial resample. A half-built decomposition shares
    /// nothing with the input — every triangle is new — so there is no meaningful halfway result to
    /// hand back.
    pub cancelled: bool,
}

#[derive(Debug, Clone)]
pub struct TetWrapOutcome {
    pub mesh: IndexedMesh,
    pub report: TetWrapReport,
}

/// Distance from a tetrahedron's centre to its nearest face: three times its volume over its
/// surface area. Zero for a degenerate cell, which then counts as ambiguous, correctly, because
/// nothing about it is a decision.
fn tetrahedron_inradius(p: &[[f64; 3]; 4]) -> f64 {
    let d = |i: usize, j: usize| {
        let (a, b) = (p[i], p[j]);
        (a[0] - b[0]).hypot(a[1] - b[1]).hypot(a[2] - b[2])
    };
    let area = |i: usize, j: usize, k: usize| {
        let (a, b, c) = (p[i], p[j], p[k]);
        let u = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        let v = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
        let c = (
            u.1 * v.2 - u.2 * v.1,
            u.2 * v.0 - u.0 * v.2,
            u.0 * v.1 - u.1 * v.0,
        );
        0.5 * (c.0 * c.0 + c.1 * c.1 + c.2 * c.2).sqrt()
    };
    let (a, b, c, d0) = (p[0], p[1], p[2], p[3]);
    let u = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let v = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    let w = (d0[0] - a[0], d0[1] - a[1], d0[2] - a[2]);
    let volume = (u.0 * (v.1 * w.2 - v.2 * w.1) - u.1 * (v.0 * w.2 - v.2 * w.0)
        + u.2 * (v.0 * w.1 - v.1 * w.0))
        .abs()
        / 6.0;
    let surface = area(0, 1, 2) + area(0, 1, 3) + area(0, 2, 3) + area(1, 2, 3);
    let _ = d(0, 1);
    if surface <= 0.0 {
        0.0
    } else {
        3.0 * volume / surface
    }
}

/// The four faces of a positively oriented tetrahedron, each wound so its normal points out of the
/// tetrahedron.
///
/// Stated once, as a table, because the sign convention is the kind of thing that is silently wrong
/// for months: for `(a, b, c, d)` with a positive volume, the face opposite `d` is `(a, c, b)`, and
/// the same rotation gives the other three.
fn outward_faces(t: [u32; 4]) -> [[u32; 3]; 4] {
    let [a, b, c, d] = t;
    [[a, c, b], [a, b, d], [a, d, c], [b, c, d]]
}

/// Signed volume times six of a tetrahedron. Positive means the orientation is the one
/// [`outward_faces`] assumes.
fn orientation6(points: &[[f64; 3]], t: [u32; 4]) -> f64 {
    let a = points[t[0] as usize];
    let b = points[t[1] as usize];
    let c = points[t[2] as usize];
    let d = points[t[3] as usize];
    let (ux, uy, uz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let (vx, vy, vz) = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    let (wx, wy, wz) = (d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)
}

/// Announces a pass's phases to a caller's sink and counts them.
///
/// The same shape as the shrinkwrap pass's own sink, so one Tauri sink and one progress display
/// drive both. `index` is the 1-based position among the phases announced so far; a `false` return
/// stops the run at the next phase boundary.
pub(crate) struct PhaseSink<'a> {
    sink: Option<&'a mut dyn FnMut(&str, usize) -> bool>,
    index: usize,
}

impl<'a> PhaseSink<'a> {
    pub(crate) fn new(sink: Option<&'a mut dyn FnMut(&str, usize) -> bool>) -> Self {
        Self { sink, index: 0 }
    }

    pub(crate) fn phase(&mut self, name: &str) -> bool {
        self.index += 1;
        match self.sink.as_mut() {
            Some(sink) => sink(name, self.index),
            None => true,
        }
    }
}

/// Resample `mesh` by tetrahedralising its points and keeping the inside/outside boundary.
///
/// Returns the input unchanged with a zeroed report when the decomposition cannot be built, rather
/// than an empty mesh: a resampler that fails should leave the caller with what it started with.
pub fn tet_surface(mesh: &IndexedMesh, options: &TetWrapOptions) -> TetWrapOutcome {
    tet_surface_with_progress(mesh, options, None)
}

/// Resample `mesh`, telling `sink` about each phase as it starts.
///
/// The decomposition and the winding query take tens of seconds on a large model, so a caller with
/// a UI needs to know which phase it is in rather than watching a spinner. `sink` is called with
/// the phase's name and its 1-based position, and its return value says whether to carry on,
/// mirroring [`crate::shrink_wrap::shrink_wrap_with_progress`].
///
/// Returning `false` stops the run at that phase boundary — never halfway through one, because a
/// half-built decomposition describes nothing — and the outcome is then the input mesh unchanged
/// with [`TetWrapReport::cancelled`] set. A caller that stops the run has made no change to the
/// geometry it handed in.
pub fn tet_surface_with_progress(
    mesh: &IndexedMesh,
    options: &TetWrapOptions,
    sink: Option<&mut dyn FnMut(&str, usize) -> bool>,
) -> TetWrapOutcome {
    let started = std::time::Instant::now();
    let mut phases = PhaseSink::new(sink);

    // Handed back when the decomposition cannot be built, or when the caller stops the run.
    // `cancelled` tells those two apart.
    let unchanged = |ms: f64, cancelled: bool| TetWrapOutcome {
        mesh: mesh.clone(),
        report: TetWrapReport {
            input_triangles: mesh.triangles.len(),
            points: 0,
            tetrahedra: 0,
            inside_tetrahedra: 0,
            ambiguous_tetrahedra: 0,
            output_triangles: mesh.triangles.len(),
            ms,
            tetgen_ms: 0.0,
            label_ms: 0.0,
            extract_ms: 0.0,
            cancelled,
        },
    };

    if mesh.triangles.is_empty() {
        return unchanged(started.elapsed().as_secs_f64() * 1000.0, false);
    }

    // 1. Tetrahedralise. Announced before the weld and the decomposition so a caller sees the phase
    //    it is waiting in, not the one that just finished.
    if !phases.phase("tetrahedralize") {
        return unchanged(started.elapsed().as_secs_f64() * 1000.0, true);
    }

    // Weld first. An exported soup repeats each shared coordinate bit for bit, so exact welding
    // collapses it to the model's actual points without risking two distinct points being merged,
    // and it is those points the decomposition should follow.
    let mut welded = mesh.clone();
    welded.weld_by_position();
    // Then merge what is left that is *nearly* coincident. The weld above matches exact bits, which
    // is right for agreeing with a re-read of the same bytes, but a soup computes the same corner
    // from more than one place and floating point rounds the copies apart. Those survive the exact
    // weld, they make facets overlap, and a constrained decomposition refuses a complex whose facets
    // intersect - it said as much about a sphere. Snapping to a grid this much finer than any
    // feature the mesh can carry merges them without moving the geometry anywhere it can be seen.
    snap_weld(&mut welded);
    // Orientation first, because facets have to be consistently wound for inside and outside to
    // mean anything, and a damaged export is not.
    crate::repair::repair_orientation(&mut welded);
    if options.tolerance > 0.0 {
        welded = crate::repair::simplify_to_error(welded, options.tolerance);
    }
    let points: Vec<[f64; 3]> = welded
        .positions
        .iter()
        .map(|p| [p.x as f64, p.y as f64, p.z as f64])
        .collect();

    let tetgen_started = std::time::Instant::now();
    // A PLC, not a bare point set: the triangles constrain the decomposition to contain them, and
    // that is the difference between a surface that follows the model and one with slivers reaching
    // across its cavities. TetGen refuses facets that intersect each other, so this works on input
    // whose facets are compatible; `-d`, the switch that sounds like the remedy, produces no
    // decomposition at all on a clean model, so it is not used.
    // Drop degenerate facets. Welding merges vertices that are *exactly* coincident, but a soup
    // computes the same corner more than once and floating point rounds the copies apart, so the
    // mesh can still hold triangles whose two corners are a rounding error apart. A constrained
    // decomposition refuses a complex containing those: it reports two facets intersecting, and it
    // reports it on a sphere, which has no business intersecting itself.
    let welded_triangles: Vec<[u32; 3]> = {
        let scale = welded.bbox().diag().max(1e-9) as f64;
        let area_floor = (scale * 1e-7) * (scale * 1e-7);
        welded
            .triangles
            .iter()
            .copied()
            .filter(|t| {
                if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
                    return false;
                }
                let a = welded.positions[t[0] as usize];
                let b = welded.positions[t[1] as usize];
                let c = welded.positions[t[2] as usize];
                let cross = b.sub(a).cross(c.sub(a));
                let area = 0.5
                    * ((cross.x as f64).powi(2)
                        + (cross.y as f64).powi(2)
                        + (cross.z as f64).powi(2))
                    .sqrt();
                area > area_floor
            })
            .collect()
    };
    let _dropped = welded.triangles.len() - welded_triangles.len();
    let mut welded_triangles = welded_triangles;
    let _sheets = crate::repair::drop_zero_depth_sheets(&mut welded_triangles);
    let Ok(tets) = dragonfruit_tetgen::tetrahedralize_plc(&points, &welded_triangles, &options.switches) else {
        return unchanged(started.elapsed().as_secs_f64() * 1000.0, false);
    };
    if tets.tets.is_empty() {
        return unchanged(started.elapsed().as_secs_f64() * 1000.0, false);
    }
    let tetgen_ms = tetgen_started.elapsed().as_secs_f64() * 1000.0;

    // 2. Label. The winding number at each tetrahedron's own centroid.
    if !phases.phase("label") {
        return unchanged(started.elapsed().as_secs_f64() * 1000.0, true);
    }
    let label_started = std::time::Instant::now();

    // Label. The winding number at a tetrahedron's own centroid, tested at the same half the
    // classification everywhere else uses.
    // The label, from the nearest triangle's own normal: a cell centre on the negative side of that
    // normal is behind the surface and therefore inside it.
    //
    // A global measure was tried first, the generalised winding number, and it is the wrong tool
    // here for a reason worth recording. Its value at a point depends on every triangle in the mesh,
    // so one region with inconsistent winding contaminates the whole field: measured on a damaged
    // export of 596,293 triangles with 1,896 inconsistent-winding edges, a point well outside read
    // 0.275 instead of zero, and 87 percent of the cells came out solid, which rebuilt the model as
    // a lump filling its convex hull. Orienting first does not rescue it, because the orientation
    // pass finds nothing to flip and the field is still wrong. A local question cannot be poisoned
    // from far away, which is why the voxel pass chose the same answer for the same input.
    let bvh = Bvh::build(&welded);
    let mut inside: Vec<bool> = Vec::with_capacity(tets.tets.len());
    // Signed distance to the surface, negative behind it, and the cell's own inradius. Kept because
    // the label of an ambiguous cell is worth revisiting once its neighbours are known.
    let mut signed_distance: Vec<f32> = Vec::with_capacity(tets.tets.len());
    let mut inradius_of: Vec<f32> = Vec::with_capacity(tets.tets.len());
    let mut ambiguous = 0usize;
    for t in &tets.tets {
        let mut c = [0.0f64; 3];
        for &v in t.iter() {
            let p = tets.points[v as usize];
            c[0] += p[0];
            c[1] += p[1];
            c[2] += p[2];
        }
        let corner = [
            tets.points[t[0] as usize],
            tets.points[t[1] as usize],
            tets.points[t[2] as usize],
            tets.points[t[3] as usize],
        ];
        let inradius = tetrahedron_inradius(&corner);
        let centre = Vec3::new(
            (c[0] * 0.25) as f32,
            (c[1] * 0.25) as f32,
            (c[2] * 0.25) as f32,
        );
        let Some((distance2, face)) = bvh.nearest_triangle(&welded, centre) else {
            inside.push(false);
            signed_distance.push(0.0);
            inradius_of.push(0.0);
            continue;
        };
        let [a, b, cc] = welded.tri_positions(face);
        let closest = closest_point_on_triangle(centre, a, b, cc);
        let normal = b.sub(a).cross(cc.sub(a));
        let behind = centre.sub(closest).dot(normal) < 0.0;
        let distance = distance2.sqrt();
        inside.push(behind);
        signed_distance.push(if behind { -distance } else { distance });
        inradius_of.push(inradius as f32);
        if (distance as f64) < inradius * AMBIGUOUS_INRADIUS_FRACTION {
            ambiguous += 1;
        }
    }

    let label_ms = label_started.elapsed().as_secs_f64() * 1000.0;

    // 3. Extract. Walking the faces to keep the boundary.
    if !phases.phase("extract") {
        return unchanged(started.elapsed().as_secs_f64() * 1000.0, true);
    }
    let extract_started = std::time::Instant::now();

    // Each face of a tetrahedron, keyed by its sorted vertices, remembering which tetrahedron it
    // came from. A face between an inside and an outside cell is surface; one between two of a kind
    // is interior to a label and not emitted.
    let mut faces: ahash::AHashMap<[u32; 3], Vec<usize>> =
        ahash::AHashMap::with_capacity(tets.tets.len() * 2);
    for (index, t) in tets.tets.iter().enumerate() {
        // Normalise the orientation once, here, so the face table is independent of how TetGen
        // happened to order each tetrahedron.
        let ordered = if orientation6(&tets.points, *t) >= 0.0 {
            *t
        } else {
            [t[0], t[2], t[1], t[3]]
        };
        for face in outward_faces(ordered) {
            let mut key = face;
            key.sort_unstable();
            faces.entry(key).or_default().push(index);
        }
    }

    // Adjacency, which settling the labelling needs: two cells sharing a face are neighbours, and
    // the weight is that face's area, so a boundary spanning a large face costs more than one that
    // does not. That is what stops a sliver reaching across a cavity from becoming surface.
    let mut neighbours: Vec<Vec<(u32, f32)>> = vec![Vec::new(); tets.tets.len()];
    for (key, owners) in &faces {
        if owners.len() != 2 {
            continue;
        }
        let a = tets.points[key[0] as usize];
        let b = tets.points[key[1] as usize];
        let c = tets.points[key[2] as usize];
        let u = [(b[0] - a[0]) as f32, (b[1] - a[1]) as f32, (b[2] - a[2]) as f32];
        let v = [(c[0] - a[0]) as f32, (c[1] - a[1]) as f32, (c[2] - a[2]) as f32];
        let cross = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let area = 0.5
            * ((cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]) as f64).sqrt();
        let (left, right) = (owners[0] as u32, owners[1] as u32);
        neighbours[left as usize].push((right, area as f32));
        neighbours[right as usize].push((left, area as f32));
    }

    // Settle the labelling against its own neighbours.
    //
    // The centroid test decides each cell alone, and a cell's nearest triangle is not always its
    // own: where a sliver reaches across a cavity the nearest triangle can be on the far wall, and
    // the cell ends up labelled against everything around it. That is what puts a boundary through
    // the material and leaves a flat plane across a concavity, one measured 33.7 mm across on an
    // 88 mm miniature.
    //
    // The energy is the one a minimum cut would minimise: a data term from the signed distance and
    // a boundary term charged per unit area. It is settled by iterating to a fixed point rather than
    // by solving the cut, which reaches the same objective by local search.
    //
    // Both terms are divided by the cell's own inradius so they are commensurate. That is not
    // cosmetic: a distance times an area against a bare area differ by a length, and which term wins
    // then depends on cell size rather than geometry.
    const LABEL_ROUNDS: usize = 8;
    for _round in 0..LABEL_ROUNDS {
        let mut flips = 0usize;
        for index in 0..tets.tets.len() {
            let inradius = inradius_of[index] as f64;
            if inradius <= 0.0 {
                continue;
            }
            let distance = signed_distance[index] as f64;
            let data_inside = if distance > 0.0 { distance / inradius } else { 0.0 };
            let data_outside = if distance < 0.0 { -distance / inradius } else { 0.0 };
            let scale = 1.0 / (inradius * inradius);
            let mut facing_in = 0.0f64;
            let mut facing_out = 0.0f64;
            for &(other, weight) in &neighbours[index] {
                if inside[other as usize] {
                    facing_out += weight as f64 * scale;
                } else {
                    facing_in += weight as f64 * scale;
                }
            }
            let want = data_inside + facing_in <= data_outside + facing_out;
            if want != inside[index] {
                inside[index] = want;
                flips += 1;
            }
        }
        if flips == 0 {
            break;
        }
    }

    let mut triangles: Vec<[u32; 3]> = Vec::new();
    for (key, owners) in &faces {
        let inside_count = owners.iter().filter(|&&t| inside[t]).count();
        // A face on the hull has one owner, an interior face two. Anything else is a degenerate
        // decomposition, which contributes no surface rather than a guess.
        if owners.len() > 2 {
            continue;
        }
        if owners.len() == 1 && inside_count == 0 {
            continue;
        }
        if owners.len() == 2 && inside_count != 1 {
            continue;
        }
        // Emit it wound as the inside cell has it, so the result faces outward.
        let Some(&owner) = owners.iter().find(|&&t| inside[t]) else {
            continue;
        };
        let t = tets.tets[owner];
        let ordered = if orientation6(&tets.points, t) >= 0.0 {
            t
        } else {
            [t[0], t[2], t[1], t[3]]
        };
        for face in outward_faces(ordered) {
            let mut sorted = face;
            sorted.sort_unstable();
            if &sorted == key {
                triangles.push(face);
                break;
            }
        }
    }

    let mut out = IndexedMesh {
        positions: tets
            .points
            .iter()
            .map(|p| Vec3::new(p[0] as f32, p[1] as f32, p[2] as f32))
            .collect(),
        triangles,
    };

    if options.max_triangles > 0 && out.triangles.len() > options.max_triangles {
        let diagonal = mesh.bbox().diag() as f64;
        out = crate::repair::decimate_indexed_to_budget(
            out,
            &crate::stl_budget::TriangleBudget {
                budget_tris: options.max_triangles,
                target_error: diagonal * 1e-4,
                soft_ceiling_tris: options.max_triangles * 2,
                is_decimated: true,
                bbox_diagonal_mm: diagonal,
                enable_per_section_decimation: false,
            },
        )
        .mesh;
    }

    // Scraps go last, after simplification has had its chance to merge them. A decomposition of a
    // surface's own points leaves small detached shells where the surface is thin or folded, and on
    // a damaged export that was 33 of them beside one body holding 99.9 percent of the faces. They
    // are the shards a render shows and the reason a closed, manifold result still reads as broken.
    let scraps = crate::shrink_wrap::prune_detached_pieces(&mut out);
    let _ = scraps;

    TetWrapOutcome {
        report: TetWrapReport {
            input_triangles: mesh.triangles.len(),
            points: tets.points.len(),
            tetrahedra: tets.tets.len(),
            inside_tetrahedra: inside.iter().filter(|&&i| i).count(),
            ambiguous_tetrahedra: ambiguous,
            output_triangles: out.triangles.len(),
            ms: started.elapsed().as_secs_f64() * 1000.0,
            tetgen_ms,
            label_ms,
            extract_ms: extract_started.elapsed().as_secs_f64() * 1000.0,
            cancelled: false,
        },
        mesh: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A UV sphere wound outward, emitted as a triangle soup with a vertex per corner so the weld
    /// has something to collapse, which is the shape a real export arrives in.
    fn sphere_soup(radius: f32, stacks: usize, slices: usize) -> IndexedMesh {
        let mut positions = Vec::new();
        let mut triangles = Vec::new();
        let mut corner = |p: Vec3, positions: &mut Vec<Vec3>| {
            positions.push(p);
            (positions.len() - 1) as u32
        };
        let point = |i: usize, j: usize| {
            let phi = std::f32::consts::PI * i as f32 / stacks as f32;
            let theta = std::f32::consts::TAU * j as f32 / slices as f32;
            Vec3::new(
                radius * phi.sin() * theta.cos(),
                radius * phi.cos(),
                radius * phi.sin() * theta.sin(),
            )
        };
        for i in 0..stacks {
            for j in 0..slices {
                let (p00, p10, p11, p01) = (
                    point(i, j),
                    point(i + 1, j),
                    point(i + 1, j + 1),
                    point(i, j + 1),
                );
                for tri in [[p00, p11, p10], [p00, p01, p11]] {
                    triangles.push([
                        corner(tri[0], &mut positions),
                        corner(tri[1], &mut positions),
                        corner(tri[2], &mut positions),
                    ]);
                }
            }
        }
        IndexedMesh {
            positions,
            triangles,
        }
    }

    /// The app sends this exact shape to the Tauri command, which deserialises it into
    /// `TetWrapOptions`. A field added here and not there is a command that fails at runtime and a
    /// TypeScript build that stays green, so the shape the frontend sends is pinned.
    #[test]
    fn the_options_the_app_sends_deserialize() {
        let json = r#"{"switches":"pQ","max_triangles":0,"tolerance":0}"#;
        let options: TetWrapOptions =
            serde_json::from_str(json).expect("the frontend's option shape must parse");
        assert_eq!(options.switches, "pQ");
        assert_eq!(options.max_triangles, 0);
        assert_eq!(options.tolerance, 0.0);
    }

    #[test]
    fn a_sphere_comes_back_closed_and_the_right_size() {
        let mesh = sphere_soup(1.0, 12, 16);
        let outcome = tet_surface(&mesh, &TetWrapOptions::default());
        let report = &outcome.report;
        assert!(report.tetrahedra > 0, "the decomposition should not be empty");
        // Every cell of a convex solid's decomposition is inside it: the convex hull of a sphere's
        // own points lies within the sphere, so there is no outside for a cell to be in. This
        // asserted a mix before, which was the labelling being wrong in a way the fixture could not
        // distinguish from progress.
        assert_eq!(
            report.inside_tetrahedra, report.tetrahedra,
            "a convex solid has no outside cells to find"
        );

        // The cells the surface passes through are a shell, so they are a small share of a
        // decomposition that also fills the interior. If this ever became a large share the
        // labelling would be mostly guesswork and the count would say so.
        let ambiguous_share =
            report.ambiguous_tetrahedra as f64 / report.tetrahedra as f64;
        assert!(
            ambiguous_share < 0.10,
            "the ambiguous shell is {:.1}% of the decomposition, which is too much to be a surface",
            ambiguous_share * 100.0
        );

        // The point of the whole exercise: the extracted surface is closed, with no debris.
        let composed = crate::repair::triangle_components(&outcome.mesh);
        let components = composed.iter().copied().max().unwrap_or(0) + 1;
        assert_eq!(components, 1, "the result must be one piece, got {components}");

        // Its volume should approximate the sphere's. The boundary follows tetrahedron faces
        // rather than the sphere, so it is a little under, never over.
        let volume = outcome.mesh.signed_volume().abs();
        let ideal = 4.0 / 3.0 * std::f64::consts::PI;
        assert!(
            volume > ideal * 0.85 && volume < ideal * 1.01,
            "volume {volume} should approximate {ideal}"
        );
    }

    #[test]
    fn an_empty_mesh_is_returned_unchanged() {
        let mesh = IndexedMesh {
            positions: Vec::new(),
            triangles: Vec::new(),
        };
        let outcome = tet_surface(&mesh, &TetWrapOptions::default());
        assert!(outcome.mesh.triangles.is_empty());
        assert_eq!(outcome.report.tetrahedra, 0);
        assert!(!outcome.report.cancelled);
    }

    /// The three phases are announced in order, 1-based, and none is skipped.
    #[test]
    fn phases_are_announced_in_order() {
        let mesh = sphere_soup(1.0, 10, 12);
        let mut seen: Vec<(String, usize)> = Vec::new();
        let mut sink = |name: &str, index: usize| {
            seen.push((name.to_string(), index));
            true
        };
        let out = tet_surface_with_progress(&mesh, &TetWrapOptions::default(), Some(&mut sink));

        assert!(!out.report.cancelled);
        let names: Vec<&str> = seen.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["tetrahedralize", "label", "extract"]);
        for (offset, (_, index)) in seen.iter().enumerate() {
            assert_eq!(*index, offset + 1, "phases are numbered 1-based and in order");
        }
    }

    /// A cancel at a phase boundary leaves the caller's mesh untouched. There is no half-built
    /// decomposition to hand back, so the outcome is the input with `cancelled` set.
    #[test]
    fn a_cancel_returns_the_input_unchanged() {
        let mesh = sphere_soup(1.0, 10, 12);
        let mut seen = 0usize;
        // Continue through the first phase, then stop at the second boundary.
        let mut sink = |_name: &str, _index: usize| {
            seen += 1;
            seen < 2
        };
        let out = tet_surface_with_progress(&mesh, &TetWrapOptions::default(), Some(&mut sink));

        assert!(out.report.cancelled);
        assert_eq!(out.report.tetrahedra, 0);
        assert_eq!(out.mesh.triangles, mesh.triangles);
    }

    #[test]
    fn the_face_orientation_table_faces_outward() {
        // A unit tetrahedron at the origin with positive orientation: every outward face's normal
        // must point away from the opposite vertex.
        let points = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let t = [0u32, 1, 2, 3];
        assert!(orientation6(&points, t) > 0.0, "fixture must be positively oriented");
        let opposite = [3usize, 2, 1, 0];
        for (index, face) in outward_faces(t).iter().enumerate() {
            let a = points[face[0] as usize];
            let b = points[face[1] as usize];
            let c = points[face[2] as usize];
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let p = points[opposite[index]];
            let centroid = [
                (a[0] + b[0] + c[0]) / 3.0,
                (a[1] + b[1] + c[1]) / 3.0,
                (a[2] + b[2] + c[2]) / 3.0,
            ];
            let toward = [centroid[0] - p[0], centroid[1] - p[1], centroid[2] - p[2]];
            let dot = n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2];
            assert!(dot > 0.0, "face {index} normal points into the tetrahedron, dot {dot}");
        }
    }
}
