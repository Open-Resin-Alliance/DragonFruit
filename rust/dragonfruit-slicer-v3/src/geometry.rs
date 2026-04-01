//! Geometry primitives and triangle parsing helpers for V3.

#[derive(Debug, Clone, Copy)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct Triangle {
    pub a: Vec3,
    pub b: Vec3,
    pub c: Vec3,
    pub z_min: f32,
    pub z_max: f32,
    /// Precomputed in-plane direction for tri-plane ∩ z-plane line.
    pub dir_x: f32,
    /// Precomputed in-plane direction for tri-plane ∩ z-plane line.
    pub dir_y: f32,
}

use rayon::prelude::*;

/// Parse flat `[x,y,z,...]` triangle data into typed geometry used by the slicer.
pub fn parse_triangles(flat: &[f32]) -> Vec<Triangle> {
    flat.par_chunks_exact(9)
        .map(|chunk| {
            let a = Vec3 {
                x: chunk[0],
                y: chunk[1],
                z: chunk[2],
            };
            let b = Vec3 {
                x: chunk[3],
                y: chunk[4],
                z: chunk[5],
            };
            let c = Vec3 {
                x: chunk[6],
                y: chunk[7],
                z: chunk[8],
            };

            // Direction of tri-plane and z-plane intersection line: n × +Z = (ny, -nx, 0)
            // Precompute once per triangle to stabilize segment orientation across layers.
            let ux = b.x - a.x;
            let uy = b.y - a.y;
            let uz = b.z - a.z;
            let vx = c.x - a.x;
            let vy = c.y - a.y;
            let vz = c.z - a.z;
            let nx = uy * vz - uz * vy;
            let ny = uz * vx - ux * vz;
            let dir_x = ny;
            let dir_y = -nx;

            Triangle {
                a,
                b,
                c,
                z_min: a.z.min(b.z).min(c.z),
                z_max: a.z.max(b.z).max(c.z),
                dir_x,
                dir_y,
            }
        })
        .collect()
}
