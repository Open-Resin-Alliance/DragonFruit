//! Scanline rasterizer for V3 layer masks.
//!
//! Uses oriented segment winding to robustly union overlapping/intersecting
//! solids and avoid spurious bridge/void artifacts.

use crate::geometry::Triangle;
use crate::types::{LayerAreaStatsV3, SliceJobV3};

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
    starts: Vec<Vec<ActiveEdge>>,
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
fn build_row_spans_even_odd(
    active_edges: &[ActiveEdge],
    width: usize,
    snap_to_integer: bool,
) -> Vec<RowSpan> {
    let mut spans = Vec::with_capacity(active_edges.len() / 2 + 1);
    let mut i = 0usize;

    while i + 1 < active_edges.len() {
        let x_left = active_edges[i].x;
        let x_right = active_edges[i + 1].x;

        if !x_left.is_finite() || !x_right.is_finite() {
            break;
        }

        if snap_to_integer {
            let a = x_left.round() as i64;
            let b = x_right.round() as i64;
            if a < b {
                if let Some(span) = make_row_span(x_left, x_right, width) {
                    spans.push(span);
                }
            }
        } else if let Some(span) = make_row_span(x_left, x_right, width) {
            spans.push(span);
        }

        i += 2;
    }

    spans
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
    if active_edges.len() < 2 {
        return Vec::new();
    }

    let mut spans = Vec::with_capacity(active_edges.len() / 2 + 1);
    let mut winding = 0i32;
    let n = active_edges.len();
    let mut closure_winding = 0i32;

    for i in 0..n.saturating_sub(1) {
        let x_left = active_edges[i].x;
        if !x_left.is_finite() {
            break;
        }

        winding += active_edges[i].wind;
        closure_winding += active_edges[i].wind;
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

    if let Some(last_edge) = active_edges.last() {
        if last_edge.x.is_finite() {
            closure_winding += last_edge.wind;
        }
    }

    if closure_winding != 0 {
        return build_row_spans_even_odd(active_edges, width, snap_to_integer);
    }

    spans
}

fn build_segments_for_layer(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
    layer_height_mm: f32,
) -> Vec<Segment> {
    let z_mm = (layer_index as f32 + 0.5) * layer_height_mm;
    let mut segments = Vec::with_capacity(layer_indices.len());

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

fn aa_subpixel_steps(level: &str) -> u8 {
    match level {
        "2x" => 2,
        "4x" => 4,
        "8x" => 8,
        "16x" => 16,
        _ => 0,
    }
}

fn build_scanline_segment_index(
    segments: &[Segment],
    height: usize,
    aa_steps: usize,
) -> Option<ScanlineSegmentIndex> {
    let sub_height = height * aa_steps;
    let mut starts = vec![Vec::<usize>::new(); sub_height];
    let mut end_exclusive = vec![0usize; segments.len()];
    let mut global_start = sub_height;
    let mut global_end = 0usize;

    let f_steps = aa_steps as f32;

    for (idx, seg) in segments.iter().enumerate() {
        let start = (seg.y_min * f_steps - 0.5).ceil() as i32;
        let end = (seg.y_max * f_steps - 0.5).ceil() as i32;

        let clamped_start = start.clamp(0, sub_height as i32) as usize;
        let clamped_end = end.clamp(0, sub_height as i32) as usize;

        if clamped_start >= clamped_end || clamped_start >= sub_height {
            continue;
        }

        starts[clamped_start].push(idx);
        end_exclusive[idx] = clamped_end;
        global_start = global_start.min(clamped_start);
        global_end = global_end.max(clamped_end);
    }

    if global_start >= global_end {
        return None;
    }

    let mut indexed = vec![Vec::<ActiveEdge>::new(); sub_height];
    for y in 0..sub_height {
        if starts[y].is_empty() {
            continue;
        }
        let y_sample = (y as f32 + 0.5) / f_steps;
        for seg_idx in &starts[y] {
            let seg = &segments[*seg_idx];
            let x = seg.x1 + (y_sample - seg.y1) * seg.dx_dy;
            indexed[y].push(ActiveEdge {
                x,
                dx_dy: seg.dx_dy / f_steps,
                wind: seg.wind,
                end_exclusive: end_exclusive[*seg_idx],
            });
        }
        indexed[y].sort_unstable_by(active_edge_cmp);
    }

    Some(ScanlineSegmentIndex {
        starts: indexed,
        y_start: global_start,
        y_end_exclusive: global_end,
    })
}

/// Rasterize one layer into an 8-bit grayscale mask (`0` or `255`).
pub fn rasterize_layer_with_stats(
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

    let segments = build_segments_for_layer(
        job,
        triangles,
        layer_indices,
        layer_index,
        job.layer_height_mm,
    );
    if segments.is_empty() {
        return (mask, stats);
    }

    let aa_level_steps = aa_subpixel_steps(job.anti_aliasing_level.trim());
    let aa_steps = (aa_level_steps as usize).max(1);
    let aa_enabled = aa_steps > 1;
    let min_aa_alpha_u8 = if aa_enabled {
        ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8
    } else {
        0
    };

    let Some(scanline_index) = build_scanline_segment_index(&segments, height, aa_steps) else {
        return (mask, stats);
    };
    let scanline_starts = scanline_index.starts;
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
        if let Some(starting) = scanline_starts.get(y) {
            if !starting.is_empty() {
                merge_active_edges_sorted(&mut active_edges, starting, &mut merge_scratch);
            }
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

    let segments = build_segments_for_layer(
        job,
        triangles,
        layer_indices,
        layer_index,
        job.layer_height_mm,
    );
    if segments.is_empty() {
        emit_zero_rows(&mut rle, height, width);
        return (rle.finish(), stats);
    }

    let aa_level_steps = aa_subpixel_steps(job.anti_aliasing_level.trim());
    let aa_steps = (aa_level_steps as usize).max(1);
    let aa_enabled = aa_steps > 1;
    let min_aa_alpha_u8 = if aa_enabled {
        ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8
    } else {
        0
    };

    let Some(scanline_index) = build_scanline_segment_index(&segments, height, aa_steps) else {
        emit_zero_rows(&mut rle, height, width);
        return (rle.finish(), stats);
    };
    let scanline_starts = scanline_index.starts;
    let y_start = scanline_index.y_start;
    let y_end_exclusive = scanline_index.y_end_exclusive;
    let track_aa_components = compute_area_stats && aa_enabled;
    let mut aa_component_tracker = if track_aa_components {
        Some(ComponentSpanTracker::new())
    } else {
        None
    };

    let first_physical_y = y_start / aa_steps;
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
    let mut current_physical_y = first_physical_y;
    // last_emitted_py: the most recent physical row fully committed to `rle`.
    // Starts at first_physical_y - 1 (we just emitted zeros 0..first_physical_y).
    #[allow(unused_assignments)]
    let mut last_emitted_py = first_physical_y.wrapping_sub(1);

    // Helper closure: commit `current_physical_y`'s row to `rle`, then emit
    // zero-rows for any skipped rows up to (but not including) `next_py`.
    macro_rules! flush_up_to {
        ($next_py:expr) => {{
            // Resolve AA accumulator into row_buf for the row being flushed.
            if aa_enabled {
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
                        row_buf[x] = resolved.max(min_aa_alpha_u8);
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
        let physical_y = y / aa_steps;

        if physical_y != current_physical_y {
            flush_up_to!(physical_y);
            current_physical_y = physical_y;
        }

        active_edges.retain(|edge| edge.end_exclusive > y);
        if let Some(starting) = scanline_starts.get(y) {
            if !starting.is_empty() {
                merge_active_edges_sorted(&mut active_edges, starting, &mut merge_scratch);
            }
        }
        if active_edges.is_empty() {
            continue;
        }

        let spans = build_row_spans_nonzero(&active_edges, width, !aa_enabled);

        for span in spans {
            if !aa_enabled {
                row_buf[span.start..=span.end].fill(255);
            } else {
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

    // Flush the final accumulated physical row.
    flush_up_to!(current_physical_y + 1);

    // Emit remaining zero rows to fill the image height.
    let rows_emitted = last_emitted_py + 1;
    if rows_emitted < height {
        emit_zero_rows(&mut rle, height - rows_emitted, width);
    }

    if aa_enabled {
        stats.total_solid_pixels /= aa_steps as u32;
    }

    let runs = rle.finish();

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
                compute_component_area_stats_from_rle_8_connected(
                    &runs,
                    width,
                    height,
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

    (runs, stats)
}

#[cfg(test)]
mod tests {
    use super::{build_row_spans_nonzero, ActiveEdge};
    use super::{rasterize_layer, rasterize_layer_rle, rasterize_layer_with_stats};
    use crate::encoders::registry::supported_output_formats;
    use crate::geometry::{parse_triangles, project_triangles_inplace};
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
            aa_on_supports: false,
            minimum_aa_alpha_percent: 35.0,
            mirror_x: false,
            mirror_y: false,
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

    fn max_run_length(mask: &[u8], width: usize) -> usize {
        mask.chunks_exact(width)
            .map(|row| {
                let mut best = 0usize;
                let mut current = 0usize;
                for &px in row {
                    if px > 0 {
                        current += 1;
                        best = best.max(current);
                    } else {
                        current = 0;
                    }
                }
                best
            })
            .max()
            .unwrap_or(0)
    }

    fn push_open_wall_triangle(
        out: &mut Vec<f32>,
        x: f32,
        y0: f32,
        y1: f32,
        z0: f32,
        z1: f32,
        negative_x_normal: bool,
    ) {
        let a = [x, y0, z0];
        let b = [x, y1, z1];
        let c = [x, y1, z0];

        if negative_x_normal {
            out.extend_from_slice(&a);
            out.extend_from_slice(&b);
            out.extend_from_slice(&c);
        } else {
            out.extend_from_slice(&a);
            out.extend_from_slice(&c);
            out.extend_from_slice(&b);
        }
    }

    #[test]
    fn unbalanced_crossings_fall_back_to_even_odd_pairs() {
        let spans = build_row_spans_nonzero(
            &[
                ActiveEdge {
                    x: 40.0,
                    dx_dy: 0.0,
                    wind: 1,
                    end_exclusive: 10,
                },
                ActiveEdge {
                    x: 64.0,
                    dx_dy: 0.0,
                    wind: 1,
                    end_exclusive: 10,
                },
                ActiveEdge {
                    x: 220.0,
                    dx_dy: 0.0,
                    wind: -1,
                    end_exclusive: 10,
                },
            ],
            256,
            true,
        );

        assert_eq!(
            spans.len(),
            1,
            "malformed rows should collapse to one safe paired span"
        );
        assert_eq!(spans[0].start, 40);
        assert_eq!(spans[0].end, 63);
    }

    #[test]
    fn open_wall_rows_do_not_leak_across_remaining_crossings() {
        let job = job_for_single_layer();

        let mut flat = Vec::<f32>::new();
        push_open_wall_triangle(&mut flat, -24.0, -18.0, 18.0, 0.0, 1.0, true);
        push_open_wall_triangle(&mut flat, -8.0, -18.0, 18.0, 0.0, 1.0, true);
        push_open_wall_triangle(&mut flat, 22.0, -18.0, 18.0, 0.0, 1.0, false);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        let mask = rasterize_layer(&job, &triangles, &indices, 0);

        let longest_run = max_run_length(&mask, job.source_width_px as usize);
        assert!(
            longest_run < 80,
            "malformed open rows should not flood-fill across the remaining crossings (longest_run={longest_run})"
        );
        assert!(
            longest_run > 5,
            "the regression mesh should still produce a small filled span so the test is meaningful"
        );
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
}
