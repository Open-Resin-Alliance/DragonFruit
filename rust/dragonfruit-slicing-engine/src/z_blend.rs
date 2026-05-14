//! EDT-based inter-layer Z-blending ("3DAA" mode).
//!
//! Rather than re-rasterizing the 3D geometry at multiple Z sub-positions,
//! 3DAA is implemented as a pure 2D post-process applied after all layers have
//! been rasterized with standard Blur AA:
//!
//! For each layer `i`:
//!  1. Find "receding pixels" — pixels present in any of the prior `look_back`
//!     layers but absent from the current layer. These are the "step" surfaces
//!     that cause stairstepping artefacts.
//!  2. Compute a Manhattan-distance BFS from the current layer's inner edge
//!     outward into the receding area, clipped to `fade_px`.
//!  3. Convert distances to a gradient (255 at the edge → 0 at fade_px).
//!  4. Remap the gradient through a LUT to compensate for the resin's
//!     logarithmic polymerization threshold.
//!  5. Max-merge the gradient into the current layer mask: receding pixels get
//!     lifted to their gradient value, existing bright pixels are never reduced.
//!
//! The result smooths the layer-line stairstepping without any geometry
//! re-rasterization, and naturally skips pixels where adjacent layers are
//! identical (vertical walls produce zero receding area → no blending).

use std::collections::VecDeque;

/// Reusable working buffers for single-layer 3DAA z-blending.
///
/// This enables streaming operation (bounded memory) by blending each layer
/// against a look-back ring of prior layers without materializing all layers.
pub struct ZBlendWorkspace {
    in_prior: Vec<u8>,
    dist: Vec<u32>,
    gradient: Vec<u8>,
    queue: VecDeque<usize>,
}

impl ZBlendWorkspace {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width.saturating_mul(height);
        Self {
            in_prior: vec![0u8; n],
            dist: vec![u32::MAX; n],
            gradient: vec![0u8; n],
            queue: VecDeque::with_capacity(n / 8),
        }
    }

    pub fn blend_layer_inplace(
        &mut self,
        current: &mut [u8],
        priors: &[&[u8]],
        width: usize,
        height: usize,
        fade_px: u32,
        lut: Option<&[u8; 256]>,
    ) {
        let n = width.saturating_mul(height);
        if self.in_prior.len() != n {
            self.in_prior.resize(n, 0);
        }
        if self.dist.len() != n {
            self.dist.resize(n, u32::MAX);
        }
        if self.gradient.len() != n {
            self.gradient.resize(n, 0);
        }

        z_blend_layer_inplace(
            current,
            priors,
            width,
            height,
            fade_px,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.gradient,
            &mut self.queue,
        );
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Apply EDT inter-layer Z-blending to all layers in-place.
///
/// `masks` must be a sequence of `width × height` grayscale u8 buffers, one
/// per layer in Z-ascending order. Working buffers are pre-allocated once and
/// reused across layers to avoid per-layer heap churn.
pub fn z_blend_all_layers(
    masks: &mut [Vec<u8>],
    width: usize,
    height: usize,
    look_back: usize,
    fade_px: u32,
    lut: Option<&[u8; 256]>,
) {
    let total = masks.len();
    if total == 0 || fade_px == 0 || look_back == 0 {
        return;
    }

    let mut workspace = ZBlendWorkspace::new(width, height);

    // Layer 0 has no prior layers; start from layer 1.
    for i in 1..total {
        let start = i.saturating_sub(look_back);
        // Split to borrow masks[i] mutably while reading masks[start..i] immutably.
        let (priors_slice, rest) = masks.split_at_mut(i);
        let current = &mut rest[0];

        let priors: Vec<&[u8]> = priors_slice[start..]
            .iter()
            .map(|layer| layer.as_slice())
            .collect();
        workspace.blend_layer_inplace(current, &priors, width, height, fade_px, lut);
    }
}

// ---------------------------------------------------------------------------
// Core per-layer EDT blending
// ---------------------------------------------------------------------------

fn z_blend_layer_inplace(
    current: &mut [u8],
    priors: &[&[u8]],
    width: usize,
    height: usize,
    fade_px: u32,
    lut: Option<&[u8; 256]>,
    in_prior: &mut [u8],
    dist: &mut [u32],
    gradient: &mut [u8],
    queue: &mut VecDeque<usize>,
) {
    let n = width * height;
    // Treat any non-zero alpha as occupied. 3DAA runs on top of Blur AA masks,
    // so using a hard mid-gray threshold (e.g. 127) effectively binarizes the
    // input and discards soft edge coverage, which can make output resemble
    // legacy coverage AA rather than true blur-based blending.
    const THRESHOLD: u8 = 0;

    // -- Step 1: build combined prior-presence map (OR of all prior layers). --
    in_prior[..n].fill(0);
    for prior in priors {
        for (p, q) in in_prior[..n].iter_mut().zip(prior[..n].iter()) {
            if *q > THRESHOLD {
                *p = 1;
            }
        }
    }

    // Quick early-out: if no prior pixel was ever set, nothing to blend.
    if !in_prior[..n].iter().any(|&v| v > 0) {
        return;
    }

    // -- Step 2: BFS from current-layer boundary into receding area. --
    dist[..n].fill(u32::MAX);
    queue.clear();

    // Seed: current-layer pixels that border at least one non-current pixel.
    // These are distance=0 from the boundary edge.
    for y in 0..height {
        for x in 0..width {
            let idx = y * width + x;
            if current[idx] <= THRESHOLD {
                continue; // not in current layer
            }
            if has_non_current_4neighbor(current, x, y, width, height, THRESHOLD) {
                dist[idx] = 0;
                queue.push_back(idx);
            }
        }
    }

    // BFS: spread distance outward into receding pixels (in_prior=1, not in current).
    while let Some(idx) = queue.pop_front() {
        let next_d = dist[idx] + 1;
        if next_d > fade_px {
            continue;
        }
        let y = idx / width;
        let x = idx % width;

        macro_rules! try_neighbor {
            ($nidx:expr) => {
                let nidx = $nidx;
                // Only enter pixels that are receding (in prior, not in current)
                // and that haven't been reached with a shorter distance yet.
                if current[nidx] <= THRESHOLD && in_prior[nidx] > 0 && dist[nidx] > next_d {
                    dist[nidx] = next_d;
                    queue.push_back(nidx);
                }
            };
        }

        if x > 0 {
            try_neighbor!(idx - 1);
        }
        if x + 1 < width {
            try_neighbor!(idx + 1);
        }
        if y > 0 {
            try_neighbor!(idx - width);
        }
        if y + 1 < height {
            try_neighbor!(idx + width);
        }
    }

    // -- Step 3: convert distances → gradient, apply LUT, max-merge. --
    // Use fade_px+1 as divisor so the pixel AT fade_px distance still gets a
    // small but non-zero gradient value (inclusive boundary).
    let fade_denom = (fade_px + 1) as f32;
    for idx in 0..n {
        // Only receding pixels get a gradient.
        if current[idx] <= THRESHOLD && in_prior[idx] > 0 && dist[idx] <= fade_px {
            // Linear gradient: 255 at dist=0 (edge), ~1 at dist=fade_px.
            let t = 1.0 - (dist[idx] as f32 / fade_denom);
            let raw = (t * 255.0 + 0.5) as u8;
            let v = if let Some(lut) = lut {
                lut[raw as usize]
            } else {
                raw
            };
            // Max-merge: never reduce existing values.
            if v > current[idx] {
                current[idx] = v;
            }
        }
    }
    // Clear gradient buffer for next call (dist/in_prior are reset at the
    // start of each call, but gradient is written directly without reset).
    gradient[..n].fill(0); // keep the buffer zeroed for next layer
}

/// Returns true if the pixel at (x, y) has at least one 4-connected neighbour
/// that is NOT in the current layer (i.e., ≤ threshold).
#[inline]
fn has_non_current_4neighbor(
    mask: &[u8],
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    threshold: u8,
) -> bool {
    let idx = y * width + x;
    if x > 0 && mask[idx - 1] <= threshold {
        return true;
    }
    if x + 1 < width && mask[idx + 1] <= threshold {
        return true;
    }
    if y > 0 && mask[idx - width] <= threshold {
        return true;
    }
    if y + 1 < height && mask[idx + width] <= threshold {
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// LUT utilities
// ---------------------------------------------------------------------------

/// Default exponential LUT: maps the linear edge-distance gradient (0 = far,
/// 255 = at edge) to an exposure value that partially compensates for resin's
/// logarithmic polymerization threshold.
///
/// Curve: `output = input^1.5`, which gently attenuates mid-range values while
/// leaving full-bright (255) untouched. Users can supply a custom LUT via
/// `SliceJobV3::z_blend_lut` to tune for their specific resin chemistry.
pub fn default_z_blend_lut() -> [u8; 256] {
    let mut lut = [0u8; 256];
    for (i, entry) in lut.iter_mut().enumerate() {
        let t = i as f32 / 255.0;
        *entry = (t.powf(1.5) * 255.0 + 0.5) as u8;
    }
    lut
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A 5×1 strip where:
    ///   prior  = [255, 255, 255, 255, 255]  (fully solid)
    ///   current = [  0,   0, 255, 255, 255]  (solid only on right)
    ///
    /// Receding pixels: indices 0 and 1.
    /// Index 2 is the nearest current-layer boundary (it borders index 1).
    ///
    /// Expected BFS distances: index1 = 1, index0 = 2.
    /// With fade_px=4 and no LUT:
    ///   gradient[1] = round((1 - 1/4) * 255) = round(191.25) = 191
    ///   gradient[0] = round((1 - 2/4) * 255) = round(127.5)  = 128
    #[test]
    fn z_blend_gradient_receding_pixels_simple() {
        let width = 5;
        let height = 1;
        let current = vec![0u8, 0, 255, 255, 255];
        let prior = vec![255u8; 5];
        let priors: Vec<Vec<u8>> = vec![prior];
        let mut masks: Vec<Vec<u8>> = vec![priors[0].clone(), current];

        z_blend_all_layers(&mut masks, width, height, 1, 4, None);

        let layer = &masks[1];
        // Receding pixels get gradient lifted
        assert!(
            layer[0] > 0,
            "pixel 0 should have gradient > 0, got {}",
            layer[0]
        );
        assert!(
            layer[1] > 0,
            "pixel 1 should have gradient > 0, got {}",
            layer[1]
        );
        // Pixel closer to the edge should have higher gradient
        assert!(
            layer[1] > layer[0],
            "pixel closer to current edge (idx 1) should have higher gradient; got {} vs {}",
            layer[1],
            layer[0]
        );
        // Solid pixels in current layer are untouched
        assert_eq!(layer[2], 255);
        assert_eq!(layer[3], 255);
        assert_eq!(layer[4], 255);
    }

    /// Identical adjacent layers → no receding area → gradient is all-zeros
    /// (straight wall: no blending needed).
    #[test]
    fn z_blend_straight_wall_no_gradient() {
        let width = 4;
        let height = 4;
        // Both layers identical: a 4×4 block
        let layer = vec![255u8; 16];
        let mut masks = vec![layer.clone(), layer];

        z_blend_all_layers(&mut masks, width, height, 1, 20, None);

        // No gradient should have been added (nothing to blend)
        assert_eq!(masks[1], vec![255u8; 16]);
    }

    /// Completely empty prior layer → no receding area.
    #[test]
    fn z_blend_empty_prior_no_gradient() {
        let width = 4;
        let height = 4;
        let empty = vec![0u8; 16];
        let solid = vec![128u8; 16];
        let mut masks = vec![empty, solid.clone()];

        z_blend_all_layers(&mut masks, width, height, 1, 20, None);

        // Current layer should be unchanged
        assert_eq!(masks[1], solid);
    }

    /// Gradient should never reduce an existing bright pixel.
    #[test]
    fn z_blend_merge_never_reduces_existing() {
        let width = 3;
        let height = 1;
        // prior: all solid; current: middle pixel at 200 (from Blur AA), sides empty
        let prior = vec![255u8, 255, 255];
        let current = vec![0u8, 200, 0];
        let mut masks = vec![prior, current];

        z_blend_all_layers(&mut masks, width, height, 1, 10, None);

        // Middle pixel (200) must not be reduced even if gradient is < 200
        assert!(
            masks[1][1] >= 200,
            "existing bright pixel reduced: {}",
            masks[1][1]
        );
    }

    /// Gradient clipped at fade_px: pixels beyond the fade distance stay at 0.
    #[test]
    fn z_blend_gradient_clipped_at_fade_distance() {
        // 10-pixel-wide strip. Prior=all, current=right half only.
        // fade_px=3 → only pixels within 3 steps of the current edge get a gradient.
        let width = 10;
        let height = 1;
        let prior = vec![255u8; 10];
        // current: pixels 5..9 are solid (255), 0..4 are empty
        let mut current = vec![0u8; 10];
        for i in 5..10 {
            current[i] = 255;
        }
        let mut masks = vec![prior, current];

        z_blend_all_layers(&mut masks, width, height, 1, 3, None);

        let layer = &masks[1];
        // Pixels 2, 3, 4 are within fade_px=3 of the current edge (at index 5)
        // Pixel 1 is 4 steps away → should be 0
        assert_eq!(
            layer[0], 0,
            "pixel 0 (dist=5) should be 0, got {}",
            layer[0]
        );
        assert_eq!(
            layer[1], 0,
            "pixel 1 (dist=4) should be 0, got {}",
            layer[1]
        );
        assert!(
            layer[2] > 0,
            "pixel 2 (dist=3) should have gradient, got {}",
            layer[2]
        );
        assert!(
            layer[3] > layer[2],
            "pixel 3 (dist=2) closer → higher, got {} vs {}",
            layer[3],
            layer[2]
        );
        assert!(
            layer[4] > layer[3],
            "pixel 4 (dist=1) closest → highest, got {} vs {}",
            layer[4],
            layer[3]
        );
    }

    /// Low-alpha Blur edge pixels must still count as occupied for 3DAA
    /// topology/edge detection. If they are treated as empty (old thresholded
    /// behaviour), 3DAA effectively re-binarizes the mask and produces legacy
    /// AA-like edges.
    #[test]
    fn z_blend_treats_nonzero_alpha_as_occupied() {
        let width = 4;
        let height = 1;

        // Prior has a pixel where current only has low-alpha blur coverage.
        let prior = vec![0u8, 255, 255, 255];
        let current = vec![0u8, 40, 255, 255];
        let mut masks = vec![prior, current.clone()];

        z_blend_all_layers(&mut masks, width, height, 1, 3, None);

        // Pixel 1 (alpha=40) is part of the current layer and should not be
        // treated as receding; it must remain unchanged.
        assert_eq!(masks[1][1], 40);
    }

    /// Default LUT is monotonically non-decreasing.
    #[test]
    fn default_lut_monotone() {
        let lut = default_z_blend_lut();
        for i in 1..256 {
            assert!(
                lut[i] >= lut[i - 1],
                "LUT not monotone at index {}: {} < {}",
                i,
                lut[i],
                lut[i - 1]
            );
        }
        assert_eq!(lut[0], 0);
        assert_eq!(lut[255], 255);
    }
}
