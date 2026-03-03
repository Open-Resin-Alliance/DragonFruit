//! Layer indexing utilities.
//!
//! The index maps each layer to the subset of triangles that can intersect its
//! slicing plane, reducing per-layer raster work.

use crate::geometry::Triangle;

#[inline]
fn layer_range_for_triangle(
    tri: &Triangle,
    layer_height_mm: f32,
    total_layers: u32,
) -> Option<(u32, u32)> {
    if total_layers == 0 {
        return None;
    }
    let last = (total_layers as i32) - 1;
    let start = ((tri.z_min / layer_height_mm) - 0.5).ceil() as i32;
    let end = ((tri.z_max / layer_height_mm) - 0.5).floor() as i32;
    if end < 0 || start > last {
        return None;
    }
    let clamped_start = start.clamp(0, last) as u32;
    let clamped_end = end.clamp(0, last) as u32;
    if clamped_end < clamped_start {
        None
    } else {
        Some((clamped_start, clamped_end))
    }
}

/// Build a per-layer triangle lookup table using z-range overlap.
pub fn build_layer_index(
    triangles: &[Triangle],
    total_layers: u32,
    layer_height_mm: f32,
) -> Vec<Vec<usize>> {
    let mut buckets = vec![Vec::<usize>::new(); total_layers as usize];
    for (idx, tri) in triangles.iter().enumerate() {
        if let Some((start, end)) = layer_range_for_triangle(tri, layer_height_mm, total_layers) {
            for l in start..=end {
                buckets[l as usize].push(idx);
            }
        }
    }
    buckets
}
