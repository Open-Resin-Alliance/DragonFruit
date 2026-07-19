//! Minimal 3D vector math + indexed triangle mesh representation.
//!
//! Kept dependency-free (no `glam` here) so the crate stays lean and the
//! layout is compatible with `bytemuck` zero-copy reinterpret of staged
//! positions buffers written by `src-tauri` (f32 little-endian, 9 per tri
//! before indexing).

use bytemuck::{Pod, Zeroable};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[repr(C)]
#[derive(Copy, Clone, Debug, Default, PartialEq, Pod, Zeroable, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
    pub const ZERO: Self = Self::new(0.0, 0.0, 0.0);

    #[inline]
    pub fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    #[inline]
    pub fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    #[inline]
    pub fn scale(self, s: f32) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }
    #[inline]
    pub fn dot(self, o: Self) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    #[inline]
    pub fn cross(self, o: Self) -> Self {
        Self::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    #[inline]
    pub fn length(self) -> f32 {
        self.dot(self).sqrt()
    }
    #[inline]
    pub fn min(self, o: Self) -> Self {
        Self::new(self.x.min(o.x), self.y.min(o.y), self.z.min(o.z))
    }
    #[inline]
    pub fn max(self, o: Self) -> Self {
        Self::new(self.x.max(o.x), self.y.max(o.y), self.z.max(o.z))
    }
    #[inline]
    pub fn finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }

    /// Rotate this vector by a unit quaternion `[x, y, z, w]`.
    /// The quaternion must be normalized (unit length).
    /// Uses the standard formula: `v' = v + 2·qw·(qv×v) + 2·(qv×(qv×v))`
    /// where `qv = (qx, qy, qz)` is the vector part of the quaternion.
    #[inline]
    pub fn rotate_by_quat(self, q: [f32; 4]) -> Self {
        let [qx, qy, qz, qw] = q;
        // cross(qv, v)
        let c1_x = qy * self.z - qz * self.y;
        let c1_y = qz * self.x - qx * self.z;
        let c1_z = qx * self.y - qy * self.x;
        // t = 2 * cross(qv, v)
        let t_x = c1_x * 2.0;
        let t_y = c1_y * 2.0;
        let t_z = c1_z * 2.0;
        // cross(qv, t)
        let c2_x = qy * t_z - qz * t_y;
        let c2_y = qz * t_x - qx * t_z;
        let c2_z = qx * t_y - qy * t_x;
        // v' = v + qw * t + cross(qv, t)
        Self::new(
            self.x + qw * t_x + c2_x,
            self.y + qw * t_y + c2_y,
            self.z + qw * t_z + c2_z,
        )
    }
}

/// Axis-aligned bounding box.
#[derive(Copy, Clone, Debug, Serialize, Deserialize)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    pub fn empty() -> Self {
        Self {
            min: Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY),
            max: Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY),
        }
    }
    pub fn expand(&mut self, p: Vec3) {
        self.min = self.min.min(p);
        self.max = self.max.max(p);
    }
    pub fn union(&mut self, o: &Aabb) {
        self.min = self.min.min(o.min);
        self.max = self.max.max(o.max);
    }
    pub fn diag(&self) -> f32 {
        if self.min.x > self.max.x {
            0.0
        } else {
            self.max.sub(self.min).length()
        }
    }
    pub fn center(&self) -> Vec3 {
        self.min.add(self.max).scale(0.5)
    }
    pub fn overlaps(&self, o: &Aabb) -> bool {
        self.min.x <= o.max.x
            && self.max.x >= o.min.x
            && self.min.y <= o.max.y
            && self.max.y >= o.min.y
            && self.min.z <= o.max.z
            && self.max.z >= o.min.z
    }
}

/// Absolute upper bound (millimetres) on the vertex-weld quantization step used
/// by [`IndexedMesh::from_triangle_soup`].
///
/// The weld step is `merge_epsilon × bbox_diagonal`, which normally lands in the
/// low-µm range (≈2.8 µm for a plate at the production 1e-5 epsilon) — far below
/// any feature the slicer must resolve. But the bbox diagonal is data-dependent:
/// a single junk vertex a few metres off the part inflates the diagonal, and
/// without a cap the "coincident-vertex" weld grows to hundreds of µm and starts
/// merging genuinely distinct geometry (the reported far-apart-merge signature).
///
/// 50 µm ≈ ¼ of the smallest support-tip gap the slicer must preserve
/// (support-tip spacing bottoms out around 0.2 mm), so a step at this ceiling
/// still cannot bridge a real tip gap while it does neutralise outlier-inflated
/// diagonals. Doc discipline mirrors `src/components/scene/hollowVoxelPreviewLimits.ts`
/// (in-repo precedent for a documented, rationale-carrying resource constant).
pub const WELD_STEP_CEILING_MM: f32 = 0.050;

/// Triangle-count threshold at/above which [`IndexedMesh::from_triangle_soup`]
/// runs its bbox pass as a rayon reduction instead of a serial fold (CP5
/// rider). Below it, rayon's fork/join overhead outweighs the gain, so small
/// meshes — which is every mesh the crate's own test suite builds — take the
/// identical serial path they always did.
const PARALLEL_WELD_MIN_TRIS: usize = 50_000;

/// Clamp a raw `merge_epsilon × bbox_diagonal` weld step into the safe range:
/// an absolute ceiling of [`WELD_STEP_CEILING_MM`] (so an outlier-inflated bbox
/// cannot over-weld) and the historical `1e-7 mm` floor (so a degenerate tiny
/// mesh never yields a zero step → division by zero).
#[inline]
pub fn clamp_weld_step(raw_step: f32) -> f32 {
    raw_step.min(WELD_STEP_CEILING_MM).max(1e-7)
}

/// Input-hygiene diagnostics from
/// [`IndexedMesh::from_triangle_soup_reported`]. Surfaced so callers can report
/// dropped geometry instead of silently swallowing malformed input (plan
/// Phase 3, CP2).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriangleSoupStats {
    /// Triangles dropped at intake because at least one vertex coordinate was
    /// non-finite (NaN or ±Inf). Reported, never silently discarded.
    pub dropped_nonfinite_triangles: usize,
}

/// Indexed triangle mesh. `positions` are unique vertices; `triangles` are
/// triples of indices into `positions`. For unindexed input (raw STL), use
/// [`IndexedMesh::from_triangle_soup`] which auto-welds coincident vertices.
#[derive(Clone, Debug, Default)]
pub struct IndexedMesh {
    pub positions: Vec<Vec3>,
    pub triangles: Vec<[u32; 3]>,
}

impl IndexedMesh {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from a flat `f32` position buffer (9 floats per triangle, raw
    /// soup as used by the existing staging buffers). Auto-welds by quantizing
    /// to `merge_epsilon` relative to the bbox diagonal.
    ///
    /// Input-hygiene (plan Phase 3): triangles carrying a non-finite (NaN/±Inf)
    /// vertex coordinate are dropped before anything is measured, and the weld
    /// step is clamped to an absolute ceiling — see
    /// [`from_triangle_soup_reported`](Self::from_triangle_soup_reported) for
    /// the diagnostics counters. This wrapper preserves the historical
    /// `-> Self` signature for existing callers; the dropped-triangle count is
    /// available via the reporting variant.
    pub fn from_triangle_soup(positions: &[f32], merge_epsilon: f32) -> Self {
        Self::from_triangle_soup_reported(positions, merge_epsilon).0
    }

    /// Like [`from_triangle_soup`](Self::from_triangle_soup) but additionally
    /// returns [`TriangleSoupStats`] input-hygiene diagnostics.
    ///
    /// Correctness (plan Phase 3, CP2/CP3):
    ///  * Any triangle with a non-finite (NaN or ±Inf) vertex coordinate is
    ///    dropped and counted (`dropped_nonfinite_triangles`) — NOT silently
    ///    swallowed. This happens BEFORE the bbox pass, so a single junk
    ///    coordinate can never make the bbox diagonal infinite/NaN and thereby
    ///    collapse the whole weld to one grid cell.
    ///  * The weld step is clamped to `WELD_STEP_CEILING_MM` so a far outlier
    ///    vertex (which inflates the bbox diagonal) cannot push the
    ///    bbox-relative step past a physically meaningful weld distance.
    pub fn from_triangle_soup_reported(
        positions: &[f32],
        merge_epsilon: f32,
    ) -> (Self, TriangleSoupStats) {
        let tri_count = positions.len() / 9;
        let mut out = IndexedMesh {
            positions: Vec::with_capacity(tri_count * 3 / 2),
            triangles: Vec::with_capacity(tri_count),
        };
        let mut stats = TriangleSoupStats::default();

        // Read triangle `tri`'s three corners from the flat soup.
        let read_tri = |tri: usize| -> [Vec3; 3] {
            let base = tri * 9;
            [
                Vec3::new(positions[base], positions[base + 1], positions[base + 2]),
                Vec3::new(positions[base + 3], positions[base + 4], positions[base + 5]),
                Vec3::new(positions[base + 6], positions[base + 7], positions[base + 8]),
            ]
        };
        let tri_finite = |t: &[Vec3; 3]| t[0].finite() && t[1].finite() && t[2].finite();

        // First pass: bbox over ONLY finite triangles, so a non-finite
        // coordinate can never inflate (Inf) or NaN-poison the quant scale.
        //
        // CP5 rider (deterministic parallelization): min/max is associative and
        // commutative and — over finite floats — EXACT (no rounding), so a
        // rayon reduction yields a byte-identical diagonal to the serial fold
        // regardless of chunk split. The interning pass below stays serial to
        // preserve the first-seen vertex ordering that downstream consumers
        // (hollowing voxelization, the P1 index-staged splice) depend on. Small
        // meshes skip rayon to avoid its fork/join overhead. See the AAR for
        // why the dedup-map parallelization is deferred.
        let bbox = if tri_count >= PARALLEL_WELD_MIN_TRIS {
            positions
                .par_chunks_exact(9)
                .fold(Aabb::empty, |mut acc, t| {
                    let v0 = Vec3::new(t[0], t[1], t[2]);
                    let v1 = Vec3::new(t[3], t[4], t[5]);
                    let v2 = Vec3::new(t[6], t[7], t[8]);
                    if v0.finite() && v1.finite() && v2.finite() {
                        acc.expand(v0);
                        acc.expand(v1);
                        acc.expand(v2);
                    }
                    acc
                })
                .reduce(Aabb::empty, |mut a, b| {
                    a.union(&b);
                    a
                })
        } else {
            let mut bbox = Aabb::empty();
            for tri in 0..tri_count {
                let corners = read_tri(tri);
                if tri_finite(&corners) {
                    bbox.expand(corners[0]);
                    bbox.expand(corners[1]);
                    bbox.expand(corners[2]);
                }
            }
            bbox
        };
        let diag = bbox.diag().max(1e-6);
        let step = clamp_weld_step(merge_epsilon * diag);
        let inv_step = 1.0 / step;

        let mut map: ahash::AHashMap<(i32, i32, i32), u32> =
            ahash::AHashMap::with_capacity(tri_count * 2);

        let mut intern = |p: Vec3, out: &mut IndexedMesh| -> u32 {
            let key = (
                (p.x * inv_step).round() as i32,
                (p.y * inv_step).round() as i32,
                (p.z * inv_step).round() as i32,
            );
            *map.entry(key).or_insert_with(|| {
                let idx = out.positions.len() as u32;
                out.positions.push(p);
                idx
            })
        };

        for tri in 0..tri_count {
            let corners = read_tri(tri);
            if !tri_finite(&corners) {
                // Quarantine: a non-finite corner would map to key (0,0,0) and
                // poison every near-origin vertex. Drop the triangle, count it.
                stats.dropped_nonfinite_triangles += 1;
                continue;
            }
            let i0 = intern(corners[0], &mut out);
            let i1 = intern(corners[1], &mut out);
            let i2 = intern(corners[2], &mut out);
            out.triangles.push([i0, i1, i2]);
        }
        (out, stats)
    }

    /// Unindex into a flat soup (9 floats per triangle). Used for exporting.
    pub fn to_triangle_soup(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.triangles.len() * 9);
        for tri in &self.triangles {
            for &idx in tri {
                let p = self.positions[idx as usize];
                out.push(p.x);
                out.push(p.y);
                out.push(p.z);
            }
        }
        out
    }

    pub fn bbox(&self) -> Aabb {
        let mut b = Aabb::empty();
        for p in &self.positions {
            b.expand(*p);
        }
        b
    }

    pub fn tri_positions(&self, face: u32) -> [Vec3; 3] {
        let t = self.triangles[face as usize];
        [
            self.positions[t[0] as usize],
            self.positions[t[1] as usize],
            self.positions[t[2] as usize],
        ]
    }

    pub fn tri_area(&self, face: u32) -> f32 {
        let [a, b, c] = self.tri_positions(face);
        b.sub(a).cross(c.sub(a)).length() * 0.5
    }

    pub fn tri_normal(&self, face: u32) -> Vec3 {
        let [a, b, c] = self.tri_positions(face);
        let n = b.sub(a).cross(c.sub(a));
        let len = n.length();
        if len > 0.0 {
            n.scale(1.0 / len)
        } else {
            Vec3::ZERO
        }
    }

    /// Signed volume via divergence theorem. Positive = outward-oriented
    /// watertight mesh; negative = inverted; near-zero = non-closed / paired.
    pub fn signed_volume(&self) -> f64 {
        let mut sum = 0.0f64;
        for tri in &self.triangles {
            let a = self.positions[tri[0] as usize];
            let b = self.positions[tri[1] as usize];
            let c = self.positions[tri[2] as usize];
            sum += (a.x as f64) * ((b.y as f64) * (c.z as f64) - (b.z as f64) * (c.y as f64))
                - (a.y as f64) * ((b.x as f64) * (c.z as f64) - (b.z as f64) * (c.x as f64))
                + (a.z as f64) * ((b.x as f64) * (c.y as f64) - (b.y as f64) * (c.x as f64));
        }
        sum / 6.0
    }

    pub fn vertex_count(&self) -> usize {
        self.positions.len()
    }
    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }
}
