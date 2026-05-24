//! Internal Z-axis anti-aliasing (ZAA) kernel selection and execution.
//!
//! This module centralizes the current ROI-local 3DAA kernel behind a stable
//! seam so future ZAA algorithms can be integrated without rewriting the
//! pump, post-worker, blur, or encode architecture.

use crate::binary_mask::BoundedBinaryMaskRef;
use crate::types::SliceJobV3;
use crate::{cross_blend, z_blend};

pub type TopologyBounds = Option<(usize, usize, usize, usize)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZaaKernelKind {
    /// Current ROI-local BFS/EDT-derived z-blend kernel used by `paul/3daa`.
    LegacyRoiBfs,
    /// Primary raster-time Z-perturbed supersampling kernel used by default 3DAA.
    Perturbation,
}

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
    if !is_vertical_aa_mode(&job.anti_aliasing_mode) || job.configured_xy_aa_steps() <= 1 {
        return false;
    }

    if let Some(kernel) = job.zaa_kernel.as_deref() {
        if kernel.eq_ignore_ascii_case("legacy")
            || kernel.eq_ignore_ascii_case("roi")
            || kernel.eq_ignore_ascii_case("post")
        {
            return false;
        }

        return kernel.eq_ignore_ascii_case("perturb") || kernel.eq_ignore_ascii_case("raster");
    }

    if let Ok(value) = std::env::var("DF_ZAA_KERNEL") {
        if value.eq_ignore_ascii_case("legacy")
            || value.eq_ignore_ascii_case("roi")
            || value.eq_ignore_ascii_case("post")
        {
            return false;
        }

        if value.eq_ignore_ascii_case("perturb") || value.eq_ignore_ascii_case("raster") {
            return true;
        }
    }

    true
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
    pub kind: ZaaKernelKind,
    pub look_back: usize,
    pub fade_px: u32,
    pub z_blend_min_alpha_u8: u8,
    pub has_custom_lut: bool,
    pub lut: [u8; 256],
    pub cross_blend_cfg: Option<cross_blend::CrossBlendKernelConfig>,
}

impl ZaaKernelConfig {
    pub fn from_job(job: &SliceJobV3) -> Self {
        let kind = if use_raster_perturbation(job) {
            ZaaKernelKind::Perturbation
        } else {
            ZaaKernelKind::LegacyRoiBfs
        };
        let look_back = (job.z_blend_look_back as usize).max(1);
        let fade_px = job.effective_z_blend_fade_px();
        let z_blend_min_alpha_u8 =
            ((job.z_blend_minimum_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
        // Keep custom LUT application as a final tail-stage remap after all
        // spatial blur passes.  Kernel blending should use a stable linear
        // cure-window ramp to avoid double-applying custom LUT transforms.
        let has_custom_lut = job.z_blend_custom_lut.is_some();
        let z_blend_max_alpha_u8 =
            ((job.z_blend_max_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
        let lut = z_blend::make_cure_window_lut(z_blend_min_alpha_u8, z_blend_max_alpha_u8);
        let cross_blend_cfg = if kind == ZaaKernelKind::LegacyRoiBfs
            && is_cross_blend_mode(&job.anti_aliasing_mode)
        {
            Some(cross_blend::CrossBlendKernelConfig {
                window_layers: look_back,
                z_decay: 0.75,
                xy_radius_px: (job.z_blend_fade_px.max(1).min(4)) as usize,
                xy_decay: 1.0,
                topo_threshold: 127,
                strength: 1.0,
                max_alpha: 255,
            })
        } else {
            None
        };

        Self {
            kind,
            look_back,
            fade_px,
            z_blend_min_alpha_u8,
            has_custom_lut,
            lut,
            cross_blend_cfg,
        }
    }

    #[inline]
    pub fn keep_emitted_topologies(&self) -> bool {
        self.cross_blend_cfg.is_some()
    }

    #[inline]
    pub fn uses_raster_perturbation(&self) -> bool {
        matches!(self.kind, ZaaKernelKind::Perturbation)
    }
}

pub struct ZaaKernelWorkspace {
    z_blend: z_blend::ZBlendWorkspace,
    cross_blend: cross_blend::CrossBlendWorkspace,
}

impl ZaaKernelWorkspace {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            z_blend: z_blend::ZBlendWorkspace::new(width, height),
            cross_blend: cross_blend::CrossBlendWorkspace::new(width, height),
        }
    }

    pub fn resident_bytes(&self) -> usize {
        self.z_blend.resident_bytes()
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
    match config.kind {
        ZaaKernelKind::LegacyRoiBfs => apply_legacy_roi_bfs(inputs, config, workspace),
        ZaaKernelKind::Perturbation => {
            let _ = inputs;
            let _ = workspace;
            ZaaKernelStats::default()
        }
    }
}

fn apply_legacy_roi_bfs(
    inputs: ZaaKernelInputs<'_>,
    config: ZaaKernelConfig,
    workspace: &mut ZaaKernelWorkspace,
) -> ZaaKernelStats {
    let mut stats = ZaaKernelStats::default();

    if inputs.backward_applied {
        let blend_start = std::time::Instant::now();
        if let Some((min_x, max_x, min_y, max_y)) = inputs.backward_seed_bounds {
            workspace.z_blend.blend_layer_local_inplace_with_roi(
                inputs.mask,
                inputs.work_bounds,
                inputs.backward_prior_topologies,
                inputs.width,
                inputs.height,
                config.fade_px,
                Some(&config.lut),
                (min_x, max_x, min_y, max_y),
            );
        }
        stats.z_blend_backward_ns = blend_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
    }

    if inputs.forward_applied && !inputs.future_topologies.is_empty() {
        let blend_start = std::time::Instant::now();
        if let Some((min_x, max_x, min_y, max_y)) = inputs.forward_seed_bounds {
            workspace
                .z_blend
                .blend_layer_forward_local_inplace_with_roi(
                    inputs.mask,
                    inputs.work_bounds,
                    inputs.layer_topology,
                    inputs.future_topologies,
                    inputs.future_topologies.len(),
                    inputs.width,
                    inputs.height,
                    config.fade_px,
                    Some(&config.lut),
                    (min_x, max_x, min_y, max_y),
                );
        }
        stats.z_blend_forward_ns = blend_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
    }

    if let Some(cfg) = config.cross_blend_cfg {
        let cross_start = std::time::Instant::now();
        let mut neighbors: Vec<cross_blend::CrossBlendNeighbor<'_>> =
            Vec::with_capacity(inputs.prior_topologies.len() + inputs.future_topologies.len());
        for (depth, prior) in inputs.prior_topologies.iter().enumerate() {
            neighbors.push(cross_blend::CrossBlendNeighbor {
                z_offset: -((depth + 1) as i32),
                mask: *prior,
                topology: *prior,
            });
        }
        for (depth, future) in inputs.future_topologies.iter().enumerate() {
            neighbors.push(cross_blend::CrossBlendNeighbor {
                z_offset: (depth + 1) as i32,
                mask: *future,
                topology: *future,
            });
        }
        let work_width = inputs.work_bounds.1 - inputs.work_bounds.0 + 1;
        let work_height = inputs.work_bounds.3 - inputs.work_bounds.2 + 1;
        let cross_stats = cross_blend::cross_blend_layer_inplace(
            cross_blend::CrossBlendLayerInputs {
                center_mask: inputs.mask,
                center_topology: inputs.layer_topology,
                neighbors: &neighbors,
                origin_x: inputs.work_bounds.0,
                origin_y: inputs.work_bounds.2,
                width: work_width,
                height: work_height,
            },
            cfg,
            &mut workspace.cross_blend,
        );
        stats.cross_blend_ns = cross_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        stats.cross_blend_touched_pixels = cross_stats.touched_pixels as u64;
        stats.cross_blend_contributing_layers = cross_stats.contributing_layers as u64;
    }

    stats
}

#[inline]
pub fn is_vertical_aa_mode(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("3daa")
        || mode.trim().eq_ignore_ascii_case("vertical")
        || mode.trim().eq_ignore_ascii_case("vertical2")
        || mode.trim().eq_ignore_ascii_case("vertical3")
        || mode.trim().eq_ignore_ascii_case("crossblend")
        || mode.trim().eq_ignore_ascii_case("volumetric")
}

#[inline]
pub fn is_cross_blend_mode(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("vertical3")
        || mode.trim().eq_ignore_ascii_case("crossblend")
        || mode.trim().eq_ignore_ascii_case("volumetric")
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
