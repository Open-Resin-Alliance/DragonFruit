use crate::bvh::BVHNode;
use crate::job::{SliceJob, SolidSliceJob};
use serde_json::{json, Value};
use std::io::Write;
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

fn parse_anti_aliasing_level(level: &str) -> AntiAliasingLevel {
    match level {
        "2x" => AntiAliasingLevel::X2,
        "4x" => AntiAliasingLevel::X4,
        "8x" => AntiAliasingLevel::X8,
        _ => AntiAliasingLevel::Off,
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
            let q = (c * 2.0).round() / 2.0;
            (q * 255.0).round() as u8
        }
        AntiAliasingLevel::X4 => {
            let q = (c * 4.0).round() / 4.0;
            (q * 255.0).round() as u8
        }
        AntiAliasingLevel::X8 => {
            let q = (c * 8.0).round() / 8.0;
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

            let start_px = a.floor() as i32;
            let end_px = (b - 1e-6).floor() as i32;
            if end_px < 0 || start_px >= width as i32 {
                continue;
            }

            let clamped_start = start_px.clamp(0, (width as i32) - 1) as usize;
            let clamped_end = end_px.clamp(0, (width as i32) - 1) as usize;
            let row = &mut mask[row_start..row_start + width];

            if aa_level == AntiAliasingLevel::Off {
                fill_row_span_white(row, clamped_start, clamped_end);
                continue;
            }

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

    mask
}

fn encode_grayscale_png_with_strategy(
    width_px: u32,
    height_px: u32,
    pixels: &[u8],
    strategy: crate::fast_png::CompressionStrategy,
) -> Result<Vec<u8>, SolidSlicerError> {
    // Use fast PNG encoder optimized for binary masks with specified strategy
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

    Some(rasterize_segments_solid(
        source_width_px,
        source_height_px,
        &segments,
        aa_level,
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

    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let metadata_options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(7));
        let png_options = FileOptions::default().compression_method(CompressionMethod::Stored);

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
