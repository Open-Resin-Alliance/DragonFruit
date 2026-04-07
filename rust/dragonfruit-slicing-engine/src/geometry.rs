//! Geometry primitives and triangle parsing helpers for V3.

use crate::types::SliceJobV3;

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
    /// Pixel-space coordinates of vertex A (set by `project_triangles_inplace`).
    pub px_ax: f32,
    pub px_ay: f32,
    /// Pixel-space coordinates of vertex B (set by `project_triangles_inplace`).
    pub px_bx: f32,
    pub px_by: f32,
    /// Pixel-space coordinates of vertex C (set by `project_triangles_inplace`).
    pub px_cx: f32,
    pub px_cy: f32,
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
            px_ax: 0.0,
            px_ay: 0.0,
            px_bx: 0.0,
            px_by: 0.0,
            px_cx: 0.0,
            px_cy: 0.0,
        });
        i += 9;
    }
    out
}

/// Project all triangle vertices into pixel space for the given slice job.
///
/// Must be called once after `parse_triangles()` before rasterization. This
/// precomputes per-vertex pixel coordinates so `build_segments_for_layer()`
/// can lerp directly in pixel space instead of calling mm_to_pixel_x/y per
/// intersection (eliminating 2 divisions per edge crossing per triangle).
pub fn project_triangles_inplace(triangles: &mut [Triangle], job: &SliceJobV3) {
    let min_x_mm = -job.build_width_mm * 0.5;
    let min_y_mm = -job.build_depth_mm * 0.5;
    let max_px_x = job.effective_render_width_px().saturating_sub(1) as f32;
    let max_px_y = job.source_height_px.saturating_sub(1) as f32;

    // Precompute linear transform: mm → [0..max_px]
    // Without mirror: px = (mm - min_mm) / build_mm * max_px
    // With mirror_x:  px = (1 - (mm - min_mm) / build_mm) * max_px
    // Rewrite as:     px = mm * ax + bx  (or ay/by for y)
    let ax = if job.mirror_x {
        -max_px_x / job.build_width_mm
    } else {
        max_px_x / job.build_width_mm
    };
    let bx = if job.mirror_x {
        max_px_x + min_x_mm * max_px_x / job.build_width_mm
    } else {
        -min_x_mm * max_px_x / job.build_width_mm
    };
    // y axis is flipped: py = (1 - t) * max_px_y  where t = (y_mm - min_y_mm) / build_depth_mm
    let ay = if job.mirror_y {
        max_px_y / job.build_depth_mm
    } else {
        -max_px_y / job.build_depth_mm
    };
    let by = if job.mirror_y {
        -min_y_mm * max_px_y / job.build_depth_mm
    } else {
        max_px_y + min_y_mm * max_px_y / job.build_depth_mm
    };

    for tri in triangles.iter_mut() {
        tri.px_ax = tri.a.x * ax + bx;
        tri.px_ay = tri.a.y * ay + by;
        tri.px_bx = tri.b.x * ax + bx;
        tri.px_by = tri.b.y * ay + by;
        tri.px_cx = tri.c.x * ax + bx;
        tri.px_cy = tri.c.y * ay + by;
    }
}
