//! Minimal 3D vector math + indexed triangle mesh representation.
//!
//! Kept dependency-free (no `glam` here) so the crate stays lean and the
//! layout is compatible with `bytemuck` zero-copy reinterpret of staged
//! positions buffers written by `src-tauri` (f32 little-endian, 9 per tri
//! before indexing).

use bytemuck::{Pod, Zeroable};
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
    pub fn from_triangle_soup(positions: &[f32], merge_epsilon: f32) -> Self {
        let tri_count = positions.len() / 9;
        let mut out = IndexedMesh {
            positions: Vec::with_capacity(tri_count * 3 / 2),
            triangles: Vec::with_capacity(tri_count),
        };

        // First pass: bbox to derive quantization scale.
        let mut bbox = Aabb::empty();
        for chunk in positions.chunks_exact(3) {
            bbox.expand(Vec3::new(chunk[0], chunk[1], chunk[2]));
        }
        let diag = bbox.diag().max(1e-6);
        let step = (merge_epsilon * diag).max(1e-7);
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
            let base = tri * 9;
            let v0 = Vec3::new(positions[base], positions[base + 1], positions[base + 2]);
            let v1 = Vec3::new(
                positions[base + 3],
                positions[base + 4],
                positions[base + 5],
            );
            let v2 = Vec3::new(
                positions[base + 6],
                positions[base + 7],
                positions[base + 8],
            );
            let i0 = intern(v0, &mut out);
            let i1 = intern(v1, &mut out);
            let i2 = intern(v2, &mut out);
            out.triangles.push([i0, i1, i2]);
        }
        out
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
