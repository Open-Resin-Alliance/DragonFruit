//! Internal Z-axis anti-aliasing (ZAA) kernel selection and execution.
//!
//! Perturbation-based Z-axis anti-aliasing helpers.
//!
//! The old ROI/BFS post-kernel has been retired; current 3DAA work happens at
//! raster time, followed by the shared blur/LUT/support tail stages in `engine`.

use crate::binary_mask::BoundedBinaryMaskRef;
use crate::types::SliceJobV3;

pub type TopologyBounds = Option<(usize, usize, usize, usize)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZaaPerturbationPattern {
    Uniform,
    Halton,
    Base2,
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name),
        Ok(value)
            if value == "1"
                || value.eq_ignore_ascii_case("true")
                || value.eq_ignore_ascii_case("yes")
                || value.eq_ignore_ascii_case("on")
    )
}

fn parse_pattern(value: &str) -> Option<ZaaPerturbationPattern> {
    if value.eq_ignore_ascii_case("halton") {
        Some(ZaaPerturbationPattern::Halton)
    } else if value.eq_ignore_ascii_case("base2") {
        Some(ZaaPerturbationPattern::Base2)
    } else if value.eq_ignore_ascii_case("uniform") {
        Some(ZaaPerturbationPattern::Uniform)
    } else {
        None
    }
}

fn env_perturbation_pattern() -> ZaaPerturbationPattern {
    std::env::var("DF_ZAA_PERTURBATION_MODE")
        .ok()
        .as_deref()
        .and_then(parse_pattern)
        .unwrap_or(ZaaPerturbationPattern::Uniform)
}

pub fn perturbation_pattern(job: &SliceJobV3) -> ZaaPerturbationPattern {
    job.zaa_pattern
        .as_deref()
        .and_then(parse_pattern)
        .unwrap_or_else(env_perturbation_pattern)
}

#[inline]
pub fn use_raster_perturbation(job: &SliceJobV3) -> bool {
    is_vertical_aa_mode(&job.anti_aliasing_mode)
}

#[inline]
pub fn duplicate_terminal_z_samples(job: &SliceJobV3, aa_steps: usize) -> bool {
    use_raster_perturbation(job)
        && job
            .zaa_duplicate_z
            .unwrap_or_else(|| env_flag("DF_ZAA_DUPLICATE_Z"))
        && matches!(aa_steps, 16 | 32 | 64)
}

#[inline]
pub fn z_steps_for_aa(aa_steps: usize, duplicate_terminal_z: bool) -> usize {
    if duplicate_terminal_z {
        (aa_steps / 2).max(1)
    } else {
        aa_steps.max(1)
    }
}

#[inline]
pub fn perturbation_offset(
    pattern: ZaaPerturbationPattern,
    sample_index: usize,
    z_steps: usize,
) -> f32 {
    match pattern {
        ZaaPerturbationPattern::Uniform => (sample_index as f32 + 0.5) / z_steps.max(1) as f32,
        ZaaPerturbationPattern::Halton => halton_base_5((sample_index + 1) as u32),
        ZaaPerturbationPattern::Base2 => van_der_corput_base_2((sample_index + 1) as u32),
    }
}

fn halton_base_5(mut index: u32) -> f32 {
    let mut result = 0.0f32;
    let mut f = 1.0f32 / 5.0f32;

    while index > 0 {
        result += f * (index % 5) as f32;
        index /= 5;
        f /= 5.0f32;
    }

    result
}

fn van_der_corput_base_2(mut index: u32) -> f32 {
    let mut result = 0.0f32;
    let mut f = 0.5f32;

    while index > 0 {
        result += f * (index & 1) as f32;
        index >>= 1;
        f *= 0.5f32;
    }

    result
}

#[derive(Debug, Clone, Copy)]
pub struct ZaaKernelConfig {
    pub look_back: usize,
}

impl ZaaKernelConfig {
    pub fn from_job(job: &SliceJobV3) -> Self {
        let look_back = (job.z_blend_look_back as usize).max(1);
        Self { look_back }
    }

    #[inline]
    pub fn keep_emitted_topologies(&self) -> bool {
        let _ = self;
        false
    }

    #[inline]
    pub fn uses_raster_perturbation(&self) -> bool {
        let _ = self;
        true
    }
}

pub struct ZaaKernelWorkspace;

impl ZaaKernelWorkspace {
    pub fn new(_width: usize, _height: usize) -> Self {
        Self
    }

    pub fn resident_bytes(&self) -> usize {
        let _ = self;
        0
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ZaaKernelStats {
    pub z_blend_backward_ns: u64,
    pub z_blend_forward_ns: u64,
    pub cross_blend_ns: u64,
    pub cross_blend_touched_pixels: u64,
    pub cross_blend_contributing_layers: u64,
}

pub struct ZaaKernelInputs<'a> {
    pub mask: &'a mut [u8],
    pub work_bounds: (usize, usize, usize, usize),
    pub layer_topology: BoundedBinaryMaskRef<'a>,
    pub prior_topologies: &'a [BoundedBinaryMaskRef<'a>],
    pub backward_prior_topologies: &'a [BoundedBinaryMaskRef<'a>],
    pub future_topologies: &'a [BoundedBinaryMaskRef<'a>],
    pub backward_applied: bool,
    pub backward_seed_bounds: TopologyBounds,
    pub forward_applied: bool,
    pub forward_seed_bounds: TopologyBounds,
    pub width: usize,
    pub height: usize,
}

pub fn apply_kernel(
    inputs: ZaaKernelInputs<'_>,
    config: ZaaKernelConfig,
    workspace: &mut ZaaKernelWorkspace,
) -> ZaaKernelStats {
    let _ = inputs;
    let _ = config;
    let _ = workspace;
    ZaaKernelStats::default()
}

#[inline]
pub fn is_vertical_aa_mode(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("3daa")
        || mode.trim().eq_ignore_ascii_case("vertical")
        || mode.trim().eq_ignore_ascii_case("vertical2")
}

#[cfg(test)]
mod tests {
    use super::{perturbation_offset, z_steps_for_aa, ZaaPerturbationPattern};

    #[test]
    fn uniform_offsets_are_centered() {
        let actual: Vec<f32> = (0..4)
            .map(|idx| perturbation_offset(ZaaPerturbationPattern::Uniform, idx, 4))
            .collect();
        let expected = [0.125, 0.375, 0.625, 0.875];

        for (idx, (&a, &e)) in actual.iter().zip(expected.iter()).enumerate() {
            assert!((a - e).abs() < 1e-6, "idx={idx} expected {e}, got {a}");
        }
    }

    #[test]
    fn base2_sequence_matches_expected() {
        let expected = [0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875, 0.0625];

        for (idx, &exp) in expected.iter().enumerate() {
            let val = perturbation_offset(ZaaPerturbationPattern::Base2, idx, expected.len());
            assert!(
                (val - exp).abs() < 1e-6,
                "idx={} expected {}, got {}",
                idx,
                exp,
                val
            );
        }
    }

    #[test]
    fn duplicate_terminal_z_halves_unique_steps() {
        assert_eq!(z_steps_for_aa(16, true), 8);
        assert_eq!(z_steps_for_aa(8, false), 8);
    }
}
