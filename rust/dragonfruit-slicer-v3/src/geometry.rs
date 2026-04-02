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

/// Parse flat `[x,y,z,...]` triangle data into typed geometry used by the slicer.
pub fn parse_triangles(flat: &[f32]) -> Vec<Triangle> {
    let mut out = Vec::with_capacity(flat.len() / 9);
    let mut i = 0;
    while i + 8 < flat.len() {
        let a = Vec3 {
            x: flat[i],
            y: flat[i + 1],
            z: flat[i + 2],
        };
        let b = Vec3 {
            x: flat[i + 3],
            y: flat[i + 4],
            z: flat[i + 5],
        };
        let c = Vec3 {
            x: flat[i + 6],
            y: flat[i + 7],
            z: flat[i + 8],
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

        out.push(Triangle {
            a,
            b,
            c,
            z_min: a.z.min(b.z).min(c.z),
            z_max: a.z.max(b.z).max(c.z),
            dir_x,
            dir_y,
        });
        i += 9;
    }
    out
}
