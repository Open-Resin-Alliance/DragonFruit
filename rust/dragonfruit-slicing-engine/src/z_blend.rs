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
    /// Back-BFS distance map for the two-BFS smooth gradient (slope-adaptive
    /// mode): distance from the outer edge of the receding / appearing zone.
    dist_back: Vec<u16>,
    queue: VecDeque<usize>,
}

impl ZBlendWorkspace {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width.saturating_mul(height);
        Self {
            in_prior: vec![0u8; n],
            dist: vec![u16::MAX; n],
            dist_back: vec![u16::MAX; n],
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

    // -----------------------------------------------------------------------
    // Slope-adaptive variants — no global fade_px; gradient derived from
    // layer-history depth instead of XY distance, automatically calibrating
    // to the local surface slope without any manual tuning.
    // -----------------------------------------------------------------------

    /// Slope-adaptive backward blend.
    ///
    /// Receding pixels (present in prior layers, absent from current) receive a
    /// gradient value of `(look_back + 1 − depth) / (look_back + 1)` passed
    /// through the LUT, where `depth` is how many layers ago the pixel was last
    /// solid. This fraction is the correct Z-coverage proxy for any surface
    /// slope: steep slopes produce narrow depth-rings (fine gradient), shallow
    /// slopes produce wide rings (gentle gradient) — all without a `fade_px`
    /// knob.
    ///
    /// The BFS connectivity check is still performed so that isolated in-prior
    /// islands disconnected from the current boundary are not affected.
    pub fn blend_layer_slope_adaptive_inplace(
        &mut self,
        current: &mut [u8],
        priors: &[&[u8]],
        width: usize,
        height: usize,
        lut: Option<&[u8; 256]>,
    ) {
        let n = width.saturating_mul(height);
        if self.in_prior.len() != n {
            self.in_prior.resize(n, 0);
        }
        if self.dist.len() != n {
            self.dist.resize(n, u16::MAX);
        }
        if self.dist_back.len() != n {
            self.dist_back.resize(n, u16::MAX);
        }
        if width == 0 || height == 0 {
            return;
        }
        z_blend_layer_slope_adaptive_inplace_with_roi(
            current,
            priors,
            width,
            height,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.dist_back,
            &mut self.queue,
            (0, width - 1, 0, height - 1),
        );
    }

    /// Slope-adaptive backward blend with ROI.
    pub fn blend_layer_slope_adaptive_inplace_with_roi(
        &mut self,
        current: &mut [u8],
        priors: &[&[u8]],
        width: usize,
        height: usize,
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
        if self.dist_back.len() != n {
            self.dist_back.resize(n, u16::MAX);
        }
        z_blend_layer_slope_adaptive_inplace_with_roi(
            current,
            priors,
            width,
            height,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.dist_back,
            &mut self.queue,
            roi,
        );
    }

    /// Slope-adaptive forward blend.
    ///
    /// Pre-appearing pixels (absent from current topology but present in future
    /// layers) receive the same depth-proportional gradient as the backward
    /// variant so that growing and shrinking edges are treated symmetrically.
    pub fn blend_layer_forward_slope_adaptive_inplace(
        &mut self,
        mask: &mut [u8],
        topology: &[u8],
        futures: &[&[u8]],
        look_back: usize,
        width: usize,
        height: usize,
        lut: Option<&[u8; 256]>,
    ) {
        let n = width.saturating_mul(height);
        if self.in_prior.len() != n {
            self.in_prior.resize(n, 0);
        }
        if self.dist.len() != n {
            self.dist.resize(n, u16::MAX);
        }
        if self.dist_back.len() != n {
            self.dist_back.resize(n, u16::MAX);
        }
        if width == 0 || height == 0 {
            return;
        }
        z_blend_forward_slope_adaptive_inplace_with_roi(
            mask,
            topology,
            futures,
            look_back,
            width,
            height,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.dist_back,
            &mut self.queue,
            (0, width - 1, 0, height - 1),
        );
    }

    /// Slope-adaptive forward blend with ROI.
    pub fn blend_layer_forward_slope_adaptive_inplace_with_roi(
        &mut self,
        mask: &mut [u8],
        topology: &[u8],
        futures: &[&[u8]],
        look_back: usize,
        width: usize,
        height: usize,
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
        if self.dist_back.len() != n {
            self.dist_back.resize(n, u16::MAX);
        }
        z_blend_forward_slope_adaptive_inplace_with_roi(
            mask,
            topology,
            futures,
            look_back,
            width,
            height,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.dist_back,
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

// ---------------------------------------------------------------------------
// Slope-adaptive private implementations
// ---------------------------------------------------------------------------

/// Slope-adaptive backward blend.
///
/// Gradient formula: `fraction = (look_back + 1 - depth) / (look_back + 1)`,
/// where `depth = in_prior[idx]` (layers since pixel was last solid).  No
/// global `fade_px` limit; the BFS terminates naturally at the edge of the
/// look-back zone (`in_prior == 0`).
///
/// This automatically calibrates to local surface slope:
/// - Steep/vertical surfaces → narrow depth-rings → sharp, physically correct gradient.
/// - Shallow surfaces → wide depth-rings → gentle gradient spanning the full zone.
fn z_blend_layer_slope_adaptive_inplace_with_roi(
    current: &mut [u8],
    priors: &[&[u8]],
    width: usize,
    height: usize,
    lut: Option<&[u8; 256]>,
    in_prior: &mut [u8],
    dist: &mut [u16],
    dist_back: &mut [u16],
    queue: &mut VecDeque<usize>,
    roi: (usize, usize, usize, usize),
) {
    let Some((roi_min_x, roi_max_x, roi_min_y, roi_max_y)) = normalize_roi(width, height, roi)
    else {
        return;
    };
    const TOPO_THRESHOLD: u8 = 127;

    // Step 1 — build depth map (same as standard z_blend).
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
        let depth_val = (depth_idx + 1) as u8;
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

    if !receding_any {
        return;
    }

    let seed_min_x = rec_min_x.saturating_sub(1);
    let seed_min_y = rec_min_y.saturating_sub(1);
    let seed_max_x = (rec_max_x + 1).min(width - 1);
    let seed_max_y = (rec_max_y + 1).min(height - 1);

    // Step 2 — chamfer EDT from the inner boundary.  8-connected propagation
    // (cardinal weight 10, diagonal weight 14) approximates Euclidean distance
    // and eliminates the sawtooth iso-distance contours of 4-connected BFS.
    for y in rec_min_y..=rec_max_y {
        let row = y * width;
        for x in rec_min_x..=rec_max_x {
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

    for y in seed_min_y..=seed_max_y {
        for x in seed_min_x..=seed_max_x {
            let idx = y * width + x;
            if current[idx] <= TOPO_THRESHOLD {
                continue;
            }
            if has_non_current_4neighbor(current, x, y, width, height, TOPO_THRESHOLD) {
                dist[idx] = 0;
                queue.push_back(idx);
            }
        }
    }

    // Forward chamfer EDT pass (top-left → bottom-right).
    for y in rec_min_y..=rec_max_y {
        for x in rec_min_x..=rec_max_x {
            let idx = y * width + x;
            if current[idx] > TOPO_THRESHOLD || in_prior[idx] == 0 {
                continue;
            }
            let mut d = u16::MAX;
            if y > 0 {
                let ra = (y - 1) * width;
                if x > 0 && dist[ra + x - 1] < u16::MAX {
                    d = d.min(dist[ra + x - 1].saturating_add(14));
                }
                if dist[ra + x] < u16::MAX {
                    d = d.min(dist[ra + x].saturating_add(10));
                }
                if x + 1 < width && dist[ra + x + 1] < u16::MAX {
                    d = d.min(dist[ra + x + 1].saturating_add(14));
                }
            }
            if x > 0 && dist[idx - 1] < u16::MAX {
                d = d.min(dist[idx - 1].saturating_add(10));
            }
            dist[idx] = d;
        }
    }
    // Backward chamfer EDT pass (bottom-right → top-left).
    for y in (rec_min_y..=rec_max_y).rev() {
        for x in (rec_min_x..=rec_max_x).rev() {
            let idx = y * width + x;
            if current[idx] > TOPO_THRESHOLD || in_prior[idx] == 0 {
                continue;
            }
            let mut d = dist[idx];
            if y + 1 < height {
                let rb = (y + 1) * width;
                if x > 0 && dist[rb + x - 1] < u16::MAX {
                    d = d.min(dist[rb + x - 1].saturating_add(14));
                }
                if dist[rb + x] < u16::MAX {
                    d = d.min(dist[rb + x].saturating_add(10));
                }
                if x + 1 < width && dist[rb + x + 1] < u16::MAX {
                    d = d.min(dist[rb + x + 1].saturating_add(14));
                }
            }
            if x + 1 < width && dist[idx + 1] < u16::MAX {
                d = d.min(dist[idx + 1].saturating_add(10));
            }
            dist[idx] = d;
        }
    }

    // Step 2b — back-EDT from the outer edge of the receding zone.
    //
    // Seeds are reachable receding pixels that abut the background (in_prior
    // == 0, not currently solid).  Combined with the front-BFS `dist` this
    // gives a per-pixel t = dist_back / (dist + dist_back) ∈ [0, 1] that is
    // 0 at the outer edge and 1 at the inner edge, capturing the LOCAL zone
    // width for any slope angle without any global normalisation.
    for y in rec_min_y..=rec_max_y {
        let row = y * width;
        for x in rec_min_x..=rec_max_x {
            dist_back[row + x] = u16::MAX;
        }
    }
    queue.clear();
    for y in rec_min_y..=rec_max_y {
        for x in rec_min_x..=rec_max_x {
            let idx = y * width + x;
            if in_prior[idx] == 0 || dist[idx] == u16::MAX {
                continue;
            }
            let mut on_outer_edge = false;
            if x > 0 {
                let ni = idx - 1;
                if in_prior[ni] == 0 && current[ni] <= TOPO_THRESHOLD {
                    on_outer_edge = true;
                }
            }
            if !on_outer_edge && x + 1 < width {
                let ni = idx + 1;
                if in_prior[ni] == 0 && current[ni] <= TOPO_THRESHOLD {
                    on_outer_edge = true;
                }
            }
            if !on_outer_edge && y > 0 {
                let ni = idx - width;
                if in_prior[ni] == 0 && current[ni] <= TOPO_THRESHOLD {
                    on_outer_edge = true;
                }
            }
            if !on_outer_edge && y + 1 < height {
                let ni = idx + width;
                if in_prior[ni] == 0 && current[ni] <= TOPO_THRESHOLD {
                    on_outer_edge = true;
                }
            }
            if on_outer_edge {
                dist_back[idx] = 0;
            }
        }
    }
    // Forward chamfer EDT pass for dist_back (top-left → bottom-right).
    for y in rec_min_y..=rec_max_y {
        for x in rec_min_x..=rec_max_x {
            let idx = y * width + x;
            if in_prior[idx] == 0 || dist[idx] == u16::MAX {
                continue;
            }
            let mut d = dist_back[idx];
            macro_rules! chk_b {
                ($ni:expr, $c:expr) => {
                    let ni = $ni;
                    if in_prior[ni] > 0 && dist[ni] != u16::MAX && dist_back[ni] < u16::MAX {
                        d = d.min(dist_back[ni].saturating_add($c));
                    }
                };
            }
            if y > 0 {
                let ra = (y - 1) * width;
                if x > 0 {
                    chk_b!(ra + x - 1, 14);
                }
                chk_b!(ra + x, 10);
                if x + 1 < width {
                    chk_b!(ra + x + 1, 14);
                }
            }
            if x > 0 {
                chk_b!(idx - 1, 10);
            }
            dist_back[idx] = d;
        }
    }
    // Backward chamfer EDT pass for dist_back (bottom-right → top-left).
    for y in (rec_min_y..=rec_max_y).rev() {
        for x in (rec_min_x..=rec_max_x).rev() {
            let idx = y * width + x;
            if in_prior[idx] == 0 || dist[idx] == u16::MAX {
                continue;
            }
            let mut d = dist_back[idx];
            macro_rules! chk_b {
                ($ni:expr, $c:expr) => {
                    let ni = $ni;
                    if in_prior[ni] > 0 && dist[ni] != u16::MAX && dist_back[ni] < u16::MAX {
                        d = d.min(dist_back[ni].saturating_add($c));
                    }
                };
            }
            if y + 1 < height {
                let rb = (y + 1) * width;
                if x > 0 {
                    chk_b!(rb + x - 1, 14);
                }
                chk_b!(rb + x, 10);
                if x + 1 < width {
                    chk_b!(rb + x + 1, 14);
                }
            }
            if x + 1 < width {
                chk_b!(idx + 1, 10);
            }
            dist_back[idx] = d;
        }
    }

    // Step 3 — continuous gradient: fraction = t, where
    //   t = dist_back / (dist + dist_back)  ∈ [0, 1]
    // is 0 at the outer edge and 1 at the inner edge.
    //
    // Unlike the depth-anchored formula, t varies continuously across ring
    // boundaries: adjacent pixels at a ring boundary differ by ≈1/zone_width
    // (≈3 % for a 30-px zone) instead of the 1/(L+1) ≈25 % step that caused
    // visible banding.  The gradient is scaled to [1/(L+1), (L+1)/(L+1)] so
    // inner-edge pixels approach solid density and outer-edge pixels receive
    // a small but nonzero exposure appropriate for the outermost depth ring.
    let look_back = priors.len();
    let denom = (look_back + 1) as f32;
    for y in rec_min_y..=rec_max_y {
        let row = y * width;
        for x in rec_min_x..=rec_max_x {
            let idx = row + x;
            if current[idx] <= TOPO_THRESHOLD && in_prior[idx] > 0 && dist[idx] != u16::MAX {
                let front = dist[idx] as f32;
                let t = if dist_back[idx] != u16::MAX {
                    let back = dist_back[idx] as f32;
                    let total = front + back;
                    if total > 0.0 {
                        back / total
                    } else {
                        0.5
                    }
                } else {
                    0.5 // enclosed zone — use midpoint
                };
                // Scale: outer edge (t=0) → 1/denom, inner edge (t=1) → 1.0.
                // Apply a depth-ring floor to handle thin-zone pixels: a pixel
                // adjacent to both the inner solid boundary and outer void
                // (concave corner, 1-px zone) gets dist_back=0 → t=0, giving
                // fraction=1/denom regardless of depth ring.  The floor
                // (L+1−d)/(L+1) ensures depth-ring 1 pixels always get at
                // least L/(L+1), matching the physical expectation without
                // reintroducing hard ring-boundary steps in normal wide zones.
                let depth = in_prior[idx] as usize;
                let fraction_floor = (look_back + 1).saturating_sub(depth) as f32 / denom;
                let fraction = ((1.0 + t * look_back as f32) / denom).max(fraction_floor);
                let raw = (fraction * 255.0 + 0.5) as u8;
                let v = if let Some(lut) = lut {
                    lut[raw as usize]
                } else {
                    raw
                };
                if v > current[idx] {
                    current[idx] = v;
                }
            }
        }
    }
}

/// Slope-adaptive forward blend.
///
/// Mirrors `z_blend_layer_slope_adaptive_inplace_with_roi` for the growing-edge
/// direction.  Pre-appearing pixels receive `(look_back + 1 - depth) /
/// (look_back + 1)` so that both edge directions are treated symmetrically.
fn z_blend_forward_slope_adaptive_inplace_with_roi(
    mask: &mut [u8],
    topology: &[u8],
    futures: &[&[u8]],
    look_back: usize,
    width: usize,
    height: usize,
    lut: Option<&[u8; 256]>,
    in_forward: &mut [u8],
    dist: &mut [u16],
    dist_back: &mut [u16],
    queue: &mut VecDeque<usize>,
    roi: (usize, usize, usize, usize),
) {
    if futures.is_empty() || look_back == 0 {
        return;
    }
    let Some((roi_min_x, roi_max_x, roi_min_y, roi_max_y)) = normalize_roi(width, height, roi)
    else {
        return;
    };
    const TOPO_THRESHOLD: u8 = 127;

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

    if !appearing_any {
        return;
    }

    let seed_min_x = app_min_x.saturating_sub(1);
    let seed_min_y = app_min_y.saturating_sub(1);
    let seed_max_x = (app_max_x + 1).min(width - 1);
    let seed_max_y = (app_max_y + 1).min(height - 1);

    // Step 2 — chamfer EDT from the inner boundary (8-connected, weights 10/14).
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

    // Forward chamfer EDT pass (top-left → bottom-right).
    for y in app_min_y..=app_max_y {
        for x in app_min_x..=app_max_x {
            let idx = y * width + x;
            if topology[idx] > TOPO_THRESHOLD || in_forward[idx] == 0 {
                continue;
            }
            let mut d = u16::MAX;
            if y > 0 {
                let ra = (y - 1) * width;
                if x > 0 && dist[ra + x - 1] < u16::MAX {
                    d = d.min(dist[ra + x - 1].saturating_add(14));
                }
                if dist[ra + x] < u16::MAX {
                    d = d.min(dist[ra + x].saturating_add(10));
                }
                if x + 1 < width && dist[ra + x + 1] < u16::MAX {
                    d = d.min(dist[ra + x + 1].saturating_add(14));
                }
            }
            if x > 0 && dist[idx - 1] < u16::MAX {
                d = d.min(dist[idx - 1].saturating_add(10));
            }
            dist[idx] = d;
        }
    }
    // Backward chamfer EDT pass (bottom-right → top-left).
    for y in (app_min_y..=app_max_y).rev() {
        for x in (app_min_x..=app_max_x).rev() {
            let idx = y * width + x;
            if topology[idx] > TOPO_THRESHOLD || in_forward[idx] == 0 {
                continue;
            }
            let mut d = dist[idx];
            if y + 1 < height {
                let rb = (y + 1) * width;
                if x > 0 && dist[rb + x - 1] < u16::MAX {
                    d = d.min(dist[rb + x - 1].saturating_add(14));
                }
                if dist[rb + x] < u16::MAX {
                    d = d.min(dist[rb + x].saturating_add(10));
                }
                if x + 1 < width && dist[rb + x + 1] < u16::MAX {
                    d = d.min(dist[rb + x + 1].saturating_add(14));
                }
            }
            if x + 1 < width && dist[idx + 1] < u16::MAX {
                d = d.min(dist[idx + 1].saturating_add(10));
            }
            dist[idx] = d;
        }
    }

    // Step 2b — back-EDT from the outer edge of the appearing zone.
    for y in app_min_y..=app_max_y {
        let row = y * width;
        for x in app_min_x..=app_max_x {
            dist_back[row + x] = u16::MAX;
        }
    }
    queue.clear();
    for y in app_min_y..=app_max_y {
        for x in app_min_x..=app_max_x {
            let idx = y * width + x;
            if in_forward[idx] == 0 || dist[idx] == u16::MAX {
                continue;
            }
            let mut on_outer_edge = false;
            if x > 0 {
                let ni = idx - 1;
                if in_forward[ni] == 0 && topology[ni] <= TOPO_THRESHOLD {
                    on_outer_edge = true;
                }
            }
            if !on_outer_edge && x + 1 < width {
                let ni = idx + 1;
                if in_forward[ni] == 0 && topology[ni] <= TOPO_THRESHOLD {
                    on_outer_edge = true;
                }
            }
            if !on_outer_edge && y > 0 {
                let ni = idx - width;
                if in_forward[ni] == 0 && topology[ni] <= TOPO_THRESHOLD {
                    on_outer_edge = true;
                }
            }
            if !on_outer_edge && y + 1 < height {
                let ni = idx + width;
                if in_forward[ni] == 0 && topology[ni] <= TOPO_THRESHOLD {
                    on_outer_edge = true;
                }
            }
            if on_outer_edge {
                dist_back[idx] = 0;
            }
        }
    }
    // Forward chamfer EDT pass for dist_back (top-left → bottom-right).
    for y in app_min_y..=app_max_y {
        for x in app_min_x..=app_max_x {
            let idx = y * width + x;
            if in_forward[idx] == 0 || dist[idx] == u16::MAX {
                continue;
            }
            let mut d = dist_back[idx];
            macro_rules! chk_b {
                ($ni:expr, $c:expr) => {
                    let ni = $ni;
                    if in_forward[ni] > 0 && dist[ni] != u16::MAX && dist_back[ni] < u16::MAX {
                        d = d.min(dist_back[ni].saturating_add($c));
                    }
                };
            }
            if y > 0 {
                let ra = (y - 1) * width;
                if x > 0 {
                    chk_b!(ra + x - 1, 14);
                }
                chk_b!(ra + x, 10);
                if x + 1 < width {
                    chk_b!(ra + x + 1, 14);
                }
            }
            if x > 0 {
                chk_b!(idx - 1, 10);
            }
            dist_back[idx] = d;
        }
    }
    // Backward chamfer EDT pass for dist_back (bottom-right → top-left).
    for y in (app_min_y..=app_max_y).rev() {
        for x in (app_min_x..=app_max_x).rev() {
            let idx = y * width + x;
            if in_forward[idx] == 0 || dist[idx] == u16::MAX {
                continue;
            }
            let mut d = dist_back[idx];
            macro_rules! chk_b {
                ($ni:expr, $c:expr) => {
                    let ni = $ni;
                    if in_forward[ni] > 0 && dist[ni] != u16::MAX && dist_back[ni] < u16::MAX {
                        d = d.min(dist_back[ni].saturating_add($c));
                    }
                };
            }
            if y + 1 < height {
                let rb = (y + 1) * width;
                if x > 0 {
                    chk_b!(rb + x - 1, 14);
                }
                chk_b!(rb + x, 10);
                if x + 1 < width {
                    chk_b!(rb + x + 1, 14);
                }
            }
            if x + 1 < width {
                chk_b!(idx + 1, 10);
            }
            dist_back[idx] = d;
        }
    }

    // Step 3 — continuous gradient: fraction = (1 + t·L) / (L+1) where
    //   t = dist_back / (dist + dist_back)  ∈ [0, 1].
    // No depth-anchor steps; ring boundaries cause ≈1/zone_width difference
    // in t between adjacent pixels rather than the 1/(L+1) ≈25 % jump.
    let denom = (look_back + 1) as f32;
    for y in app_min_y..=app_max_y {
        let row = y * width;
        for x in app_min_x..=app_max_x {
            let idx = row + x;
            if topology[idx] <= TOPO_THRESHOLD && in_forward[idx] > 0 && dist[idx] != u16::MAX {
                let front = dist[idx] as f32;
                let t = if dist_back[idx] != u16::MAX {
                    let back = dist_back[idx] as f32;
                    let total = front + back;
                    if total > 0.0 {
                        back / total
                    } else {
                        0.5
                    }
                } else {
                    0.5
                };
                let depth = in_forward[idx] as usize;
                let fraction_floor = (look_back + 1).saturating_sub(depth) as f32 / denom;
                let fraction = ((1.0 + t * look_back as f32) / denom).max(fraction_floor);
                let raw = (fraction * 255.0 + 0.5) as u8;
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
// Experimental cross-blend (volumetric) API scaffolding
// ---------------------------------------------------------------------------

/// Configuration for experimental cross-layer volumetric blending.
///
/// This is the planned successor to the current 2.5D EDT compensation path.
/// For now it acts as a stable API surface while the kernel is developed.
#[derive(Debug, Clone, Copy)]
pub struct CrossBlendConfig {
    /// Number of prior/future layers sampled on each side.
    pub window_layers: usize,
    /// Spatial fade radius in pixels for XY distance attenuation.
    pub fade_px: u32,
    /// Temporal falloff exponent across Z neighbors.
    pub temporal_power: f32,
    /// Overall effect strength [0..1].
    pub strength: f32,
}

impl Default for CrossBlendConfig {
    fn default() -> Self {
        Self {
            window_layers: 4,
            fade_px: 8,
            temporal_power: 1.0,
            strength: 1.0,
        }
    }
}

/// Reusable scratch buffers for cross-blend experiments.
pub struct CrossBlendWorkspace {
    accum: Vec<f32>,
    dist: Vec<u16>,
    queue: VecDeque<usize>,
}

impl CrossBlendWorkspace {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width.saturating_mul(height);
        Self {
            accum: vec![0.0; n],
            dist: vec![u16::MAX; n],
            queue: VecDeque::with_capacity(n / 8),
        }
    }

    fn ensure_len(&mut self, n: usize) {
        if self.accum.len() != n {
            self.accum.resize(n, 0.0);
        }
        if self.dist.len() != n {
            self.dist.resize(n, u16::MAX);
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CrossBlendStats {
    pub contributing_layers: u32,
    pub touched_pixels: u32,
}

/// Experimental volumetric cross-blend entrypoint.
///
/// Current behavior is intentionally a no-op placeholder to keep output stable
/// while the full 3D accumulation kernel is introduced incrementally.
pub fn cross_blend_layer_inplace(
    mask: &mut [u8],
    center_topology: &[u8],
    priors: &[&[u8]],
    futures: &[&[u8]],
    width: usize,
    height: usize,
    cfg: &CrossBlendConfig,
    ws: &mut CrossBlendWorkspace,
) -> CrossBlendStats {
    let n = width.saturating_mul(height);
    if n == 0 || mask.len() < n || center_topology.len() < n {
        return CrossBlendStats::default();
    }
    if priors.is_empty() && futures.is_empty() {
        return CrossBlendStats::default();
    }

    const TOPO_THRESHOLD: u8 = 127;
    let strength = cfg.strength.clamp(0.0, 1.0);
    if strength <= 0.0 {
        return CrossBlendStats::default();
    }
    let temporal_power = cfg.temporal_power.max(0.05);
    let max_window = cfg.window_layers.max(1);

    ws.ensure_len(n);
    ws.accum.fill(0.0);
    ws.dist.fill(u16::MAX);
    ws.queue.clear();

    let mut touched_pixels: u32 = 0;
    let mut contributing_layers: u32 = 0;
    let mut max_temporal_weight = 0.0f32;

    // Priors are provided nearest-first in the streaming engine path when wired;
    // keep explicit depth indexing for deterministic falloff.
    for (depth_idx, prior) in priors.iter().take(max_window).enumerate() {
        let depth = depth_idx + 1;
        let w = 1.0f32 / (depth as f32).powf(temporal_power);
        if w <= 0.0 {
            continue;
        }
        max_temporal_weight += w;
        let mut layer_contributed = false;
        for i in 0..n {
            if prior[i] > TOPO_THRESHOLD {
                ws.accum[i] += w;
                layer_contributed = true;
            }
        }
        if layer_contributed {
            contributing_layers = contributing_layers.saturating_add(1);
        }
    }

    for (depth_idx, future) in futures.iter().take(max_window).enumerate() {
        let depth = depth_idx + 1;
        let w = 1.0f32 / (depth as f32).powf(temporal_power);
        if w <= 0.0 {
            continue;
        }
        max_temporal_weight += w;
        let mut layer_contributed = false;
        for i in 0..n {
            if future[i] > TOPO_THRESHOLD {
                ws.accum[i] += w;
                layer_contributed = true;
            }
        }
        if layer_contributed {
            contributing_layers = contributing_layers.saturating_add(1);
        }
    }

    if max_temporal_weight <= 0.0 {
        return CrossBlendStats {
            contributing_layers,
            touched_pixels,
        };
    }

    // Seed boundary of current topology and compute outward distances into
    // candidate cross-blend region (non-topology pixels with temporal support).
    let max_d = cfg.fade_px.max(1);
    for y in 0..height {
        for x in 0..width {
            let idx = y * width + x;
            if center_topology[idx] <= TOPO_THRESHOLD {
                continue;
            }
            if has_non_current_4neighbor(center_topology, x, y, width, height, TOPO_THRESHOLD) {
                ws.dist[idx] = 0;
                ws.queue.push_back(idx);
            }
        }
    }

    while let Some(idx) = ws.queue.pop_front() {
        let next_d = ws.dist[idx].saturating_add(1);
        if (next_d as u32) > max_d {
            continue;
        }
        let y = idx / width;
        let x = idx % width;

        macro_rules! try_neighbor {
            ($nidx:expr) => {
                let nidx = $nidx;
                if center_topology[nidx] <= TOPO_THRESHOLD
                    && ws.accum[nidx] > 0.0
                    && ws.dist[nidx] > next_d
                {
                    ws.dist[nidx] = next_d;
                    ws.queue.push_back(nidx);
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

    // Volumetric blend: temporal occupancy density normalized against maximum
    // sampled weight, modulated by XY distance fade from center-layer boundary.
    let fade_denom = (max_d + 1) as f32;
    for i in 0..n {
        if center_topology[i] > TOPO_THRESHOLD {
            continue;
        }
        if ws.accum[i] <= 0.0 {
            continue;
        }
        let d = ws.dist[i];
        if d == u16::MAX || (d as u32) > max_d {
            continue;
        }
        let occ = (ws.accum[i] / max_temporal_weight).clamp(0.0, 1.0);
        if occ <= 0.0 {
            continue;
        }
        let spatial = 1.0 - (d as f32 / fade_denom);
        if spatial <= 0.0 {
            continue;
        }
        let alpha = (occ * spatial * strength * 255.0).round().clamp(0.0, 255.0) as u8;
        if alpha > mask[i] {
            mask[i] = alpha;
            touched_pixels = touched_pixels.saturating_add(1);
        }
    }

    CrossBlendStats {
        contributing_layers,
        touched_pixels,
    }
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

    #[test]
    fn cross_blend_prototype_lifts_non_topology_pixel() {
        let width = 3;
        let height = 1;
        let mut mask = vec![0u8, 255, 0];
        let center_topology = vec![0u8, 255, 0];

        let prior = vec![255u8, 255, 0];
        let future = vec![255u8, 255, 0];
        let priors: Vec<&[u8]> = vec![prior.as_slice()];
        let futures: Vec<&[u8]> = vec![future.as_slice()];

        let cfg = CrossBlendConfig {
            window_layers: 2,
            fade_px: 8,
            temporal_power: 1.0,
            strength: 0.5,
        };
        let mut ws = CrossBlendWorkspace::new(width, height);

        let stats = cross_blend_layer_inplace(
            &mut mask,
            &center_topology,
            &priors,
            &futures,
            width,
            height,
            &cfg,
            &mut ws,
        );

        assert!(stats.touched_pixels >= 1);
        assert_eq!(mask[1], 255, "center topology pixel should remain solid");
        assert!(mask[0] > 0, "neighbor should receive volumetric lift");
        assert_eq!(mask[2], 0, "non-contributing side should remain unchanged");
    }

    #[test]
    fn cross_blend_applies_spatial_fade_from_boundary() {
        let width = 4;
        let height = 1;
        let mut mask = vec![0u8, 255, 0, 0];
        let center_topology = vec![0u8, 255, 0, 0];

        // Future occupancy exists on both empty-side pixels; nearest (idx2)
        // should receive stronger lift than farther (idx3) due to XY fade.
        let future = vec![0u8, 255, 255, 255];
        let futures: Vec<&[u8]> = vec![future.as_slice()];

        let cfg = CrossBlendConfig {
            window_layers: 1,
            fade_px: 3,
            temporal_power: 1.0,
            strength: 1.0,
        };
        let mut ws = CrossBlendWorkspace::new(width, height);

        let _stats = cross_blend_layer_inplace(
            &mut mask,
            &center_topology,
            &[],
            &futures,
            width,
            height,
            &cfg,
            &mut ws,
        );

        assert!(mask[2] > 0, "nearest pixel should be lifted");
        assert!(
            mask[3] > 0,
            "farther pixel should still be lifted within fade"
        );
        assert!(
            mask[2] > mask[3],
            "nearer pixel should be stronger than farther pixel; got {} vs {}",
            mask[2],
            mask[3]
        );
    }
}
