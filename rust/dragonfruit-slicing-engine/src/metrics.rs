//! Performance counters used for diagnostics and UI telemetry.

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
    /// CPU time spent in post z-blend blur stages (model + debug channels).
    pub post_blur_ns: u64,
    /// CPU time spent merging support mask back into model mask.
    pub support_merge_ns: u64,
    /// Effective 3DAA post-stage worker thread count selected by the engine.
    pub daa_post_threads: u32,
    /// Effective 3DAA post-stage overlap buffer depth selected by the engine.
    pub daa_post_buffer_depth: u32,
    pub layers: u32,
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
