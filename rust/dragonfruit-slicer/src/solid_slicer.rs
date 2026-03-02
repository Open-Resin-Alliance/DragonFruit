use crate::bvh::BVHNode;
use crate::job::{SliceJob, SolidSliceJob};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;
use thiserror::Error;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

#[derive(Debug, Clone, Copy)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct Tri {
    pub a: Vec3,
    pub b: Vec3,
    pub c: Vec3,
    pub z_min: f32,
    pub z_max: f32,
    pub dir_x: f32,
    pub dir_y: f32,
}

#[derive(Debug, Clone, Copy)]
struct Segment {
    x1: f32,
    y1: f32,
    dx_dy: f32,
    y_min: f32,
    y_max: f32,
    wind: i32,
}

#[derive(Debug, Error)]
pub enum SolidSlicerError {
    #[error("solid slicing currently supports .nanodlp output only (got {0})")]
    UnsupportedOutput(String),
    #[error("invalid raster dimensions {width}x{height}")]
    InvalidDimensions { width: u32, height: u32 },
    #[error(
        "invalid layer settings: layer_height_mm={layer_height_mm}, total_layers={total_layers}"
    )]
    InvalidLayerSettings {
        layer_height_mm: f32,
        total_layers: u32,
    },
    #[error("invalid build volume dimensions: build_width_mm={build_width_mm}, build_depth_mm={build_depth_mm}")]
    InvalidBuildVolume {
        build_width_mm: f32,
        build_depth_mm: f32,
    },
    #[error("triangles_xyz length must be a multiple of 9 (got {0})")]
    InvalidTriangleBuffer(usize),
    #[error("PNG encoding failed: {0}")]
    PngEncoding(String),
    #[error("invalid packing mode: {0}")]
    InvalidPackingMode(String),
    #[error("failed to parse metadata json: {0}")]
    MetadataJson(String),
    #[error("zip writer failure: {0}")]
    ZipWrite(String),
    #[error("invalid chunk range: start_layer={start_layer}, layer_count={layer_count}, total_layers={total_layers}")]
    InvalidChunkRange {
        start_layer: u32,
        layer_count: u32,
        total_layers: u32,
    },
    #[error("slicing cancelled by user")]
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PackingMode {
    None,
    Rgb8Div3,
    Gray3Div2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AntiAliasingLevel {
    Off,
    X2,
    X4,
    X8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RasterComputeBackend {
    Auto,
    Cpu,
    Gpu,
}

fn parse_anti_aliasing_level(level: &str) -> AntiAliasingLevel {
    match level {
        "2x" => AntiAliasingLevel::X2,
        "4x" => AntiAliasingLevel::X4,
        "8x" => AntiAliasingLevel::X8,
        _ => AntiAliasingLevel::Off,
    }
}

fn parse_compute_backend(value: &str) -> RasterComputeBackend {
    match value {
        "cpu" => RasterComputeBackend::Cpu,
        "gpu" => RasterComputeBackend::Gpu,
        _ => RasterComputeBackend::Auto,
    }
}

#[inline]
fn select_raster_backend(requested: RasterComputeBackend) -> RasterComputeBackend {
    // GPU raster is slower than CPU raster due to lack of spatial acceleration (no bucketing).
    // Use CPU for rasterization; GPU pack still helps with output packing.
    match requested {
        RasterComputeBackend::Cpu => RasterComputeBackend::Cpu,
        RasterComputeBackend::Gpu => RasterComputeBackend::Cpu,
        RasterComputeBackend::Auto => RasterComputeBackend::Cpu,
    }
}

#[inline]
fn select_pack_backend(requested: RasterComputeBackend) -> RasterComputeBackend {
    // Keep rasterization on CPU (faster with spatial bucketing), but allow explicit
    // GPU selection to accelerate mask packing when available.
    match requested {
        RasterComputeBackend::Gpu => RasterComputeBackend::Gpu,
        RasterComputeBackend::Cpu | RasterComputeBackend::Auto => RasterComputeBackend::Cpu,
    }
}

fn quantize_coverage_to_level(coverage: f32, aa_level: AntiAliasingLevel) -> u8 {
    let c = coverage.clamp(0.0, 1.0);
    match aa_level {
        AntiAliasingLevel::Off => {
            if c > 0.0 {
                255
            } else {
                0
            }
        }
        AntiAliasingLevel::X2 => {
            // Slight boost so partial edge pixels cure more decisively.
            let boosted = c.powf(0.82);
            let q = (boosted * 2.0).round() / 2.0;
            (q * 255.0).round() as u8
        }
        AntiAliasingLevel::X4 => {
            // Stronger boost than 2x to reduce visible stair stepping.
            let boosted = c.powf(0.72);
            let q = (boosted * 4.0).round() / 4.0;
            (q * 255.0).round() as u8
        }
        AntiAliasingLevel::X8 => {
            // Most aggressive edge-strength curve for high-AA profiles.
            let boosted = c.powf(0.62);
            let q = (boosted * 8.0).round() / 8.0;
            (q * 255.0).round() as u8
        }
    }
}

fn parse_packing_mode(mode: &str) -> Result<PackingMode, SolidSlicerError> {
    match mode {
        "none" => Ok(PackingMode::None),
        "rgb8_div3" => Ok(PackingMode::Rgb8Div3),
        "gray3_div2" => Ok(PackingMode::Gray3Div2),
        other => Err(SolidSlicerError::InvalidPackingMode(other.to_string())),
    }
}

fn parse_png_compression_strategy(strategy: &str) -> crate::fast_png::CompressionStrategy {
    match strategy {
        "fastest" => crate::fast_png::CompressionStrategy::Fastest,
        "smallest" => crate::fast_png::CompressionStrategy::Smallest,
        "optimal" => crate::fast_png::CompressionStrategy::Optimal,
        _ => crate::fast_png::CompressionStrategy::Balanced,
    }
}

#[inline]
fn normalize_container_compression_level(raw: u8) -> u8 {
    raw.min(9)
}

#[inline]
fn should_store_layer_png_in_zip(png_strategy: crate::fast_png::CompressionStrategy) -> bool {
    // Layer PNGs are already compressed when strategy != Fastest.
    // Re-deflating these bytes at the ZIP layer is usually wasted CPU.
    png_strategy != crate::fast_png::CompressionStrategy::Fastest
}

fn should_use_bvh(triangle_count: usize, bvh_acceleration_enabled: bool) -> bool {
    if !bvh_acceleration_enabled {
        return false;
    }

    // Use BVH acceleration for large models (>10K triangles)
    const BVH_THRESHOLD: usize = 10_000;
    triangle_count > BVH_THRESHOLD
}

fn parse_triangles(flat: &[f32]) -> Result<Vec<Tri>, SolidSlicerError> {
    if flat.len() % 9 != 0 {
        return Err(SolidSlicerError::InvalidTriangleBuffer(flat.len()));
    }

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

        let z_min = a.z.min(b.z).min(c.z);
        let z_max = a.z.max(b.z).max(c.z);

        // Direction of tri-plane and z-plane intersection line: n × +Z = (ny, -nx, 0)
        // This is invariant across layers, so precompute once per triangle.
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

        out.push(Tri {
            a,
            b,
            c,
            z_min,
            z_max,
            dir_x,
            dir_y,
        });

        i += 9;
    }

    Ok(out)
}

fn mm_to_pixel_x(x_mm: f32, min_x_mm: f32, build_width_mm: f32, width_px: u32) -> f32 {
    let t = (x_mm - min_x_mm) / build_width_mm;
    t * ((width_px.saturating_sub(1)) as f32)
}

fn mm_to_pixel_y(y_mm: f32, min_y_mm: f32, build_depth_mm: f32, height_px: u32) -> f32 {
    let t = (y_mm - min_y_mm) / build_depth_mm;
    (1.0 - t) * ((height_px.saturating_sub(1)) as f32)
}

fn edge_plane_intersection_xy(a: Vec3, b: Vec3, z: f32) -> Option<(f32, f32)> {
    let dz1 = a.z - z;
    let dz2 = b.z - z;

    // Half-open edge convention to reduce double-counting when the plane passes vertices.
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

fn layer_range_for_triangle(
    tri: &Tri,
    layer_height_mm: f32,
    total_layers: u32,
) -> Option<(u32, u32)> {
    let last = (total_layers as i32) - 1;
    if last < 0 {
        return None;
    }

    // z_sample(layer) = (layer + 0.5) * layer_height_mm
    let start = ((tri.z_min / layer_height_mm) - 0.5).ceil() as i32;
    let end = ((tri.z_max / layer_height_mm) - 0.5).floor() as i32;

    if end < 0 || start > last {
        return None;
    }

    let clamped_start = start.clamp(0, last) as u32;
    let clamped_end = end.clamp(0, last) as u32;
    if clamped_end < clamped_start {
        return None;
    }

    Some((clamped_start, clamped_end))
}

fn build_layer_triangle_buckets(
    triangles: &[Tri],
    total_layers: u32,
    layer_height_mm: f32,
) -> Vec<Vec<usize>> {
    let mut buckets = vec![Vec::<usize>::new(); total_layers as usize];
    for (index, tri) in triangles.iter().enumerate() {
        if let Some((start, end)) = layer_range_for_triangle(tri, layer_height_mm, total_layers) {
            for layer in start..=end {
                buckets[layer as usize].push(index);
            }
        }
    }
    buckets
}

/// Query triangles that intersect a Z-plane using BVH acceleration
fn query_layer_triangles_bvh(
    bvh: &BVHNode,
    triangles: &[Tri],
    layer_index: u32,
    layer_height_mm: f32,
) -> Vec<usize> {
    let z_mm = ((layer_index as f32) + 0.5) * layer_height_mm;
    let mut indices = Vec::new();
    bvh.query_z_plane(z_mm, &mut indices);

    // Filter to only triangles that actually intersect this Z height
    // (BVH gives candidates, need final check)
    indices.retain(|&idx| {
        let tri = &triangles[idx];
        tri.z_min <= z_mm && tri.z_max >= z_mm
    });

    indices
}

fn build_layer_segments(
    triangles: &[Tri],
    triangle_indices: &[usize],
    z_mm: f32,
    mirror_x: bool,
    mirror_y: bool,
    min_x_mm: f32,
    min_y_mm: f32,
    build_width_mm: f32,
    build_depth_mm: f32,
    width_px: u32,
    height_px: u32,
) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::with_capacity(triangle_indices.len());

    for tri_index in triangle_indices {
        let tri = triangles[*tri_index];
        let dir_x = tri.dir_x;
        let dir_y = tri.dir_y;

        let mut points = [(0.0f32, 0.0f32); 3];
        let mut point_count = 0usize;

        if let Some(p) = edge_plane_intersection_xy(tri.a, tri.b, z_mm) {
            distinct_points_push(&mut points, &mut point_count, p);
        }
        if let Some(p) = edge_plane_intersection_xy(tri.b, tri.c, z_mm) {
            distinct_points_push(&mut points, &mut point_count, p);
        }
        if let Some(p) = edge_plane_intersection_xy(tri.c, tri.a, z_mm) {
            distinct_points_push(&mut points, &mut point_count, p);
        }

        if point_count < 2 {
            continue;
        }

        let mut p0 = points[0];
        let mut p1 = points[1];

        if dir_x.abs() > 1e-10 || dir_y.abs() > 1e-10 {
            let seg_x = p1.0 - p0.0;
            let seg_y = p1.1 - p0.1;
            if (seg_x * dir_x + seg_y * dir_y) < 0.0 {
                core::mem::swap(&mut p0, &mut p1);
            }
        }

        let p0x_mm = if mirror_x { -p0.0 } else { p0.0 };
        let p0y_mm = if mirror_y { -p0.1 } else { p0.1 };
        let p1x_mm = if mirror_x { -p1.0 } else { p1.0 };
        let p1y_mm = if mirror_y { -p1.1 } else { p1.1 };

        let x1 = mm_to_pixel_x(p0x_mm, min_x_mm, build_width_mm, width_px);
        let y1 = mm_to_pixel_y(p0y_mm, min_y_mm, build_depth_mm, height_px);
        let x2 = mm_to_pixel_x(p1x_mm, min_x_mm, build_width_mm, width_px);
        let y2 = mm_to_pixel_y(p1y_mm, min_y_mm, build_depth_mm, height_px);

        let dy = y2 - y1;
        if dy.abs() < 1e-8 {
            continue;
        }

        let wind = if dy > 0.0 { 1 } else { -1 };

        let y_min = y1.min(y2);
        let y_max = y1.max(y2);

        segments.push(Segment {
            x1,
            y1,
            dx_dy: (x2 - x1) / dy,
            y_min,
            y_max,
            wind,
        });
    }

    segments
}

fn build_row_segment_buckets(height_px: u32, segments: &[Segment]) -> Vec<Vec<usize>> {
    let mut row_buckets = vec![Vec::<usize>::new(); height_px as usize];
    let y_epsilon = 1e-9f32;

    for (seg_index, seg) in segments.iter().enumerate() {
        // Row sample is y + 0.5, and valid interval is [y_min, y_max)
        let row_start = (seg.y_min - 0.5).ceil() as i32;
        let row_end = (seg.y_max - 0.5 - y_epsilon).ceil() as i32 - 1;

        if row_end < 0 || row_start >= height_px as i32 {
            continue;
        }

        let clamped_start = row_start.clamp(0, (height_px as i32) - 1) as usize;
        let clamped_end = row_end.clamp(0, (height_px as i32) - 1) as usize;

        for row in clamped_start..=clamped_end {
            row_buckets[row].push(seg_index);
        }
    }

    row_buckets
}

fn segment_x_range(seg: &Segment) -> (f32, f32) {
    let x_at_y_min = seg.x1 + (seg.y_min - seg.y1) * seg.dx_dy;
    let x_at_y_max = seg.x1 + (seg.y_max - seg.y1) * seg.dx_dy;
    (x_at_y_min.min(x_at_y_max), x_at_y_min.max(x_at_y_max))
}

fn build_column_segment_buckets(width_px: u32, segments: &[Segment]) -> Vec<Vec<usize>> {
    let mut column_buckets = vec![Vec::<usize>::new(); width_px as usize];
    let x_epsilon = 1e-9f32;

    for (seg_index, seg) in segments.iter().enumerate() {
        if seg.dx_dy.abs() < 1e-8 {
            continue;
        }

        let (x_min, x_max) = segment_x_range(seg);
        let column_start = (x_min - 0.5).ceil() as i32;
        let column_end = (x_max - 0.5 - x_epsilon).ceil() as i32 - 1;

        if column_end < 0 || column_start >= width_px as i32 {
            continue;
        }

        let clamped_start = column_start.clamp(0, (width_px as i32) - 1) as usize;
        let clamped_end = column_end.clamp(0, (width_px as i32) - 1) as usize;

        for column in clamped_start..=clamped_end {
            column_buckets[column].push(seg_index);
        }
    }

    column_buckets
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline(always)]
fn fill_row_span_white(mask_row: &mut [u8], x_start: usize, x_end_inclusive: usize) {
    use core::arch::wasm32::{u8x16_splat, v128, v128_store};

    let span_len = x_end_inclusive + 1 - x_start;

    // Early return for tiny spans
    if span_len < 4 {
        for i in x_start..=x_end_inclusive {
            mask_row[i] = 255;
        }
        return;
    }

    let base_ptr = unsafe { mask_row.as_mut_ptr().add(x_start) };

    // Align pointer to 16-byte boundary for better SIMD performance
    let align_offset = (16 - (base_ptr as usize % 16)) % 16;
    let align_count = align_offset.min(span_len);

    // Fill unaligned portion
    unsafe {
        for i in 0..align_count {
            *base_ptr.add(i) = 255;
        }
    }

    // Fill aligned portion using SIMD
    let remaining = span_len - align_count;
    let simd_chunks = remaining / 16;
    let simd_bytes = simd_chunks * 16;

    let white = u8x16_splat(255);

    unsafe {
        for chunk in 0..simd_chunks {
            let offset = align_count + chunk * 16;
            v128_store(base_ptr.add(offset) as *mut v128, white);
        }

        // Fill remainder
        let remainder_start = align_count + simd_bytes;
        for i in 0..(span_len - align_count - simd_bytes) {
            *base_ptr.add(remainder_start + i) = 255;
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(always)]
fn fill_row_span_white(mask_row: &mut [u8], x_start: usize, x_end_inclusive: usize) {
    mask_row[x_start..=x_end_inclusive].fill(255);
}

fn rasterize_segments_solid(
    width_px: u32,
    height_px: u32,
    segments: &[Segment],
    aa_level: AntiAliasingLevel,
) -> Vec<u8> {
    let width = width_px as usize;
    let height = height_px as usize;
    let mut mask = vec![0u8; width * height];
    let mut intersections: Vec<(f32, i32)> = Vec::with_capacity(1024);
    let row_buckets = build_row_segment_buckets(height_px, segments);
    let x_epsilon = 1e-6f32;

    for y in 0..height {
        intersections.clear();
        let y_sample = (y as f32) + 0.5;

        for seg_index in &row_buckets[y] {
            let seg = segments[*seg_index];
            let x = seg.x1 + (y_sample - seg.y1) * seg.dx_dy;
            if !x.is_finite() {
                continue;
            }
            intersections.push((x, seg.wind));
        }

        if intersections.is_empty() {
            continue;
        }

        // Use insertion sort for small arrays (typical case), comparison sort for larger
        if intersections.len() <= 32 {
            for i in 1..intersections.len() {
                let key = intersections[i];
                let mut j = i;
                while j > 0 && intersections[j - 1].0 > key.0 {
                    intersections[j] = intersections[j - 1];
                    j -= 1;
                }
                intersections[j] = key;
            }
        } else {
            intersections
                .sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        }

        let row_start = y * width;
        let mut winding = 0i32;
        let mut i = 0usize;
        while i < intersections.len() {
            let x0 = intersections[i].0;
            let mut delta_wind = 0i32;

            while i < intersections.len() && (intersections[i].0 - x0).abs() <= x_epsilon {
                delta_wind += intersections[i].1;
                i += 1;
            }

            winding += delta_wind;
            if winding == 0 || i >= intersections.len() {
                continue;
            }

            let x1 = intersections[i].0;
            if (x1 - x0).abs() <= x_epsilon {
                continue;
            }

            let a = x0.min(x1).max(0.0);
            let b = x0.max(x1).min(width as f32);
            if b <= a {
                continue;
            }

            let row = &mut mask[row_start..row_start + width];

            if aa_level == AntiAliasingLevel::Off {
                // Binary on/off: fill pixels touched by coverage [a, b)
                // Use floor for left (include left-partial pixels) and ceil for right (include right-partial pixels)
                let start_px = a.floor() as i32;
                let end_px = b.ceil() as i32;
                if end_px <= start_px || end_px <= 0 || start_px >= width as i32 {
                    continue;
                }
                let clamped_start = start_px.max(0) as usize;
                let clamped_end = ((end_px - 1).min(width as i32 - 1)) as usize;
                if clamped_end >= clamped_start {
                    fill_row_span_white(row, clamped_start, clamped_end);
                }
                continue;
            }

            let start_px = a.floor() as i32;
            let end_px = (b - 1e-6).floor() as i32;
            if end_px < 0 || start_px >= width as i32 {
                continue;
            }

            let clamped_start = start_px.clamp(0, (width as i32) - 1) as usize;
            let clamped_end = end_px.clamp(0, (width as i32) - 1) as usize;

            if clamped_start == clamped_end {
                let px_left = clamped_start as f32;
                let px_right = px_left + 1.0;
                let coverage = (b.min(px_right) - a.max(px_left)).max(0.0);
                let value = quantize_coverage_to_level(coverage, aa_level);
                if value > row[clamped_start] {
                    row[clamped_start] = value;
                }
                continue;
            }

            let left_px_left = clamped_start as f32;
            let left_px_right = left_px_left + 1.0;
            let left_coverage = (b.min(left_px_right) - a.max(left_px_left)).max(0.0);
            let left_value = quantize_coverage_to_level(left_coverage, aa_level);
            if left_value > row[clamped_start] {
                row[clamped_start] = left_value;
            }

            let right_px_left = clamped_end as f32;
            let right_px_right = right_px_left + 1.0;
            let right_coverage = (b.min(right_px_right) - a.max(right_px_left)).max(0.0);
            let right_value = quantize_coverage_to_level(right_coverage, aa_level);
            if right_value > row[clamped_end] {
                row[clamped_end] = right_value;
            }

            if clamped_end > clamped_start + 1 {
                fill_row_span_white(row, clamped_start + 1, clamped_end - 1);
            }
        }
    }

    // Second-pass vertical scanline AA to reduce horizontal stair stepping.
    // This mirrors the row-based pass with column sampling for balanced X/Y behavior.
    // Skip vertical AA on very large outputs to avoid 512MB+ temporary allocations.
    let pixel_count = (width as u64) * (height as u64);
    let skip_vertical_aa_due_to_size = pixel_count > 8_000_000; // ~2880x2880+

    if aa_level != AntiAliasingLevel::Off && height >= 2 && !skip_vertical_aa_due_to_size {
        let mut mask_y = vec![0u8; width * height];
        let mut y_intersections: Vec<f32> = Vec::with_capacity(1024);
        let column_buckets = build_column_segment_buckets(width_px, segments);
        let y_epsilon = 1e-6f32;

        for x in 0..width {
            y_intersections.clear();
            let x_sample = (x as f32) + 0.5;

            for seg_index in &column_buckets[x] {
                let seg = segments[*seg_index];
                if seg.dx_dy.abs() < 1e-8 {
                    continue;
                }

                let (x_min, x_max) = segment_x_range(&seg);
                if x_sample < x_min || x_sample >= x_max {
                    continue;
                }

                let y = seg.y1 + (x_sample - seg.x1) / seg.dx_dy;
                if y.is_finite() {
                    y_intersections.push(y);
                }
            }

            if y_intersections.len() < 2 {
                continue;
            }

            if y_intersections.len() <= 32 {
                for i in 1..y_intersections.len() {
                    let key = y_intersections[i];
                    let mut j = i;
                    while j > 0 && y_intersections[j - 1] > key {
                        y_intersections[j] = y_intersections[j - 1];
                        j -= 1;
                    }
                    y_intersections[j] = key;
                }
            } else {
                y_intersections
                    .sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            }

            let mut i = 0usize;
            while i + 1 < y_intersections.len() {
                let y0 = y_intersections[i];
                let y1 = y_intersections[i + 1];
                i += 2;

                if (y1 - y0).abs() <= y_epsilon {
                    continue;
                }

                let a = y0.min(y1).max(0.0);
                let b = y0.max(y1).min(height as f32);
                if b <= a {
                    continue;
                }

                let start_px = a.floor() as i32;
                let end_px = (b - 1e-6).floor() as i32;
                if end_px < 0 || start_px >= height as i32 {
                    continue;
                }

                let clamped_start = start_px.clamp(0, (height as i32) - 1) as usize;
                let clamped_end = end_px.clamp(0, (height as i32) - 1) as usize;

                if clamped_start == clamped_end {
                    let py_top = clamped_start as f32;
                    let py_bottom = py_top + 1.0;
                    let coverage = (b.min(py_bottom) - a.max(py_top)).max(0.0);
                    let value = quantize_coverage_to_level(coverage, aa_level);
                    let idx = clamped_start * width + x;
                    if value > mask_y[idx] {
                        mask_y[idx] = value;
                    }
                    continue;
                }

                let top_py = clamped_start as f32;
                let top_coverage = (b.min(top_py + 1.0) - a.max(top_py)).max(0.0);
                let top_value = quantize_coverage_to_level(top_coverage, aa_level);
                let top_idx = clamped_start * width + x;
                if top_value > mask_y[top_idx] {
                    mask_y[top_idx] = top_value;
                }

                let bottom_py = clamped_end as f32;
                let bottom_coverage = (b.min(bottom_py + 1.0) - a.max(bottom_py)).max(0.0);
                let bottom_value = quantize_coverage_to_level(bottom_coverage, aa_level);
                let bottom_idx = clamped_end * width + x;
                if bottom_value > mask_y[bottom_idx] {
                    mask_y[bottom_idx] = bottom_value;
                }

                if clamped_end > clamped_start + 1 {
                    for y in (clamped_start + 1)..clamped_end {
                        mask_y[y * width + x] = 255;
                    }
                }
            }
        }

        for i in 0..mask.len() {
            if mask_y[i] > mask[i] {
                mask[i] = mask_y[i];
            }
        }
    }

    mask
}

#[inline]
fn rasterize_segments_with_backend(
    width_px: u32,
    height_px: u32,
    segments: &[Segment],
    aa_level: AntiAliasingLevel,
    backend: RasterComputeBackend,
) -> Vec<u8> {
    if backend == RasterComputeBackend::Gpu && aa_level == AntiAliasingLevel::Off {
        let gpu_segments: Vec<crate::gpu_raster::GpuSegment> = segments
            .iter()
            .map(|s| crate::gpu_raster::GpuSegment {
                x1: s.x1,
                y1: s.y1,
                dx_dy: s.dx_dy,
                y_min: s.y_min,
                y_max: s.y_max,
                wind: s.wind,
                _pad: 0,
            })
            .collect();

        if let Some(mask) =
            crate::gpu_raster::try_rasterize_binary_gpu(&gpu_segments, width_px, height_px)
        {
            return mask;
        }
    }

    rasterize_segments_solid(width_px, height_px, segments, aa_level)
}

fn encode_grayscale_png_with_strategy(
    width_px: u32,
    height_px: u32,
    pixels: &[u8],
    strategy: crate::fast_png::CompressionStrategy,
) -> Result<Vec<u8>, SolidSlicerError> {
    // For the fastest strategy, bypass flate2 entirely and use the raw PNG
    // encoder which writes stored DEFLATE blocks directly (pure memcpy speed).
    if strategy == crate::fast_png::CompressionStrategy::Fastest {
        return crate::fast_png::encode_raw_png(width_px, height_px, pixels)
            .map_err(|err| SolidSlicerError::PngEncoding(err.to_string()));
    }

    // Other strategies use the full FastPngEncoder with flate2 compression.
    use crate::fast_png::FastPngEncoder;
    let config = crate::fast_png::FastPngConfig::from_strategy(strategy);
    FastPngEncoder::new(width_px, height_px, config)
        .and_then(|encoder| encoder.encode(pixels))
        .map_err(|err| SolidSlicerError::PngEncoding(err.to_string()))
}

fn merge_mask_max(dst: &mut [u8], src: &[u8]) {
    for (d, s) in dst.iter_mut().zip(src.iter()) {
        if *s > *d {
            *d = *s;
        }
    }
}

fn rasterize_mask_for_triangle_indices(
    triangles: &[Tri],
    triangle_indices: &[usize],
    z_mm: f32,
    mirror_x: bool,
    mirror_y: bool,
    min_x_mm: f32,
    min_y_mm: f32,
    build_width_mm: f32,
    build_depth_mm: f32,
    source_width_px: u32,
    source_height_px: u32,
    aa_level: AntiAliasingLevel,
) -> Option<Vec<u8>> {
    if triangle_indices.is_empty() {
        return None;
    }

    let segments = build_layer_segments(
        triangles,
        triangle_indices,
        z_mm,
        mirror_x,
        mirror_y,
        min_x_mm,
        min_y_mm,
        build_width_mm,
        build_depth_mm,
        source_width_px,
        source_height_px,
    );

    if segments.is_empty() {
        return None;
    }

    Some(rasterize_segments_with_backend(
        source_width_px,
        source_height_px,
        &segments,
        aa_level,
        RasterComputeBackend::Cpu,
    ))
}

fn rasterize_mask_for_triangle_indices_with_backend(
    triangles: &[Tri],
    triangle_indices: &[usize],
    z_mm: f32,
    mirror_x: bool,
    mirror_y: bool,
    min_x_mm: f32,
    min_y_mm: f32,
    build_width_mm: f32,
    build_depth_mm: f32,
    source_width_px: u32,
    source_height_px: u32,
    aa_level: AntiAliasingLevel,
    backend: RasterComputeBackend,
) -> Option<Vec<u8>> {
    if triangle_indices.is_empty() {
        return None;
    }

    let segments = build_layer_segments(
        triangles,
        triangle_indices,
        z_mm,
        mirror_x,
        mirror_y,
        min_x_mm,
        min_y_mm,
        build_width_mm,
        build_depth_mm,
        source_width_px,
        source_height_px,
    );

    if segments.is_empty() {
        return None;
    }

    Some(rasterize_segments_with_backend(
        source_width_px,
        source_height_px,
        &segments,
        aa_level,
        backend,
    ))
}

fn pack_mask_to_nanodlp_png(
    source_mask: &[u8],
    source_width_px: u32,
    source_height_px: u32,
    output_width_px: u32,
    output_height_px: u32,
    packing_mode: PackingMode,
    png_strategy: crate::fast_png::CompressionStrategy,
) -> Result<Vec<u8>, SolidSlicerError> {
    if source_height_px != output_height_px {
        return Err(SolidSlicerError::InvalidDimensions {
            width: output_width_px,
            height: output_height_px,
        });
    }

    let src_w = source_width_px as usize;
    let out_w = output_width_px as usize;
    let out_h = output_height_px as usize;

    match packing_mode {
        PackingMode::None => {
            if source_width_px != output_width_px {
                return Err(SolidSlicerError::InvalidDimensions {
                    width: output_width_px,
                    height: output_height_px,
                });
            }
            encode_grayscale_png_with_strategy(
                output_width_px,
                output_height_px,
                source_mask,
                png_strategy,
            )
        }
        PackingMode::Rgb8Div3 => {
            let mut packed = vec![0u8; out_w * out_h];
            let required_subpixels = out_w.saturating_mul(3);
            let pad_total = required_subpixels.saturating_sub(src_w);
            let pad_left = pad_total / 2;

            for y in 0..out_h {
                let src_row = y * src_w;
                let out_row = y * out_w;
                for x in 0..out_w {
                    let sx = (x as isize * 3) - (pad_left as isize);
                    let r = if sx >= 0 && (sx as usize) < src_w {
                        source_mask[src_row + (sx as usize)] as u16
                    } else {
                        0
                    };
                    let g = if sx + 1 >= 0 && ((sx + 1) as usize) < src_w {
                        source_mask[src_row + ((sx + 1) as usize)] as u16
                    } else {
                        0
                    };
                    let b = if sx + 2 >= 0 && ((sx + 2) as usize) < src_w {
                        source_mask[src_row + ((sx + 2) as usize)] as u16
                    } else {
                        0
                    };
                    let gray = ((r + g + b) / 3) as u8;
                    packed[out_row + x] = gray;
                }
            }

            encode_grayscale_png_with_strategy(
                output_width_px,
                output_height_px,
                &packed,
                png_strategy,
            )
        }
        PackingMode::Gray3Div2 => {
            let mut packed = vec![0u8; out_w * out_h];
            let required_subpixels = out_w.saturating_mul(2);
            let pad_total = required_subpixels.saturating_sub(src_w);
            let pad_left = pad_total / 2;

            for y in 0..out_h {
                let src_row = y * src_w;
                let out_row = y * out_w;
                for x in 0..out_w {
                    let sx = (x as isize * 2) - (pad_left as isize);
                    let a = if sx >= 0 && (sx as usize) < src_w {
                        source_mask[src_row + (sx as usize)] as u16
                    } else {
                        0
                    };
                    let b = if sx + 1 >= 0 && ((sx + 1) as usize) < src_w {
                        source_mask[src_row + ((sx + 1) as usize)] as u16
                    } else {
                        0
                    };
                    let gray = ((a + b) >> 1) as u8;
                    packed[out_row + x] = gray;
                }
            }

            encode_grayscale_png_with_strategy(
                output_width_px,
                output_height_px,
                &packed,
                png_strategy,
            )
        }
    }
}

fn pack_mask_to_nanodlp_png_with_backend(
    source_mask: &[u8],
    source_width_px: u32,
    source_height_px: u32,
    output_width_px: u32,
    output_height_px: u32,
    packing_mode: PackingMode,
    png_strategy: crate::fast_png::CompressionStrategy,
    backend: RasterComputeBackend,
) -> Result<Vec<u8>, SolidSlicerError> {
    if backend == RasterComputeBackend::Gpu {
        let gpu_mode = match packing_mode {
            PackingMode::None => crate::gpu_pack::GpuPackingMode::None,
            PackingMode::Rgb8Div3 => crate::gpu_pack::GpuPackingMode::Rgb8Div3,
            PackingMode::Gray3Div2 => crate::gpu_pack::GpuPackingMode::Gray3Div2,
        };

        if let Some(packed) = crate::gpu_pack::try_pack_mask_gpu(
            source_mask,
            source_width_px,
            source_height_px,
            output_width_px,
            output_height_px,
            gpu_mode,
        ) {
            return encode_grayscale_png_with_strategy(
                output_width_px,
                output_height_px,
                &packed,
                png_strategy,
            );
        }
    }

    pack_mask_to_nanodlp_png(
        source_mask,
        source_width_px,
        source_height_px,
        output_width_px,
        output_height_px,
        packing_mode,
        png_strategy,
    )
}

fn extract_printer_name(root: &Value) -> String {
    root.get("printer")
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Athena")
        .to_string()
}

fn extract_source_file(root: &Value) -> String {
    root.get("sourceFile")
        .and_then(Value::as_str)
        .unwrap_or("dragonfruit_export")
        .to_string()
}

fn extract_mirror_flags(root: &Value) -> (bool, bool) {
    let printer = root.get("printer");

    let mirror_x_direct = printer
        .and_then(|p| p.get("mirrorX"))
        .and_then(Value::as_bool);
    let mirror_y_direct = printer
        .and_then(|p| p.get("mirrorY"))
        .and_then(Value::as_bool);

    let mirror_x_display = printer
        .and_then(|p| p.get("display"))
        .and_then(|d| d.get("mirrorX"))
        .and_then(Value::as_bool);
    let mirror_y_display = printer
        .and_then(|p| p.get("display"))
        .and_then(|d| d.get("mirrorY"))
        .and_then(Value::as_bool);

    (
        mirror_x_direct.or(mirror_x_display).unwrap_or(false),
        mirror_y_direct.or(mirror_y_display).unwrap_or(false),
    )
}

fn build_plate_json(job: &SolidSliceJob, source_metadata: &Value) -> Value {
    let total_layers = job.total_layers;
    let z_max_mm = (job.layer_height_mm as f64) * (total_layers as f64);

    json!({
        "PlateID": 0,
        "ProfileID": 0,
        "Profile": Value::Null,
        "CreatedDate": 0,
        "Path": "",
        "LayersCount": total_layers,
        "Processed": true,
        "TotalSolidArea": 0.0,
        "MultiMaterial": false,
        "MC": {
            "StartX": 0,
            "StartY": 0,
            "Width": 0,
            "Height": 0,
            "X": Value::Null,
            "Y": Value::Null,
            "MultiCureGap": 0,
            "Count": 0
        },
        "XMin": 0.0,
        "XMax": 0.0,
        "YMin": 0.0,
        "YMax": 0.0,
        "ZMin": 0.0,
        "ZMax": z_max_mm,
        "_dragonfruit": {
            "source": "dragonfruit-wasm",
            "upstreamRef": "Open-Resin-Alliance/VoxelShift",
            "metadata": source_metadata
        }
    })
}

fn build_profile_json(job: &SolidSliceJob, source_metadata: &Value) -> Value {
    let printer_name = extract_printer_name(source_metadata);
    let source_file = extract_source_file(source_metadata);
    let (mirror_x, _) = extract_mirror_flags(source_metadata);
    let thickness_um = ((job.layer_height_mm as f64) * 1000.0).round();

    json!({
        "ResinID": 0,
        "ProfileID": 0,
        "Title": format!("DragonFruit — {}", printer_name),
        "Desc": format!("Imported from {} via DragonFruit", source_file),
        "Thickness": thickness_um,
        "XOffset": (job.width_px / 2),
        "YOffset": (job.height_px / 2),
        "ZOffset": 0,
        "AutoCenter": 0,
        "XPixelSize": 0.0,
        "YPixelSize": 0.0,
        "ImageMirror": if mirror_x { 1 } else { 0 },
        "DisplayController": 1,
        "Boundary": {
            "XMin": 0.0,
            "XMax": 0.0,
            "YMin": 0.0,
            "YMax": 0.0,
            "ZMin": 0.0,
            "ZMax": (job.layer_height_mm as f64) * (job.total_layers as f64)
        },
        "Area": { "PlateID": 0, "Layers": [], "Kill": false }
    })
}

fn build_options_json(job: &SolidSliceJob) -> Value {
    let depth_um = ((job.layer_height_mm as f64) * 1000.0).round();
    json!({
        "PWidth": job.width_px,
        "PHeight": job.height_px,
        "SupportDepth": depth_um,
        "Depth": depth_um,
        "LiftSpeed": 0.0,
        "RetractSpeed": 0.0,
        "CureTime": 0.0,
        "ExportType": 0,
        "OutputPath": "",
        "Suffix": "",
        "SkipEmpty": 0,
        "FillColorRGB": { "R": 255, "G": 255, "B": 255, "A": 255 },
        "BlankColorRGB": { "R": 0, "G": 0, "B": 0, "A": 255 }
    })
}

fn build_meta_json() -> Value {
    json!({
        "format_version": 2,
        "distro": "athena",
        "program": "DragonFruit",
        "version": "0.1.0",
        "os": "windows",
        "arch": "x86_64",
        "profile": false
    })
}

fn build_slicer_json(job: &SolidSliceJob) -> Value {
    let thickness_um = ((job.layer_height_mm as f64) * 1000.0).round();
    let x_pixel_size = if job.width_px > 0 {
        (job.build_width_mm as f64) / (job.width_px as f64)
    } else {
        0.0
    };
    let y_pixel_size = if job.height_px > 0 {
        (job.build_depth_mm as f64) / (job.height_px as f64)
    } else {
        0.0
    };

    json!({
        "Type": "cws",
        "URL": "",
        "PWidth": job.width_px,
        "PHeight": job.height_px,
        "ScaleFactor": 0,
        "StartLayer": 0,
        "SupportDepth": thickness_um,
        "SupportLayerNumber": 0,
        "Thickness": thickness_um,
        "XOffset": (job.width_px / 2),
        "YOffset": (job.height_px / 2),
        "ZOffset": 0,
        "XPixelSize": x_pixel_size,
        "YPixelSize": y_pixel_size,
        "Mask": Value::Null,
        "AutoCenter": 0,
        "SliceFromZero": false,
        "DisableValidator": false,
        "PreviewGenerate": false,
        "Running": false,
        "Debug": false,
        "IsFaulty": false,
        "Corrupted": false,
        "MultiMaterial": false,
        "AdaptExport": "",
        "PreviewColor": "",
        "FaultyLayers": Value::Null,
        "OverhangLayers": Value::Null,
        "LayerStatus": Value::Null,
        "File": "/job.cws",
        "FileSize": 0,
        "LayerCount": job.total_layers,
        "Boundary": {
            "XMin": 0,
            "XMax": 0,
            "YMin": 0,
            "YMax": 0,
            "ZMin": 0,
            "ZMax": (job.layer_height_mm as f64) * (job.total_layers as f64)
        },
        "Area": {
            "PlateID": 0,
            "Layers": [],
            "TotalSolidArea": 0.0,
            "Kill": false
        },
        "MC": {
            "StartX": 0,
            "StartY": 0,
            "Width": 0,
            "Height": 0,
            "X": Value::Null,
            "Y": Value::Null,
            "MultiCureGap": 0,
            "Count": 0
        }
    })
}

fn json_pretty_bytes(value: &Value) -> Result<Vec<u8>, SolidSlicerError> {
    serde_json::to_vec_pretty(value).map_err(|err| SolidSlicerError::MetadataJson(err.to_string()))
}

fn validate_solid_job(job: &SolidSliceJob) -> Result<(), SolidSlicerError> {
    if job.width_px == 0
        || job.height_px == 0
        || job.source_width_px == 0
        || job.source_height_px == 0
    {
        return Err(SolidSlicerError::InvalidDimensions {
            width: job.width_px,
            height: job.height_px,
        });
    }

    if !(job.layer_height_mm.is_finite() && job.layer_height_mm > 0.0) || job.total_layers == 0 {
        return Err(SolidSlicerError::InvalidLayerSettings {
            layer_height_mm: job.layer_height_mm,
            total_layers: job.total_layers,
        });
    }

    if !(job.build_width_mm.is_finite() && job.build_width_mm > 0.0)
        || !(job.build_depth_mm.is_finite() && job.build_depth_mm > 0.0)
    {
        return Err(SolidSlicerError::InvalidBuildVolume {
            build_width_mm: job.build_width_mm,
            build_depth_mm: job.build_depth_mm,
        });
    }

    Ok(())
}

fn render_layer_png(
    job: &SolidSliceJob,
    triangles: &[Tri],
    layer_buckets: &[Vec<usize>],
    packing_mode: PackingMode,
    png_strategy: crate::fast_png::CompressionStrategy,
    mirror_x: bool,
    mirror_y: bool,
    min_x_mm: f32,
    min_y_mm: f32,
    aa_level: AntiAliasingLevel,
    layer_index: u32,
    empty_layer_png: &mut Option<Vec<u8>>,
) -> Result<Vec<u8>, SolidSlicerError> {
    let z_mm = ((layer_index as f32) + 0.5) * job.layer_height_mm;
    let triangle_indices = &layer_buckets[layer_index as usize];

    if triangle_indices.is_empty() {
        if empty_layer_png.is_none() {
            let empty_mask =
                vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
            *empty_layer_png = Some(pack_mask_to_nanodlp_png(
                &empty_mask,
                job.source_width_px,
                job.source_height_px,
                job.width_px,
                job.height_px,
                packing_mode,
                png_strategy,
            )?);
        }

        return Ok(empty_layer_png.clone().unwrap_or_default());
    }

    let use_support_aware_aa = aa_level != AntiAliasingLevel::Off
        && !job.aa_on_supports
        && job.model_triangle_count > 0
        && job.model_triangle_count < triangles.len();

    let mask = if use_support_aware_aa {
        let mut model_indices = Vec::with_capacity(triangle_indices.len());
        let mut support_indices = Vec::with_capacity(triangle_indices.len());
        for tri_index in triangle_indices {
            if *tri_index < job.model_triangle_count {
                model_indices.push(*tri_index);
            } else {
                support_indices.push(*tri_index);
            }
        }

        let mut merged =
            vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
        let mut wrote_any = false;

        if let Some(model_mask) = rasterize_mask_for_triangle_indices(
            triangles,
            &model_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            aa_level,
        ) {
            merge_mask_max(&mut merged, &model_mask);
            wrote_any = true;
        }

        if let Some(support_mask) = rasterize_mask_for_triangle_indices(
            triangles,
            &support_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            AntiAliasingLevel::Off,
        ) {
            merge_mask_max(&mut merged, &support_mask);
            wrote_any = true;
        }

        if !wrote_any {
            if empty_layer_png.is_none() {
                let empty_mask =
                    vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
                *empty_layer_png = Some(pack_mask_to_nanodlp_png(
                    &empty_mask,
                    job.source_width_px,
                    job.source_height_px,
                    job.width_px,
                    job.height_px,
                    packing_mode,
                    png_strategy,
                )?);
            }

            return Ok(empty_layer_png.clone().unwrap_or_default());
        }

        merged
    } else {
        let Some(mask) = rasterize_mask_for_triangle_indices(
            triangles,
            triangle_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            aa_level,
        ) else {
            if empty_layer_png.is_none() {
                let empty_mask =
                    vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
                *empty_layer_png = Some(pack_mask_to_nanodlp_png(
                    &empty_mask,
                    job.source_width_px,
                    job.source_height_px,
                    job.width_px,
                    job.height_px,
                    packing_mode,
                    png_strategy,
                )?);
            }

            return Ok(empty_layer_png.clone().unwrap_or_default());
        };

        mask
    };

    pack_mask_to_nanodlp_png(
        &mask,
        job.source_width_px,
        job.source_height_px,
        job.width_px,
        job.height_px,
        packing_mode,
        png_strategy,
    )
}

/// BVH-accelerated version of render_layer_png for large models
fn render_layer_png_bvh(
    job: &SolidSliceJob,
    triangles: &[Tri],
    bvh: &BVHNode,
    packing_mode: PackingMode,
    png_strategy: crate::fast_png::CompressionStrategy,
    mirror_x: bool,
    mirror_y: bool,
    min_x_mm: f32,
    min_y_mm: f32,
    aa_level: AntiAliasingLevel,
    layer_index: u32,
    empty_layer_png: &mut Option<Vec<u8>>,
) -> Result<Vec<u8>, SolidSlicerError> {
    let z_mm = ((layer_index as f32) + 0.5) * job.layer_height_mm;

    // Query BVH for candidate triangles
    let triangle_indices =
        query_layer_triangles_bvh(bvh, triangles, layer_index, job.layer_height_mm);

    if triangle_indices.is_empty() {
        if empty_layer_png.is_none() {
            let empty_mask =
                vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
            *empty_layer_png = Some(pack_mask_to_nanodlp_png(
                &empty_mask,
                job.source_width_px,
                job.source_height_px,
                job.width_px,
                job.height_px,
                packing_mode,
                png_strategy,
            )?);
        }

        return Ok(empty_layer_png.clone().unwrap_or_default());
    }

    let use_support_aware_aa = aa_level != AntiAliasingLevel::Off
        && !job.aa_on_supports
        && job.model_triangle_count > 0
        && job.model_triangle_count < triangles.len();

    let mask = if use_support_aware_aa {
        let mut model_indices = Vec::with_capacity(triangle_indices.len());
        let mut support_indices = Vec::with_capacity(triangle_indices.len());
        for tri_index in &triangle_indices {
            if *tri_index < job.model_triangle_count {
                model_indices.push(*tri_index);
            } else {
                support_indices.push(*tri_index);
            }
        }

        let mut merged =
            vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
        let mut wrote_any = false;

        if let Some(model_mask) = rasterize_mask_for_triangle_indices(
            triangles,
            &model_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            aa_level,
        ) {
            merge_mask_max(&mut merged, &model_mask);
            wrote_any = true;
        }

        if let Some(support_mask) = rasterize_mask_for_triangle_indices(
            triangles,
            &support_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            AntiAliasingLevel::Off,
        ) {
            merge_mask_max(&mut merged, &support_mask);
            wrote_any = true;
        }

        if !wrote_any {
            if empty_layer_png.is_none() {
                let empty_mask =
                    vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
                *empty_layer_png = Some(pack_mask_to_nanodlp_png(
                    &empty_mask,
                    job.source_width_px,
                    job.source_height_px,
                    job.width_px,
                    job.height_px,
                    packing_mode,
                    png_strategy,
                )?);
            }

            return Ok(empty_layer_png.clone().unwrap_or_default());
        }

        merged
    } else {
        let Some(mask) = rasterize_mask_for_triangle_indices(
            triangles,
            &triangle_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            aa_level,
        ) else {
            if empty_layer_png.is_none() {
                let empty_mask =
                    vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
                *empty_layer_png = Some(pack_mask_to_nanodlp_png(
                    &empty_mask,
                    job.source_width_px,
                    job.source_height_px,
                    job.width_px,
                    job.height_px,
                    packing_mode,
                    png_strategy,
                )?);
            }

            return Ok(empty_layer_png.clone().unwrap_or_default());
        };

        mask
    };

    pack_mask_to_nanodlp_png(
        &mask,
        job.source_width_px,
        job.source_height_px,
        job.width_px,
        job.height_px,
        packing_mode,
        png_strategy,
    )
}

pub fn solid_slice_to_png_layers(job: &SolidSliceJob) -> Result<Vec<Vec<u8>>, SolidSlicerError> {
    if job.output_format != ".nanodlp" {
        return Err(SolidSlicerError::UnsupportedOutput(
            job.output_format.clone(),
        ));
    }

    validate_solid_job(job)?;

    let packing_mode = parse_packing_mode(&job.x_packing_mode)?;
    let aa_level = parse_anti_aliasing_level(&job.anti_aliasing_level);
    let png_strategy = parse_png_compression_strategy(&job.png_compression_strategy);
    let triangles = parse_triangles(&job.triangles_xyz)?;
    let source_metadata: Value = serde_json::from_str(&job.metadata_json)
        .map_err(|err| SolidSlicerError::MetadataJson(err.to_string()))?;
    let (mirror_x, mirror_y) = extract_mirror_flags(&source_metadata);
    let min_x_mm = -job.build_width_mm * 0.5;
    let min_y_mm = -job.build_depth_mm * 0.5;

    let use_bvh = should_use_bvh(triangles.len(), job.bvh_acceleration_enabled);

    let bvh = if use_bvh {
        let indices: Vec<usize> = (0..triangles.len()).collect();
        Some(BVHNode::build(&triangles, indices, 16)) // Max 16 triangles per leaf
    } else {
        None
    };

    let layer_buckets = if use_bvh {
        Vec::new() // Don't pre-build buckets when using BVH
    } else {
        build_layer_triangle_buckets(&triangles, job.total_layers, job.layer_height_mm)
    };

    let mut layer_pngs: Vec<Vec<u8>> = Vec::with_capacity(job.total_layers as usize);
    let mut empty_layer_png: Option<Vec<u8>> = None;

    for layer_index in 0..job.total_layers {
        let png = if use_bvh {
            render_layer_png_bvh(
                job,
                &triangles,
                bvh.as_ref().unwrap(),
                packing_mode,
                png_strategy,
                mirror_x,
                mirror_y,
                min_x_mm,
                min_y_mm,
                aa_level,
                layer_index,
                &mut empty_layer_png,
            )?
        } else {
            render_layer_png(
                job,
                &triangles,
                &layer_buckets,
                packing_mode,
                png_strategy,
                mirror_x,
                mirror_y,
                min_x_mm,
                min_y_mm,
                aa_level,
                layer_index,
                &mut empty_layer_png,
            )?
        };
        layer_pngs.push(png);
    }

    Ok(layer_pngs)
}

pub fn slice_solid_chunk_payload(
    job: &SolidSliceJob,
    start_layer: u32,
    layer_count: u32,
) -> Result<Vec<u8>, SolidSlicerError> {
    if job.output_format != ".nanodlp" {
        return Err(SolidSlicerError::UnsupportedOutput(
            job.output_format.clone(),
        ));
    }

    validate_solid_job(job)?;

    if layer_count == 0
        || start_layer >= job.total_layers
        || start_layer.saturating_add(layer_count) > job.total_layers
    {
        return Err(SolidSlicerError::InvalidChunkRange {
            start_layer,
            layer_count,
            total_layers: job.total_layers,
        });
    }

    let packing_mode = parse_packing_mode(&job.x_packing_mode)?;
    let aa_level = parse_anti_aliasing_level(&job.anti_aliasing_level);
    let png_strategy = parse_png_compression_strategy(&job.png_compression_strategy);
    let triangles = parse_triangles(&job.triangles_xyz)?;
    let source_metadata: Value = serde_json::from_str(&job.metadata_json)
        .map_err(|err| SolidSlicerError::MetadataJson(err.to_string()))?;
    let (mirror_x, mirror_y) = extract_mirror_flags(&source_metadata);
    let min_x_mm = -job.build_width_mm * 0.5;
    let min_y_mm = -job.build_depth_mm * 0.5;

    let use_bvh = should_use_bvh(triangles.len(), job.bvh_acceleration_enabled);

    let bvh = if use_bvh {
        let indices: Vec<usize> = (0..triangles.len()).collect();
        Some(BVHNode::build(&triangles, indices, 16))
    } else {
        None
    };

    let layer_buckets = if use_bvh {
        Vec::new()
    } else {
        build_layer_triangle_buckets(&triangles, job.total_layers, job.layer_height_mm)
    };
    let mut empty_layer_png: Option<Vec<u8>> = None;

    let mut out = Vec::<u8>::new();
    out.extend_from_slice(b"DFCK");
    out.extend_from_slice(&layer_count.to_le_bytes());

    let end_layer = start_layer + layer_count;
    for layer_index in start_layer..end_layer {
        let png = if use_bvh {
            render_layer_png_bvh(
                job,
                &triangles,
                bvh.as_ref().unwrap(),
                packing_mode,
                png_strategy,
                mirror_x,
                mirror_y,
                min_x_mm,
                min_y_mm,
                aa_level,
                layer_index,
                &mut empty_layer_png,
            )?
        } else {
            render_layer_png(
                job,
                &triangles,
                &layer_buckets,
                packing_mode,
                png_strategy,
                mirror_x,
                mirror_y,
                min_x_mm,
                min_y_mm,
                aa_level,
                layer_index,
                &mut empty_layer_png,
            )?
        };

        let png_len = png.len() as u32;
        out.extend_from_slice(&layer_index.to_le_bytes());
        out.extend_from_slice(&png_len.to_le_bytes());
        out.extend_from_slice(&png);
    }

    Ok(out)
}

pub fn slice_solid_and_encode_nanodlp_streaming(
    job: &SolidSliceJob,
) -> Result<Vec<u8>, SolidSlicerError> {
    let source_metadata: Value = serde_json::from_str(&job.metadata_json)
        .map_err(|err| SolidSlicerError::MetadataJson(err.to_string()))?;

    let plate_json = json_pretty_bytes(&build_plate_json(job, &source_metadata))?;
    let meta_json = json_pretty_bytes(&build_meta_json())?;
    let slicer_json = json_pretty_bytes(&build_slicer_json(job))?;
    let profile_json = json_pretty_bytes(&build_profile_json(job, &source_metadata))?;
    let options_json = json_pretty_bytes(&build_options_json(job))?;

    let packing_mode = parse_packing_mode(&job.x_packing_mode)?;
    let aa_level = parse_anti_aliasing_level(&job.anti_aliasing_level);
    let png_strategy = parse_png_compression_strategy(&job.png_compression_strategy);
    let (mirror_x, mirror_y) = extract_mirror_flags(&source_metadata);
    let triangles = parse_triangles(&job.triangles_xyz)?;
    let min_x_mm = -job.build_width_mm * 0.5;
    let min_y_mm = -job.build_depth_mm * 0.5;

    let use_bvh = should_use_bvh(triangles.len(), job.bvh_acceleration_enabled);

    let bvh = if use_bvh {
        let indices: Vec<usize> = (0..triangles.len()).collect();
        Some(BVHNode::build(&triangles, indices, 16))
    } else {
        None
    };

    let layer_buckets = if use_bvh {
        Vec::new()
    } else {
        build_layer_triangle_buckets(&triangles, job.total_layers, job.layer_height_mm)
    };
    let mut empty_layer_png: Option<Vec<u8>> = None;
    let mut first_layer_png: Option<Vec<u8>> = None;
    let mut preview_layer_png: Option<Vec<u8>> = None;

    let container_compression_level =
        normalize_container_compression_level(job.container_compression_level);
    let store_layer_pngs = should_store_layer_png_in_zip(png_strategy);
    let png_options = if store_layer_pngs || container_compression_level == 0 {
        FileOptions::default().compression_method(CompressionMethod::Stored)
    } else {
        FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(container_compression_level as i32))
    };

    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let metadata_options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(7));

        zip.start_file("meta.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&meta_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("slicer.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&slicer_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("plate.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&plate_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("profile.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&profile_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("options.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&options_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("info.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(b"[]")
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        for layer_index in 0..job.total_layers {
            let layer_png = if use_bvh {
                render_layer_png_bvh(
                    job,
                    &triangles,
                    bvh.as_ref().unwrap(),
                    packing_mode,
                    png_strategy,
                    mirror_x,
                    mirror_y,
                    min_x_mm,
                    min_y_mm,
                    aa_level,
                    layer_index,
                    &mut empty_layer_png,
                )?
            } else {
                render_layer_png(
                    job,
                    &triangles,
                    &layer_buckets,
                    packing_mode,
                    png_strategy,
                    mirror_x,
                    mirror_y,
                    min_x_mm,
                    min_y_mm,
                    aa_level,
                    layer_index,
                    &mut empty_layer_png,
                )?
            };

            let name = format!("{}.png", layer_index + 1);
            zip.start_file(name, png_options)
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
            zip.write_all(&layer_png)
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

            if first_layer_png.is_none() {
                first_layer_png = Some(layer_png.clone());
            } else if preview_layer_png.is_none() {
                let first = first_layer_png.as_ref().unwrap();
                if first.len() != layer_png.len() || first != &layer_png {
                    preview_layer_png = Some(layer_png.clone());
                }
            }
        }

        if let Some(preview_png) = preview_layer_png.or(first_layer_png) {
            zip.start_file("3d.png", png_options)
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
            zip.write_all(&preview_png)
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

            zip.start_file("3d.png.meta", metadata_options)
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
            zip.write_all(b"{}")
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        }

        zip.finish()
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
    }

    Ok(cursor.into_inner())
}

pub fn to_container_job(base: &SolidSliceJob, layer_pngs: Vec<Vec<u8>>) -> SliceJob {
    SliceJob {
        output_format: base.output_format.clone(),
        width_px: base.width_px,
        height_px: base.height_px,
        layer_height_mm: base.layer_height_mm,
        total_layers: base.total_layers,
        layer_pngs,
        metadata_json: base.metadata_json.clone(),
    }
}

// ---------------------------------------------------------------------------
// Thread-safe layer renderer (no &mut state — suitable for Rayon par_iter)
// ---------------------------------------------------------------------------

fn render_layer_png_parallel(
    raster_backend: RasterComputeBackend,
    pack_backend: RasterComputeBackend,
    job: &SolidSliceJob,
    triangles: &[Tri],
    bvh: Option<&BVHNode>,
    layer_buckets: &[Vec<usize>],
    empty_png: &[u8],
    packing_mode: PackingMode,
    png_strategy: crate::fast_png::CompressionStrategy,
    mirror_x: bool,
    mirror_y: bool,
    min_x_mm: f32,
    min_y_mm: f32,
    aa_level: AntiAliasingLevel,
    layer_index: u32,
    perf: Option<&SlicingPerfCounters>,
) -> Result<Vec<u8>, SolidSlicerError> {
    let render_start = Instant::now();
    let z_mm = ((layer_index as f32) + 0.5) * job.layer_height_mm;

    // Get triangle indices for this layer (BVH query or bucket lookup)
    let owned_indices;
    let triangle_indices: &[usize] = if let Some(bvh_node) = bvh {
        owned_indices =
            query_layer_triangles_bvh(bvh_node, triangles, layer_index, job.layer_height_mm);
        &owned_indices
    } else {
        &layer_buckets[layer_index as usize]
    };

    if triangle_indices.is_empty() {
        if let Some(perf) = perf {
            perf.render_total_ns
                .fetch_add(elapsed_ns_u64(render_start), Ordering::Relaxed);
            perf.rendered_layers.fetch_add(1, Ordering::Relaxed);
        }
        return Ok(empty_png.to_vec());
    }

    let raster_start = Instant::now();

    let use_support_aware_aa = aa_level != AntiAliasingLevel::Off
        && !job.aa_on_supports
        && job.model_triangle_count > 0
        && job.model_triangle_count < triangles.len();

    let mask = if use_support_aware_aa {
        let mut model_indices = Vec::with_capacity(triangle_indices.len());
        let mut support_indices = Vec::with_capacity(triangle_indices.len());
        for tri_index in triangle_indices {
            if *tri_index < job.model_triangle_count {
                model_indices.push(*tri_index);
            } else {
                support_indices.push(*tri_index);
            }
        }

        let mut merged =
            vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
        let mut wrote_any = false;

        if let Some(model_mask) = rasterize_mask_for_triangle_indices(
            triangles,
            &model_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            aa_level,
        ) {
            merge_mask_max(&mut merged, &model_mask);
            wrote_any = true;
        }

        if let Some(support_mask) = rasterize_mask_for_triangle_indices(
            triangles,
            &support_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            AntiAliasingLevel::Off,
        ) {
            merge_mask_max(&mut merged, &support_mask);
            wrote_any = true;
        }

        if !wrote_any {
            if let Some(perf) = perf {
                perf.rasterize_ns
                    .fetch_add(elapsed_ns_u64(raster_start), Ordering::Relaxed);
                perf.render_total_ns
                    .fetch_add(elapsed_ns_u64(render_start), Ordering::Relaxed);
                perf.rendered_layers.fetch_add(1, Ordering::Relaxed);
            }
            return Ok(empty_png.to_vec());
        }

        merged
    } else {
        let Some(mask) = rasterize_mask_for_triangle_indices_with_backend(
            triangles,
            triangle_indices,
            z_mm,
            mirror_x,
            mirror_y,
            min_x_mm,
            min_y_mm,
            job.build_width_mm,
            job.build_depth_mm,
            job.source_width_px,
            job.source_height_px,
            aa_level,
            raster_backend,
        ) else {
            if let Some(perf) = perf {
                perf.rasterize_ns
                    .fetch_add(elapsed_ns_u64(raster_start), Ordering::Relaxed);
                perf.render_total_ns
                    .fetch_add(elapsed_ns_u64(render_start), Ordering::Relaxed);
                perf.rendered_layers.fetch_add(1, Ordering::Relaxed);
            }
            return Ok(empty_png.to_vec());
        };
        mask
    };

    let raster_elapsed_ns = elapsed_ns_u64(raster_start);
    let pack_start = Instant::now();

    let packed = pack_mask_to_nanodlp_png_with_backend(
        &mask,
        job.source_width_px,
        job.source_height_px,
        job.width_px,
        job.height_px,
        packing_mode,
        png_strategy,
        pack_backend,
    );

    let pack_elapsed_ns = elapsed_ns_u64(pack_start);

    if let Some(perf) = perf {
        perf.rasterize_ns
            .fetch_add(raster_elapsed_ns, Ordering::Relaxed);
        perf.pack_png_ns
            .fetch_add(pack_elapsed_ns, Ordering::Relaxed);
        perf.render_total_ns
            .fetch_add(elapsed_ns_u64(render_start), Ordering::Relaxed);
        perf.rendered_layers.fetch_add(1, Ordering::Relaxed);
    }

    packed
}

#[inline]
fn render_layer_png_parallel_with_backend(
    raster_backend: RasterComputeBackend,
    pack_backend: RasterComputeBackend,
    job: &SolidSliceJob,
    triangles: &[Tri],
    bvh: Option<&BVHNode>,
    layer_buckets: &[Vec<usize>],
    empty_png: &[u8],
    packing_mode: PackingMode,
    png_strategy: crate::fast_png::CompressionStrategy,
    mirror_x: bool,
    mirror_y: bool,
    min_x_mm: f32,
    min_y_mm: f32,
    aa_level: AntiAliasingLevel,
    layer_index: u32,
    perf: Option<&SlicingPerfCounters>,
) -> Result<Vec<u8>, SolidSlicerError> {
    match raster_backend {
        RasterComputeBackend::Cpu | RasterComputeBackend::Auto | RasterComputeBackend::Gpu => {
            render_layer_png_parallel(
                raster_backend,
                pack_backend,
                job,
                triangles,
                bvh,
                layer_buckets,
                empty_png,
                packing_mode,
                png_strategy,
                mirror_x,
                mirror_y,
                min_x_mm,
                min_y_mm,
                aa_level,
                layer_index,
                perf,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Progress-aware + cancellable variants
// ---------------------------------------------------------------------------

pub type ProgressCallback = Box<dyn Fn(u32, u32) + Send + Sync>;

#[derive(Default)]
struct SlicingPerfCounters {
    render_total_ns: AtomicU64,
    rasterize_ns: AtomicU64,
    pack_png_ns: AtomicU64,
    zip_write_ns: AtomicU64,
    rendered_layers: AtomicU64,
    zipped_layers: AtomicU64,
}

#[inline]
fn elapsed_ns_u64(start: Instant) -> u64 {
    let nanos = start.elapsed().as_nanos();
    nanos.min(u64::MAX as u128) as u64
}

#[inline]
fn ns_to_ms(ns: u64) -> f64 {
    (ns as f64) / 1_000_000.0
}

#[inline]
fn ns_to_s(ns: u64) -> f64 {
    (ns as f64) / 1_000_000_000.0
}

fn choose_pipeline_buffer_layers(
    job: &SolidSliceJob,
    compression_level: u8,
    max_concurrent_renders: usize,
) -> usize {
    // Keep at least 6GB available for OS + browser/dev server + desktop shell.
    // In tauri:dev, node/chromium can spike hard during compile/reload.
    const SYSTEM_HEADROOM_BYTES: u64 = 6 * 1024 * 1024 * 1024;
    const MIN_BUFFER: usize = 2;
    const ABS_MAX_BUFFER: usize = 12;

    // Conservative per-layer estimate of in-flight memory held by channel + reorder map.
    // Stored entries and low compression can produce larger PNG payloads.
    let layer_pixels = (job.width_px as u64).saturating_mul(job.height_px as u64);
    let per_layer_bytes = if compression_level == 0 {
        layer_pixels.saturating_add(256 * 1024)
    } else {
        (layer_pixels / 2).saturating_add(192 * 1024)
    }
    .max(1 * 1024 * 1024);

    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let available_bytes = system.available_memory();

    let budget_bytes = available_bytes.saturating_sub(SYSTEM_HEADROOM_BYTES);
    if budget_bytes == 0 {
        return MIN_BUFFER;
    }

    // Bound queue depth by renderer concurrency so writer lag can't hoard too many PNGs.
    let concurrency_cap =
        (max_concurrent_renders.saturating_mul(2)).clamp(MIN_BUFFER, ABS_MAX_BUFFER);
    let fit = (budget_bytes / per_layer_bytes).clamp(MIN_BUFFER as u64, concurrency_cap as u64);
    fit as usize
}

/// Estimate the per-thread working memory for rendering one layer.
/// Accounts for masks, segment buffers, row_buckets, and PNG encoding.
fn estimate_per_render_bytes(job: &SolidSliceJob, aa_level: AntiAliasingLevel) -> u64 {
    let source_pixels = (job.source_width_px as u64).saturating_mul(job.source_height_px as u64);
    // Base: one mask allocation + row_buckets overhead + segments + PNG output.
    let base = source_pixels + 512 * 1024 + source_pixels; // mask + overhead + PNG output
                                                           // Support-aware AA path allocates merged + temp model_mask + temp support_mask.
    let has_support_aa = aa_level != AntiAliasingLevel::Off
        && !job.aa_on_supports
        && job.model_triangle_count > 0
        && job.model_triangle_count < (job.triangles_xyz.len() / 9);
    if has_support_aa {
        // merged + model_mask + support_mask (only 2 coexist at peak)
        base + source_pixels
    } else {
        base
    }
}

/// Choose the maximum number of concurrent layer renders based on available memory.
fn choose_max_concurrent_renders(job: &SolidSliceJob, aa_level: AntiAliasingLevel) -> usize {
    const SYSTEM_HEADROOM_BYTES: u64 = 6 * 1024 * 1024 * 1024;
    const MIN_CONCURRENT: usize = 1;

    let hw_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);

    // The measured per-render peak is much higher than the simple mask estimate,
    // especially at high resolutions with AA + packing + compression buffers.
    // Apply a conservative safety multiplier to avoid optimistic over-subscription.
    let per_render = estimate_per_render_bytes(job, aa_level)
        .saturating_mul(4)
        .max(1);

    // Hard cap by source resolution to avoid catastrophic over-parallelization.
    // 11520x5120 (~59M px) can require very large transient allocations per worker.
    let source_pixels = (job.source_width_px as u64).saturating_mul(job.source_height_px as u64);
    let resolution_cap = if source_pixels >= 45_000_000 {
        2
    } else if source_pixels >= 20_000_000 {
        3
    } else if source_pixels >= 12_000_000 {
        4
    } else if source_pixels >= 8_000_000 {
        6
    } else if source_pixels >= 4_000_000 {
        8
    } else {
        12
    };

    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let available = system.available_memory();
    let budget = available.saturating_sub(SYSTEM_HEADROOM_BYTES);
    if budget == 0 {
        return MIN_CONCURRENT.min(resolution_cap).min(hw_threads);
    }

    let fit = (budget / per_render) as usize;
    let auto_cap = fit.clamp(MIN_CONCURRENT, hw_threads).min(resolution_cap);

    // Optional operator override for emergency tuning in dev/prod without rebuild.
    // Example: set DF_SLICER_MAX_CONCURRENT=2
    let env_cap = std::env::var("DF_SLICER_MAX_CONCURRENT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|v| *v >= 1);

    if let Some(cap) = env_cap {
        auto_cap.min(cap.max(1))
    } else {
        auto_cap
    }
}

/// Simple counting semaphore for limiting concurrent operations.
struct RenderSemaphore {
    state: std::sync::Mutex<usize>,
    cv: std::sync::Condvar,
    max: usize,
}

impl RenderSemaphore {
    fn new(max: usize) -> Self {
        Self {
            state: std::sync::Mutex::new(0),
            cv: std::sync::Condvar::new(),
            max,
        }
    }

    fn acquire(&self) {
        let mut count = self.state.lock().unwrap();
        while *count >= self.max {
            count = self.cv.wait(count).unwrap();
        }
        *count += 1;
    }

    fn release(&self) {
        let mut count = self.state.lock().unwrap();
        *count -= 1;
        self.cv.notify_one();
    }
}

#[inline]
fn check_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), SolidSlicerError> {
    if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            return Err(SolidSlicerError::Cancelled);
        }
    }
    Ok(())
}

pub fn solid_slice_to_png_layers_with_progress(
    job: &SolidSliceJob,
    on_progress: Option<ProgressCallback>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<Vec<u8>>, SolidSlicerError> {
    if job.output_format != ".nanodlp" {
        return Err(SolidSlicerError::UnsupportedOutput(
            job.output_format.clone(),
        ));
    }

    validate_solid_job(job)?;

    let packing_mode = parse_packing_mode(&job.x_packing_mode)?;
    let requested_backend = parse_compute_backend(&job.compute_backend);
    let raster_backend = select_raster_backend(requested_backend);
    let pack_backend = select_pack_backend(requested_backend);
    let aa_level = parse_anti_aliasing_level(&job.anti_aliasing_level);
    let png_strategy = parse_png_compression_strategy(&job.png_compression_strategy);
    let triangles = parse_triangles(&job.triangles_xyz)?;
    let source_metadata: Value = serde_json::from_str(&job.metadata_json)
        .map_err(|err| SolidSlicerError::MetadataJson(err.to_string()))?;
    let (mirror_x, mirror_y) = extract_mirror_flags(&source_metadata);
    let min_x_mm = -job.build_width_mm * 0.5;
    let min_y_mm = -job.build_depth_mm * 0.5;

    let use_bvh = should_use_bvh(triangles.len(), job.bvh_acceleration_enabled);

    let bvh = if use_bvh {
        let indices: Vec<usize> = (0..triangles.len()).collect();
        Some(BVHNode::build(&triangles, indices, 16))
    } else {
        None
    };

    let layer_buckets = if use_bvh {
        Vec::new()
    } else {
        build_layer_triangle_buckets(&triangles, job.total_layers, job.layer_height_mm)
    };

    // Pre-compute the empty layer PNG once (shared across threads)
    let empty_mask = vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
    let empty_png = pack_mask_to_nanodlp_png(
        &empty_mask,
        job.source_width_px,
        job.source_height_px,
        job.width_px,
        job.height_px,
        packing_mode,
        png_strategy,
    )?;

    // Track progress atomically from parallel threads
    let progress_counter = std::sync::atomic::AtomicU32::new(0);

    // Render all layers in parallel using Rayon
    let layer_pngs: Result<Vec<Vec<u8>>, SolidSlicerError> = (0..job.total_layers)
        .into_par_iter()
        .map(|layer_index| {
            check_cancelled(cancel_flag)?;

            let png = if use_bvh {
                render_layer_png_parallel_with_backend(
                    raster_backend,
                    pack_backend,
                    job,
                    &triangles,
                    Some(bvh.as_ref().unwrap()),
                    &[],
                    &empty_png,
                    packing_mode,
                    png_strategy,
                    mirror_x,
                    mirror_y,
                    min_x_mm,
                    min_y_mm,
                    aa_level,
                    layer_index,
                    None,
                )
            } else {
                render_layer_png_parallel_with_backend(
                    raster_backend,
                    pack_backend,
                    job,
                    &triangles,
                    None,
                    &layer_buckets,
                    &empty_png,
                    packing_mode,
                    png_strategy,
                    mirror_x,
                    mirror_y,
                    min_x_mm,
                    min_y_mm,
                    aa_level,
                    layer_index,
                    None,
                )
            }?;

            let done = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some(ref cb) = on_progress {
                cb(done, job.total_layers);
            }

            Ok(png)
        })
        .collect();

    layer_pngs
}

enum StreamingArtifact {
    Bytes(Vec<u8>),
    TempPath {
        path: std::path::PathBuf,
        byte_len: u64,
    },
}

fn slice_solid_and_encode_nanodlp_streaming_with_progress_impl(
    mut job: SolidSliceJob,
    on_progress: Option<ProgressCallback>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<StreamingArtifact, SolidSlicerError> {
    let total_start = Instant::now();
    let source_metadata: Value = serde_json::from_str(&job.metadata_json)
        .map_err(|err| SolidSlicerError::MetadataJson(err.to_string()))?;

    let plate_json = json_pretty_bytes(&build_plate_json(&job, &source_metadata))?;
    let meta_json = json_pretty_bytes(&build_meta_json())?;
    let slicer_json = json_pretty_bytes(&build_slicer_json(&job))?;
    let profile_json = json_pretty_bytes(&build_profile_json(&job, &source_metadata))?;
    let options_json = json_pretty_bytes(&build_options_json(&job))?;

    let packing_mode = parse_packing_mode(&job.x_packing_mode)?;
    let requested_backend = parse_compute_backend(&job.compute_backend);
    let raster_backend = select_raster_backend(requested_backend);
    let pack_backend = select_pack_backend(requested_backend);
    let aa_level = parse_anti_aliasing_level(&job.anti_aliasing_level);
    let png_strategy = parse_png_compression_strategy(&job.png_compression_strategy);
    let (mirror_x, mirror_y) = extract_mirror_flags(&source_metadata);
    let triangles = parse_triangles(&job.triangles_xyz)?;

    // Compute memory-aware concurrency limit BEFORE freeing triangles_xyz,
    // since the estimate needs the triangle count for support-AA detection.
    let max_concurrent = choose_max_concurrent_renders(&job, aa_level);

    // Free the raw f32 triangle buffer (~36–72 MB for large models).
    // All subsequent rendering uses the parsed Vec<Tri> instead.
    let raw_tri_bytes = job.triangles_xyz.len() * std::mem::size_of::<f32>();
    job.triangles_xyz = Vec::new();
    eprintln!("[SlicingMem] freed triangles_xyz: {} bytes", raw_tri_bytes);

    let min_x_mm = -job.build_width_mm * 0.5;
    let min_y_mm = -job.build_depth_mm * 0.5;

    let use_bvh = should_use_bvh(triangles.len(), job.bvh_acceleration_enabled);

    let bvh = if use_bvh {
        let indices: Vec<usize> = (0..triangles.len()).collect();
        Some(BVHNode::build(&triangles, indices, 16))
    } else {
        None
    };

    let layer_buckets = if use_bvh {
        Vec::new()
    } else {
        build_layer_triangle_buckets(&triangles, job.total_layers, job.layer_height_mm)
    };

    // Pre-compute the empty layer PNG once
    let empty_mask = vec![0u8; (job.source_width_px as usize) * (job.source_height_px as usize)];
    let empty_png = pack_mask_to_nanodlp_png(
        &empty_mask,
        job.source_width_px,
        job.source_height_px,
        job.width_px,
        job.height_px,
        packing_mode,
        png_strategy,
    )?;

    // Track progress atomically from parallel threads
    let progress_counter = std::sync::atomic::AtomicU32::new(0);
    let perf = SlicingPerfCounters::default();

    let container_compression_level =
        normalize_container_compression_level(job.container_compression_level);
    let pipeline_buffer =
        choose_pipeline_buffer_layers(&job, container_compression_level, max_concurrent);
    let render_semaphore = RenderSemaphore::new(max_concurrent);
    let store_layer_pngs = should_store_layer_png_in_zip(png_strategy);
    eprintln!(
        "[SlicingMem] pipeline_buffer={} max_concurrent_renders={}",
        pipeline_buffer, max_concurrent
    );
    let png_zip_options = if store_layer_pngs || container_compression_level == 0 {
        FileOptions::default().compression_method(CompressionMethod::Stored)
    } else {
        FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(container_compression_level as i32))
    };

    let mut archive_file = tempfile::tempfile()
        .map_err(|err| SolidSlicerError::ZipWrite(format!("temp archive create failed: {err}")))?;
    {
        let mut zip = ZipWriter::new(&mut archive_file);
        let metadata_options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(7));

        zip.start_file("meta.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&meta_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("slicer.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&slicer_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("plate.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&plate_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("profile.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&profile_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("options.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(&options_json)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        zip.start_file("info.json", metadata_options)
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        zip.write_all(b"[]")
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;

        let mut first_layer_png: Option<Vec<u8>> = None;
        let mut preview_layer_png: Option<Vec<u8>> = None;

        // Pipeline: render workers → bounded channel → sequential ZIP writer.
        //
        // Render workers (Rayon pool) and the ZIP writer (calling thread) run
        // concurrently; there is no burst/idle pattern.
        //
        // Memory bounds:
        // - RenderSemaphore limits how many threads render simultaneously,
        //   capping per-thread mask/PNG working memory.
        // - PIPELINE_BUFFER limits how many completed PNGs sit in the channel.
        //   If the ZIP writer is slower, render workers block on tx.send()
        //   (backpressure) rather than accumulating PNGs unboundedly.
        //
        // The reorder buffer (BTreeMap) holds a small number of out-of-order layers
        // until the expected next layer arrives.  Its depth is bounded in practice
        // by the number of concurrent render permits.
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(u32, Vec<u8>), SolidSlicerError>>(
            pipeline_buffer,
        );

        let mut pipeline_error: Result<(), SolidSlicerError> = Ok(());
        let mut reorder: std::collections::BTreeMap<u32, Vec<u8>> =
            std::collections::BTreeMap::new();
        let mut next_to_write = 0u32;

        // rayon::in_place_scope guarantees the closure runs on the calling thread
        // (the spawn_blocking OS thread, which is NOT a slicer pool thread), so
        // &Receiver (not Sync) and &mut zip can be captured without Send bounds.
        // Spawned tasks still run on the slicer Rayon pool as normal.
        rayon::in_place_scope(|s| {
            // Render task: submitted into the slicer Rayon pool.
            // for_each_with clones `tx` once per Rayon worker thread (cheap —
            // SyncSender clone is just a refcount bump), not once per layer.
            s.spawn(|_| {
                (0..job.total_layers)
                    .into_par_iter()
                    .for_each_with(tx, |tx, layer_index| {
                        let result = (|| -> Result<(u32, Vec<u8>), SolidSlicerError> {
                            check_cancelled(cancel_flag)?;
                            // Limit concurrent renders to cap peak memory usage.
                            render_semaphore.acquire();
                            let png = if use_bvh {
                                render_layer_png_parallel_with_backend(
                                    raster_backend,
                                    pack_backend,
                                    &job,
                                    &triangles,
                                    Some(bvh.as_ref().unwrap()),
                                    &[],
                                    &empty_png,
                                    packing_mode,
                                    png_strategy,
                                    mirror_x,
                                    mirror_y,
                                    min_x_mm,
                                    min_y_mm,
                                    aa_level,
                                    layer_index,
                                    Some(&perf),
                                )
                            } else {
                                render_layer_png_parallel_with_backend(
                                    raster_backend,
                                    pack_backend,
                                    &job,
                                    &triangles,
                                    None,
                                    &layer_buckets,
                                    &empty_png,
                                    packing_mode,
                                    png_strategy,
                                    mirror_x,
                                    mirror_y,
                                    min_x_mm,
                                    min_y_mm,
                                    aa_level,
                                    layer_index,
                                    Some(&perf),
                                )
                            };
                            render_semaphore.release();
                            let png = png?;
                            let done = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                            if let Some(ref cb) = on_progress {
                                cb(done, job.total_layers);
                            }
                            Ok((layer_index, png))
                        })();
                        // Ignore RecvError: receiver may have dropped after a write error.
                        let _ = tx.send(result);
                    });
                // `tx` consumed by for_each_with; when all tasks finish the last
                // clone is dropped, closing the channel and ending the for-loop below.
            });

            // ZIP writer: runs on the calling thread concurrently with render workers.
            // We always drain the channel even when in error state — if we stopped
            // reading, render workers would block on a full tx.send() and the scope
            // would deadlock waiting for the s.spawn task to finish.
            for msg in &rx {
                if pipeline_error.is_err() {
                    // Error already recorded; drain remaining messages and discard.
                    continue;
                }
                match msg {
                    Err(e) => {
                        pipeline_error = Err(e);
                    }
                    Ok((idx, png)) => {
                        reorder.insert(idx, png);
                        // Drain all consecutive in-order layers from the reorder buffer.
                        while let Some(layer_png) = reorder.remove(&next_to_write) {
                            if first_layer_png.is_none() {
                                first_layer_png = Some(layer_png.clone());
                            } else if preview_layer_png.is_none() {
                                let first = first_layer_png.as_ref().unwrap();
                                if first.len() != layer_png.len() || *first != layer_png {
                                    preview_layer_png = Some(layer_png.clone());
                                }
                            }
                            let name = format!("{}.png", next_to_write + 1);
                            let zip_write_start = Instant::now();
                            let r = zip
                                .start_file(name, png_zip_options)
                                .map_err(|e| SolidSlicerError::ZipWrite(e.to_string()))
                                .and_then(|_| {
                                    zip.write_all(&layer_png)
                                        .map_err(|e| SolidSlicerError::ZipWrite(e.to_string()))
                                });
                            perf.zip_write_ns
                                .fetch_add(elapsed_ns_u64(zip_write_start), Ordering::Relaxed);
                            perf.zipped_layers.fetch_add(1, Ordering::Relaxed);
                            // layer_png is dropped here, freeing the raw PNG memory.
                            if let Err(e) = r {
                                pipeline_error = Err(e);
                                break;
                            }
                            next_to_write += 1;
                        }
                    }
                }
            }
            // Channel is now exhausted: all render tasks finished and all tx clones dropped.
        });

        pipeline_error?;

        if let Some(preview_png) = preview_layer_png.as_deref().or(first_layer_png.as_deref()) {
            let preview_zip_start = Instant::now();
            zip.start_file("3d.png", png_zip_options)
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
            zip.write_all(preview_png)
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
            perf.zip_write_ns
                .fetch_add(elapsed_ns_u64(preview_zip_start), Ordering::Relaxed);

            zip.start_file("3d.png.meta", metadata_options)
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
            zip.write_all(b"{}")
                .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
        }

        zip.finish()
            .map_err(|err| SolidSlicerError::ZipWrite(err.to_string()))?;
    }

    let archive_len = archive_file.seek(SeekFrom::End(0)).map_err(|err| {
        SolidSlicerError::ZipWrite(format!("temp archive size probe failed: {err}"))
    })?;

    archive_file
        .seek(SeekFrom::Start(0))
        .map_err(|err| SolidSlicerError::ZipWrite(format!("temp archive rewind failed: {err}")))?;

    let artifact = if archive_len >= 256 * 1024 * 1024 {
        let unique_name = format!(
            "dragonfruit_slice_{}_{}.nanodlp",
            std::process::id(),
            total_start.elapsed().as_nanos()
        );
        let path = std::env::temp_dir().join(unique_name);
        let mut persisted = std::fs::File::create(&path).map_err(|err| {
            SolidSlicerError::ZipWrite(format!("temp archive persist create failed: {err}"))
        })?;

        std::io::copy(&mut archive_file, &mut persisted).map_err(|err| {
            SolidSlicerError::ZipWrite(format!("temp archive persist copy failed: {err}"))
        })?;

        StreamingArtifact::TempPath {
            path,
            byte_len: archive_len,
        }
    } else {
        let mut archive_bytes = Vec::with_capacity(archive_len as usize);
        archive_file
            .read_to_end(&mut archive_bytes)
            .map_err(|err| {
                SolidSlicerError::ZipWrite(format!("temp archive read failed: {err}"))
            })?;
        StreamingArtifact::Bytes(archive_bytes)
    };

    let total_ns = elapsed_ns_u64(total_start);
    let render_total_ns = perf.render_total_ns.load(Ordering::Relaxed);
    let rasterize_ns = perf.rasterize_ns.load(Ordering::Relaxed);
    let pack_png_ns = perf.pack_png_ns.load(Ordering::Relaxed);
    let zip_write_ns = perf.zip_write_ns.load(Ordering::Relaxed);
    let rendered_layers = perf.rendered_layers.load(Ordering::Relaxed);
    let zipped_layers = perf.zipped_layers.load(Ordering::Relaxed);
    let other_ns = total_ns.saturating_sub(
        rasterize_ns
            .saturating_add(pack_png_ns)
            .saturating_add(zip_write_ns),
    );
    let avg_render_ms = if rendered_layers > 0 {
        ns_to_ms(render_total_ns) / (rendered_layers as f64)
    } else {
        0.0
    };
    let avg_zip_ms = if zipped_layers > 0 {
        ns_to_ms(zip_write_ns) / (zipped_layers as f64)
    } else {
        0.0
    };

    eprintln!(
        "[SlicingPerf] total={:.3}s layers={} rendered={} zipped={} raster={:.3}s pack_png={:.3}s zip_write={:.3}s other={:.3}s avg_render={:.3}ms avg_zip={:.3}ms compression_level={} layer_zip_mode={} threads={} pipeline_buffer={} max_concurrent={}",
        ns_to_s(total_ns),
        job.total_layers,
        rendered_layers,
        zipped_layers,
        ns_to_s(rasterize_ns),
        ns_to_s(pack_png_ns),
        ns_to_s(zip_write_ns),
        ns_to_s(other_ns),
        avg_render_ms,
        avg_zip_ms,
        normalize_container_compression_level(job.container_compression_level),
        if store_layer_pngs { "stored" } else { "deflated" },
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        pipeline_buffer,
        max_concurrent,
    );

    Ok(artifact)
}

pub fn slice_solid_and_encode_nanodlp_streaming_with_progress(
    job: SolidSliceJob,
    on_progress: Option<ProgressCallback>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<u8>, SolidSlicerError> {
    match slice_solid_and_encode_nanodlp_streaming_with_progress_impl(
        job,
        on_progress,
        cancel_flag,
    )? {
        StreamingArtifact::Bytes(bytes) => Ok(bytes),
        StreamingArtifact::TempPath { path, .. } => {
            let bytes = std::fs::read(&path).map_err(|err| {
                SolidSlicerError::ZipWrite(format!("temp archive reload failed: {err}"))
            })?;
            let _ = std::fs::remove_file(path);
            Ok(bytes)
        }
    }
}

pub fn slice_solid_and_encode_nanodlp_streaming_to_temp_path_with_progress(
    job: SolidSliceJob,
    on_progress: Option<ProgressCallback>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(std::path::PathBuf, u64), SolidSlicerError> {
    match slice_solid_and_encode_nanodlp_streaming_with_progress_impl(
        job,
        on_progress,
        cancel_flag,
    )? {
        StreamingArtifact::TempPath { path, byte_len } => Ok((path, byte_len)),
        StreamingArtifact::Bytes(bytes) => {
            let unique_name = format!(
                "dragonfruit_slice_{}_{}.nanodlp",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            let path = std::env::temp_dir().join(unique_name);
            std::fs::write(&path, &bytes).map_err(|err| {
                SolidSlicerError::ZipWrite(format!("temp archive write failed: {err}"))
            })?;
            Ok((path, bytes.len() as u64))
        }
    }
}
