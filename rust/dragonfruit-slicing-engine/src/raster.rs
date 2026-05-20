//! Scanline rasterizer for V3 layer masks.
//!
//! Uses oriented segment winding to robustly union overlapping/intersecting
//! solids and avoid spurious bridge/void artifacts.

use crate::geometry::Triangle;
use crate::types::{LayerAreaStatsV3, SliceJobV3};
use rayon::prelude::*;

#[inline]
fn edge_x_cmp(a: f32, b: f32) -> std::cmp::Ordering {
    match (a.is_finite(), b.is_finite()) {
        (true, true) => a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => std::cmp::Ordering::Equal,
    }
}

#[inline]
fn active_edge_cmp(a: &ActiveEdge, b: &ActiveEdge) -> std::cmp::Ordering {
    edge_x_cmp(a.x, b.x)
}

#[inline]
fn merge_active_edges_sorted(
    active_edges: &mut Vec<ActiveEdge>,
    starting: &[ActiveEdge],
    scratch: &mut Vec<ActiveEdge>,
) {
    if starting.is_empty() {
        return;
    }

    scratch.clear();
    scratch.reserve(active_edges.len() + starting.len());

    let mut i = 0usize;
    let mut j = 0usize;

    while i < active_edges.len() && j < starting.len() {
        if active_edge_cmp(&active_edges[i], &starting[j]).is_gt() {
            scratch.push(starting[j]);
            j += 1;
        } else {
            scratch.push(active_edges[i]);
            i += 1;
        }
    }

    if i < active_edges.len() {
        scratch.extend_from_slice(&active_edges[i..]);
    }
    if j < starting.len() {
        scratch.extend_from_slice(&starting[j..]);
    }

    std::mem::swap(active_edges, scratch);
}

#[inline]
fn restore_active_edges_sorted(active_edges: &mut [ActiveEdge]) {
    if active_edges.len() < 2 {
        return;
    }

    // Insertion sort is ideal here because scanline updates are small (
    // each edge only moves by dx/dy for one row), so the slice stays nearly
    // sorted from one scanline to the next.
    for i in 1..active_edges.len() {
        let mut j = i;
        while j > 0 && active_edge_cmp(&active_edges[j], &active_edges[j - 1]).is_lt() {
            active_edges.swap(j, j - 1);
            j -= 1;
        }
    }
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

#[derive(Debug, Clone, Copy)]
struct ActiveEdge {
    x: f32,
    dx_dy: f32,
    wind: i32,
    end_exclusive: usize,
}

#[derive(Debug, Clone, Copy)]
struct RowSpan {
    a: f32,
    b: f32,
    start: usize,
    end: usize,
}

#[derive(Debug)]
struct ScanlineSegmentIndex {
    starts: Vec<ActiveEdge>,
    row_offsets: Vec<usize>,
    y_start: usize,
    y_end_exclusive: usize,
}

#[inline]
fn make_row_span(x0: f32, x1: f32, width: usize) -> Option<RowSpan> {
    let a = x0.min(x1).max(0.0);
    let b = x0.max(x1).min(width as f32);
    if b <= a {
        return None;
    }

    let start_px = a.floor() as i32;
    let end_px = b.ceil() as i32;
    if end_px <= start_px || end_px <= 0 || start_px >= width as i32 {
        return None;
    }

    let start = start_px.max(0) as usize;
    let end = ((end_px - 1).min(width as i32 - 1)) as usize;
    if end < start {
        return None;
    }

    Some(RowSpan { a, b, start, end })
}

#[inline]
fn edge_plane_intersection_t(az: f32, bz: f32, z: f32) -> Option<f32> {
    let dz1 = az - z;
    let dz2 = bz - z;
    let crosses = (dz1 <= 0.0 && dz2 > 0.0) || (dz2 <= 0.0 && dz1 > 0.0);
    if !crosses {
        return None;
    }
    let denom = bz - az;
    if denom.abs() < 1e-8 {
        return None;
    }
    Some((z - az) / denom)
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

/// Build filled spans for one scanline using non-zero winding.
///
/// Iterates every consecutive edge pair. When `snap_to_integer` is
/// true (non-AA path) we round each edge's x to the nearest integer pixel
/// and skip the pair if both round to the same pixel,
/// eliminating the 1-px bogus spans that near-coincident crossings on
/// defective meshes used to produce.
fn build_row_spans_nonzero(
    active_edges: &[ActiveEdge],
    width: usize,
    snap_to_integer: bool,
) -> Vec<RowSpan> {
    let mut spans = Vec::with_capacity(active_edges.len() / 2 + 1);
    let mut winding = 0i32;
    let n = active_edges.len();

    for i in 0..n.saturating_sub(1) {
        let x_left = active_edges[i].x;
        if !x_left.is_finite() {
            break;
        }

        winding += active_edges[i].wind;
        if winding == 0 {
            continue;
        }

        let x_right = active_edges[i + 1].x;
        if !x_right.is_finite() {
            break;
        }

        if snap_to_integer {
            let a = x_left.round() as i64;
            let b = x_right.round() as i64;
            if a >= b {
                continue;
            }
        }

        if let Some(span) = make_row_span(x_left, x_right, width) {
            spans.push(span);
        }
    }

    spans
}

fn build_segments_for_layer_into(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    z_mm: f32,
    segments: &mut Vec<Segment>,
) {
    segments.clear();

    for tri_idx in layer_indices {
        let tri = triangles[*tri_idx];
        let dir_x = tri.dir_x;
        let dir_y = tri.dir_y;

        let mut pts = [(0.0f32, 0.0f32); 3];
        let mut count = 0usize;

        // Lerp directly in pixel space using precomputed vertex px coords.
        // Eliminates mm_to_pixel_x/y per intersection (2 divisions per point).
        if let Some(t) = edge_plane_intersection_t(tri.a.z, tri.b.z, z_mm) {
            distinct_points_push(
                &mut pts,
                &mut count,
                (
                    tri.px_ax + (tri.px_bx - tri.px_ax) * t,
                    tri.px_ay + (tri.px_by - tri.px_ay) * t,
                ),
            );
        }
        if let Some(t) = edge_plane_intersection_t(tri.b.z, tri.c.z, z_mm) {
            distinct_points_push(
                &mut pts,
                &mut count,
                (
                    tri.px_bx + (tri.px_cx - tri.px_bx) * t,
                    tri.px_by + (tri.px_cy - tri.px_by) * t,
                ),
            );
        }
        if let Some(t) = edge_plane_intersection_t(tri.c.z, tri.a.z, z_mm) {
            distinct_points_push(
                &mut pts,
                &mut count,
                (
                    tri.px_cx + (tri.px_ax - tri.px_cx) * t,
                    tri.px_cy + (tri.px_ay - tri.px_cy) * t,
                ),
            );
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

        let x1 = p0.0;
        let y1 = p0.1;
        let x2 = p1.0;
        let y2 = p1.1;

        let dy = y2 - y1;
        if dy.abs() < 1e-8 {
            continue;
        }

        let mut wind = tri.fill_wind;
        if job.mirror_x {
            wind = -wind;
        }

        segments.push(Segment {
            x1,
            y1,
            dx_dy: (x2 - x1) / dy,
            y_min: y1.min(y2),
            y_max: y1.max(y2),
            wind,
        });
    }
}

fn build_segments_for_layer(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    z_mm: f32,
) -> Vec<Segment> {
    let mut segments = Vec::with_capacity(layer_indices.len());
    build_segments_for_layer_into(job, triangles, layer_indices, z_mm, &mut segments);
    segments
}

fn compute_component_area_stats_8_connected(
    mask: &[u8],
    width: usize,
    height: usize,
    min_x: usize,
    max_x: usize,
    min_y: usize,
    max_y: usize,
    pixel_area_mm2: f64,
) -> (u32, f64, f64, u32) {
    if width == 0
        || height == 0
        || min_x > max_x
        || min_y > max_y
        || max_x >= width
        || max_y >= height
    {
        return (0, 0.0, 0.0, 0);
    }

    let roi_w = max_x - min_x + 1;
    let roi_h = max_y - min_y + 1;
    let mut visited = vec![0u8; roi_w * roi_h];
    let mut stack = Vec::<usize>::new();

    let mut total_solid_pixels = 0u32;
    let mut largest_area_mm2 = 0.0f64;
    let mut smallest_area_mm2 = f64::INFINITY;
    let mut area_count = 0u32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let local_idx = (y - min_y) * roi_w + (x - min_x);
            let idx = y * width + x;
            if mask[idx] == 0 || visited[local_idx] != 0 {
                continue;
            }

            area_count = area_count.saturating_add(1);
            let mut component_pixels = 0u32;

            visited[local_idx] = 1;
            stack.push(local_idx);

            while let Some(cur_local) = stack.pop() {
                component_pixels = component_pixels.saturating_add(1);

                let ly = cur_local / roi_w;
                let lx = cur_local - (ly * roi_w);
                let gy = min_y + ly;
                let gx = min_x + lx;

                let y0 = gy.saturating_sub(1).max(min_y);
                let y1 = (gy + 1).min(max_y);
                let x0 = gx.saturating_sub(1).max(min_x);
                let x1 = (gx + 1).min(max_x);

                for ny in y0..=y1 {
                    for nx in x0..=x1 {
                        if nx == gx && ny == gy {
                            continue;
                        }
                        let nidx = ny * width + nx;
                        let nlocal = (ny - min_y) * roi_w + (nx - min_x);
                        if mask[nidx] == 0 || visited[nlocal] != 0 {
                            continue;
                        }
                        visited[nlocal] = 1;
                        stack.push(nlocal);
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

#[derive(Debug, Clone, Copy)]
struct RleSpan {
    start: u32,
    end: u32,
    component: usize,
}

#[derive(Debug, Clone, Copy)]
struct ComponentNode {
    parent: usize,
    rank: u8,
    pixels: u32,
}

#[derive(Debug, Default)]
struct ComponentSpanTracker {
    components: Vec<ComponentNode>,
    prev_row_spans: Vec<RleSpan>,
    current_row_spans: Vec<RleSpan>,
}

impl ComponentSpanTracker {
    fn new() -> Self {
        Self::default()
    }

    #[inline]
    fn push_span(&mut self, start: usize, end: usize) {
        if end < start {
            return;
        }
        let component = self.components.len();
        self.components.push(ComponentNode {
            parent: component,
            rank: 0,
            pixels: (end - start + 1) as u32,
        });
        self.current_row_spans.push(RleSpan {
            start: start as u32,
            end: end as u32,
            component,
        });
    }

    #[inline]
    fn finish_row(&mut self) {
        if !self.current_row_spans.is_empty() && !self.prev_row_spans.is_empty() {
            let mut prev_start_idx = 0usize;
            for span in &mut self.current_row_spans {
                let adjacency_start = span.start.saturating_sub(1);
                let adjacency_end = span.end.saturating_add(1);

                while prev_start_idx < self.prev_row_spans.len()
                    && self.prev_row_spans[prev_start_idx].end < adjacency_start
                {
                    prev_start_idx += 1;
                }

                let mut probe = prev_start_idx;
                while probe < self.prev_row_spans.len()
                    && self.prev_row_spans[probe].start <= adjacency_end
                {
                    span.component = component_union(
                        &mut self.components,
                        span.component,
                        self.prev_row_spans[probe].component,
                    );
                    probe += 1;
                }
            }
        }

        self.prev_row_spans.clear();
        self.prev_row_spans
            .extend_from_slice(&self.current_row_spans);
        self.current_row_spans.clear();
    }

    fn finalize(mut self, pixel_area_mm2: f64) -> (u32, f64, f64, u32) {
        if self.components.is_empty() {
            return (0, 0.0, 0.0, 0);
        }

        let mut seen_roots = vec![false; self.components.len()];
        let mut total_solid_pixels = 0u32;
        let mut largest_area_mm2 = 0.0f64;
        let mut smallest_area_mm2 = f64::INFINITY;
        let mut area_count = 0u32;

        for index in 0..self.components.len() {
            let root = component_find(&mut self.components, index);
            if seen_roots[root] {
                continue;
            }
            seen_roots[root] = true;

            let pixels = self.components[root].pixels;
            if pixels == 0 {
                continue;
            }

            area_count = area_count.saturating_add(1);
            total_solid_pixels = total_solid_pixels.saturating_add(pixels);

            let area_mm2 = pixels as f64 * pixel_area_mm2;
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
}

#[inline]
fn component_find(nodes: &mut [ComponentNode], index: usize) -> usize {
    let parent = nodes[index].parent;
    if parent == index {
        return index;
    }

    let root = component_find(nodes, parent);
    nodes[index].parent = root;
    root
}

#[inline]
fn component_union(nodes: &mut [ComponentNode], a: usize, b: usize) -> usize {
    let mut root_a = component_find(nodes, a);
    let mut root_b = component_find(nodes, b);

    if root_a == root_b {
        return root_a;
    }

    if nodes[root_a].rank < nodes[root_b].rank {
        std::mem::swap(&mut root_a, &mut root_b);
    }

    nodes[root_b].parent = root_a;
    nodes[root_a].pixels = nodes[root_a].pixels.saturating_add(nodes[root_b].pixels);

    if nodes[root_a].rank == nodes[root_b].rank {
        nodes[root_a].rank = nodes[root_a].rank.saturating_add(1);
    }

    root_a
}

/// Compute 8-connected component area stats directly from row-major RLE runs.
///
/// This avoids materializing a full binary mask + per-pixel flood fill,
/// reducing work to run/span adjacency checks for non-AA layers.
fn compute_component_area_stats_from_rle_8_connected(
    runs: &[crate::rle::RleRun],
    width: usize,
    height: usize,
    pixel_area_mm2: f64,
) -> (u32, f64, f64, u32) {
    if width == 0 || height == 0 || runs.is_empty() {
        return (0, 0.0, 0.0, 0);
    }

    let mut components: Vec<ComponentNode> = Vec::new();
    let mut prev_row_spans: Vec<RleSpan> = Vec::new();
    let mut current_row_spans: Vec<RleSpan> = Vec::new();

    let mut row = 0usize;
    let mut col = 0usize;

    for run in runs {
        if row >= height {
            break;
        }

        let mut remaining = run.length as usize;
        while remaining > 0 && row < height {
            let row_remaining = width.saturating_sub(col);
            if row_remaining == 0 {
                prev_row_spans.clear();
                prev_row_spans.extend_from_slice(&current_row_spans);
                current_row_spans.clear();
                row = row.saturating_add(1);
                col = 0;
                continue;
            }

            let take = remaining.min(row_remaining);

            if run.value > 0 {
                let start = col as u32;
                let end = (col + take - 1) as u32;
                let component = components.len();
                components.push(ComponentNode {
                    parent: component,
                    rank: 0,
                    pixels: take as u32,
                });
                current_row_spans.push(RleSpan {
                    start,
                    end,
                    component,
                });
            }

            col += take;
            remaining -= take;

            if col == width {
                if !current_row_spans.is_empty() && !prev_row_spans.is_empty() {
                    let mut prev_start_idx = 0usize;

                    for span in &mut current_row_spans {
                        let adjacency_start = span.start.saturating_sub(1);
                        let adjacency_end = span.end.saturating_add(1);

                        while prev_start_idx < prev_row_spans.len()
                            && prev_row_spans[prev_start_idx].end < adjacency_start
                        {
                            prev_start_idx += 1;
                        }

                        let mut probe = prev_start_idx;
                        while probe < prev_row_spans.len()
                            && prev_row_spans[probe].start <= adjacency_end
                        {
                            span.component = component_union(
                                &mut components,
                                span.component,
                                prev_row_spans[probe].component,
                            );
                            probe += 1;
                        }
                    }
                }

                prev_row_spans.clear();
                prev_row_spans.extend_from_slice(&current_row_spans);
                current_row_spans.clear();

                row += 1;
                col = 0;
            }
        }
    }

    if components.is_empty() {
        return (0, 0.0, 0.0, 0);
    }

    let mut seen_roots = vec![false; components.len()];
    let mut total_solid_pixels = 0u32;
    let mut largest_area_mm2 = 0.0f64;
    let mut smallest_area_mm2 = f64::INFINITY;
    let mut area_count = 0u32;

    for index in 0..components.len() {
        let root = component_find(&mut components, index);
        if seen_roots[root] {
            continue;
        }
        seen_roots[root] = true;

        let pixels = components[root].pixels;
        if pixels == 0 {
            continue;
        }

        area_count = area_count.saturating_add(1);
        total_solid_pixels = total_solid_pixels.saturating_add(pixels);

        let area_mm2 = pixels as f64 * pixel_area_mm2;
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

#[inline]
fn blur_radius_px(radius_px: u32) -> usize {
    radius_px.max(1) as usize
}

#[inline]
fn supports_should_bypass_aa(job: &SliceJobV3, triangle_count: usize) -> bool {
    if job.aa_on_supports {
        return false;
    }

    let model_triangle_count = job.model_triangle_count as usize;
    if model_triangle_count == 0 || model_triangle_count >= triangle_count {
        return false;
    }

    let aa_steps = (job.effective_xy_aa_steps() as usize).max(1);
    let blur_mode = job.anti_aliasing_mode_is_blur();
    let blur_radius = if blur_mode {
        blur_radius_px(job.blur_brush_radius_px)
    } else {
        0
    };

    aa_steps > 1 || blur_radius > 0
}

#[inline]
fn split_layer_candidates_by_geometry(
    layer_indices: &[usize],
    model_triangle_count: usize,
    model_out: &mut Vec<usize>,
    support_out: &mut Vec<usize>,
) {
    model_out.clear();
    support_out.clear();

    for &idx in layer_indices {
        if idx < model_triangle_count {
            model_out.push(idx);
        } else {
            support_out.push(idx);
        }
    }
}

fn recompute_layer_stats_from_mask(
    mask: &[u8],
    width: usize,
    height: usize,
    pixel_area_mm2: f64,
    compute_area_stats: bool,
) -> LayerAreaStatsV3 {
    let mut stats = LayerAreaStatsV3::default();

    if width == 0 || height == 0 || mask.is_empty() {
        return stats;
    }

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    for y in 0..height {
        let row_start = y * width;
        for x in 0..width {
            if mask[row_start + x] == 0 {
                continue;
            }

            stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(1);
            min_x = min_x.min(x as i32);
            min_y = min_y.min(y as i32);
            max_x = max_x.max(x as i32);
            max_y = max_y.max(y as i32);
        }
    }

    if stats.total_solid_pixels == 0 {
        return stats;
    }

    stats.min_x = min_x;
    stats.min_y = min_y;
    stats.max_x = max_x;
    stats.max_y = max_y;

    if compute_area_stats {
        let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) =
            compute_component_area_stats_8_connected(
                mask,
                width,
                height,
                min_x as usize,
                max_x as usize,
                min_y as usize,
                max_y as usize,
                pixel_area_mm2,
            );

        stats.total_solid_pixels = total_pixels;
        stats.total_solid_area_mm2 = (total_pixels as f64) * pixel_area_mm2;
        stats.largest_area_mm2 = largest_area_mm2;
        stats.smallest_area_mm2 = smallest_area_mm2;
        stats.area_count = area_count;
    } else {
        let total_area = (stats.total_solid_pixels as f64) * pixel_area_mm2;
        stats.total_solid_area_mm2 = total_area;
        stats.largest_area_mm2 = total_area;
        stats.smallest_area_mm2 = total_area;
        stats.area_count = 1;
    }

    stats
}

fn apply_edge_box_blur_to_mask_in_roi(
    mask: &mut [u8],
    width: usize,
    height: usize,
    radius: usize,
    min_alpha_u8: u8,
    roi_min_x: usize,
    roi_max_x: usize,
    roi_min_y: usize,
    roi_max_y: usize,
) {
    if radius == 0
        || width == 0
        || height == 0
        || mask.is_empty()
        || roi_min_x > roi_max_x
        || roi_min_y > roi_max_y
        || roi_max_x >= width
        || roi_max_y >= height
    {
        return;
    }

    // Separable 2-D box blur.
    //
    // For large ROIs (>= 1 MP in release builds) we use a two-pass parallel
    // H→V approach that saturates all cores via Rayon.  For smaller ROIs or
    // debug builds the Rayon / hpass-allocation overhead dominates; we fall
    // back to the classic single-pass ring-buffer algorithm which uses only
    // O(radius × roi_w) extra memory and has better cache behaviour at small
    // sizes.
    //
    // Denominator terms use global image coordinates so ROI border pixels
    // receive the same implicit-zero attenuation in both paths.

    let roi_w = roi_max_x - roi_min_x + 1;
    let roi_h = roi_max_y - roi_min_y + 1;

    // Parallel only for sufficiently large ROIs.  Keep runtime-configurable so
    // optimized dev profiles can still leverage Rayon.
    let par_thresh = std::env::var("DF_3DAA_BLUR_PAR_THRESH")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1_000_000); // ~1 MP: ~1000×1000 pixels
    let use_par = roi_w.saturating_mul(roi_h) >= par_thresh;

    let h_denom: Vec<u32> = (0..roi_w)
        .map(|ix| {
            let x = roi_min_x + ix;
            (1 + radius.min(x) + radius.min(width - 1 - x)) as u32
        })
        .collect();
    let v_denom: Vec<u32> = (0..roi_h)
        .map(|iy| {
            let y = roi_min_y + iy;
            (1 + radius.min(y) + radius.min(height - 1 - y)) as u32
        })
        .collect();

    if !use_par {
        // ── Sequential ring-buffer path ───────────────────────────────────
        // Single forward pass; ring holds at most (2r+1) rows of horizontal
        // sums.  O(roi_w × roi_h) time, O(radius × roi_w) extra memory.
        let ring_cap = 2 * radius + 1;
        let mut ring = vec![0u16; ring_cap * roi_w];
        let mut col_sums = vec![0u32; roi_w];
        let mut ring_head = 0usize;
        let mut ring_len = 0usize;

        for add_row in 0..roi_h + radius {
            if add_row < roi_h {
                let new_slot = (ring_head + ring_len) % ring_cap;
                let slot_start = new_slot * roi_w;
                let src_y = roi_min_y + add_row;
                let src_row_start = src_y * width + roi_min_x;
                let src = &mask[src_row_start..src_row_start + roi_w];

                let mut sum = 0u32;
                let init_end = radius.min(roi_w - 1);
                for &b in &src[0..=init_end] {
                    sum += b as u32;
                }
                for ix in 0..roi_w {
                    ring[slot_start + ix] = sum as u16;
                    col_sums[ix] += sum;
                    if ix >= radius {
                        sum -= src[ix - radius] as u32;
                    }
                    let r1 = ix + radius + 1;
                    if r1 < roi_w {
                        sum += src[r1] as u32;
                    }
                }
                ring_len += 1;
            }

            if add_row >= radius {
                let out_row = add_row - radius;
                let dst_y = roi_min_y + out_row;
                let dst_row_start = dst_y * width + roi_min_x;
                let row_out = &mut mask[dst_row_start..dst_row_start + roi_w];
                for ix in 0..roi_w {
                    let denom = (h_denom[ix] * v_denom[out_row]).max(1);
                    let raw = (col_sums[ix] + denom / 2) / denom;
                    let mut val = raw.min(255) as u8;
                    if val < min_alpha_u8 {
                        val = 0;
                    }
                    row_out[ix] = val;
                }

                if out_row >= radius {
                    let evict_start = ring_head * roi_w;
                    for ix in 0..roi_w {
                        col_sums[ix] -= ring[evict_start + ix] as u32;
                    }
                    ring_head = (ring_head + 1) % ring_cap;
                    ring_len -= 1;
                }
            }
        }
        return;
    }

    // ── Parallel H→V path (large ROIs, release builds) ───────────────────
    // Thread-local buffer eliminates the ~41 MB per-call heap allocation.
    // Capacity is retained across calls so only the first call per thread pays
    // for OS page mapping; subsequent calls are essentially free.
    //
    // SAFETY invariant: every element of hpass is written by the H-pass
    // before the V-pass reads it, so set_len on uninitialized capacity is fine.
    thread_local! {
        static HPASS: std::cell::UnsafeCell<Vec<u16>> = std::cell::UnsafeCell::new(Vec::new());
    }

    let mask_read = mask.as_ptr() as usize;
    let mask_ptr = mask.as_mut_ptr() as usize;

    HPASS.with(|cell| {
        let needed = roi_w * roi_h;
        // SAFETY: thread_local — only the owning thread accesses this cell.
        let hpass: &mut Vec<u16> = unsafe { &mut *cell.get() };
        if hpass.capacity() < needed {
            hpass.reserve(needed - hpass.len());
        }
        // H-pass writes all elements before V-pass reads any; no need to zero-init.
        unsafe { hpass.set_len(needed) };

        // H-pass: parallel over rows.
        hpass
            .par_chunks_mut(roi_w)
            .enumerate()
            .for_each(|(roi_y, hrow)| {
                // SAFETY: H-pass only reads `mask`; V-pass (which writes) starts
                // only after par_chunks_mut returns — no concurrent read/write.
                let src_start = (roi_min_y + roi_y) * width + roi_min_x;
                let src = unsafe {
                    std::slice::from_raw_parts((mask_read as *const u8).add(src_start), roi_w)
                };
                let mut sum = 0u32;
                let init_end = radius.min(roi_w - 1);
                for &b in &src[..=init_end] {
                    sum += b as u32;
                }
                for roi_x in 0..roi_w {
                    hrow[roi_x] = sum as u16;
                    if roi_x >= radius {
                        sum -= src[roi_x - radius] as u32;
                    }
                    let r1 = roi_x + radius + 1;
                    if r1 < roi_w {
                        sum += src[r1] as u32;
                    }
                }
            });

        let hpass_ptr = hpass.as_ptr() as usize;

        // V-pass: parallel over columns.
        // Safety: each parallel task writes to a distinct column of `mask`;
        // writes at `(roi_min_y + roi_y) * width + roi_min_x + roi_x` are
        // non-overlapping for different `roi_x` values.
        (0..roi_w).into_par_iter().for_each(|roi_x| {
            // SAFETY: see comment above.
            let hp = hpass_ptr as *const u16;
            let mp = mask_ptr as *mut u8;
            let mut col_sum = 0u32;
            let init_end = radius.min(roi_h - 1);
            for roi_y in 0..=init_end {
                col_sum += unsafe { *hp.add(roi_y * roi_w + roi_x) } as u32;
            }
            for roi_y in 0..roi_h {
                let denom = (h_denom[roi_x] * v_denom[roi_y]).max(1);
                let raw = (col_sum + denom / 2) / denom;
                let mut val = raw.min(255) as u8;
                // Zero out pixels below the min-alpha floor rather than clamping
                // them up — see original function for full rationale.
                if val < min_alpha_u8 {
                    val = 0;
                }
                // SAFETY: column roi_x, disjoint from all other parallel tasks.
                unsafe {
                    *mp.add((roi_min_y + roi_y) * width + roi_min_x + roi_x) = val;
                }
                // Slide vertical window down.
                let bot = roi_y + radius + 1;
                if bot < roi_h {
                    col_sum += unsafe { *hp.add(bot * roi_w + roi_x) } as u32;
                }
                if roi_y >= radius {
                    col_sum -= unsafe { *hp.add((roi_y - radius) * roi_w + roi_x) } as u32;
                }
            }
        });
    }); // end HPASS.with
}

#[cfg(test)]
pub(crate) fn apply_blur_postprocess_inplace(
    mask: &mut [u8],
    width: usize,
    height: usize,
    radius: usize,
    min_alpha_u8: u8,
) {
    if radius == 0 || width == 0 || height == 0 || mask.is_empty() {
        return;
    }

    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut any_non_zero = false;

    for y in 0..height {
        let row_start = y * width;
        for x in 0..width {
            if mask[row_start + x] == 0 {
                continue;
            }
            any_non_zero = true;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
    }

    if !any_non_zero {
        return;
    }

    let r = radius as i32;
    let roi_min_x = (min_x as i32).saturating_sub(r).max(0) as usize;
    let roi_max_x = ((max_x as i32).saturating_add(r)).min(width as i32 - 1) as usize;
    let roi_min_y = (min_y as i32).saturating_sub(r).max(0) as usize;
    let roi_max_y = ((max_y as i32).saturating_add(r)).min(height as i32 - 1) as usize;

    apply_blur_postprocess_inplace_with_roi(
        mask,
        width,
        height,
        roi_min_x,
        roi_max_x,
        roi_min_y,
        roi_max_y,
        radius,
        min_alpha_u8,
    );
}

pub(crate) fn apply_blur_postprocess_inplace_with_roi(
    mask: &mut [u8],
    width: usize,
    height: usize,
    roi_min_x: usize,
    roi_max_x: usize,
    roi_min_y: usize,
    roi_max_y: usize,
    radius: usize,
    min_alpha_u8: u8,
) {
    if radius == 0 || width == 0 || height == 0 || mask.is_empty() {
        return;
    }
    if roi_min_x >= width || roi_min_y >= height {
        return;
    }
    let clamped_max_x = roi_max_x.min(width - 1);
    let clamped_max_y = roi_max_y.min(height - 1);
    if roi_min_x > clamped_max_x || roi_min_y > clamped_max_y {
        return;
    }

    apply_edge_box_blur_to_mask_in_roi(
        mask,
        width,
        height,
        radius,
        min_alpha_u8,
        roi_min_x,
        clamped_max_x,
        roi_min_y,
        clamped_max_y,
    );
}

pub(crate) fn encode_mask_to_rle(
    mask: &[u8],
    width: usize,
    height: usize,
) -> Vec<crate::rle::RleRun> {
    use crate::rle::{emit_row, RleAccum};

    let mut rle = RleAccum::new();
    for row_index in 0..height {
        let row_start = row_index * width;
        let row = &mask[row_start..row_start + width];
        emit_row(&mut rle, row);
    }
    rle.finish()
}

#[inline]
fn apply_lut_to_mask_in_bounds(
    mask: &mut [u8],
    width: usize,
    min_x: usize,
    max_x: usize,
    min_y: usize,
    max_y: usize,
    lut: &[u8; 256],
) {
    if width == 0 || min_x > max_x || min_y > max_y {
        return;
    }

    for y in min_y..=max_y {
        let row_start = y * width;
        for x in min_x..=max_x {
            let idx = row_start + x;
            mask[idx] = lut[mask[idx] as usize];
        }
    }
}

pub fn remap_gray_rle_with_lut(
    runs: &[crate::rle::RleRun],
    lut: &[u8; 256],
) -> Vec<crate::rle::RleRun> {
    use crate::rle::RleAccum;

    if runs.is_empty() {
        return Vec::new();
    }

    let mut out = RleAccum::new();
    for run in runs {
        out.push_run(run.length, lut[run.value as usize]);
    }
    out.finish()
}

#[cfg(test)]
pub(crate) fn encode_mask_to_rle_in_bounds(
    mask: &[u8],
    width: usize,
    height: usize,
    bounds: Option<(usize, usize, usize, usize)>,
) -> Vec<crate::rle::RleRun> {
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    let mut rle = RleAccum::new();
    if width == 0 || height == 0 {
        return rle.finish();
    }
    let Some((min_x, max_x, min_y, max_y)) = bounds else {
        emit_zero_rows(&mut rle, height, width);
        return rle.finish();
    };

    let min_x = min_x.min(width - 1);
    let max_x = max_x.min(width - 1);
    let min_y = min_y.min(height - 1);
    let max_y = max_y.min(height - 1);
    if min_x > max_x || min_y > max_y {
        emit_zero_rows(&mut rle, height, width);
        return rle.finish();
    }

    emit_zero_rows(&mut rle, min_y, width);
    for row_index in min_y..=max_y {
        let row_start = row_index * width;
        if min_x > 0 {
            rle.push_run(min_x as u32, 0);
        }
        emit_row(&mut rle, &mask[row_start + min_x..=row_start + max_x]);
        let right = width - 1 - max_x;
        if right > 0 {
            rle.push_run(right as u32, 0);
        }
    }
    emit_zero_rows(&mut rle, height - 1 - max_y, width);
    rle.finish()
}

#[cfg(test)]
pub(crate) fn encode_bounded_gray_mask_to_rle(
    mask: &crate::binary_mask::BoundedGrayMask,
    width: usize,
    height: usize,
) -> Vec<crate::rle::RleRun> {
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    let mut rle = RleAccum::new();
    if width == 0 || height == 0 {
        return rle.finish();
    }

    let view = mask.as_view();
    let Some((min_x, max_x, min_y, max_y)) = view.bounds() else {
        emit_zero_rows(&mut rle, height, width);
        return rle.finish();
    };

    let min_x = min_x.min(width - 1);
    let max_x = max_x.min(width - 1);
    let min_y = min_y.min(height - 1);
    let max_y = max_y.min(height - 1);
    if min_x > max_x || min_y > max_y {
        emit_zero_rows(&mut rle, height, width);
        return rle.finish();
    }

    emit_zero_rows(&mut rle, min_y, width);
    for row_index in min_y..=max_y {
        if min_x > 0 {
            rle.push_run(min_x as u32, 0);
        }
        if let Some(row) = view.row(row_index) {
            emit_row(&mut rle, row);
        } else {
            rle.push_run((max_x - min_x + 1) as u32, 0);
        }
        let right = width - 1 - max_x;
        if right > 0 {
            rle.push_run(right as u32, 0);
        }
    }
    emit_zero_rows(&mut rle, height - 1 - max_y, width);
    rle.finish()
}

fn build_scanline_segment_index(
    segments: &[Segment],
    height: usize,
    aa_steps: usize,
    subrow_phase: f32,
) -> Option<ScanlineSegmentIndex> {
    let sub_height = height * aa_steps;
    if sub_height == 0 {
        return None;
    }

    let mut start_counts = vec![0usize; sub_height];
    let mut start_rows = vec![usize::MAX; segments.len()];
    let mut end_exclusive = vec![0usize; segments.len()];
    let mut global_start = sub_height;
    let mut global_end = 0usize;

    let f_steps = aa_steps as f32;

    for (idx, seg) in segments.iter().enumerate() {
        let start = (seg.y_min * f_steps - subrow_phase).ceil() as i32;
        let end = (seg.y_max * f_steps - subrow_phase).ceil() as i32;

        let clamped_start = start.clamp(0, sub_height as i32) as usize;
        let clamped_end = end.clamp(0, sub_height as i32) as usize;

        if clamped_start >= clamped_end || clamped_start >= sub_height {
            continue;
        }

        start_counts[clamped_start] += 1;
        start_rows[idx] = clamped_start;
        end_exclusive[idx] = clamped_end;
        global_start = global_start.min(clamped_start);
        global_end = global_end.max(clamped_end);
    }

    if global_start >= global_end {
        return None;
    }

    let mut row_offsets = vec![0usize; sub_height + 1];
    for y in 0..sub_height {
        row_offsets[y + 1] = row_offsets[y] + start_counts[y];
    }

    let total_starts = row_offsets[sub_height];
    let mut indexed = vec![
        ActiveEdge {
            x: 0.0,
            dx_dy: 0.0,
            wind: 0,
            end_exclusive: 0,
        };
        total_starts
    ];
    let mut write_offsets = row_offsets[..sub_height].to_vec();

    for (seg_idx, seg) in segments.iter().enumerate() {
        let y = start_rows[seg_idx];
        if y == usize::MAX {
            continue;
        }

        let y_sample = (y as f32 + subrow_phase) / f_steps;
        let x = seg.x1 + (y_sample - seg.y1) * seg.dx_dy;
        let pos = write_offsets[y];
        indexed[pos] = ActiveEdge {
            x,
            dx_dy: seg.dx_dy / f_steps,
            wind: seg.wind,
            end_exclusive: end_exclusive[seg_idx],
        };
        write_offsets[y] += 1;
    }

    for y in global_start..global_end {
        let start = row_offsets[y];
        let end = row_offsets[y + 1];
        if end.saturating_sub(start) > 1 {
            indexed[start..end].sort_unstable_by(active_edge_cmp);
        }
    }

    Some(ScanlineSegmentIndex {
        starts: indexed,
        row_offsets,
        y_start: global_start,
        y_end_exclusive: global_end,
    })
}

/// Rasterize one layer into an 8-bit grayscale mask (`0` or `255`).
fn rasterize_layer_with_stats_impl(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
    compute_area_stats: bool,
) -> (Vec<u8>, LayerAreaStatsV3) {
    let width = job.effective_render_width_px() as usize;
    let height = job.source_height_px as usize;
    let mut mask = crate::pipeline::get_recycled_mask(width * height);
    let mut stats = LayerAreaStatsV3::default();

    if layer_indices.is_empty() {
        return (mask, stats);
    }

    let aa_level_steps = job.effective_xy_aa_steps();
    let aa_steps = (aa_level_steps as usize).max(1);

    // Coverage raster path with optional SSAA for Coverage mode only.
    // Blur mode intentionally forces binary coverage rasterization, then applies
    // ROI blur as the sole 2D AA step.
    let blur_mode = job.anti_aliasing_mode_is_blur();
    let blur_radius = if blur_mode {
        blur_radius_px(job.blur_brush_radius_px)
    } else {
        0
    };
    let aa_enabled = aa_steps > 1;
    let min_aa_alpha_u8 = if blur_radius > 0 {
        ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8
    } else {
        0
    };
    let blur_custom_lut = if blur_mode {
        job.normalized_custom_cure_lut()
    } else {
        None
    };
    let z_mm = (layer_index as f32 + 0.5) * job.layer_height_mm;
    let segments = build_segments_for_layer(job, triangles, layer_indices, z_mm);
    if segments.is_empty() {
        return (mask, stats);
    }

    let Some(scanline_index) = build_scanline_segment_index(&segments, height, aa_steps, 0.5)
    else {
        return (mask, stats);
    };
    let scanline_starts = scanline_index.starts;
    let scanline_row_offsets = scanline_index.row_offsets;
    let y_start = scanline_index.y_start;
    let y_end_exclusive = scanline_index.y_end_exclusive;
    let track_aa_components = compute_area_stats && aa_enabled;
    let mut aa_component_tracker = if track_aa_components {
        Some(ComponentSpanTracker::new())
    } else {
        None
    };

    let pixel_area_mm2 = ((job.build_width_mm as f64) / (job.source_width_px.max(1) as f64))
        * ((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    let mut active_edges: Vec<ActiveEdge> = Vec::with_capacity(segments.len().min(256));
    let mut merge_scratch: Vec<ActiveEdge> = Vec::with_capacity(segments.len().min(256));

    let mut row_accum = vec![0u32; width];
    let mut row_delta = if aa_enabled {
        vec![0i32; width + 1]
    } else {
        Vec::new()
    };
    let mut row_hit_delta = if track_aa_components {
        vec![0i32; width + 1]
    } else {
        Vec::new()
    };
    let mut current_physical_y = if y_start < y_end_exclusive {
        y_start / aa_steps
    } else {
        0
    };

    for y in y_start..y_end_exclusive {
        let physical_y = y / aa_steps;

        if physical_y != current_physical_y {
            if aa_enabled && current_physical_y < height {
                let r_start = current_physical_y * width;
                let mask_row = &mut mask[r_start..r_start + width];
                let mut coverage = 0i32;
                let mut occupied = 0i32;
                let mut run_start: Option<usize> = None;

                for x in 0..width {
                    coverage += row_delta[x];
                    let acc = if coverage > 0 {
                        row_accum[x].saturating_add(coverage as u32)
                    } else {
                        row_accum[x]
                    };
                    if acc > 0 {
                        let resolved = (acc / (aa_steps as u32)).min(255) as u8;
                        mask_row[x] = resolved.max(min_aa_alpha_u8);
                    }
                    row_accum[x] = 0;
                    row_delta[x] = 0;

                    if track_aa_components {
                        occupied += row_hit_delta[x];
                        let is_occupied = occupied > 0;
                        if is_occupied {
                            if run_start.is_none() {
                                run_start = Some(x);
                            }
                        } else if let Some(start) = run_start.take() {
                            if let Some(ref mut tracker) = aa_component_tracker {
                                tracker.push_span(start, x - 1);
                            }
                        }
                        row_hit_delta[x] = 0;
                    }
                }

                row_delta[width] = 0;
                if track_aa_components {
                    if let Some(start) = run_start {
                        if let Some(ref mut tracker) = aa_component_tracker {
                            tracker.push_span(start, width - 1);
                        }
                    }
                    row_hit_delta[width] = 0;
                    if let Some(ref mut tracker) = aa_component_tracker {
                        tracker.finish_row();
                    }
                }
            }
            current_physical_y = physical_y;
        }

        active_edges.retain(|edge| edge.end_exclusive > y);
        let row_start = scanline_row_offsets[y];
        let row_end = scanline_row_offsets[y + 1];
        if row_start != row_end {
            merge_active_edges_sorted(
                &mut active_edges,
                &scanline_starts[row_start..row_end],
                &mut merge_scratch,
            );
        }
        if active_edges.is_empty() {
            continue;
        }

        let row_start = physical_y * width;

        let spans = build_row_spans_nonzero(&active_edges, width, !aa_enabled);

        for span in spans {
            if !aa_enabled {
                let row = &mut mask[row_start..row_start + width];
                row[span.start..=span.end].fill(255);
            } else {
                // 2D Uniform Supersampling combining exact analytic X with N-stepped Y
                let left_i = span.a.floor() as i32;
                let right_i = span.b.ceil() as i32 - 1;

                if left_i <= right_i {
                    if left_i == right_i {
                        if left_i >= 0 && left_i < width as i32 {
                            let cov = (span.b - span.a).clamp(0.0, 1.0) * 255.0;
                            row_accum[left_i as usize] += cov as u32;
                        }
                    } else {
                        let left_cov = ((left_i as f32 + 1.0) - span.a).clamp(0.0, 1.0) * 255.0;
                        let right_cov = (span.b - right_i as f32).clamp(0.0, 1.0) * 255.0;

                        if left_i >= 0 && left_i < width as i32 {
                            row_accum[left_i as usize] += left_cov as u32;
                        }

                        let interior_start = (left_i + 1).max(0) as usize;
                        let interior_end = (right_i - 1).min(width as i32 - 1) as usize;
                        if interior_end >= interior_start {
                            row_delta[interior_start] += 255;
                            row_delta[interior_end + 1] -= 255;
                        }

                        if right_i >= 0 && right_i < width as i32 {
                            row_accum[right_i as usize] += right_cov as u32;
                        }
                    }
                }

                if track_aa_components {
                    row_hit_delta[span.start] += 1;
                    row_hit_delta[span.end + 1] -= 1;
                }
            }

            let filled = (span.end - span.start + 1) as u32;
            stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(filled);

            min_x = min_x.min(span.start as i32);
            max_x = max_x.max(span.end as i32);
            min_y = min_y.min(physical_y as i32);
            max_y = max_y.max(physical_y as i32);
        }

        for edge in &mut active_edges {
            edge.x += edge.dx_dy;
        }
        restore_active_edges_sorted(&mut active_edges);
    }

    if blur_radius > 0 && stats.total_solid_pixels > 0 {
        let effective_radius = blur_radius;

        let r = effective_radius as i32;
        let roi_min_x = min_x.saturating_sub(r).max(0) as usize;
        let roi_max_x = (max_x.saturating_add(r)).min(width as i32 - 1) as usize;
        let roi_min_y = min_y.saturating_sub(r).max(0) as usize;
        let roi_max_y = (max_y.saturating_add(r)).min(height as i32 - 1) as usize;

        apply_edge_box_blur_to_mask_in_roi(
            &mut mask,
            width,
            height,
            effective_radius,
            if blur_custom_lut.is_some() {
                0
            } else {
                min_aa_alpha_u8
            },
            roi_min_x,
            roi_max_x,
            roi_min_y,
            roi_max_y,
        );

        if let Some(lut) = blur_custom_lut.as_ref() {
            apply_lut_to_mask_in_bounds(
                &mut mask, width, roi_min_x, roi_max_x, roi_min_y, roi_max_y, lut,
            );
        }

        let mut total_solid_pixels = 0u32;
        let mut blur_min_x = i32::MAX;
        let mut blur_min_y = i32::MAX;
        let mut blur_max_x = i32::MIN;
        let mut blur_max_y = i32::MIN;

        for y in roi_min_y..=roi_max_y {
            let row_start = y * width;
            for x in roi_min_x..=roi_max_x {
                if mask[row_start + x] == 0 {
                    continue;
                }

                total_solid_pixels = total_solid_pixels.saturating_add(1);
                blur_min_x = blur_min_x.min(x as i32);
                blur_min_y = blur_min_y.min(y as i32);
                blur_max_x = blur_max_x.max(x as i32);
                blur_max_y = blur_max_y.max(y as i32);
            }
        }

        if total_solid_pixels > 0 {
            stats.total_solid_pixels = total_solid_pixels;
            stats.min_x = blur_min_x;
            stats.min_y = blur_min_y;
            stats.max_x = blur_max_x;
            stats.max_y = blur_max_y;

            if compute_area_stats {
                let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) =
                    compute_component_area_stats_8_connected(
                        &mask,
                        width,
                        height,
                        blur_min_x as usize,
                        blur_max_x as usize,
                        blur_min_y as usize,
                        blur_max_y as usize,
                        pixel_area_mm2,
                    );

                stats.total_solid_pixels = total_pixels;
                let total_area = (total_pixels as f64) * pixel_area_mm2;
                stats.total_solid_area_mm2 = total_area;
                stats.largest_area_mm2 = largest_area_mm2;
                stats.smallest_area_mm2 = smallest_area_mm2;
                stats.area_count = area_count;
            } else {
                let total_area = (stats.total_solid_pixels as f64) * pixel_area_mm2;
                stats.total_solid_area_mm2 = total_area;
                stats.largest_area_mm2 = total_area;
                stats.smallest_area_mm2 = total_area;
                stats.area_count = 1;
            }
        }

        return (mask, stats);
    }

    if aa_enabled && current_physical_y < height {
        let r_start = current_physical_y * width;
        if r_start < mask.len() {
            let mask_row = &mut mask[r_start..r_start + width];
            let mut coverage = 0i32;
            let mut occupied = 0i32;
            let mut run_start: Option<usize> = None;
            for x in 0..width {
                coverage += row_delta[x];
                let acc = if coverage > 0 {
                    row_accum[x].saturating_add(coverage as u32)
                } else {
                    row_accum[x]
                };
                if acc > 0 {
                    let resolved = (acc / (aa_steps as u32)).min(255) as u8;
                    mask_row[x] = resolved.max(min_aa_alpha_u8);
                }
                row_accum[x] = 0;
                row_delta[x] = 0;

                if track_aa_components {
                    occupied += row_hit_delta[x];
                    let is_occupied = occupied > 0;
                    if is_occupied {
                        if run_start.is_none() {
                            run_start = Some(x);
                        }
                    } else if let Some(start) = run_start.take() {
                        if let Some(ref mut tracker) = aa_component_tracker {
                            tracker.push_span(start, x - 1);
                        }
                    }
                    row_hit_delta[x] = 0;
                }
            }

            row_delta[width] = 0;
            if track_aa_components {
                if let Some(start) = run_start {
                    if let Some(ref mut tracker) = aa_component_tracker {
                        tracker.push_span(start, width - 1);
                    }
                }
                row_hit_delta[width] = 0;
                if let Some(ref mut tracker) = aa_component_tracker {
                    tracker.finish_row();
                }
            }
        }
    }

    if aa_enabled {
        stats.total_solid_pixels /= aa_steps as u32;
    }

    if stats.total_solid_pixels > 0 {
        stats.min_x = min_x;
        stats.min_y = min_y;
        stats.max_x = max_x;
        stats.max_y = max_y;

        if compute_area_stats {
            let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) = if aa_enabled {
                aa_component_tracker
                    .take()
                    .map(|tracker| tracker.finalize(pixel_area_mm2))
                    .unwrap_or((0, 0.0, 0.0, 0))
            } else {
                compute_component_area_stats_8_connected(
                    &mask,
                    width,
                    height,
                    min_x as usize,
                    max_x as usize,
                    min_y as usize,
                    max_y as usize,
                    pixel_area_mm2,
                )
            };

            stats.total_solid_pixels = total_pixels;
            let total_area = (total_pixels as f64) * pixel_area_mm2;
            stats.total_solid_area_mm2 = total_area;
            stats.largest_area_mm2 = largest_area_mm2;
            stats.smallest_area_mm2 = smallest_area_mm2;
            stats.area_count = area_count;
        } else {
            let total_area = (stats.total_solid_pixels as f64) * pixel_area_mm2;
            stats.total_solid_area_mm2 = total_area;
            stats.largest_area_mm2 = total_area;
            stats.smallest_area_mm2 = total_area;
            stats.area_count = 1;
        }
    }

    (mask, stats)
}

/// Rasterize one layer into an 8-bit grayscale mask (`0` or `255`), optionally
/// bypassing AA for support/raft geometry when model/support split metadata is
/// provided in `job.model_triangle_count`.
pub fn rasterize_layer_with_stats(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
    compute_area_stats: bool,
) -> (Vec<u8>, LayerAreaStatsV3) {
    if !supports_should_bypass_aa(job, triangles.len()) {
        return rasterize_layer_with_stats_impl(
            job,
            triangles,
            layer_indices,
            layer_index,
            compute_area_stats,
        );
    }

    let model_triangle_count = (job.model_triangle_count as usize).min(triangles.len());
    let mut model_layer_indices = Vec::with_capacity(layer_indices.len());
    let mut support_layer_indices = Vec::with_capacity(layer_indices.len());
    split_layer_candidates_by_geometry(
        layer_indices,
        model_triangle_count,
        &mut model_layer_indices,
        &mut support_layer_indices,
    );

    if support_layer_indices.is_empty() {
        return rasterize_layer_with_stats_impl(
            job,
            triangles,
            &model_layer_indices,
            layer_index,
            compute_area_stats,
        );
    }

    let (mut model_mask, _model_stats) =
        rasterize_layer_with_stats_impl(job, triangles, &model_layer_indices, layer_index, false);

    let mut support_job = job.clone();
    support_job.anti_aliasing_level = "Off".to_string();
    support_job.anti_aliasing_mode = "Coverage".to_string();
    support_job.blur_brush_radius_px = 0;
    support_job.minimum_aa_alpha_percent = 100.0;
    support_job.aa_on_supports = true;
    support_job.model_triangle_count = 0;

    let (support_mask, _support_stats) = rasterize_layer_with_stats_impl(
        &support_job,
        triangles,
        &support_layer_indices,
        layer_index,
        false,
    );

    for (dst, src) in model_mask.iter_mut().zip(support_mask.iter()) {
        if *src > *dst {
            *dst = *src;
        }
    }

    let pixel_area_mm2 = ((job.build_width_mm as f64) / (job.source_width_px.max(1) as f64))
        * ((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));

    let stats = recompute_layer_stats_from_mask(
        &model_mask,
        job.effective_render_width_px() as usize,
        job.source_height_px as usize,
        pixel_area_mm2,
        compute_area_stats,
    );

    (model_mask, stats)
}

/// Rasterize one layer into an 8-bit grayscale mask (`0` or `255`).
pub fn rasterize_layer(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
) -> Vec<u8> {
    rasterize_layer_with_stats(job, triangles, layer_indices, layer_index, false).0
}

/// Rasterize one layer directly into RLE output — no full-image mask buffer.
///
/// Functionally equivalent to `rasterize_layer_with_stats` but uses a single
/// row-wide scratch buffer instead of a full WH-pixel mask.  This eliminates
/// the dominant 40-56 MB allocation at 8 K resolution for CTB and other
/// formats that do not need PNG. When `compute_area_stats` is true, a binary
/// stats mask is captured and 8-connected component analysis is applied.
#[allow(unused_assignments)]
pub fn rasterize_layer_rle(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
    compute_area_stats: bool,
) -> (Vec<crate::rle::RleRun>, LayerAreaStatsV3) {
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    let width = job.effective_render_width_px() as usize;
    let height = job.source_height_px as usize;
    let mut rle = RleAccum::new();
    let mut stats = LayerAreaStatsV3::default();

    if layer_indices.is_empty() || width == 0 || height == 0 {
        emit_zero_rows(&mut rle, height, width);
        return (rle.finish(), stats);
    }

    if supports_should_bypass_aa(job, triangles.len()) {
        let (mask, stats) = rasterize_layer_with_stats(
            job,
            triangles,
            layer_indices,
            layer_index,
            compute_area_stats,
        );
        let runs = encode_mask_to_rle(&mask, width, height);
        return (runs, stats);
    }

    // Binary single-Z streaming path.
    // AA (SSAA supersampling + optional blur) is applied at the engine level
    // before this function is called — the rasterizer always sees a binary job.
    let z_mm = (layer_index as f32 + 0.5) * job.layer_height_mm;
    let segments = build_segments_for_layer(job, triangles, layer_indices, z_mm);
    if segments.is_empty() {
        emit_zero_rows(&mut rle, height, width);
        return (rle.finish(), stats);
    }

    let Some(scanline_index) = build_scanline_segment_index(&segments, height, 1, 0.5) else {
        emit_zero_rows(&mut rle, height, width);
        return (rle.finish(), stats);
    };
    let scanline_starts = scanline_index.starts;
    let scanline_row_offsets = scanline_index.row_offsets;
    let y_start = scanline_index.y_start;
    let y_end_exclusive = scanline_index.y_end_exclusive;
    let first_physical_y = y_start;
    // Emit zero rows before the rasterized region.
    emit_zero_rows(&mut rle, first_physical_y, width);

    let pixel_area_mm2 = ((job.build_width_mm as f64)
        / (job.effective_render_width_px().max(1) as f64))
        * ((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    let mut active_edges: Vec<ActiveEdge> = Vec::with_capacity(segments.len().min(256));
    let mut merge_scratch: Vec<ActiveEdge> = Vec::with_capacity(segments.len().min(256));

    // Single-row scratch buffer — width bytes max (7680 at 8 K).
    let mut row_buf = vec![0u8; width];
    let mut current_physical_y = first_physical_y;
    // last_emitted_py: the most recent physical row fully committed to `rle`.
    // Starts at first_physical_y - 1 (we just emitted zeros 0..first_physical_y).
    #[allow(unused_assignments)]
    let mut last_emitted_py = first_physical_y.wrapping_sub(1);

    // Helper closure: commit `current_physical_y`'s row to `rle`, then emit
    // zero-rows for any skipped rows up to (but not including) `next_py`.
    macro_rules! flush_up_to {
        ($next_py:expr) => {{
            emit_row(&mut rle, &row_buf);
            row_buf.fill(0);
            last_emitted_py = current_physical_y;

            let next = $next_py;
            let gap = next.saturating_sub(last_emitted_py + 1);
            if gap > 0 {
                emit_zero_rows(&mut rle, gap, width);
                last_emitted_py = next - 1;
            }
        }};
    }

    for y in y_start..y_end_exclusive {
        let physical_y = y;

        if physical_y != current_physical_y {
            flush_up_to!(physical_y);
            current_physical_y = physical_y;
        }

        active_edges.retain(|edge| edge.end_exclusive > y);
        let row_start = scanline_row_offsets[y];
        let row_end = scanline_row_offsets[y + 1];
        if row_start != row_end {
            merge_active_edges_sorted(
                &mut active_edges,
                &scanline_starts[row_start..row_end],
                &mut merge_scratch,
            );
        }
        if active_edges.is_empty() {
            continue;
        }

        let spans = build_row_spans_nonzero(&active_edges, width, true);

        for span in spans {
            row_buf[span.start..=span.end].fill(255);

            let filled = (span.end - span.start + 1) as u32;
            stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(filled);
            min_x = min_x.min(span.start as i32);
            max_x = max_x.max(span.end as i32);
            min_y = min_y.min(physical_y as i32);
            max_y = max_y.max(physical_y as i32);
        }

        for edge in &mut active_edges {
            edge.x += edge.dx_dy;
        }
        restore_active_edges_sorted(&mut active_edges);
    }

    // Flush the final accumulated physical row.
    flush_up_to!(current_physical_y + 1);

    // Emit remaining zero rows to fill the image height.
    let rows_emitted = last_emitted_py + 1;
    if rows_emitted < height {
        emit_zero_rows(&mut rle, height - rows_emitted, width);
    }

    let runs = rle.finish();

    if stats.total_solid_pixels > 0 {
        stats.min_x = min_x;
        stats.min_y = min_y;
        stats.max_x = max_x;
        stats.max_y = max_y;

        if compute_area_stats {
            let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) =
                compute_component_area_stats_from_rle_8_connected(
                    &runs,
                    width,
                    height,
                    pixel_area_mm2,
                );

            stats.total_solid_pixels = total_pixels;
            let total_area = (total_pixels as f64) * pixel_area_mm2;
            stats.total_solid_area_mm2 = total_area;
            stats.largest_area_mm2 = largest_area_mm2;
            stats.smallest_area_mm2 = smallest_area_mm2;
            stats.area_count = area_count;
        } else {
            let total_area = (stats.total_solid_pixels as f64) * pixel_area_mm2;
            stats.total_solid_area_mm2 = total_area;
            stats.largest_area_mm2 = total_area;
            stats.smallest_area_mm2 = total_area;
            stats.area_count = 1;
        }
    }

    (runs, stats)
}

// ── Resolution-scaling supersampler ───────────────────────────────────────────
//
// The approach:
//   1. Rasterize at Nx resolution using the ultra-fast binary RLE engine.
//   2. Call `downsample_binary_rle_to_gray_rle` to collapse every NxN
//      super-pixel block into one output pixel whose gray value is the
//      fraction of lit super-pixels (0–255).
//   3. Optionally apply `apply_blur_postprocess_inplace` post-downsample.
//
// No full-image pixel buffer is ever allocated at either resolution.

/// Accumulate a lit span [sx_start, sx_start + len) of super-pixels into
/// per-output-column count arrays using a difference-array trick so that
/// fully-covered interior columns are O(1) instead of O(out_width).
#[inline]
fn accumulate_lit_span(
    sx_start: usize,
    len: usize,
    factor: usize,
    out_width: usize,
    col_lit: &mut [u32],
    col_delta: &mut [i32],
) {
    debug_assert_eq!(col_lit.len(), out_width);
    debug_assert_eq!(col_delta.len(), out_width + 1);

    if len == 0 || out_width == 0 {
        return;
    }

    let sx_end = sx_start + len;
    let out_left = sx_start / factor;
    let out_right_ceil = sx_end.div_ceil(factor);
    let out_right = out_right_ceil.min(out_width); // exclusive

    if out_left >= out_width || out_left >= out_right {
        return;
    }

    // Fast path: entire span fits within one output column.
    if out_right == out_left + 1 {
        col_lit[out_left] += len as u32;
        return;
    }

    // Left partial column: super-pixels from sx_start up to the right edge of out_left.
    let left_boundary = (out_left + 1) * factor; // exclusive right edge of out_left column
    let left_partial = left_boundary - sx_start;
    col_lit[out_left] += left_partial as u32;

    // Fully covered interior columns: each has exactly `factor` lit super-pixels.
    // Use difference-array so this is O(1) regardless of the run length.
    let full_start = out_left + 1;
    let full_end = (sx_end / factor).min(out_width); // exclusive
    if full_start < full_end {
        col_delta[full_start] += factor as i32;
        col_delta[full_end] -= factor as i32;
    }

    // Right partial column: super-pixels from its left edge up to sx_end.
    let right_col = sx_end / factor;
    if right_col < out_width && sx_end % factor != 0 {
        let right_partial = sx_end - right_col * factor;
        col_lit[right_col] += right_partial as u32;
    }
}

/// Downsample a super-resolution binary RLE layer to output resolution.
///
/// `runs` must cover exactly `super_width × super_height` pixels in row-major
/// order with binary values (0 or 255).  `factor` must divide both dimensions
/// evenly; the output covers `(super_width/factor) × (super_height/factor)`
/// pixels.
///
/// Each `factor × factor` block of super-pixels collapses into one output
/// pixel with gray value proportional to the lit fraction:
///
/// ```text
/// gray = (lit_count * 255 + max_count/2) / max_count   (rounded)
/// ```
///
/// Pixels below `min_alpha_u8` after rounding are clamped to zero.
///
/// No full-image buffer is allocated at any point — the downsampler works
/// entirely in O(out_width) per output row.
pub fn downsample_binary_rle_to_gray_rle(
    runs: &[crate::rle::RleRun],
    super_width: usize,
    super_height: usize,
    factor: usize,
    min_alpha_u8: u8,
) -> Vec<crate::rle::RleRun> {
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    debug_assert!(factor >= 1, "SSAA factor must be >= 1");
    debug_assert_eq!(
        super_width % factor,
        0,
        "super_width must be divisible by factor"
    );
    debug_assert_eq!(
        super_height % factor,
        0,
        "super_height must be divisible by factor"
    );

    if factor <= 1 || runs.is_empty() {
        return runs.to_vec();
    }

    let out_width = super_width / factor;
    let out_height = super_height / factor;
    let max_count = (factor * factor) as u32;

    // col_lit[ox]: accumulated lit super-pixel count for output column ox over
    // the current block of `factor` super-rows.
    let mut col_lit: Vec<u32> = vec![0; out_width];
    // Difference array for fully-covered interior spans (O(1) per run, O(out_width) flush).
    let mut col_delta: Vec<i32> = vec![0; out_width + 1];

    let mut out_rle = RleAccum::new();
    // Scratch buffer for one output row — reused to avoid per-row allocation.
    let mut row_buf = vec![0u8; out_width];
    // Track whether any lit span was accumulated in the current factor-row group.
    // If false at flush time, the entire group is blank → emit_zero_rows (O(1)).
    let mut has_any_lit = false;
    let mut super_col: usize = 0;
    let mut super_row: usize = 0;
    let mut output_rows_emitted = 0usize;

    for run in runs {
        let lit = run.value >= 128;
        let mut remaining = run.length as usize;

        while remaining > 0 {
            // Pixels left in the current super-row.
            let row_remaining = super_width - super_col;
            let take = remaining.min(row_remaining);

            if lit {
                accumulate_lit_span(
                    super_col,
                    take,
                    factor,
                    out_width,
                    &mut col_lit,
                    &mut col_delta,
                );
                has_any_lit = true;
            }

            super_col += take;
            remaining -= take;

            if super_col >= super_width {
                super_col = 0;
                super_row += 1;

                // Every `factor` super-rows complete one output row.
                if super_row % factor == 0 {
                    if !has_any_lit {
                        // Fast path: entire factor-row group was blank — O(1).
                        emit_zero_rows(&mut out_rle, 1, out_width);
                    } else {
                        has_any_lit = false;
                        // Apply the difference array to col_lit.
                        let mut delta_accum = 0i32;
                        for ox in 0..out_width {
                            delta_accum += col_delta[ox];
                            col_lit[ox] = col_lit[ox].saturating_add(delta_accum.max(0) as u32);
                            col_delta[ox] = 0;
                        }
                        col_delta[out_width] = 0;
                        // Compute gray values into scratch buffer, emit as a single batched RLE row.
                        for ox in 0..out_width {
                            let lit_count = col_lit[ox];
                            col_lit[ox] = 0;
                            let raw =
                                ((lit_count * 255 + max_count / 2) / max_count).min(255) as u8;
                            row_buf[ox] = if raw > 0 && raw < min_alpha_u8 {
                                0u8
                            } else {
                                raw
                            };
                        }
                        emit_row(&mut out_rle, &row_buf);
                    }
                    output_rows_emitted += 1;
                }
            }
        }
    }

    // Emit any trailing partial output row (edge case with incomplete input).
    if output_rows_emitted < out_height {
        if !has_any_lit {
            // Entire remaining tail is blank.
            emit_zero_rows(&mut out_rle, out_height - output_rows_emitted, out_width);
        } else {
            // Apply the difference array once for the partial group.
            let mut delta_accum = 0i32;
            for ox in 0..out_width {
                delta_accum += col_delta[ox];
                col_lit[ox] = col_lit[ox].saturating_add(delta_accum.max(0) as u32);
            }
            for ox in 0..out_width {
                let lit_count = col_lit[ox];
                col_lit[ox] = 0;
                let raw = ((lit_count * 255 + max_count / 2) / max_count).min(255) as u8;
                row_buf[ox] = if raw > 0 && raw < min_alpha_u8 {
                    0u8
                } else {
                    raw
                };
            }
            emit_row(&mut out_rle, &row_buf);
            output_rows_emitted += 1;
            // Any remaining rows are all zeros.
            if output_rows_emitted < out_height {
                emit_zero_rows(&mut out_rle, out_height - output_rows_emitted, out_width);
            }
        }
    }

    out_rle.finish()
}

#[inline]
fn compute_nonzero_bounds_from_rle(
    runs: &[crate::rle::RleRun],
    width: usize,
    height: usize,
) -> Option<(usize, usize, usize, usize)> {
    if width == 0 || height == 0 || runs.is_empty() {
        return None;
    }

    let total_pixels = width.saturating_mul(height);
    let mut pos = 0usize;
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut any_non_zero = false;

    for run in runs {
        if pos >= total_pixels {
            break;
        }

        let run_len = (run.length as usize).min(total_pixels - pos);
        if run_len == 0 {
            continue;
        }

        if run.value != 0 {
            any_non_zero = true;
            let mut cur = pos;
            let end = pos + run_len;
            while cur < end {
                let row = cur / width;
                let col = cur % width;
                let take = (end - cur).min(width - col);
                min_x = min_x.min(col);
                max_x = max_x.max(col + take - 1);
                min_y = min_y.min(row);
                max_y = max_y.max(row);
                cur += take;
            }
        }

        pos += run_len;
    }

    if any_non_zero {
        Some((min_x, max_x, min_y, max_y))
    } else {
        None
    }
}

pub(crate) fn recompute_layer_stats_from_rle(
    runs: &[crate::rle::RleRun],
    width: usize,
    height: usize,
    pixel_area_mm2: f64,
    compute_area_stats: bool,
) -> LayerAreaStatsV3 {
    let mut stats = LayerAreaStatsV3::default();

    if width == 0 || height == 0 || runs.is_empty() {
        return stats;
    }

    let total_pixels = width.saturating_mul(height);
    let mut pos = 0usize;
    let mut solid_pixels = 0u32;
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut any_non_zero = false;

    for run in runs {
        if pos >= total_pixels {
            break;
        }

        let run_len = (run.length as usize).min(total_pixels - pos);
        if run_len == 0 {
            continue;
        }

        if run.value != 0 {
            any_non_zero = true;
            solid_pixels = solid_pixels.saturating_add(run_len as u32);

            let mut cur = pos;
            let end = pos + run_len;
            while cur < end {
                let row = cur / width;
                let col = cur % width;
                let take = (end - cur).min(width - col);
                min_x = min_x.min(col);
                max_x = max_x.max(col + take - 1);
                min_y = min_y.min(row);
                max_y = max_y.max(row);
                cur += take;
            }
        }

        pos += run_len;
    }

    if !any_non_zero {
        return stats;
    }

    stats.total_solid_pixels = solid_pixels;
    stats.min_x = min_x as i32;
    stats.min_y = min_y as i32;
    stats.max_x = max_x as i32;
    stats.max_y = max_y as i32;

    if compute_area_stats {
        let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) =
            compute_component_area_stats_from_rle_8_connected(runs, width, height, pixel_area_mm2);
        stats.total_solid_pixels = total_pixels;
        let total_area = (total_pixels as f64) * pixel_area_mm2;
        stats.total_solid_area_mm2 = total_area;
        stats.largest_area_mm2 = largest_area_mm2;
        stats.smallest_area_mm2 = smallest_area_mm2;
        stats.area_count = area_count;
    } else {
        let total_area = (solid_pixels as f64) * pixel_area_mm2;
        stats.total_solid_area_mm2 = total_area;
        stats.largest_area_mm2 = total_area;
        stats.smallest_area_mm2 = total_area;
        stats.area_count = 1;
    }

    stats
}

/// Streaming separable box blur operating directly on gray RLE runs.
///
/// Matches the boundary-clamped denominator of `apply_blur_postprocess_inplace`
/// but uses only `O((2×radius+1) × width × 2)` bytes of working memory
/// (≈69 KB for radius=1, width=11520) instead of a full-image mask (≈60 MB).
///
/// # Algorithm
/// 1. Decode the gray RLE row by row into a `width`-element scratch buffer.
/// 2. Apply a horizontal box blur via a running sum → store raw (un-divided)
///    horizontal sums in a `(2×radius+1)`-slot ring buffer of `u16` rows.
/// 3. Accumulate the ring rows into `col_sums: Vec<u32>`.
/// 4. Once enough rows are buffered, compute the boundary-clamped 2D average
///    and emit the output row via `emit_row` / `emit_zero_rows` — zero heap
///    allocation beyond the fixed-size ring.
pub fn blur_gray_rle_streaming(
    runs: &[crate::rle::RleRun],
    width: usize,
    height: usize,
    radius: usize,
    min_alpha_u8: u8,
) -> Vec<crate::rle::RleRun> {
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    if radius == 0 || width == 0 || height == 0 {
        return runs.to_vec();
    }

    let Some((min_x, max_x, min_y, max_y)) = compute_nonzero_bounds_from_rle(runs, width, height)
    else {
        // All-zero image: blur of zero is zero.
        let mut out = RleAccum::new();
        emit_zero_rows(&mut out, height, width);
        return out.finish();
    };

    let roi_min_x = min_x.saturating_sub(radius);
    let roi_max_x = max_x.saturating_add(radius).min(width - 1);
    let roi_min_y = min_y.saturating_sub(radius);
    let roi_max_y = max_y.saturating_add(radius).min(height - 1);
    let roi_w = roi_max_x - roi_min_x + 1;
    let roi_h = roi_max_y - roi_min_y + 1;
    let right_zeros = width - 1 - roi_max_x;

    let ring_cap = 2 * radius + 1;
    // Ring buffer: ring_cap rows × width u16 elements (raw horizontal box-blur sums).
    // Max per-element value = 255 × (2×radius+1). For radius ≤ 127 this fits u16.
    let mut ring = vec![0u16; ring_cap * roi_w];
    // Vertical accumulator: sum of ring rows currently in the sliding window.
    let mut col_sums = vec![0u32; roi_w];
    // Scratch buffers: one decoded ROI row, one emitted ROI row.
    let mut decode_buf = vec![0u8; roi_w];
    let mut emit_buf = vec![0u8; roi_w];
    let mut out_rle = RleAccum::new();

    emit_zero_rows(&mut out_rle, roi_min_y, width);

    // Pre-compute boundary-clamped horizontal denominator once per column.
    // This mirrors the h_denom formula in apply_edge_box_blur_to_mask_in_roi.
    let h_denom: Vec<u32> = (0..roi_w)
        .map(|ix| {
            let x = roi_min_x + ix;
            (1 + radius.min(x) + radius.min(width - 1 - x)) as u32
        })
        .collect();

    let mut ring_head = 0usize;
    let mut ring_len = 0usize;

    // RLE decode state.
    let mut run_idx = 0usize;
    let mut run_pos = 0usize; // pixels consumed from runs[run_idx]
    let mut abs_pos = 0usize;

    let advance_to =
        |target_abs: usize, run_idx: &mut usize, run_pos: &mut usize, abs_pos: &mut usize| {
            while *abs_pos < target_abs {
                if *run_idx >= runs.len() {
                    *abs_pos = target_abs;
                    break;
                }

                let run = &runs[*run_idx];
                let avail = (run.length as usize).saturating_sub(*run_pos);
                if avail == 0 {
                    *run_idx += 1;
                    *run_pos = 0;
                    continue;
                }

                let take = (target_abs - *abs_pos).min(avail);
                *abs_pos += take;
                *run_pos += take;
                if *run_pos >= run.length as usize {
                    *run_idx += 1;
                    *run_pos = 0;
                }
            }
        };

    // The outer loop runs height + radius iterations:
    //   - add_row 0..roi_h  : decode + h-blur one ROI row, add to ring
    //   - add_row 0..roi_h  : if add_row >= radius, emit ROI row out_row = add_row - radius
    //   - add_row roi_h..roi_h+radius : only emit (drain remaining ring rows)
    for add_row in 0..roi_h + radius {
        if add_row < roi_h {
            // ── Decode one ROI slice into decode_buf ──────────────────────
            let global_y = roi_min_y + add_row;
            let row_abs_start = global_y * width + roi_min_x;
            advance_to(row_abs_start, &mut run_idx, &mut run_pos, &mut abs_pos);

            let mut written = 0usize;
            while written < roi_w {
                if run_idx >= runs.len() {
                    decode_buf[written..].fill(0);
                    abs_pos += roi_w - written;
                    break;
                }
                let run = &runs[run_idx];
                let avail = (run.length as usize).saturating_sub(run_pos);
                if avail == 0 {
                    run_idx += 1;
                    run_pos = 0;
                    continue;
                }
                let take = avail.min(roi_w - written);
                decode_buf[written..written + take].fill(run.value);
                written += take;
                abs_pos += take;
                run_pos += take;
                if run_pos >= run.length as usize {
                    run_idx += 1;
                    run_pos = 0;
                }
            }

            // ── Horizontal box blur → store raw sum in ring ───────────────
            // `sum` slides across the row; the raw (un-divided) sum is stored
            // so the final division can use the combined h_denom × v_denom in
            // one step (matching apply_edge_box_blur_to_mask_in_roi exactly).
            let new_slot = (ring_head + ring_len) % ring_cap;
            let slot_start = new_slot * roi_w;

            let mut sum = 0u32;
            let init_end = radius.min(roi_w - 1);
            for &b in &decode_buf[..=init_end] {
                sum += b as u32;
            }
            for ix in 0..roi_w {
                ring[slot_start + ix] = sum as u16; // safe: max = 255×(2r+1) ≤ u16::MAX for r≤127
                col_sums[ix] += sum;
                if ix >= radius {
                    sum -= decode_buf[ix - radius] as u32;
                }
                let r1 = ix + radius + 1;
                if r1 < roi_w {
                    sum += decode_buf[r1] as u32;
                }
            }
            ring_len += 1;
        }

        // ── Emit output row once we have enough buffered rows ─────────────
        if add_row >= radius {
            let out_row = add_row - radius;
            let global_out_y = roi_min_y + out_row;
            // Boundary-clamped vertical denominator: same formula as v_denom in
            // apply_edge_box_blur_to_mask_in_roi with roi_min_y = 0.
            let v_denom_val =
                (1 + radius.min(global_out_y) + radius.min(height - 1 - global_out_y)) as u32;

            let mut all_zero = true;
            for ix in 0..roi_w {
                let denom = (h_denom[ix] * v_denom_val).max(1);
                let raw = (col_sums[ix] + denom / 2) / denom;
                let mut val = raw.min(255) as u8;
                if val > 0 && val < min_alpha_u8 {
                    val = 0;
                }
                emit_buf[ix] = val;
                if val > 0 {
                    all_zero = false;
                }
            }

            if all_zero {
                emit_zero_rows(&mut out_rle, 1, width);
            } else {
                if roi_min_x > 0 {
                    out_rle.push_run(roi_min_x as u32, 0);
                }
                emit_row(&mut out_rle, &emit_buf);
                if right_zeros > 0 {
                    out_rle.push_run(right_zeros as u32, 0);
                }
            }

            // Evict the oldest ring row once the full vertical window is in use.
            if out_row >= radius {
                let evict_start = ring_head * roi_w;
                for ix in 0..roi_w {
                    col_sums[ix] -= ring[evict_start + ix] as u32;
                }
                ring_head = (ring_head + 1) % ring_cap;
                ring_len -= 1;
            }
        }
    }

    emit_zero_rows(&mut out_rle, height - 1 - roi_max_y, width);

    out_rle.finish()
}

#[cfg(test)]
mod tests {
    use super::{
        apply_blur_postprocess_inplace, blur_gray_rle_streaming, encode_bounded_gray_mask_to_rle,
        encode_mask_to_rle, encode_mask_to_rle_in_bounds, rasterize_layer, rasterize_layer_rle,
        rasterize_layer_with_stats, remap_gray_rle_with_lut,
    };
    use crate::binary_mask::BoundedGrayMask;
    use crate::encoders::registry::supported_output_formats;
    use crate::geometry::{parse_triangles, project_triangles_inplace};
    use crate::rle::expand_rle_to_mask;
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
            format_version: None,
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
            anti_aliasing_level: "Off".to_string(),
            anti_aliasing_mode: "Blur".to_string(),
            blur_brush_radius_px: 1,
            aa_on_supports: false,
            model_triangle_count: 0,
            minimum_aa_alpha_percent: 35.0,
            mirror_x: false,
            mirror_y: false,
            z_blend_look_back: 2,
            z_blend_fade_px: 20,
            z_blend_auto_fade: true,
            z_blend_minimum_alpha_percent: 0.0,
            z_blend_max_alpha_percent: 90.0,
            z_blend_custom_lut: None,
            triangles_xyz: Vec::new(),
            metadata_json: "{}".to_string(),
            x_packing_mode: "none".to_string(),
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
    fn bounded_rle_preserves_full_frame_coordinates() {
        let width = 8usize;
        let height = 5usize;
        let mut mask = vec![0u8; width * height];
        mask[1 * width + 2] = 10;
        mask[1 * width + 3] = 10;
        mask[2 * width + 4] = 20;
        mask[3 * width + 5] = 30;

        let runs = encode_mask_to_rle_in_bounds(&mask, width, height, Some((2, 5, 1, 3)));
        let expanded = expand_rle_to_mask(&runs, width * height);

        assert_eq!(expanded, mask);
    }

    #[test]
    fn bounded_gray_rle_matches_full_frame_bounds_encoder() {
        let width = 8usize;
        let height = 5usize;
        let mut mask = vec![0u8; width * height];
        mask[1 * width + 2] = 10;
        mask[1 * width + 3] = 10;
        mask[2 * width + 4] = 20;
        mask[3 * width + 5] = 30;

        let bounded = BoundedGrayMask::from_full_frame_in_bounds(
            mask.clone(),
            width,
            height,
            Some((2, 5, 1, 3)),
        );

        let runs = encode_bounded_gray_mask_to_rle(&bounded, width, height);
        let expanded = expand_rle_to_mask(&runs, width * height);

        assert_eq!(expanded, mask);
    }

    #[test]
    fn overlapping_boxes_do_not_create_void_split() {
        let job = job_for_single_layer();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, -2.0, 0.0, 0.0, 1.0, 24.0, 24.0);
        push_box_triangles(&mut flat, 8.0, 0.0, 0.0, 1.0, 24.0, 24.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
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

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
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

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let (_mask, stats) = rasterize_layer_with_stats(&job, &triangles, &indices, 0, true);

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

    #[test]
    fn disconnected_islands_report_component_stats_in_rle_path() {
        let job = job_for_single_layer();

        let mut flat = Vec::<f32>::new();
        // Large island
        push_box_triangles(&mut flat, -20.0, 0.0, 0.0, 1.0, 18.0, 18.0);
        // Smaller, disconnected island
        push_box_triangles(&mut flat, 20.0, 0.0, 0.0, 1.0, 8.0, 8.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let (_runs, stats) = rasterize_layer_rle(&job, &triangles, &indices, 0, true);

        assert_eq!(
            stats.area_count, 2,
            "disconnected solids should produce two 8-connected components in RLE path"
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

    #[test]
    fn disconnected_islands_report_component_stats_with_aa() {
        let mut job = job_for_single_layer();
        job.anti_aliasing_level = "4x".to_string();

        let mut flat = Vec::<f32>::new();
        // Large island
        push_box_triangles(&mut flat, -20.0, 0.0, 0.0, 1.0, 18.0, 18.0);
        // Smaller, disconnected island
        push_box_triangles(&mut flat, 20.0, 0.0, 0.0, 1.0, 8.0, 8.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let (_mask, stats) = rasterize_layer_with_stats(&job, &triangles, &indices, 0, true);

        assert_eq!(
            stats.area_count, 2,
            "AA path should preserve disconnected 8-connected component count"
        );
        assert!(
            stats.largest_area_mm2 > stats.smallest_area_mm2,
            "largest area should exceed smallest area for differently sized disconnected islands"
        );
        assert!(
            (stats.total_solid_area_mm2 - (stats.largest_area_mm2 + stats.smallest_area_mm2)).abs()
                < 1e-6,
            "total area should equal the sum of component areas in AA path"
        );
    }

    #[test]
    fn disconnected_islands_report_component_stats_in_rle_path_with_aa() {
        let mut job = job_for_single_layer();
        job.anti_aliasing_level = "4x".to_string();

        let mut flat = Vec::<f32>::new();
        // Large island
        push_box_triangles(&mut flat, -20.0, 0.0, 0.0, 1.0, 18.0, 18.0);
        // Smaller, disconnected island
        push_box_triangles(&mut flat, 20.0, 0.0, 0.0, 1.0, 8.0, 8.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let (_runs, stats) = rasterize_layer_rle(&job, &triangles, &indices, 0, true);

        assert_eq!(
            stats.area_count, 2,
            "AA RLE path should preserve disconnected 8-connected component count"
        );
        assert!(
            stats.largest_area_mm2 > stats.smallest_area_mm2,
            "largest area should exceed smallest area for differently sized disconnected islands"
        );
        assert!(
            (stats.total_solid_area_mm2 - (stats.largest_area_mm2 + stats.smallest_area_mm2)).abs()
                < 1e-6,
            "total area should equal the sum of component areas in AA RLE path"
        );
    }

    #[test]
    fn blur_mode_produces_grayscale_edge_pixels_in_mask_path() {
        let mut job = job_for_single_layer();
        job.blur_brush_radius_px = 2;
        job.anti_aliasing_mode = "Blur".to_string();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, 0.0, 0.0, 0.0, 1.0, 18.0, 18.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let (mask, stats) = rasterize_layer_with_stats(&job, &triangles, &indices, 0, true);

        assert!(
            stats.total_solid_pixels > 0,
            "blur mode should still rasterize solid pixels"
        );
        assert!(
            mask.iter().any(|&px| px > 0 && px < 255),
            "blur mode should create grayscale edge pixels"
        );
        assert!(
            mask.iter().any(|&px| px == 255),
            "blur mode should preserve fully solid interior pixels"
        );
    }

    #[test]
    fn blur_mode_produces_grayscale_edge_pixels_in_rle_path() {
        // Blur post-processing now happens at the engine level, not inside the
        // rasterizer.  Simulate the engine pipeline: binary RLE rasterize →
        // expand to mask → apply blur → re-encode to RLE.
        let mut job = job_for_single_layer();
        job.blur_brush_radius_px = 2;
        job.anti_aliasing_mode = "Blur".to_string();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, 0.0, 0.0, 0.0, 1.0, 18.0, 18.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();

        // Rasterizer now always returns binary runs.
        let (binary_runs, stats) = rasterize_layer_rle(&job, &triangles, &indices, 0, true);

        // Engine-level blur post-process.
        let width = job.effective_render_width_px() as usize;
        let height = job.source_height_px as usize;
        let blur_radius = job.blur_brush_radius_px.max(1) as usize;
        let min_alpha_u8 =
            ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
        let mut mask = crate::rle::expand_rle_to_mask(&binary_runs, width * height);
        apply_blur_postprocess_inplace(&mut mask, width, height, blur_radius, min_alpha_u8);
        let runs = encode_mask_to_rle(&mask, width, height);

        assert!(
            stats.total_solid_pixels > 0,
            "blur mode should still rasterize solid pixels"
        );
        assert!(
            runs.iter().any(|run| run.value > 0 && run.value < 255),
            "blur mode should produce grayscale RLE runs"
        );
        assert!(
            runs.iter().any(|run| run.value == 255),
            "blur mode should preserve fully solid interior runs"
        );
    }

    #[test]
    fn split_support_geometry_stays_binary_when_support_aa_is_disabled() {
        let mut job = job_for_single_layer();
        job.total_layers = 2;
        job.anti_aliasing_level = "4x".to_string();
        job.anti_aliasing_mode = "Blur".to_string();
        job.blur_brush_radius_px = 2;
        job.minimum_aa_alpha_percent = 35.0;
        job.aa_on_supports = false;
        job.model_triangle_count = 12;

        let mut flat = Vec::<f32>::new();
        // Model triangles live above the test layer so only the support half is active.
        push_box_triangles(&mut flat, 0.0, 0.0, 1.2, 1.8, 20.0, 20.0);
        push_box_triangles(&mut flat, 0.0, 0.0, 0.0, 0.8, 20.0, 20.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let all_indices: Vec<usize> = (0..triangles.len()).collect();
        let support_indices: Vec<usize> = (12..24).collect();

        let (split_mask, split_stats) =
            rasterize_layer_with_stats(&job, &triangles, &all_indices, 0, false);

        let mut support_job = job.clone();
        support_job.anti_aliasing_level = "Off".to_string();
        support_job.anti_aliasing_mode = "Coverage".to_string();
        support_job.blur_brush_radius_px = 0;
        support_job.minimum_aa_alpha_percent = 100.0;
        support_job.aa_on_supports = true;
        support_job.model_triangle_count = 0;

        let (expected_support_mask, expected_stats) =
            rasterize_layer_with_stats(&support_job, &triangles, &support_indices, 0, false);

        assert_eq!(split_mask, expected_support_mask);
        assert_eq!(
            split_stats.total_solid_pixels,
            expected_stats.total_solid_pixels
        );
        assert!(
            split_mask.iter().all(|&px| px == 0 || px == 255),
            "support geometry must remain binary when support AA is disabled"
        );
    }

    #[test]
    fn streaming_rle_blur_matches_full_mask_blur() {
        let mut job = job_for_single_layer();
        job.blur_brush_radius_px = 2;
        job.anti_aliasing_mode = "Blur".to_string();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, -16.0, 8.0, 0.0, 1.0, 20.0, 12.0);
        push_box_triangles(&mut flat, 18.0, -10.0, 0.0, 1.0, 10.0, 22.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();

        let (binary_runs, _stats) = rasterize_layer_rle(&job, &triangles, &indices, 0, false);

        let width = job.effective_render_width_px() as usize;
        let height = job.source_height_px as usize;
        let blur_radius = job.blur_brush_radius_px.max(1) as usize;
        let min_alpha_u8 =
            ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;

        let mut expected_mask = crate::rle::expand_rle_to_mask(&binary_runs, width * height);
        apply_blur_postprocess_inplace(
            &mut expected_mask,
            width,
            height,
            blur_radius,
            min_alpha_u8,
        );
        let actual_runs =
            blur_gray_rle_streaming(&binary_runs, width, height, blur_radius, min_alpha_u8);
        let actual_mask = crate::rle::expand_rle_to_mask(&actual_runs, width * height);

        assert_eq!(
            actual_mask, expected_mask,
            "streaming RLE blur must match legacy full-mask blur exactly"
        );
    }

    #[test]
    fn streaming_rle_blur_matches_full_mask_blur_for_grayscale_input() {
        let width = 12usize;
        let height = 8usize;
        let blur_radius = 2usize;
        let min_alpha_u8 = 64u8;

        let mut mask = vec![0u8; width * height];
        // Handcrafted grayscale footprint with soft edges and asymmetric values
        // to ensure the streaming path is validated on true grayscale input,
        // not just binary 0/255 masks.
        let rows: [&[u8]; 4] = [
            &[0, 0, 0, 12, 44, 96, 128, 96, 44, 12, 0, 0],
            &[0, 0, 18, 64, 140, 220, 255, 220, 140, 64, 18, 0],
            &[0, 0, 24, 80, 168, 240, 255, 240, 168, 80, 24, 0],
            &[0, 0, 12, 44, 96, 128, 180, 128, 96, 44, 12, 0],
        ];
        for (row_idx, row) in rows.iter().enumerate() {
            let y = 2 + row_idx;
            let start = y * width;
            mask[start..start + width].copy_from_slice(row);
        }

        let runs = encode_mask_to_rle(&mask, width, height);

        let mut expected_mask = mask.clone();
        apply_blur_postprocess_inplace(
            &mut expected_mask,
            width,
            height,
            blur_radius,
            min_alpha_u8,
        );

        let actual_runs = blur_gray_rle_streaming(&runs, width, height, blur_radius, min_alpha_u8);
        let actual_mask = crate::rle::expand_rle_to_mask(&actual_runs, width * height);

        assert_eq!(
            actual_mask, expected_mask,
            "streaming RLE blur must match legacy full-mask blur for grayscale input"
        );
    }

    #[test]
    fn streaming_rle_blur_with_lut_matches_full_mask_blur() {
        let width = 12usize;
        let height = 8usize;
        let blur_radius = 2usize;

        let mut mask = vec![0u8; width * height];
        let rows: [&[u8]; 4] = [
            &[0, 0, 0, 12, 44, 96, 128, 96, 44, 12, 0, 0],
            &[0, 0, 18, 64, 140, 220, 255, 220, 140, 64, 18, 0],
            &[0, 0, 24, 80, 168, 240, 255, 240, 168, 80, 24, 0],
            &[0, 0, 12, 44, 96, 128, 180, 128, 96, 44, 12, 0],
        ];
        for (row_idx, row) in rows.iter().enumerate() {
            let y = 2 + row_idx;
            let start = y * width;
            mask[start..start + width].copy_from_slice(row);
        }

        let mut lut = [0u8; 256];
        for (idx, slot) in lut.iter_mut().enumerate() {
            *slot = ((idx as f32 * 0.72).round() as u32).min(255) as u8;
        }
        lut[0] = 0;
        lut[255] = 255;

        let runs = encode_mask_to_rle(&mask, width, height);

        let mut expected_mask = mask.clone();
        apply_blur_postprocess_inplace(&mut expected_mask, width, height, blur_radius, 0);
        for px in &mut expected_mask {
            *px = lut[*px as usize];
        }

        let blurred_runs = blur_gray_rle_streaming(&runs, width, height, blur_radius, 0);
        let remapped_runs = remap_gray_rle_with_lut(&blurred_runs, &lut);
        let actual_mask = crate::rle::expand_rle_to_mask(&remapped_runs, width * height);

        assert_eq!(
            actual_mask, expected_mask,
            "streaming RLE blur + LUT remap must match legacy full-mask blur + LUT"
        );
    }

    #[test]
    fn blur_mode_with_ssaa_still_produces_grayscale_edges() {
        let mut job = job_for_single_layer();
        job.blur_brush_radius_px = 2;
        job.anti_aliasing_mode = "Blur".to_string();
        job.anti_aliasing_level = "4x".to_string();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, 0.0, 0.0, 0.0, 1.0, 18.0, 18.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let (mask, stats) = rasterize_layer_with_stats(&job, &triangles, &indices, 0, true);

        assert!(
            stats.total_solid_pixels > 0,
            "blur+SSAA mode should rasterize solid pixels"
        );
        assert!(
            mask.iter().any(|&px| px > 0 && px < 255),
            "blur+SSAA mode should produce grayscale edge pixels"
        );
        assert!(
            mask.iter().any(|&px| px == 255),
            "blur+SSAA mode should preserve fully solid interior pixels"
        );
    }

    #[test]
    fn blur_mode_ignores_ssaa_level_in_mask_path() {
        let mut base_job = job_for_single_layer();
        base_job.blur_brush_radius_px = 2;
        base_job.anti_aliasing_mode = "Blur".to_string();

        let mut ssaa_job = base_job.clone();
        ssaa_job.anti_aliasing_level = "4x".to_string();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, 0.0, 0.0, 0.0, 1.0, 18.0, 18.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &base_job);
        let indices: Vec<usize> = (0..triangles.len()).collect();

        let (base_mask, base_stats) =
            rasterize_layer_with_stats(&base_job, &triangles, &indices, 0, true);
        let (ssaa_mask, ssaa_stats) =
            rasterize_layer_with_stats(&ssaa_job, &triangles, &indices, 0, true);

        assert_eq!(ssaa_mask, base_mask, "blur raster should ignore SSAA level");
        assert_eq!(ssaa_stats.total_solid_pixels, base_stats.total_solid_pixels);
        assert_eq!(ssaa_stats.area_count, base_stats.area_count);
        assert_eq!(ssaa_stats.min_x, base_stats.min_x);
        assert_eq!(ssaa_stats.max_x, base_stats.max_x);
        assert_eq!(ssaa_stats.min_y, base_stats.min_y);
        assert_eq!(ssaa_stats.max_y, base_stats.max_y);
    }

    #[test]
    fn blur_mode_ignores_ssaa_level_in_rle_path() {
        let mut base_job = job_for_single_layer();
        base_job.blur_brush_radius_px = 2;
        base_job.anti_aliasing_mode = "Blur".to_string();

        let mut ssaa_job = base_job.clone();
        ssaa_job.anti_aliasing_level = "4x".to_string();

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, 0.0, 0.0, 0.0, 1.0, 18.0, 18.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &base_job);
        let indices: Vec<usize> = (0..triangles.len()).collect();

        let (base_runs, base_stats) = rasterize_layer_rle(&base_job, &triangles, &indices, 0, true);
        let (ssaa_runs, ssaa_stats) = rasterize_layer_rle(&ssaa_job, &triangles, &indices, 0, true);

        assert_eq!(
            ssaa_runs, base_runs,
            "blur RLE path should ignore SSAA level"
        );
        assert_eq!(ssaa_stats.total_solid_pixels, base_stats.total_solid_pixels);
        assert_eq!(ssaa_stats.area_count, base_stats.area_count);
        assert_eq!(ssaa_stats.min_x, base_stats.min_x);
        assert_eq!(ssaa_stats.max_x, base_stats.max_x);
        assert_eq!(ssaa_stats.min_y, base_stats.min_y);
        assert_eq!(ssaa_stats.max_y, base_stats.max_y);
    }
}
