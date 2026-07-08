//! Dual contouring of the signed narrow band (Schaefer & Ju manifold
//! variant, staged: mass-point → hermite QEF → per-sheet vertex splitting).
//!
//! Orientation contract: quads are wound so face normals point from inside
//! (negative field) to outside (positive field). Output is therefore
//! coherently outward-oriented *by construction* — downstream code must not
//! re-run ray-parity orientation votes on it.
//!
//! Missing corners: a lattice corner absent from the band is > halfwidth
//! from the surface, so it has the *same* sign as any stored neighbor (a
//! true crossing lies within ~1 voxel of the surface and both its endpoints
//! are always stored). Edges with a missing endpoint never cross; missing
//! corners must NOT be defaulted to "outside", which would contour phantom
//! walls around the deep interior of solids.

use crate::core::bvh::Bvh;
use crate::core::mesh::{IndexedMesh, Vec3};
use crate::volumetric::band::{CornerKey, SparseBand, WrapError};
use crate::volumetric::qef::QefSolver;
use rayon::prelude::*;

#[derive(Clone, Copy)]
pub struct DcOptions {
    /// Split cell vertices per connected surface sheet (manifold DC). With
    /// this off, thin walls / pinches can produce non-manifold vertices.
    pub manifold: bool,
}

impl Default for DcOptions {
    fn default() -> Self {
        Self { manifold: true }
    }
}

/// Hermite normal source: the *input* mesh + its BVH. Normals are taken from
/// the nearest input triangle — NOT the field gradient, which is smoothed
/// and washes out the very features hermite data is there to preserve.
pub struct HermiteSource<'a> {
    pub mesh: &'a IndexedMesh,
    pub bvh: &'a Bvh,
}

/// (u, v) companion axes of `a` in right-handed cyclic order, so that
/// û × v̂ = +â. Quads wound (c00, c10, c11, c01) over (u, v) then face +a.
#[inline]
fn cyc(a: usize) -> (usize, usize) {
    match a {
        0 => (1, 2),
        1 => (2, 0),
        _ => (0, 1),
    }
}

#[inline]
fn key_add(k: CornerKey, d: [i32; 3]) -> CornerKey {
    (k.0 + d[0], k.1 + d[1], k.2 + d[2])
}

#[inline]
fn axis_offset(a: usize, val: i32) -> [i32; 3] {
    let mut d = [0i32; 3];
    d[a] = val;
    d
}

/// Edge slot id within a cell: axis `a`, offsets (lu, lv) along cyc(a).
#[inline]
fn edge_slot(a: usize, lu: i32, lv: i32) -> usize {
    a * 4 + (lu as usize) * 2 + (lv as usize)
}

/// Start-corner offset (relative to the cell min corner) of an edge slot.
#[inline]
fn slot_start(slot: usize) -> (usize, [i32; 3]) {
    let a = slot / 4;
    let lu = ((slot % 4) / 2) as i32;
    let lv = (slot % 2) as i32;
    let (u, v) = cyc(a);
    let mut off = [0i32; 3];
    off[u] = lu;
    off[v] = lv;
    (a, off)
}

/// Tiny fixed-size union-find over the 12 edge slots of one cell.
struct SlotUf([u8; 12]);

impl SlotUf {
    fn new() -> Self {
        Self([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    }
    fn find(&mut self, x: u8) -> u8 {
        let mut r = x;
        while self.0[r as usize] != r {
            r = self.0[r as usize];
        }
        let mut c = x;
        while self.0[c as usize] != r {
            let next = self.0[c as usize];
            self.0[c as usize] = r;
            c = next;
        }
        r
    }
    fn union(&mut self, a: u8, b: u8) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.0[rb as usize] = ra;
        }
    }
}

struct CellOut {
    key: CornerKey,
    /// Per crossing slot: local sheet index into `verts`; 255 = no crossing.
    slot_sheet: [u8; 12],
    /// One vertex position per sheet.
    verts: smallvec::SmallVec<[Vec3; 2]>,
}

/// Extract the 0-isosurface of the signed band. Requires `apply_sign` to
/// have run. `hermite` enables feature-preserving QEF placement; without it
/// vertices sit at the mass point of edge crossings (surface-nets behavior).
pub fn dual_contour(
    band: &SparseBand,
    hermite: Option<&HermiteSource<'_>>,
    opts: &DcOptions,
) -> Result<IndexedMesh, WrapError> {
    // 1. Global crossing edges: both endpoints stored, signs differ.
    let mut crossings: Vec<(CornerKey, u8)> = band
        .keys
        .par_iter()
        .enumerate()
        .fold(Vec::new, |mut acc, (idx, &key)| {
            let inside = band.inside[idx];
            for a in 0..3usize {
                let nk = key_add(key, axis_offset(a, 1));
                if let Some(&nidx) = band.index.get(&nk) {
                    if band.inside[nidx as usize] != inside {
                        acc.push((key, a as u8));
                    }
                }
            }
            acc
        })
        .reduce(Vec::new, |mut a, mut b| {
            a.append(&mut b);
            a
        });
    if crossings.is_empty() {
        return Err(WrapError::EmptyExtraction);
    }
    crossings.par_sort_unstable();

    // 2. Active cells: the 4 cells around every crossing edge.
    let mut cell_keys: Vec<CornerKey> = crossings
        .par_iter()
        .fold(Vec::new, |mut acc, &(key, a)| {
            let (u, v) = cyc(a as usize);
            for (du, dv) in [(-1, -1), (0, -1), (0, 0), (-1, 0)] {
                let mut d = [0i32; 3];
                d[u] = du;
                d[v] = dv;
                acc.push(key_add(key, d));
            }
            acc
        })
        .reduce(Vec::new, |mut a, mut b| {
            a.append(&mut b);
            a
        });
    cell_keys.par_sort_unstable();
    cell_keys.dedup();

    // 3. Per-cell vertices (parallel, deterministic order).
    let cells: Vec<CellOut> = cell_keys
        .par_iter()
        .map(|&ck| build_cell(band, hermite, opts, ck))
        .collect();

    // Assign global vertex indices in cell order.
    let mut cell_index: ahash::AHashMap<CornerKey, u32> =
        ahash::AHashMap::with_capacity(cells.len());
    let mut vert_base: Vec<u32> = Vec::with_capacity(cells.len());
    let mut positions: Vec<Vec3> = Vec::new();
    for (ci, cell) in cells.iter().enumerate() {
        cell_index.insert(cell.key, ci as u32);
        vert_base.push(positions.len() as u32);
        positions.extend_from_slice(&cell.verts);
    }

    // 4. Quad emission per crossing edge, wound inside→outside.
    let triangles: Vec<[u32; 3]> = crossings
        .par_iter()
        .fold(Vec::new, |mut acc, &(key, a)| {
            let a = a as usize;
            let (u, v) = cyc(a);
            // Quad corners (c00, c10, c11, c01) over (u, v): cell offsets.
            let mut quad = [0u32; 4];
            let mut ok = true;
            for (qi, (du, dv)) in [(-1, -1), (0, -1), (0, 0), (-1, 0)].iter().enumerate() {
                let mut d = [0i32; 3];
                d[u] = *du;
                d[v] = *dv;
                let ck = key_add(key, d);
                let Some(&ci) = cell_index.get(&ck) else {
                    ok = false;
                    break;
                };
                let cell = &cells[ci as usize];
                let slot = edge_slot(a, -du, -dv);
                let sheet = cell.slot_sheet[slot];
                if sheet == 255 {
                    ok = false;
                    break;
                }
                quad[qi] = vert_base[ci as usize] + sheet as u32;
            }
            debug_assert!(ok, "crossing edge without 4 complete cells");
            if !ok {
                return acc;
            }
            // Lower corner inside ⇒ field rises along +a ⇒ outward = +a ⇒
            // keep (c00, c10, c11, c01) CCW order; else reverse.
            let lower_inside = {
                let idx = band.index[&key];
                band.inside[idx as usize]
            };
            let [q0, q1, q2, q3] = quad;
            let (t0, t1) = if lower_inside {
                ([q0, q1, q2], [q0, q2, q3])
            } else {
                ([q0, q3, q2], [q0, q2, q1])
            };
            // Sheet-split vertices can coincide per quad corner; skip
            // degenerate index triples.
            if t0[0] != t0[1] && t0[1] != t0[2] && t0[0] != t0[2] {
                acc.push(t0);
            }
            if t1[0] != t1[1] && t1[1] != t1[2] && t1[0] != t1[2] {
                acc.push(t1);
            }
            acc
        })
        .reduce(Vec::new, |mut a, mut b| {
            a.append(&mut b);
            a
        });

    Ok(IndexedMesh {
        positions,
        triangles,
    })
}

fn build_cell(
    band: &SparseBand,
    hermite: Option<&HermiteSource<'_>>,
    opts: &DcOptions,
    ck: CornerKey,
) -> CellOut {
    // Signed values of the 8 cell corners; None = missing (same sign as any
    // stored neighbor, so edges touching it never cross).
    let mut corner_val = [None::<f32>; 8];
    for (ci, val) in corner_val.iter_mut().enumerate() {
        let d = [(ci & 1) as i32, ((ci >> 1) & 1) as i32, ((ci >> 2) & 1) as i32];
        if let Some(&idx) = band.index.get(&key_add(ck, d)) {
            *val = Some(band.signed_at(idx));
        }
    }
    let corner_of = |off: [i32; 3]| -> usize {
        (off[0] + 2 * off[1] + 4 * off[2]) as usize
    };

    // Crossings on the cell's 12 edges.
    struct Crossing {
        slot: usize,
        p: Vec3,
        n: Vec3,
    }
    let mut crossings: smallvec::SmallVec<[Crossing; 8]> = smallvec::SmallVec::new();
    for slot in 0..12 {
        let (a, start) = slot_start(slot);
        let end = {
            let mut e = start;
            e[a] += 1;
            e
        };
        let (Some(fa), Some(fb)) = (
            corner_val[corner_of(start)],
            corner_val[corner_of(end)],
        ) else {
            continue;
        };
        if (fa < 0.0) == (fb < 0.0) {
            continue;
        }
        let t = fa / (fa - fb);
        let pa = band.corner_pos(key_add(ck, start));
        let pb = band.corner_pos(key_add(ck, end));
        let p = pa.add(pb.sub(pa).scale(t));
        // Hermite normal from the nearest input triangle, flipped to point
        // along the local inside→outside direction (broken input winds
        // inconsistently; the field sign is the trustworthy reference).
        let n = if let Some(h) = hermite {
            let (_, face, _) = h.bvh.closest_point(h.mesh, p);
            let mut n = h.mesh.tri_normal(face);
            let mut grad = Vec3::ZERO;
            match a {
                0 => grad.x = if fa < 0.0 { 1.0 } else { -1.0 },
                1 => grad.y = if fa < 0.0 { 1.0 } else { -1.0 },
                _ => grad.z = if fa < 0.0 { 1.0 } else { -1.0 },
            }
            if n.dot(grad) < 0.0 {
                n = n.scale(-1.0);
            }
            if n == Vec3::ZERO {
                n = grad;
            }
            n
        } else {
            Vec3::ZERO
        };
        crossings.push(Crossing { slot, p, n });
    }

    let mut slot_sheet = [255u8; 12];
    let mut verts: smallvec::SmallVec<[Vec3; 2]> = smallvec::SmallVec::new();
    if crossings.is_empty() {
        return CellOut {
            key: ck,
            slot_sheet,
            verts,
        };
    }

    // Sheet assignment.
    let mut uf = SlotUf::new();
    if opts.manifold {
        connect_sheets_via_faces(&corner_val, &corner_of, &mut uf);
    } else {
        // Single sheet: union every crossing slot together.
        for w in crossings.windows(2) {
            uf.union(w[0].slot as u8, w[1].slot as u8);
        }
    }

    // Group crossings by union-find root → local sheet ids (stable order).
    let cell_min = band.corner_pos(ck);
    let cell_max = band.corner_pos(key_add(ck, [1, 1, 1]));
    let mut root_to_sheet: smallvec::SmallVec<[(u8, u8); 4]> = smallvec::SmallVec::new();
    let mut solvers: smallvec::SmallVec<[QefSolver; 2]> = smallvec::SmallVec::new();
    for cr in &crossings {
        let root = uf.find(cr.slot as u8);
        let sheet = match root_to_sheet.iter().find(|(r, _)| *r == root) {
            Some((_, s)) => *s,
            None => {
                let s = solvers.len() as u8;
                root_to_sheet.push((root, s));
                solvers.push(QefSolver::new());
                s
            }
        };
        slot_sheet[cr.slot] = sheet;
        solvers[sheet as usize].add(cr.p, cr.n);
    }
    for solver in &solvers {
        let v = if hermite.is_some() {
            solver.solve(cell_min, cell_max)
        } else {
            solver.mass_point()
        };
        verts.push(v);
    }

    CellOut {
        key: ck,
        slot_sheet,
        verts,
    }
}

/// Connect crossing slots that lie on a common surface sheet, face by face
/// (Schaefer & Ju). On a face with two crossings they connect directly; four
/// crossings (saddle) are paired by the bilinear asymptotic decider so both
/// cells sharing the face agree.
fn connect_sheets_via_faces(
    corner_val: &[Option<f32>; 8],
    corner_of: &dyn Fn([i32; 3]) -> usize,
    uf: &mut SlotUf,
) {
    for n in 0..3usize {
        // Face-local axes p < q, both != n.
        let (p, q) = match n {
            0 => (1, 2),
            1 => (0, 2),
            _ => (0, 1),
        };
        for s in 0..2i32 {
            // Face corners in cyclic order c0..c3 over (p, q).
            let mk = |lp: i32, lq: i32| -> [i32; 3] {
                let mut o = [0i32; 3];
                o[n] = s;
                o[p] = lp;
                o[q] = lq;
                o
            };
            let c = [mk(0, 0), mk(1, 0), mk(1, 1), mk(0, 1)];
            let f: [Option<f32>; 4] = [
                corner_val[corner_of(c[0])],
                corner_val[corner_of(c[1])],
                corner_val[corner_of(c[2])],
                corner_val[corner_of(c[3])],
            ];
            // Face edges cyclic: e_i between c_i and c_{i+1}. Map to slots.
            let edge_of = |i: usize| -> Option<u8> {
                let (ca, cb) = (c[i], c[(i + 1) % 4]);
                let axis = (0..3).find(|&ax| ca[ax] != cb[ax])?;
                let start = if ca[axis] < cb[axis] { ca } else { cb };
                let (u, v) = cyc(axis);
                Some(edge_slot(axis, start[u], start[v]) as u8)
            };
            let crossing = |i: usize| -> bool {
                match (f[i], f[(i + 1) % 4]) {
                    (Some(a), Some(b)) => (a < 0.0) != (b < 0.0),
                    _ => false,
                }
            };
            let crossed: smallvec::SmallVec<[usize; 4]> =
                (0..4).filter(|&i| crossing(i)).collect();
            match crossed.len() {
                2 => {
                    if let (Some(a), Some(b)) = (edge_of(crossed[0]), edge_of(crossed[1])) {
                        uf.union(a, b);
                    }
                }
                4 => {
                    // Saddle: all four corners stored (else <4 crossings).
                    let f0 = f[0].unwrap();
                    let f1 = f[1].unwrap();
                    let f2 = f[2].unwrap();
                    let f3 = f[3].unwrap();
                    let denom = f0 + f2 - f1 - f3;
                    let asym = if denom.abs() > 1e-20 {
                        (f0 * f2 - f1 * f3) / denom
                    } else {
                        0.0
                    };
                    // Same sign as f0 ⇒ diagonal c0–c2 connected ⇒ contour
                    // arcs isolate c1 (edges e0,e1) and c3 (edges e2,e3);
                    // otherwise arcs isolate c0 (e3,e0) and c2 (e1,e2).
                    let pairs: [(usize, usize); 2] = if (asym < 0.0) == (f0 < 0.0) {
                        [(0, 1), (2, 3)]
                    } else {
                        [(3, 0), (1, 2)]
                    };
                    for (i, j) in pairs {
                        if let (Some(a), Some(b)) = (edge_of(i), edge_of(j)) {
                            uf.union(a, b);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}
