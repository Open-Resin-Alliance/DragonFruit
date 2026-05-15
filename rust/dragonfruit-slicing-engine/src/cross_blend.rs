//! Volumetric cross-layer blending kernel.
//!
//! This module applies a local 3D kernel around each center-layer pixel:
//! - XY neighborhood sampling inside each neighbor layer
//! - Z-distance weighting across prior/future layers
//! - topology gating and max-merge semantics (never darkens center pixels)
//!
//! Unlike the older 2.5D pass, this performs true 3D neighborhood accumulation
//! over (x, y, z) samples (bounded by configured windows/radii).

/// Configuration for volumetric-style cross-layer blending.
#[derive(Debug, Clone, Copy)]
pub struct CrossBlendKernelConfig {
    /// Maximum absolute neighbor offset in layers to sample.
    pub window_layers: usize,
    /// Exponential Z decay for neighbor contribution.
    pub z_decay: f32,
    /// XY sampling radius (in pixels) for in-layer neighborhood accumulation.
    pub xy_radius_px: usize,
    /// Exponential XY decay for neighborhood contribution.
    pub xy_decay: f32,
    /// Occupancy threshold used for topology-gated contribution.
    pub topo_threshold: u8,
    /// Overall blend strength [0..1].
    pub strength: f32,
    /// Upper bound to clamp output alpha.
    pub max_alpha: u8,
}

impl Default for CrossBlendKernelConfig {
    fn default() -> Self {
        Self {
            window_layers: 4,
            z_decay: 0.75,
            xy_radius_px: 2,
            xy_decay: 1.0,
            topo_threshold: 127,
            strength: 1.0,
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
#[derive(Debug)]
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
    neighbor_offsets: Vec<(isize, isize, f32)>,
}

impl CrossBlendWorkspace {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width.saturating_mul(height);
        Self {
            accum: vec![0.0; n],
            weight: vec![0.0; n],
            neighbor_offsets: Vec::new(),
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

    fn prepare_xy_offsets(&mut self, radius: usize, decay: f32) {
        self.neighbor_offsets.clear();
        let radius_i = radius as isize;
        let r2 = (radius as f32) * (radius as f32);
        for dy in -radius_i..=radius_i {
            for dx in -radius_i..=radius_i {
                let d2 = (dx * dx + dy * dy) as f32;
                if d2 > r2 {
                    continue;
                }
                let d = d2.sqrt();
                let w = (-decay * d).exp();
                if w > 0.0 {
                    self.neighbor_offsets.push((dx, dy, w));
                }
            }
        }
        // Deterministic order helps test stability.
        self.neighbor_offsets
            .sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    }
}

/// Lightweight stats for diagnostics and future quality/perf guardrails.
#[derive(Debug, Clone, Copy, Default)]
pub struct CrossBlendStats {
    pub touched_pixels: u32,
    pub contributing_layers: u32,
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
    workspace.prepare_xy_offsets(cfg.xy_radius_px.max(1), cfg.xy_decay.max(0.01));

    let strength = cfg.strength.clamp(0.0, 1.0);
    if strength <= 0.0 {
        return CrossBlendStats::default();
    }

    let mut stats = CrossBlendStats::default();
    let width_i = inputs.width as isize;
    let height_i = inputs.height as isize;
    let kernel_weight_sum: f32 = workspace
        .neighbor_offsets
        .iter()
        .map(|(_, _, w)| *w)
        .sum();
    let mut z_weight_sum = 0.0f32;

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
        z_weight_sum += zw;

        let mut layer_contributed = false;

        for y in 0..inputs.height {
            let y_i = y as isize;
            let row = y * inputs.width;
            for x in 0..inputs.width {
                let x_i = x as isize;
                let center_idx = row + x;

                // Keep the blend field local to current geometry to avoid distant haloing.
                let center_gate = if inputs.center_topology[center_idx] > cfg.topo_threshold {
                    1.0
                } else {
                    0.7
                };

                let mut local_accum = 0.0f32;
                let mut local_weight = 0.0f32;

                for (dx, dy, xy_w) in workspace.neighbor_offsets.iter().copied() {
                    let nx = x_i + dx;
                    let ny = y_i + dy;
                    if nx < 0 || ny < 0 || nx >= width_i || ny >= height_i {
                        continue;
                    }
                    let nidx = ny as usize * inputs.width + nx as usize;
                    if neighbor.topology[nidx] <= cfg.topo_threshold {
                        continue;
                    }

                    let w = zw * xy_w * center_gate;
                    local_accum += neighbor.mask[nidx] as f32 * w;
                    local_weight += w;
                }

                if local_weight > 0.0 {
                    workspace.accum[center_idx] += local_accum;
                    workspace.weight[center_idx] += local_weight;
                    layer_contributed = true;
                }
            }
        }

        if layer_contributed {
            stats.contributing_layers = stats.contributing_layers.saturating_add(1);
        }
    }

    let normalization_weight = (kernel_weight_sum * z_weight_sum).max(f32::EPSILON);

    for i in 0..n {
        let w = workspace.weight[i];
        if w <= 0.0 {
            continue;
        }
        let avg_alpha = workspace.accum[i] / w;
        let coverage = (w / normalization_weight).clamp(0.0, 1.0);
        let blended = (avg_alpha * coverage * strength).clamp(0.0, cfg.max_alpha as f32) as u8;
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

    #[test]
    fn cross_blend_has_xy_distance_falloff() {
        let width = 5;
        let height = 1;
        let mut center = vec![0u8, 0, 0, 0, 0];
        let center_topo = vec![0u8; 5];

        // Occupancy only at center pixel in +1 layer.
        let n1_mask = vec![0u8, 0, 255, 0, 0];
        let n1_topo = vec![0u8, 0, 255, 0, 0];
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
            CrossBlendKernelConfig {
                window_layers: 1,
                z_decay: 0.75,
                xy_radius_px: 2,
                xy_decay: 1.0,
                topo_threshold: 127,
                strength: 1.0,
                max_alpha: 255,
            },
            &mut ws,
        );

        // center gets strongest, immediate neighbors weaker.
        assert!(center[2] > 0);
        assert!(center[1] > 0);
        assert!(center[3] > 0);
        assert!(center[2] > center[1]);
        assert!(center[2] > center[3]);
    }
}
