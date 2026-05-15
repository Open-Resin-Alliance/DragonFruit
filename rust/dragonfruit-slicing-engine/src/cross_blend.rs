//! Cross-layer blending kernel API (volumetric-oriented scaffolding).
//!
//! This module defines a stable surface for a future true 3D-ish blending pass
//! that combines multiple neighbor layers using configurable Z-distance weights.
//! The current implementation is intentionally conservative and is not wired into
//! the engine yet; it is used to establish contracts and guardrail tests.

/// Configuration for volumetric-style cross-layer blending.
#[derive(Debug, Clone, Copy)]
pub struct CrossBlendKernelConfig {
    /// Maximum absolute neighbor offset in layers to sample.
    pub window_layers: usize,
    /// Exponential Z decay for neighbor contribution.
    pub z_decay: f32,
    /// Occupancy threshold used for topology-gated contribution.
    pub topo_threshold: u8,
    /// Upper bound to clamp output alpha.
    pub max_alpha: u8,
}

impl Default for CrossBlendKernelConfig {
    fn default() -> Self {
        Self {
            window_layers: 2,
            z_decay: 0.75,
            topo_threshold: 127,
            max_alpha: 255,
        }
    }
}

/// One neighbor layer sampled around a center layer.
#[derive(Debug, Clone, Copy)]
pub struct CrossBlendNeighbor<'a> {
    /// Signed layer offset relative to center (`-1`, `+1`, ...).
    pub z_offset: i32,
    /// 8-bit grayscale mask for the neighbor layer.
    pub mask: &'a [u8],
    /// Binary-ish topology/occupancy mask for the neighbor layer.
    pub topology: &'a [u8],
}

/// Input bundle for a center-layer cross-blend operation.
#[derive(Debug, Clone, Copy)]
pub struct CrossBlendLayerInputs<'a> {
    /// Center mask to blend into.
    pub center_mask: &'a mut [u8],
    /// Center topology used for local gating.
    pub center_topology: &'a [u8],
    /// Neighbor layer samples within configured Z window.
    pub neighbors: &'a [CrossBlendNeighbor<'a>],
    /// Layer dimensions.
    pub width: usize,
    pub height: usize,
}

/// Reusable scratch buffers for cross-blend kernels.
#[derive(Debug, Default)]
pub struct CrossBlendWorkspace {
    accum: Vec<f32>,
    weight: Vec<f32>,
}

impl CrossBlendWorkspace {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width.saturating_mul(height);
        Self {
            accum: vec![0.0; n],
            weight: vec![0.0; n],
        }
    }

    fn ensure_len(&mut self, n: usize) {
        if self.accum.len() != n {
            self.accum.resize(n, 0.0);
        }
        if self.weight.len() != n {
            self.weight.resize(n, 0.0);
        }
    }
}

/// Lightweight stats for diagnostics and future quality/perf guardrails.
#[derive(Debug, Clone, Copy, Default)]
pub struct CrossBlendStats {
    pub touched_pixels: u32,
    pub contributors: u32,
}

#[inline]
fn z_weight(z_offset: i32, decay: f32) -> f32 {
    let dz = z_offset.unsigned_abs() as f32;
    (-decay * dz).exp()
}

/// Prototype cross-layer accumulation kernel.
///
/// Behavior today:
/// - topology-gated weighted accumulation from neighbors into center mask
/// - max-merge semantics (never darkens existing center mask)
///
/// This is intentionally simple and deterministic to establish integration
/// points before introducing heavier volumetric reconstruction logic.
pub fn cross_blend_layer_inplace(
    inputs: CrossBlendLayerInputs<'_>,
    cfg: CrossBlendKernelConfig,
    workspace: &mut CrossBlendWorkspace,
) -> CrossBlendStats {
    let n = inputs.width.saturating_mul(inputs.height);
    if n == 0 || inputs.center_mask.len() != n || inputs.center_topology.len() != n {
        return CrossBlendStats::default();
    }

    workspace.ensure_len(n);
    workspace.accum.fill(0.0);
    workspace.weight.fill(0.0);

    let mut stats = CrossBlendStats::default();

    for neighbor in inputs.neighbors.iter() {
        if neighbor.mask.len() != n || neighbor.topology.len() != n {
            continue;
        }
        let dz = neighbor.z_offset.unsigned_abs() as usize;
        if dz == 0 || dz > cfg.window_layers {
            continue;
        }
        let zw = z_weight(neighbor.z_offset, cfg.z_decay);
        if zw <= 0.0 {
            continue;
        }

        for i in 0..n {
            if neighbor.topology[i] <= cfg.topo_threshold {
                continue;
            }
            // Prefer contributions near/inside center occupancy to avoid haloing.
            let center_gate = if inputs.center_topology[i] > cfg.topo_threshold {
                1.0
            } else {
                0.6
            };
            let w = zw * center_gate;
            workspace.accum[i] += neighbor.mask[i] as f32 * w;
            workspace.weight[i] += w;
            stats.contributors = stats.contributors.saturating_add(1);
        }
    }

    for i in 0..n {
        let w = workspace.weight[i];
        if w <= 0.0 {
            continue;
        }
        let blended = (workspace.accum[i] / w).clamp(0.0, cfg.max_alpha as f32) as u8;
        if blended > inputs.center_mask[i] {
            inputs.center_mask[i] = blended;
            stats.touched_pixels = stats.touched_pixels.saturating_add(1);
        }
    }

    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_blend_respects_max_merge() {
        let width = 4;
        let height = 1;
        let mut center = vec![200u8, 10, 10, 200];
        let center_topo = vec![255u8, 0, 0, 255];

        let n1_mask = vec![100u8, 220, 220, 100];
        let n1_topo = vec![255u8; 4];
        let neighbors = [CrossBlendNeighbor {
            z_offset: 1,
            mask: &n1_mask,
            topology: &n1_topo,
        }];

        let mut ws = CrossBlendWorkspace::new(width, height);
        let _stats = cross_blend_layer_inplace(
            CrossBlendLayerInputs {
                center_mask: &mut center,
                center_topology: &center_topo,
                neighbors: &neighbors,
                width,
                height,
            },
            CrossBlendKernelConfig::default(),
            &mut ws,
        );

        // Existing high values never darken.
        assert!(center[0] >= 200);
        assert!(center[3] >= 200);
        // Low center values can increase.
        assert!(center[1] >= 10);
        assert!(center[2] >= 10);
    }
}
