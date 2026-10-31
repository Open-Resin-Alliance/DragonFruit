//! Scanline rasterizer for V3 layer masks.
//!
//! Uses oriented segment winding to robustly union overlapping/intersecting
//! solids and avoid spurious bridge/void artifacts.

use crate::geometry::Triangle;
use crate::pulp_simd::{self, Backend};
use crate::types::{LayerAreaStatsV3, SliceJobV3};
use crate::zaa;
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

/// Emit the union of sorted inclusive spans, clipped to a column window.
/// RleAccum merges adjacent equal values, including across row boundaries.
#[inline]
fn emit_binary_row_spans(
    rle: &mut crate::rle::RleAccum,
    spans: &[RowSpan],
    window_start: usize,
    window_width: usize,
) {
    let window_end = window_start + window_width;
    let mut cursor = window_start;
    for span in spans {
        let start = span.start.max(window_start).max(cursor);
        let end = span.end.saturating_add(1).min(window_end);
        if start >= end {
            continue;
        }
        rle.push_run((start - cursor) as u32, 0);
        rle.push_run((end - start) as u32, 255);
        cursor = end;
    }
    rle.push_run((window_end - cursor) as u32, 0);
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
fn push_span_snapped(
    spans: &mut Vec<RowSpan>,
    x_left: f32,
    x_right: f32,
    width: usize,
    snap_to_integer: bool,
) {
    if snap_to_integer {
        let a = x_left.round() as i64;
        let b = x_right.round() as i64;
        if a >= b {
            return;
        }
    }
    if let Some(span) = make_row_span(x_left, x_right, width) {
        spans.push(span);
    }
}

/// Rebuild spans for a defective row by pairing each fill-entry crossing
/// with the nearest following fill-exit crossing and filling the matched
/// pairs, so fill can never run past a genuine exit crossing.
///
/// Crossings left unmatched are then paired even-odd style among
/// themselves, keeping meshes whose winding carries no information
/// (partially inverted faces produce same-sign walls) filled as before —
/// unless the pair is exit-then-entry (the signature of the gap between
/// two objects) or a matched crossing lies between the orphans (the pair
/// would bridge fill across healthy geometry). Filling those intervals is
/// exactly the row-leak this repair exists to prevent, so they are
/// dropped. A defect then costs at worst a one-row sliver of fill instead
/// of a solid line across the row.
///
/// On a well-formed row this produces exactly the non-zero-winding result;
/// it only differs where the crossing sequence is inconsistent.
fn build_row_spans_matched(
    active_edges: &[ActiveEdge],
    width: usize,
    snap_to_integer: bool,
    entry_wind: i32,
) -> (Vec<RowSpan>, usize) {
    let mut open: Vec<f32> = Vec::with_capacity(4);
    let mut pairs: Vec<(f32, f32)> = Vec::with_capacity(active_edges.len() / 2 + 1);
    let mut orphans: Vec<(f32, i32)> = Vec::new();

    let mut edge_index = 0usize;
    while edge_index < active_edges.len() {
        let edge = active_edges[edge_index];
        if !edge.x.is_finite() {
            break;
        }

        // Normalize so w > 0 opens fill and w < 0 closes it, regardless of
        // the mesh's dominant orientation.
        let mut w = edge.wind * entry_wind;
        if w == -1 && open.is_empty() {
            // A nearby entry belongs to this unmatched exit when its next
            // possible closing exit is farther away. Consume that local gap
            // instead of carrying the entry into another model instance.
            let next_entry = active_edges.get(edge_index + 1).filter(|next| {
                next.x.is_finite() && next.wind * entry_wind == 1 && next.x > edge.x
            });
            if let Some(next_entry) = next_entry {
                let next_exit = active_edges[edge_index + 2..].iter().find(|candidate| {
                    candidate.x.is_finite() && candidate.wind * entry_wind < 0
                });
                if next_exit.is_some_and(|next_exit| {
                    next_entry.x - edge.x < next_exit.x - next_entry.x
                }) {
                    edge_index += 2;
                    continue;
                }
            }
        }
        while w > 0 {
            open.push(edge.x);
            w -= 1;
        }
        while w < 0 {
            w += 1;
            match open.pop() {
                Some(x_left) => {
                    if edge.x > x_left {
                        pairs.push((x_left, edge.x));
                    }
                }
                None => orphans.push((edge.x, -1)),
            }
        }
        edge_index += 1;
    }
    for &x in &open {
        orphans.push((x, 1));
    }
    orphans.sort_by(|a, b| a.0.total_cmp(&b.0));

    // The count of orientation-consistent (entry, exit) matches is the
    // evidence used to pick the row's true orientation; orphan pairs added
    // below are orientation-free and must not count.
    let matched_pair_count = pairs.len();

    // An orphan pair may only fill if no matched crossing lies strictly
    // between the two orphans. The same-sign walls of a single solid have
    // an empty interior, but instanced copies of a defective mesh shed one
    // orphan per instance onto the same row, and pairing those would
    // bridge fill across every healthy object in between.
    let mut matched_xs: Vec<f32> = Vec::with_capacity(pairs.len() * 2);
    for &(a, b) in &pairs {
        matched_xs.push(a);
        matched_xs.push(b);
    }
    matched_xs.sort_by(f32::total_cmp);

    let mut i = 0usize;
    while i + 1 < orphans.len() {
        let (x_left, w_left) = orphans[i];
        let (x_right, w_right) = orphans[i + 1];
        // Skip exit-then-entry pairs: that interval lies between objects.
        let gap_signature = w_left < 0 && w_right > 0;
        let first_inside = matched_xs.partition_point(|&x| x <= x_left);
        let crosses_matched_fill =
            matched_xs.get(first_inside).is_some_and(|&x| x < x_right);
        if !gap_signature && !crosses_matched_fill && x_right > x_left {
            pairs.push((x_left, x_right));
        }
        i += 2;
    }

    if pairs.is_empty() {
        return (Vec::new(), matched_pair_count);
    }

    // Nested pairs emit innermost-first, so intervals may overlap; merge
    // into disjoint spans so AA coverage isn't double-counted downstream.
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut spans = Vec::with_capacity(pairs.len());
    let (mut cur_a, mut cur_b) = pairs[0];
    for &(a, b) in &pairs[1..] {
        if a <= cur_b {
            cur_b = cur_b.max(b);
        } else {
            push_span_snapped(&mut spans, cur_a, cur_b, width, snap_to_integer);
            (cur_a, cur_b) = (a, b);
        }
    }
    push_span_snapped(&mut spans, cur_a, cur_b, width, snap_to_integer);

    (spans, matched_pair_count)
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
fn build_row_spans_nonzero_ctx(
    active_edges: &[ActiveEdge],
    width: usize,
    snap_to_integer: bool,
    prev_spans: Option<&[RowSpan]>,
) -> Vec<RowSpan> {
    if active_edges.len() < 2 {
        return Vec::new();
    }
    let (spans, _repaired) =
        build_row_spans_nonzero_inner(active_edges, width, snap_to_integer, prev_spans);
    spans
}

/// Context-free variant for callers (and tests) without row history.
#[cfg(test)]
fn build_row_spans_nonzero(
    active_edges: &[ActiveEdge],
    width: usize,
    snap_to_integer: bool,
) -> Vec<RowSpan> {
    build_row_spans_nonzero_ctx(active_edges, width, snap_to_integer, None)
}

/// Total overlap in pixels between two sorted, disjoint span lists.
fn spans_overlap_px(a: &[RowSpan], b: &[RowSpan]) -> u64 {
    let mut total = 0u64;
    let mut j = 0usize;
    for sa in a {
        while j < b.len() && b[j].end < sa.start {
            j += 1;
        }
        let mut k = j;
        while k < b.len() && b[k].start <= sa.end {
            let lo = sa.start.max(b[k].start);
            let hi = sa.end.min(b[k].end);
            if hi >= lo {
                total += (hi - lo + 1) as u64;
            }
            k += 1;
        }
    }
    total
}

#[inline]
fn spans_total_px(spans: &[RowSpan]) -> u64 {
    spans.iter().map(|s| (s.end - s.start + 1) as u64).sum()
}

fn collapse_subpixel_pairs(active_edges: &[ActiveEdge]) -> Option<Vec<ActiveEdge>> {
    let has_subpixel_pair = active_edges.windows(2).any(|pair| {
        pair[0].x.is_finite()
            && pair[1].x.is_finite()
            && pair[0].wind + pair[1].wind == 0
            && pair[1].x - pair[0].x < 1.0
    });
    if !has_subpixel_pair {
        return None;
    }

    let mut collapsed = Vec::with_capacity(active_edges.len());
    for &edge in active_edges {
        let cancels_previous = collapsed.last().is_some_and(|previous: &ActiveEdge| {
            previous.x.is_finite()
                && edge.x.is_finite()
                && previous.wind + edge.wind == 0
                && edge.x - previous.x < 1.0
        });
        if cancels_previous {
            collapsed.pop();
        } else {
            collapsed.push(edge);
        }
    }

    Some(collapsed)
}

fn build_row_spans_nonzero_inner(
    active_edges: &[ActiveEdge],
    width: usize,
    snap_to_integer: bool,
    prev_spans: Option<&[RowSpan]>,
) -> (Vec<RowSpan>, bool) {
    // Opposite crossings below the source raster's X resolution have zero
    // printable extent. Remove them before winding repair so one crossing
    // cannot be matched against another instance across the plate.
    let collapsed_edges = collapse_subpixel_pairs(active_edges);
    let active_edges = collapsed_edges.as_deref().unwrap_or(active_edges);

    let mut spans = Vec::with_capacity(active_edges.len() / 2 + 1);
    let mut winding = 0i32;
    let n = active_edges.len();
    let mut closure_winding = 0i32;
    let mut min_winding = 0i32;
    let mut max_winding = 0i32;

    for i in 0..n.saturating_sub(1) {
        let x_left = active_edges[i].x;
        if !x_left.is_finite() {
            break;
        }

        winding += active_edges[i].wind;
        closure_winding += active_edges[i].wind;
        min_winding = min_winding.min(closure_winding);
        max_winding = max_winding.max(closure_winding);
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
            min_winding = min_winding.min(closure_winding);
            max_winding = max_winding.max(closure_winding);
        }
    }

    // A well-formed row closes back to winding zero and never mixes signs
    // (positive and negative winding regions in one row mean some crossings
    // have inverted orientation). Either symptom marks a mesh defect on this
    // row; discard the naive spans and rebuild from matched crossing pairs
    // so a stray crossing cannot leak fill across the row.
    if closure_winding != 0 || (min_winding < 0 && max_winding > 0) {
        // Decide the row's true orientation by evidence, not by winding
        // extremes: a single flipped triangle can drive the winding lower
        // than the legitimate peak and would invert the whole row's
        // interpretation — and an alternating crossing sequence pairs
        // almost equally well in both directions, so within-row evidence
        // alone can tie. The cascade:
        //   1. vertical coherence — defects are single-row events, so the
        //      orientation whose fill agrees with the previous row's spans
        //      is the true one;
        //   2. more orientation-consistent (entry, exit) matches;
        //   3. less total fill — when everything ties, a missing sliver is
        //      a safer failure than a phantom line across the plate.
        let (pos_spans, pos_pairs) =
            build_row_spans_matched(active_edges, width, snap_to_integer, 1);
        let (neg_spans, neg_pairs) =
            build_row_spans_matched(active_edges, width, snap_to_integer, -1);

        let prev = prev_spans.unwrap_or(&[]);
        let pos_overlap = spans_overlap_px(&pos_spans, prev);
        let neg_overlap = spans_overlap_px(&neg_spans, prev);

        let choose_pos = if pos_overlap != neg_overlap {
            pos_overlap > neg_overlap
        } else if pos_pairs != neg_pairs {
            pos_pairs > neg_pairs
        } else {
            spans_total_px(&pos_spans) <= spans_total_px(&neg_spans)
        };

        return (if choose_pos { pos_spans } else { neg_spans }, true);
    }

    (spans, false)
}

#[inline]
fn push_segment_for_triangle_at_z(
    job: &SliceJobV3,
    tri: Triangle,
    z_mm: f32,
    segments: &mut Vec<Segment>,
) {
    if z_mm < tri.z_min || z_mm >= tri.z_max {
        return;
    }

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
        return;
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
        return;
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

fn build_segments_for_layer_into(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    z_mm: f32,
    segments: &mut Vec<Segment>,
) {
    segments.clear();

    for tri_idx in layer_indices {
        push_segment_for_triangle_at_z(job, triangles[*tri_idx], z_mm, segments);
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

fn build_z_perturbed_segments_list(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
    aa_steps: usize,
) -> Vec<Vec<Segment>> {
    let duplicate_terminal_z = zaa::duplicate_terminal_z_samples(job, aa_steps);
    let z_steps = zaa::z_steps_for_aa(aa_steps, duplicate_terminal_z);
    let pattern = zaa::perturbation_pattern(job);

    let mut sample_z = Vec::with_capacity(z_steps);
    for sample_idx in 0..z_steps {
        let offset = zaa::perturbation_offset(pattern, sample_idx, z_steps);
        sample_z.push((layer_index as f32 + offset) * job.layer_height_mm);
    }
    let sample_z_is_sorted = sample_z.windows(2).all(|pair| pair[0] <= pair[1]);

    let mut segments_list = (0..z_steps)
        .map(|_| Vec::with_capacity(layer_indices.len().min(1024)))
        .collect::<Vec<_>>();

    for &tri_idx in layer_indices {
        let tri = triangles[tri_idx];
        if sample_z_is_sorted {
            if tri.z_max <= sample_z[0] || tri.z_min > sample_z[z_steps - 1] {
                continue;
            }

            let start = sample_z.partition_point(|&z| z < tri.z_min);
            let end = sample_z.partition_point(|&z| z < tri.z_max);
            for sample_idx in start..end {
                push_segment_for_triangle_at_z(
                    job,
                    tri,
                    sample_z[sample_idx],
                    &mut segments_list[sample_idx],
                );
            }
        } else {
            for sample_idx in 0..z_steps {
                push_segment_for_triangle_at_z(
                    job,
                    tri,
                    sample_z[sample_idx],
                    &mut segments_list[sample_idx],
                );
            }
        }
    }

    segments_list
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
    // Keep UI value simple while ensuring low radii are visibly effective.
    // Optional override for tuning/experiments:
    //   DF_3DAA_XY_BLUR_RADIUS_SCALE=<float>
    let scale = std::env::var("DF_3DAA_XY_BLUR_RADIUS_SCALE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.5);

    ((radius_px.max(1) as f64 * scale).ceil() as usize).clamp(1, 64)
}

#[inline]
fn support_split_bounds_for_2d_raster(
    job: &SliceJobV3,
    triangle_count: usize,
) -> Option<usize> {
    let aa_steps = (job.effective_xy_aa_steps() as usize).max(1);
    let blur_mode = job.anti_aliasing_mode_is_blur();
    let blur_radius = if blur_mode && job.blur_brush_radius_px > 0 {
        blur_radius_px(job.blur_brush_radius_px)
    } else {
        0
    };
    let model_aa_active = aa_steps > 1 || blur_radius > 0;
    job.support_split_triangle_bounds(triangle_count, model_aa_active)
}

#[inline]
fn supports_should_bypass_aa(job: &SliceJobV3, triangle_count: usize) -> bool {
    support_split_bounds_for_2d_raster(job, triangle_count).is_some()
}

#[inline]
fn split_layer_candidates_by_bounds(
    layer_indices: &[usize],
    model_tri: usize,
    model_out: &mut Vec<usize>,
    support_out: &mut Vec<usize>,
) {
    model_out.clear();
    support_out.clear();

    for &idx in layer_indices {
        if idx < model_tri {
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

// Horizontal box sums have a loop-carried dependency; column updates do not.
// Scalar and oversized-radius rows add the full sum before u16 ring truncation.
#[inline(always)]
fn box_horizontal_row<const ADD_COLUMNS: bool>(
    source: &[u8], radius: usize, ring_row: &mut [u16], columns: &mut [u32],
) {
    debug_assert_eq!(source.len(), ring_row.len());
    debug_assert_eq!(source.len(), columns.len());
    let width = source.len();
    let mut sum: u32 = source[..=radius.min(width - 1)].iter().map(|&b| b as u32).sum();
    let write = |out: &mut u16, column: &mut u32, sum: u32| {
        *out = sum as u16;
        if ADD_COLUMNS { *column += sum; }
    };
    // Split at the two window edges so each source range is proven in bounds.
    let left_start = radius.min(width);
    let right_start = radius.saturating_add(1).min(width);
    let right_end = width - right_start;
    let first_end = left_start.min(right_end);
    let middle_end = left_start.max(right_end);
    for ((out, column), &right) in ring_row[..first_end].iter_mut()
        .zip(&mut columns[..first_end]).zip(&source[right_start..right_start + first_end])
    {
        write(out, column, sum);
        sum += right as u32;
    }
    if left_start <= right_end {
        for (((out, column), &left), &right) in ring_row[first_end..middle_end].iter_mut()
            .zip(&mut columns[first_end..middle_end])
            .zip(&source[..middle_end - first_end])
            .zip(&source[right_start + first_end..right_start + middle_end])
        {
            write(out, column, sum);
            sum -= left as u32;
            sum += right as u32;
        }
    } else {
        for (out, column) in ring_row[first_end..middle_end].iter_mut()
            .zip(&mut columns[first_end..middle_end])
        {
            write(out, column, sum);
        }
    }
    for ((out, column), &left) in ring_row[middle_end..].iter_mut()
        .zip(&mut columns[middle_end..])
        .zip(&source[middle_end.saturating_sub(radius)..width.saturating_sub(radius)])
    {
        write(out, column, sum);
        sum -= left as u32;
    }
}

#[inline(always)]
fn box_update_columns<S: pulp::Simd, const SUBTRACT: bool>(simd: S, columns: &mut [u32], row: &[u16]) {
    debug_assert_eq!(columns.len(), row.len());
    let lanes = pulp_simd::u32_lanes::<S>();
    let (vectors, tail) = S::as_mut_simd_u32s(columns);
    let end = vectors.len() * lanes;
    for (column, values) in vectors.iter_mut().zip(row[..end].chunks_exact(lanes)) {
        let value = pulp_simd::load_u16_as_u32(simd, values);
        *column = if SUBTRACT { simd.sub_u32s(*column, value) } else { simd.add_u32s(*column, value) };
    }
    for (column, &value) in tail.iter_mut().zip(&row[end..]) {
        if SUBTRACT { *column -= value as u32; } else { *column += value as u32; }
    }
}

struct BoxNormalizeDenominators<'a> {
    horizontal: &'a [u32],
    uniform_start: usize,
    uniform_end: usize,
    vertical: u32,
    uniform: pulp_simd::U32Divider,
}

impl<'a> BoxNormalizeDenominators<'a> {
    fn new(horizontal: &'a [u32]) -> Self {
        let largest = *horizontal.iter().max().expect("nonempty box row");
        let uniform_start = horizontal.iter().position(|&d| d == largest).unwrap();
        let uniform_end = horizontal.iter().rposition(|&d| d == largest).unwrap() + 1;
        Self {
            horizontal, uniform_start, uniform_end, vertical: 0,
            uniform: pulp_simd::U32Divider::new(1),
        }
    }

    #[inline(always)]
    fn set_vertical(&mut self, vertical: u32) {
        if self.vertical != vertical {
            self.vertical = vertical;
            // The image-global horizontal plateau shares one exact reciprocal;
            // interior rows reuse it too. Cropping never changes edge attenuation.
            self.uniform = pulp_simd::U32Divider::new(
                (self.horizontal[self.uniform_start] * vertical).max(1));
        }
    }

    #[inline(always)]
    fn divider(&self, x: usize) -> pulp_simd::U32Divider {
        if (self.uniform_start..self.uniform_end).contains(&x) {
            self.uniform
        } else {
            pulp_simd::U32Divider::new((self.horizontal[x] * self.vertical).max(1))
        }
    }

    #[inline(always)]
    fn vectors<S: pulp::Simd>(&self, simd: S, x: usize) -> (S::u32s, S::u32s, S::u32s) {
        let lanes = pulp_simd::u32_lanes::<S>();
        if x >= self.uniform_start && x + lanes <= self.uniform_end {
            return (simd.splat_u32s(self.uniform.denominator),
                simd.splat_u32s(self.uniform.multiplier), simd.splat_u32s(self.uniform.denominator / 2));
        }
        // Only a boundary tile needs differing lane denominators. Keep its
        // metadata on the stack, rather than allocating a denominator matrix.
        let mut denominators = simd.splat_u32s(1);
        let mut multipliers = simd.splat_u32s(0);
        let mut biases = simd.splat_u32s(0);
        let d = pulp::bytemuck::cast_slice_mut::<S::u32s, u32>(std::slice::from_mut(&mut denominators));
        let m = pulp::bytemuck::cast_slice_mut::<S::u32s, u32>(std::slice::from_mut(&mut multipliers));
        let b = pulp::bytemuck::cast_slice_mut::<S::u32s, u32>(std::slice::from_mut(&mut biases));
        for lane in 0..lanes {
            let divider = self.divider(x + lane);
            d[lane] = divider.denominator;
            m[lane] = divider.multiplier;
            b[lane] = divider.denominator / 2;
        }
        (denominators, multipliers, biases)
    }
}

#[inline(always)]
fn box_normalize_vector<S: pulp::Simd>(
    simd: S, sum: S::u32s, denominators: (S::u32s, S::u32s, S::u32s), min_alpha: u8,
) -> S::u32s {
    let (denominator, multiplier, bias) = denominators;
    #[cfg(debug_assertions)]
    {
        // Pulp addition wraps; retain the old scalar debug overflow panic.
        let sums = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&sum));
        let biases = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&bias));
        for (&sum, &bias) in sums.iter().zip(biases) { let _ = sum + bias; }
    }
    // Exact multiply-high/remainder correction replaces scalar (sum+d/2)/d;
    // rounding, byte clipping, and the strict min-alpha comparison are unchanged.
    let raw = pulp_simd::divide_u32s(simd, simd.add_u32s(sum, bias), denominator, multiplier);
    let value = simd.min_u32s(raw, simd.splat_u32s(255));
    simd.select_u32s(simd.less_than_u32s(value, simd.splat_u32s(min_alpha as u32)), simd.splat_u32s(0), value)
}

#[inline(always)]
fn box_store_vector<S: pulp::Simd>(values: S::u32s, row: &mut [u8]) -> bool {
    let values = pulp::bytemuck::cast_slice::<S::u32s, u32>(std::slice::from_ref(&values));
    let mut all_zero = true;
    for (out, &value) in row.iter_mut().zip(values) {
        *out = value as u8;
        all_zero &= value == 0;
    }
    all_zero
}

#[inline(always)]
fn box_normalize_row<S: pulp::Simd>(
    simd: S, columns: &[u32], denominators: &mut BoxNormalizeDenominators<'_>,
    v_denom: u32, min_alpha: u8, row: &mut [u8],
) -> bool {
    denominators.set_vertical(v_denom);
    let lanes = pulp_simd::u32_lanes::<S>();
    let (vectors, tail) = S::as_simd_u32s(columns);
    let end = vectors.len() * lanes;
    let mut all_zero = true;
    for (x, &sum) in vectors.iter().enumerate() {
        let x = x * lanes;
        let value = box_normalize_vector(simd, sum, denominators.vectors(simd, x), min_alpha);
        all_zero &= box_store_vector::<S>(value, &mut row[x..x + lanes]);
    }
    for (lane, (&sum, out)) in tail.iter().zip(&mut row[end..]).enumerate() {
        let divider = denominators.divider(end + lane);
        let value = divider.divide(sum + divider.denominator / 2).min(255) as u8;
        *out = if value < min_alpha { 0 } else { value };
        all_zero &= *out == 0;
    }
    all_zero
}

struct BoxSequentialBlur<'a> {
    mask: &'a mut [u8],
    width: usize,
    roi_min_x: usize,
    roi_min_y: usize,
    roi_w: usize,
    roi_h: usize,
    radius: usize,
    min_alpha_u8: u8,
    h_denom: &'a [u32],
    v_denom: &'a [u32],
}

impl pulp::WithSimd for BoxSequentialBlur<'_> {
    type Output = ();

    #[inline(always)]
    fn with_simd<S: pulp::Simd>(self, simd: S) {
        if pulp_simd::u32_lanes::<S>() == 1 || self.radius > 127 {
            box_sequential_blur_with_simd::<S, true>(self, simd);
        } else {
            box_sequential_blur_with_simd::<S, false>(self, simd);
        }
    }
}

#[inline(always)]
fn box_sequential_blur_with_simd<S: pulp::Simd, const ADD_COLUMNS: bool>(
    operation: BoxSequentialBlur<'_>, simd: S,
) {
    let BoxSequentialBlur {
        mask, width, roi_min_x, roi_min_y, roi_w, roi_h, radius, min_alpha_u8, h_denom, v_denom,
    } = operation;
    // Single forward pass; ring holds at most (2r+1) rows of horizontal
    // sums.  O(roi_w × roi_h) time, O(radius × roi_w) extra memory.
    let ring_cap = 2 * radius + 1;
    let mut ring = vec![0u16; ring_cap * roi_w];
    let mut col_sums = vec![0u32; roi_w];
    let mut ring_head = 0usize;
    let mut ring_len = 0usize;
    let mut denominators = BoxNormalizeDenominators::new(h_denom);

    for add_row in 0..roi_h + radius {
        if add_row < roi_h {
            let new_slot = (ring_head + ring_len) % ring_cap;
            let slot_start = new_slot * roi_w;
            let src_y = roi_min_y + add_row;
            let src_row_start = src_y * width + roi_min_x;
            let src = &mask[src_row_start..src_row_start + roi_w];

            let ring_row = &mut ring[slot_start..slot_start + roi_w];
            box_horizontal_row::<ADD_COLUMNS>(src, radius, ring_row, &mut col_sums);
            if !ADD_COLUMNS { box_update_columns::<S, false>(simd, &mut col_sums, ring_row); }
            ring_len += 1;
        }

        if add_row >= radius {
            let out_row = add_row - radius;
            let dst_y = roi_min_y + out_row;
            let dst_row_start = dst_y * width + roi_min_x;
            let row_out = &mut mask[dst_row_start..dst_row_start + roi_w];
            box_normalize_row(simd, &col_sums, &mut denominators, v_denom[out_row], min_alpha_u8, row_out);

            if out_row >= radius {
                let evict_start = ring_head * roi_w;
                let row = &ring[evict_start..evict_start + roi_w];
                box_update_columns::<S, true>(simd, &mut col_sums, row);
                ring_head = (ring_head + 1) % ring_cap;
                ring_len -= 1;
            }
        }
    }
}

struct BoxVerticalColumns<'a> {
    hpass: &'a [u16],
    mask_ptr: usize,
    width: usize,
    roi_min_x: usize,
    roi_min_y: usize,
    roi_w: usize,
    roi_h: usize,
    x_start: usize,
    x_end: usize,
    radius: usize,
    min_alpha: u8,
    h_denom: &'a [u32],
    v_denom: &'a [u32],
}

impl pulp::WithSimd for BoxVerticalColumns<'_> {
    type Output = ();

    #[inline(always)]
    fn with_simd<S: pulp::Simd>(self, simd: S) {
        let lanes = pulp_simd::u32_lanes::<S>();
        let mut denominators = BoxNormalizeDenominators::new(&self.h_denom[self.x_start..self.x_end]);
        let mut x = self.x_start;
        while self.radius <= 127 && x + lanes <= self.x_end {
            let mut sum = simd.splat_u32s(0);
            for y in 0..=self.radius.min(self.roi_h - 1) {
                sum = simd.add_u32s(sum, pulp_simd::load_u16_as_u32(simd, &self.hpass[y * self.roi_w + x..]));
            }
            let mut vertical = 0;
            let mut metadata = (simd.splat_u32s(1), simd.splat_u32s(0), simd.splat_u32s(0));
            for y in 0..self.roi_h {
                if vertical != self.v_denom[y] {
                    vertical = self.v_denom[y];
                    denominators.set_vertical(vertical);
                    // Reuse the complete tile's divisors down the vertical
                    // plateau, including horizontal image-border lanes.
                    metadata = denominators.vectors(simd, x - self.x_start);
                }
                let value = box_normalize_vector(simd, sum, metadata, self.min_alpha);
                // Each task owns a disjoint column block; H-pass is read-only.
                let row = unsafe {
                    std::slice::from_raw_parts_mut((self.mask_ptr as *mut u8)
                        .add((self.roi_min_y + y) * self.width + self.roi_min_x + x), lanes)
                };
                box_store_vector::<S>(value, row);
                let bot = y + self.radius + 1;
                if bot < self.roi_h {
                    sum = simd.add_u32s(sum, pulp_simd::load_u16_as_u32(simd, &self.hpass[bot * self.roi_w + x..]));
                }
                if y >= self.radius {
                    sum = simd.sub_u32s(sum, pulp_simd::load_u16_as_u32(simd, &self.hpass[(y - self.radius) * self.roi_w + x..]));
                }
            }
            x += lanes;
        }
        for x in x..self.x_end {
            let mut sum = 0u32;
            for y in 0..=self.radius.min(self.roi_h - 1) {
                sum += self.hpass[y * self.roi_w + x] as u32;
            }
            let mut vertical = 0;
            let mut divider = pulp_simd::U32Divider::new(1);
            for y in 0..self.roi_h {
                if vertical != self.v_denom[y] {
                    vertical = self.v_denom[y];
                    denominators.set_vertical(vertical);
                    divider = denominators.divider(x - self.x_start);
                }
                let blurred = divider.divide(sum + divider.denominator / 2).min(255) as u8;
                unsafe {
                    *(self.mask_ptr as *mut u8).add((self.roi_min_y + y) * self.width + self.roi_min_x + x) =
                        if blurred < self.min_alpha { 0 } else { blurred };
                }
                let bot = y + self.radius + 1;
                if bot < self.roi_h {
                    sum += self.hpass[bot * self.roi_w + x] as u32;
                }
                if y >= self.radius {
                    sum -= self.hpass[(y - self.radius) * self.roi_w + x] as u32;
                }
            }
        }
    }
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
    apply_edge_box_blur_to_mask_in_roi_with_backend(
        mask, width, height, radius, min_alpha_u8,
        roi_min_x, roi_max_x, roi_min_y, roi_max_y, Backend::detected(),
    );
}

fn apply_edge_box_blur_to_mask_in_roi_with_backend(
    mask: &mut [u8],
    width: usize,
    height: usize,
    radius: usize,
    min_alpha_u8: u8,
    roi_min_x: usize,
    roi_max_x: usize,
    roi_min_y: usize,
    roi_max_y: usize,
    backend: Backend,
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
        backend.dispatch(BoxSequentialBlur {
            mask, width, roi_min_x, roi_min_y, roi_w, roi_h, radius, min_alpha_u8,
            h_denom: &h_denom, v_denom: &v_denom,
        });
        return;
    }

    // ── Parallel H→V path (large ROIs, release builds) ───────────────────
    // Reuse a buffer per thread, but take ownership before Rayon can run another
    // blur on this worker. A reentrant blur must not overwrite the live H-pass.
    // SAFETY invariant: H-pass writes every element before V-pass reads it.
    thread_local! {
        static HPASS: std::cell::RefCell<Vec<u16>> = std::cell::RefCell::new(Vec::new());
    }

    let mask_read = mask.as_ptr() as usize;
    let mask_ptr = mask.as_mut_ptr() as usize;

    {
        let mut hpass = HPASS.with(|cell| std::mem::take(&mut *cell.borrow_mut()));
        let needed = roi_w * roi_h;
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

        // Let a queued nested blur run here so the regression test exercises the
        // reentrant case deterministically; compiled out in non-test builds.
        #[cfg(test)]
        rayon::yield_now();

        // V-pass tasks own disjoint column blocks. Dispatch inside each Rayon
        // worker, so its entire vector loop runs in the CPU-gated scope.
        (0..roi_w.div_ceil(64)).into_par_iter().for_each(|block| {
            let x_start = block * 64;
            backend.dispatch(BoxVerticalColumns {
                hpass: &hpass,
                mask_ptr,
                width,
                roi_min_x,
                roi_min_y,
                roi_w,
                roi_h,
                x_start,
                x_end: (x_start + 64).min(roi_w),
                radius,
                min_alpha: min_alpha_u8,
                h_denom: &h_denom,
                v_denom: &v_denom,
            });
        });
        HPASS.with(|cell| {
            let mut cached = cell.borrow_mut();
            if cached.capacity() < hpass.capacity() {
                *cached = hpass;
            }
        });
    }
}

fn gaussian_blur_weights(radius: usize, sigma: f64) -> Vec<u32> {
    if radius == 0 {
        return vec![1024];
    }

    let sigma = sigma.max(0.05);

    let mut weights = Vec::with_capacity(radius + 1);
    for d in 0..=radius {
        let dist = d as f64;
        let exponent = -((dist * dist) / (2.0 * sigma * sigma));
        weights.push((exponent.exp() * 1024.0).round().max(1.0) as u32);
    }
    weights
}

fn weighted_blur_axis_denom(index: usize, max_index: usize, radius: usize, weights: &[u32]) -> u64 {
    let mut denom = weights[0] as u64;
    for dist in 1..=radius {
        let w = weights[dist] as u64;
        if index >= dist {
            denom = denom.saturating_add(w);
        }
        if index.saturating_add(dist) <= max_index {
            denom = denom.saturating_add(w);
        }
    }
    denom.max(1)
}

struct GaussianHorizontalRow<'a> {
    source: &'a [u8],
    output: &'a mut [u32],
    roi_min_x: usize,
    weights: &'a [u32],
}

impl pulp::WithSimd for GaussianHorizontalRow<'_> {
    type Output = ();

    #[inline(always)]
    fn with_simd<S: pulp::Simd>(self, simd: S) {
        let radius = self.weights.len() - 1;
        let lanes = pulp_simd::u32_lanes::<S>();
        let mut local_x = 0;
        while local_x < self.output.len() {
            let x = self.roi_min_x + local_x;
            if x >= radius && local_x + lanes <= self.output.len()
                && x + lanes <= self.source.len().saturating_sub(radius)
            {
                let mut sum = pulp_simd::sat_mul_u32(simd,
                    pulp_simd::load_u8_as_u32(simd, &self.source[x..]), simd.splat_u32s(self.weights[0]));
                for dist in 1..=radius {
                    let weight = simd.splat_u32s(self.weights[dist]);
                    let left = pulp_simd::sat_mul_u32(simd, pulp_simd::load_u8_as_u32(simd, &self.source[x - dist..]), weight);
                    let right = pulp_simd::sat_mul_u32(simd, pulp_simd::load_u8_as_u32(simd, &self.source[x + dist..]), weight);
                    sum = pulp_simd::sat_add_u32(simd, pulp_simd::sat_add_u32(simd, sum, left), right);
                }
                // All terms are nonnegative: saturating each u32 term/add is
                // identical to the original u64 sum followed by the u32 clamp.
                S::as_mut_simd_u32s(&mut self.output[local_x..local_x + lanes]).0[0] = sum;
                local_x += lanes;
            } else {
                let mut sum = (self.weights[0] as u64).saturating_mul(self.source[x] as u64);
                for dist in 1..=radius {
                    let weight = self.weights[dist] as u64;
                    if let Some(left) = x.checked_sub(dist) {
                        sum = sum.saturating_add(weight.saturating_mul(self.source[left] as u64));
                    }
                    if let Some(right) = x.checked_add(dist) {
                        if right < self.source.len() {
                            sum = sum.saturating_add(weight.saturating_mul(self.source[right] as u64));
                        }
                    }
                }
                self.output[local_x] = sum.min(u32::MAX as u64) as u32;
                local_x += 1;
            }
        }
    }
}

#[inline(always)]
fn gaussian_normalize_vector<S: pulp::Simd>(
    simd: S, sum: S::u64s, x_denoms: &[u64], y_denom: u64,
    uniform: Option<pulp_simd::U64ByteDivider>, min_alpha: u8, output: &mut [u8],
) {
    // Only the clipped byte quotient is needed. Cached multiply-high constants
    // on narrow vectors, or eight vector compare/subtract steps on wide vectors,
    // replace scalar (sum+d/2)/d without reducing Gaussian precision.
    let value = if let Some(divider) = uniform {
        #[cfg(debug_assertions)]
        for &sum in pulp::bytemuck::cast_slice::<S::u64s, u64>(std::slice::from_ref(&sum)) {
            let _ = sum + divider.denominator / 2;
        }
        divider.divide_simd(simd, simd.add_u64s(sum, simd.splat_u64s(divider.denominator / 2)))
    } else {
        let mut denominator = simd.splat_u64s(1);
        let mut bias = simd.splat_u64s(0);
        let d = pulp::bytemuck::cast_slice_mut::<S::u64s, u64>(std::slice::from_mut(&mut denominator));
        let b = pulp::bytemuck::cast_slice_mut::<S::u64s, u64>(std::slice::from_mut(&mut bias));
        for lane in 0..pulp_simd::u64_lanes::<S>() {
            d[lane] = x_denoms[lane].saturating_mul(y_denom).max(1);
            b[lane] = d[lane] / 2;
        }
        #[cfg(debug_assertions)]
        {
            // Bias addition is deliberately not saturating, just as before.
            let sums = pulp::bytemuck::cast_slice::<S::u64s, u64>(std::slice::from_ref(&sum));
            for (&sum, &bias) in sums.iter().zip(b.iter()) { let _ = sum + bias; }
        }
        pulp_simd::divide_u64s_to_u8(simd, simd.add_u64s(sum, bias), denominator)
    };
    let value = simd.select_u64s(simd.less_than_u64s(value, simd.splat_u64s(min_alpha as u64)), simd.splat_u64s(0), value);
    let values = pulp::bytemuck::cast_slice::<S::u64s, u64>(std::slice::from_ref(&value));
    for (out, &value) in output.iter_mut().zip(values) {
        *out = value as u8;
    }
}

struct GaussianVerticalRow<'a> {
    ring: &'a std::collections::VecDeque<(usize, Vec<u32>)>,
    output: &'a mut [u8],
    out_y: usize,
    weights: &'a [u32],
    x_denoms: &'a [u64],
    y_denom: u64,
    uniform_start: usize,
    uniform_end: usize,
    uniform_divider: pulp_simd::U64ByteDivider,
    min_alpha: u8,
}

impl pulp::WithSimd for GaussianVerticalRow<'_> {
    type Output = ();

    #[inline(always)]
    fn with_simd<S: pulp::Simd>(self, simd: S) {
        let lanes = pulp_simd::u32_lanes::<S>();
        let wide_lanes = pulp_simd::u64_lanes::<S>();
        let end = if lanes == 1 { 0 } else { self.output.len() / lanes * lanes };
        for x in (0..end).step_by(lanes) {
            let mut lo = simd.splat_u64s(0);
            let mut hi = simd.splat_u64s(0);
            for (row_y, row) in self.ring {
                let dist = row_y.abs_diff(self.out_y);
                if dist < self.weights.len() {
                    let (product_lo, product_hi) = pulp_simd::widening_mul_u32_to_u64(simd,
                        S::as_simd_u32s(&row[x..x + lanes]).0[0], simd.splat_u32s(self.weights[dist]));
                    lo = pulp_simd::sat_add_u64(simd, lo, product_lo);
                    hi = pulp_simd::sat_add_u64(simd, hi, product_hi);
                }
            }
            let uniform_lo = (x >= self.uniform_start && x + wide_lanes <= self.uniform_end)
                .then_some(self.uniform_divider);
            gaussian_normalize_vector(simd, lo, &self.x_denoms[x..], self.y_denom,
                uniform_lo, self.min_alpha, &mut self.output[x..x + wide_lanes]);
            let high_x = x + wide_lanes;
            let uniform_hi = (high_x >= self.uniform_start && x + lanes <= self.uniform_end)
                .then_some(self.uniform_divider);
            gaussian_normalize_vector(simd, hi, &self.x_denoms[high_x..], self.y_denom,
                uniform_hi, self.min_alpha, &mut self.output[high_x..x + lanes]);
        }
        for x in end..self.output.len() {
            let mut sum = 0u64;
            for (row_y, row) in self.ring {
                let dist = row_y.abs_diff(self.out_y);
                if dist < self.weights.len() {
                    sum = sum.saturating_add((self.weights[dist] as u64).saturating_mul(row[x] as u64));
                }
            }
            let divider = if (self.uniform_start..self.uniform_end).contains(&x) {
                self.uniform_divider
            } else {
                pulp_simd::U64ByteDivider::new(self.x_denoms[x].saturating_mul(self.y_denom).max(1))
            };
            let blurred = divider.divide(sum + divider.denominator / 2);
            self.output[x] = if blurred < self.min_alpha { 0 } else { blurred };
        }
    }
}

fn apply_edge_gaussian_blur_to_mask_in_roi(
    mask: &mut [u8],
    width: usize,
    height: usize,
    radius: usize,
    sigma_x: f64,
    sigma_y: f64,
    min_alpha_u8: u8,
    roi_min_x: usize,
    roi_max_x: usize,
    roi_min_y: usize,
    roi_max_y: usize,
) {
    apply_edge_gaussian_blur_to_mask_in_roi_with_backend(
        mask, width, height, radius, sigma_x, sigma_y, min_alpha_u8,
        roi_min_x, roi_max_x, roi_min_y, roi_max_y, Backend::detected(),
    );
}

fn apply_edge_gaussian_blur_to_mask_in_roi_with_backend(
    mask: &mut [u8],
    width: usize,
    height: usize,
    radius: usize,
    sigma_x: f64,
    sigma_y: f64,
    min_alpha_u8: u8,
    roi_min_x: usize,
    roi_max_x: usize,
    roi_min_y: usize,
    roi_max_y: usize,
    backend: Backend,
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

    let weights_x = gaussian_blur_weights(radius, sigma_x);
    let weights_y = gaussian_blur_weights(radius, sigma_y);
    let roi_w = roi_max_x - roi_min_x + 1;
    let roi_h = roi_max_y - roi_min_y + 1;
    let x_denoms: Vec<u64> = (roi_min_x..=roi_max_x)
        .map(|x| weighted_blur_axis_denom(x, width - 1, radius, &weights_x))
        .collect();
    let y_denoms: Vec<u64> = (roi_min_y..=roi_max_y)
        .map(|y| weighted_blur_axis_denom(y, height - 1, radius, &weights_y))
        .collect();
    let largest_x_denom = *x_denoms.iter().max().unwrap();
    let uniform_start = x_denoms.iter().position(|&d| d == largest_x_denom).unwrap();
    let uniform_end = uniform_start + x_denoms[uniform_start..].iter()
        .take_while(|&&d| d == largest_x_denom).count();
    let mut last_y_denom = 0;
    let mut uniform_divider = pulp_simd::U64ByteDivider::new(1);

    let source = mask.to_vec();
    let mut out = vec![0u8; mask.len()];
    let mut ring: std::collections::VecDeque<(usize, Vec<u32>)> =
        std::collections::VecDeque::with_capacity(radius.saturating_mul(2).saturating_add(1));

    for add_row in 0..roi_h + radius {
        if add_row < roi_h {
            let y = roi_min_y + add_row;
            let row_start = y * width;
            let mut hrow = vec![0u32; roi_w];
            backend.dispatch(GaussianHorizontalRow {
                source: &source[row_start..row_start + width],
                output: &mut hrow,
                roi_min_x,
                weights: &weights_x,
            });
            ring.push_back((y, hrow));
        }

        if add_row >= radius {
            let out_y = roi_min_y + (add_row - radius);
            let y_denom = y_denoms[out_y - roi_min_y];
            if last_y_denom != y_denom {
                last_y_denom = y_denom;
                // Reuse the global horizontal/vertical plateau denominator
                // across pixels and rows, retaining cropped-edge attenuation.
                uniform_divider = pulp_simd::U64ByteDivider::new(largest_x_denom.saturating_mul(y_denom).max(1));
            }
            let row_start = out_y * width;
            backend.dispatch(GaussianVerticalRow {
                ring: &ring,
                output: &mut out[row_start + roi_min_x..row_start + roi_min_x + roi_w],
                out_y,
                weights: &weights_y,
                x_denoms: &x_denoms,
                y_denom,
                uniform_start,
                uniform_end,
                uniform_divider,
                min_alpha: min_alpha_u8,
            });

            if out_y >= radius {
                ring.pop_front();
            }
        }
    }

    mask.copy_from_slice(&out);
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
        1.5,
        1.5,
        min_alpha_u8,
        "box",
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
    sigma_x: f64,
    sigma_y: f64,
    min_alpha_u8: u8,
    kernel: &str,
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

    if kernel.trim().eq_ignore_ascii_case("gaussian") {
        apply_edge_gaussian_blur_to_mask_in_roi(
            mask,
            width,
            height,
            radius,
            sigma_x,
            sigma_y,
            min_alpha_u8,
            roi_min_x,
            clamped_max_x,
            roi_min_y,
            clamped_max_y,
        );
    } else {
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
    let runs = rle.finish();
    runs
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

fn build_scanline_segment_index_z_perturbed(
    segments_list: &[Vec<Segment>],
    height: usize,
    aa_steps: usize,
) -> Option<ScanlineSegmentIndex> {
    let sub_height = height.saturating_mul(aa_steps);
    if sub_height == 0 || segments_list.is_empty() {
        return None;
    }

    // With Duplicate Terminal Z there are fewer unique Z heights than Y
    // sub-samples, so each Z sample feeds two consecutive sub-rows. Every
    // sub-row must still be filled: skipping half of them would halve the
    // accumulated coverage and turn solid interiors grey.
    let z_steps = segments_list.len().min(aa_steps).max(1);
    let mut start_counts = vec![0usize; sub_height];
    let mut global_start = sub_height;
    let mut global_end = 0usize;
    let f_steps = aa_steps as f32;

    for sample_idx in 0..aa_steps {
        let phase = (sample_idx as f32 + 0.5) / f_steps;
        for seg in &segments_list[sample_idx * z_steps / aa_steps] {
            let start_py = (seg.y_min - phase).ceil() as i32;
            let end_py = (seg.y_max - phase).ceil() as i32;
            let clamped_start = start_py.clamp(0, height as i32) as usize;
            let clamped_end = end_py.clamp(0, height as i32) as usize;
            if clamped_start >= clamped_end {
                continue;
            }
            for py in clamped_start..clamped_end {
                let y = py * aa_steps + sample_idx;
                start_counts[y] += 1;
                global_start = global_start.min(y);
                global_end = global_end.max(y + 1);
            }
        }
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

    for sample_idx in 0..aa_steps {
        let phase = (sample_idx as f32 + 0.5) / f_steps;
        for seg in &segments_list[sample_idx * z_steps / aa_steps] {
            let start_py = (seg.y_min - phase).ceil() as i32;
            let end_py = (seg.y_max - phase).ceil() as i32;
            let clamped_start = start_py.clamp(0, height as i32) as usize;
            let clamped_end = end_py.clamp(0, height as i32) as usize;
            if clamped_start >= clamped_end {
                continue;
            }
            for py in clamped_start..clamped_end {
                let y = py * aa_steps + sample_idx;
                let y_sample = py as f32 + phase;
                let x = seg.x1 + (y_sample - seg.y1) * seg.dx_dy;
                let pos = write_offsets[y];
                indexed[pos] = ActiveEdge {
                    x,
                    dx_dy: 0.0,
                    wind: seg.wind,
                    end_exclusive: y + 1,
                };
                write_offsets[y] += 1;
            }
        }
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

#[inline]
fn resolve_accumulated_aa_alpha(accum: f32, coverage: i32, aa_steps: usize) -> u8 {
    let total = if coverage > 0 {
        accum + (coverage as f32)
    } else {
        accum
    };

    if total <= 0.0 {
        0
    } else {
        (total / (aa_steps as f32)).round().clamp(0.0, 255.0) as u8
    }
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
    let use_z_perturbation = zaa::use_raster_perturbation(job) && aa_steps > 1;

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
    let blur_tail_lut = if blur_mode {
        job.normalized_tail_cure_lut()
    } else {
        None
    };
    let segments_list = if use_z_perturbation {
        build_z_perturbed_segments_list(job, triangles, layer_indices, layer_index, aa_steps)
    } else {
        Vec::new()
    };
    let segments = if use_z_perturbation {
        Vec::new()
    } else {
        let z_mm = (layer_index as f32 + 0.5) * job.layer_height_mm;
        build_segments_for_layer(job, triangles, layer_indices, z_mm)
    };

    if use_z_perturbation {
        if segments_list.iter().all(|segments| segments.is_empty()) {
            return (mask, stats);
        }
    } else if segments.is_empty() {
        return (mask, stats);
    }

    let scanline_index = if use_z_perturbation {
        build_scanline_segment_index_z_perturbed(&segments_list, height, aa_steps)
    } else {
        build_scanline_segment_index(&segments, height, aa_steps, 0.5)
    };
    let Some(scanline_index) = scanline_index else {
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

    let segment_capacity = if use_z_perturbation {
        segments_list
            .iter()
            .map(|segments| segments.len())
            .max()
            .unwrap_or(0)
    } else {
        segments.len()
    };
    let mut active_edges: Vec<ActiveEdge> = Vec::with_capacity(segment_capacity.min(256));
    let mut merge_scratch: Vec<ActiveEdge> = Vec::with_capacity(segment_capacity.min(256));

    let mut row_accum = vec![0.0f32; width];
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
    let mut prev_spans: Vec<RowSpan> = Vec::new();

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
                    let resolved = resolve_accumulated_aa_alpha(row_accum[x], coverage, aa_steps);
                    if resolved > 0 {
                        mask_row[x] = resolved;
                    }
                    row_accum[x] = 0.0;
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
            prev_spans.clear();
            continue;
        }

        let row_start = physical_y * width;

        let spans =
            build_row_spans_nonzero_ctx(&active_edges, width, !aa_enabled, Some(&prev_spans));

        for span in spans.iter().copied() {
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
                            row_accum[left_i as usize] += cov;
                        }
                    } else {
                        let left_cov = ((left_i as f32 + 1.0) - span.a).clamp(0.0, 1.0) * 255.0;
                        let right_cov = (span.b - right_i as f32).clamp(0.0, 1.0) * 255.0;

                        if left_i >= 0 && left_i < width as i32 {
                            row_accum[left_i as usize] += left_cov;
                        }

                        let interior_start = (left_i + 1).max(0) as usize;
                        let interior_end = (right_i - 1).min(width as i32 - 1) as usize;
                        if interior_end >= interior_start {
                            row_delta[interior_start] += 255;
                            row_delta[interior_end + 1] -= 255;
                        }

                        if right_i >= 0 && right_i < width as i32 {
                            row_accum[right_i as usize] += right_cov;
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

        prev_spans = spans;

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
            0,
            roi_min_x,
            roi_max_x,
            roi_min_y,
            roi_max_y,
        );

        if let Some(lut) = blur_tail_lut.as_ref() {
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
                let resolved = resolve_accumulated_aa_alpha(row_accum[x], coverage, aa_steps);
                if resolved > 0 {
                    mask_row[x] = resolved;
                }
                row_accum[x] = 0.0;
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
    let Some(model_tri) = support_split_bounds_for_2d_raster(job, triangles.len())
    else {
        return rasterize_layer_with_stats_impl(
            job,
            triangles,
            layer_indices,
            layer_index,
            compute_area_stats,
        );
    };

    let mut model_layer_indices = Vec::with_capacity(layer_indices.len());
    let mut support_layer_indices = Vec::with_capacity(layer_indices.len());
    split_layer_candidates_by_bounds(
        layer_indices,
        model_tri,
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
    support_job.support_halo_enabled = false;
    support_job.support_halo_radius_px = 0;

    let (mut support_mask, _support_stats) = rasterize_layer_with_stats_impl(
        &support_job,
        triangles,
        &support_layer_indices,
        layer_index,
        false,
    );

    if job.support_halo_active() {
        let width = job.effective_render_width_px() as usize;
        let height = job.source_height_px as usize;
        apply_euclidean_radial_halo_dense(
            &mut support_mask,
            width,
            height,
            job.effective_support_halo_radius_px(),
            job.effective_support_halo_max_intensity_u8(),
            SupportHaloProfile::from_str_lossy(&job.support_halo_profile),
            job.effective_support_halo_max_tip_diameter_px(),
        );
    }

    for (dst, src) in model_mask.iter_mut().zip(support_mask.iter()) {
        if *src > *dst {
            *dst = *src;
        }
    }
    crate::pipeline::return_mask_to_pool(support_mask);

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
        crate::pipeline::return_mask_to_pool(mask);
        return (runs, stats);
    }

    let aa_level_steps = job.effective_xy_aa_steps();
    let aa_steps = (aa_level_steps as usize).max(1);
    let aa_enabled = aa_steps > 1;
    let use_z_perturbation = zaa::use_raster_perturbation(job) && aa_enabled;

    if use_z_perturbation {
        let segments_list =
            build_z_perturbed_segments_list(job, triangles, layer_indices, layer_index, aa_steps);
        if segments_list.iter().all(|segments| segments.is_empty()) {
            emit_zero_rows(&mut rle, height, width);
            return (rle.finish(), stats);
        }

        let Some(scanline_index) =
            build_scanline_segment_index_z_perturbed(&segments_list, height, aa_steps)
        else {
            emit_zero_rows(&mut rle, height, width);
            return (rle.finish(), stats);
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

        let first_physical_y = y_start / aa_steps;
        emit_zero_rows(&mut rle, first_physical_y, width);

        let pixel_area_mm2 = ((job.build_width_mm as f64)
            / (job.effective_render_width_px().max(1) as f64))
            * ((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));

        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;

        let segment_capacity = segments_list
            .iter()
            .map(|segments| segments.len())
            .max()
            .unwrap_or(0);
        let mut active_edges: Vec<ActiveEdge> = Vec::with_capacity(segment_capacity.min(256));
        let mut merge_scratch: Vec<ActiveEdge> = Vec::with_capacity(segment_capacity.min(256));

        let mut row_buf = vec![0u8; width];
        let mut row_accum = vec![0.0f32; width];
        let mut row_delta = vec![0i32; width + 1];
        let mut row_hit_delta = if track_aa_components {
            vec![0i32; width + 1]
        } else {
            Vec::new()
        };
        let mut current_physical_y = first_physical_y;
        #[allow(unused_assignments)]
        let mut last_emitted_py = first_physical_y.wrapping_sub(1);

        macro_rules! flush_up_to {
            ($next_py:expr) => {{
                let mut coverage = 0i32;
                let mut occupied = 0i32;
                let mut run_start: Option<usize> = None;

                for x in 0..width {
                    coverage += row_delta[x];
                    let resolved = resolve_accumulated_aa_alpha(row_accum[x], coverage, aa_steps);
                    if resolved > 0 {
                        row_buf[x] = resolved;
                    }
                    row_accum[x] = 0.0;
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

        let mut prev_spans: Vec<RowSpan> = Vec::new();
        for y in y_start..y_end_exclusive {
            let physical_y = y / aa_steps;

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
                prev_spans.clear();
                continue;
            }

            let spans =
                build_row_spans_nonzero_ctx(&active_edges, width, false, Some(&prev_spans));
            for span in spans.iter().copied() {
                let left_i = span.a.floor() as i32;
                let right_i = span.b.ceil() as i32 - 1;

                if left_i <= right_i {
                    if left_i == right_i {
                        if left_i >= 0 && left_i < width as i32 {
                            let cov = (span.b - span.a).clamp(0.0, 1.0) * 255.0;
                            row_accum[left_i as usize] += cov;
                        }
                    } else {
                        let left_cov = ((left_i as f32 + 1.0) - span.a).clamp(0.0, 1.0) * 255.0;
                        let right_cov = (span.b - right_i as f32).clamp(0.0, 1.0) * 255.0;

                        if left_i >= 0 && left_i < width as i32 {
                            row_accum[left_i as usize] += left_cov;
                        }

                        let interior_start = (left_i + 1).max(0) as usize;
                        let interior_end = (right_i - 1).min(width as i32 - 1) as usize;
                        if interior_end >= interior_start {
                            row_delta[interior_start] += 255;
                            row_delta[interior_end + 1] -= 255;
                        }

                        if right_i >= 0 && right_i < width as i32 {
                            row_accum[right_i as usize] += right_cov;
                        }
                    }
                }

                if track_aa_components {
                    row_hit_delta[span.start] += 1;
                    row_hit_delta[span.end + 1] -= 1;
                }

                let filled = (span.end - span.start + 1) as u32;
                stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(filled);
                min_x = min_x.min(span.start as i32);
                max_x = max_x.max(span.end as i32);
                min_y = min_y.min(physical_y as i32);
                max_y = max_y.max(physical_y as i32);
            }

            prev_spans = spans;

            for edge in &mut active_edges {
                edge.x += edge.dx_dy;
            }
            restore_active_edges_sorted(&mut active_edges);
        }

        flush_up_to!(current_physical_y + 1);

        let rows_emitted = last_emitted_py + 1;
        if rows_emitted < height {
            emit_zero_rows(&mut rle, height - rows_emitted, width);
        }

        stats.total_solid_pixels /= aa_steps as u32;
        let runs = rle.finish();

        if stats.total_solid_pixels > 0 {
            stats.min_x = min_x;
            stats.min_y = min_y;
            stats.max_x = max_x;
            stats.max_y = max_y;

            if compute_area_stats {
                let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) =
                    aa_component_tracker
                        .take()
                        .map(|tracker| tracker.finalize(pixel_area_mm2))
                        .unwrap_or((0, 0.0, 0.0, 0));

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

    // Keep the previous spans for winding repair/coherence and direct emission.
    let mut prev_spans: Vec<RowSpan> = Vec::new();
    let mut current_physical_y = first_physical_y;
    // last_emitted_py: the most recent physical row fully committed to `rle`.
    // Starts at first_physical_y - 1 (we just emitted zeros 0..first_physical_y).
    #[allow(unused_assignments)]
    let mut last_emitted_py = first_physical_y.wrapping_sub(1);

    // Helper closure: commit `current_physical_y`'s row to `rle`, then emit
    // zero-rows for any skipped rows up to (but not including) `next_py`.
    macro_rules! flush_up_to {
        ($next_py:expr) => {{
            emit_binary_row_spans(&mut rle, &prev_spans, 0, width);
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
            prev_spans.clear();
            continue;
        }

        let spans = build_row_spans_nonzero_ctx(&active_edges, width, true, Some(&prev_spans));

        for span in spans.iter().copied() {
            let filled = (span.end - span.start + 1) as u32;
            stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(filled);
            min_x = min_x.min(span.start as i32);
            max_x = max_x.max(span.end as i32);
            min_y = min_y.min(physical_y as i32);
            max_y = max_y.max(physical_y as i32);
        }

        prev_spans = spans;

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

/// Compute per-window layer stats from a window-relative run stream.
///
/// X-extents are reported in absolute frame columns (`+ window_start_col`);
/// pixel totals count only pixels inside the window, so per-block stats can
/// be summed into an exact per-layer total.
fn window_stats_from_runs(
    runs: &[crate::rle::RleRun],
    window_width: usize,
    height: usize,
    window_start_col: usize,
    pixel_area_mm2: f64,
    compute_area_stats: bool,
) -> LayerAreaStatsV3 {
    let mut stats = LayerAreaStatsV3::default();
    if window_width == 0 || height == 0 {
        return stats;
    }

    let row_w = window_width as u64;
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    let mut pos: u64 = 0;
    for run in runs {
        let end = pos + run.length as u64;
        if run.value > 0 {
            let mut p = pos;
            while p < end {
                let row = p / row_w;
                let row_start = row * row_w;
                let seg_end = end.min(row_start + row_w);
                min_x = min_x.min((p - row_start) as i32);
                max_x = max_x.max((seg_end - 1 - row_start) as i32);
                min_y = min_y.min(row as i32);
                max_y = max_y.max(row as i32);
                stats.total_solid_pixels =
                    stats.total_solid_pixels.saturating_add((seg_end - p) as u32);
                p = seg_end;
            }
        }
        pos = end;
    }

    if stats.total_solid_pixels > 0 {
        stats.min_x = min_x + window_start_col as i32;
        stats.max_x = max_x + window_start_col as i32;
        stats.min_y = min_y;
        stats.max_y = max_y;

        if compute_area_stats {
            let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) =
                compute_component_area_stats_from_rle_8_connected(
                    runs,
                    window_width,
                    height,
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
    }

    stats
}

/// Rasterize one column window ("block") of a layer directly into RLE output.
///
/// The windowed counterpart of `rasterize_layer_rle`: emits an independent
/// `block.width × height` row-major run stream containing pixels
/// `[block.start_col, block.start_col + block.width)` of every row, so
/// encoders that store layers as column partitions (e.g. GOO V5 half-screen
/// panels) receive per-block streams directly instead of splitting a
/// full-width stream. Edge geometry is built once per call and painting is
/// clamped to the window, so pixel values inside the window are identical to
/// the full-width raster. Stats count window pixels only, with x-extents in
/// absolute frame columns, allowing exact per-layer aggregation across blocks.
/// Component counts are window-local: an island spanning a block seam is
/// counted once per block it touches.
#[allow(unused_assignments)]
pub fn rasterize_layer_rle_block(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    layer_index: u32,
    compute_area_stats: bool,
    block: crate::rle::RleBlockSpec,
) -> (Vec<crate::rle::RleRun>, LayerAreaStatsV3) {
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    let full_width = job.effective_render_width_px() as usize;
    let height = job.source_height_px as usize;
    let wstart = (block.start_col as usize).min(full_width);
    let wend = wstart
        .saturating_add(block.width as usize)
        .min(full_width);
    let wwidth = wend - wstart;

    let mut rle = RleAccum::new();
    let mut stats = LayerAreaStatsV3::default();

    if wwidth == 0 || height == 0 {
        return (rle.finish(), stats);
    }

    if layer_indices.is_empty() {
        emit_zero_rows(&mut rle, height, wwidth);
        return (rle.finish(), stats);
    }

    let pixel_area_mm2 = ((job.build_width_mm as f64)
        / (job.effective_render_width_px().max(1) as f64))
        * ((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));

    if supports_should_bypass_aa(job, triangles.len()) {
        let (mask, _) =
            rasterize_layer_with_stats(job, triangles, layer_indices, layer_index, false);
        let mut window_mask = Vec::with_capacity(wwidth * height);
        for row in 0..height {
            let row_start = row * full_width;
            window_mask.extend_from_slice(&mask[row_start + wstart..row_start + wend]);
        }
        crate::pipeline::return_mask_to_pool(mask);
        let runs = encode_mask_to_rle(&window_mask, wwidth, height);
        let stats = window_stats_from_runs(
            &runs,
            wwidth,
            height,
            wstart,
            pixel_area_mm2,
            compute_area_stats,
        );
        return (runs, stats);
    }

    let aa_level_steps = job.effective_xy_aa_steps();
    let aa_steps = (aa_level_steps as usize).max(1);
    let aa_enabled = aa_steps > 1;
    let use_z_perturbation = zaa::use_raster_perturbation(job) && aa_enabled;

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    if use_z_perturbation {
        let segments_list =
            build_z_perturbed_segments_list(job, triangles, layer_indices, layer_index, aa_steps);
        if segments_list.iter().all(|segments| segments.is_empty()) {
            emit_zero_rows(&mut rle, height, wwidth);
            return (rle.finish(), stats);
        }

        let Some(scanline_index) =
            build_scanline_segment_index_z_perturbed(&segments_list, height, aa_steps)
        else {
            emit_zero_rows(&mut rle, height, wwidth);
            return (rle.finish(), stats);
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

        let first_physical_y = y_start / aa_steps;
        emit_zero_rows(&mut rle, first_physical_y, wwidth);

        let segment_capacity = segments_list
            .iter()
            .map(|segments| segments.len())
            .max()
            .unwrap_or(0);
        let mut active_edges: Vec<ActiveEdge> = Vec::with_capacity(segment_capacity.min(256));
        let mut merge_scratch: Vec<ActiveEdge> = Vec::with_capacity(segment_capacity.min(256));

        let mut row_buf = vec![0u8; wwidth];
        let mut row_accum = vec![0.0f32; wwidth];
        let mut row_delta = vec![0i32; wwidth + 1];
        let mut row_hit_delta = if track_aa_components {
            vec![0i32; wwidth + 1]
        } else {
            Vec::new()
        };
        let mut current_physical_y = first_physical_y;
        #[allow(unused_assignments)]
        let mut last_emitted_py = first_physical_y.wrapping_sub(1);

        macro_rules! flush_up_to {
            ($next_py:expr) => {{
                let mut coverage = 0i32;
                let mut occupied = 0i32;
                let mut run_start: Option<usize> = None;

                for x in 0..wwidth {
                    coverage += row_delta[x];
                    let resolved = resolve_accumulated_aa_alpha(row_accum[x], coverage, aa_steps);
                    if resolved > 0 {
                        row_buf[x] = resolved;
                    }
                    row_accum[x] = 0.0;
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

                row_delta[wwidth] = 0;
                if track_aa_components {
                    if let Some(start) = run_start {
                        if let Some(ref mut tracker) = aa_component_tracker {
                            tracker.push_span(start, wwidth - 1);
                        }
                    }
                    row_hit_delta[wwidth] = 0;
                    if let Some(ref mut tracker) = aa_component_tracker {
                        tracker.finish_row();
                    }
                }

                emit_row(&mut rle, &row_buf);
                row_buf.fill(0);
                last_emitted_py = current_physical_y;

                let next = $next_py;
                let gap = next.saturating_sub(last_emitted_py + 1);
                if gap > 0 {
                    emit_zero_rows(&mut rle, gap, wwidth);
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

            let spans = build_row_spans_nonzero_ctx(&active_edges, full_width, false, None);
            for span in spans {
                // Clamp the fractional span to the window. The cut edge
                // becomes a full-coverage boundary, so pixel values inside
                // the window match the full-width raster exactly.
                let a = span.a.max(wstart as f32);
                let b = span.b.min(wend as f32);

                if b > a {
                    let left_i = a.floor() as i32;
                    let right_i = b.ceil() as i32 - 1;

                    if left_i <= right_i {
                        if left_i == right_i {
                            if left_i >= wstart as i32 && left_i < wend as i32 {
                                let cov = (b - a).clamp(0.0, 1.0) * 255.0;
                                row_accum[(left_i - wstart as i32) as usize] += cov;
                            }
                        } else {
                            let left_cov = ((left_i as f32 + 1.0) - a).clamp(0.0, 1.0) * 255.0;
                            let right_cov = (b - right_i as f32).clamp(0.0, 1.0) * 255.0;

                            if left_i >= wstart as i32 && left_i < wend as i32 {
                                row_accum[(left_i - wstart as i32) as usize] += left_cov;
                            }

                            let interior_start_i = (left_i + 1).max(wstart as i32);
                            let interior_end_i = (right_i - 1).min(wend as i32 - 1);
                            if interior_start_i <= interior_end_i {
                                row_delta[(interior_start_i - wstart as i32) as usize] += 255;
                                row_delta[(interior_end_i - wstart as i32) as usize + 1] -= 255;
                            }

                            if right_i >= wstart as i32 && right_i < wend as i32 {
                                row_accum[(right_i - wstart as i32) as usize] += right_cov;
                            }
                        }
                    }
                }

                let s = span.start.max(wstart);
                let e = span.end.min(wend - 1);
                if s <= e {
                    if track_aa_components {
                        row_hit_delta[s - wstart] += 1;
                        row_hit_delta[e - wstart + 1] -= 1;
                    }

                    let filled = (e - s + 1) as u32;
                    stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(filled);
                    min_x = min_x.min(s as i32);
                    max_x = max_x.max(e as i32);
                    min_y = min_y.min(physical_y as i32);
                    max_y = max_y.max(physical_y as i32);
                }
            }

            for edge in &mut active_edges {
                edge.x += edge.dx_dy;
            }
            restore_active_edges_sorted(&mut active_edges);
        }

        flush_up_to!(current_physical_y + 1);

        let rows_emitted = last_emitted_py + 1;
        if rows_emitted < height {
            emit_zero_rows(&mut rle, height - rows_emitted, wwidth);
        }

        stats.total_solid_pixels /= aa_steps as u32;
        let runs = rle.finish();

        if stats.total_solid_pixels > 0 {
            stats.min_x = min_x;
            stats.min_y = min_y;
            stats.max_x = max_x;
            stats.max_y = max_y;

            if compute_area_stats {
                let (total_pixels, largest_area_mm2, smallest_area_mm2, area_count) =
                    aa_component_tracker
                        .take()
                        .map(|tracker| tracker.finalize(pixel_area_mm2))
                        .unwrap_or((0, 0.0, 0.0, 0));

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

        return (runs, stats);
    }

    // Binary single-Z streaming path, window-clamped.
    let z_mm = (layer_index as f32 + 0.5) * job.layer_height_mm;
    let segments = build_segments_for_layer(job, triangles, layer_indices, z_mm);
    if segments.is_empty() {
        emit_zero_rows(&mut rle, height, wwidth);
        return (rle.finish(), stats);
    }

    let Some(scanline_index) = build_scanline_segment_index(&segments, height, 1, 0.5) else {
        emit_zero_rows(&mut rle, height, wwidth);
        return (rle.finish(), stats);
    };
    let scanline_starts = scanline_index.starts;
    let scanline_row_offsets = scanline_index.row_offsets;
    let y_start = scanline_index.y_start;
    let y_end_exclusive = scanline_index.y_end_exclusive;
    let first_physical_y = y_start;
    emit_zero_rows(&mut rle, first_physical_y, wwidth);

    let mut active_edges: Vec<ActiveEdge> = Vec::with_capacity(segments.len().min(256));
    let mut merge_scratch: Vec<ActiveEdge> = Vec::with_capacity(segments.len().min(256));

    let mut current_spans: Vec<RowSpan> = Vec::new();
    let mut current_physical_y = first_physical_y;
    #[allow(unused_assignments)]
    let mut last_emitted_py = first_physical_y.wrapping_sub(1);

    macro_rules! flush_up_to {
        ($next_py:expr) => {{
            emit_binary_row_spans(&mut rle, &current_spans, wstart, wwidth);
            // The block path has no previous-row coherence dependency. Release
            // these spans before building the next row, with no scratch buffer.
            current_spans = Vec::new();
            last_emitted_py = current_physical_y;

            let next = $next_py;
            let gap = next.saturating_sub(last_emitted_py + 1);
            if gap > 0 {
                emit_zero_rows(&mut rle, gap, wwidth);
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

        let spans = build_row_spans_nonzero_ctx(&active_edges, full_width, true, None);

        for span in spans.iter().copied() {
            let s = span.start.max(wstart);
            let e = span.end.min(wend - 1);
            if s > e {
                continue;
            }
            let filled = (e - s + 1) as u32;
            stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(filled);
            min_x = min_x.min(s as i32);
            max_x = max_x.max(e as i32);
            min_y = min_y.min(physical_y as i32);
            max_y = max_y.max(physical_y as i32);
        }
        current_spans = spans;

        for edge in &mut active_edges {
            edge.x += edge.dx_dy;
        }
        restore_active_edges_sorted(&mut active_edges);
    }

    flush_up_to!(current_physical_y + 1);

    let rows_emitted = last_emitted_py + 1;
    if rows_emitted < height {
        emit_zero_rows(&mut rle, height - rows_emitted, wwidth);
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
                    wwidth,
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

    let runs = out_rle.finish();
    runs
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
    blur_gray_rle_streaming_with_bounds(runs, width, height, radius, min_alpha_u8).0
}

pub fn blur_gray_rle_streaming_with_bounds(
    runs: &[crate::rle::RleRun],
    width: usize,
    height: usize,
    radius: usize,
    min_alpha_u8: u8,
) -> (
    Vec<crate::rle::RleRun>,
    Option<(usize, usize, usize, usize)>,
) {
    blur_gray_rle_streaming_with_bounds_and_backend(
        runs, width, height, radius, min_alpha_u8, Backend::detected(),
    )
}

fn blur_gray_rle_streaming_with_bounds_and_backend(
    runs: &[crate::rle::RleRun],
    width: usize,
    height: usize,
    radius: usize,
    min_alpha_u8: u8,
    backend: Backend,
) -> (
    Vec<crate::rle::RleRun>,
    Option<(usize, usize, usize, usize)>,
) {
    backend.dispatch(BoxRleBlur { runs, width, height, radius, min_alpha_u8 })
}

struct BoxRleBlur<'a> {
    runs: &'a [crate::rle::RleRun],
    width: usize,
    height: usize,
    radius: usize,
    min_alpha_u8: u8,
}

impl pulp::WithSimd for BoxRleBlur<'_> {
    type Output = (Vec<crate::rle::RleRun>, Option<(usize, usize, usize, usize)>);

    #[inline(always)]
    fn with_simd<S: pulp::Simd>(self, simd: S) -> Self::Output {
        // Select once: native safe-radius rows use independent SIMD columns;
        // scalar and oversized rows retain fused full-u32 horizontal additions.
        if pulp_simd::u32_lanes::<S>() == 1 || self.radius > 127 {
            box_rle_blur_with_simd::<S, true>(self, simd)
        } else {
            box_rle_blur_with_simd::<S, false>(self, simd)
        }
    }
}

#[inline(always)]
fn box_rle_blur_with_simd<S: pulp::Simd, const ADD_COLUMNS: bool>(
    operation: BoxRleBlur<'_>, simd: S,
) -> (Vec<crate::rle::RleRun>, Option<(usize, usize, usize, usize)>) {
    let BoxRleBlur { runs, width, height, radius, min_alpha_u8 } = operation;
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    if width == 0 || height == 0 {
        return (runs.to_vec(), None);
    }

    if radius == 0 {
        return (
            runs.to_vec(),
            compute_nonzero_bounds_from_rle(runs, width, height),
        );
    }

    let Some((min_x, max_x, min_y, max_y)) = compute_nonzero_bounds_from_rle(runs, width, height)
    else {
        // All-zero image: blur of zero is zero.
        let mut out = RleAccum::new();
        emit_zero_rows(&mut out, height, width);
        return (out.finish(), None);
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
    let mut out_bounds: Option<(usize, usize, usize, usize)> = None;

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
    let mut denominators = BoxNormalizeDenominators::new(&h_denom);

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

            let ring_row = &mut ring[slot_start..slot_start + roi_w];
            box_horizontal_row::<ADD_COLUMNS>(&decode_buf, radius, ring_row, &mut col_sums);
            if !ADD_COLUMNS { box_update_columns::<S, false>(simd, &mut col_sums, ring_row); }
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

            let all_zero = box_normalize_row(simd, &col_sums, &mut denominators, v_denom_val, min_alpha_u8, &mut emit_buf);

            if all_zero {
                emit_zero_rows(&mut out_rle, 1, width);
            } else {
                let row_min_x = roi_min_x
                    + emit_buf
                        .iter()
                        .position(|&value| value != 0)
                        .expect("nonzero blur row should have a first nonzero pixel");
                let row_max_x = roi_min_x
                    + emit_buf
                        .iter()
                        .rposition(|&value| value != 0)
                        .expect("nonzero blur row should have a last nonzero pixel");
                if let Some((min_x, max_x, min_y, max_y)) = out_bounds.as_mut() {
                    *min_x = (*min_x).min(row_min_x);
                    *max_x = (*max_x).max(row_max_x);
                    *min_y = (*min_y).min(global_out_y);
                    *max_y = (*max_y).max(global_out_y);
                } else {
                    out_bounds = Some((row_min_x, row_max_x, global_out_y, global_out_y));
                }

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
                let row = &ring[evict_start..evict_start + roi_w];
                box_update_columns::<S, true>(simd, &mut col_sums, row);
                ring_head = (ring_head + 1) % ring_cap;
                ring_len -= 1;
            }
        }
    }

    emit_zero_rows(&mut out_rle, height - 1 - roi_max_y, width);

    let runs = out_rle.finish();
    (runs, out_bounds)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupportHaloProfile {
    Donut,
    Linear,
    Exponential,
    Gaussian,
}

impl SupportHaloProfile {
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "linear" | "lin" => Self::Linear,
            "exponential" | "exp" => Self::Exponential,
            "gaussian" | "gauss" => Self::Gaussian,
            "donut" | "annular" | "moat" | _ => Self::Donut,
        }
    }
}

pub const NUM_HALO_DIAMETER_BUCKETS: usize = 16;
const HALO_BUCKET_NONE: u8 = 0xFF;

pub const BAYER_8X8: [[u8; 8]; 8] = [
    [ 0, 32,  8, 40,  2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

pub fn build_inverse_gamma_lut(gamma: f32) -> [u8; 256] {
    let g = gamma.clamp(1.0, 5.0);
    let mut lut = [0u8; 256];
    if (g - 1.0).abs() < 1e-4 {
        for (i, v) in lut.iter_mut().enumerate() {
            *v = i as u8;
        }
        return lut;
    }
    let inv_gamma = 1.0 / g;
    for e in 1..256 {
        let linear_e = (e as f32) / 255.0;
        lut[e] = (linear_e.powf(inv_gamma) * 255.0).round().clamp(1.0, 254.0) as u8;
    }
    lut[255] = 255;
    lut
}

pub fn build_halo_dither_lut(
    palette: &crate::dither::DitherPaletteV3,
    gamma: f32,
) -> Box<[[[u8; 8]; 256]; 8]> {
    let mut lut = Box::new([[[0u8; 8]; 256]; 8]);
    let g = gamma.clamp(1.0, 5.0);
    let levels = palette.target_bytes.len();
    if levels < 2 {
        return lut;
    }
    for py in 0..8usize {
        for px in 0..8usize {
            lut[py][0][px] = 0;
            lut[py][255][px] = 255;
            let thresh = (BAYER_8X8[py][px] as f32 + 0.5) / 64.0;
            for v in 1..255usize {
                let e = ((v as f32) / 255.0).powf(g);
                let mut k = 0usize;
                while k + 1 < levels - 1 && palette.target_energy[k + 1] < e {
                    k += 1;
                }
                let e_lo = palette.target_energy[k];
                let e_hi = palette.target_energy[k + 1];
                let frac = if e_hi > e_lo {
                    ((e - e_lo) / (e_hi - e_lo)).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                lut[py][v][px] = if frac > thresh {
                    palette.target_bytes[k + 1]
                } else {
                    palette.target_bytes[k]
                };
            }
        }
    }
    lut
}

pub fn evaluate_tip_diameter_halo_scales(d_mm: f32, d_max_mm: f32) -> (f32, f32) {
    let d_max = d_max_mm.max(0.45);
    if !d_mm.is_finite() || d_mm >= d_max {
        return (0.0, 0.0);
    }
    let d = d_mm.max(0.0);
    let d_min = 0.20f32;
    let d_ref = 0.40f32;

    let s_r = if d <= d_min {
        4.0 / 3.0
    } else if d <= d_ref {
        let t = ((d - d_min) / (d_ref - d_min)).clamp(0.0, 1.0);
        (4.0 / 3.0) - (1.0 / 3.0) * t
    } else {
        let u = ((d - d_ref) / (d_max - d_ref)).clamp(0.0, 1.0);
        (1.0 / 3.0) + (2.0 / 3.0) * (1.0 - u) * (1.0 - u)
    };

    let s_e = if d <= d_min {
        1.00
    } else if d <= d_ref {
        let t = ((d - d_min) / (d_ref - d_min)).clamp(0.0, 1.0);
        1.00 - 0.15 * t
    } else {
        let u = ((d - d_ref) / (d_max - d_ref)).clamp(0.0, 1.0);
        let c = (core::f32::consts::FRAC_PI_2 * u).cos();
        0.85 * c * c
    };

    (s_r, s_e)
}

pub fn evaluate_tip_diameter_halo_scales_with_inverse_pct(
    d_mm: f32,
    d_max_mm: f32,
    inverse_scale_pct: f32,
) -> (f32, f32) {
    let d_max = d_max_mm.max(0.10);
    if d_mm >= d_max {
        return (0.0, 0.0);
    }
    let (sr_dyn, se_dyn) = evaluate_tip_diameter_halo_scales(d_mm, d_max_mm);
    let k = if inverse_scale_pct.is_finite() {
        (inverse_scale_pct / 100.0).clamp(0.0, 2.0)
    } else {
        1.0
    };
    let s_r = (1.0 + k * (sr_dyn - 1.0)).clamp(0.0, 2.5);
    let s_e = (1.0 + k * (se_dyn - 1.0)).clamp(0.0, 1.5);
    (s_r, s_e)
}

const CORE_SUPPORT_WORD: u16 = 0xFFFF;

#[inline]
fn compute_halo_proximity_rank(r_mm: f32, target_radius_mm: f32) -> u8 {
    if r_mm <= 0.0 {
        return 255;
    }
    let u_rad = (r_mm / target_radius_mm.max(1e-5)).clamp(0.0, 1.0);
    (254.0 - 253.0 * u_rad).round().clamp(1.0, 254.0) as u8
}

#[inline]
fn pack_halo_word(prox: u8, pwm_u8: u8) -> u16 {
    if pwm_u8 == 0 || prox == 0 {
        0
    } else {
        ((prox as u16) << 8) | (pwm_u8 as u16)
    }
}

#[derive(Clone)]
struct SupportHaloRowKernel {
    dy: isize,
    interior_word: u16,
    caps: Vec<(usize, u16)>,
}

#[derive(Clone, Default)]
struct SupportHaloBucketKernel {
    row_kernels: Vec<SupportHaloRowKernel>,
}

#[derive(Clone)]
pub struct SupportHaloPrecalc {
    pub pitch_x_mm: f32,
    pub pitch_y_mm: f32,
    pub ref_radius_mm: f32,
    pub max_tip_diameter_mm: f32,
    pub tips_only: bool,
    pub max_rx_px: usize,
    pub max_ry_px: usize,
    pub max_tip_dx_px: usize,
    pub max_tip_dy_px: usize,
    buckets: [SupportHaloBucketKernel; NUM_HALO_DIAMETER_BUCKETS],
    dither_lut: Option<Box<[[[u8; 8]; 256]; 8]>>,
}

#[inline]
fn eval_halo_intensity_anisotropic(
    dx: usize,
    dy: usize,
    pitch_x_mm: f32,
    pitch_y_mm: f32,
    target_radius_mm: f32,
    max_intensity_u8: u8,
    energy_scale: f32,
    profile: SupportHaloProfile,
    inv_gamma_lut: &[u8; 256],
) -> u8 {
    if dx == 0 && dy == 0 {
        return 255;
    }
    if target_radius_mm <= 0.0 || max_intensity_u8 == 0 || energy_scale <= 0.0 {
        return 0;
    }
    let rx_mm = (dx as f32) * pitch_x_mm;
    let ry_mm = (dy as f32) * pitch_y_mm;
    let r_mm = rx_mm.hypot(ry_mm);
    if r_mm > target_radius_mm + 1e-5 {
        return 0;
    }

    let p_min = pitch_x_mm.min(pitch_y_mm).max(1e-4);
    let p_max = pitch_x_mm.max(pitch_y_mm).max(1e-4);
    let cos_t = rx_mm / r_mm.max(1e-6);
    let sin_t = ry_mm / r_mm.max(1e-6);
    let p_theta = (pitch_x_mm * cos_t).hypot(pitch_y_mm * sin_t);
    let eta_pack = (p_theta / p_max).clamp(0.1, 1.0);

    let d_equiv = r_mm / p_min;
    let r_equiv = (target_radius_mm / p_min).max(1.0);

    match profile {
        SupportHaloProfile::Donut => {
            let f_donut = if r_equiv <= 1.5 {
                1.0
            } else {
                let denom = (target_radius_mm - 0.5 * p_min).max(p_min);
                let u = ((r_mm - p_min).max(0.0) / denom).clamp(0.0, 1.0);
                let u_peak = 2.0 / 5.5;
                if u <= 0.0 {
                    0.25
                } else if u <= u_peak {
                    let s = (core::f32::consts::FRAC_PI_2 * (u / u_peak)).sin();
                    0.25 + 0.75 * s * s
                } else {
                    let c =
                        (core::f32::consts::FRAC_PI_2 * ((u - u_peak) / (1.0 - u_peak))).cos();
                    c * c
                }
            };
            let e_idx = ((max_intensity_u8 as f32) * energy_scale * f_donut * eta_pack)
                .round()
                .clamp(0.0, 255.0) as usize;
            inv_gamma_lut[e_idx]
        }
        SupportHaloProfile::Linear => {
            let linear_t = ((r_equiv + 1.0 - d_equiv) / (r_equiv + 1.0)).clamp(0.0, 1.0);
            ((max_intensity_u8 as f32) * energy_scale * linear_t * eta_pack)
                .round()
                .clamp(0.0, 255.0) as u8
        }
        SupportHaloProfile::Exponential => {
            let linear_t = ((r_equiv + 1.0 - d_equiv) / (r_equiv + 1.0)).clamp(0.0, 1.0);
            let alpha = ((-1.5 * (d_equiv - 1.0) / r_equiv).exp() * linear_t).clamp(0.0, 1.0);
            ((max_intensity_u8 as f32) * energy_scale * alpha * eta_pack)
                .round()
                .clamp(0.0, 255.0) as u8
        }
        SupportHaloProfile::Gaussian => {
            let sigma = (0.5 * r_equiv).max(0.5);
            let alpha = (-(d_equiv * d_equiv) / (2.0 * sigma * sigma))
                .exp()
                .clamp(0.0, 1.0);
            ((max_intensity_u8 as f32) * energy_scale * alpha * eta_pack)
                .round()
                .clamp(0.0, 255.0) as u8
        }
    }
}

fn build_anisotropic_halo_row_kernels(
    pitch_x_mm: f32,
    pitch_y_mm: f32,
    target_radius_mm: f32,
    max_intensity_u8: u8,
    energy_scale: f32,
    profile: SupportHaloProfile,
    inv_gamma_lut: &[u8; 256],
) -> (Vec<SupportHaloRowKernel>, usize, usize) {
    if target_radius_mm <= 0.0 || max_intensity_u8 == 0 || energy_scale <= 0.0 {
        return (Vec::new(), 0, 0);
    }
    let rx_max = ((target_radius_mm / pitch_x_mm.max(1e-4)).ceil() as usize).clamp(1, 48);
    let ry_max = ((target_radius_mm / pitch_y_mm.max(1e-4)).ceil() as usize).clamp(1, 48);
    let r_y_isize = ry_max as isize;
    let mut kernels = Vec::with_capacity(2 * ry_max + 1);
    let mut actual_max_rx = 0usize;
    let mut actual_max_ry = 0usize;

    for dy in -r_y_isize..=r_y_isize {
        let dy_abs = dy.unsigned_abs();
        let interior_word = if dy == 0 {
            CORE_SUPPORT_WORD
        } else {
            let val = eval_halo_intensity_anisotropic(
                0,
                dy_abs,
                pitch_x_mm,
                pitch_y_mm,
                target_radius_mm,
                max_intensity_u8,
                energy_scale,
                profile,
                inv_gamma_lut,
            );
            let r_mm = (dy_abs as f32) * pitch_y_mm;
            let prox = compute_halo_proximity_rank(r_mm, target_radius_mm);
            pack_halo_word(prox, val)
        };
        if dy_abs > 0 && interior_word > 0 {
            actual_max_ry = actual_max_ry.max(dy_abs);
        }
        let mut caps = Vec::with_capacity(rx_max);
        for dx in 1..=rx_max {
            let val = eval_halo_intensity_anisotropic(
                dx,
                dy_abs,
                pitch_x_mm,
                pitch_y_mm,
                target_radius_mm,
                max_intensity_u8,
                energy_scale,
                profile,
                inv_gamma_lut,
            );
            if val > 0 {
                let r_mm = ((dx as f32) * pitch_x_mm).hypot((dy_abs as f32) * pitch_y_mm);
                let prox = compute_halo_proximity_rank(r_mm, target_radius_mm);
                let word = pack_halo_word(prox, val);
                if word > 0 {
                    caps.push((dx, word));
                    actual_max_rx = actual_max_rx.max(dx);
                    actual_max_ry = actual_max_ry.max(dy_abs);
                }
            }
        }
        if interior_word > 0 || !caps.is_empty() {
            kernels.push(SupportHaloRowKernel {
                dy,
                interior_word,
                caps,
            });
        }
    }

    (kernels, actual_max_rx, actual_max_ry)
}

impl SupportHaloPrecalc {
    pub fn from_job(
        job: &crate::types::SliceJobV3,
        dither_palette: Option<&crate::dither::DitherPaletteV3>,
    ) -> Option<Self> {
        if !job.support_halo_active() {
            return None;
        }
        let (pitch_x_mm, pitch_y_mm) = job.effective_output_pixel_pitch_mm();
        let ref_radius_mm = job.effective_support_halo_ref_radius_mm();
        let max_intensity_u8 = job.effective_support_halo_max_intensity_u8();
        if ref_radius_mm <= 0.0 || max_intensity_u8 == 0 {
            return None;
        }
        let profile = SupportHaloProfile::from_str_lossy(&job.support_halo_profile);
        let gamma = job.effective_support_halo_gamma();
        let inv_gamma_lut = build_inverse_gamma_lut(gamma);
        let tips_only = job.support_halo_is_tips_only();
        let max_tip_diameter_mm = job.effective_support_halo_max_tip_diameter_mm();
        let inverse_scale_pct = job.effective_support_halo_inverse_scale_percent();
        let (max_tip_dx_px, max_tip_dy_px) = job
            .effective_support_halo_max_tip_diameter_px_xy()
            .map(|(dx, dy)| (dx as usize, dy as usize))
            .unwrap_or((0, 0));

        let mut buckets: [SupportHaloBucketKernel; NUM_HALO_DIAMETER_BUCKETS] =
            std::array::from_fn(|_| SupportHaloBucketKernel::default());
        let mut max_rx_px = 0usize;
        let mut max_ry_px = 0usize;

        if tips_only {
            let step_mm = max_tip_diameter_mm / (NUM_HALO_DIAMETER_BUCKETS as f32);
            for b in 0..NUM_HALO_DIAMETER_BUCKETS {
                let d_rep_mm = if b + 1 < NUM_HALO_DIAMETER_BUCKETS {
                    ((b + 1) as f32) * step_mm
                } else {
                    ((b as f32) + 0.5) * step_mm
                };
                let (s_r, s_e) = evaluate_tip_diameter_halo_scales_with_inverse_pct(
                    d_rep_mm,
                    max_tip_diameter_mm,
                    inverse_scale_pct,
                );
                let target_r_mm = ref_radius_mm * s_r;
                let (row_kernels, rx, ry) = build_anisotropic_halo_row_kernels(
                    pitch_x_mm,
                    pitch_y_mm,
                    target_r_mm,
                    max_intensity_u8,
                    s_e,
                    profile,
                    &inv_gamma_lut,
                );
                max_rx_px = max_rx_px.max(rx);
                max_ry_px = max_ry_px.max(ry);
                buckets[b] = SupportHaloBucketKernel { row_kernels };
            }
        } else {
            let (row_kernels, rx, ry) = build_anisotropic_halo_row_kernels(
                pitch_x_mm,
                pitch_y_mm,
                ref_radius_mm,
                max_intensity_u8,
                1.0,
                profile,
                &inv_gamma_lut,
            );
            max_rx_px = rx;
            max_ry_px = ry;
            buckets[0] = SupportHaloBucketKernel { row_kernels };
        }

        if max_rx_px == 0 && max_ry_px == 0 {
            return None;
        }

        let dither_lut = match dither_palette {
            Some(p) => Some(build_halo_dither_lut(p, gamma)),
            None => job.effective_dither_bit_depth().map(|bit_depth| {
                let lut = job.normalized_tail_cure_lut().unwrap_or_else(|| {
                    let mut identity_lut = [0u8; 256];
                    for i in 0..256 {
                        identity_lut[i] = i as u8;
                    }
                    identity_lut
                });
                let owned_palette =
                    crate::dither::DitherPaletteV3::new(&lut, gamma as f64, bit_depth);
                build_halo_dither_lut(&owned_palette, gamma)
            }),
        };

        Some(Self {
            pitch_x_mm,
            pitch_y_mm,
            ref_radius_mm,
            max_tip_diameter_mm,
            tips_only,
            max_rx_px,
            max_ry_px,
            max_tip_dx_px,
            max_tip_dy_px,
            buckets,
            dither_lut,
        })
    }
}

#[inline]
fn eval_halo_intensity(
    d: f32,
    r_f: f32,
    max_intensity_u8: u8,
    profile: SupportHaloProfile,
) -> u8 {
    if d <= 0.0 {
        return 255;
    }
    if d > r_f || max_intensity_u8 == 0 {
        return 0;
    }
    match profile {
        SupportHaloProfile::Donut => {
            let inv_gamma = build_inverse_gamma_lut(3.0);
            eval_halo_intensity_anisotropic(
                d.round().max(1.0) as usize,
                0,
                1.0,
                1.0,
                r_f,
                max_intensity_u8,
                1.0,
                SupportHaloProfile::Donut,
                &inv_gamma,
            )
        }
        SupportHaloProfile::Linear => {
            let linear_t = ((r_f + 1.0 - d) / (r_f + 1.0)).clamp(0.0, 1.0);
            ((max_intensity_u8 as f32) * linear_t).round().clamp(0.0, 255.0) as u8
        }
        SupportHaloProfile::Exponential => {
            let linear_t = ((r_f + 1.0 - d) / (r_f + 1.0)).clamp(0.0, 1.0);
            let alpha = ((-1.5 * (d - 1.0) / r_f.max(1.0)).exp() * linear_t).clamp(0.0, 1.0);
            ((max_intensity_u8 as f32) * alpha).round().clamp(0.0, 255.0) as u8
        }
        SupportHaloProfile::Gaussian => {
            let sigma = (0.5 * r_f).max(0.5);
            let alpha = (-(d * d) / (2.0 * sigma * sigma)).exp().clamp(0.0, 1.0);
            ((max_intensity_u8 as f32) * alpha).round().clamp(0.0, 255.0) as u8
        }
    }
}

fn build_euclidean_halo_row_kernels(
    radius_px: u32,
    max_intensity_u8: u8,
    profile: SupportHaloProfile,
) -> Vec<SupportHaloRowKernel> {
    let r = radius_px.clamp(1, 16) as isize;
    let r_f = r as f32;
    let r_sq = r * r;
    let mut kernels = Vec::with_capacity((2 * r + 1) as usize);

    for dy in -r..=r {
        let dy_abs = dy.unsigned_abs() as f32;
        let interior_word = if dy == 0 {
            CORE_SUPPORT_WORD
        } else {
            let val = eval_halo_intensity(dy_abs, r_f, max_intensity_u8, profile);
            let prox = compute_halo_proximity_rank(dy_abs, r_f);
            pack_halo_word(prox, val)
        };
        let mut caps = Vec::with_capacity(r as usize);
        for dx in 1..=r {
            let d_sq = dx * dx + dy * dy;
            if d_sq <= r_sq {
                let d = (d_sq as f32).sqrt();
                let val = eval_halo_intensity(d, r_f, max_intensity_u8, profile);
                if val > 0 {
                    let prox = compute_halo_proximity_rank(d, r_f);
                    let word = pack_halo_word(prox, val);
                    if word > 0 {
                        caps.push((dx as usize, word));
                    }
                }
            }
        }
        kernels.push(SupportHaloRowKernel {
            dy,
            interior_word,
            caps,
        });
    }

    kernels
}

#[derive(Clone, Copy, Debug)]
struct SupportRowSpan {
    y: usize,
    x_start: usize,
    x_end: usize,
    emit_halo: bool,
    bucket_idx: u8,
}

fn find_root_span(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        let gp = parent[parent[i]];
        parent[i] = gp;
        i = gp;
    }
    i
}

/// Evaluates 2D Thin Cross-Section Gating (`tips_only`) over horizontal support spans.
fn gate_thin_support_spans(spans: &mut [SupportRowSpan], max_d_px: u32) {
    let n = spans.len();
    if n == 0 {
        return;
    }
    let max_d = max_d_px.max(1) as usize;
    let inf_dist = u32::MAX / 2;

    let mut parent: Vec<usize> = (0..n).collect();
    let mut dist_to_wide: Vec<u32> = spans
        .iter()
        .map(|s| {
            if s.x_end - s.x_start > max_d {
                0
            } else {
                inf_dist
            }
        })
        .collect();

    let mut rows: Vec<(usize, usize, usize)> = Vec::new();
    let mut r_start = 0usize;
    for i in 1..=n {
        if i == n || spans[i].y != spans[r_start].y {
            rows.push((spans[r_start].y, r_start, i));
            r_start = i;
        }
    }

    for r_idx in 1..rows.len() {
        let (prev_y, p0, p1) = rows[r_idx - 1];
        let (curr_y, c0, c1) = rows[r_idx];
        if prev_y + 1 != curr_y {
            continue;
        }
        let mut p = p0;
        for c in c0..c1 {
            let cx0 = spans[c].x_start;
            let cx1 = spans[c].x_end;
            while p < p1 && spans[p].x_end < cx0 {
                p += 1;
            }
            let mut scan_p = p;
            while scan_p < p1 && spans[scan_p].x_start <= cx1 {
                let ra = find_root_span(&mut parent, scan_p);
                let rb = find_root_span(&mut parent, c);
                if ra != rb {
                    if ra < rb {
                        parent[rb] = ra;
                    } else {
                        parent[ra] = rb;
                    }
                }
                let cand = dist_to_wide[scan_p].saturating_add(1);
                if cand < dist_to_wide[c] {
                    dist_to_wide[c] = cand;
                }
                scan_p += 1;
            }
        }
    }

    for r_idx in (0..rows.len().saturating_sub(1)).rev() {
        let (curr_y, c0, c1) = rows[r_idx];
        let (next_y, n0, n1) = rows[r_idx + 1];
        if curr_y + 1 != next_y {
            continue;
        }
        let mut nx = n0;
        for c in c0..c1 {
            let cx0 = spans[c].x_start;
            let cx1 = spans[c].x_end;
            while nx < n1 && spans[nx].x_end < cx0 {
                nx += 1;
            }
            let mut scan_n = nx;
            while scan_n < n1 && spans[scan_n].x_start <= cx1 {
                let cand = dist_to_wide[scan_n].saturating_add(1);
                if cand < dist_to_wide[c] {
                    dist_to_wide[c] = cand;
                }
                scan_n += 1;
            }
        }
    }

    let mut comp_min_x = vec![usize::MAX; n];
    let mut comp_max_x = vec![0usize; n];
    let mut comp_min_y = vec![usize::MAX; n];
    let mut comp_max_y = vec![0usize; n];

    for i in 0..n {
        let r = find_root_span(&mut parent, i);
        let s = &spans[i];
        comp_min_x[r] = comp_min_x[r].min(s.x_start);
        comp_max_x[r] = comp_max_x[r].max(s.x_end - 1);
        comp_min_y[r] = comp_min_y[r].min(s.y);
        comp_max_y[r] = comp_max_y[r].max(s.y);
    }

    let cap_look_rows = ((max_d / 2) + 2) as u32;
    for i in 0..n {
        let r = parent[i];
        let comp_w = comp_max_x[r] - comp_min_x[r] + 1;
        let comp_h = comp_max_y[r] - comp_min_y[r] + 1;
        if comp_w <= max_d && comp_h <= max_d {
            spans[i].emit_halo = true;
        } else {
            let span_w = spans[i].x_end - spans[i].x_start;
            spans[i].emit_halo = span_w <= max_d
                && dist_to_wide[i] > cap_look_rows
                && dist_to_wide[i] < inf_dist / 2;
        }
    }
}

#[derive(Default)]
struct HaloScratchBuffers {
    spans: Vec<SupportRowSpan>,
    parent: Vec<usize>,
    dist_to_wide: Vec<u32>,
    rows: Vec<(usize, usize, usize)>,
    comp_min_x: Vec<usize>,
    comp_max_x: Vec<usize>,
    comp_min_y: Vec<usize>,
    comp_max_y: Vec<usize>,
    comp_area_px: Vec<usize>,
    comp_bucket: Vec<u8>,
    comp_is_small: Vec<bool>,
    ring: Vec<u16>,
    row_bytes: Vec<u8>,
    slot_bounds: Vec<(usize, usize)>,
}

thread_local! {
    static HALO_SCRATCH: std::cell::RefCell<HaloScratchBuffers> =
        std::cell::RefCell::new(HaloScratchBuffers::default());
}

fn classify_support_spans_with_precalc_in_scratch(
    scratch: &mut HaloScratchBuffers,
    precalc: &SupportHaloPrecalc,
) {
    let n = scratch.spans.len();
    if n == 0 {
        return;
    }
    if !precalc.tips_only {
        for s in scratch.spans.iter_mut() {
            s.emit_halo = true;
            s.bucket_idx = 0;
        }
        return;
    }

    let max_dx = precalc.max_tip_dx_px.max(1);
    let max_dy = precalc.max_tip_dy_px.max(1);
    let d_max_mm = precalc.max_tip_diameter_mm;
    let step_mm = (d_max_mm / (NUM_HALO_DIAMETER_BUCKETS as f32)).max(1e-4);
    let inf_dist = u32::MAX / 2;

    scratch.parent.clear();
    scratch.parent.extend(0..n);

    scratch.dist_to_wide.clear();
    scratch.dist_to_wide.reserve(n);
    let mut any_wide_span = false;
    for s in &scratch.spans {
        let span_w = s.x_end - s.x_start;
        let span_w_mm = (span_w as f32) * precalc.pitch_x_mm;
        if span_w > max_dx || span_w_mm >= d_max_mm - 1e-5 {
            scratch.dist_to_wide.push(0);
            any_wide_span = true;
        } else {
            scratch.dist_to_wide.push(inf_dist);
        }
    }

    scratch.rows.clear();
    let mut r_start = 0usize;
    for i in 1..=n {
        if i == n || scratch.spans[i].y != scratch.spans[r_start].y {
            scratch.rows.push((scratch.spans[r_start].y, r_start, i));
            r_start = i;
        }
    }

    let rows_len = scratch.rows.len();
    for r_idx in 1..rows_len {
        let (prev_y, p0, p1) = scratch.rows[r_idx - 1];
        let (curr_y, c0, c1) = scratch.rows[r_idx];
        if prev_y + 1 != curr_y {
            continue;
        }
        let mut p = p0;
        for c in c0..c1 {
            let cx0 = scratch.spans[c].x_start;
            let cx1 = scratch.spans[c].x_end;
            while p < p1 && scratch.spans[p].x_end < cx0 {
                p += 1;
            }
            let mut scan_p = p;
            while scan_p < p1 && scratch.spans[scan_p].x_start <= cx1 {
                let ra = find_root_span(&mut scratch.parent, scan_p);
                let rb = find_root_span(&mut scratch.parent, c);
                if ra != rb {
                    if ra < rb {
                        scratch.parent[rb] = ra;
                    } else {
                        scratch.parent[ra] = rb;
                    }
                }
                if any_wide_span {
                    let cand = scratch.dist_to_wide[scan_p].saturating_add(1);
                    if cand < scratch.dist_to_wide[c] {
                        scratch.dist_to_wide[c] = cand;
                    }
                }
                scan_p += 1;
            }
        }
    }

    if any_wide_span {
        for r_idx in (0..rows_len.saturating_sub(1)).rev() {
            let (curr_y, c0, c1) = scratch.rows[r_idx];
            let (next_y, n0, n1) = scratch.rows[r_idx + 1];
            if curr_y + 1 != next_y {
                continue;
            }
            let mut nx = n0;
            for c in c0..c1 {
                let cx0 = scratch.spans[c].x_start;
                let cx1 = scratch.spans[c].x_end;
                while nx < n1 && scratch.spans[nx].x_end < cx0 {
                    nx += 1;
                }
                let mut scan_n = nx;
                while scan_n < n1 && scratch.spans[scan_n].x_start <= cx1 {
                    let cand = scratch.dist_to_wide[scan_n].saturating_add(1);
                    if cand < scratch.dist_to_wide[c] {
                        scratch.dist_to_wide[c] = cand;
                    }
                    scan_n += 1;
                }
            }
        }
    }

    scratch.comp_min_x.clear();
    scratch.comp_min_x.resize(n, usize::MAX);
    scratch.comp_max_x.clear();
    scratch.comp_max_x.resize(n, 0);
    scratch.comp_min_y.clear();
    scratch.comp_min_y.resize(n, usize::MAX);
    scratch.comp_max_y.clear();
    scratch.comp_max_y.resize(n, 0);
    scratch.comp_area_px.clear();
    scratch.comp_area_px.resize(n, 0);

    for i in 0..n {
        let r = find_root_span(&mut scratch.parent, i);
        let s = &scratch.spans[i];
        scratch.comp_min_x[r] = scratch.comp_min_x[r].min(s.x_start);
        scratch.comp_max_x[r] = scratch.comp_max_x[r].max(s.x_end - 1);
        scratch.comp_min_y[r] = scratch.comp_min_y[r].min(s.y);
        scratch.comp_max_y[r] = scratch.comp_max_y[r].max(s.y);
        scratch.comp_area_px[r] += s.x_end - s.x_start;
    }

    let cap_look_rows = ((max_dy / 2) + 2) as u32;
    let map_d_to_bucket = |d_mm: f32| -> u8 {
        if d_mm >= d_max_mm - 1e-5 {
            HALO_BUCKET_NONE
        } else {
            (((d_mm / step_mm).round() as usize).saturating_sub(1))
                .min(NUM_HALO_DIAMETER_BUCKETS - 1) as u8
        }
    };

    scratch.comp_bucket.clear();
    scratch.comp_bucket.resize(n, HALO_BUCKET_NONE);
    scratch.comp_is_small.clear();
    scratch.comp_is_small.resize(n, false);

    let area_to_mm2_factor = 4.0 * precalc.pitch_x_mm * precalc.pitch_y_mm / core::f32::consts::PI;
    for r in 0..n {
        if scratch.parent[r] != r || scratch.comp_area_px[r] == 0 {
            continue;
        }
        let comp_w = scratch.comp_max_x[r] - scratch.comp_min_x[r] + 1;
        let comp_h = scratch.comp_max_y[r] - scratch.comp_min_y[r] + 1;
        let comp_w_mm = (comp_w as f32) * precalc.pitch_x_mm;
        let comp_h_mm = (comp_h as f32) * precalc.pitch_y_mm;
        if comp_w_mm <= 1.5 * d_max_mm && comp_h_mm <= 1.5 * d_max_mm {
            let comp_d_blob_mm = ((scratch.comp_area_px[r] as f32) * area_to_mm2_factor)
                .sqrt()
                .min(comp_w_mm.max(comp_h_mm));
            if comp_d_blob_mm < d_max_mm - 1e-5 {
                scratch.comp_is_small[r] = true;
                scratch.comp_bucket[r] = map_d_to_bucket(comp_d_blob_mm);
            }
        }
    }

    for i in 0..n {
        let r = scratch.parent[i];
        if scratch.comp_is_small[r] {
            let b = scratch.comp_bucket[r];
            scratch.spans[i].bucket_idx = b;
            scratch.spans[i].emit_halo = b != HALO_BUCKET_NONE;
        } else if any_wide_span {
            let span_w = scratch.spans[i].x_end - scratch.spans[i].x_start;
            let span_d_mm = (span_w as f32) * precalc.pitch_x_mm;
            if span_w <= max_dx
                && span_d_mm < d_max_mm - 1e-5
                && scratch.dist_to_wide[i] > cap_look_rows
                && scratch.dist_to_wide[i] < inf_dist / 2
            {
                let b = map_d_to_bucket(span_d_mm);
                scratch.spans[i].bucket_idx = b;
                scratch.spans[i].emit_halo = b != HALO_BUCKET_NONE;
            } else {
                scratch.spans[i].bucket_idx = HALO_BUCKET_NONE;
                scratch.spans[i].emit_halo = false;
            }
        } else {
            scratch.spans[i].bucket_idx = HALO_BUCKET_NONE;
            scratch.spans[i].emit_halo = false;
        }
    }
}

pub fn apply_euclidean_radial_halo_rle_with_precalc(
    support_runs: &[crate::rle::RleRun],
    width: usize,
    height: usize,
    precalc: &SupportHaloPrecalc,
) -> Vec<crate::rle::RleRun> {
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    let rx_pad = precalc.max_rx_px;
    let ry_pad = precalc.max_ry_px;
    if width == 0
        || height == 0
        || (rx_pad == 0 && ry_pad == 0)
        || support_runs.is_empty()
    {
        return support_runs.to_vec();
    }

    HALO_SCRATCH.with(|cell| {
        let mut scratch = cell.borrow_mut();
        scratch.spans.clear();

        let total_pixels = width * height;
        let mut abs_pos = 0usize;
        let mut min_x = width;
        let mut max_x = 0usize;
        let mut min_y = height;
        let mut max_y = 0usize;

        for run in support_runs {
            let len = run.length as usize;
            if len == 0 {
                continue;
            }
            if run.value == 0 {
                abs_pos = abs_pos.saturating_add(len);
                continue;
            }

            let mut rem = len;
            while rem > 0 && abs_pos < total_pixels {
                let in_y = abs_pos / width;
                let x_start = abs_pos % width;
                let take = rem.min(width - x_start);
                let x_end = x_start + take;

                min_x = min_x.min(x_start);
                max_x = max_x.max(x_end - 1);
                min_y = min_y.min(in_y);
                max_y = max_y.max(in_y);

                if let Some(last) = scratch.spans.last_mut() {
                    if last.y == in_y && last.x_end == x_start {
                        last.x_end = x_end;
                    } else {
                        scratch.spans.push(SupportRowSpan {
                            y: in_y,
                            x_start,
                            x_end,
                            emit_halo: true,
                            bucket_idx: 0,
                        });
                    }
                } else {
                    scratch.spans.push(SupportRowSpan {
                        y: in_y,
                        x_start,
                        x_end,
                        emit_halo: true,
                        bucket_idx: 0,
                    });
                }

                abs_pos += take;
                rem -= take;
            }
        }

        if scratch.spans.is_empty() {
            return support_runs.to_vec();
        }

        classify_support_spans_with_precalc_in_scratch(&mut scratch, precalc);

        let roi_min_x = min_x.saturating_sub(rx_pad);
        let roi_max_x = (max_x + rx_pad).min(width - 1);
        let roi_min_y = min_y.saturating_sub(ry_pad);
        let roi_max_y = (max_y + ry_pad).min(height - 1);
        let roi_w = roi_max_x - roi_min_x + 1;

        let ring_cap = 2 * ry_pad + 1;
        let ring_len = ring_cap * roi_w;
        if scratch.ring.len() < ring_len {
            scratch.ring.resize(ring_len, 0);
        }
        if scratch.row_bytes.len() < roi_w {
            scratch.row_bytes.resize(roi_w, 0);
        }
        scratch.slot_bounds.clear();
        scratch.slot_bounds.resize(ring_cap, (usize::MAX, 0));

        let HaloScratchBuffers {
            ref spans,
            ref mut ring,
            ref mut row_bytes,
            ref mut slot_bounds,
            ..
        } = *scratch;

        let mut out_rle = RleAccum::new();
        emit_zero_rows(&mut out_rle, roi_min_y, width);

        let flush_ring_row = |target_y: usize,
                              ring: &mut [u16],
                              row_bytes: &mut [u8],
                              slot_bounds: &mut [(usize, usize)],
                              out_rle: &mut RleAccum| {
            let slot = (target_y - roi_min_y) % ring_cap;
            let (b_min, b_max) = slot_bounds[slot];
            if b_min > b_max {
                emit_zero_rows(out_rle, 1, width);
            } else {
                let slot_offset = slot * roi_w;
                let active_len = b_max - b_min + 1;
                let active_ring = &mut ring[slot_offset + b_min..=slot_offset + b_max];
                let active_bytes = &mut row_bytes[..active_len];
                if let Some(ref dither_lut) = precalc.dither_lut {
                    let lut_row = &dither_lut[target_y & 7];
                    let base_x = roi_min_x + b_min;
                    for (offset, &word) in active_ring.iter().enumerate() {
                        let v = (word & 0xFF) as u8;
                        active_bytes[offset] = if v > 0 && v < 255 {
                            lut_row[v as usize][(base_x + offset) & 7]
                        } else {
                            v
                        };
                    }
                } else {
                    for (offset, &word) in active_ring.iter().enumerate() {
                        active_bytes[offset] = (word & 0xFF) as u8;
                    }
                }
                let left_zeros = roi_min_x + b_min;
                if left_zeros > 0 {
                    out_rle.push_run(left_zeros as u32, 0);
                }
                emit_row(out_rle, active_bytes);
                let row_right_zeros = width - 1 - (roi_min_x + b_max);
                if row_right_zeros > 0 {
                    out_rle.push_run(row_right_zeros as u32, 0);
                }
                active_ring.fill(0);
                slot_bounds[slot] = (usize::MAX, 0);
            }
        };

        let mut next_unflushed_y = roi_min_y;

        for span in spans {
            let in_y = span.y;
            let x_start = span.x_start;
            let x_end = span.x_end;

            while next_unflushed_y + ry_pad < in_y && next_unflushed_y <= roi_max_y {
                flush_ring_row(
                    next_unflushed_y,
                    ring,
                    row_bytes,
                    slot_bounds,
                    &mut out_rle,
                );
                next_unflushed_y += 1;
            }

            let ix0 = x_start - roi_min_x;
            let ix1 = x_end - roi_min_x;

            if !span.emit_halo || span.bucket_idx == HALO_BUCKET_NONE {
                let slot = (in_y - roi_min_y) % ring_cap;
                let bounds = &mut slot_bounds[slot];
                bounds.0 = bounds.0.min(ix0);
                bounds.1 = bounds.1.max(ix1 - 1);
                let row_slice = &mut ring[slot * roi_w..(slot + 1) * roi_w];
                row_slice[ix0..ix1].fill(CORE_SUPPORT_WORD);
                continue;
            }

            let row_kernels = &precalc.buckets[span.bucket_idx as usize].row_kernels;
            if row_kernels.is_empty() {
                let slot = (in_y - roi_min_y) % ring_cap;
                let bounds = &mut slot_bounds[slot];
                bounds.0 = bounds.0.min(ix0);
                bounds.1 = bounds.1.max(ix1 - 1);
                let row_slice = &mut ring[slot * roi_w..(slot + 1) * roi_w];
                row_slice[ix0..ix1].fill(CORE_SUPPORT_WORD);
                continue;
            }

            for rk in row_kernels {
                let ty_isize = in_y as isize + rk.dy;
                if ty_isize < roi_min_y as isize || ty_isize > roi_max_y as isize {
                    continue;
                }
                let ty = ty_isize as usize;
                let slot = (ty - roi_min_y) % ring_cap;
                let max_cap_dx = rk.caps.last().map(|&(dx, _)| dx).unwrap_or(0);
                let touch_min = x_start.saturating_sub(max_cap_dx).max(roi_min_x) - roi_min_x;
                let touch_max = (x_end - 1 + max_cap_dx).min(roi_max_x) - roi_min_x;
                let bounds = &mut slot_bounds[slot];
                bounds.0 = bounds.0.min(touch_min);
                bounds.1 = bounds.1.max(touch_max);

                let row_slice = &mut ring[slot * roi_w..(slot + 1) * roi_w];

                if rk.interior_word == CORE_SUPPORT_WORD {
                    row_slice[ix0..ix1].fill(CORE_SUPPORT_WORD);
                } else if rk.interior_word > 0 {
                    for px in &mut row_slice[ix0..ix1] {
                        if rk.interior_word > *px {
                            *px = rk.interior_word;
                        }
                    }
                }

                for &(dx, cap_word) in &rk.caps {
                    if let Some(lx) = x_start.checked_sub(dx) {
                        if lx >= roi_min_x {
                            let idx = lx - roi_min_x;
                            if cap_word > row_slice[idx] {
                                row_slice[idx] = cap_word;
                            }
                        }
                    }
                    let rx = x_end - 1 + dx;
                    if rx <= roi_max_x {
                        let idx = rx - roi_min_x;
                        if cap_word > row_slice[idx] {
                            row_slice[idx] = cap_word;
                        }
                    }
                }
            }
        }

        while next_unflushed_y <= roi_max_y {
            flush_ring_row(
                next_unflushed_y,
                ring,
                row_bytes,
                slot_bounds,
                &mut out_rle,
            );
            next_unflushed_y += 1;
        }

        emit_zero_rows(&mut out_rle, height - 1 - roi_max_y, width);
        out_rle.finish()
    })
}

pub fn apply_euclidean_radial_halo_dense_with_precalc(
    support_mask: &mut [u8],
    width: usize,
    height: usize,
    precalc: &SupportHaloPrecalc,
) {
    if width == 0
        || height == 0
        || (precalc.max_rx_px == 0 && precalc.max_ry_px == 0)
        || support_mask.len() < width * height
    {
        return;
    }
    let runs = encode_mask_to_rle(&support_mask[..width * height], width, height);
    let halo_runs = apply_euclidean_radial_halo_rle_with_precalc(&runs, width, height, precalc);
    let mut cursor = 0usize;
    let total = width * height;
    for run in halo_runs {
        if cursor >= total {
            break;
        }
        let take = (run.length as usize).min(total - cursor);
        support_mask[cursor..cursor + take].fill(run.value);
        cursor += take;
    }
}

pub fn apply_euclidean_radial_halo_rle(
    support_runs: &[crate::rle::RleRun],
    width: usize,
    height: usize,
    radius_px: u32,
    max_intensity_u8: u8,
    profile: SupportHaloProfile,
    max_tip_diameter_px: Option<u32>,
) -> Vec<crate::rle::RleRun> {
    use crate::rle::{emit_row, emit_zero_rows, RleAccum};

    let radius = radius_px.min(16) as usize;
    if width == 0
        || height == 0
        || radius == 0
        || max_intensity_u8 == 0
        || support_runs.is_empty()
    {
        return support_runs.to_vec();
    }

    let total_pixels = width * height;
    let mut abs_pos = 0usize;
    let mut spans: Vec<SupportRowSpan> = Vec::new();
    let mut min_x = width;
    let mut max_x = 0usize;
    let mut min_y = height;
    let mut max_y = 0usize;

    for run in support_runs {
        let len = run.length as usize;
        if len == 0 {
            continue;
        }
        if run.value == 0 {
            abs_pos = abs_pos.saturating_add(len);
            continue;
        }

        let mut rem = len;
        while rem > 0 && abs_pos < total_pixels {
            let in_y = abs_pos / width;
            let x_start = abs_pos % width;
            let take = rem.min(width - x_start);
            let x_end = x_start + take;

            min_x = min_x.min(x_start);
            max_x = max_x.max(x_end - 1);
            min_y = min_y.min(in_y);
            max_y = max_y.max(in_y);

            if let Some(last) = spans.last_mut() {
                if last.y == in_y && last.x_end == x_start {
                    last.x_end = x_end;
                } else {
                    spans.push(SupportRowSpan {
                        y: in_y,
                        x_start,
                        x_end,
                        emit_halo: true,
                        bucket_idx: 0,
                    });
                }
            } else {
                spans.push(SupportRowSpan {
                    y: in_y,
                    x_start,
                    x_end,
                    emit_halo: true,
                    bucket_idx: 0,
                });
            }

            abs_pos += take;
            rem -= take;
        }
    }

    if spans.is_empty() {
        return support_runs.to_vec();
    }

    if let Some(max_d_px) = max_tip_diameter_px {
        gate_thin_support_spans(&mut spans, max_d_px);
    }

    let roi_min_x = min_x.saturating_sub(radius);
    let roi_max_x = (max_x + radius).min(width - 1);
    let roi_min_y = min_y.saturating_sub(radius);
    let roi_max_y = (max_y + radius).min(height - 1);
    let roi_w = roi_max_x - roi_min_x + 1;
    let right_zeros = width - 1 - roi_max_x;

    let ring_cap = 2 * radius + 1;
    let mut ring = vec![0u16; ring_cap * roi_w];
    let mut row_bytes = vec![0u8; roi_w];
    let mut slot_dirty = vec![false; ring_cap];
    let row_kernels =
        build_euclidean_halo_row_kernels(radius as u32, max_intensity_u8, profile);

    let mut out_rle = RleAccum::new();
    emit_zero_rows(&mut out_rle, roi_min_y, width);

    let flush_ring_row = |target_y: usize,
                          ring: &mut [u16],
                          row_bytes: &mut [u8],
                          slot_dirty: &mut [bool],
                          out_rle: &mut RleAccum| {
        let slot = (target_y - roi_min_y) % ring_cap;
        if !slot_dirty[slot] {
            emit_zero_rows(out_rle, 1, width);
        } else {
            let slot_offset = slot * roi_w;
            let row_slice = &mut ring[slot_offset..slot_offset + roi_w];
            for (ix, &word) in row_slice.iter().enumerate() {
                row_bytes[ix] = (word & 0xFF) as u8;
            }
            if roi_min_x > 0 {
                out_rle.push_run(roi_min_x as u32, 0);
            }
            emit_row(out_rle, row_bytes);
            if right_zeros > 0 {
                out_rle.push_run(right_zeros as u32, 0);
            }
            row_slice.fill(0);
            slot_dirty[slot] = false;
        }
    };

    let mut next_unflushed_y = roi_min_y;

    for span in &spans {
        let in_y = span.y;
        let x_start = span.x_start;
        let x_end = span.x_end;

        while next_unflushed_y + radius < in_y && next_unflushed_y <= roi_max_y {
            flush_ring_row(
                next_unflushed_y,
                &mut ring,
                &mut row_bytes,
                &mut slot_dirty,
                &mut out_rle,
            );
            next_unflushed_y += 1;
        }

        let ix0 = x_start - roi_min_x;
        let ix1 = x_end - roi_min_x;

        if !span.emit_halo {
            let slot = (in_y - roi_min_y) % ring_cap;
            slot_dirty[slot] = true;
            let row_slice = &mut ring[slot * roi_w..(slot + 1) * roi_w];
            row_slice[ix0..ix1].fill(CORE_SUPPORT_WORD);
            continue;
        }

        for rk in &row_kernels {
            let ty_isize = in_y as isize + rk.dy;
            if ty_isize < roi_min_y as isize || ty_isize > roi_max_y as isize {
                continue;
            }
            let ty = ty_isize as usize;
            let slot = (ty - roi_min_y) % ring_cap;
            slot_dirty[slot] = true;
            let row_slice = &mut ring[slot * roi_w..(slot + 1) * roi_w];

            if rk.interior_word == CORE_SUPPORT_WORD {
                row_slice[ix0..ix1].fill(CORE_SUPPORT_WORD);
            } else if rk.interior_word > 0 {
                for px in &mut row_slice[ix0..ix1] {
                    if rk.interior_word > *px {
                        *px = rk.interior_word;
                    }
                }
            }

            for &(dx, cap_word) in &rk.caps {
                if let Some(lx) = x_start.checked_sub(dx) {
                    if lx >= roi_min_x {
                        let idx = lx - roi_min_x;
                        if cap_word > row_slice[idx] {
                            row_slice[idx] = cap_word;
                        }
                    }
                }
                let rx = x_end - 1 + dx;
                if rx <= roi_max_x {
                    let idx = rx - roi_min_x;
                    if cap_word > row_slice[idx] {
                        row_slice[idx] = cap_word;
                    }
                }
            }
        }
    }

    while next_unflushed_y <= roi_max_y {
        flush_ring_row(
            next_unflushed_y,
            &mut ring,
            &mut row_bytes,
            &mut slot_dirty,
            &mut out_rle,
        );
        next_unflushed_y += 1;
    }

    emit_zero_rows(&mut out_rle, height - 1 - roi_max_y, width);
    out_rle.finish()
}

pub fn apply_euclidean_radial_halo_dense(
    support_mask: &mut [u8],
    width: usize,
    height: usize,
    radius_px: u32,
    max_intensity_u8: u8,
    profile: SupportHaloProfile,
    max_tip_diameter_px: Option<u32>,
) {
    let radius = radius_px.min(16);
    if width == 0
        || height == 0
        || radius == 0
        || max_intensity_u8 == 0
        || support_mask.len() < width * height
    {
        return;
    }
    let runs = encode_mask_to_rle(&support_mask[..width * height], width, height);
    let halo_runs = apply_euclidean_radial_halo_rle(
        &runs,
        width,
        height,
        radius,
        max_intensity_u8,
        profile,
        max_tip_diameter_px,
    );
    let mut cursor = 0usize;
    let total = width * height;
    for run in halo_runs {
        if cursor >= total {
            break;
        }
        let take = (run.length as usize).min(total - cursor);
        support_mask[cursor..cursor + take].fill(run.value);
        cursor += take;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_blur_postprocess_inplace, apply_euclidean_radial_halo_rle, blur_gray_rle_streaming,
        build_row_spans_nonzero, encode_bounded_gray_mask_to_rle, encode_mask_to_rle,
        encode_mask_to_rle_in_bounds, rasterize_layer, rasterize_layer_rle,
        rasterize_layer_rle_block, rasterize_layer_with_stats, remap_gray_rle_with_lut,
        resolve_accumulated_aa_alpha, ActiveEdge, SupportHaloProfile,
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
            blur_brush_kernel: "box".to_string(),
            blur_brush_sigma_x: 1.5,
            blur_brush_sigma_y: 1.5,
            z_blur_radius_layers: 0,
            z_blur_kernel: "gaussian".to_string(),
            z_blur_sigma: 0.5,
            aa_on_supports: false,
            model_triangle_count: 0,
            minimum_aa_alpha_percent: 35.0,
            mirror_x: false,
            mirror_y: false,
            z_blend_look_back: 2,
            z_blend_minimum_alpha_percent: 0.0,
            z_blend_max_alpha_percent: 90.0,
            z_blend_custom_lut: None,
            zaa_kernel: None,
            zaa_pattern: None,
            zaa_duplicate_z: None,
            dither_enabled: false,
            dither_bit_depth: None,
            dither_device_gamma: 3.0,
            triangles_xyz: Vec::new(),
            metadata_json: "{}".to_string(),
            x_packing_mode: "none".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn halo_preserves_binary_core_and_decays_radially() {
        let width = 21usize;
        let height = 21usize;
        let mut mask = vec![0u8; width * height];
        mask[10 * width + 10] = 255;
        let support_runs = encode_mask_to_rle(&mask, width, height);

        let halo_runs = apply_euclidean_radial_halo_rle(
            &support_runs,
            width,
            height,
            3,
            128,
            SupportHaloProfile::Linear,
            None,
        );
        let out = expand_rle_to_mask(&halo_runs, width * height);

        // Core preserved at (10, 10)
        assert_eq!(out[10 * width + 10], 255);
        // Orthogonal neighbors at d = 1: round(128 * 3 / 4) = 96
        assert_eq!(out[10 * width + 9], 96);
        assert_eq!(out[10 * width + 11], 96);
        assert_eq!(out[9 * width + 10], 96);
        assert_eq!(out[11 * width + 10], 96);
        // Diagonal neighbors at d = sqrt(2): round(128 * (4 - sqrt(2)) / 4) = 83
        assert_eq!(out[9 * width + 9], 83);
        assert_eq!(out[9 * width + 11], 83);
        assert_eq!(out[11 * width + 9], 83);
        assert_eq!(out[11 * width + 11], 83);
        // Corners at (±3, ±3) where dx^2 + dy^2 = 18 > 9 must be 0 (Euclidean circle, not Chebyshev box)
        assert_eq!(out[7 * width + 7], 0);
        assert_eq!(out[7 * width + 13], 0);
        assert_eq!(out[13 * width + 7], 0);
        assert_eq!(out[13 * width + 13], 0);
    }

    #[test]
    fn halo_merge_never_darkens_model_aa_pixels() {
        let width = 21usize;
        let height = 21usize;
        let mut support_mask = vec![0u8; width * height];
        support_mask[10 * width + 10] = 255;
        let support_runs = encode_mask_to_rle(&support_mask, width, height);
        let halo_runs = apply_euclidean_radial_halo_rle(
            &support_runs,
            width,
            height,
            3,
            128,
            SupportHaloProfile::Linear,
            None,
        );

        let mut model_mask = vec![0u8; width * height];
        // Overlap orthogonal halo pixel (9, 10) which has halo value 96 with model AA value 200
        model_mask[10 * width + 9] = 200;
        // Overlap core pixel (10, 10) with model AA value 200
        model_mask[10 * width + 10] = 200;
        let model_runs = encode_mask_to_rle(&model_mask, width, height);

        let merged_runs = crate::pipeline::merge_rle_max(&model_runs, &halo_runs);
        let merged = expand_rle_to_mask(&merged_runs, width * height);

        // Halo pixel (96) must not darken model AA pixel (200), while uncovered halo pixel (11, 10) gets 96
        assert_eq!(merged[10 * width + 9], 200);
        assert_eq!(merged[10 * width + 10], 255);
        assert_eq!(merged[10 * width + 11], 96);
    }

    #[test]
    fn halo_tips_only_gates_out_thick_trunks_and_polar_caps_while_haloing_thin_tips() {
        let width = 80usize;
        let height = 80usize;
        let mut mask = vec![0u8; width * height];

        // 1. Thin circular tip centered at (15, 40) with radius 3px (diameter ~7px <= 12px)
        for y in 0..height {
            for x in 0..width {
                let dx = x as isize - 15;
                let dy = y as isize - 40;
                if dx * dx + dy * dy <= 9 {
                    mask[y * width + x] = 255;
                }
            }
        }

        // 2. Thick circular trunk centered at (50, 40) with radius 11px (diameter ~23px > 12px),
        //    which includes narrow North/South polar scanline caps of chord width <= 12px!
        for y in 0..height {
            for x in 0..width {
                let dx = x as isize - 50;
                let dy = y as isize - 40;
                if dx * dx + dy * dy <= 121 {
                    mask[y * width + x] = 255;
                }
            }
        }

        let support_runs = encode_mask_to_rle(&mask, width, height);
        let halo_runs = apply_euclidean_radial_halo_rle(
            &support_runs,
            width,
            height,
            3,
            128,
            SupportHaloProfile::Linear,
            Some(12),
        );
        let out = expand_rle_to_mask(&halo_runs, width * height);

        // Every original 255 pixel in both the thin tip and thick trunk must remain 255.
        for idx in 0..(width * height) {
            if mask[idx] == 255 {
                assert_eq!(out[idx], 255);
            }
        }

        // Thin tip at (15, 40) must emit intermediate grayscale halo pixels around it (e.g., at (19, 40)).
        assert!(out[40 * width + 19] > 0 && out[40 * width + 19] < 255);

        // Thick circular trunk at (50, 40) must emit ZERO halo pixels anywhere around it,
        // including above/below its narrow North/South polar scanline caps!
        let trunk_halo_count = (0..height)
            .flat_map(|y| (30..width).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                let v = out[y * width + x];
                v > 0 && v < 255
            })
            .count();
        assert_eq!(trunk_halo_count, 0);
    }

    #[test]
    fn donut_profile_suppresses_inner_ring_and_peaks_at_annular_collar() {
        let width = 31usize;
        let height = 31usize;
        let mut mask = vec![0u8; width * height];
        mask[15 * width + 15] = 255;
        let support_runs = encode_mask_to_rle(&mask, width, height);

        let job = SliceJobV3 {
            source_width_px: width as u32,
            source_height_px: height as u32,
            width_px: width as u32,
            height_px: height as u32,
            build_width_mm: (width as f32) * 0.025,
            build_depth_mm: (height as f32) * 0.025,
            support_halo_enabled: true,
            support_halo_radius_px: 6,
            support_halo_max_intensity_percent: 25.0,
            support_halo_profile: "donut".to_string(),
            support_halo_scope: "full_supports".to_string(),
            dither_device_gamma: 3.0,
            ..Default::default()
        };

        let precalc = super::SupportHaloPrecalc::from_job(&job, None)
            .expect("donut precalc should be active");
        let halo_runs = super::apply_euclidean_radial_halo_rle_with_precalc(
            &support_runs,
            width,
            height,
            &precalc,
        );
        let out = expand_rle_to_mask(&halo_runs, width * height);

        // Core at d = 0 must remain 255
        assert_eq!(out[15 * width + 15], 255);

        // Inner moat at d = 1: E_moat = 0.25 * 0.25 -> e = 16 -> gamma=3.0 PWM = 101
        let d1 = out[15 * width + 16];
        assert_eq!(d1, 101, "inner moat (d=1) should map to gamma-3 PWM 101, got {d1}");

        // Annular collar peak at d = 3 (~0.45 R): E_peak = 0.25 -> e = 64 -> gamma=3.0 PWM = 161
        let d3 = out[15 * width + 18];
        assert_eq!(d3, 161, "annular collar peak (d=3) should map to gamma-3 PWM 161, got {d3}");
        assert!(d3 > d1, "annular collar peak ({d3}) must exceed inner moat ({d1})");

        // Outer skirt at d = 4, 5, 6 must monotonically decay toward 0 and remain active at d = 6
        let d4 = out[15 * width + 19];
        let d5 = out[15 * width + 20];
        let d6 = out[15 * width + 21];
        let d7 = out[15 * width + 22];
        assert!(d3 > d4 && d4 > d5 && d5 > d6 && d6 > 0);
        assert_eq!(d7, 0);
    }

    #[test]
    fn anisotropic_pixel_pitch_scales_x_and_y_reach_and_packing_energy() {
        let width = 41usize;
        let height = 41usize;
        let mut mask = vec![0u8; width * height];
        mask[20 * width + 20] = 255;
        let support_runs = encode_mask_to_rle(&mask, width, height);

        // Simulate 19 um X pitch vs 24 um Y pitch (e.g. Elegoo Saturn 4 Ultra 16K / 12K class)
        let pitch_x = 0.019f32;
        let pitch_y = 0.024f32;
        let job = SliceJobV3 {
            source_width_px: width as u32,
            source_height_px: height as u32,
            width_px: width as u32,
            height_px: height as u32,
            build_width_mm: (width as f32) * pitch_x,
            build_depth_mm: (height as f32) * pitch_y,
            support_halo_enabled: true,
            support_halo_radius_px: 8, // R_ref_mm = 8 * 0.019 = 0.152 mm
            support_halo_max_intensity_percent: 25.0,
            support_halo_profile: "donut".to_string(),
            support_halo_scope: "full_supports".to_string(),
            dither_device_gamma: 3.0,
            ..Default::default()
        };

        let precalc = super::SupportHaloPrecalc::from_job(&job, None)
            .expect("anisotropic precalc should be active");
        let halo_runs = super::apply_euclidean_radial_halo_rle_with_precalc(
            &support_runs,
            width,
            height,
            &precalc,
        );
        let out = expand_rle_to_mask(&halo_runs, width * height);

        let max_dx = (1..=16usize)
            .filter(|&dx| out[20 * width + (20 + dx)] > 0)
            .max()
            .unwrap_or(0);
        let max_dy = (1..=16usize)
            .filter(|&dy| out[(20 + dy) * width + 20] > 0)
            .max()
            .unwrap_or(0);

        // X reach must be 8 px (8 * 0.019 = 0.152 mm), Y reach must be 6 px (6 * 0.024 = 0.144 mm <= 0.152 mm < 7 * 0.024 = 0.168 mm)
        assert_eq!(max_dx, 8, "X-axis reach should be 8 px at 19um pitch");
        assert_eq!(max_dy, 6, "Y-axis reach should be 6 px at 24um pitch");
        assert!(
            ((max_dx as f32) * pitch_x - (max_dy as f32) * pitch_y).abs() <= pitch_y,
            "Physical reach in mm along X and Y must match within 1 pixel pitch"
        );

        // Peak intensity along X must be attenuated by sub-pixel packing factor (19/24) relative to Y peak
        let peak_x = (1..=max_dx)
            .map(|dx| out[20 * width + (20 + dx)])
            .max()
            .unwrap_or(0);
        let peak_y = (1..=max_dy)
            .map(|dy| out[(20 + dy) * width + 20])
            .max()
            .unwrap_or(0);
        assert!(
            peak_x < peak_y,
            "X-axis peak PWM ({peak_x}) should be attenuated relative to Y-axis peak PWM ({peak_y}) due to denser X sub-pixel packing"
        );
    }

    #[test]
    fn continuous_tip_diameter_scaling_expands_020mm_tip_and_tapers_toward_dmax() {
        let (sr_020, se_020) = super::evaluate_tip_diameter_halo_scales(0.20, 0.80);
        let (sr_040, se_040) = super::evaluate_tip_diameter_halo_scales(0.40, 0.80);
        let (sr_060, se_060) = super::evaluate_tip_diameter_halo_scales(0.60, 0.80);
        let (sr_080, se_080) = super::evaluate_tip_diameter_halo_scales(0.80, 0.80);

        assert!((sr_020 - 4.0 / 3.0).abs() < 1e-4 && (se_020 - 1.00).abs() < 1e-4);
        assert!((sr_040 - 1.0).abs() < 1e-4 && (se_040 - 0.85).abs() < 1e-4);
        assert!((sr_060 - 0.50).abs() < 1e-4 && (se_060 - 0.425).abs() < 1e-4);
        assert_eq!((sr_080, se_080), (0.0, 0.0));

        // Verify end-to-end 2D mask behavior on a 0.025 mm/px grid (R_ref = 6 px = 0.15 mm):
        // - 0.20 mm tip (8 px box) gets 4/3 * 6 = 8 px halo reach and peak PWM 161
        // - 0.40 mm tip (16 px box) gets 1.0 * 6 = 6 px halo reach and scaled peak PWM
        // - 0.60 mm neck (24 px box) gets 0.5 * 6 = 3 px halo reach and tapered peak PWM
        // - 0.85 mm trunk (34 px box) gets 0 halo reach
        let width = 200usize;
        let height = 60usize;
        let mut mask = vec![0u8; width * height];
        let mut stamp_square = |cx: usize, cy: usize, size: usize| {
            let x0 = cx - size / 2;
            let y0 = cy - size / 2;
            for y in y0..(y0 + size) {
                for x in x0..(x0 + size) {
                    mask[y * width + x] = 255;
                }
            }
        };
        stamp_square(25, 30, 8);   // 0.20 mm tip (x: 21..29)
        stamp_square(70, 30, 16);  // 0.40 mm tip (x: 62..78)
        stamp_square(120, 30, 24); // 0.60 mm neck (x: 108..132)
        stamp_square(170, 30, 34); // 0.85 mm trunk (x: 153..187)

        let support_runs = encode_mask_to_rle(&mask, width, height);
        let job = SliceJobV3 {
            source_width_px: width as u32,
            source_height_px: height as u32,
            width_px: width as u32,
            height_px: height as u32,
            build_width_mm: (width as f32) * 0.025,
            build_depth_mm: (height as f32) * 0.025,
            support_halo_enabled: true,
            support_halo_radius_px: 6, // R_ref = 0.15 mm
            support_halo_max_intensity_percent: 25.0,
            support_halo_profile: "donut".to_string(),
            support_halo_scope: "tips_only".to_string(),
            support_halo_max_tip_diameter_mm: 0.80,
            dither_device_gamma: 3.0,
            ..Default::default()
        };

        let precalc = super::SupportHaloPrecalc::from_job(&job, None).unwrap();
        let halo_runs = super::apply_euclidean_radial_halo_rle_with_precalc(
            &support_runs,
            width,
            height,
            &precalc,
        );
        let out = expand_rle_to_mask(&halo_runs, width * height);

        let reach_right = |x_right_edge: usize| -> usize {
            (1..=12usize)
                .filter(|&dx| {
                    let v = out[30 * width + x_right_edge + dx];
                    v > 0 && v < 255
                })
                .max()
                .unwrap_or(0)
        };
        let reach_020 = reach_right(28);
        let reach_040 = reach_right(77);
        let reach_060 = reach_right(131);
        let reach_085 = reach_right(186);

        assert_eq!(reach_020, 8, "0.20 mm tip should expand to 8 px (0.20 mm) reach");
        assert_eq!(reach_040, 6, "0.40 mm tip should have 6 px (0.15 mm) reference reach");
        assert_eq!(reach_060, 3, "0.60 mm neck should taper to 3 px (0.075 mm) reach");
        assert_eq!(reach_085, 0, "0.85 mm trunk (>= 0.80 mm) must emit zero halo");
    }

    #[test]
    fn circular_020mm_tip_produces_060mm_outer_donut_with_visible_perimeter_moat() {
        let width = 40usize;
        let height = 40usize;
        let pitch_mm = 0.020f32;
        let mut mask = vec![0u8; width * height];

        // 0.20 mm diameter (0.10 mm radius = 5.0 px at 20 um pitch) circular tip centered at (19.5, 19.5)
        for y in 0..height {
            for x in 0..width {
                let dx = (x as f32) - 19.5;
                let dy = (y as f32) - 19.5;
                if dx.hypot(dy) <= 5.0 {
                    mask[y * width + x] = 255;
                }
            }
        }

        let support_runs = encode_mask_to_rle(&mask, width, height);
        let job = SliceJobV3 {
            source_width_px: width as u32,
            source_height_px: height as u32,
            width_px: width as u32,
            height_px: height as u32,
            build_width_mm: (width as f32) * pitch_mm,
            build_depth_mm: (height as f32) * pitch_mm,
            support_halo_enabled: true,
            support_halo_radius_mm: 0.15,
            support_halo_inverse_scale_percent: 100.0,
            support_halo_max_intensity_percent: 25.0,
            support_halo_profile: "donut".to_string(),
            support_halo_scope: "tips_only".to_string(),
            support_halo_max_tip_diameter_mm: 0.80,
            dither_device_gamma: 3.0,
            ..Default::default()
        };

        let precalc = super::SupportHaloPrecalc::from_job(&job, None)
            .expect("Stage 5 Option A precalc should be active");
        let halo_runs = super::apply_euclidean_radial_halo_rle_with_precalc(
            &support_runs,
            width,
            height,
            &precalc,
        );
        let out = expand_rle_to_mask(&halo_runs, width * height);

        // 1. Core 255 diameter on equator (y = 19) and meridian (x = 19) is 10 px (0.20 mm)
        let core_w = (0..width).filter(|&x| out[19 * width + x] == 255).count();
        let core_h = (0..height).filter(|&y| out[y * width + 19] == 255).count();
        assert_eq!(core_w, 10, "core width must be 10 px (0.20 mm)");
        assert_eq!(core_h, 10, "core height must be 10 px (0.20 mm)");

        // 2. Every 4-connected perimeter pixel (d_edge = 1 px) around the 255 circle must preserve
        //    the low anti-dilation moat intensity (<= 115, specifically 101), never overwritten by 161!
        let mut moat_count = 0usize;
        for y in 1..(height - 1) {
            for x in 1..(width - 1) {
                if mask[y * width + x] == 0 {
                    let touches_core = mask[(y - 1) * width + x] == 255
                        || mask[(y + 1) * width + x] == 255
                        || mask[y * width + (x - 1)] == 255
                        || mask[y * width + (x + 1)] == 255;
                    if touches_core {
                        moat_count += 1;
                        let v = out[y * width + x];
                        assert!(
                            v > 0 && v <= 115,
                            "perimeter moat pixel at ({x}, {y}) was overwritten with {v} (expected moat <= 115)"
                        );
                    }
                }
            }
        }
        assert!(moat_count >= 28, "circle perimeter should have at least 28 4-connected moat pixels");

        // 3. Annular Donut collar at d_edge = 4..5 px reaches peak intensity (160..=161) on all 4 cardinal axes
        assert!((155..=162).contains(&out[19 * width + 28]), "East collar crest should peak around 160-161");
        assert!((155..=162).contains(&out[19 * width + 11]), "West collar crest should peak around 160-161");
        assert!((155..=162).contains(&out[28 * width + 19]), "South collar crest should peak around 160-161");
        assert!((155..=162).contains(&out[11 * width + 19]), "North collar crest should peak around 160-161");

        // 4. Total outer non-zero diameter is 30 px (0.60 mm = 0.20 mm core + 2 * 0.20 mm halo)
        let outer_w = (0..width).filter(|&x| out[19 * width + x] > 0).count();
        let outer_h = (0..height).filter(|&y| out[y * width + 19] > 0).count();
        assert_eq!(outer_w, 30, "total outer X diameter must be 30 px (0.60 mm), got {outer_w}");
        assert_eq!(outer_h, 30, "total outer Y diameter must be 30 px (0.60 mm), got {outer_h}");
    }

    #[test]
    fn tilted_elliptical_support_blob_uses_2d_area_equivalent_diameter() {
        let width = 80usize;
        let height = 80usize;
        let pitch_mm = 0.020f32;
        let mut mask = vec![0u8; width * height];

        // Elliptical support blob with minor axis 0.40 mm (rx = 10 px) and major axis 0.88 mm (ry = 22 px).
        // 1D major axis is 0.88 mm > D_max (0.80 mm), but 2D area-equivalent diameter is
        // sqrt(0.40 * 0.88) = 0.593 mm < 0.80 mm and within the 1.5 * D_max = 1.20 mm extent guard.
        for y in 0..height {
            for x in 0..width {
                let nx = ((x as f32) - 39.5) / 10.0;
                let ny = ((y as f32) - 39.5) / 22.0;
                if nx * nx + ny * ny <= 1.0 {
                    mask[y * width + x] = 255;
                }
            }
        }

        let support_runs = encode_mask_to_rle(&mask, width, height);
        let job = SliceJobV3 {
            source_width_px: width as u32,
            source_height_px: height as u32,
            width_px: width as u32,
            height_px: height as u32,
            build_width_mm: (width as f32) * pitch_mm,
            build_depth_mm: (height as f32) * pitch_mm,
            support_halo_enabled: true,
            support_halo_radius_mm: 0.15,
            support_halo_inverse_scale_percent: 100.0,
            support_halo_max_intensity_percent: 25.0,
            support_halo_profile: "donut".to_string(),
            support_halo_scope: "tips_only".to_string(),
            support_halo_max_tip_diameter_mm: 0.80,
            dither_device_gamma: 3.0,
            ..Default::default()
        };

        let precalc = super::SupportHaloPrecalc::from_job(&job, None).unwrap();
        let halo_runs = super::apply_euclidean_radial_halo_rle_with_precalc(
            &support_runs,
            width,
            height,
            &precalc,
        );
        let out = expand_rle_to_mask(&halo_runs, width * height);

        // At D_blob ~ 0.593 mm (bucket ~ 0.60 mm), s_R ~ 0.50 -> R_halo ~ 0.075 mm = 4 px at 20 um pitch.
        let max_east_core = (0..width).filter(|&x| mask[39 * width + x] == 255).max().unwrap();
        let east_reach = (1..=10usize)
            .filter(|&dx| {
                let v = out[39 * width + max_east_core + dx];
                v > 0 && v < 255
            })
            .max()
            .unwrap_or(0);
        assert!(
            east_reach >= 3 && east_reach <= 5,
            "tilted 0.40x0.88 mm elliptical blob (D_blob ~ 0.59 mm) should receive ~4 px halo reach, got {east_reach}"
        );
    }

    #[test]
    fn inverse_scale_percent_zero_applies_fixed_mm_radius_across_all_tip_sizes() {
        let width = 200usize;
        let height = 60usize;
        let pitch_mm = 0.025f32;
        let mut mask = vec![0u8; width * height];
        let mut stamp_square = |cx: usize, cy: usize, size: usize| {
            let x0 = cx - size / 2;
            let y0 = cy - size / 2;
            for y in y0..(y0 + size) {
                for x in x0..(x0 + size) {
                    mask[y * width + x] = 255;
                }
            }
        };
        stamp_square(25, 30, 8);   // 0.20 mm tip (x: 21..29)
        stamp_square(75, 30, 16);  // 0.40 mm tip (x: 67..83)
        stamp_square(135, 30, 24); // 0.60 mm tip (x: 123..147)

        let support_runs = encode_mask_to_rle(&mask, width, height);
        let job = SliceJobV3 {
            source_width_px: width as u32,
            source_height_px: height as u32,
            width_px: width as u32,
            height_px: height as u32,
            build_width_mm: (width as f32) * pitch_mm,
            build_depth_mm: (height as f32) * pitch_mm,
            support_halo_enabled: true,
            support_halo_radius_mm: 0.15, // 6 px at 25 um pitch
            support_halo_inverse_scale_percent: 0.0, // Fixed Radius mode!
            support_halo_max_intensity_percent: 25.0,
            support_halo_profile: "donut".to_string(),
            support_halo_scope: "tips_only".to_string(),
            support_halo_max_tip_diameter_mm: 0.80,
            dither_device_gamma: 3.0,
            ..Default::default()
        };

        let precalc = super::SupportHaloPrecalc::from_job(&job, None).unwrap();
        let halo_runs = super::apply_euclidean_radial_halo_rle_with_precalc(
            &support_runs,
            width,
            height,
            &precalc,
        );
        let out = expand_rle_to_mask(&halo_runs, width * height);

        let stats_right = |x_right_edge: usize| -> (usize, u8) {
            let reach = (1..=12usize)
                .filter(|&dx| {
                    let v = out[30 * width + x_right_edge + dx];
                    v > 0 && v < 255
                })
                .max()
                .unwrap_or(0);
            let peak = (1..=12usize)
                .map(|dx| out[30 * width + x_right_edge + dx])
                .filter(|&v| v < 255)
                .max()
                .unwrap_or(0);
            (reach, peak)
        };

        let (reach_020, peak_020) = stats_right(28);
        let (reach_040, peak_040) = stats_right(82);
        let (reach_060, peak_060) = stats_right(146);

        assert_eq!(reach_020, 6, "0.20 mm tip should have fixed 6 px (0.15 mm) reach at 0% inverse scale");
        assert_eq!(reach_040, 6, "0.40 mm tip should have fixed 6 px (0.15 mm) reach at 0% inverse scale");
        assert_eq!(reach_060, 6, "0.60 mm tip should have fixed 6 px (0.15 mm) reach at 0% inverse scale");
        assert_eq!(peak_020, peak_040, "peak intensity must be identical across all tip sizes at 0% inverse scale");
        assert_eq!(peak_040, peak_060, "peak intensity must be identical across all tip sizes at 0% inverse scale");
    }

    #[test]
    fn duplicate_terminal_z_keeps_solid_interiors_opaque() {
        let mut xyz = Vec::new();
        push_box_triangles(&mut xyz, 0.0, 0.0, -1.0, 2.0, 40.0, 40.0);

        let center = |duplicate_z: Option<bool>| -> u8 {
            let mut job = job_for_single_layer();
            job.anti_aliasing_mode = "3DAA".to_string();
            job.anti_aliasing_level = "16x".to_string();
            job.zaa_duplicate_z = duplicate_z;

            let width = job.source_width_px as usize;
            let height = job.source_height_px as usize;
            let mut triangles = parse_triangles(&xyz);
            project_triangles_inplace(&mut triangles, &job);
            let indices: Vec<usize> = (0..triangles.len()).collect();

            let mask = rasterize_layer(&job, &triangles, &indices, 0);
            mask[(height / 2) * width + width / 2]
        };

        // Halving the unique Z samples must not halve the accumulated coverage:
        // the interior stays white, only the edges get grey.
        assert_eq!(center(Some(false)), 255);
        assert_eq!(center(Some(true)), 255);
    }

    #[test]
    fn windowed_rle_blocks_hstack_matches_full_width_raster() {
        let job = job_for_single_layer();
        let width = job.source_width_px as usize;
        let height = job.source_height_px as usize;

        // Plate coordinates are centre-origin: one box straddling the centre
        // seam (x = 0), one entirely in the left half.
        let mut xyz = Vec::new();
        push_box_triangles(&mut xyz, 0.0, 5.0, 0.0, 2.0, 30.0, 25.0);
        push_box_triangles(&mut xyz, -30.0, -20.0, 0.0, 2.0, 18.0, 12.0);
        let mut triangles = parse_triangles(&xyz);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();

        let (full_runs, full_stats) = rasterize_layer_rle(&job, &triangles, &indices, 0, false);
        let full_mask = expand_rle_to_mask(&full_runs, width * height);

        let half = width / 2;
        let (left_runs, left_stats) = rasterize_layer_rle_block(
            &job,
            &triangles,
            &indices,
            0,
            false,
            crate::rle::make_rle_block(0, half as u32),
        );
        let (right_runs, right_stats) = rasterize_layer_rle_block(
            &job,
            &triangles,
            &indices,
            0,
            false,
            crate::rle::make_rle_block(half as u32, (width - half) as u32),
        );

        let left_mask = expand_rle_to_mask(&left_runs, half * height);
        let right_mask = expand_rle_to_mask(&right_runs, (width - half) * height);

        let mut stacked = Vec::with_capacity(width * height);
        for row in 0..height {
            stacked.extend_from_slice(&left_mask[row * half..(row + 1) * half]);
            stacked
                .extend_from_slice(&right_mask[row * (width - half)..(row + 1) * (width - half)]);
        }

        assert_eq!(stacked, full_mask);
        assert!(full_stats.total_solid_pixels > 0);
        assert!(left_stats.total_solid_pixels > 0);
        assert!(right_stats.total_solid_pixels > 0);
        assert_eq!(
            left_stats.total_solid_pixels + right_stats.total_solid_pixels,
            full_stats.total_solid_pixels
        );
        // Block stats report x-extents in absolute frame columns.
        assert_eq!(left_stats.min_x.min(right_stats.min_x), full_stats.min_x);
        assert_eq!(left_stats.max_x.max(right_stats.max_x), full_stats.max_x);
    }

    #[test]
    fn blur_halo_crop_matches_full_width_blur_at_seam() {
        // Validates the engine's halo strategy: blurring a window widened by
        // the kernel radius, then cropping the halo columns, must equal the
        // corresponding columns of the full-width blur.
        let width = 64usize;
        let height = 16usize;
        let radius = 3usize;

        // Content crossing the seam at width/2.
        let mut mask = vec![0u8; width * height];
        for y in 4..12 {
            for x in 24..44 {
                mask[y * width + x] = 255;
            }
        }
        let full_runs = encode_mask_to_rle(&mask, width, height);
        let full_blur = blur_gray_rle_streaming(&full_runs, width, height, radius, 0);
        let full_blur_mask = expand_rle_to_mask(&full_blur, width * height);

        let half = width / 2;
        let mut stacked = Vec::with_capacity(width * height);
        let mut halves: Vec<Vec<u8>> = Vec::new();
        for (start, w) in [(0usize, half), (half, width - half)] {
            let halo_left = radius.min(start);
            let halo_right = radius.min(width - (start + w));
            let wid_start = start - halo_left;
            let wid_w = (start + w + halo_right) - wid_start;

            // Window-rasterized equivalent: crop the binary runs to the
            // widened window, blur at the widened width, crop the halo.
            let widened = crate::rle::crop_rle_columns(
                &full_runs,
                width as u32,
                wid_start as u32,
                (width - (wid_start + wid_w)) as u32,
            );
            let blurred = blur_gray_rle_streaming(&widened, wid_w, height, radius, 0);
            let cropped = crate::rle::crop_rle_columns(
                &blurred,
                wid_w as u32,
                halo_left as u32,
                halo_right as u32,
            );
            halves.push(expand_rle_to_mask(&cropped, w * height));
        }
        for row in 0..height {
            stacked.extend_from_slice(&halves[0][row * half..(row + 1) * half]);
            stacked
                .extend_from_slice(&halves[1][row * (width - half)..(row + 1) * (width - half)]);
        }

        assert_eq!(stacked, full_blur_mask);
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

    fn edge(x: f32, wind: i32) -> ActiveEdge {
        ActiveEdge {
            x,
            dx_dy: 0.0,
            wind,
            end_exclusive: 10,
        }
    }

    #[test]
    fn unbalanced_crossings_keep_only_matched_pairs() {
        let spans = build_row_spans_nonzero(
            &[edge(40.0, 1), edge(64.0, 1), edge(220.0, -1)],
            256,
            true,
        );

        assert_eq!(
            spans.len(),
            1,
            "malformed rows should collapse to the orientation-consistent pair"
        );
        assert_eq!(spans[0].start, 64);
        assert_eq!(spans[0].end, 219);
    }

    #[test]
    fn missing_exit_does_not_bridge_to_the_next_object() {
        // Left object's exit crossing is missing (hole in the mesh); the
        // orphaned entry at x=10 must not leak fill across the gap into the
        // object at 100..130.
        let spans = build_row_spans_nonzero(
            &[edge(10.0, 1), edge(100.0, 1), edge(130.0, -1)],
            256,
            true,
        );

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start, 100);
        assert_eq!(spans[0].end, 129);
    }

    #[test]
    fn duplicated_entry_does_not_bridge_between_objects() {
        // A duplicated (non-manifold) face doubles the left object's entry
        // crossing. Winding stays positive through the gap, so the old
        // non-zero rule filled 40..100 solid.
        let spans = build_row_spans_nonzero(
            &[
                edge(10.0, 1),
                edge(10.0, 1),
                edge(40.0, -1),
                edge(100.0, 1),
                edge(130.0, -1),
            ],
            256,
            true,
        );

        assert_eq!(spans.len(), 2, "gap between objects must stay empty");
        assert_eq!((spans[0].start, spans[0].end), (10, 39));
        assert_eq!((spans[1].start, spans[1].end), (100, 129));
    }

    #[test]
    fn flipped_crossings_in_the_gap_do_not_fill() {
        // A flipped triangle pair puts inverted crossings between two
        // objects. The old rule saw winding == -1 there and filled the gap.
        let spans = build_row_spans_nonzero(
            &[
                edge(10.0, 1),
                edge(40.0, -1),
                edge(60.0, -1),
                edge(80.0, 1),
                edge(100.0, 1),
                edge(130.0, -1),
            ],
            256,
            true,
        );

        assert_eq!(spans.len(), 2, "inverted junk must not fill the gap");
        assert_eq!((spans[0].start, spans[0].end), (10, 39));
        assert_eq!((spans[1].start, spans[1].end), (100, 129));
    }

    #[test]
    fn flipped_triangle_does_not_invert_the_row() {
        // Three objects; the middle object's left crossing passes through a
        // flipped triangle so its wind reads -1 instead of +1. The winding
        // dips to -2 (below the legitimate +1 peak), which used to flip the
        // orientation vote and fill the gaps instead of the objects —
        // rendering the row inverted. Evidence-based orientation must keep
        // all three objects filled.
        let spans = build_row_spans_nonzero(
            &[
                edge(10.0, 1),
                edge(40.0, -1),
                edge(100.0, -1),
                edge(130.0, -1),
                edge(200.0, 1),
                edge(230.0, -1),
            ],
            256,
            true,
        );

        assert_eq!(spans.len(), 3, "all three objects must fill, nothing else");
        assert_eq!((spans[0].start, spans[0].end), (10, 39));
        assert_eq!((spans[1].start, spans[1].end), (100, 129));
        assert_eq!((spans[2].start, spans[2].end), (200, 229));
    }

    #[test]
    fn real_world_flipped_cluster_row_keeps_objects_and_gaps() {
        // Regression data: the actual crossing list captured from row 2364
        // of an 11520 px frame sliced from a defective mesh. A flipped
        // triangle sheds a micro-cluster of crossings at x≈4104 leaving
        // closure -1 and a winding dip to -2; pairing evidence ties in both
        // orientations, and the old winding-extent vote inverted the row —
        // filling the 5644..8618 gap as a line across the plate.
        let defective: [(f32, i32); 31] = [
            (3459.9434, 1),
            (3470.0964, -1),
            (3779.1995, 1),
            (3903.8005, -1),
            (3944.261, 1),
            (4103.43, -1),
            (4103.759, 1),
            (4103.8467, -1),
            (4103.8843, -1),
            (4103.887, 1),
            (4103.896, 1),
            (4103.903, -1),
            (4103.9097, -1),
            (4103.911, -1),
            (4103.9478, 1),
            (4103.98, 1),
            (4104.374, -1),
            (4104.568, 1),
            (4313.804, -1),
            (4415.3384, 1),
            (4456.252, -1),
            (4784.626, 1),
            (4874.465, -1),
            (4997.4087, 1),
            (5422.0386, -1),
            (5628.915, 1),
            (5644.446, -1),
            (8618.343, 1),
            (9020.281, -1),
            (9533.445, 1),
            (9558.4795, -1),
        ];
        let edges: Vec<ActiveEdge> = defective.iter().map(|&(x, w)| edge(x, w)).collect();

        // Healthy neighbor row: the same objects without the defect cluster.
        let healthy: [(f32, i32); 18] = [
            (3459.9, 1),
            (3470.1, -1),
            (3779.2, 1),
            (3903.8, -1),
            (3944.3, 1),
            (4103.4, -1),
            (4415.3, 1),
            (4456.3, -1),
            (4784.6, 1),
            (4874.5, -1),
            (4997.4, 1),
            (5422.0, -1),
            (5628.9, 1),
            (5644.4, -1),
            (8618.3, 1),
            (9020.3, -1),
            (9533.4, 1),
            (9558.5, -1),
        ];
        let prev_edges: Vec<ActiveEdge> = healthy.iter().map(|&(x, w)| edge(x, w)).collect();
        let prev = build_row_spans_nonzero(&prev_edges, 11520, true);

        let spans = super::build_row_spans_nonzero_ctx(&edges, 11520, true, Some(&prev));

        assert!(
            spans.iter().all(|s| s.end < 5646 || s.start > 8617),
            "the 5644..8618 gap must stay empty, got {:?}",
            spans
                .iter()
                .map(|s| (s.start, s.end))
                .collect::<Vec<_>>()
        );
        assert!(
            spans.iter().any(|s| s.start <= 5000 && s.end >= 5400),
            "the 4997..5422 object must fill"
        );
        assert!(
            spans.iter().any(|s| s.start <= 8620 && s.end >= 9019),
            "the 8618..9020 object must fill"
        );
    }

    #[test]
    fn neighbor_coherence_resolves_orientation_ties() {
        // One correctly wound object (10..40) and one fully flipped object
        // (100..130) tie on every within-row metric: one matched pair and
        // 30 px of fill in either orientation. The previous row's spans
        // (healthy geometry at 100..130) must break the tie.
        let prev = build_row_spans_nonzero(&[edge(100.0, 1), edge(130.0, -1)], 256, true);
        let spans = super::build_row_spans_nonzero_ctx(
            &[
                edge(10.0, 1),
                edge(40.0, -1),
                edge(100.0, -1),
                edge(130.0, 1),
            ],
            256,
            true,
            Some(&prev),
        );

        assert_eq!(spans.len(), 1);
        assert_eq!((spans[0].start, spans[0].end), (100, 129));
    }

    #[test]
    fn repeated_instance_defects_do_not_bridge_the_plate() {
        // Instanced copies of the same defective mesh shed one orphaned
        // entry per instance onto the same row. Pairing those orphans
        // (10, 200) would draw a line across both healthy objects between
        // them — the full-plate leak seen on multi-instance plates.
        let spans = build_row_spans_nonzero(
            &[
                edge(10.0, 1),
                edge(30.0, 1),
                edge(50.0, -1),
                edge(100.0, 1),
                edge(120.0, -1),
                edge(200.0, 1),
            ],
            256,
            true,
        );

        assert_eq!(spans.len(), 2, "orphan entries must not pair across matched fill");
        assert_eq!((spans[0].start, spans[0].end), (30, 49));
        assert_eq!((spans[1].start, spans[1].end), (100, 119));
    }

    #[test]
    fn repeated_subpixel_gap_pairs_do_not_bridge_in_any_raster_mode() {
        let prev = build_row_spans_nonzero(
            &[
                edge(10.0, 1),
                edge(20.0, -1),
                edge(30.0, 1),
                edge(40.0, -1),
                edge(110.0, 1),
                edge(120.0, -1),
                edge(130.0, 1),
                edge(140.0, -1),
                edge(210.0, 1),
                edge(220.0, -1),
                edge(230.0, 1),
                edge(240.0, -1),
            ],
            300,
            true,
        );
        let defective = [
            edge(10.0, 1),
            edge(20.0, -1),
            edge(30.0, 1),
            edge(40.0, -1),
            edge(50.0, -1),
            edge(50.02, 1),
            edge(110.0, 1),
            edge(120.0, -1),
            edge(130.0, 1),
            edge(140.0, -1),
            edge(150.0, -1),
            edge(150.02, 1),
            edge(210.0, 1),
            edge(220.0, -1),
            edge(230.0, 1),
            edge(240.0, -1),
            edge(250.0, -1),
            edge(250.02, 1),
        ];

        for snap_to_integer in [true, false] {
            let spans = super::build_row_spans_nonzero_ctx(
                &defective,
                300,
                snap_to_integer,
                Some(&prev),
            );

            assert_eq!(spans.len(), 6);
            assert!(
                spans.iter().all(|span| span.b - span.a <= 10.0),
                "subpixel gaps must not bridge repeated instances: {spans:?}"
            );
        }
    }

    #[test]
    fn repeated_local_gap_signatures_do_not_bridge_between_instances() {
        let mut prev_edges = Vec::new();
        let mut edges = Vec::new();
        for offset in [0.0, 100.0, 200.0] {
            prev_edges.extend_from_slice(&[
                edge(offset + 10.0, 1),
                edge(offset + 20.0, -1),
                edge(offset + 30.0, 1),
                edge(offset + 40.0, -1),
            ]);
            edges.extend_from_slice(&[
                edge(offset + 10.0, 1),
                edge(offset + 20.0, -1),
                edge(offset + 30.0, 1),
                edge(offset + 40.0, -1),
                edge(offset + 50.0, -1),
                edge(offset + 55.0, 1),
            ]);
        }
        let prev = build_row_spans_nonzero(&prev_edges, 300, true);

        for snap_to_integer in [true, false] {
            let spans = super::build_row_spans_nonzero_ctx(
                &edges,
                300,
                snap_to_integer,
                Some(&prev),
            );
            assert_eq!(spans.len(), 6);
            assert!(
                spans.iter().all(|span| span.b - span.a <= 10.0),
                "local gap signatures must not bridge repeated instances: {spans:?}"
            );
        }
    }

    #[test]
    fn unmatched_exit_does_not_consume_the_next_real_object() {
        let spans = build_row_spans_nonzero(
            &[edge(10.0, -1), edge(100.0, 1), edge(130.0, -1)],
            256,
            true,
        );

        assert_eq!(spans.len(), 1);
        assert_eq!((spans[0].start, spans[0].end), (100, 129));
    }

    #[test]
    fn complete_subpixel_features_are_dropped_in_all_raster_modes() {
        let edges = [edge(10.1, 1), edge(10.9, -1)];

        assert!(build_row_spans_nonzero(&edges, 256, true).is_empty());
        assert!(build_row_spans_nonzero(&edges, 256, false).is_empty());
    }

    #[test]
    fn same_sign_walls_still_fill_via_orphan_pairing() {
        // Partially inverted meshes produce same-sign crossings for both
        // walls of a solid; orientation carries no pairing information
        // there, so consecutive unmatched crossings pair up positionally,
        // matching the old even-odd fallback.
        let spans = build_row_spans_nonzero(&[edge(20.0, 1), edge(40.0, 1)], 256, true);

        assert_eq!(spans.len(), 1);
        assert_eq!((spans[0].start, spans[0].end), (20, 39));
    }

    #[test]
    fn fully_inverted_rows_still_fill() {
        // A globally flipped mesh winds negative everywhere; the fast path
        // must keep filling it exactly as before.
        let spans = build_row_spans_nonzero(&[edge(10.0, -1), edge(40.0, 1)], 256, true);

        assert_eq!(spans.len(), 1);
        assert_eq!((spans[0].start, spans[0].end), (10, 39));
    }

    #[test]
    fn overlapping_solids_still_union_after_hardening() {
        let spans = build_row_spans_nonzero(
            &[edge(10.0, 1), edge(30.0, 1), edge(60.0, -1), edge(90.0, -1)],
            256,
            true,
        );

        assert_eq!(spans.first().unwrap().start, 10);
        assert_eq!(spans.last().unwrap().end, 89);
        for pair in spans.windows(2) {
            assert_eq!(
                pair[1].start,
                pair[0].end + 1,
                "overlap union must stay gapless"
            );
        }
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
        // Matched-pair repair keeps the orientation-consistent object
        // (entry at -8 paired with the exit at 22, ~81 px) and drops the
        // orphaned entry at -24; a leak across all three walls would run
        // ~124 px.
        assert!(
            longest_run < 90,
            "malformed open rows should not flood-fill across the remaining crossings (longest_run={longest_run})"
        );
        assert!(
            longest_run > 5,
            "the regression mesh should still produce a small filled span so the test is meaningful"
        );
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
    fn parallel_box_blurs_on_one_worker_keep_separate_intermediates() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        let width = 1024;
        let height = 1024;
        let mut lit = vec![255u8; width * height];
        let mut dark = vec![0u8; width * height];

        pool.install(|| {
            rayon::scope_fifo(|scope| {
                scope.spawn_fifo(|_| {
                    super::apply_edge_box_blur_to_mask_in_roi(
                        &mut dark, width, height, 1, 0, 0, width - 1, 0, height - 1,
                    );
                });
                super::apply_edge_box_blur_to_mask_in_roi(
                    &mut lit, width, height, 1, 0, 0, width - 1, 0, height - 1,
                );
            });
        });

        assert!(lit.iter().all(|&pixel| pixel == 255));
        assert!(dark.iter().all(|&pixel| pixel == 0));
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
    fn accumulated_aa_alpha_preserves_fractional_coverage() {
        let partial_cov = 255.0 * 0.1;
        let resolved = resolve_accumulated_aa_alpha(partial_cov * 10.0, 0, 10);

        assert_eq!(
            resolved, 26,
            "fractional SSAA contributions should be rounded after accumulation, not truncated per sample"
        );
    }

    #[test]
    fn perturbation_rle_matches_mask_output() {
        let mut job = job_for_single_layer();
        job.anti_aliasing_level = "4x".to_string();
        job.anti_aliasing_mode = "Vertical2".to_string();
        job.blur_brush_radius_px = 0;
        job.zaa_kernel = Some("perturb".to_string());
        job.zaa_pattern = Some("uniform".to_string());

        let mut flat = Vec::<f32>::new();
        push_box_triangles(&mut flat, 0.0, 0.0, 0.0, 0.25, 18.0, 18.0);

        let mut triangles = parse_triangles(&flat);
        project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();

        let (mask, mask_stats) = rasterize_layer_with_stats(&job, &triangles, &indices, 0, true);
        let (runs, rle_stats) = rasterize_layer_rle(&job, &triangles, &indices, 0, true);
        let expanded = expand_rle_to_mask(&runs, mask.len());

        assert_eq!(
            expanded, mask,
            "perturbation RLE raster must match the full-mask perturbation output"
        );
        assert_eq!(rle_stats.total_solid_pixels, mask_stats.total_solid_pixels);
        assert_eq!(rle_stats.area_count, mask_stats.area_count);
        assert!(
            runs.iter().any(|run| run.value > 0 && run.value < 255),
            "perturbation RLE path should emit grayscale runs"
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
    // Direct 2-D definition, not a separable/ring-buffer implementation. The
    // source Y range is the ROI, while X taps may read beyond the output ROI.
    fn gaussian_definition(
        source: &[u8], width: usize, height: usize, radius: usize,
        sigma_x: f64, sigma_y: f64, min_alpha: u8,
        roi: (usize, usize, usize, usize),
    ) -> Vec<u8> {
        let weight = |distance: usize, sigma: f64| -> u128 {
            let sigma = sigma.max(0.05);
            (1024.0 * (-(distance as f64).powi(2) / (2.0 * sigma.powi(2))).exp())
                .round().max(1.0) as u128
        };
        let mut expected = vec![0; source.len()];
        for y in roi.2..=roi.3 {
            for x in roi.0..=roi.1 {
                let mut numerator = 0u128;
                let mut denominator = 0u128;
                for sy in y.saturating_sub(radius)..=y.saturating_add(radius).min(height - 1) {
                    for sx in x.saturating_sub(radius)..=x.saturating_add(radius).min(width - 1) {
                        let coefficient = weight(x.abs_diff(sx), sigma_x) * weight(y.abs_diff(sy), sigma_y);
                        denominator += coefficient;
                        if (roi.2..=roi.3).contains(&sy) {
                            numerator += source[sy * width + sx] as u128 * coefficient;
                        }
                    }
                }
                let value = ((numerator + denominator / 2) / denominator).min(255) as u8;
                expected[y * width + x] = if value < min_alpha { 0 } else { value };
            }
        }
        expected
    }

    #[test]
    fn gaussian_pixels_match_2d_definition_on_every_supported_backend() {
        let cases = [
            (1, 5, 3, 0.01, 1.1, (0, 0, 0, 4)),
            (3, 2, 4, 1.5, 0.3, (0, 2, 0, 1)),
            (37, 7, 2, 1.25, 1.8, (3, 35, 0, 5)),
            (73, 9, 3, 2.4, 0.7, (1, 67, 0, 8)),
            // Oversized radii leave only image-border denominators, including
            // varying-denominator vectors and an odd scalar tail.
            (17, 3, 127, 80.0, 0.7, (0, 16, 0, 2)),
            (17, 3, 128, 80.0, 0.7, (0, 16, 0, 2)),
            (17, 3, 257, 0.3, 160.0, (1, 15, 0, 2)),
            // Interior ROI lengths straddle the native 4/8/16-u32 widths;
            // each scratch row contains exactly full vectors or a scalar tail.
            (7, 5, 2, 1.25, 1.8, (2, 4, 0, 4)),
            (8, 5, 2, 1.25, 1.8, (2, 5, 0, 4)),
            (9, 5, 2, 1.25, 1.8, (2, 6, 0, 4)),
            (11, 5, 2, 1.25, 1.8, (2, 8, 0, 4)),
            (12, 5, 2, 1.25, 1.8, (2, 9, 0, 4)),
            (13, 5, 2, 1.25, 1.8, (2, 10, 0, 4)),
            (19, 5, 2, 1.25, 1.8, (2, 16, 0, 4)),
            (20, 5, 2, 1.25, 1.8, (2, 17, 0, 4)),
            (21, 5, 2, 1.25, 1.8, (2, 18, 0, 4)),
        ];
        for (width, height, radius, sigma_x, sigma_y, roi) in cases {
            // Asymmetric grayscale data also exercises nonzero source taps
            // outside a cropped output ROI and unaligned source-row starts.
            let source: Vec<u8> = (0..width * height)
                .map(|i| ((i * 47 + i / width * 13 + 11) % 256) as u8).collect();
            for min_alpha in [0, 64, 180, 255] {
                let expected = gaussian_definition(&source, width, height, radius, sigma_x, sigma_y, min_alpha, roi);
                for backend in crate::pulp_simd::Backend::supported_for_tests() {
                    let mut actual = source.clone();
                    super::apply_edge_gaussian_blur_to_mask_in_roi_with_backend(
                        &mut actual, width, height, radius, sigma_x, sigma_y, min_alpha,
                        roi.0, roi.1, roi.2, roi.3, backend,
                    );
                    assert_eq!(actual, expected, "Gaussian pixels: {width}x{height}, radius {radius}, floor {min_alpha}");
                }
            }
        }
    }

    #[test]
    fn gaussian_cropped_top_preserves_existing_attenuation() {
        // sigma=1 gives integer weights [1024, 621]. The omitted top source
        // row still contributes to the denominator; the second output retains
        // only the last ring row, matching the existing cropped-top behavior.
        let expected = [vec![0; 37], vec![185; 37], vec![159; 37]].concat();
        for backend in crate::pulp_simd::Backend::supported_for_tests() {
            let mut actual = vec![255; 37 * 3];
            super::apply_edge_gaussian_blur_to_mask_in_roi_with_backend(
                &mut actual, 37, 3, 1, 1.0, 1.0, 0, 0, 36, 1, 2, backend,
            );
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn gaussian_emission_preserves_saturation_large_denominators_and_alpha_ties() {
        let weight = u32::MAX;
        let weights = [weight, weight];
        for width in [1, 3, 7, 8, 9, 16, 17, 37] {
            let values = [u32::MAX, 0, 1, 127, 128, u32::MAX / 2, 2];
            let divisors = [1, u64::MAX, u64::MAX / 2, 3 * weight as u64,
                3 * weight as u64, 1, 3 * weight as u64];
            let row: Vec<u32> = (0..width).map(|x| values[x % values.len()]).collect();
            let ring: std::collections::VecDeque<_> = (0..3).map(|y| (y, row.clone())).collect();
            for uniform in [false, true] {
                let x_denoms: Vec<u64> = (0..width).map(|x| {
                    if uniform { 1 } else { divisors[x % divisors.len()] }
                }).collect();
                for min_alpha in [0, 127, 128, 255] {
                    let expected: Vec<u8> = row.iter().zip(&x_denoms).map(|(&value, &denom)| {
                        // Independent widened definition: accumulation saturates
                        // at u64::MAX, then exact rounding and byte clipping apply.
                        let sum = (3 * value as u128 * weight as u128).min(u64::MAX as u128) as u64;
                        let value = ((sum + denom / 2) / denom).min(255) as u8;
                        if value < min_alpha { 0 } else { value }
                    }).collect();
                    for backend in crate::pulp_simd::Backend::supported_for_tests() {
                        let mut actual = vec![0; width];
                        backend.dispatch(super::GaussianVerticalRow {
                            ring: &ring, output: &mut actual, out_y: 1, weights: &weights,
                            x_denoms: &x_denoms, y_denom: 1, uniform_start: 0,
                            uniform_end: if uniform { width } else { 1 },
                            uniform_divider: crate::pulp_simd::U64ByteDivider::new(1), min_alpha,
                        });
                        assert_eq!(actual, expected, "Gaussian emission: width {width}, floor {min_alpha}, {backend:?}");
                    }
                }
            }
        }
    }

    fn box_definition(source: &[u8], width: usize, height: usize, radius: usize, min_alpha: u8) -> Vec<u8> {
        let mut expected = vec![0; source.len()];
        for y in 0..height {
            for x in 0..width {
                let mut numerator = 0u64;
                let mut denominator = 0u64;
                for sy in y.saturating_sub(radius)..=y.saturating_add(radius).min(height - 1) {
                    for sx in x.saturating_sub(radius)..=x.saturating_add(radius).min(width - 1) {
                        numerator += source[sy * width + sx] as u64;
                        denominator += 1;
                    }
                }
                let value = ((numerator + denominator / 2) / denominator) as u8;
                expected[y * width + x] = if value < min_alpha { 0 } else { value };
            }
        }
        expected
    }

    #[test]
    fn box_pixels_rle_and_bounds_match_on_every_supported_backend() {
        for width in [1, 3, 4, 5, 7, 8, 9, 15, 16, 17, 37, 73] {
            let height = 9;
            let mut source = vec![0; width * height];
            for y in 2..7 {
                for x in 0..width {
                    if width <= 3 || (3..width - 2).contains(&x) {
                        source[y * width + x] = ((x * 47 + y * 13 + 11) % 256) as u8;
                    }
                }
            }
            let runs = encode_mask_to_rle(&source, width, height);
            for (radius, min_alpha) in [(1, 0), (2, 64), (5, 180)] {
                let expected = box_definition(&source, width, height, radius, min_alpha);
                let expected_runs = encode_mask_to_rle(&expected, width, height);
                let mut expected_bounds: Option<(usize, usize, usize, usize)> = None;
                for (i, &value) in expected.iter().enumerate() {
                    if value != 0 {
                        let (x, y) = (i % width, i / width);
                        expected_bounds = Some(match expected_bounds {
                            Some((a, b, c, d)) => (a.min(x), b.max(x), c.min(y), d.max(y)),
                            None => (x, x, y, y),
                        });
                    }
                }
                for backend in crate::pulp_simd::Backend::supported_for_tests() {
                    let mut actual = source.clone();
                    super::apply_edge_box_blur_to_mask_in_roi_with_backend(
                        &mut actual, width, height, radius, min_alpha, 0, width - 1, 0, height - 1, backend,
                    );
                    assert_eq!(actual, expected);
                    let (actual_runs, actual_bounds) = super::blur_gray_rle_streaming_with_bounds_and_backend(
                        &runs, width, height, radius, min_alpha, backend,
                    );
                    assert_eq!(actual_runs, expected_runs);
                    assert_eq!(actual_bounds, expected_bounds);
                }
            }
        }
    }

    #[test]
    fn parallel_box_pixels_match_2d_average_on_every_supported_backend() {
        let (width, height) = (1025, 977);
        let source: Vec<u8> = (0..width * height)
            .map(|i| ((i % width * 19 + i / width * 7) % 256) as u8).collect();
        let expected = box_definition(&source, width, height, 1, 64);
        for backend in crate::pulp_simd::Backend::supported_for_tests() {
            let mut actual = source.clone();
            super::apply_edge_box_blur_to_mask_in_roi_with_backend(
                &mut actual, width, height, 1, 64, 0, width - 1, 0, height - 1, backend,
            );
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn box_cropped_roi_retains_global_border_counts_on_every_backend() {
        let (width, height) = (37usize, 9usize);
        let roi = (5usize, 34usize, 2usize, 7usize);
        let source: Vec<u8> = (0..width * height)
            .map(|i| ((i * 47 + i / width * 13 + 11) % 256) as u8).collect();
        for radius in [1usize, 5, 128] {
            for min_alpha in [0, 64, 180] {
                let mut expected = source.clone();
                for y in roi.2..=roi.3 {
                    for x in roi.0..=roi.1 {
                        let left = x.saturating_sub(radius);
                        let right = x.saturating_add(radius).min(width - 1);
                        let top = y.saturating_sub(radius);
                        let bottom = y.saturating_add(radius).min(height - 1);
                        let denom = ((right - left + 1) * (bottom - top + 1)) as u64;
                        let mut sum = 0u64;
                        for sy in top.max(roi.2)..=bottom.min(roi.3) {
                            for sx in left.max(roi.0)..=right.min(roi.1) {
                                sum += source[sy * width + sx] as u64;
                            }
                        }
                        let value = ((sum + denom / 2) / denom).min(255) as u8;
                        expected[y * width + x] = if value < min_alpha { 0 } else { value };
                    }
                }
                for backend in crate::pulp_simd::Backend::supported_for_tests() {
                    let mut actual = source.clone();
                    super::apply_edge_box_blur_to_mask_in_roi_with_backend(
                        &mut actual, width, height, radius, min_alpha, roi.0, roi.1, roi.2, roi.3, backend,
                    );
                    assert_eq!(actual, expected, "cropped box: radius {radius}, floor {min_alpha}, {backend:?}");
                }
            }
        }
    }

    fn assert_box_stream_consumer(
        source: &[u8], width: usize, height: usize, radius: usize, min_alpha: u8, expected: &[u8],
    ) {
        let runs = encode_mask_to_rle(source, width, height);
        let expected_runs = encode_mask_to_rle(expected, width, height);
        let mut expected_bounds: Option<(usize, usize, usize, usize)> = None;
        for (i, &value) in expected.iter().enumerate() {
            if value != 0 {
                let (x, y) = (i % width, i / width);
                expected_bounds = Some(match expected_bounds {
                    Some((a, b, c, d)) => (a.min(x), b.max(x), c.min(y), d.max(y)),
                    None => (x, x, y, y),
                });
            }
        }
        for backend in crate::pulp_simd::Backend::supported_for_tests() {
            let (actual_runs, bounds) = super::blur_gray_rle_streaming_with_bounds_and_backend(
                &runs, width, height, radius, min_alpha, backend,
            );
            assert_eq!(expand_rle_to_mask(&actual_runs, width * height), expected,
                "streamed pixels: {width}x{height}, radius {radius}, floor {min_alpha}, {backend:?}");
            assert_eq!(actual_runs, expected_runs);
            assert_eq!(bounds, expected_bounds);
        }
    }

    #[test]
    fn box_stream_exact_tail_tiny_and_clipped_rows_match_every_backend() {
        for width in [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65] {
            for height in [1, 2, 9] {
                let source: Vec<u8> = (0..width * height)
                    .map(|i| (1 + (i % width * 47 + i / width * 13) % 255) as u8).collect();
                for (radius, min_alpha) in [(1, 0), (2, 64), (5, 180), (127, 0), (128, 180), (129, 255)] {
                    let expected = box_definition(&source, width, height, radius, min_alpha);
                    assert_box_stream_consumer(&source, width, height, radius, min_alpha, &expected);
                }
            }
        }
        // Exact and tail ROI widths with zero padding on every image edge.
        // Also clip the expanded support against the left/top and right/bottom.
        for roi_w in [5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65] {
            let (width, height) = (roi_w + 16, 15);
            for (left, top) in [(9, 6), (0, 0), (width - roi_w + 4, 12)] {
                let mut source = vec![0; width * height];
                for y in top..top + 3 {
                    for x in left..left + roi_w - 4 {
                        source[y * width + x] = (32 + (x * 47 + y * 13) % 224) as u8;
                    }
                }
                for min_alpha in [0, 64, 180] {
                    let expected = box_definition(&source, width, height, 2, min_alpha);
                    assert_box_stream_consumer(&source, width, height, 2, min_alpha, &expected);
                }
            }
        }
        let zero = vec![0; 33 * 3];
        assert_box_stream_consumer(&zero, 33, 3, 2, 64, &zero);
        let source = vec![1; 17 * 2];
        assert_box_stream_consumer(&source, 17, 2, 0, 180, &source);
    }

    // Independent prefix-sum reference for the preserved oversized-radius
    // contract: add full horizontal sums, but evict their u16 ring values.
    fn box_ring_precision_definition(
        source: &[u8], width: usize, height: usize, radius: usize, min_alpha: u8,
    ) -> Vec<u8> {
        let mut horizontal = vec![0u32; source.len()];
        let mut row_prefix = vec![0u32; width + 1];
        for y in 0..height {
            for x in 0..width {
                row_prefix[x + 1] = row_prefix[x] + source[y * width + x] as u32;
            }
            for x in 0..width {
                let left = x.saturating_sub(radius);
                let right = (x + radius + 1).min(width);
                horizontal[y * width + x] = row_prefix[right] - row_prefix[left];
            }
        }
        let mut expected = vec![0; source.len()];
        let mut full_prefix = vec![0u64; height + 1];
        let mut truncated_prefix = vec![0u64; height + 1];
        for x in 0..width {
            for y in 0..height {
                let sum = horizontal[y * width + x];
                full_prefix[y + 1] = full_prefix[y] + sum as u64;
                truncated_prefix[y + 1] = truncated_prefix[y] + (sum as u16) as u64;
            }
            let h_denom = 1 + radius.min(x) + radius.min(width - 1 - x);
            for y in 0..height {
                let top = y.saturating_sub(radius);
                let bottom = (y + radius + 1).min(height);
                let numerator = full_prefix[bottom] - truncated_prefix[top];
                let denom = (h_denom * (bottom - top)) as u64;
                let value = ((numerator + denom / 2) / denom).min(255) as u8;
                expected[y * width + x] = if value < min_alpha { 0 } else { value };
            }
        }
        expected
    }

    #[test]
    fn box_stream_radius_127_128_129_preserves_ring_eviction_precision() {
        for radius in [127, 128, 129] {
            for width in [255, 256, 257, 258, 259, 260, 271, 272, 273] {
                let height = 2 * radius + 3;
                let source: Vec<u8> = (0..width * height).map(|i| {
                    if i / width <= radius { 255 } else { (32 + (i % width * 19 + i / width * 7) % 160) as u8 }
                }).collect();
                for min_alpha in [0, 180] {
                    let expected = box_ring_precision_definition(&source, width, height, radius, min_alpha);
                    assert_box_stream_consumer(&source, width, height, radius, min_alpha, &expected);
                }
            }
        }
    }

    #[test]
    fn large_box_radius_retains_full_addition_before_u16_eviction() {
        // A 259-pixel sum of 255 is 66045, exceeding u16. Ring storage may
        // truncate it, but sequential/streaming additions must not truncate it.
        let (width, height) = (259, 2);
        let source = vec![255; width * height];
        let runs = encode_mask_to_rle(&source, width, height);
        for backend in crate::pulp_simd::Backend::supported_for_tests() {
            let mut actual = source.clone();
            super::apply_edge_box_blur_to_mask_in_roi_with_backend(
                &mut actual, width, height, 129, 0, 0, width - 1, 0, height - 1, backend,
            );
            assert_eq!(actual, source);
            let (actual_runs, bounds) = super::blur_gray_rle_streaming_with_bounds_and_backend(
                &runs, width, height, 129, 0, backend,
            );
            assert_eq!(actual_runs, runs);
            assert_eq!(bounds, Some((0, width - 1, 0, height - 1)));
        }
    }

    #[test]
    fn sparse_ring_flush_matches_multi_island_halo_rle_bit_for_bit() {
        let width = 256usize;
        let height = 128usize;
        let pitch_mm = 0.025f32;
        let mut mask = vec![0u8; width * height];

        let mut stamp_square = |cx: usize, cy: usize, size: usize| {
            let x0 = cx - size / 2;
            let y0 = cy - size / 2;
            for y in y0..(y0 + size) {
                for x in x0..(x0 + size) {
                    mask[y * width + x] = 255;
                }
            }
        };

        // 1. Two widely separated thin tips on the same row band (y ~ 20) to exercise wide roi_w with sparse active columns
        stamp_square(24, 20, 8);   // 0.20 mm tip on far left
        stamp_square(232, 20, 12); // 0.30 mm tip on far right
        // 2. Disconnected thin tip after a large vertical empty row gap (y ~ 64)
        stamp_square(128, 64, 16); // 0.40 mm tip in center
        // 3. Wide raft/trunk at bottom (y ~ 102, 48x20 px = 1.20x0.50 mm >= D_max) that must emit zero halo
        for y in 92..112 {
            for x in 40..88 {
                mask[y * width + x] = 255;
            }
        }

        let support_runs = encode_mask_to_rle(&mask, width, height);
        let job = SliceJobV3 {
            source_width_px: width as u32,
            source_height_px: height as u32,
            width_px: width as u32,
            height_px: height as u32,
            build_width_mm: (width as f32) * pitch_mm,
            build_depth_mm: (height as f32) * pitch_mm,
            support_halo_enabled: true,
            support_halo_radius_px: 6,
            support_halo_max_intensity_percent: 25.0,
            support_halo_profile: "donut".to_string(),
            support_halo_scope: "tips_only".to_string(),
            support_halo_max_tip_diameter_mm: 0.80,
            dither_device_gamma: 3.0,
            ..Default::default()
        };

        let precalc = super::SupportHaloPrecalc::from_job(&job, None)
            .expect("precalc should be active");

        let runs_first = super::apply_euclidean_radial_halo_rle_with_precalc(
            &support_runs,
            width,
            height,
            &precalc,
        );
        // Exercise thread-local scratch reuse across an empty layer and a second pass
        let empty_runs = encode_mask_to_rle(&vec![0u8; width * height], width, height);
        let empty_halo = super::apply_euclidean_radial_halo_rle_with_precalc(
            &empty_runs,
            width,
            height,
            &precalc,
        );
        assert_eq!(expand_rle_to_mask(&empty_halo, width * height), vec![0u8; width * height]);

        let runs_second = super::apply_euclidean_radial_halo_rle_with_precalc(
            &support_runs,
            width,
            height,
            &precalc,
        );
        assert_eq!(
            runs_first, runs_second,
            "repeated halo RLE evaluation with thread-local scratch reuse must be bit-identical"
        );

        let total_len: usize = runs_first.iter().map(|r| r.length as usize).sum();
        assert_eq!(total_len, width * height, "RLE run lengths must sum to exact frame pixel count");

        let out = expand_rle_to_mask(&runs_first, width * height);
        // Core pixels preserved
        for (idx, &src) in mask.iter().enumerate() {
            if src == 255 {
                assert_eq!(out[idx], 255, "core pixel at {idx} lost 255");
            }
        }
        // Empty gap between left tip (x=24) and right tip (x=232) on row 20 must remain 0
        assert!(out[20 * width + 60..20 * width + 190].iter().all(|&v| v == 0));
        // Empty row band between y=35 and y=50 must remain 0
        assert!(out[35 * width..50 * width].iter().all(|&v| v == 0));
        // Wide raft at y=92..112, x=40..88 must have zero halo collar around it
        assert_eq!(out[90 * width + 64], 0);
        assert_eq!(out[113 * width + 64], 0);
        assert_eq!(out[100 * width + 38], 0);
        assert_eq!(out[100 * width + 90], 0);
    }
}

