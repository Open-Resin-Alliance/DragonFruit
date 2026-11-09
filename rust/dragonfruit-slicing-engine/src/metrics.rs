//! Performance counters used for diagnostics and UI telemetry.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Default)]
pub struct SlicingPerfV3 {
    pub total_ns: u64,
    pub index_build_ns: u64,
    pub render_wall_ns: u64,
    pub render_ns: u64,
    pub png_encode_ns: u64,
    pub archive_encode_ns: u64,
    /// CPU time spent in backward inter-layer z-blend compensation (3DAA path).
    pub z_blend_backward_ns: u64,
    /// CPU time spent in forward inter-layer z-blend compensation (3DAA path).
    pub z_blend_forward_ns: u64,
    /// CPU time spent in experimental cross-layer blend kernel.
    pub cross_blend_ns: u64,
    /// Number of center-layer pixels raised by cross-blend max-merge.
    pub cross_blend_touched_pixels: u64,
    /// Aggregate number of neighbor layers that contributed occupancy.
    pub cross_blend_contributing_layers: u64,
    /// CPU time spent in post z-blend blur stages (model + debug channels).
    pub post_blur_ns: u64,
    /// CPU time spent merging support mask back into model mask.
    pub support_merge_ns: u64,
    /// Effective 3DAA post-stage worker thread count selected by the engine.
    pub daa_post_threads: u32,
    /// Effective 3DAA post-stage overlap buffer depth selected by the engine.
    pub daa_post_buffer_depth: u32,
    pub layers: u32,

    // ── Breakdown of `png_encode_ns` ──────────────────────────────────────
    // `png_encode_ns` times the whole encode closure.  For jobs with SSAA,
    // blur or dithering that closure wraps four pre-passes around the format
    // encoder, so a single number cannot say which of them costs anything.
    // These five fields are that block broken out and should sum back to it.
    /// CPU time spent downsampling the super-resolution binary RLE (SSAA).
    pub encode_ssaa_downsample_ns: u64,
    /// CPU time spent in the streaming separable box blur.
    pub encode_blur_ns: u64,
    /// CPU time spent in Floyd-Steinberg dithering (or the tail-cure remap).
    pub encode_dither_ns: u64,
    /// CPU time spent downsampling and max-merging the support mask.
    pub encode_support_merge_ns: u64,
    /// CPU time spent in the output format encoder itself (CTB, PNG, ...).
    pub encode_format_ns: u64,
    /// Time spent encoding layer PNGs on the 3DAA encode thread.
    pub encode_png_ns: u64,
    /// Wall time of the 3DAA encode thread, which is a *single* consumer: no
    /// number of post workers can push a job below this.
    pub encode_thread_wall_ns: u64,
    /// CPU time spent in the tail-cure LUT remap, previously folded into
    /// `post_blur_ns` together with the dither.
    pub tail_remap_ns: u64,
}

impl SlicingPerfV3 {
    pub fn total_s(&self) -> f64 {
        self.total_ns as f64 / 1_000_000_000.0
    }

    pub fn layers_per_second(&self) -> f64 {
        if self.total_ns == 0 {
            return 0.0;
        }
        (self.layers as f64) / self.total_s().max(1e-9)
    }
}

/// Accumulate the time elapsed since `start` into `counter`.
#[inline]
pub fn add_elapsed(counter: &AtomicU64, start: std::time::Instant) {
    counter.fetch_add(
        start.elapsed().as_nanos().min(u64::MAX as u128) as u64,
        Ordering::Relaxed,
    );
}

/// Shared per-stage timers for the encode closure.
///
/// The closure runs on every rayon worker at once, so each field accumulates
/// CPU time **summed across threads** — the same convention as `render_ns`,
/// and the same reason these sums can exceed wall-clock time.
#[derive(Debug, Default)]
pub struct EncodeStageCounters {
    pub ssaa_downsample_ns: AtomicU64,
    pub blur_ns: AtomicU64,
    pub dither_ns: AtomicU64,
    pub support_merge_ns: AtomicU64,
    pub format_ns: AtomicU64,
}

impl EncodeStageCounters {
    /// Fold the accumulated per-stage times into a finished perf block.
    pub fn apply_to(&self, perf: &mut SlicingPerfV3) {
        perf.encode_ssaa_downsample_ns = self.ssaa_downsample_ns.load(Ordering::Relaxed);
        perf.encode_blur_ns = self.blur_ns.load(Ordering::Relaxed);
        perf.encode_dither_ns = self.dither_ns.load(Ordering::Relaxed);
        perf.encode_support_merge_ns = self.support_merge_ns.load(Ordering::Relaxed);
        perf.encode_format_ns = self.format_ns.load(Ordering::Relaxed);
    }
}
