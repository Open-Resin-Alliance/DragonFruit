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
    /// BFS distance map. u16 is sufficient since fade_px is always well under
    /// 65535 in practice; halving the element size saves ~112 MB at 7680².
    dist: Vec<u16>,
    queue: VecDeque<usize>,
}

impl ZBlendWorkspace {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width.saturating_mul(height);
        Self {
            in_prior: vec![0u8; n],
            dist: vec![u16::MAX; n],
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
            self.dist.resize(n, u16::MAX);
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
            &mut self.queue,
        );
    }

    pub fn blend_layer_inplace_with_roi(
        &mut self,
        current: &mut [u8],
        priors: &[&[u8]],
        width: usize,
        height: usize,
        fade_px: u32,
        lut: Option<&[u8; 256]>,
        roi: (usize, usize, usize, usize),
    ) {
        let n = width.saturating_mul(height);
        if self.in_prior.len() != n {
            self.in_prior.resize(n, 0);
        }
        if self.dist.len() != n {
            self.dist.resize(n, u16::MAX);
        }

        z_blend_layer_inplace_with_roi(
            current,
            priors,
            width,
            height,
            fade_px,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.queue,
            roi,
        );
    }

    /// Apply forward (lookahead) Z-blend compensation to a processed mask.
    ///
    /// For each "pre-appearing" pixel — one absent from `topology` (this layer)
    /// but present in at least one of `futures` (upcoming layers) — computes a
    /// Manhattan-distance BFS from the topology boundary outward and applies a
    /// depth-scaled alpha gradient that is symmetric to the backward receding
    /// gradient produced by [`blend_layer_inplace`].
    ///
    /// **Why this prevents dimensional overgrowth:** without forward compensation
    /// only shrinking edges receive a gradient (backward receding), biasing the
    /// total exposure dose toward over-curing at feature endings.  By giving
    /// growing edges an identical pre-appearing gradient, both transitions are
    /// treated symmetrically and the net Z-dimensional footprint is neutral.
    ///
    /// `look_back` should be the same value used for backward blending so the
    /// peak alpha formula is identical in both directions:
    /// `peak = 255 × look_back / (look_back + 1)` for the nearest layer.
    pub fn blend_layer_forward_inplace(
        &mut self,
        mask: &mut [u8],
        topology: &[u8],
        futures: &[&[u8]],
        look_back: usize,
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
            self.dist.resize(n, u16::MAX);
        }
        z_blend_forward_inplace(
            mask,
            topology,
            futures,
            look_back,
            width,
            height,
            fade_px,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.queue,
        );
    }

    pub fn blend_layer_forward_inplace_with_roi(
        &mut self,
        mask: &mut [u8],
        topology: &[u8],
        futures: &[&[u8]],
        look_back: usize,
        width: usize,
        height: usize,
        fade_px: u32,
        lut: Option<&[u8; 256]>,
        roi: (usize, usize, usize, usize),
    ) {
        let n = width.saturating_mul(height);
        if self.in_prior.len() != n {
            self.in_prior.resize(n, 0);
        }
        if self.dist.len() != n {
            self.dist.resize(n, u16::MAX);
        }
        z_blend_forward_inplace_with_roi(
            mask,
            topology,
            futures,
            look_back,
            width,
            height,
            fade_px,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.queue,
            roi,
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
    dist: &mut [u16],
    queue: &mut VecDeque<usize>,
) {
    if width == 0 || height == 0 {
        return;
    }
    z_blend_layer_inplace_with_roi(
        current,
        priors,
        width,
        height,
        fade_px,
        lut,
        in_prior,
        dist,
        queue,
        (0, width - 1, 0, height - 1),
    );
}

#[inline]
fn normalize_roi(
    width: usize,
    height: usize,
    roi: (usize, usize, usize, usize),
) -> Option<(usize, usize, usize, usize)> {
    if width == 0 || height == 0 {
        return None;
    }
    let (min_x, max_x, min_y, max_y) = roi;
    if min_x >= width || min_y >= height {
        return None;
    }
    let clamped_max_x = max_x.min(width - 1);
    let clamped_max_y = max_y.min(height - 1);
    if min_x > clamped_max_x || min_y > clamped_max_y {
        return None;
    }
    Some((min_x, clamped_max_x, min_y, clamped_max_y))
}

fn z_blend_layer_inplace_with_roi(
    current: &mut [u8],
    priors: &[&[u8]],
    width: usize,
    height: usize,
    fade_px: u32,
    lut: Option<&[u8; 256]>,
    in_prior: &mut [u8],
    dist: &mut [u16],
    queue: &mut VecDeque<usize>,
    roi: (usize, usize, usize, usize),
) {
    let Some((roi_min_x, roi_max_x, roi_min_y, roi_max_y)) = normalize_roi(width, height, roi)
    else {
        return;
    };
    // Topology threshold used ONLY for occupancy/boundary detection.
    //
    // Using non-zero alpha here makes blur fringes count as "solid", which can
    // create detached ghost shells and non-physical re-brightening when older,
    // wider layers leak into later layers through look-back blending.
    //
    // Keep the output mask itself full-grayscale; this threshold is only for
    // geometric classification in the EDT pass.
    const TOPO_THRESHOLD: u8 = 127;

    // -- Step 1: build Z-depth map for prior-layer pixels. --
    //
    // in_prior[idx] = 0  → pixel not in any prior layer
    // in_prior[idx] = d  → pixel last present d layers ago
    //                       (d=1 = most-recent prior N-1, d=2 = N-2, …)
    //
    // Iterating priors from most-recent to oldest means the FIRST write wins,
    // so in_prior always records the minimum (most-recent) depth.  Depth is used
    // in Step 3 to scale the receding gradient peak: a pixel that was solid just
    // one layer ago blends in close to 255; one from two layers ago is dimmer.
    for y in roi_min_y..=roi_max_y {
        let row = y * width;
        for x in roi_min_x..=roi_max_x {
            in_prior[row + x] = 0;
        }
    }

    let mut receding_any = false;
    let mut rec_min_x = width;
    let mut rec_max_x = 0usize;
    let mut rec_min_y = height;
    let mut rec_max_y = 0usize;

    for (depth_idx, prior) in priors.iter().rev().enumerate() {
        let depth_val = (depth_idx + 1) as u8; // 1 = most-recent, 2 = older …
        for y in roi_min_y..=roi_max_y {
            let row = y * width;
            for x in roi_min_x..=roi_max_x {
                let idx = row + x;
                if prior[idx] > TOPO_THRESHOLD && in_prior[idx] == 0 {
                    in_prior[idx] = depth_val;
                    if current[idx] <= TOPO_THRESHOLD {
                        receding_any = true;
                        rec_min_x = rec_min_x.min(x);
                        rec_max_x = rec_max_x.max(x);
                        rec_min_y = rec_min_y.min(y);
                        rec_max_y = rec_max_y.max(y);
                    }
                }
            }
        }
    }

    // Quick early-out: if no receding pixels exist (prior occupied, current empty),
    // there is nothing to blend for this layer.
    if !receding_any {
        return;
    }

    // Seed scan needs one-pixel expansion around receding zone to find current
    // boundary pixels adjacent to receding pixels.
    let seed_min_x = rec_min_x.saturating_sub(1);
    let seed_min_y = rec_min_y.saturating_sub(1);
    let seed_max_x = (rec_max_x + 1).min(width - 1);
    let seed_max_y = (rec_max_y + 1).min(height - 1);

    // -- Step 2: BFS from current-layer boundary into receding area. --
    for y in rec_min_y..=rec_max_y {
        let row_start = y * width;
        for x in rec_min_x..=rec_max_x {
            dist[row_start + x] = u16::MAX;
        }
    }
    for y in seed_min_y..=seed_max_y {
        let row_start = y * width;
        for x in seed_min_x..=seed_max_x {
            dist[row_start + x] = u16::MAX;
        }
    }
    queue.clear();

    // Seed: current-layer pixels that border at least one non-current pixel.
    // These are distance=0 from the boundary edge.
    for y in seed_min_y..=seed_max_y {
        for x in seed_min_x..=seed_max_x {
            let idx = y * width + x;
            if current[idx] <= TOPO_THRESHOLD {
                continue; // not in current layer
            }
            if has_non_current_4neighbor(current, x, y, width, height, TOPO_THRESHOLD) {
                dist[idx] = 0;
                queue.push_back(idx);
            }
        }
    }

    // BFS: spread distance outward into receding pixels (in_prior=1, not in current).
    while let Some(idx) = queue.pop_front() {
        // saturating_add guards against the theoretical u16::MAX wrap; in
        // practice fade_px is always << 65535 so this never saturates.
        let next_d = dist[idx].saturating_add(1);
        if (next_d as u32) > fade_px {
            continue;
        }
        let y = idx / width;
        let x = idx % width;

        macro_rules! try_neighbor {
            ($nidx:expr) => {
                let nidx = $nidx;
                // Only enter pixels that are receding (in prior, not in current)
                // and that haven't been reached with a shorter distance yet.
                if current[nidx] <= TOPO_THRESHOLD && in_prior[nidx] > 0 && dist[nidx] > next_d {
                    dist[nidx] = next_d;
                    queue.push_back(nidx);
                }
            };
        }

        if x > rec_min_x {
            try_neighbor!(idx - 1);
        }
        if x < rec_max_x {
            try_neighbor!(idx + 1);
        }
        if y > rec_min_y {
            try_neighbor!(idx - width);
        }
        if y < rec_max_y {
            try_neighbor!(idx + width);
        }
    }

    // -- Step 3: convert distances → gradient, apply LUT, max-merge. --
    // Use fade_px+1 as divisor so the pixel AT fade_px distance still gets a
    // small but non-zero gradient value (inclusive boundary).
    let fade_denom = (fade_px + 1) as f32;
    for y in rec_min_y..=rec_max_y {
        let row_start = y * width;
        for x in rec_min_x..=rec_max_x {
            let idx = row_start + x;
            // Only receding pixels get a gradient.
            if current[idx] <= TOPO_THRESHOLD && in_prior[idx] > 0 && (dist[idx] as u32) <= fade_px
            {
                // Scale the gradient peak by Z-depth so prior layers bleed into
                // the current layer at proportionally lower alpha:
                //
                //   peak = 255 × (look_back + 1 − depth) / (look_back + 1)
                //
                // depth=1 (most-recent prior N-1): peak = look_back/(look_back+1) × 255
                // depth=2 (one layer older N-2):   peak = (look_back-1)/(look_back+1) × 255
                // …
                //
                // The current layer always stays at full 255 and is never reduced
                // here; only the receding zone outside the current boundary is
                // affected.  Within that zone the XY distance further attenuates:
                // alpha = peak × (1 − dist/fade_px), giving a smooth 2D gradient
                // that also encodes the Z-layer history.
                let look_back = priors.len();
                let depth = in_prior[idx] as usize;
                let peak_alpha = if look_back > 0 && depth <= look_back {
                    let num = (look_back + 1).saturating_sub(depth) as f32;
                    (255.0 * num / (look_back + 1) as f32).round() as u8
                } else {
                    255
                };
                let t = 1.0 - (dist[idx] as f32 / fade_denom);
                let raw = (t * peak_alpha as f32 + 0.5) as u8;
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
    }
}

/// Forward EDT Z-blend: bleed pre-appearing pixels (not in `topology` but
/// present in at least one of `futures`) into `mask` using a symmetric
/// depth-scaled gradient.
///
/// Mirrors `z_blend_layer_inplace` but operates on growing edges instead of
/// shrinking ones.  The `look_back` denominator is shared so that peak alphas
/// are identical for the nearest layer in each direction.
fn z_blend_forward_inplace(
    mask: &mut [u8],
    topology: &[u8],
    futures: &[&[u8]],
    look_back: usize,
    width: usize,
    height: usize,
    fade_px: u32,
    lut: Option<&[u8; 256]>,
    in_forward: &mut [u8],
    dist: &mut [u16],
    queue: &mut VecDeque<usize>,
) {
    if width == 0 || height == 0 {
        return;
    }
    z_blend_forward_inplace_with_roi(
        mask,
        topology,
        futures,
        look_back,
        width,
        height,
        fade_px,
        lut,
        in_forward,
        dist,
        queue,
        (0, width - 1, 0, height - 1),
    );
}

fn z_blend_forward_inplace_with_roi(
    mask: &mut [u8],
    topology: &[u8],
    futures: &[&[u8]],
    look_back: usize,
    width: usize,
    height: usize,
    fade_px: u32,
    lut: Option<&[u8; 256]>,
    in_forward: &mut [u8],
    dist: &mut [u16],
    queue: &mut VecDeque<usize>,
    roi: (usize, usize, usize, usize),
) {
    if futures.is_empty() || fade_px == 0 || look_back == 0 {
        return;
    }
    let Some((roi_min_x, roi_max_x, roi_min_y, roi_max_y)) = normalize_roi(width, height, roi)
    else {
        return;
    };
    const TOPO_THRESHOLD: u8 = 127;

    // Build forward depth map: in_forward[idx] = d → pixel first appears
    // d layers ahead (d=1 = next layer = most-recent future, d=2 = further …).
    // Iterating from most-recent future to furthest means the FIRST write wins,
    // recording the minimum (nearest) future depth.  Only pixels absent from
    // the current topology can be pre-appearing.
    for y in roi_min_y..=roi_max_y {
        let row = y * width;
        for x in roi_min_x..=roi_max_x {
            in_forward[row + x] = 0;
        }
    }

    let mut appearing_any = false;
    let mut app_min_x = width;
    let mut app_max_x = 0usize;
    let mut app_min_y = height;
    let mut app_max_y = 0usize;

    for (depth_idx, future) in futures.iter().enumerate() {
        let depth_val = (depth_idx + 1) as u8;
        for y in roi_min_y..=roi_max_y {
            let row = y * width;
            for x in roi_min_x..=roi_max_x {
                let idx = row + x;
                if future[idx] > TOPO_THRESHOLD && in_forward[idx] == 0 {
                    in_forward[idx] = depth_val;
                    if topology[idx] <= TOPO_THRESHOLD {
                        appearing_any = true;
                        app_min_x = app_min_x.min(x);
                        app_max_x = app_max_x.max(x);
                        app_min_y = app_min_y.min(y);
                        app_max_y = app_max_y.max(y);
                    }
                }
            }
        }
    }

    // Quick early-out: if no pre-appearing pixels exist, there's no forward blend.
    if !appearing_any {
        return;
    }

    let seed_min_x = app_min_x.saturating_sub(1);
    let seed_min_y = app_min_y.saturating_sub(1);
    let seed_max_x = (app_max_x + 1).min(width - 1);
    let seed_max_y = (app_max_y + 1).min(height - 1);

    // Reset dist in the working ROI.
    for y in app_min_y..=app_max_y {
        let row = y * width;
        for x in app_min_x..=app_max_x {
            dist[row + x] = u16::MAX;
        }
    }
    for y in seed_min_y..=seed_max_y {
        let row = y * width;
        for x in seed_min_x..=seed_max_x {
            dist[row + x] = u16::MAX;
        }
    }
    queue.clear();

    // Seed: topology boundary pixels that border at least one non-topology pixel.
    for y in seed_min_y..=seed_max_y {
        for x in seed_min_x..=seed_max_x {
            let idx = y * width + x;
            if topology[idx] <= TOPO_THRESHOLD {
                continue;
            }
            if has_non_current_4neighbor(topology, x, y, width, height, TOPO_THRESHOLD) {
                dist[idx] = 0;
                queue.push_back(idx);
            }
        }
    }

    // BFS into pre-appearing pixels.
    while let Some(idx) = queue.pop_front() {
        let next_d = dist[idx].saturating_add(1);
        if (next_d as u32) > fade_px {
            continue;
        }
        let y = idx / width;
        let x = idx % width;

        macro_rules! try_neighbor {
            ($nidx:expr) => {
                let nidx = $nidx;
                if topology[nidx] <= TOPO_THRESHOLD && in_forward[nidx] > 0 && dist[nidx] > next_d {
                    dist[nidx] = next_d;
                    queue.push_back(nidx);
                }
            };
        }

        if x > app_min_x {
            try_neighbor!(idx - 1);
        }
        if x < app_max_x {
            try_neighbor!(idx + 1);
        }
        if y > app_min_y {
            try_neighbor!(idx - width);
        }
        if y < app_max_y {
            try_neighbor!(idx + width);
        }
    }

    // Convert distances → gradient, apply LUT, max-merge into mask.
    // Peak alpha uses look_back as the denominator (same as backward) so that
    // the nearest future layer (depth=1) gives exactly the same peak as the
    // nearest prior layer (depth=1).
    let fade_denom = (fade_px + 1) as f32;
    let denominator = (look_back + 1) as f32;
    for y in app_min_y..=app_max_y {
        let row_start = y * width;
        for x in app_min_x..=app_max_x {
            let idx = row_start + x;
            if topology[idx] <= TOPO_THRESHOLD
                && in_forward[idx] > 0
                && (dist[idx] as u32) <= fade_px
            {
                let depth = in_forward[idx] as usize;
                let num = (look_back + 1).saturating_sub(depth) as f32;
                let peak_alpha = (255.0 * num / denominator).round() as u8;
                let t = 1.0 - (dist[idx] as f32 / fade_denom);
                let raw = (t * peak_alpha as f32 + 0.5) as u8;
                let v = if let Some(lut) = lut {
                    lut[raw as usize]
                } else {
                    raw
                };
                if v > mask[idx] {
                    mask[idx] = v;
                }
            }
        }
    }
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

    /// Low-alpha blur fringe should not define 3DAA topology. Treating it as
    /// occupied can generate detached ghost shells from old wider layers.
    #[test]
    fn z_blend_ignores_low_alpha_for_topology() {
        let width = 4;
        let height = 1;

        // Prior has a pixel where current only has low-alpha blur coverage.
        let prior = vec![0u8, 255, 255, 255];
        let current = vec![0u8, 40, 255, 255];
        let mut masks = vec![prior, current.clone()];

        z_blend_all_layers(&mut masks, width, height, 1, 3, None);

        // Pixel 1 is below topology threshold, so it remains receding and can
        // be raised by z-blend relative to the low-alpha fringe value.
        assert!(masks[1][1] >= 40);

        // Current fully-solid pixels remain intact.
        assert_eq!(masks[1][2], 255);
        assert_eq!(masks[1][3], 255);

        // Pixels well outside fade remain untouched.
        assert_eq!(masks[1][0], 0);
    }

    /// Existing low-alpha fringe should be preserved when no receding
    /// topology exists.
    #[test]
    fn z_blend_preserves_low_alpha_when_layers_match() {
        let width = 4;
        let height = 1;
        let prior = vec![0u8, 40, 255, 255];
        let current = vec![0u8, 40, 255, 255];
        let mut masks = vec![prior, current.clone()];

        z_blend_all_layers(&mut masks, width, height, 1, 3, None);

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
