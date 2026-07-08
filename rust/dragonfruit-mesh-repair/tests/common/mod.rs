//! Shared programmatic fixtures for integration tests. The repo convention
//! is to build meshes in code rather than committing binary mesh files.
#![allow(dead_code)]

use dragonfruit_mesh_repair::{IndexedMesh, Vec3};

/// Deterministic xorshift64* PRNG so tests are reproducible without a `rand`
/// dependency.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform f32 in [0, 1).
    pub fn f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
    /// Uniform f32 in [lo, hi).
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f32()
    }
}

/// Axis-aligned cube with outward-wound faces.
pub fn cube_at(center: Vec3, size: f32) -> IndexedMesh {
    let h = size * 0.5;
    let (x0, y0, z0) = (center.x - h, center.y - h, center.z - h);
    let (x1, y1, z1) = (center.x + h, center.y + h, center.z + h);
    let positions = vec![
        Vec3::new(x0, y0, z0),
        Vec3::new(x1, y0, z0),
        Vec3::new(x1, y1, z0),
        Vec3::new(x0, y1, z0),
        Vec3::new(x0, y0, z1),
        Vec3::new(x1, y0, z1),
        Vec3::new(x1, y1, z1),
        Vec3::new(x0, y1, z1),
    ];
    let quads: [[u32; 4]; 6] = [
        [0, 3, 2, 1], // bottom (-z)
        [4, 5, 6, 7], // top (+z)
        [0, 1, 5, 4], // front (-y)
        [2, 3, 7, 6], // back (+y)
        [0, 4, 7, 3], // left (-x)
        [1, 2, 6, 5], // right (+x)
    ];
    let mut triangles = Vec::with_capacity(12);
    for q in quads {
        triangles.push([q[0], q[1], q[2]]);
        triangles.push([q[0], q[2], q[3]]);
    }
    IndexedMesh {
        positions,
        triangles,
    }
}

pub fn unit_cube() -> IndexedMesh {
    cube_at(Vec3::new(0.5, 0.5, 0.5), 1.0)
}

/// UV sphere, outward-wound. `rings` latitude divisions (>= 2), `segs`
/// longitude divisions (>= 3).
pub fn uv_sphere(center: Vec3, r: f32, rings: usize, segs: usize) -> IndexedMesh {
    assert!(rings >= 2 && segs >= 3);
    let mut positions = Vec::with_capacity(2 + (rings - 1) * segs);
    positions.push(Vec3::new(center.x, center.y, center.z + r)); // north pole
    for i in 1..rings {
        let theta = std::f32::consts::PI * i as f32 / rings as f32;
        let (st, ct) = theta.sin_cos();
        for j in 0..segs {
            let phi = std::f32::consts::TAU * j as f32 / segs as f32;
            let (sp, cp) = phi.sin_cos();
            positions.push(Vec3::new(
                center.x + r * st * cp,
                center.y + r * st * sp,
                center.z + r * ct,
            ));
        }
    }
    positions.push(Vec3::new(center.x, center.y, center.z - r)); // south pole
    let south = positions.len() as u32 - 1;
    let ring = |i: usize, j: usize| -> u32 { (1 + (i - 1) * segs + (j % segs)) as u32 };

    let mut triangles = Vec::new();
    for j in 0..segs {
        triangles.push([0, ring(1, j), ring(1, j + 1)]);
    }
    for i in 1..rings - 1 {
        for j in 0..segs {
            let a = ring(i, j);
            let b = ring(i + 1, j);
            let c = ring(i + 1, j + 1);
            let d = ring(i, j + 1);
            triangles.push([a, b, c]);
            triangles.push([a, c, d]);
        }
    }
    for j in 0..segs {
        triangles.push([south, ring(rings - 1, j + 1), ring(rings - 1, j)]);
    }
    IndexedMesh {
        positions,
        triangles,
    }
}

/// UV sphere with the first `punched` triangles removed (opens a hole at the
/// north-pole cap). Interior of the sphere still winds to ~1 under GWN.
pub fn punched_sphere(
    center: Vec3,
    r: f32,
    rings: usize,
    segs: usize,
    punched: usize,
) -> IndexedMesh {
    let mut m = uv_sphere(center, r, rings, segs);
    let n = punched.min(m.triangles.len());
    m.triangles.drain(0..n);
    m
}

/// A sphere with every triangle's winding inverted (points inward).
pub fn inverted_sphere(center: Vec3, r: f32, rings: usize, segs: usize) -> IndexedMesh {
    let mut m = uv_sphere(center, r, rings, segs);
    for t in &mut m.triangles {
        t.swap(1, 2);
    }
    m
}

/// Concatenate meshes into one (separate shells, indices offset).
pub fn concat(meshes: &[IndexedMesh]) -> IndexedMesh {
    let mut out = IndexedMesh::new();
    for m in meshes {
        let base = out.positions.len() as u32;
        out.positions.extend_from_slice(&m.positions);
        out.triangles
            .extend(m.triangles.iter().map(|t| [t[0] + base, t[1] + base, t[2] + base]));
    }
    out
}

/// Two unit-ish cubes overlapping along x — a self-intersecting two-shell mesh.
pub fn two_overlapping_cubes() -> IndexedMesh {
    concat(&[
        cube_at(Vec3::new(0.0, 0.0, 0.0), 2.0),
        cube_at(Vec3::new(1.2, 0.0, 0.0), 2.0),
    ])
}

/// A small closed cube nested fully inside a larger one.
pub fn nested_cubes() -> IndexedMesh {
    concat(&[
        cube_at(Vec3::new(0.0, 0.0, 0.0), 4.0),
        cube_at(Vec3::new(0.0, 0.0, 0.0), 1.0),
    ])
}

/// Axis-aligned box with independent extents (outward-wound).
pub fn box_at(center: Vec3, sx: f32, sy: f32, sz: f32) -> IndexedMesh {
    let mut m = cube_at(Vec3::ZERO, 1.0);
    for p in &mut m.positions {
        *p = Vec3::new(center.x + p.x * sx, center.y + p.y * sy, center.z + p.z * sz);
    }
    m
}

/// Mixed model+support scene: dense sphere body high above the plate plus
/// low-poly posts rising from z=0 — the height-band classifier tags the
/// sphere(s) Model and the posts Support. Optional intra-group overlaps
/// create same-group self-intersections without ever crossing groups.
pub fn model_with_posts(model_overlap: bool, posts_overlap: bool) -> IndexedMesh {
    let mut parts: Vec<IndexedMesh> = Vec::new();
    parts.push(uv_sphere(Vec3::new(0.0, 0.0, 9.0), 1.2, 24, 32));
    if model_overlap {
        parts.push(uv_sphere(Vec3::new(0.9, 0.0, 9.0), 1.2, 24, 32));
    }
    for i in 0..6 {
        let x = -5.0 + i as f32 * 2.0;
        parts.push(box_at(Vec3::new(x, 3.0, 3.0), 0.5, 0.5, 6.0));
        if posts_overlap {
            parts.push(box_at(Vec3::new(x + 0.3, 3.0, 3.0), 0.5, 0.5, 6.0));
        }
    }
    concat(&parts)
}
