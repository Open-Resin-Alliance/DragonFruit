//! Scanline rasterizer for V3 layer masks.
//!
//! Uses oriented segment winding to robustly union overlapping/intersecting
//! solids and avoid spurious bridge/void artifacts.

use crate::geometry::{Triangle, Vec3};
use crate::types::{LayerAreaStatsV3, SliceJobV3};

#[derive(Debug, Clone, Copy)]
struct Segment {
    x1: f32,
    y1: f32,
    dx_dy: f32,
    y_min: f32,
    y_max: f32,
    wind: i32,
}

#[inline]
fn mm_to_pixel_x(x_mm: f32, min_x_mm: f32, build_width_mm: f32, width_px: u32) -> f32 {
    let t = (x_mm - min_x_mm) / build_width_mm;
    t * ((width_px.saturating_sub(1)) as f32)
}

#[inline]
fn mm_to_pixel_y(y_mm: f32, min_y_mm: f32, build_depth_mm: f32, height_px: u32) -> f32 {
    let t = (y_mm - min_y_mm) / build_depth_mm;
    (1.0 - t) * ((height_px.saturating_sub(1)) as f32)
}

#[inline]
fn edge_plane_intersection_xy(a: Vec3, b: Vec3, z: f32) -> Option<(f32, f32)> {
    let dz1 = a.z - z;
    let dz2 = b.z - z;
    let crosses = (dz1 <= 0.0 && dz2 > 0.0) || (dz2 <= 0.0 && dz1 > 0.0);
    if !crosses {
        return None;
    }
    let denom = b.z - a.z;
    if denom.abs() < 1e-8 {
        return None;
    }
    let t = (z - a.z) / denom;
    Some((a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t))
}

#[inline]
fn distinct_points_push(points: &mut [(f32, f32); 3], count: &mut usize, candidate: (f32, f32)) {
    let eps = 1e-5;
    for i in 0..*count {
        let p = points[i];
        if (candidate.0 - p.0).abs() <= eps && (candidate.1 - p.1).abs() <= eps {
            return;
        }
    }

    if *count < 3 {
        points[*count] = candidate;
        *count += 1;
    }
}

fn build_segments_for_layer(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
) -> Vec<Segment> {
    let z_mm = ((layer_index as f32) + 0.5) * job.layer_height_mm;
    let mut segments = Vec::with_capacity(layer_indices.len());
    let min_x_mm = -job.build_width_mm * 0.5;
    let min_y_mm = -job.build_depth_mm * 0.5;

    for tri_idx in layer_indices {
        let tri = triangles[*tri_idx];
        let dir_x = tri.dir_x;
        let dir_y = tri.dir_y;

        let mut pts = [(0.0f32, 0.0f32); 3];
        let mut count = 0usize;

        if let Some(p) = edge_plane_intersection_xy(tri.a, tri.b, z_mm) {
            distinct_points_push(&mut pts, &mut count, p);
        }
        if let Some(p) = edge_plane_intersection_xy(tri.b, tri.c, z_mm) {
            distinct_points_push(&mut pts, &mut count, p);
        }
        if let Some(p) = edge_plane_intersection_xy(tri.c, tri.a, z_mm) {
            distinct_points_push(&mut pts, &mut count, p);
        }

        if count < 2 {
            continue;
        }

        let mut p0 = pts[0];
        let mut p1 = pts[1];

        // Stabilize segment direction using the triangle's precomputed
        // tri-plane/z-plane line direction so winding remains consistent.
        if dir_x.abs() > 1e-10 || dir_y.abs() > 1e-10 {
            let seg_x = p1.0 - p0.0;
            let seg_y = p1.1 - p0.1;
            if (seg_x * dir_x + seg_y * dir_y) < 0.0 {
                core::mem::swap(&mut p0, &mut p1);
            }
        }

        let x1 = mm_to_pixel_x(p0.0, min_x_mm, job.build_width_mm, job.source_width_px);
        let y1 = mm_to_pixel_y(p0.1, min_y_mm, job.build_depth_mm, job.source_height_px);
        let x2 = mm_to_pixel_x(p1.0, min_x_mm, job.build_width_mm, job.source_width_px);
        let y2 = mm_to_pixel_y(p1.1, min_y_mm, job.build_depth_mm, job.source_height_px);

        let dy = y2 - y1;
        if dy.abs() < 1e-8 {
            continue;
        }

        segments.push(Segment {
            x1,
            y1,
            dx_dy: (x2 - x1) / dy,
            y_min: y1.min(y2),
            y_max: y1.max(y2),
            wind: if dy > 0.0 { 1 } else { -1 },
        });
    }

    segments
}

fn compute_component_area_stats_8_connected(
    mask: &[u8],
    width: usize,
    height: usize,
    pixel_area_mm2: f64,
) -> (u32, f64, f64, u32) {
    let mut visited = vec![0u8; mask.len()];
    let mut stack = Vec::<usize>::new();

    let mut total_solid_pixels = 0u32;
    let mut largest_area_mm2 = 0.0f64;
    let mut smallest_area_mm2 = f64::INFINITY;
    let mut area_count = 0u32;

    for idx in 0..mask.len() {
        if mask[idx] == 0 || visited[idx] != 0 {
            continue;
        }

        area_count = area_count.saturating_add(1);
        let mut component_pixels = 0u32;

        visited[idx] = 1;
        stack.push(idx);

        while let Some(cur) = stack.pop() {
            component_pixels = component_pixels.saturating_add(1);

            let y = cur / width;
            let x = cur - (y * width);

            let y0 = y.saturating_sub(1);
            let y1 = (y + 1).min(height - 1);
            let x0 = x.saturating_sub(1);
            let x1 = (x + 1).min(width - 1);

            for ny in y0..=y1 {
                for nx in x0..=x1 {
                    if nx == x && ny == y {
                        continue;
                    }
                    let nidx = ny * width + nx;
                    if mask[nidx] == 0 || visited[nidx] != 0 {
                        continue;
                    }
                    visited[nidx] = 1;
                    stack.push(nidx);
                }
            }
        }

        total_solid_pixels = total_solid_pixels.saturating_add(component_pixels);
        let area_mm2 = (component_pixels as f64) * pixel_area_mm2;
        if area_mm2 > largest_area_mm2 {
            largest_area_mm2 = area_mm2;
        }
        if area_mm2 < smallest_area_mm2 {
            smallest_area_mm2 = area_mm2;
        }
    }

    if area_count == 0 {
        (0, 0.0, 0.0, 0)
    } else {
        (
            total_solid_pixels,
            largest_area_mm2,
            smallest_area_mm2,
            area_count,
        )
    }
}

/// Rasterize one layer into an 8-bit grayscale mask (`0` or `255`).
pub fn rasterize_layer_with_stats(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
) -> (Vec<u8>, LayerAreaStatsV3) {
    let width = job.source_width_px as usize;
    let height = job.source_height_px as usize;
    let mut mask = vec![0u8; width * height];
    let mut stats = LayerAreaStatsV3::default();

    if layer_indices.is_empty() {
        return (mask, stats);
    }

    let segments = build_segments_for_layer(job, triangles, layer_indices, layer_index);
    if segments.is_empty() {
        return (mask, stats);
    }

    let x_eps = 1e-6f32;
    let pixel_area_mm2 = ((job.build_width_mm as f64) / (job.source_width_px.max(1) as f64))
        * ((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    for y in 0..height {
        let y_sample = (y as f32) + 0.5;
        let mut intersections: Vec<(f32, i32)> = Vec::with_capacity(64);

        for seg in &segments {
            if !(y_sample >= seg.y_min && y_sample < seg.y_max) {
                continue;
            }
            let x = seg.x1 + (y_sample - seg.y1) * seg.dx_dy;
            if x.is_finite() {
                intersections.push((x, seg.wind));
            }
        }

        if intersections.is_empty() {
            continue;
        }

        intersections.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        let row_start = y * width;
        let row = &mut mask[row_start..row_start + width];

        let mut winding = 0i32;
        let mut i = 0usize;
        while i < intersections.len() {
            let x0 = intersections[i].0;
            let mut delta = 0i32;
            while i < intersections.len() && (intersections[i].0 - x0).abs() <= x_eps {
                delta += intersections[i].1;
                i += 1;
            }
            winding += delta;
            if winding == 0 || i >= intersections.len() {
                continue;
            }

            let x1 = intersections[i].0;
            let a = x0.min(x1).max(0.0);
            let b = x0.max(x1).min(width as f32);
            if b <= a {
                continue;
            }

            let start_px = a.floor() as i32;
            let end_px = b.ceil() as i32;
            if end_px <= start_px || end_px <= 0 || start_px >= width as i32 {
                continue;
            }
            let clamped_start = start_px.max(0) as usize;
            let clamped_end = ((end_px - 1).min(width as i32 - 1)) as usize;
            if clamped_end >= clamped_start {
                row[clamped_start..=clamped_end].fill(255);
                let filled = (clamped_end - clamped_start + 1) as u32;
                stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(filled);

                min_x = min_x.min(clamped_start as i32);
                max_x = max_x.max(clamped_end as i32);
                min_y = min_y.min(y as i32);
                max_y = max_y.max(y as i32);
            }
        }
    }

    if stats.total_solid_pixels > 0 {
        let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) =
            compute_component_area_stats_8_connected(&mask, width, height, pixel_area_mm2);

        stats.total_solid_pixels = total_pixels;
        let total_area = (total_pixels as f64) * pixel_area_mm2;
        stats.total_solid_area_mm2 = total_area;
        stats.largest_area_mm2 = largest_area_mm2;
        stats.smallest_area_mm2 = smallest_area_mm2;
        stats.min_x = min_x;
        stats.min_y = min_y;
        stats.max_x = max_x;
        stats.max_y = max_y;
        stats.area_count = area_count;
    }

    (mask, stats)
}

/// Rasterize one layer into an 8-bit grayscale mask (`0` or `255`).
pub fn rasterize_layer(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
) -> Vec<u8> {
    rasterize_layer_with_stats(job, triangles, layer_indices, layer_index).0
}

#[cfg(test)]
mod tests {
    use super::{rasterize_layer, rasterize_layer_with_stats};
    use crate::encoders::registry::supported_output_formats;
    use crate::geometry::parse_triangles;
    use crate::types::SliceJobV3;

    fn push_box_triangles(
        out: &mut Vec<f32>,
        cx: f32,
        cy: f32,
        z0: f32,
        z1: f32,
        sx: f32,
        sy: f32,
    ) {
        let x0 = cx - sx * 0.5;
        let x1 = cx + sx * 0.5;
        let y0 = cy - sy * 0.5;
        let y1 = cy + sy * 0.5;

        let verts = [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y1, z0],
            [x0, y1, z0],
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1],
        ];

        let faces = [
            [0usize, 1usize, 2usize],
            [0, 2, 3],
            [4, 6, 5],
            [4, 7, 6],
            [0, 4, 5],
            [0, 5, 1],
            [1, 5, 6],
            [1, 6, 2],
            [2, 6, 7],
            [2, 7, 3],
            [3, 7, 4],
            [3, 4, 0],
        ];

        for [a, b, c] in faces {
            out.extend_from_slice(&verts[a]);
            out.extend_from_slice(&verts[b]);
            out.extend_from_slice(&verts[c]);
        }
    }

    fn job_for_single_layer() -> SliceJobV3 {
        let output_format = supported_output_formats()
            .first()
            .copied()
            .unwrap_or(".placeholder");

        SliceJobV3 {
            output_format: output_format.to_string(),
            source_width_px: 256,
            source_height_px: 256,
            width_px: 256,
            height_px: 256,
            build_width_mm: 100.0,
            build_depth_mm: 100.0,
            layer_height_mm: 1.0,
            total_layers: 1,
            export_thumbnail_png_base64: None,
            png_compression_strategy: "fastest".to_string(),
            container_compression_level: 0,
            triangles_xyz: Vec::new(),
            metadata_json: "{}".to_string(),
        }
    }

    fn run_count(row: &[u8]) -> usize {
        let mut runs = 0usize;
        let mut in_run = false;
        for &px in row {
            if px > 0 {
                if !in_run {
                    runs += 1;
                    in_run = true;
                }
            } else {
                in_run = false;
            }
        }
        runs
    }

    #[test]
    fn overlapping_boxes_do_not_create_void_split() {
        let job = job_for_single_layer();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, -2.0, 0.0, 0.0, 1.0, 24.0, 24.0);
        push_box_triangles(&mut flat, 8.0, 0.0, 0.0, 1.0, 24.0, 24.0);

        let triangles = parse_triangles(&flat);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let mask = rasterize_layer(&job, &triangles, &indices, 0);

        let y = (job.source_height_px as usize) / 2;
        let row_start = y * (job.source_width_px as usize);
        let row_end = row_start + (job.source_width_px as usize);
        let row = &mask[row_start..row_end];

        assert_eq!(
            run_count(row),
            1,
            "overlapping solids should rasterize as one continuous union span"
        );
    }

    #[test]
    fn disjoint_boxes_do_not_get_bridge_lines() {
        let job = job_for_single_layer();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, -18.0, 0.0, 0.0, 1.0, 12.0, 12.0);
        push_box_triangles(&mut flat, 18.0, 0.0, 0.0, 1.0, 12.0, 12.0);

        let triangles = parse_triangles(&flat);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let mask = rasterize_layer(&job, &triangles, &indices, 0);

        let y = (job.source_height_px as usize) / 2;
        let row_start = y * (job.source_width_px as usize);
        let row_end = row_start + (job.source_width_px as usize);
        let row = &mask[row_start..row_end];

        assert_eq!(
            run_count(row),
            2,
            "disjoint solids should remain separated with no connector span"
        );
    }

    #[test]
    fn disconnected_islands_report_component_stats() {
        let job = job_for_single_layer();

        let mut flat = Vec::<f32>::new();
        // Large island
        push_box_triangles(&mut flat, -20.0, 0.0, 0.0, 1.0, 18.0, 18.0);
        // Smaller, disconnected island
        push_box_triangles(&mut flat, 20.0, 0.0, 0.0, 1.0, 8.0, 8.0);

        let triangles = parse_triangles(&flat);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let (_mask, stats) = rasterize_layer_with_stats(&job, &triangles, &indices, 0);

        assert_eq!(
            stats.area_count, 2,
            "disconnected solids should produce two 8-connected components"
        );
        assert!(
            stats.largest_area_mm2 > stats.smallest_area_mm2,
            "largest area should exceed smallest area for differently sized disconnected islands"
        );
        assert!(
            (stats.total_solid_area_mm2 - (stats.largest_area_mm2 + stats.smallest_area_mm2)).abs()
                < 1e-6,
            "total area should equal the sum of component areas"
        );
    }
}
