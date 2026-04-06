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
