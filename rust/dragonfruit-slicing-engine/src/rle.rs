//! RLE types and utilities for buffer-free rasterization.
//!
//! `RleRun` is the unit of rasterized output: row-major, pixel (0,0) first.
//! Adjacent same-value runs are merged by `RleAccum`.

/// A single run-length encoded span.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RleRun {
    pub length: u32,
    pub value: u8,
}

/// Streaming accumulator that merges adjacent same-value runs.
pub struct RleAccum {
    current_value: u8,
    current_len: u32,
    pub runs: Vec<RleRun>,
}

impl Default for RleAccum {
    fn default() -> Self {
        Self::new()
    }
}

impl RleAccum {
    pub fn new() -> Self {
        Self {
            current_value: 0,
            current_len: 0,
            runs: Vec::with_capacity(4096),
        }
    }

    #[inline]
    pub fn push_run(&mut self, length: u32, value: u8) {
        if length == 0 {
            return;
        }
        if value == self.current_value {
            self.current_len = self.current_len.saturating_add(length);
        } else {
            if self.current_len > 0 {
                self.runs.push(RleRun {
                    length: self.current_len,
                    value: self.current_value,
                });
            }
            self.current_value = value;
            self.current_len = length;
        }
    }

    pub fn finish(mut self) -> Vec<RleRun> {
        if self.current_len > 0 {
            self.runs.push(RleRun {
                length: self.current_len,
                value: self.current_value,
            });
        }
        self.runs
    }
}

/// Emit `row_count` full rows of zero pixels into the accumulator.
#[inline]
pub fn emit_zero_rows(rle: &mut RleAccum, row_count: usize, width: usize) {
    if row_count == 0 || width == 0 {
        return;
    }
    // Single saturating-add is safe: max = 7680 * 4320 * 64K ≈ 2×10^12 > u32::MAX,
    // but per-layer max is 7680*4320 = 33.2M << 4.3B (u32::MAX). Split if needed.
    let total = (row_count as u64).saturating_mul(width as u64);
    let mut remaining = total;
    while remaining > 0 {
        let chunk = remaining.min(u32::MAX as u64) as u32;
        rle.push_run(chunk, 0);
        remaining -= chunk as u64;
    }
}

/// Encode a pixel row into the accumulator (runs span row boundaries).
#[inline]
pub fn emit_row(rle: &mut RleAccum, row: &[u8]) {
    if row.is_empty() {
        return;
    }
    let mut run_val = row[0];
    let mut run_len = 1u32;
    for &px in &row[1..] {
        if px == run_val {
            run_len += 1;
        } else {
            rle.push_run(run_len, run_val);
            run_val = px;
            run_len = 1;
        }
    }
    rle.push_run(run_len, run_val);
}

/// Expand RLE runs into a flat pixel buffer (primarily for fallback/test use).
pub fn expand_rle_to_mask(runs: &[RleRun], total_pixels: usize) -> Vec<u8> {
    let mut out = vec![0u8; total_pixels];
    let mut pos = 0usize;
    for run in runs {
        let end = (pos + run.length as usize).min(total_pixels);
        out[pos..end].fill(run.value);
        pos = end;
        if pos >= total_pixels {
            break;
        }
    }
    out
}

/// A column window of a row-major layer: pixels `[start_col, start_col + width)`
/// of every row, emitted as an independent `width × height` row-major run
/// stream. Runs inside a block never carry pixels from outside its columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RleBlockSpec {
    pub start_col: u32,
    pub width: u32,
}

/// Describe a column-window RLE block starting at `start_column` and spanning
/// `width` pixels of every row.
pub fn make_rle_block(start_column: u32, width: u32) -> RleBlockSpec {
    RleBlockSpec {
        start_col: start_column,
        width,
    }
}

/// Re-emit the inner `[crop_left, row_width - crop_right)` columns of a
/// `row_width`-wide row-major run stream as an independent run stream of the
/// cropped width. Used to strip blur halo columns from windowed rasterization.
pub fn crop_rle_columns(
    runs: &[RleRun],
    row_width: u32,
    crop_left: u32,
    crop_right: u32,
) -> Vec<RleRun> {
    let row_width = row_width as u64;
    let keep_start = crop_left as u64;
    let keep_end = row_width.saturating_sub(crop_right as u64);
    if row_width == 0 || keep_end <= keep_start {
        return Vec::new();
    }

    let mut acc = RleAccum::new();
    let mut pos: u64 = 0;
    for run in runs {
        let end = pos + run.length as u64;
        let mut p = pos;
        while p < end {
            let row_start = (p / row_width) * row_width;
            let seg_end = end.min(row_start + row_width);
            let a = (p - row_start).max(keep_start);
            let b = (seg_end - row_start).min(keep_end);
            if b > a {
                acc.push_run((b - a) as u32, run.value);
            }
            p = seg_end;
        }
        pos = end;
    }
    acc.finish()
}

#[cfg(test)]
mod block_tests {
    use super::*;

    fn runs_of(pixels: &[u8]) -> Vec<RleRun> {
        let mut acc = RleAccum::new();
        emit_row(&mut acc, pixels);
        acc.finish()
    }

    #[test]
    fn make_rle_block_carries_window() {
        let block = make_rle_block(7560, 7560);
        assert_eq!(block.start_col, 7560);
        assert_eq!(block.width, 7560);
    }

    #[test]
    fn crop_rle_columns_extracts_inner_window() {
        // 3 rows × 6 cols; keep cols 2..4.
        #[rustfmt::skip]
        let pixels = [
            0u8, 0, 1, 2, 0, 0,
            5,   5, 5, 5, 5, 5,
            0,   9, 9, 9, 9, 0,
        ];
        let cropped = crop_rle_columns(&runs_of(&pixels), 6, 2, 2);
        let mask = expand_rle_to_mask(&cropped, 6);
        assert_eq!(mask, vec![1, 2, 5, 5, 9, 9]);
    }

    #[test]
    fn crop_rle_columns_handles_runs_spanning_rows() {
        // One run covering 4 rows × 4 cols entirely.
        let runs = vec![RleRun {
            length: 16,
            value: 7,
        }];
        let cropped = crop_rle_columns(&runs, 4, 1, 1);
        assert_eq!(
            cropped,
            vec![RleRun {
                length: 8,
                value: 7
            }]
        );
    }

    #[test]
    fn crop_rle_columns_zero_crop_is_identity() {
        let pixels = [0u8, 1, 1, 0, 2, 2, 2, 0];
        let runs = runs_of(&pixels);
        assert_eq!(crop_rle_columns(&runs, 8, 0, 0), runs);
    }

    #[test]
    fn crop_rle_columns_degenerate_window_is_empty() {
        let runs = vec![RleRun {
            length: 8,
            value: 1,
        }];
        assert!(crop_rle_columns(&runs, 4, 2, 2).is_empty());
        assert!(crop_rle_columns(&runs, 4, 3, 3).is_empty());
    }
}
