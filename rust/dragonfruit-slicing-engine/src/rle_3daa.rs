//! RLE-native 3D Anti-Aliasing (3DAA) z-blend.
//!
//! Replaces the post-rasterization BFS / EDT approach with a streaming
//! per-scanline algorithm that requires O(look_back × intervals_per_row)
//! working memory — no full-image pixel buffers.
//!
//! # Algorithm overview
//!
//! For each scanline `y` in the current layer:
//!
//! 1. Retrieve current-layer solid intervals from `current_topo`.
//! 2. Compute the union of all prior layers' solid intervals at `y`.
//! 3. Compute the union of all future layers' solid intervals at `y`.
//! 4. "Blend zone" = (prior_union ∪ future_union) − current.
//!    These are pixels that appear in adjacent layers but not the current one.
//! 5. For each blend-zone pixel compute the 2-D Euclidean distance to the
//!    nearest current-layer solid pixel (across nearby rows).
//! 6. Convert distance → alpha through the cure-window LUT.
//! 7. Emit a grayscale RLE row:  current pixels → 255, blend pixels → alpha,
//!    all others → 0.
//!
//! Memory per layer: O(intervals) ≈ 150 KB average at 12K,
//! versus the 59 MB full-frame pixel buffer it replaces.

use crate::rle::{RleAccum, RleRun};

// ---------------------------------------------------------------------------
// RleTopology
// ---------------------------------------------------------------------------

/// Row-indexed binary occupancy map built from a binary RLE.
///
/// For a 12K × 5K layer at 20% fill the resident cost is typically ~150 KB —
/// compare with the 59 MB full-frame pixel buffer the old BFS approach needed.
pub struct RleTopology {
    width: usize,
    height: usize,
    /// `row_offsets[y] .. row_offsets[y+1]` indexes into `intervals`.
    row_offsets: Vec<u32>,
    /// (start_x, end_x) inclusive pairs, sorted, non-overlapping within each row.
    intervals: Vec<(u32, u32)>,
}

impl RleTopology {
    /// Build from binary `runs` (any value > 0 treated as solid).
    ///
    /// Handles RLE runs that span row boundaries correctly.
    pub fn from_binary_rle(runs: &[RleRun], width: usize, height: usize) -> Self {
        if width == 0 || height == 0 {
            let row_offsets = vec![0u32; height + 1];
            return Self {
                width,
                height,
                row_offsets,
                intervals: Vec::new(),
            };
        }

        let total = width.saturating_mul(height);
        let mut row_offsets: Vec<u32> = Vec::with_capacity(height + 1);
        let mut intervals: Vec<(u32, u32)> = Vec::new();

        row_offsets.push(0u32); // row 0 starts at offset 0

        let mut abs_pos = 0usize;
        let mut col = 0usize; // current x within current row
        let mut row = 0usize;
        let mut in_solid = false;
        let mut solid_start = 0u32;

        'outer: for run in runs {
            if abs_pos >= total {
                break;
            }
            let run_end = (abs_pos + run.length as usize).min(total);
            let solid = run.value > 0;
            let mut pos = abs_pos;

            while pos < run_end {
                let row_remaining = width - col;
                let seg_len = row_remaining.min(run_end - pos);

                if solid {
                    if !in_solid {
                        solid_start = col as u32;
                        in_solid = true;
                    }
                } else if in_solid {
                    // Interval closes at the pixel before this empty segment.
                    intervals.push((solid_start, (col - 1) as u32));
                    in_solid = false;
                }

                col += seg_len;
                pos += seg_len;

                if col >= width {
                    // Row boundary: close any open interval for this row.
                    if in_solid {
                        intervals.push((solid_start, (width - 1) as u32));
                        // Carry in_solid over to next row only if the run continues.
                        in_solid = pos < run_end;
                        solid_start = 0; // if still solid, next row starts at x=0
                    }
                    col = 0;
                    row += 1;
                    if row >= height {
                        in_solid = false;
                        break 'outer;
                    }
                    row_offsets.push(intervals.len() as u32);
                }
            }

            abs_pos = run_end;
        }

        // Close any trailing open interval (last row, partial fill).
        if in_solid && row < height && col > 0 {
            intervals.push((solid_start, (col - 1) as u32));
        }

        // Fill remaining row_offsets sentinels up to `height + 1`.
        while row_offsets.len() <= height {
            row_offsets.push(intervals.len() as u32);
        }

        Self {
            width,
            height,
            row_offsets,
            intervals,
        }
    }

    /// Solid intervals for row `y`, sorted by start_x.
    #[inline]
    pub fn row_intervals(&self, y: usize) -> &[(u32, u32)] {
        if y >= self.height {
            return &[];
        }
        let s = self.row_offsets[y] as usize;
        let e = self.row_offsets[y + 1] as usize;
        &self.intervals[s..e]
    }

    /// Approximate heap bytes used by this topology.
    pub fn resident_bytes(&self) -> usize {
        self.row_offsets.len() * 4 + self.intervals.len() * 8
    }

    pub fn width(&self) -> usize {
        self.width
    }
    pub fn height(&self) -> usize {
        self.height
    }
}

// ---------------------------------------------------------------------------
// Interval arithmetic helpers
// ---------------------------------------------------------------------------

/// Merge-union a collection of sorted interval slices into `scratch`.
///
/// `scratch` is cleared first; on return it contains sorted, non-overlapping
/// merged intervals covering the union of all inputs.
fn union_intervals_into(sources: &[&[(u32, u32)]], scratch: &mut Vec<(u32, u32)>) {
    scratch.clear();
    for &src in sources {
        scratch.extend_from_slice(src);
    }
    if scratch.len() <= 1 {
        return;
    }
    scratch.sort_unstable_by_key(|&(s, _)| s);
    let mut write = 0usize;
    for read in 1..scratch.len() {
        let (r0, r1) = scratch[read];
        // Intervals are adjacent (touching) or overlapping → merge.
        if r0 <= scratch[write].1.saturating_add(1) {
            if r1 > scratch[write].1 {
                scratch[write].1 = r1;
            }
        } else {
            write += 1;
            scratch[write] = (r0, r1);
        }
    }
    scratch.truncate(write + 1);
}

/// Compute `a − b` (set-difference of sorted interval lists) into `output`.
///
/// Both `a` and `b` must be sorted and non-overlapping. `output` is cleared
/// first; on return it contains the sorted, non-overlapping intervals of
/// pixels that appear in `a` but not in `b`.
fn subtract_intervals(a: &[(u32, u32)], b: &[(u32, u32)], output: &mut Vec<(u32, u32)>) {
    output.clear();
    if a.is_empty() {
        return;
    }
    if b.is_empty() {
        output.extend_from_slice(a);
        return;
    }

    let mut bi = 0usize;
    for &(a0, a1) in a {
        let mut start = a0;
        // Advance past b-intervals that end strictly before `start`.
        while bi < b.len() && b[bi].1 < start {
            bi += 1;
        }
        // Walk b-intervals that overlap [start, a1].
        let mut j = bi;
        while j < b.len() && b[j].0 <= a1 {
            let (b0, b1) = b[j];
            if b0 > start {
                output.push((start, b0 - 1));
            }
            start = b1.saturating_add(1);
            if start > a1 {
                break;
            }
            j += 1;
        }
        if start <= a1 {
            output.push((start, a1));
        }
    }
}

// ---------------------------------------------------------------------------
// Distance → alpha
// ---------------------------------------------------------------------------

/// Convert a pixel distance (0 = at boundary, ≥ fade_px → 0) to alpha.
///
/// Formula: `raw = (fade_px − dist) * 255 / fade_px`, then optionally remapped
/// through `lut`. This matches the cure-window LUT convention used by the rest
/// of the z-blend pipeline.
#[cfg(test)]
#[inline]
fn dist_to_alpha(dist: u32, fade_px: u32, lut: Option<&[u8; 256]>) -> u8 {
    if dist >= fade_px {
        return 0;
    }
    let raw = ((fade_px - dist) * 255 / fade_px.max(1)) as usize;
    let raw = raw.min(255);
    match lut {
        Some(l) => l[raw],
        None => raw as u8,
    }
}

// ---------------------------------------------------------------------------
// Main blend function
// ---------------------------------------------------------------------------

/// Apply 3DAA z-blend to `current_topo`, returning a grayscale RLE.
///
/// EDT-like blend over adjacent-layer occupancy.
///
/// - `prior_topos` and `future_topos` are adjacent layers inside the caller's
///   z-window (e.g. `look_back`). Their per-row union defines where blend is
///   allowed.
/// - Solid current-layer pixels → 255.
/// - Pixels in adjacent-layer union but not in current are flood-filled from
///   current-boundary seeds (4-neighbor), then graded per connected component
///   using normalized distance `t = d / max_d_component` (same style as the
///   EDT-era component normalization).
/// - `fade_px` remains a hard cutoff (`d > fade_px` => 0).
/// - All other pixels → 0.
pub fn blend_3daa_rle(
    current_topo: &RleTopology,
    prior_topos: &[&RleTopology],
    future_topos: &[&RleTopology],
    width: usize,
    height: usize,
    fade_px: u32,
    lut: Option<&[u8; 256]>,
) -> Vec<RleRun> {
    use std::collections::VecDeque;

    let mut out = RleAccum::new();

    if prior_topos.is_empty() && future_topos.is_empty() {
        // Pure binary pass-through.
        for y in 0..height {
            emit_row_binary(current_topo.row_intervals(y), width, &mut out);
        }
        return out.finish();
    }

    // Build blend-zone intervals for all rows first. We need full 2D
    // connectivity (components can span rows) before emitting final alphas.
    let mut row_blend: Vec<Vec<(u32, u32)>> = vec![Vec::new(); height];
    let mut adj_src: Vec<&[(u32, u32)]> =
        Vec::with_capacity(prior_topos.len() + future_topos.len());
    let mut adj_union: Vec<(u32, u32)> = Vec::new();
    let mut has_blend = false;
    let mut blend_min_x = width;
    let mut blend_max_x = 0usize;
    let mut blend_min_y = height;
    let mut blend_max_y = 0usize;

    for y in 0..height {
        let cur = current_topo.row_intervals(y);

        // Union all adjacent occupancy at this row (caller already restricts
        // how many layers are included in `prior_topos` / `future_topos`).
        adj_src.clear();
        for t in prior_topos {
            let iv = t.row_intervals(y);
            if !iv.is_empty() {
                adj_src.push(iv);
            }
        }
        for t in future_topos {
            let iv = t.row_intervals(y);
            if !iv.is_empty() {
                adj_src.push(iv);
            }
        }
        if adj_src.is_empty() {
            continue;
        }

        union_intervals_into(&adj_src, &mut adj_union);
        subtract_intervals(&adj_union, cur, &mut row_blend[y]);

        if !row_blend[y].is_empty() {
            has_blend = true;
            blend_min_y = blend_min_y.min(y);
            blend_max_y = blend_max_y.max(y);
            for &(s, e) in &row_blend[y] {
                blend_min_x = blend_min_x.min(s as usize);
                blend_max_x = blend_max_x.max(e as usize);
            }
        }
    }

    if !has_blend {
        for y in 0..height {
            emit_row_binary(current_topo.row_intervals(y), width, &mut out);
        }
        return out.finish();
    }

    // ROI around blend zone, expanded by one pixel for seed-neighbor checks.
    let roi_min_x = blend_min_x.saturating_sub(1);
    let roi_max_x = (blend_max_x + 1).min(width.saturating_sub(1));
    let roi_min_y = blend_min_y.saturating_sub(1);
    let roi_max_y = (blend_max_y + 1).min(height.saturating_sub(1));
    let roi_w = roi_max_x - roi_min_x + 1;
    let roi_h = roi_max_y - roi_min_y + 1;
    let roi_len = roi_w * roi_h;

    // ROI-local masks.
    let mut zone = vec![0u8; roi_len];
    let mut cur_mask = vec![0u8; roi_len];

    // Fill current mask in ROI.
    for y in roi_min_y..=roi_max_y {
        let ry = y - roi_min_y;
        let row_off = ry * roi_w;
        for &(s, e) in current_topo.row_intervals(y) {
            let s = s as usize;
            let e = e as usize;
            if e < roi_min_x || s > roi_max_x {
                continue;
            }
            let cs = s.max(roi_min_x);
            let ce = e.min(roi_max_x);
            for x in cs..=ce {
                cur_mask[row_off + (x - roi_min_x)] = 1;
            }
        }
    }

    // Fill blend-zone mask in ROI.
    for y in blend_min_y..=blend_max_y {
        let ry = y - roi_min_y;
        let row_off = ry * roi_w;
        for &(s, e) in &row_blend[y] {
            let s = s as usize;
            let e = e as usize;
            if e < roi_min_x || s > roi_max_x {
                continue;
            }
            let zs = s.max(roi_min_x);
            let ze = e.min(roi_max_x);
            for x in zs..=ze {
                zone[row_off + (x - roi_min_x)] = 1;
            }
        }
    }

    // Seeded BFS distance through blend zone.
    let mut dist = vec![0u16; roi_len];
    let mut queue: VecDeque<usize> = VecDeque::new();

    for y in blend_min_y..=blend_max_y {
        let ry = y - roi_min_y;
        let row_off = ry * roi_w;
        for &(s, e) in &row_blend[y] {
            for x in (s as usize)..=(e as usize) {
                let rx = x - roi_min_x;
                let idx = row_off + rx;
                if zone[idx] == 0 {
                    continue;
                }
                let left = rx > 0 && cur_mask[idx - 1] != 0;
                let right = rx + 1 < roi_w && cur_mask[idx + 1] != 0;
                let up = ry > 0 && cur_mask[idx - roi_w] != 0;
                let down = ry + 1 < roi_h && cur_mask[idx + roi_w] != 0;
                if left || right || up || down {
                    dist[idx] = 1;
                    queue.push_back(idx);
                }
            }
        }
    }

    // Expand through the full connected blend zone to obtain component extent.
    while let Some(idx) = queue.pop_front() {
        let d = dist[idx];
        let nd = d.saturating_add(1);
        let ry = idx / roi_w;
        let rx = idx % roi_w;

        if rx > 0 {
            let n = idx - 1;
            if zone[n] != 0 && dist[n] == 0 {
                dist[n] = nd;
                queue.push_back(n);
            }
        }
        if rx + 1 < roi_w {
            let n = idx + 1;
            if zone[n] != 0 && dist[n] == 0 {
                dist[n] = nd;
                queue.push_back(n);
            }
        }
        if ry > 0 {
            let n = idx - roi_w;
            if zone[n] != 0 && dist[n] == 0 {
                dist[n] = nd;
                queue.push_back(n);
            }
        }
        if ry + 1 < roi_h {
            let n = idx + roi_w;
            if zone[n] != 0 && dist[n] == 0 {
                dist[n] = nd;
                queue.push_back(n);
            }
        }
    }

    // Connected-component labels on reachable blend pixels (dist > 0).
    let mut labels = vec![0u32; roi_len];
    let mut comp_max_dist: Vec<u16> = vec![0u16]; // index 0 unused
    let mut next_label: u32 = 0;

    for idx in 0..roi_len {
        if dist[idx] == 0 || labels[idx] != 0 {
            continue;
        }
        next_label += 1;
        let label = next_label;
        labels[idx] = label;
        queue.push_back(idx);
        let mut max_d = dist[idx];

        while let Some(p) = queue.pop_front() {
            let d = dist[p];
            if d > max_d {
                max_d = d;
            }

            let ry = p / roi_w;
            let rx = p % roi_w;
            if rx > 0 {
                let n = p - 1;
                if dist[n] > 0 && labels[n] == 0 {
                    labels[n] = label;
                    queue.push_back(n);
                }
            }
            if rx + 1 < roi_w {
                let n = p + 1;
                if dist[n] > 0 && labels[n] == 0 {
                    labels[n] = label;
                    queue.push_back(n);
                }
            }
            if ry > 0 {
                let n = p - roi_w;
                if dist[n] > 0 && labels[n] == 0 {
                    labels[n] = label;
                    queue.push_back(n);
                }
            }
            if ry + 1 < roi_h {
                let n = p + roi_w;
                if dist[n] > 0 && labels[n] == 0 {
                    labels[n] = label;
                    queue.push_back(n);
                }
            }
        }

        comp_max_dist.push(max_d);
    }

    // Sweep-emit this row by interleaving current solids (255), blend-zone
    // pixels (component-normalized gradient), and zero gaps.
    for y in 0..height {
        let cur = current_topo.row_intervals(y);
        let blend_zone = &row_blend[y];
        let mut col = 0u32;
        let w = width as u32;
        let mut ci = 0usize;
        let mut bi = 0usize;

        while col < w {
            let nc = cur.get(ci).map(|&(s, _)| s).unwrap_or(w);
            let nb = blend_zone.get(bi).map(|&(s, _)| s).unwrap_or(w);
            let next_start = nc.min(nb);

            if next_start >= w {
                break;
            }

            if next_start > col {
                out.push_run(next_start - col, 0);
                col = next_start;
            }

            if nc <= nb {
                let (s, e) = cur[ci];
                debug_assert_eq!(s, col);
                out.push_run(e - s + 1, 255);
                col = e + 1;
                ci += 1;
            } else {
                let (s, e) = blend_zone[bi];
                debug_assert_eq!(s, col);
                for x in s..=e {
                    let idx = (y - roi_min_y) * roi_w + (x as usize - roi_min_x);
                    let d = dist[idx] as u32;
                    let alpha = if d == 0 || d > fade_px {
                        0
                    } else {
                        let lbl = labels[idx] as usize;
                        let max_d = comp_max_dist.get(lbl).copied().unwrap_or(1).max(1) as f32;
                        let t = (d as f32 / max_d).clamp(0.0, 1.0);
                        let raw = ((1.0 - t) * 255.0 + 0.5) as usize;
                        match lut {
                            Some(l) => l[raw.min(255)],
                            None => raw.min(255) as u8,
                        }
                    };
                    out.push_run(1, alpha);
                }
                col = e + 1;
                bi += 1;
            }
        }

        if col < w {
            out.push_run(w - col, 0);
        }
    }

    out.finish()
}

// ---------------------------------------------------------------------------
// Row-emission helpers
// ---------------------------------------------------------------------------

/// Emit one scanline as binary (solid=255 / empty=0).
fn emit_row_binary(intervals: &[(u32, u32)], width: usize, out: &mut RleAccum) {
    let mut col = 0u32;
    for &(s, e) in intervals {
        if s > col {
            out.push_run(s - col, 0);
        }
        out.push_run(e - s + 1, 255);
        col = e + 1;
    }
    let w = width as u32;
    if col < w {
        out.push_run(w - col, 0);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_runs(pairs: &[(u32, u8)]) -> Vec<RleRun> {
        pairs
            .iter()
            .map(|&(length, value)| RleRun { length, value })
            .collect()
    }

    // ── RleTopology::from_binary_rle ─────────────────────────────────────────

    #[test]
    fn topology_empty() {
        let topo = RleTopology::from_binary_rle(&[], 4, 2);
        assert_eq!(topo.row_intervals(0), &[]);
        assert_eq!(topo.row_intervals(1), &[]);
    }

    #[test]
    fn topology_all_solid_one_row() {
        // width=4 height=1, one solid run of length 4
        let runs = make_runs(&[(4, 255)]);
        let topo = RleTopology::from_binary_rle(&runs, 4, 1);
        assert_eq!(topo.row_intervals(0), &[(0, 3)]);
    }

    #[test]
    fn topology_partial_row() {
        // width=4, row = [ solid(2), empty(2) ]
        let runs = make_runs(&[(2, 255), (2, 0)]);
        let topo = RleTopology::from_binary_rle(&runs, 4, 1);
        assert_eq!(topo.row_intervals(0), &[(0, 1)]);
    }

    #[test]
    fn topology_run_crosses_row_boundary() {
        // width=4, height=2, solid run of 6 then empty run of 2
        // Row 0: solid 0..3  (full row)
        // Row 1: solid 0..1, then empty 2..3
        let runs = make_runs(&[(6, 255), (2, 0)]);
        let topo = RleTopology::from_binary_rle(&runs, 4, 2);
        assert_eq!(topo.row_intervals(0), &[(0, 3)]);
        assert_eq!(topo.row_intervals(1), &[(0, 1)]);
    }

    #[test]
    fn topology_solid_exactly_fills_row_then_empty() {
        // Solid run ends exactly at row boundary; next row is empty.
        let runs = make_runs(&[(4, 255), (4, 0)]);
        let topo = RleTopology::from_binary_rle(&runs, 4, 2);
        assert_eq!(topo.row_intervals(0), &[(0, 3)]);
        assert_eq!(topo.row_intervals(1), &[]);
    }

    #[test]
    fn topology_multi_interval_per_row() {
        // width=6, row = solid(2), empty(1), solid(2), empty(1)
        let runs = make_runs(&[(2, 255), (1, 0), (2, 255), (1, 0)]);
        let topo = RleTopology::from_binary_rle(&runs, 6, 1);
        assert_eq!(topo.row_intervals(0), &[(0, 1), (3, 4)]);
    }

    #[test]
    fn topology_multi_row_span() {
        // width=4, height=3, entire image is solid
        let runs = make_runs(&[(12, 255)]);
        let topo = RleTopology::from_binary_rle(&runs, 4, 3);
        assert_eq!(topo.row_intervals(0), &[(0, 3)]);
        assert_eq!(topo.row_intervals(1), &[(0, 3)]);
        assert_eq!(topo.row_intervals(2), &[(0, 3)]);
    }

    // ── subtract_intervals ───────────────────────────────────────────────────

    #[test]
    fn subtract_empty_b() {
        let a = vec![(0u32, 5u32), (10, 15)];
        let b: Vec<(u32, u32)> = vec![];
        let mut out = vec![];
        subtract_intervals(&a, &b, &mut out);
        assert_eq!(out, vec![(0, 5), (10, 15)]);
    }

    #[test]
    fn subtract_partial_overlap() {
        let a = vec![(0u32, 10u32)];
        let b = vec![(3u32, 6u32)];
        let mut out = vec![];
        subtract_intervals(&a, &b, &mut out);
        assert_eq!(out, vec![(0, 2), (7, 10)]);
    }

    #[test]
    fn subtract_multiple_b_in_one_a() {
        let a = vec![(0u32, 20u32)];
        let b = vec![(3u32, 5u32), (8, 10), (15, 17)];
        let mut out = vec![];
        subtract_intervals(&a, &b, &mut out);
        assert_eq!(out, vec![(0, 2), (6, 7), (11, 14), (18, 20)]);
    }

    // ── union_intervals_into ─────────────────────────────────────────────────

    #[test]
    fn union_disjoint() {
        let a: &[(u32, u32)] = &[(0, 3)];
        let b: &[(u32, u32)] = &[(5, 8)];
        let mut scratch = vec![];
        union_intervals_into(&[a, b], &mut scratch);
        assert_eq!(scratch, vec![(0, 3), (5, 8)]);
    }

    #[test]
    fn union_overlapping() {
        let a: &[(u32, u32)] = &[(0, 5)];
        let b: &[(u32, u32)] = &[(3, 8)];
        let mut scratch = vec![];
        union_intervals_into(&[a, b], &mut scratch);
        assert_eq!(scratch, vec![(0, 8)]);
    }

    #[test]
    fn union_adjacent_merged() {
        let a: &[(u32, u32)] = &[(0, 3)];
        let b: &[(u32, u32)] = &[(4, 7)];
        let mut scratch = vec![];
        union_intervals_into(&[a, b], &mut scratch);
        assert_eq!(scratch, vec![(0, 7)]);
    }

    // ── dist_to_alpha ────────────────────────────────────────────────────────

    #[test]
    fn dist_to_alpha_at_boundary() {
        assert_eq!(dist_to_alpha(0, 8, None), 255); // at boundary → full alpha
    }

    #[test]
    fn dist_to_alpha_at_fade_limit() {
        assert_eq!(dist_to_alpha(8, 8, None), 0); // at or beyond fade → 0
        assert_eq!(dist_to_alpha(100, 8, None), 0);
    }

    #[test]
    fn dist_to_alpha_midpoint() {
        // dist=4, fade_px=8 → raw = (8-4)*255/8 = 127
        assert_eq!(dist_to_alpha(4, 8, None), 127);
    }

    // ── blend_3daa_rle ───────────────────────────────────────────────────────

    fn rle_to_pixels(runs: &[RleRun]) -> Vec<u8> {
        let mut out = Vec::new();
        for r in runs {
            for _ in 0..r.length {
                out.push(r.value);
            }
        }
        out
    }

    #[test]
    fn blend_no_adjacent_layers_is_binary() {
        // width=4, height=1, solid pixels 1..2
        let cur_runs = make_runs(&[(1, 0), (2, 255), (1, 0)]);
        let cur_topo = RleTopology::from_binary_rle(&cur_runs, 4, 1);
        let result = blend_3daa_rle(&cur_topo, &[], &[], 4, 1, 8, None);
        assert_eq!(rle_to_pixels(&result), vec![0, 255, 255, 0]);
    }

    #[test]
    fn blend_full_solid_current_no_blend_zone() {
        // If prior == current, blend zone is empty; output is binary 255.
        let runs = make_runs(&[(4, 255)]);
        let cur_topo = RleTopology::from_binary_rle(&runs, 4, 1);
        let prior_topo = RleTopology::from_binary_rle(&runs, 4, 1);
        let result = blend_3daa_rle(&cur_topo, &[&prior_topo], &[], 4, 1, 8, None);
        assert_eq!(rle_to_pixels(&result), vec![255, 255, 255, 255]);
    }

    #[test]
    fn blend_receding_geometry_right_edge() {
        // Prior has solid x=0..3 (whole row); current has solid x=0..1.
        // Blend zone: x=2..3. 2-D distance to current edge x=1 gives:
        // x=2 => dist=1 (higher alpha), x=3 => dist=2 (lower alpha).
        let prior_runs = make_runs(&[(4, 255)]);
        let cur_runs = make_runs(&[(2, 255), (2, 0)]);
        let prior_topo = RleTopology::from_binary_rle(&prior_runs, 4, 1);
        let cur_topo = RleTopology::from_binary_rle(&cur_runs, 4, 1);
        let result = blend_3daa_rle(&cur_topo, &[&prior_topo], &[], 4, 1, 4, None);
        let px = rle_to_pixels(&result);
        assert_eq!(px[0], 255); // current solid
        assert_eq!(px[1], 255); // current solid
        assert!(px[2] > px[3]);
        assert!(px[2] > 0);
        assert_eq!(px[3], 0);
    }

    #[test]
    fn blend_zone_respects_fade_distance() {
        // Prior has solid x=0..3; current has only x=0..0.
        // With fade_px=2:
        // component-normalized distances are [1,2,3] over x=[1,2,3], so
        // x=1 has higher alpha than x=2, and x=3 is cut by fade.
        let w = 10usize;
        let prior_runs = make_runs(&[(4, 255), (6, 0)]);
        let cur_runs = make_runs(&[(1, 255), (9, 0)]);
        let prior_topo = RleTopology::from_binary_rle(&prior_runs, w, 1);
        let cur_topo = RleTopology::from_binary_rle(&cur_runs, w, 1);
        let result = blend_3daa_rle(&cur_topo, &[&prior_topo], &[], w, 1, 2, None);
        let px = rle_to_pixels(&result);
        assert_eq!(px[0], 255); // current solid
        assert!(px[1] > px[2]);
        assert!(px[2] > 0);
        assert_eq!(px[3], 0);
        for &v in &px[4..] {
            assert_eq!(v, 0);
        }
    }

    #[test]
    fn blend_union_across_depth_is_xy_blended() {
        // Adjacent layers are unioned first, then per-component normalization
        // controls alpha (so different connected components can have different
        // slopes even for equal geometric distance to current).
        // width=8, height=1, current: x=4 only.
        // prior[0]: x=3..5, prior[1]: x=1..6.
        // Distances to current x=4 become:
        // x=3/5 => 1, x=2/6 => 2, x=1 => 3.
        let w = 8usize;
        let cur_runs = make_runs(&[(4, 0), (1, 255), (3, 0)]);
        let prior_d1_runs = make_runs(&[(3, 0), (3, 255), (2, 0)]);
        let prior_d2_runs = make_runs(&[(1, 0), (6, 255), (1, 0)]);
        let cur_topo = RleTopology::from_binary_rle(&cur_runs, w, 1);
        let prior_d1 = RleTopology::from_binary_rle(&prior_d1_runs, w, 1);
        let prior_d2 = RleTopology::from_binary_rle(&prior_d2_runs, w, 1);
        let result = blend_3daa_rle(&cur_topo, &[&prior_d1, &prior_d2], &[], w, 1, 4, None);
        let px = rle_to_pixels(&result);
        assert_eq!(px[4], 255); // current solid
        assert_eq!(px[0], 0); // not in any adjacent
        assert_eq!(px[7], 0); // not in any adjacent
        assert!(px[3] > px[2]); // left component drops with distance
        assert!(px[5] > px[6]); // right component drops with distance
        assert!(px[3] > px[5]); // component-normalized slopes may differ
        assert!(px[2] > px[6]);
        assert_eq!(px[1], 0);
        assert_eq!(px[6], 0);
    }

    #[test]
    fn blend_uses_vertical_distance_not_just_horizontal() {
        // Current has one pixel at (x=2,y=1). Prior has two pixels at row 0:
        // x=2 and x=3. Seed enters via vertical adjacency at (2,0), then
        // propagates horizontally to (3,0), proving vertical coupling.
        let w = 5usize;
        let h = 3usize;
        let cur_runs = make_runs(&[(7, 0), (1, 255), (7, 0)]);
        let prior_runs = make_runs(&[(2, 0), (2, 255), (11, 0)]);
        let cur_topo = RleTopology::from_binary_rle(&cur_runs, w, h);
        let prior_topo = RleTopology::from_binary_rle(&prior_runs, w, h);
        let result = blend_3daa_rle(&cur_topo, &[&prior_topo], &[], w, h, 3, None);
        let px = rle_to_pixels(&result);
        assert_eq!(px.len(), w * h);
        assert_eq!(px[7], 255); // current pixel at row1,col2
        assert!(px[2] > 0); // row0,col2 gets blend via vertical proximity
        assert_eq!(px[3], 0); // row0,col3 is farther in same component
    }
}
