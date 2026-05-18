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

use rayon::prelude::*;

/// Reusable working buffers for single-layer 3DAA z-blending.
///
/// Internal scratch buffers (`in_prior`, `dist`, `seeds`, `edt_g`, `labels_buf`)
/// are sized to the **ROI** being processed, not the full image, and grow
/// monotonically as larger ROIs are encountered.  For a 12K printer (11520×5120,
/// ~59 M px) processing a typical model whose footprint is ~10–25% of the build
/// area, this yields a ~4–10× reduction in per-worker workspace RAM compared to
/// the previous W×H allocation.
pub struct ZBlendWorkspace {
    /// Backward/forward prior occupancy depth map. ROI-local, length ≥ roi_w*roi_h.
    in_prior: Vec<u8>,
    /// Felzenszwalb EDT distance map (exact Euclidean, in pixels). ROI-local.
    dist: Vec<f32>,
    /// Temporary seed-marker buffer used during the EDT phase. ROI-local.
    seeds: Vec<bool>,
    /// Scratch buffer for felzenszwalb_edt_roi Phase-1 squared horizontal distances.
    edt_g: Vec<f32>,
    /// Scratch buffer for label_receding_components output labels.
    labels_buf: Vec<u32>,
    /// Reusable BFS queue for label_receding_components (avoids per-layer VecDeque alloc).
    bfs_queue: VecDeque<usize>,
}

impl ZBlendWorkspace {
    pub fn new(_width: usize, _height: usize) -> Self {
        // Buffers grow on first use to the actual ROI size, not the full image.
        // This avoids a ~826 MB up-front allocation per worker at 12K.
        Self {
            in_prior: Vec::new(),
            dist: Vec::new(),
            seeds: Vec::new(),
            edt_g: Vec::new(),
            labels_buf: Vec::new(),
            bfs_queue: VecDeque::new(),
        }
    }

    /// Ensure ROI-local scratch buffers can hold at least `n = roi_w * roi_h`
    /// elements.  Grow-only: never shrinks, so worst-case ROI sets capacity.
    #[inline]
    fn ensure_roi_capacity(&mut self, n: usize) {
        if self.in_prior.len() < n {
            self.in_prior.resize(n, 0);
        }
        if self.dist.len() < n {
            self.dist.resize(n, f32::INFINITY);
        }
        if self.seeds.len() < n {
            self.seeds.resize(n, false);
        }
    }

    /// Approximate resident byte size of all ROI-local scratch.  Used by the
    /// engine's diagnostic to report actual (vs worst-case) workspace usage.
    pub fn resident_bytes(&self) -> usize {
        self.in_prior.capacity() * std::mem::size_of::<u8>()
            + self.dist.capacity() * std::mem::size_of::<f32>()
            + self.seeds.capacity() * std::mem::size_of::<bool>()
            + self.edt_g.capacity() * std::mem::size_of::<f32>()
            + self.labels_buf.capacity() * std::mem::size_of::<u32>()
            + self.bfs_queue.capacity() * std::mem::size_of::<usize>()
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
        if width == 0 || height == 0 {
            return;
        }
        // Full-image ROI.
        let roi = (0, width - 1, 0, height - 1);
        self.blend_layer_inplace_with_roi(current, priors, width, height, fade_px, lut, roi);
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
        let Some((roi_min_x, roi_max_x, roi_min_y, roi_max_y)) = normalize_roi(width, height, roi)
        else {
            return;
        };
        let roi_w = roi_max_x - roi_min_x + 1;
        let roi_h = roi_max_y - roi_min_y + 1;
        self.ensure_roi_capacity(roi_w * roi_h);
        z_blend_layer_inplace_with_roi(
            current,
            priors,
            width,
            height,
            fade_px,
            lut,
            &mut self.in_prior,
            &mut self.dist,
            &mut self.seeds,
            &mut self.edt_g,
            &mut self.labels_buf,
            &mut self.bfs_queue,
            (roi_min_x, roi_max_x, roi_min_y, roi_max_y),
        );
    }

    /// Apply forward (lookahead) Z-blend compensation to a processed mask.
    ///
    /// For each "pre-appearing" pixel — one absent from `topology` (this layer)
    /// but present in at least one of `futures` (upcoming layers) — computes the
    /// exact Euclidean distance from the topology boundary outward and applies a
    /// per-component-normalized alpha gradient symmetric to the backward receding
    /// gradient produced by [`blend_layer_inplace`].
    ///
    /// **Why this prevents dimensional overgrowth:** without forward compensation
    /// only shrinking edges receive a gradient (backward receding), biasing the
    /// total exposure dose toward over-curing at feature endings.  By giving
    /// growing edges an identical pre-appearing gradient, both transitions are
    /// treated symmetrically and the net Z-dimensional footprint is neutral.
    ///
    /// `look_back` should be the same value used for backward blending.
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
        if width == 0 || height == 0 {
            return;
        }
        let roi = (0, width - 1, 0, height - 1);
        self.blend_layer_forward_inplace_with_roi(
            mask, topology, futures, look_back, width, height, fade_px, lut, roi,
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
        let Some((roi_min_x, roi_max_x, roi_min_y, roi_max_y)) = normalize_roi(width, height, roi)
        else {
            return;
        };
        let roi_w = roi_max_x - roi_min_x + 1;
        let roi_h = roi_max_y - roi_min_y + 1;
        self.ensure_roi_capacity(roi_w * roi_h);
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
            &mut self.seeds,
            &mut self.edt_g,
            &mut self.labels_buf,
            &mut self.bfs_queue,
            (roi_min_x, roi_max_x, roi_min_y, roi_max_y),
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
    dist: &mut [f32],
    seeds: &mut [bool],
    edt_g: &mut Vec<f32>,
    labels_buf: &mut Vec<u32>,
    bfs_queue: &mut VecDeque<usize>,
    roi: (usize, usize, usize, usize),
) {
    let Some((roi_min_x, roi_max_x, roi_min_y, roi_max_y)) = normalize_roi(width, height, roi)
    else {
        return;
    };
    let roi_w = roi_max_x - roi_min_x + 1;
    let roi_h = roi_max_y - roi_min_y + 1;
    let roi_len = roi_w * roi_h;
    // Caller is responsible for ensuring in_prior/dist/seeds are sized ≥ roi_len.
    debug_assert!(in_prior.len() >= roi_len);
    debug_assert!(dist.len() >= roi_len);
    debug_assert!(seeds.len() >= roi_len);

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
    // in_prior[local] = 0  → pixel not in any prior layer
    // in_prior[local] = d  → pixel last present d layers ago
    //                       (d=1 = most-recent prior N-1, d=2 = N-2, …)
    //
    // Iterating priors from most-recent to oldest means the FIRST write wins,
    // so in_prior always records the minimum (most-recent) depth.
    for ly in 0..roi_h {
        let local_row = ly * roi_w;
        for lx in 0..roi_w {
            in_prior[local_row + lx] = 0;
        }
    }

    let mut receding_any = false;
    let mut rec_min_x = width;
    let mut rec_max_x = 0usize;
    let mut rec_min_y = height;
    let mut rec_max_y = 0usize;

    for (depth_idx, prior) in priors.iter().rev().enumerate() {
        let depth_val = (depth_idx + 1) as u8; // 1 = most-recent, 2 = older …
        for ly in 0..roi_h {
            let y = roi_min_y + ly;
            let row = y * width;
            let local_row = ly * roi_w;
            for lx in 0..roi_w {
                let x = roi_min_x + lx;
                let img_idx = row + x;
                let loc_idx = local_row + lx;
                if prior[img_idx] > TOPO_THRESHOLD && in_prior[loc_idx] == 0 {
                    in_prior[loc_idx] = depth_val;
                    if current[img_idx] <= TOPO_THRESHOLD {
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

    // Quick early-out: if no receding pixels exist there is nothing to blend.
    if !receding_any {
        return;
    }

    // Seed scan needs one-pixel expansion around receding zone to find current
    // boundary pixels adjacent to receding pixels.  We clamp to the input ROI
    // because the caller is expected to pre-pad ROI by `fade_px + 1`, which
    // already covers the +1 halo.  This keeps everything within the
    // ROI-local scratch buffers.
    let seed_min_x = rec_min_x.saturating_sub(1).max(roi_min_x);
    let seed_min_y = rec_min_y.saturating_sub(1).max(roi_min_y);
    let seed_max_x = (rec_max_x + 1).min(roi_max_x);
    let seed_max_y = (rec_max_y + 1).min(roi_max_y);

    // -- Step 2: Felzenszwalb exact Euclidean EDT. --
    //
    // Seeds are current-layer boundary pixels that border at least one
    // receding (non-current) pixel.  The EDT produces exact Euclidean
    // distances in pixels from those seeds outward into the receding zone.
    //
    // Note: `seeds` is ROI-local; `current` is full-image.  The
    // `has_non_current_4neighbor` neighborhood check uses global coords.
    for y in seed_min_y..=seed_max_y {
        let ly = y - roi_min_y;
        let local_row = ly * roi_w;
        let row = y * width;
        for x in seed_min_x..=seed_max_x {
            let lx = x - roi_min_x;
            seeds[local_row + lx] = current[row + x] > TOPO_THRESHOLD
                && has_non_current_4neighbor(current, x, y, width, height, TOPO_THRESHOLD);
        }
    }

    // EDT operates on the full ROI-local plane; pixels outside the seed scan
    // region were not initialised this layer but `seeds`/`dist` retain stale
    // markers from the previous call.  Reset the active EDT region to a clean
    // state covering the entire ROI for correctness.
    //
    // Cheaper than full-buffer clears because we only touch ROI×ROI.
    // (Note: we keep `seeds` zeroed outside the seed scan to avoid spurious
    // seeds from the previous call's stale `true` markers.)
    if seed_min_x > roi_min_x
        || seed_max_x < roi_max_x
        || seed_min_y > roi_min_y
        || seed_max_y < roi_max_y
    {
        // Zero the ROI portion outside the seed-scan rectangle so the EDT
        // sees a clean ROI-local seed buffer.
        for ly in 0..roi_h {
            let y = roi_min_y + ly;
            let local_row = ly * roi_w;
            if y < seed_min_y || y > seed_max_y {
                for lx in 0..roi_w {
                    seeds[local_row + lx] = false;
                }
            } else {
                for lx in 0..roi_w {
                    let x = roi_min_x + lx;
                    if x < seed_min_x || x > seed_max_x {
                        seeds[local_row + lx] = false;
                    }
                }
            }
        }
    }

    felzenszwalb_edt_roi_local(&seeds[..roi_len], roi_w, roi_h, &mut dist[..roi_len], edt_g);

    // Clear seed markers for next call (keep buffer hot).
    for y in seed_min_y..=seed_max_y {
        let ly = y - roi_min_y;
        let local_row = ly * roi_w;
        for x in seed_min_x..=seed_max_x {
            let lx = x - roi_min_x;
            seeds[local_row + lx] = false;
        }
    }

    // -- Step 3: label connected components in the receding zone. --
    //
    // Each isolated island of receding pixels gets its own gradient steepness
    // determined by its own maximum distance to the boundary.  This makes the
    // gradient automatically slope-adaptive: narrow (steep) islands produce
    // steep gradients; wide (shallow) islands produce gentle ones.
    let roi_w_rec = rec_max_x - rec_min_x + 1;
    let num_labels = label_receding_components_local(
        in_prior,
        current,
        width,
        roi_min_x,
        roi_min_y,
        roi_w,
        rec_min_x,
        rec_max_x,
        rec_min_y,
        rec_max_y,
        TOPO_THRESHOLD,
        labels_buf,
        bfs_queue,
    );

    // Find per-component maximum distance (uncapped — we use the full extent
    // for normalization so the gradient is truly self-calibrating).
    let mut max_dist = vec![0.0f32; num_labels as usize + 1];
    for y in rec_min_y..=rec_max_y {
        let ly = y - roi_min_y;
        let local_row = ly * roi_w;
        let row = y * width;
        for x in rec_min_x..=rec_max_x {
            let lx = x - roi_min_x;
            let loc_idx = local_row + lx;
            let img_idx = row + x;
            if in_prior[loc_idx] > 0 && current[img_idx] <= TOPO_THRESHOLD {
                let d = dist[loc_idx];
                if d.is_finite() {
                    let lbl = labels_buf[(y - rec_min_y) * roi_w_rec + (x - rec_min_x)] as usize;
                    if d > max_dist[lbl] {
                        max_dist[lbl] = d;
                    }
                }
            }
        }
    }

    // -- Step 4: convert distances → per-component-normalized gradient. --
    //
    // For each receding pixel:
    //   t = dist / max_dist_of_component   (0 = inner edge, 1 = outer edge)
    //   raw = round((1 - t) * 255)
    //
    // Pixels beyond fade_px are excluded (hard cutoff).
    // raw is then remapped through the cure-window LUT and max-merged.
    let fade_f = fade_px as f32;
    for y in rec_min_y..=rec_max_y {
        let ly = y - roi_min_y;
        let local_row = ly * roi_w;
        let row = y * width;
        for x in rec_min_x..=rec_max_x {
            let lx = x - roi_min_x;
            let loc_idx = local_row + lx;
            let img_idx = row + x;
            if current[img_idx] <= TOPO_THRESHOLD && in_prior[loc_idx] > 0 {
                let d = dist[loc_idx];
                if !d.is_finite() || d > fade_f {
                    continue;
                }
                let lbl = labels_buf[(y - rec_min_y) * roi_w_rec + (x - rec_min_x)] as usize;
                let max_d = max_dist[lbl].max(1.0);
                let t = (d / max_d).clamp(0.0, 1.0);
                let raw = ((1.0 - t) * 255.0 + 0.5) as u8;
                let v = if let Some(lut) = lut {
                    lut[raw as usize]
                } else {
                    raw
                };
                // Max-merge: never reduce existing values.
                if v > current[img_idx] {
                    current[img_idx] = v;
                }
            }
        }
    }
}

/// Forward EDT Z-blend: bleed pre-appearing pixels (not in `topology` but
/// present in at least one of `futures`) into `mask` using a symmetric
/// per-component-normalized Euclidean gradient.
///
/// Mirrors `z_blend_layer_inplace_with_roi` but operates on growing edges
/// instead of shrinking ones.
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
    dist: &mut [f32],
    seeds: &mut [bool],
    edt_g: &mut Vec<f32>,
    labels_buf: &mut Vec<u32>,
    bfs_queue: &mut VecDeque<usize>,
    roi: (usize, usize, usize, usize),
) {
    if futures.is_empty() || fade_px == 0 || look_back == 0 {
        return;
    }
    let Some((roi_min_x, roi_max_x, roi_min_y, roi_max_y)) = normalize_roi(width, height, roi)
    else {
        return;
    };
    let roi_w = roi_max_x - roi_min_x + 1;
    let roi_h = roi_max_y - roi_min_y + 1;
    let roi_len = roi_w * roi_h;
    debug_assert!(in_forward.len() >= roi_len);
    debug_assert!(dist.len() >= roi_len);
    debug_assert!(seeds.len() >= roi_len);

    const TOPO_THRESHOLD: u8 = 127;

    // Build forward depth map: in_forward[local] = d → pixel first appears
    // d layers ahead (d=1 = next layer = most-recent future, d=2 = further…).
    for ly in 0..roi_h {
        let local_row = ly * roi_w;
        for lx in 0..roi_w {
            in_forward[local_row + lx] = 0;
        }
    }

    let mut appearing_any = false;
    let mut app_min_x = width;
    let mut app_max_x = 0usize;
    let mut app_min_y = height;
    let mut app_max_y = 0usize;

    for (depth_idx, future) in futures.iter().enumerate() {
        let depth_val = (depth_idx + 1) as u8;
        for ly in 0..roi_h {
            let y = roi_min_y + ly;
            let row = y * width;
            let local_row = ly * roi_w;
            for lx in 0..roi_w {
                let x = roi_min_x + lx;
                let img_idx = row + x;
                let loc_idx = local_row + lx;
                if future[img_idx] > TOPO_THRESHOLD && in_forward[loc_idx] == 0 {
                    in_forward[loc_idx] = depth_val;
                    if topology[img_idx] <= TOPO_THRESHOLD {
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

    let seed_min_x = app_min_x.saturating_sub(1).max(roi_min_x);
    let seed_min_y = app_min_y.saturating_sub(1).max(roi_min_y);
    let seed_max_x = (app_max_x + 1).min(roi_max_x);
    let seed_max_y = (app_max_y + 1).min(roi_max_y);

    // -- Step 2: Felzenszwalb exact Euclidean EDT. --
    for y in seed_min_y..=seed_max_y {
        let ly = y - roi_min_y;
        let local_row = ly * roi_w;
        let row = y * width;
        for x in seed_min_x..=seed_max_x {
            let lx = x - roi_min_x;
            seeds[local_row + lx] = topology[row + x] > TOPO_THRESHOLD
                && has_non_current_4neighbor(topology, x, y, width, height, TOPO_THRESHOLD);
        }
    }

    if seed_min_x > roi_min_x
        || seed_max_x < roi_max_x
        || seed_min_y > roi_min_y
        || seed_max_y < roi_max_y
    {
        for ly in 0..roi_h {
            let y = roi_min_y + ly;
            let local_row = ly * roi_w;
            if y < seed_min_y || y > seed_max_y {
                for lx in 0..roi_w {
                    seeds[local_row + lx] = false;
                }
            } else {
                for lx in 0..roi_w {
                    let x = roi_min_x + lx;
                    if x < seed_min_x || x > seed_max_x {
                        seeds[local_row + lx] = false;
                    }
                }
            }
        }
    }

    felzenszwalb_edt_roi_local(&seeds[..roi_len], roi_w, roi_h, &mut dist[..roi_len], edt_g);

    // Clear seed markers.
    for y in seed_min_y..=seed_max_y {
        let ly = y - roi_min_y;
        let local_row = ly * roi_w;
        for x in seed_min_x..=seed_max_x {
            let lx = x - roi_min_x;
            seeds[local_row + lx] = false;
        }
    }

    // -- Step 3: label connected components in the pre-appearing zone. --
    let roi_w_app = app_max_x - app_min_x + 1;
    let num_labels = label_receding_components_local(
        in_forward,
        topology,
        width,
        roi_min_x,
        roi_min_y,
        roi_w,
        app_min_x,
        app_max_x,
        app_min_y,
        app_max_y,
        TOPO_THRESHOLD,
        labels_buf,
        bfs_queue,
    );

    let mut max_dist = vec![0.0f32; num_labels as usize + 1];
    for y in app_min_y..=app_max_y {
        let ly = y - roi_min_y;
        let local_row = ly * roi_w;
        let row = y * width;
        for x in app_min_x..=app_max_x {
            let lx = x - roi_min_x;
            let loc_idx = local_row + lx;
            let img_idx = row + x;
            if in_forward[loc_idx] > 0 && topology[img_idx] <= TOPO_THRESHOLD {
                let d = dist[loc_idx];
                if d.is_finite() {
                    let lbl = labels_buf[(y - app_min_y) * roi_w_app + (x - app_min_x)] as usize;
                    if d > max_dist[lbl] {
                        max_dist[lbl] = d;
                    }
                }
            }
        }
    }

    // -- Step 4: convert distances → gradient, max-merge into mask. --
    let fade_f = fade_px as f32;
    for y in app_min_y..=app_max_y {
        let ly = y - roi_min_y;
        let local_row = ly * roi_w;
        let row = y * width;
        for x in app_min_x..=app_max_x {
            let lx = x - roi_min_x;
            let loc_idx = local_row + lx;
            let img_idx = row + x;
            if topology[img_idx] <= TOPO_THRESHOLD && in_forward[loc_idx] > 0 {
                let d = dist[loc_idx];
                if !d.is_finite() || d > fade_f {
                    continue;
                }
                let lbl = labels_buf[(y - app_min_y) * roi_w_app + (x - app_min_x)] as usize;
                let max_d = max_dist[lbl].max(1.0);
                let t = (d / max_d).clamp(0.0, 1.0);
                let raw = ((1.0 - t) * 255.0 + 0.5) as u8;
                let v = if let Some(lut) = lut {
                    lut[raw as usize]
                } else {
                    raw
                };
                if v > mask[img_idx] {
                    mask[img_idx] = v;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Felzenszwalb exact Euclidean distance transform (ROI-local)
// ---------------------------------------------------------------------------

/// Compute an exact Euclidean distance transform (EDT) over a ROI-local plane.
///
/// `seeds` and `dist` are both indexed as `roi_y * roi_w + roi_x` with shape
/// `(roi_w, roi_h)` — no global image stride.  This makes per-worker scratch
/// `O(roi_w · roi_h)` instead of `O(W · H)`.
///
/// Seeds (`seeds[idx] == true`) receive distance 0; all others receive the
/// Euclidean distance to the nearest seed, or `f32::INFINITY` if unreachable.
fn felzenszwalb_edt_roi_local(
    seeds: &[bool],
    roi_w: usize,
    roi_h: usize,
    dist: &mut [f32],
    scratch_g: &mut Vec<f32>,
) {
    if roi_w == 0 || roi_h == 0 {
        return;
    }
    let g_len = roi_w * roi_h;
    debug_assert!(seeds.len() >= g_len);
    debug_assert!(dist.len() >= g_len);
    if scratch_g.len() < g_len {
        scratch_g.resize(g_len, 0.0);
    }

    // Phase 1: per-row horizontal squared-distance scan.  Each row is disjoint
    // in both `seeds` (read-only) and `scratch_g` (write), so `par_chunks_mut`
    // is safe.
    let par_thresh = std::env::var("DF_3DAA_EDT_PAR_THRESH")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(500_000); // ~700×700 pixels
    let use_par = g_len >= par_thresh;

    if use_par {
        scratch_g[..g_len]
            .par_chunks_mut(roi_w)
            .enumerate()
            .for_each(|(roi_y, row)| {
                let seed_row = roi_y * roi_w;
                let mut left_d = f32::INFINITY;
                for roi_x in 0..roi_w {
                    if seeds[seed_row + roi_x] {
                        left_d = 0.0;
                    } else if left_d < f32::INFINITY {
                        left_d += 1.0;
                    }
                    row[roi_x] = left_d * left_d;
                }
                let mut right_d = f32::INFINITY;
                for roi_x in (0..roi_w).rev() {
                    if seeds[seed_row + roi_x] {
                        right_d = 0.0;
                    } else if right_d < f32::INFINITY {
                        right_d += 1.0;
                    }
                    let d2 = right_d * right_d;
                    if d2 < row[roi_x] {
                        row[roi_x] = d2;
                    }
                }
            });
    } else {
        let g = &mut scratch_g[..g_len];
        for roi_y in 0..roi_h {
            let seed_row = roi_y * roi_w;
            let g_row = roi_y * roi_w;
            let mut left_d = f32::INFINITY;
            for roi_x in 0..roi_w {
                if seeds[seed_row + roi_x] {
                    left_d = 0.0;
                } else if left_d < f32::INFINITY {
                    left_d += 1.0;
                }
                g[g_row + roi_x] = left_d * left_d;
            }
            let mut right_d = f32::INFINITY;
            for roi_x in (0..roi_w).rev() {
                if seeds[seed_row + roi_x] {
                    right_d = 0.0;
                } else if right_d < f32::INFINITY {
                    right_d += 1.0;
                }
                let d2 = right_d * right_d;
                if d2 < g[g_row + roi_x] {
                    g[g_row + roi_x] = d2;
                }
            }
        }
    }

    // Phase 2: per-column parabola lower-envelope.  Columns are independent,
    // so this is parallelised with `for_each_init` (per-worker v/z scratch).
    //
    // Disjoint-write safety: each column `roi_x` writes only to local indices
    // `roi_y * roi_w + roi_x` for roi_y in 0..roi_h — different columns differ
    // in `roi_x`, so their target indices never alias.
    let g_read = &scratch_g[..g_len];

    let phase2_par_thresh = std::env::var("DF_3DAA_EDT_PHASE2_PAR_THRESH")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(500_000);
    let phase2_use_par = g_len >= phase2_par_thresh && roi_w >= 32;

    if phase2_use_par {
        // SAFETY: see disjoint-write argument above.  Carrying the pointer
        // through the closure as a `usize` (Send + Sync) is well-defined.
        let dist_addr = dist.as_mut_ptr() as usize;
        (0..roi_w).into_par_iter().for_each_init(
            || (vec![0usize; roi_h], vec![0.0f32; roi_h + 1]),
            |(v, z), roi_x| {
                let dist_ptr = dist_addr as *mut f32;
                phase2_column_local(g_read, dist_ptr, roi_w, roi_h, roi_x, v, z);
            },
        );
    } else {
        let mut v = vec![0usize; roi_h];
        let mut z = vec![0.0f32; roi_h + 1];
        let dist_ptr = dist.as_mut_ptr();
        for roi_x in 0..roi_w {
            phase2_column_local(g_read, dist_ptr, roi_w, roi_h, roi_x, &mut v, &mut z);
        }
    }
}

/// Per-column Phase-2 parabola lower-envelope computation (ROI-local).
///
/// Writes are confined to local indices `roi_y * roi_w + roi_x` for
/// `roi_y in 0..roi_h`.  Caller must ensure concurrent calls use disjoint
/// `roi_x` values.
#[inline]
fn phase2_column_local(
    g_read: &[f32],
    dist_ptr: *mut f32,
    roi_w: usize,
    roi_h: usize,
    roi_x: usize,
    v: &mut [usize],
    z: &mut [f32],
) {
    let first = match (0..roi_h).find(|&ry| g_read[ry * roi_w + roi_x] < f32::INFINITY) {
        None => {
            for roi_y in 0..roi_h {
                let idx = roi_y * roi_w + roi_x;
                // SAFETY: disjoint per-column write (see caller invariant).
                unsafe {
                    *dist_ptr.add(idx) = f32::INFINITY;
                }
            }
            return;
        }
        Some(f) => f,
    };

    v[0] = first;
    z[0] = f32::NEG_INFINITY;
    z[1] = f32::INFINITY;
    let mut k = 0usize;

    for roi_y in (first + 1)..roi_h {
        let fq = g_read[roi_y * roi_w + roi_x];
        if fq == f32::INFINITY {
            continue;
        }
        let q = roi_y as f32;
        loop {
            let vk = v[k] as f32;
            let fvk = g_read[v[k] * roi_w + roi_x];
            let s = ((fq + q * q) - (fvk + vk * vk)) / (2.0 * (q - vk));
            if s > z[k] {
                k += 1;
                v[k] = roi_y;
                z[k] = s;
                z[k + 1] = f32::INFINITY;
                break;
            }
            if k == 0 {
                v[0] = roi_y;
                z[0] = f32::NEG_INFINITY;
                z[1] = f32::INFINITY;
                break;
            }
            k -= 1;
        }
    }

    let mut ki = 0;
    for roi_y in 0..roi_h {
        while z[ki + 1] < roi_y as f32 {
            ki += 1;
        }
        let vk = v[ki] as f32;
        let diff = roi_y as f32 - vk;
        let d2 = diff * diff + g_read[v[ki] * roi_w + roi_x];
        let idx = roi_y * roi_w + roi_x;
        // SAFETY: disjoint per-column write (see caller invariant).
        unsafe {
            *dist_ptr.add(idx) = d2.sqrt();
        }
    }
}

// ---------------------------------------------------------------------------
// Connected-component labeling for the receding / pre-appearing zone
// ---------------------------------------------------------------------------

/// 8-connected BFS connected-component labeling for a zone of pixels where
/// `in_occupancy[local] > 0` AND `current[global] <= topo_threshold`.
///
/// `in_occupancy` is **ROI-local** (workspace ROI shape `(ws_roi_w, _)` with
/// origin `(ws_roi_min_x, ws_roi_min_y)`).  `current` is the **full-image**
/// layer mask indexed by `y * width + x`.
///
/// Returns `num_labels`. `labels_buf` is indexed by *receding* ROI position
/// `(y - rec_min_y) * roi_w_rec + (x - rec_min_x)` with `roi_w_rec = rec_max_x - rec_min_x + 1`.
/// Label 0 = not part of the zone; labels 1..=num_labels are the components.
#[allow(clippy::too_many_arguments)]
fn label_receding_components_local(
    in_occupancy: &[u8],
    current: &[u8],
    width: usize,
    ws_roi_min_x: usize,
    ws_roi_min_y: usize,
    ws_roi_w: usize,
    rec_min_x: usize,
    rec_max_x: usize,
    rec_min_y: usize,
    rec_max_y: usize,
    topo_threshold: u8,
    labels_buf: &mut Vec<u32>,
    bfs_queue: &mut VecDeque<usize>,
) -> u32 {
    let roi_w = rec_max_x - rec_min_x + 1;
    let roi_h = rec_max_y - rec_min_y + 1;
    let roi_len = roi_w * roi_h;
    if labels_buf.len() < roi_len {
        labels_buf.resize(roi_len, 0);
    }
    labels_buf[..roi_len].fill(0);
    bfs_queue.clear();

    let mut next_label = 1u32;

    for start_ry in 0..roi_h {
        let start_y = rec_min_y + start_ry;
        let occ_row_local = (start_y - ws_roi_min_y) * ws_roi_w;
        let cur_row = start_y * width;
        for start_rx in 0..roi_w {
            let start_x = rec_min_x + start_rx;
            let roi_idx = start_ry * roi_w + start_rx;
            let occ_idx = occ_row_local + (start_x - ws_roi_min_x);
            let img_idx = cur_row + start_x;

            if in_occupancy[occ_idx] == 0
                || current[img_idx] > topo_threshold
                || labels_buf[roi_idx] != 0
            {
                continue;
            }

            let label = next_label;
            next_label += 1;
            labels_buf[roi_idx] = label;
            bfs_queue.push_back(roi_idx);

            while let Some(ri) = bfs_queue.pop_front() {
                let ry = ri / roi_w;
                let rx = ri % roi_w;
                let y = rec_min_y + ry;
                let x = rec_min_x + rx;

                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let ny = y as i32 + dy;
                        let nx = x as i32 + dx;
                        if nx < rec_min_x as i32
                            || nx > rec_max_x as i32
                            || ny < rec_min_y as i32
                            || ny > rec_max_y as i32
                        {
                            continue;
                        }
                        let nrx = nx as usize - rec_min_x;
                        let nry = ny as usize - rec_min_y;
                        let nri = nry * roi_w + nrx;
                        let n_occ =
                            (ny as usize - ws_roi_min_y) * ws_roi_w + (nx as usize - ws_roi_min_x);
                        let n_img = ny as usize * width + nx as usize;
                        if in_occupancy[n_occ] > 0
                            && current[n_img] <= topo_threshold
                            && labels_buf[nri] == 0
                        {
                            labels_buf[nri] = label;
                            bfs_queue.push_back(nri);
                        }
                    }
                }
            }
        }
    }

    next_label - 1
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
/// Build a "cure-window" look-up table that maps the per-component normalised
/// gradient value (0 = outermost pixel, 255 = innermost boundary pixel) to an
/// exposure value in the range `[min_alpha_u8, max_alpha_u8]`.
///
/// - `lut[0]  = 0`   — void (not a receding pixel at all).
/// - `lut[255] = 255` — fully solid boundary pixel.
/// - `lut[1..=254]`  — linear from `min_alpha_u8` (near outer edge) to
///   `max_alpha_u8` (near inner edge).
pub fn make_cure_window_lut(min_alpha_u8: u8, max_alpha_u8: u8) -> [u8; 256] {
    let mut lut = [0u8; 256];
    lut[255] = 255;
    let lo = min_alpha_u8 as f32;
    let hi = max_alpha_u8.max(min_alpha_u8) as f32;
    for i in 1u8..=254 {
        let t = (i as f32 - 1.0) / 253.0;
        lut[i as usize] = (lo + t * (hi - lo) + 0.5).min(255.0) as u8;
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
    /// With per-component Euclidean normalization (Felzenszwalb EDT):
    ///   Component has 2 pixels: dist[0]=2.0, dist[1]=1.0, max_dist=2.0
    ///   pixel 1: t = 1.0/2.0 = 0.5  → raw = round((1-0.5)*255) = 128
    ///   pixel 0: t = 2.0/2.0 = 1.0  → raw = round((1-1.0)*255) = 0
    ///   (outermost pixel of any component always gets 0 = no blending)
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
        // Outermost receding pixel (farthest from solid) → t=1.0 → raw=0
        assert_eq!(
            layer[0], 0,
            "outermost receding pixel gets 0 (t=1.0 at component max_dist), got {}",
            layer[0]
        );
        // Inner receding pixel has positive gradient
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

    /// Cure-window LUT is monotonically non-decreasing and has correct endpoints.
    #[test]
    fn cure_window_lut_monotone() {
        let lut = make_cure_window_lut(90, 230);
        assert_eq!(lut[0], 0);
        assert_eq!(lut[1], 90);
        assert_eq!(lut[254], 230);
        assert_eq!(lut[255], 255);
        for i in 1..256 {
            assert!(
                lut[i] >= lut[i - 1],
                "LUT not monotone at index {}: {} < {}",
                i,
                lut[i],
                lut[i - 1]
            );
        }
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
