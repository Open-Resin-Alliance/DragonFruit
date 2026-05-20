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
//! 5. For each blend-zone pixel compute the 1-D horizontal distance to the
//!    nearest current-layer solid pixel on the same scanline.
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
            return Self { width, height, row_offsets, intervals: Vec::new() };
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

        Self { width, height, row_offsets, intervals }
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

/// Convert a horizontal pixel distance (0 = at boundary, ≥ fade_px → 0) to alpha.
///
/// Formula: `raw = (fade_px − dist) * 255 / fade_px`, then optionally remapped
/// through `lut`. This matches the cure-window LUT convention used by the rest
/// of the z-blend pipeline.
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
/// Alpha is assigned by **Z-layer distance**, not horizontal XY distance.
/// A blend pixel first appearing in an adjacent layer at distance `d` receives
/// `alpha ∝ (fade_layers + 1 − d) / (fade_layers + 1)`, optionally remapped
/// through `lut`. This correctly handles curved/sloped surfaces where adjacent
/// layer footprints extend far beyond the current-layer boundary in XY;
/// the subsequent XY blur provides spatial gradient smoothing.
///
/// - `prior_topos[i]` = topology of the layer `i + 1` steps **before** current.
/// - `future_topos[i]` = topology of the layer `i + 1` steps **after** current.
/// - Solid current-layer pixels → 255.
/// - Pixels in adjacent layers (within `fade_layers` Z-steps) but not in
///   current → alpha scaled by nearest-layer distance, through `lut`.
/// - All other pixels → 0.
pub fn blend_3daa_rle(
    current_topo: &RleTopology,
    prior_topos: &[&RleTopology],   // [0]=1 layer ago, [1]=2 layers ago, …
    future_topos: &[&RleTopology],  // [0]=1 layer ahead, [1]=2 ahead, …
    width: usize,
    height: usize,
    fade_layers: u32,
    lut: Option<&[u8; 256]>,
) -> Vec<RleRun> {
    let mut out = RleAccum::new();

    if prior_topos.is_empty() && future_topos.is_empty() {
        // Pure binary pass-through.
        for y in 0..height {
            emit_row_binary(current_topo.row_intervals(y), width, &mut out);
        }
        return out.finish();
    }

    let max_depth = prior_topos.len()
        .max(future_topos.len())
        .min(fade_layers as usize);

    // Per-row scratch buffers reused across all scanlines.
    let mut adj_src: Vec<&[(u32, u32)]> = Vec::with_capacity(2);
    let mut adj_union: Vec<(u32, u32)> = Vec::new();
    let mut blend_minus_cur: Vec<(u32, u32)> = Vec::new();
    let mut new_at_d: Vec<(u32, u32)> = Vec::new();
    let mut covered: Vec<(u32, u32)> = Vec::new();
    let mut covered_next: Vec<(u32, u32)> = Vec::new();
    let mut all_segs: Vec<(u32, u32, u8)> = Vec::new();

    for y in 0..height {
        let cur = current_topo.row_intervals(y);
        all_segs.clear();
        covered.clear();

        // Process adjacent layers from nearest (d=1) to farthest (d=max_depth).
        // Each blend pixel receives the alpha of the closest layer containing it.
        for d in 1..=max_depth {
            // dist_to_alpha with fade = fade_layers+1 gives:
            //   d=1           → (fade_layers)*255/(fade_layers+1)  — near-maximum
            //   d=fade_layers → 255/(fade_layers+1)                — small but nonzero
            let alpha_d = dist_to_alpha(d as u32, fade_layers + 1, lut);
            if alpha_d == 0 {
                break;
            }

            adj_src.clear();
            if d <= prior_topos.len() {
                let iv = prior_topos[d - 1].row_intervals(y);
                if !iv.is_empty() { adj_src.push(iv); }
            }
            if d <= future_topos.len() {
                let iv = future_topos[d - 1].row_intervals(y);
                if !iv.is_empty() { adj_src.push(iv); }
            }
            if adj_src.is_empty() { continue; }

            union_intervals_into(&adj_src, &mut adj_union);

            // Pixels in adjacent footprint but absent from the current layer.
            subtract_intervals(&adj_union, cur, &mut blend_minus_cur);
            if blend_minus_cur.is_empty() { continue; }

            // Exclude pixels already assigned a closer-layer alpha.
            subtract_intervals(&blend_minus_cur, &covered, &mut new_at_d);
            for &(s, e) in &new_at_d {
                all_segs.push((s, e, alpha_d));
            }

            // Expand the covered set.
            let srcs = [covered.as_slice(), blend_minus_cur.as_slice()];
            union_intervals_into(&srcs, &mut covered_next);
            std::mem::swap(&mut covered, &mut covered_next);
        }

        // Current pixels always at full exposure.
        for &(s, e) in cur {
            all_segs.push((s, e, 255u8));
        }

        if all_segs.is_empty() {
            out.push_run(width as u32, 0);
            continue;
        }

        // Sort by start position then sweep-emit.
        all_segs.sort_unstable_by_key(|&(s, _, _)| s);
        let mut col = 0u32;
        let w = width as u32;
        for &(s, e, alpha) in &all_segs {
            if s > col { out.push_run(s - col, 0); }
            out.push_run(e - s + 1, alpha);
            col = e + 1;
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
        pairs.iter().map(|&(length, value)| RleRun { length, value }).collect()
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
        // Blend zone: x=2..3 (receding pixels, both from prior at d=1).
        // With Z-layer-distance alpha: both x=2 and x=3 come from d=1 → same alpha.
        let prior_runs = make_runs(&[(4, 255)]);
        let cur_runs = make_runs(&[(2, 255), (2, 0)]);
        let prior_topo = RleTopology::from_binary_rle(&prior_runs, 4, 1);
        let cur_topo = RleTopology::from_binary_rle(&cur_runs, 4, 1);
        let result = blend_3daa_rle(&cur_topo, &[&prior_topo], &[], 4, 1, 4, None);
        let px = rle_to_pixels(&result);
        assert_eq!(px[0], 255); // current solid
        assert_eq!(px[1], 255); // current solid
        // Both blend-zone pixels come from d=1 → identical alpha.
        assert_eq!(px[2], px[3]);
        assert!(px[2] > 0);
        assert!(px[2] < 255);
    }

    #[test]
    fn blend_zone_all_pixels_get_layer_based_alpha() {
        // Prior has solid x=0..3; current has only x=0..0 (width=10, fade_layers=4).
        // Blend zone: x=1..3 — these are far from the horizontal boundary but
        // adjacent at d=1. With Z-layer-distance they must all get nonzero alpha.
        let w = 10usize;
        let prior_runs = make_runs(&[(4, 255), (6, 0)]);
        let cur_runs = make_runs(&[(1, 255), (9, 0)]);
        let prior_topo = RleTopology::from_binary_rle(&prior_runs, w, 1);
        let cur_topo = RleTopology::from_binary_rle(&cur_runs, w, 1);
        let result = blend_3daa_rle(&cur_topo, &[&prior_topo], &[], w, 1, 4, None);
        let px = rle_to_pixels(&result);
        assert_eq!(px[0], 255); // current solid
        // All blend-zone pixels (x=1..3) come from d=1 → same nonzero alpha.
        assert!(px[1] > 0);
        assert_eq!(px[1], px[2]);
        assert_eq!(px[2], px[3]);
        // Pixels beyond prior (x=4..9) → 0.
        for &v in &px[4..] { assert_eq!(v, 0); }
    }

    #[test]
    fn blend_z_layer_gradient_priority() {
        // Validate that pixels closer in Z get higher alpha.
        // width=8, height=1, current: x=4 only.
        // prior[0] (d=1): x=3..5  → blend zone x=3, x=5
        // prior[1] (d=2): x=1..6  → blend zone x=1..2, x=6 (x=3,x=5 already covered)
        // Expected: px[3]==px[5] (alpha_d1), px[1]==px[2]==px[6] (alpha_d2),
        //           alpha_d1 > alpha_d2 > 0, px[4]==255.
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
        assert_eq!(px[0], 0);   // not in any adjacent
        assert_eq!(px[7], 0);   // not in any adjacent
        assert_eq!(px[3], px[5]); // both from d=1
        assert_eq!(px[1], px[2]); // both from d=2
        assert_eq!(px[1], px[6]); // both from d=2
        assert!(px[3] > px[1]);   // d=1 alpha > d=2 alpha
        assert!(px[1] > 0);       // d=2 still nonzero
    }
}
