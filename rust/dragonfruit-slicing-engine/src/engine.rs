//! V3 engine orchestration and validation layer.

use crate::encode::{encode_grayscale_png, encode_rgb_png_8bit};
use crate::encoders::registry::{
    find_encoder, find_encoder_by_hint_or_source, supported_output_formats,
};
use crate::geometry::{parse_triangles, project_triangles_inplace};
use crate::index::build_layer_index;
use crate::metrics::SlicingPerfV3;
use crate::pipeline::{render_layers_bounded, render_layers_rle, render_layers_rle_encoded};
use crate::raster::{
    apply_blur_postprocess_inplace, apply_blur_postprocess_inplace_with_roi,
    blur_gray_rle_streaming, downsample_binary_rle_to_gray_rle, encode_mask_to_rle_in_bounds,
    rasterize_layer_with_stats,
};
use crate::types::{
    LayerAreaStatsV3, ProgressCallbackV3, RenderedLayersV3, SliceArtifactV3, SliceJobV3,
    SliceProgressPhaseV3, SliceProgressUpdateV3,
};
use crate::{cross_blend, z_blend};
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use thiserror::Error;

#[cfg(target_arch = "x86")]
use std::arch::x86::{__m128i, _mm_loadu_si128, _mm_max_epu8, _mm_storeu_si128};
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::{__m128i, _mm_loadu_si128, _mm_max_epu8, _mm_storeu_si128};

#[derive(Debug, Error)]
pub enum SlicerV3Error {
    #[error("cancelled")]
    Cancelled,
    #[error("unsupported output format: {0}")]
    UnsupportedOutput(String),
    #[error("invalid dimensions {width}x{height}")]
    InvalidDimensions { width: u32, height: u32 },
    #[error(
        "invalid layer settings: layer_height_mm={layer_height_mm}, total_layers={total_layers}"
    )]
    InvalidLayerSettings {
        layer_height_mm: f32,
        total_layers: u32,
    },
    #[error("invalid build volume dimensions: build_width_mm={build_width_mm}, build_depth_mm={build_depth_mm}")]
    InvalidBuildVolume {
        build_width_mm: f32,
        build_depth_mm: f32,
    },
    #[error("invalid triangle buffer length: expected multiple of 9, got {0}")]
    InvalidTriangleBuffer(usize),
    #[error("png encode failed: {0}")]
    Png(String),
    #[error("zip encode failed: {0}")]
    Zip(String),
    #[error("json encode failed: {0}")]
    Json(String),
    #[error("missing rendered layer payload: {0}")]
    MissingRenderedLayerPayload(String),
    #[error("layer preview read failed: {0}")]
    LayerPreview(String),
}

fn validate_job(job: &SliceJobV3) -> Result<(), SlicerV3Error> {
    if job.width_px == 0
        || job.height_px == 0
        || job.source_width_px == 0
        || job.source_height_px == 0
    {
        return Err(SlicerV3Error::InvalidDimensions {
            width: job.width_px,
            height: job.height_px,
        });
    }
    if !(job.layer_height_mm.is_finite() && job.layer_height_mm > 0.0) || job.total_layers == 0 {
        return Err(SlicerV3Error::InvalidLayerSettings {
            layer_height_mm: job.layer_height_mm,
            total_layers: job.total_layers,
        });
    }
    if !(job.build_width_mm.is_finite() && job.build_width_mm > 0.0)
        || !(job.build_depth_mm.is_finite() && job.build_depth_mm > 0.0)
    {
        return Err(SlicerV3Error::InvalidBuildVolume {
            build_width_mm: job.build_width_mm,
            build_depth_mm: job.build_depth_mm,
        });
    }
    if job.triangles_xyz.len() % 9 != 0 {
        return Err(SlicerV3Error::InvalidTriangleBuffer(
            job.triangles_xyz.len(),
        ));
    }
    Ok(())
}

#[inline]
fn is_vertical_aa_mode(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("3daa")
        || mode.trim().eq_ignore_ascii_case("vertical")
        || mode.trim().eq_ignore_ascii_case("vertical2")
        || mode.trim().eq_ignore_ascii_case("vertical3")
        || mode.trim().eq_ignore_ascii_case("crossblend")
        || mode.trim().eq_ignore_ascii_case("volumetric")
}

#[inline]
fn is_cross_blend_mode(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("vertical3")
        || mode.trim().eq_ignore_ascii_case("crossblend")
        || mode.trim().eq_ignore_ascii_case("volumetric")
}

#[inline]
fn apply_min_alpha_floor(mask: &mut [u8], min_aa_alpha_u8: u8) {
    if min_aa_alpha_u8 == 0 {
        return;
    }
    for px in mask.iter_mut() {
        if *px < min_aa_alpha_u8 {
            *px = 0;
        }
    }
}

struct SupportMaskContext {
    support_job: SliceJobV3,
    triangles: Vec<crate::geometry::Triangle>,
    layer_index: crate::index::LayerIndex,
    model_triangle_count: usize,
    support_candidates: Vec<usize>,
}

struct SupportMaskLayer {
    mask: Vec<u8>,
    bounds: (usize, usize, usize, usize),
}

impl SupportMaskContext {
    fn from_job(job: &SliceJobV3) -> Option<Self> {
        if job.aa_on_supports {
            return None;
        }

        let total_triangles = job.triangles_xyz.len() / 9;
        let model_triangle_count = (job.model_triangle_count as usize).min(total_triangles);
        if model_triangle_count == 0 || model_triangle_count >= total_triangles {
            return None;
        }

        let mut support_job = job.clone();
        support_job.anti_aliasing_level = "Off".to_string();
        support_job.anti_aliasing_mode = "Coverage".to_string();
        support_job.blur_brush_radius_px = 0;
        support_job.minimum_aa_alpha_percent = 0.0;
        support_job.aa_on_supports = true;
        support_job.model_triangle_count = 0;

        let mut triangles = parse_triangles(&support_job.triangles_xyz);
        project_triangles_inplace(&mut triangles, &support_job);
        let layer_index = build_layer_index(
            &triangles,
            support_job.total_layers,
            support_job.layer_height_mm,
        );

        Some(Self {
            support_job,
            triangles,
            layer_index,
            model_triangle_count,
            support_candidates: Vec::new(),
        })
    }

    fn rasterize_support_mask(&mut self, layer: u32) -> Option<SupportMaskLayer> {
        self.support_candidates.clear();
        for &candidate in self.layer_index.candidates_for_layer(layer) {
            if candidate >= self.model_triangle_count {
                self.support_candidates.push(candidate);
            }
        }

        if self.support_candidates.is_empty() {
            return None;
        }

        let (mask, stats) = rasterize_layer_with_stats(
            &self.support_job,
            &self.triangles,
            &self.support_candidates,
            layer,
            false,
        );

        if stats.total_solid_pixels == 0 {
            return None;
        }

        let min_x = stats.min_x.max(0) as usize;
        let max_x = stats.max_x.max(stats.min_x).max(0) as usize;
        let min_y = stats.min_y.max(0) as usize;
        let max_y = stats.max_y.max(stats.min_y).max(0) as usize;

        Some(SupportMaskLayer {
            mask,
            bounds: (min_x, max_x, min_y, max_y),
        })
    }
}

#[inline]
fn merge_support_mask_inplace(dst: &mut [u8], support: &SupportMaskLayer, width: usize) {
    let (min_x, max_x, min_y, max_y) = support.bounds;
    if width == 0 || min_x > max_x || min_y > max_y {
        return;
    }
    let row_len = max_x - min_x + 1;
    for y in min_y..=max_y {
        let row_start = y * width + min_x;
        let row_end = row_start + row_len;
        u8_max_inplace(
            &mut dst[row_start..row_end],
            &support.mask[row_start..row_end],
        );
    }
}

#[inline]
fn u8_max_inplace(dst: &mut [u8], src: &[u8]) {
    let len = dst.len().min(src.len());
    if len == 0 {
        return;
    }

    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if std::is_x86_feature_detected!("sse2") {
            // SAFETY: SSE2 is runtime-detected above. Pointers are valid for
            // `len` bytes, and we use unaligned load/store intrinsics.
            unsafe {
                u8_max_inplace_sse2(&mut dst[..len], &src[..len]);
            }
            return;
        }
    }

    for (d, s) in dst.iter_mut().zip(src.iter()).take(len) {
        if *s > *d {
            *d = *s;
        }
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "sse2")]
unsafe fn u8_max_inplace_sse2(dst: &mut [u8], src: &[u8]) {
    let len = dst.len().min(src.len());
    let mut i = 0usize;

    while i + 16 <= len {
        // SAFETY: i..i+16 is in-bounds due to loop condition.
        let a = unsafe { _mm_loadu_si128(dst.as_ptr().add(i) as *const __m128i) };
        // SAFETY: i..i+16 is in-bounds due to loop condition.
        let b = unsafe { _mm_loadu_si128(src.as_ptr().add(i) as *const __m128i) };
        let m = _mm_max_epu8(a, b);
        // SAFETY: i..i+16 is in-bounds due to loop condition.
        unsafe { _mm_storeu_si128(dst.as_mut_ptr().add(i) as *mut __m128i, m) };
        i += 16;
    }

    for j in i..len {
        let s = src[j];
        if s > dst[j] {
            dst[j] = s;
        }
    }
}

#[inline]
fn merge_bounds(
    a: Option<(usize, usize, usize, usize)>,
    b: Option<(usize, usize, usize, usize)>,
) -> Option<(usize, usize, usize, usize)> {
    match (a, b) {
        (None, None) => None,
        (Some(v), None) | (None, Some(v)) => Some(v),
        (Some((aminx, amaxx, aminy, amaxy)), Some((bminx, bmaxx, bminy, bmaxy))) => Some((
            aminx.min(bminx),
            amaxx.max(bmaxx),
            aminy.min(bminy),
            amaxy.max(bmaxy),
        )),
    }
}

#[inline]
fn expand_bounds(
    bounds: Option<(usize, usize, usize, usize)>,
    pad: usize,
    width: usize,
    height: usize,
) -> Option<(usize, usize, usize, usize)> {
    let (min_x, max_x, min_y, max_y) = bounds?;
    if width == 0 || height == 0 {
        return None;
    }
    Some((
        min_x.saturating_sub(pad),
        (max_x + pad).min(width - 1),
        min_y.saturating_sub(pad),
        (max_y + pad).min(height - 1),
    ))
}

/// Returns an inclusive `(first_layer, last_layer)` window where model geometry
/// can exist, based on model-triangle Z extents.
///
/// When model/support split metadata is unavailable, returns `None` and callers
/// should keep 3DAA enabled for all layers.
fn resolve_model_active_layer_window(job: &SliceJobV3) -> Option<(u32, u32)> {
    let total_triangles = job.triangles_xyz.len() / 9;
    let model_triangles = (job.model_triangle_count as usize).min(total_triangles);

    // No split metadata (or model-only mesh): fall back to full-range processing.
    if model_triangles == 0 || model_triangles >= total_triangles {
        return None;
    }

    let mut min_z = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;

    for tri in 0..model_triangles {
        let base = tri * 9;
        let z0 = job.triangles_xyz[base + 2];
        let z1 = job.triangles_xyz[base + 5];
        let z2 = job.triangles_xyz[base + 8];
        for z in [z0, z1, z2] {
            if z.is_finite() {
                min_z = min_z.min(z);
                max_z = max_z.max(z);
            }
        }
    }

    if !min_z.is_finite() || !max_z.is_finite() || max_z < 0.0 {
        return None;
    }

    let layer_h = job.layer_height_mm.max(f32::EPSILON);
    let max_layer = job.total_layers.saturating_sub(1) as i64;
    let first = ((min_z / layer_h).floor() as i64).clamp(0, max_layer) as u32;
    let last = ((max_z / layer_h).ceil() as i64).clamp(0, max_layer) as u32;

    if first > last {
        None
    } else {
        Some((first, last))
    }
}

#[inline]
fn env_override_usize(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1)
}

#[inline]
fn choose_3daa_post_threads(width: usize, height: usize, total_layers: u32) -> usize {
    let hw = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);

    if let Some(override_threads) = env_override_usize("DF_3DAA_POST_THREADS") {
        return override_threads.clamp(1, hw);
    }

    let layer_pixels = (width as u64).saturating_mul(height as u64);
    let total_pixels = layer_pixels.saturating_mul(total_layers as u64);

    let auto = if hw <= 4 || total_pixels < 300_000_000 {
        1
    } else if layer_pixels >= 8_000_000 || total_pixels >= 3_000_000_000 {
        // Very large layers are memory-bandwidth heavy and benefit most from
        // saturating host parallelism for topology/sweep work and backward EDT.
        // Worker count for ZBlendWorkspace-heavy post-processing is independently
        // bounded by the memory-aware formula in choose_3daa_post_buffer_depth.
        hw
    } else if total_pixels < 1_000_000_000 {
        (hw / 3).max(1)
    } else if total_pixels < 3_000_000_000 {
        (hw / 2).max(1)
    } else {
        (hw * 3 / 4).max(1)
    };

    auto.clamp(1, hw)
}

#[inline]
fn choose_3daa_post_buffer_depth(
    width: usize,
    height: usize,
    total_layers: u32,
    post_threads: usize,
) -> usize {
    if let Some(override_depth) = env_override_usize("DF_3DAA_POST_BUFFER_DEPTH") {
        return override_depth.min(8);
    }

    let hw = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let layer_pixels = (width as u64).saturating_mul(height as u64);
    let total_pixels = layer_pixels.saturating_mul(total_layers as u64);

    // Require at least 6 hardware threads and enough layers for the pipeline
    // to matter.  The single-threaded fallback is used otherwise.
    if total_layers < 96 || post_threads <= 1 || hw < 6 {
        return 0;
    }

    // For very large per-layer sizes (>=6M px, e.g. 12K printers) backward EDT
    // is now executed inside post-workers (not the main thread), so both EDTs
    // run off the main thread.  EDT Phase 2 is also tile-parallel within a
    // single layer (see z_blend.rs::phase2_column).
    //
    // Since Phase 1.2 made `ZBlendWorkspace` ROI-local + lazy, each worker now
    // resides in ~30–80 MB in typical 12K jobs (down from ~880 MB worst-case),
    // but 12K profiles showed that raising 16-core hosts from 4 → 6 workers
    // regressed wall time and increased bandwidth pressure (higher backward/fwd
    // CPU per layer, higher blur CPU, and much larger pending/raster memory).
    // Keep the huge-layer default conservative here; the env override remains
    // available for targeted experiments.
    //
    // Default for layer_pixels ≥ 6 M:
    //   hw ≥ 16 → 4 workers
    //   hw ≥ 12 → 4 workers
    //   hw ≥ 6  → 2 workers
    //   else    → 1 worker
    // Override with `DF_3DAA_POST_BUFFER_DEPTH`.
    if layer_pixels >= 6_000_000 {
        if hw >= 6 && total_layers >= 96 {
            if hw >= 16 {
                return 4;
            }
            if hw >= 12 {
                return 4;
            }
            return 2;
        }
        return 0;
    }

    if total_pixels >= 3_000_000_000 {
        4
    } else {
        2
    }
}

type TopologyBounds = Option<(usize, usize, usize, usize)>;

struct PendingLayer {
    layer_index: u32,
    mask: Vec<u8>,
    mask_bounds: TopologyBounds,
    topology: Arc<Vec<u8>>,
    topology_bounds: TopologyBounds,
    topology_non_empty: bool,
    model_non_empty: bool,
    backward_applied: bool,
    backward_seed_bounds: TopologyBounds,
    /// Prior topologies for backward EDT, captured at push time (oldest-to-newest).
    /// Moved into `PostWorkerTask` so post-workers can run backward EDT off the
    /// main thread in parallel with rasterization of subsequent layers.
    backward_prior_topologies: Vec<Arc<Vec<u8>>>,
    support_mask: Option<SupportMaskLayer>,
    apply_model_aa: bool,
    backward_contrib: Option<Vec<u8>>,
}

struct PostWorkerTask {
    seq: u64,
    layer: PendingLayer,
    /// Oldest-to-newest topology window for this layer's *backward* EDT.
    /// Collected from `pending_layers` at push time so the main thread is free
    /// to move on while post-workers process the EDT in parallel.
    backward_prior_topologies: Vec<Arc<Vec<u8>>>,
    /// Most-recently-emitted topologies (newest-first), used only for cross-blend.
    prior_topologies: Vec<Arc<Vec<u8>>>,
    future_topologies: Vec<Arc<Vec<u8>>>,
    future_bounds: Vec<TopologyBounds>,
    futures_have_topology: bool,
    cross_blend_cfg: Option<cross_blend::CrossBlendKernelConfig>,
}

struct PostProcessedLayer {
    seq: u64,
    layer: PendingLayer,
    active_bounds: TopologyBounds,
    forward_contrib: Option<Vec<u8>>,
    z_blend_backward_ns: u64,
    z_blend_forward_ns: u64,
    cross_blend_ns: u64,
    cross_blend_touched_pixels: u64,
    cross_blend_contributing_layers: u64,
    post_blur_ns: u64,
    support_merge_ns: u64,
}

/// Perf counters returned by the 3DAA pump thread.
///
/// All timings are nanosecond-precision totals accumulated across the whole job.
/// The main thread reads these after joining the pump thread and copies them
/// into [`SlicerPerfV3`] for the caller and the `[3DAA] done` diagnostic.
struct PumpStats {
    z_blend_backward_ns: u64,
    z_blend_forward_ns: u64,
    cross_blend_ns: u64,
    cross_blend_touched_pixels: u64,
    cross_blend_contributing_layers: u64,
    post_blur_ns: u64,
    support_merge_ns: u64,
    /// Total time spent inside the topology-sweep step across all layers.
    callback_sweep_ns: u64,
    /// Total time spent draining done-results and forwarding to the encode
    /// thread across all layers.
    callback_drain_ns: u64,
    /// Total pump-thread work time per layer (used for the `[3DAA] pump/layer`
    /// diagnostic and to estimate raster vs. pump overlap).
    callback_total_ns: u64,
}

/// A fully z-blended, blurred layer ready for encoding.  Carries only the
/// fields the encode thread needs; heavyweight 3DAA data has already been
/// consumed by the consumer thread (topology tracking, perf counters).
struct EncodeTask {
    layer_index: u32,
    mask: Vec<u8>,
    active_bounds: TopologyBounds,
    /// Backward z-blend contribution — only used for the debug colour overlay.
    backward_contrib: Option<Vec<u8>>,
    /// Forward z-blend contribution — only used for the debug colour overlay.
    forward_contrib: Option<Vec<u8>>,
}

/// Wraps a raw pointer to an `FnMut` callback so it can be sent to the encode
/// thread.
///
/// # Safety
/// The encode thread is always joined before `rasterize_vertical_aa_streaming_v3`
/// returns (enforced by [`EncodeThreadHandle`]'s `Drop` impl), and no other
/// code calls the function while the thread is running.
///
/// The `'static` bound on the `dyn` is a type-system fiction: the actual
/// referent has a shorter lifetime that is manually enforced by the invariant
/// above.  `std::mem::transmute` is used at construction to erase the
/// compile-time lifetime (both `&mut dyn FnMut(...)` and
/// `*mut (dyn FnMut(...) + 'static)` are identical 2-word fat pointers).
struct SendMaskCallback(
    Option<*mut (dyn FnMut(u32, Vec<u8>, TopologyBounds) -> Result<(), SlicerV3Error> + 'static)>,
);
// SAFETY: see above — exclusive access + bounded lifetime guaranteed by caller.
unsafe impl Send for SendMaskCallback {}

/// RAII wrapper that ensures the encode thread is always joined before the
/// enclosing function returns, even on early-exit `?` paths.
///
/// Declare this BEFORE the `encode_tx` local so that Rust's reverse-drop
/// ordering causes `encode_tx` to close first (unblocking the thread) and
/// this handle's `Drop` to join second.
struct EncodeThreadHandle {
    handle: Option<
        std::thread::JoinHandle<
            Result<(Option<Vec<Vec<u8>>>, Option<Vec<Vec<u8>>>), SlicerV3Error>,
        >,
    >,
}

impl EncodeThreadHandle {
    /// Consume the handle on the success path: joins the thread and returns the
    /// accumulated `(png_layers, raw_mask_layers)`.  Must only be called after
    /// `encode_tx` has been dropped (otherwise the thread will never exit).
    fn finish(mut self) -> Result<(Option<Vec<Vec<u8>>>, Option<Vec<Vec<u8>>>), SlicerV3Error> {
        self.handle
            .take()
            .expect("EncodeThreadHandle::finish called twice")
            .join()
            .map_err(|_| SlicerV3Error::LayerPreview("3DAA encode thread panicked".to_string()))?
    }
}

impl Drop for EncodeThreadHandle {
    fn drop(&mut self) {
        // On error paths `finish()` was not called; join the thread here so
        // the raw `on_processed_mask` pointer stays valid until the thread
        // terminates.  Errors from the thread are discarded on this path.
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn process_pending_layer_post(
    mut layer: PendingLayer,
    prior_topologies: &[&[u8]],
    backward_prior_topologies: &[&[u8]],
    future_topologies: &[&[u8]],
    future_bounds: &[TopologyBounds],
    futures_have_topology: bool,
    width: usize,
    height: usize,
    fade_px: u32,
    blur_radius: usize,
    min_aa_alpha_u8: u8,
    z_blend_min_alpha_u8: u8,
    has_custom_lut: bool,
    debug_color_overlay: bool,
    lut: &[u8; 256],
    workspace: &mut z_blend::ZBlendWorkspace,
    cross_blend_cfg: Option<&cross_blend::CrossBlendKernelConfig>,
    cross_blend_ws: &mut cross_blend::CrossBlendWorkspace,
) -> PostProcessedLayer {
    let pixels_per_layer = width.saturating_mul(height);
    let mut active_bounds = layer.mask_bounds;

    // --- Backward z-blend (moved off the main thread to enable multi-worker parallelism). ---
    // `backward_prior_topologies` is ordered oldest-to-newest, matching the
    // convention used when these priors were collected from `pending_layers`.
    let mut z_blend_backward_ns_local = 0u64;
    if layer.backward_applied {
        let blend_start = std::time::Instant::now();
        let before_backward = if debug_color_overlay {
            Some(layer.mask.clone())
        } else {
            None
        };
        let blend_pad = fade_px as usize + 1;
        active_bounds = merge_bounds(
            active_bounds,
            expand_bounds(layer.backward_seed_bounds, blend_pad, width, height),
        );
        if let Some((min_x, max_x, min_y, max_y)) =
            expand_bounds(layer.backward_seed_bounds, blend_pad, width, height)
        {
            workspace.blend_layer_inplace_with_roi(
                &mut layer.mask,
                backward_prior_topologies,
                width,
                height,
                fade_px,
                Some(lut),
                (min_x, max_x, min_y, max_y),
            );
        } else {
            workspace.blend_layer_inplace(
                &mut layer.mask,
                backward_prior_topologies,
                width,
                height,
                fade_px,
                Some(lut),
            );
        }
        z_blend_backward_ns_local = blend_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        if let Some(before) = before_backward {
            let mut diff = vec![0u8; pixels_per_layer];
            for ((dst, after), prev) in diff.iter_mut().zip(layer.mask.iter()).zip(before.iter()) {
                *dst = after.saturating_sub(*prev);
            }
            layer.backward_contrib = Some(diff);
        }
    }

    let forward_applied = layer.apply_model_aa && layer.topology_non_empty && futures_have_topology;

    let mut forward_contrib = if debug_color_overlay && forward_applied {
        Some(vec![0u8; pixels_per_layer])
    } else {
        None
    };

    let effective_look_back = future_topologies.len();
    let mut z_blend_forward_ns = 0u64;
    let mut cross_blend_ns = 0u64;
    let mut cross_blend_touched_pixels = 0u64;
    let mut cross_blend_contributing_layers = 0u64;
    let mut post_blur_ns = 0u64;
    let mut support_merge_ns = 0u64;

    if forward_applied && effective_look_back > 0 {
        let blend_start = std::time::Instant::now();
        let before_forward = if debug_color_overlay {
            Some(layer.mask.clone())
        } else {
            None
        };

        let mut forward_seed_bounds = layer.topology_bounds;
        for bounds in future_bounds.iter().copied() {
            forward_seed_bounds = merge_bounds(forward_seed_bounds, bounds);
        }

        let blend_pad = fade_px as usize + 1;
        active_bounds = merge_bounds(
            active_bounds,
            expand_bounds(forward_seed_bounds, blend_pad, width, height),
        );
        if let Some((min_x, max_x, min_y, max_y)) =
            expand_bounds(forward_seed_bounds, blend_pad, width, height)
        {
            workspace.blend_layer_forward_inplace_with_roi(
                &mut layer.mask,
                layer.topology.as_slice(),
                future_topologies,
                effective_look_back,
                width,
                height,
                fade_px,
                Some(lut),
                (min_x, max_x, min_y, max_y),
            );
        } else {
            workspace.blend_layer_forward_inplace(
                &mut layer.mask,
                layer.topology.as_slice(),
                future_topologies,
                effective_look_back,
                width,
                height,
                fade_px,
                Some(lut),
            );
        }
        z_blend_forward_ns = blend_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;

        if let (Some(before), Some(ref mut forward)) =
            (before_forward.as_ref(), forward_contrib.as_mut())
        {
            for ((dst, after), prev) in forward.iter_mut().zip(layer.mask.iter()).zip(before.iter())
            {
                *dst = after.saturating_sub(*prev);
            }
        }
    }

    if let Some(cfg) = cross_blend_cfg {
        let cross_start = std::time::Instant::now();
        let mut cross_seed_bounds = layer.topology_bounds;
        for bounds in future_bounds.iter().copied() {
            cross_seed_bounds = merge_bounds(cross_seed_bounds, bounds);
        }
        active_bounds = merge_bounds(active_bounds, cross_seed_bounds);
        let mut neighbors: Vec<cross_blend::CrossBlendNeighbor<'_>> =
            Vec::with_capacity(prior_topologies.len() + future_topologies.len());
        for (depth, prior) in prior_topologies.iter().enumerate() {
            neighbors.push(cross_blend::CrossBlendNeighbor {
                z_offset: -((depth + 1) as i32),
                // Topology-magnitude occupancy field for volumetric support.
                mask: prior,
                topology: prior,
            });
        }
        for (depth, future) in future_topologies.iter().enumerate() {
            neighbors.push(cross_blend::CrossBlendNeighbor {
                z_offset: (depth + 1) as i32,
                mask: future,
                topology: future,
            });
        }
        let stats = cross_blend::cross_blend_layer_inplace(
            cross_blend::CrossBlendLayerInputs {
                center_mask: &mut layer.mask,
                center_topology: layer.topology.as_slice(),
                neighbors: &neighbors,
                width,
                height,
            },
            *cfg,
            cross_blend_ws,
        );
        cross_blend_ns = cross_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        cross_blend_touched_pixels = stats.touched_pixels as u64;
        cross_blend_contributing_layers = stats.contributing_layers as u64;
    }

    let should_blur_model = layer.apply_model_aa
        && (layer.model_non_empty || layer.backward_applied || forward_applied);
    if should_blur_model {
        let blur_start = std::time::Instant::now();
        let mut model_blur_seed_bounds = layer.backward_seed_bounds;
        if forward_applied {
            model_blur_seed_bounds = merge_bounds(model_blur_seed_bounds, layer.topology_bounds);
            for bounds in future_bounds.iter().copied() {
                model_blur_seed_bounds = merge_bounds(model_blur_seed_bounds, bounds);
            }
        }
        let blur_pad = fade_px as usize + blur_radius;
        active_bounds = merge_bounds(
            active_bounds,
            expand_bounds(model_blur_seed_bounds, blur_pad, width, height),
        );
        if let Some((min_x, max_x, min_y, max_y)) =
            expand_bounds(model_blur_seed_bounds, blur_pad, width, height)
        {
            // Run the blur without an inline min-alpha floor so we can apply
            // separate floors for topology pixels vs z-blend pixels below.
            // When custom_lut is used, skip floors since the LUT fully defines cure behavior.
            apply_blur_postprocess_inplace_with_roi(
                &mut layer.mask,
                width,
                height,
                min_x,
                max_x,
                min_y,
                max_y,
                blur_radius,
                0,
            );
        } else {
            apply_blur_postprocess_inplace(&mut layer.mask, width, height, blur_radius, 0);
        }
        // Apply topology-gated minimum alpha floors after blur:
        // SKIP if custom_lut is used; the LUT fully defines cure behavior and
        // additional floors would contradict the user's intent.
        //
        // Pixels inside the current layer's binary footprint (topology) received
        // their value from XY rasterization ± blur.  These are true XY AA pixels
        // and should be lifted to `min_aa_alpha_u8` so they cure reliably.
        //
        // Pixels outside the topology received their value exclusively from the
        // z-blend gradient.  Lifting them with the same floor as XY AA pixels
        // causes dimensional overgrowth (the "wide flat top" artefact) because
        // even faint gradient tails 100+ px from the edge get lifted to the cure
        // threshold.  The separate `z_blend_min_alpha_u8` (default 0) lets the
        // gradient taper naturally.
        if !has_custom_lut {
            const TOPO_THRESHOLD: u8 = 127;
            if min_aa_alpha_u8 > 0 || z_blend_min_alpha_u8 > 0 {
                let topology = layer.topology.as_slice();
                for (idx, px) in layer.mask.iter_mut().enumerate() {
                    if *px == 0 {
                        continue;
                    }
                    if topology[idx] > TOPO_THRESHOLD {
                        // XY AA pixel: floor up so it cures reliably.
                        if *px < min_aa_alpha_u8 {
                            *px = min_aa_alpha_u8;
                        }
                    } else {
                        // z-blend gradient pixel: zero out if below cure threshold
                        // so the gradient fades to black rather than forming a hard
                        // lifted ring (the "fat block" artefact).
                        if *px < z_blend_min_alpha_u8 {
                            *px = 0;
                        }
                    }
                }
            }
            if blur_radius == 0 {
                // No blur ran; still need to apply XY AA floor to topology pixels
                // and z-blend cutoff to gradient pixels.
                const TOPO_THRESHOLD2: u8 = 127;
                let topology = layer.topology.as_slice();
                for (idx, px) in layer.mask.iter_mut().enumerate() {
                    if *px == 0 {
                        continue;
                    }
                    if topology[idx] > TOPO_THRESHOLD2 {
                        if *px < min_aa_alpha_u8 {
                            *px = min_aa_alpha_u8;
                        }
                    } else {
                        if *px < z_blend_min_alpha_u8 {
                            *px = 0;
                        }
                    }
                }
            }
        }
        post_blur_ns = post_blur_ns
            .saturating_add(blur_start.elapsed().as_nanos().min(u64::MAX as u128) as u64);
    }

    if let Some(ref mut backward) = layer.backward_contrib {
        let blur_start = std::time::Instant::now();
        apply_blur_postprocess_inplace(backward, width, height, blur_radius, min_aa_alpha_u8);
        if blur_radius == 0 {
            apply_min_alpha_floor(backward, min_aa_alpha_u8);
        }
        post_blur_ns = post_blur_ns
            .saturating_add(blur_start.elapsed().as_nanos().min(u64::MAX as u128) as u64);
    }
    if let Some(ref mut forward) = forward_contrib {
        let blur_start = std::time::Instant::now();
        apply_blur_postprocess_inplace(forward, width, height, blur_radius, min_aa_alpha_u8);
        if blur_radius == 0 {
            apply_min_alpha_floor(forward, min_aa_alpha_u8);
        }
        post_blur_ns = post_blur_ns
            .saturating_add(blur_start.elapsed().as_nanos().min(u64::MAX as u128) as u64);
    }

    if let Some(support_mask) = layer.support_mask.as_ref() {
        let merge_start = std::time::Instant::now();
        active_bounds = merge_bounds(active_bounds, Some(support_mask.bounds));
        merge_support_mask_inplace(&mut layer.mask, support_mask, width);
        support_merge_ns = support_merge_ns
            .saturating_add(merge_start.elapsed().as_nanos().min(u64::MAX as u128) as u64);
    }

    PostProcessedLayer {
        seq: 0,
        layer,
        active_bounds,
        forward_contrib,
        z_blend_backward_ns: z_blend_backward_ns_local,
        z_blend_forward_ns,
        cross_blend_ns,
        cross_blend_touched_pixels,
        cross_blend_contributing_layers,
        post_blur_ns,
        support_merge_ns,
    }
}

/// Fast consumer-thread path: updates perf counters and the topology window,
/// recycles the topology buffer, then forwards the processed mask to the
/// dedicated encode thread via the bounded channel.
///
/// This replaces the old `emit_post_processed_layer` at every call site.
/// The slow work (PNG encoding / `on_processed_mask` callback) now runs
/// concurrently with the next layer's raster/EDT pipeline.
#[allow(clippy::too_many_arguments)]
fn forward_to_encode(
    done: PostProcessedLayer,
    emitted_topologies: &mut VecDeque<Arc<Vec<u8>>>,
    topology_reuse_pool: &mut Vec<Vec<u8>>,
    keep_emitted_topologies: bool,
    look_back: usize,
    encode_tx: &std::sync::mpsc::SyncSender<EncodeTask>,
    z_blend_backward_ns: &AtomicU64,
    z_blend_forward_ns: &AtomicU64,
    cross_blend_ns: &AtomicU64,
    cross_blend_touched_pixels: &AtomicU64,
    cross_blend_contributing_layers: &AtomicU64,
    post_blur_ns: &AtomicU64,
    support_merge_ns: &AtomicU64,
    forwarded_layers: &AtomicU64,
) -> Result<(), SlicerV3Error> {
    // Perf counters (cheap atomics).
    z_blend_backward_ns.fetch_add(done.z_blend_backward_ns, Ordering::Relaxed);
    z_blend_forward_ns.fetch_add(done.z_blend_forward_ns, Ordering::Relaxed);
    cross_blend_ns.fetch_add(done.cross_blend_ns, Ordering::Relaxed);
    cross_blend_touched_pixels.fetch_add(done.cross_blend_touched_pixels, Ordering::Relaxed);
    cross_blend_contributing_layers
        .fetch_add(done.cross_blend_contributing_layers, Ordering::Relaxed);
    post_blur_ns.fetch_add(done.post_blur_ns, Ordering::Relaxed);
    support_merge_ns.fetch_add(done.support_merge_ns, Ordering::Relaxed);

    // Topology window for future cross-blend priors (consumer-thread state).
    if keep_emitted_topologies {
        emitted_topologies.push_back(Arc::clone(&done.layer.topology));
        while emitted_topologies.len() > look_back {
            emitted_topologies.pop_front();
        }
    }
    // Recycle the topology buffer when this is the sole remaining Arc owner.
    if let Ok(inner) = Arc::try_unwrap(done.layer.topology) {
        topology_reuse_pool.push(inner);
    }

    // Dispatch to the encode thread.  This may block briefly if the channel
    // is at capacity, providing back-pressure on the 3DAA pipeline.
    encode_tx
        .send(EncodeTask {
            layer_index: done.layer.layer_index,
            mask: done.layer.mask,
            active_bounds: done.active_bounds,
            backward_contrib: done.layer.backward_contrib,
            forward_contrib: done.forward_contrib,
        })
        .map_err(|_| {
            SlicerV3Error::LayerPreview("3DAA encode channel closed unexpectedly".to_string())
        })?;
    forwarded_layers.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

fn rasterize_vertical_aa_streaming_v3(
    job: &SliceJobV3,
    raster_job: &SliceJobV3,
    // Raw triangle float data for the raster job, taken by value so it can be
    // freed immediately after `parse_triangles` completes — before the long
    // render loop begins.  The caller should pass job.triangles_xyz.clone()
    // here; the clone is short-lived (freed after parse_triangles returns).
    raster_triangles_xyz: Vec<f32>,
    requires_area_stats: bool,
    collect_png_layers: bool,
    collect_raw_mask_layers: bool,
    // Optional per-layer callback receiving the fully processed (z-blended +
    // blurred) mask. When provided, the mask is forwarded here instead of being
    // appended to `raw_mask_layers`. Use this for streaming RLE or raw-mask
    // output without accumulating all layers in memory.
    on_processed_mask: Option<
        &mut dyn FnMut(u32, Vec<u8>, TopologyBounds) -> Result<(), SlicerV3Error>,
    >,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    let width = raster_job.effective_render_width_px() as usize;
    let height = raster_job.source_height_px as usize;
    let pixels_per_layer = width.saturating_mul(height);
    // Large-layer sweeps over full masks/topology maps are bandwidth-heavy and
    // can under-utilize CPU when run on a single thread.
    const PARALLEL_SWEEP_PIXEL_THRESHOLD: usize = 8_000_000;
    let use_parallel_sweeps = pixels_per_layer >= PARALLEL_SWEEP_PIXEL_THRESHOLD;
    let cross_blend_cfg = if is_cross_blend_mode(&job.anti_aliasing_mode) {
        Some(cross_blend::CrossBlendKernelConfig {
            window_layers: (job.z_blend_look_back as usize).max(1),
            z_decay: 0.75,
            xy_radius_px: (job.z_blend_fade_px.max(1).min(4)) as usize,
            xy_decay: 1.0,
            topo_threshold: TOPOLOGY_ALPHA_THRESHOLD,
            strength: 1.0,
            max_alpha: 255,
        })
    } else {
        None
    };
    let post_threads = choose_3daa_post_threads(width, height, job.total_layers);
    let post_buffer_depth =
        choose_3daa_post_buffer_depth(width, height, job.total_layers, post_threads);
    // Dedicated thread pool for the topology parallel sweep.  Sized to post_threads
    // (= hw for large layers) so the sweep scales with available cores.
    // The rasteriser runs in its own isolated custom ThreadPool so there is no
    // scheduling conflict.  Post-worker count is bounded by choose_3daa_post_buffer_depth.
    let post_sweep_pool = if use_parallel_sweeps {
        ThreadPoolBuilder::new()
            .num_threads(post_threads)
            .build()
            .ok()
    } else {
        None
    };
    let look_back = (job.z_blend_look_back as usize).max(1);
    // Use the physics-calibrated fade distance when auto-fade is enabled.
    // See `SliceJobV3::effective_z_blend_fade_px` for the derivation.
    let fade_px = job.effective_z_blend_fade_px();
    let blur_radius = job.blur_brush_radius_px as usize;
    let min_aa_alpha_u8 =
        ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
    // Separate minimum alpha for z-blend gradient pixels.  These live outside
    // the current layer's binary footprint and must be allowed to taper to 0;
    // lifting them with the same floor as XY AA pixels causes dimensional
    // overgrowth and the "wide flat top" stair-step artefact.
    let z_blend_min_alpha_u8 =
        ((job.z_blend_minimum_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
    let has_custom_lut = job.z_blend_custom_lut.is_some();
    let lut: [u8; 256] = if let Some(custom) = &job.z_blend_custom_lut {
        let mut arr = [0u8; 256];
        for (i, &v) in custom.iter().enumerate().take(256) {
            arr[i] = v;
        }
        arr[0] = 0;
        arr[255] = 255;
        arr
    } else {
        let z_blend_max_alpha_u8 =
            ((job.z_blend_max_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
        z_blend::make_cure_window_lut(z_blend_min_alpha_u8, z_blend_max_alpha_u8)
    };
    let debug_color_overlay = job.z_blend_debug_color_overlay && collect_png_layers;
    const TOPOLOGY_ALPHA_THRESHOLD: u8 = 127;

    let mut topology_reuse_pool: Vec<Vec<u8>> = Vec::with_capacity(look_back + 1);
    // Lazily allocate consumer-thread post workspaces only if we actually run
    // the non-overlap path. In normal overlap mode, post-processing happens on
    // worker threads and these would otherwise be an unused extra ~884MB at 12K.
    let mut workspace: Option<z_blend::ZBlendWorkspace> = None;
    let mut cross_blend_ws: Option<cross_blend::CrossBlendWorkspace> = None;
    let debug_rgb_buffer: Vec<u8> = if debug_color_overlay {
        vec![0u8; pixels_per_layer * 3]
    } else {
        Vec::new()
    };
    let png_layers: Option<Vec<Vec<u8>>> =
        collect_png_layers.then(|| Vec::with_capacity(job.total_layers as usize));
    // When on_processed_mask is provided it owns the processed masks (streaming
    // to an RLE / raw-mask encoder); fall back to in-memory collection only
    // when the caller explicitly requests it AND no streaming callback exists.
    let use_callback = on_processed_mask.is_some();
    // RLE-first baseline: callback + no PNG + no raw-mask collection.
    // This is the hottest path and should keep memory pressure minimal.
    let rle_streaming_baseline = use_callback && !collect_png_layers && !collect_raw_mask_layers;
    let raw_mask_layers: Option<Vec<Vec<u8>>> = (collect_raw_mask_layers && !use_callback)
        .then(|| Vec::with_capacity(job.total_layers as usize));
    let mut on_processed_mask = on_processed_mask; // move into local for closure capture

    // Perf counters (z_blend_backward_ns, z_blend_forward_ns, cross_blend_ns,
    // cross_blend_touched_pixels, cross_blend_contributing_layers, post_blur_ns,
    // support_merge_ns, callback_sweep_ns, callback_drain_ns, callback_total_ns)
    // are declared inside the pump thread and returned via PumpStats after it
    // joins.  Only the two Arc<AtomicU64> counters that are also read by the
    // encode thread remain here.
    let encode_progress_log_every =
        env_override_usize("DF_3DAA_RATE_LOG_EVERY").unwrap_or(0) as u64;
    let forwarded_layers = Arc::new(AtomicU64::new(0));
    let encoded_layers = Arc::new(AtomicU64::new(0));

    // ── Encode thread ──────────────────────────────────────────────────────────
    // The consumer thread is the pipeline bottleneck: after the previous session's
    // raster-concurrency fix, emit-drain (CTB/LYS encoding) consumes ~35ms/layer
    // while EDT only takes ~18ms.  Moving encoding to a dedicated thread lets EDT
    // and encoding overlap, targeting ~35ms/layer effective throughput instead of
    // ~53ms/layer (EDT + encode serially).
    //
    // Drop-ordering is critical for safety with the raw `on_processed_mask`
    // pointer: declare `encode_handle_guard` FIRST so it drops LAST (joins
    // the thread), and `encode_tx` SECOND so it drops FIRST (closes the channel,
    // letting the thread exit cleanly).  Rust's reverse-drop order ensures this
    // even on early `?` returns.
    let encode_handle_guard: EncodeThreadHandle;
    // Encode channel capacity.  Each in-flight 12K layer is ~59 MB.
    //
    // Depth=3 for huge layers (RLE baseline): absorbs short encode bursts while
    // keeping total in-flight mask memory bounded.  Depth=4 was tried but
    // combined with worker_count=4 it caused enough memory pressure at 12K
    // (encode_buf×59MB + pending) to slow the encode thread itself, negating
    // the extra throughput headroom.  Depth=3 is the empirical sweet spot.
    let encode_buffer_depth_default = if rle_streaming_baseline {
        if pixels_per_layer >= 48 * 1024 * 1024 {
            3
        } else {
            3
        }
    } else if pixels_per_layer >= 48 * 1024 * 1024 {
        2
    } else {
        3
    };
    let encode_buffer_depth = std::env::var("DF_3DAA_ENCODE_BUFFER_DEPTH")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(encode_buffer_depth_default);
    let (encode_tx, encode_rx) = std::sync::mpsc::sync_channel::<EncodeTask>(encode_buffer_depth);
    {
        // Raw pointer for the FnMut callback — see SendMaskCallback for safety
        // invariant documentation.
        //
        // `&mut dyn FnMut(...)` and `*mut (dyn FnMut(...) + 'static)` are both
        // 2-word fat pointers with identical binary layouts; transmute is used
        // to erase the compile-time lifetime (the actual lifetime is enforced
        // by the join-before-return invariant upheld by EncodeThreadHandle).
        let send_fn = SendMaskCallback(on_processed_mask.as_deref_mut().map(|f| unsafe {
            std::mem::transmute::<
                &mut dyn FnMut(u32, Vec<u8>, TopologyBounds) -> Result<(), SlicerV3Error>,
                *mut (dyn FnMut(u32, Vec<u8>, TopologyBounds) -> Result<(), SlicerV3Error>
                     + 'static),
            >(f)
        }));
        let enc_w = width as u32;
        let enc_h = height as u32;
        let enc_compress = raster_job.png_compression_strategy.clone();
        let enc_debug = debug_color_overlay;
        let enc_px = pixels_per_layer;
        let enc_total_layers = job.total_layers as u64;
        let enc_log_every = encode_progress_log_every;
        let forwarded_layers_enc = Arc::clone(&forwarded_layers);
        let encoded_layers_enc = Arc::clone(&encoded_layers);
        let mut png_layers_enc = png_layers;
        let mut raw_mask_layers_enc = raw_mask_layers;
        let mut dbg_rgb_enc = debug_rgb_buffer;
        let encode_thread = std::thread::Builder::new()
            .name("3daa-encode".to_string())
            .spawn(
                move || -> Result<(Option<Vec<Vec<u8>>>, Option<Vec<Vec<u8>>>), SlicerV3Error> {
                    let send_fn = send_fn;
                    let encode_start = std::time::Instant::now();
                    let mut window_start = encode_start;
                    let mut window_layers_base = 0u64;
                    // Per-step timing accumulators (ns) for the [3DAA] encode breakdown.
                    let mut png_ns: u64 = 0;
                    let mut format_ns: u64 = 0;
                    for task in encode_rx {
                        if let Some(out_pngs) = &mut png_layers_enc {
                            let png_t0 = std::time::Instant::now();
                            let png = if enc_debug {
                                if let (Some(bk), Some(fw)) = (
                                    task.backward_contrib.as_ref(),
                                    task.forward_contrib.as_ref(),
                                ) {
                                    if dbg_rgb_enc.len() != enc_px * 3 {
                                        dbg_rgb_enc.resize(enc_px * 3, 0);
                                    }
                                    for i in 0..enc_px {
                                        dbg_rgb_enc[i * 3] = fw[i];
                                        dbg_rgb_enc[i * 3 + 1] = bk[i];
                                        dbg_rgb_enc[i * 3 + 2] = 0;
                                    }
                                    encode_rgb_png_8bit(enc_w, enc_h, &dbg_rgb_enc, &enc_compress)?
                                } else {
                                    encode_grayscale_png(
                                        enc_w,
                                        enc_h,
                                        &task.mask,
                                        &enc_compress,
                                        false,
                                    )?
                                }
                            } else {
                                encode_grayscale_png(
                                    enc_w,
                                    enc_h,
                                    &task.mask,
                                    &enc_compress,
                                    false,
                                )?
                            };
                            out_pngs.push(png);
                            png_ns = png_ns.saturating_add(
                                png_t0.elapsed().as_nanos().min(u64::MAX as u128) as u64,
                            );
                        }
                        // SAFETY: exclusive access guaranteed — only this thread calls the
                        // fn, and it is joined before rasterize_vertical_aa_streaming_v3
                        // returns (enforced by EncodeThreadHandle::Drop).
                        {
                            let fmt_t0 = std::time::Instant::now();
                            if let Some(ptr) = send_fn.0 {
                                unsafe { (*ptr)(task.layer_index, task.mask, task.active_bounds) }?;
                            } else if let Some(out_masks) = &mut raw_mask_layers_enc {
                                out_masks.push(task.mask);
                            }
                            format_ns = format_ns.saturating_add(
                                fmt_t0.elapsed().as_nanos().min(u64::MAX as u128) as u64,
                            );
                        }

                        let encoded = encoded_layers_enc.fetch_add(1, Ordering::Relaxed) + 1;
                        if enc_log_every > 0 {
                            if encoded == 1 {
                                eprintln!(
                                    "[3DAA]   progress first-encoded={:.3}s",
                                    encode_start.elapsed().as_secs_f64(),
                                );
                                window_start = std::time::Instant::now();
                                window_layers_base = encoded;
                            }
                            if encoded == enc_total_layers || encoded % enc_log_every == 0 {
                                let total_elapsed = encode_start.elapsed().as_secs_f64().max(1e-9);
                                let window_elapsed = window_start.elapsed().as_secs_f64().max(1e-9);
                                let window_layers = encoded.saturating_sub(window_layers_base).max(1);
                                let total_lps = encoded as f64 / total_elapsed;
                                let window_lps = window_layers as f64 / window_elapsed;
                                let forwarded = forwarded_layers_enc.load(Ordering::Relaxed);
                                let backlog = forwarded.saturating_sub(encoded);
                                eprintln!(
                                    "[3DAA]   progress {}/{} | total={:.1} l/s window={:.1} l/s encode_backlog={}",
                                    encoded,
                                    enc_total_layers,
                                    total_lps,
                                    window_lps,
                                    backlog,
                                );
                                window_start = std::time::Instant::now();
                                window_layers_base = encoded;
                            }
                        }
                    }
                    let total_encode_s = encode_start.elapsed().as_secs_f64();
                    let enc_n = enc_total_layers.max(1) as f64;
                    let ms = |ns: u64| ns as f64 / 1_000_000.0;
                    eprintln!(
                        "[3DAA]   encode/layer → format={:.1}ms png={:.1}ms \
                         (encode-thread wall≈{:.1}ms/layer)",
                        ms(format_ns) / enc_n,
                        ms(png_ns) / enc_n,
                        total_encode_s * 1000.0 / enc_n,
                    );
                    Ok((png_layers_enc, raw_mask_layers_enc))
                },
            )
            .map_err(|e| {
                SlicerV3Error::LayerPreview(format!("failed to spawn 3DAA encode thread: {e}"))
            })?;
        encode_handle_guard = EncodeThreadHandle {
            handle: Some(encode_thread),
        };
    }
    // `png_layers`, `raw_mask_layers`, and `debug_rgb_buffer` are now owned by
    // the encode thread.  They are recovered at the end via
    // `encode_handle_guard.finish()`.
    // ──────────────────────────────────────────────────────────────────────────

    let mut support_mask_context = SupportMaskContext::from_job(raster_job);
    let model_active_layer_window = resolve_model_active_layer_window(raster_job);

    // Pending queue for symmetric forward-compensation blending.
    //
    // Each layer is held until up to `look_back` future topologies are available.
    // At emission time we apply forward blend first (lookahead window), then XY
    // blur, then support merge. This keeps forward and backward Z blending
    // symmetric and ensures both happen before blur.
    let mut pending_layers: VecDeque<PendingLayer> = VecDeque::with_capacity(look_back + 1);
    let mut emitted_topologies: VecDeque<Arc<Vec<u8>>> = VecDeque::with_capacity(look_back + 1);

    let overlap_enabled = post_buffer_depth > 0;

    // ── 3DAA pipeline diagnostics ──────────────────────────────────────────────
    // Print startup parameters so it's immediately clear what configuration is
    // being used.  Visible in `tauri:dev` console and cargo test output.
    {
        let hw_diag = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        let layer_px = (width as u64).saturating_mul(height as u64);
        let expected_workers = if post_buffer_depth > 0 {
            post_threads.min(post_buffer_depth.max(1)).max(1)
        } else {
            0
        };
        // Per-worker resident workspace WORST-CASE estimate (full-frame W×H):
        //   in_prior u8 + dist f32 + seeds u8 + edt_g f32 + labels_buf u32 = 14 bytes/px
        //   (plus ~1 byte/px BFS queue overhead = 15 bytes/px).
        // When cross_blend is enabled, +8 bytes/px (accum f32 + weight f32).
        //
        // NOTE (Phase 1.2): ZBlendWorkspace scratch is now ROI-local & lazy.
        // Typical models occupy 10–25% of build area, so the actual resident
        // workspace is typically 4–10× smaller than this ceiling.
        let zblend_bytes_per_px: u64 = 15;
        let crossblend_bytes_per_px: u64 = if cross_blend_cfg.is_some() { 8 } else { 0 };
        let ws_bytes = layer_px.saturating_mul(zblend_bytes_per_px + crossblend_bytes_per_px);
        let ws_mb_per_worker = ws_bytes / 1_000_000;
        let ws_total_mb = ws_mb_per_worker.saturating_mul(expected_workers.max(1) as u64);
        // Pending-layer ring estimate: (look_back + buffer_depth) layers each
        // carrying a 1 byte/px mask + 1 byte/px topology = 2 bytes/px.
        let pending_layers_est = (look_back as u64).saturating_add(post_buffer_depth.max(1) as u64);
        let pending_mb = pending_layers_est
            .saturating_mul(layer_px)
            .saturating_mul(2)
            / 1_000_000;
        // Encode channel: encode_buffer_depth × 1 byte/px mask.
        let encode_mb = (encode_buffer_depth as u64).saturating_mul(layer_px) / 1_000_000;
        // Mirror cap_concurrency_for_mask_bytes logic for the streaming 3DAA path.
        let raster_concurrent = {
            let budget_override = std::env::var("DF_V3_MAX_MASK_INFLIGHT_MB")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|v| *v >= 64)
                .map(|mb| (mb * 1024 * 1024) / pixels_per_layer.max(1));
            if let Some(budget) = budget_override {
                hw_diag.min(budget).max(1)
            } else if pixels_per_layer >= 48 * 1024 * 1024 {
                hw_diag.min(8)
            } else if pixels_per_layer >= 24 * 1024 * 1024 {
                hw_diag.min(6)
            } else if pixels_per_layer >= 12 * 1024 * 1024 {
                hw_diag.min(8)
            } else {
                hw_diag
            }
        };
        let streaming_buffer_depth = if let Ok(v) = std::env::var("DF_V3_STREAMING_BUFFER_DEPTH") {
            v.parse::<usize>().ok().map(|n| n.clamp(1, 32)).unwrap_or(4)
        } else if pixels_per_layer >= 48 * 1024 * 1024 {
            raster_concurrent.clamp(4, 8)
        } else if pixels_per_layer >= 24 * 1024 * 1024 {
            4
        } else {
            4
        };
        let raster_mb = ((raster_concurrent + streaming_buffer_depth) as u64)
            .saturating_mul(layer_px)
            / 1_000_000;
        let peak_in_flight_mb = ws_total_mb
            .saturating_add(pending_mb)
            .saturating_add(encode_mb)
            .saturating_add(raster_mb);
        eprintln!(
            "[3DAA] {}×{} layers={} hw={} raster_workers={} post_threads={} buffer_depth={} \
             workers={} ws_max≈{}MB/worker ws_total_max≈{}MB pending≈{}MB encode≈{}MB raster≈{}MB peak_max≈{}MB \
             look_back={} encode_buf={} raster_buf={} raster_aa={} raster_mode={} rate_log_every={}",
            width,
            height,
            job.total_layers,
            hw_diag,
            raster_concurrent,
            post_threads,
            post_buffer_depth,
            expected_workers,
            ws_mb_per_worker,
            ws_total_mb,
            pending_mb,
            encode_mb,
            raster_mb,
            peak_in_flight_mb,
            look_back,
            encode_buffer_depth,
            streaming_buffer_depth,
            raster_job.anti_aliasing_level,
            raster_job.anti_aliasing_mode,
            encode_progress_log_every,
        );
    }
    let pipeline_wall_start = std::time::Instant::now();
    // ──────────────────────────────────────────────────────────────────────────

    let mut post_worker_txs: Vec<mpsc::SyncSender<PostWorkerTask>> = Vec::new();
    let mut post_worker_rx: Option<mpsc::Receiver<PostProcessedLayer>> = None;
    let mut post_next_send_seq: u64 = 0;
    let mut post_next_emit_seq: u64 = 0;
    let mut post_rr_index: usize = 0;
    let mut post_done_reorder: BTreeMap<u64, PostProcessedLayer> = BTreeMap::new();
    let mut post_worker_count: usize = 0;
    // ROI-local ZBlendWorkspace resident bytes (max across workers, updated
    // after each processed layer).  Reported in the [3DAA] done summary so
    // users can see the actual memory vs. the worst-case ceiling.
    let workspace_max_bytes = Arc::new(AtomicUsize::new(0));

    if overlap_enabled {
        // `post_buffer_depth` returns the desired *worker count*.
        // The per-worker input channel depth is intentionally 1 (double-buffer: the
        // worker processes task N while task N+1 sits queued).  Using worker_count
        // here instead would queue worker_count tasks per worker = worker_count²
        // full-layer masks simultaneously, which at 12K (59 MB/mask, 4 workers)
        // balloons to 944 MB before backpressure ever kicks in.
        let worker_count = post_buffer_depth.max(1).min(post_threads);
        post_worker_count = worker_count;
        // done channel: worker_count slots so all workers can emit without blocking.
        let (done_tx, done_rx) = mpsc::sync_channel::<PostProcessedLayer>(worker_count);

        for _ in 0..worker_count {
            // Per-worker task queue depth = 1: one buffered while processing current.
            let (task_tx, task_rx) = mpsc::sync_channel::<PostWorkerTask>(1);
            let done_tx_worker = done_tx.clone();
            let ws_max = Arc::clone(&workspace_max_bytes);
            std::thread::spawn(move || {
                let mut workspace = z_blend::ZBlendWorkspace::new(width, height);
                let mut cross_blend_ws = cross_blend::CrossBlendWorkspace::new(width, height);
                while let Ok(task) = task_rx.recv() {
                    let backward_prior_slices: Vec<&[u8]> = task
                        .backward_prior_topologies
                        .iter()
                        .map(|v| v.as_slice())
                        .collect();
                    let prior_slices: Vec<&[u8]> =
                        task.prior_topologies.iter().map(|v| v.as_slice()).collect();
                    let future_slices: Vec<&[u8]> = task
                        .future_topologies
                        .iter()
                        .map(|v| v.as_slice())
                        .collect();
                    let mut out = process_pending_layer_post(
                        task.layer,
                        &prior_slices,
                        &backward_prior_slices,
                        &future_slices,
                        &task.future_bounds,
                        task.futures_have_topology,
                        width,
                        height,
                        fade_px,
                        blur_radius,
                        min_aa_alpha_u8,
                        z_blend_min_alpha_u8,
                        has_custom_lut,
                        debug_color_overlay,
                        &lut,
                        &mut workspace,
                        task.cross_blend_cfg.as_ref(),
                        &mut cross_blend_ws,
                    );
                    out.seq = task.seq;
                    let bytes = workspace.resident_bytes();
                    let mut cur = ws_max.load(Ordering::Relaxed);
                    while bytes > cur {
                        match ws_max.compare_exchange_weak(
                            cur,
                            bytes,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        ) {
                            Ok(_) => break,
                            Err(prev) => cur = prev,
                        }
                    }
                    if done_tx_worker.send(out).is_err() {
                        break;
                    }
                }
            });
            post_worker_txs.push(task_tx);
        }
        drop(done_tx);

        post_worker_rx = Some(done_rx);
    }

    // ── Raster-pump decoupling ─────────────────────────────────────────────────
    // `on_raw_mask_layer` now just pushes the raw mask to a bounded channel
    // (depth = 1) and returns immediately.  A dedicated pump thread receives
    // those masks and runs all 3DAA processing (topology bake, dispatch,
    // done-drain, encode-send), overlapping with the rasterizer.
    //
    // Before decoupling: rasterize 26ms → callback 35ms → 61ms/layer (serial)
    // After decoupling:  rasterize 26ms ‖ pump 35ms → ~35ms/layer (parallel)
    let (raw_pump_tx, raw_pump_rx) =
        std::sync::mpsc::sync_channel::<(u32, Vec<u8>, LayerAreaStatsV3)>(1);
    let pump_thread = std::thread::Builder::new()
        .name("3daa-pump".to_string())
        .spawn(move || -> Result<PumpStats, SlicerV3Error> {
            // Local perf counters; passed by reference to forward_to_encode.
            let z_blend_backward_ns = AtomicU64::new(0);
            let z_blend_forward_ns = AtomicU64::new(0);
            let cross_blend_ns = AtomicU64::new(0);
            let cross_blend_touched_pixels = AtomicU64::new(0);
            let cross_blend_contributing_layers = AtomicU64::new(0);
            let post_blur_ns = AtomicU64::new(0);
            let support_merge_ns = AtomicU64::new(0);
            let callback_sweep_ns = AtomicU64::new(0);
            let callback_drain_ns = AtomicU64::new(0);
            let callback_total_ns = AtomicU64::new(0);
            // Timer for the 2-second periodic queue-depth diagnostic.
            let mut pump_diag_last = std::time::Instant::now();

            for (layer_index, mut raw_mask, raster_stats) in raw_pump_rx {
                let callback_t0 = std::time::Instant::now();
                let result = (|| -> Result<(), SlicerV3Error> {
                    if raw_mask.is_empty() {
                        // Streaming raster emits an empty Vec sentinel for guaranteed-black
                        // layers. Reuse a pooled full-size buffer instead of allocating a
                        // fresh 59MB Vec, which can fail under fragmentation on long 12K jobs.
                        raw_mask = crate::pipeline::get_recycled_mask(pixels_per_layer);
                    }
                    if raw_mask.len() != pixels_per_layer {
                        return Err(SlicerV3Error::MissingRenderedLayerPayload(
                            "Vertical AA raw mask size mismatch while streaming".to_string(),
                        ));
                    }

                    let support_mask_for_layer = support_mask_context
                        .as_mut()
                        .and_then(|ctx| ctx.rasterize_support_mask(layer_index));

                    // Remove support/raft pixels from the AA processing path.
                    // They are merged back after model-only z-blend + blur.
                    if let Some(ref support_layer) = support_mask_for_layer {
                        let support_mask = support_layer.mask.as_slice();
                        let (min_x, max_x, min_y, max_y) = support_layer.bounds;
                        for y in min_y..=max_y {
                            let row_start = y * width;
                            let raw_row = &mut raw_mask[row_start + min_x..=row_start + max_x];
                            let support_row = &support_mask[row_start + min_x..=row_start + max_x];
                            for (px, s) in raw_row.iter_mut().zip(support_row.iter()) {
                                if *s > 0 {
                                    *px = 0;
                                }
                            }
                        }
                    }

                    // Topology mask: binary occupancy for z-blending and forward compensation.
                    let apply_model_aa = model_active_layer_window
                        .map(|(first, last)| layer_index >= first && layer_index <= last)
                        .unwrap_or(true);

                    let mut topology_mask = topology_reuse_pool
                        .pop()
                        .unwrap_or_else(|| vec![0u8; pixels_per_layer]);
                    if topology_mask.len() != pixels_per_layer {
                        topology_mask.resize(pixels_per_layer, 0);
                    }
                    let mut model_non_empty = false;
                    let mut topology_non_empty = false;
                    let mut topo_min_x = width;
                    let mut topo_max_x = 0usize;
                    let mut topo_min_y = height;
                    let mut topo_max_y = 0usize;
                    let mask_bounds = if raster_stats.total_solid_pixels > 0 {
                        let min_x = (raster_stats.min_x.max(0) as usize).min(width - 1);
                        let max_x = (raster_stats.max_x.max(raster_stats.min_x).max(0) as usize)
                            .min(width - 1);
                        let min_y = (raster_stats.min_y.max(0) as usize).min(height - 1);
                        let max_y = (raster_stats.max_y.max(raster_stats.min_y).max(0) as usize)
                            .min(height - 1);
                        (min_x <= max_x && min_y <= max_y).then_some((min_x, max_x, min_y, max_y))
                    } else {
                        None
                    };
                    if apply_model_aa {
                        // Reused buffers may contain stale bits from previous layers.
                        topology_mask.fill(0);

                        // Use rasterizer-provided non-zero bounds to avoid sweeping the
                        // entire 12K frame on every layer.
                        if raster_stats.total_solid_pixels > 0 {
                            model_non_empty = true;

                            let bbox_min_x = (raster_stats.min_x.max(0) as usize).min(width - 1);
                            let bbox_max_x = (raster_stats.max_x.max(raster_stats.min_x).max(0)
                                as usize)
                                .min(width - 1);
                            let bbox_min_y = (raster_stats.min_y.max(0) as usize).min(height - 1);
                            let bbox_max_y = (raster_stats.max_y.max(raster_stats.min_y).max(0)
                                as usize)
                                .min(height - 1);

                            if bbox_min_x <= bbox_max_x && bbox_min_y <= bbox_max_y {
                                #[derive(Clone, Copy)]
                                struct TopologySweepStats {
                                    topology_non_empty: bool,
                                    min_x: usize,
                                    max_x: usize,
                                    min_y: usize,
                                    max_y: usize,
                                }

                                impl TopologySweepStats {
                                    #[inline]
                                    fn empty(width: usize, height: usize) -> Self {
                                        Self {
                                            topology_non_empty: false,
                                            min_x: width,
                                            max_x: 0,
                                            min_y: height,
                                            max_y: 0,
                                        }
                                    }

                                    #[inline]
                                    fn merge(
                                        self,
                                        other: Self,
                                        width: usize,
                                        height: usize,
                                    ) -> Self {
                                        if !self.topology_non_empty && !other.topology_non_empty {
                                            return Self::empty(width, height);
                                        }
                                        Self {
                                            topology_non_empty: self.topology_non_empty
                                                || other.topology_non_empty,
                                            min_x: self.min_x.min(other.min_x),
                                            max_x: self.max_x.max(other.max_x),
                                            min_y: self.min_y.min(other.min_y),
                                            max_y: self.max_y.max(other.max_y),
                                        }
                                    }
                                }

                                let bbox_area = (bbox_max_x - bbox_min_x + 1)
                                    .saturating_mul(bbox_max_y - bbox_min_y + 1);

                                let run_sweep_parallel = use_parallel_sweeps
                                    && bbox_area >= PARALLEL_SWEEP_PIXEL_THRESHOLD;

                                let mut sweep_parallel = || {
                                    let row_start = bbox_min_y * width;
                                    let row_end = (bbox_max_y + 1) * width;
                                    raw_mask[row_start..row_end]
                                        .par_chunks(width)
                                        .zip(
                                            topology_mask[row_start..row_end].par_chunks_mut(width),
                                        )
                                        .enumerate()
                                        .map(|(local_y, (raw_row, topo_row))| {
                                            let y = bbox_min_y + local_y;
                                            let mut local =
                                                TopologySweepStats::empty(width, height);
                                            for x in bbox_min_x..=bbox_max_x {
                                                if raw_row[x] > TOPOLOGY_ALPHA_THRESHOLD {
                                                    topo_row[x] = 255;
                                                    local.topology_non_empty = true;
                                                    local.min_x = local.min_x.min(x);
                                                    local.max_x = local.max_x.max(x);
                                                    local.min_y = local.min_y.min(y);
                                                    local.max_y = local.max_y.max(y);
                                                }
                                            }
                                            local
                                        })
                                        .reduce(
                                            || TopologySweepStats::empty(width, height),
                                            |a, b| a.merge(b, width, height),
                                        )
                                };

                                let sweep_t0 = std::time::Instant::now();
                                let sweep = if run_sweep_parallel {
                                    if let Some(pool) = post_sweep_pool.as_ref() {
                                        pool.install(sweep_parallel)
                                    } else {
                                        sweep_parallel()
                                    }
                                } else {
                                    let mut local = TopologySweepStats::empty(width, height);
                                    for y in bbox_min_y..=bbox_max_y {
                                        let row = y * width;
                                        for x in bbox_min_x..=bbox_max_x {
                                            let idx = row + x;
                                            if raw_mask[idx] > TOPOLOGY_ALPHA_THRESHOLD {
                                                topology_mask[idx] = 255;
                                                local.topology_non_empty = true;
                                                local.min_x = local.min_x.min(x);
                                                local.max_x = local.max_x.max(x);
                                                local.min_y = local.min_y.min(y);
                                                local.max_y = local.max_y.max(y);
                                            }
                                        }
                                    }
                                    local
                                };
                                callback_sweep_ns.fetch_add(
                                    sweep_t0.elapsed().as_nanos().min(u64::MAX as u128) as u64,
                                    Ordering::Relaxed,
                                );

                                topology_non_empty = sweep.topology_non_empty;
                                topo_min_x = sweep.min_x;
                                topo_max_x = sweep.max_x;
                                topo_min_y = sweep.min_y;
                                topo_max_y = sweep.max_y;
                            }
                        }
                    } else {
                        topology_mask.fill(0);
                    }

                    let topology_bounds = if topology_non_empty {
                        Some((topo_min_x, topo_max_x, topo_min_y, topo_max_y))
                    } else {
                        None
                    };

                    let priors_have_topology =
                        pending_layers.iter().any(|layer| layer.topology_non_empty);
                    let backward_applied =
                        apply_model_aa && (model_non_empty || priors_have_topology);
                    let mut backward_seed_bounds = topology_bounds;
                    // Capture backward prior topologies (oldest-to-newest) while pending_layers
                    // holds the correct window.  These are stored in PendingLayer and forwarded
                    // to the post-worker so backward EDT runs off the main thread.
                    let priors_start = pending_layers.len().saturating_sub(look_back);
                    if backward_applied {
                        for prior in pending_layers.iter().skip(priors_start) {
                            backward_seed_bounds =
                                merge_bounds(backward_seed_bounds, prior.topology_bounds);
                        }
                    }
                    let backward_prior_topologies: Vec<Arc<Vec<u8>>> = pending_layers
                        .iter()
                        .skip(priors_start)
                        .map(|l| Arc::clone(&l.topology))
                        .collect();

                    // Defer emission so we can apply a full lookahead window before blur.
                    // Backward EDT now runs inside process_pending_layer_post (post-worker).
                    pending_layers.push_back(PendingLayer {
                        layer_index,
                        mask: raw_mask,
                        mask_bounds,
                        topology: Arc::new(topology_mask),
                        topology_bounds,
                        topology_non_empty,
                        model_non_empty,
                        backward_applied,
                        backward_seed_bounds,
                        backward_prior_topologies,
                        support_mask: support_mask_for_layer,
                        apply_model_aa,
                        backward_contrib: None, // computed by process_pending_layer_post after backward EDT
                    });

                    // Flush once the oldest pending layer has a full future window plus
                    // optional extra buffering depth for post-stage scheduling experiments.
                    if pending_layers.len() > look_back + post_buffer_depth {
                        let mut layer = pending_layers.pop_front().expect("pending layer exists");

                        if !post_worker_txs.is_empty() {
                            let prior_topologies: Vec<Arc<Vec<u8>>> = emitted_topologies
                                .iter()
                                .rev()
                                .take(look_back)
                                .map(Arc::clone)
                                .collect();
                            let future_topologies: Vec<Arc<Vec<u8>>> = pending_layers
                                .iter()
                                .take(look_back)
                                .map(|future| Arc::clone(&future.topology))
                                .collect();
                            let future_bounds: Vec<TopologyBounds> = pending_layers
                                .iter()
                                .take(look_back)
                                .map(|future| future.topology_bounds)
                                .collect();
                            let futures_have_topology = pending_layers
                                .iter()
                                .take(look_back)
                                .any(|future| future.topology_non_empty);

                            let worker_idx = post_rr_index % post_worker_txs.len();
                            post_rr_index = post_rr_index.wrapping_add(1);
                            let seq = post_next_send_seq;
                            post_next_send_seq = post_next_send_seq.wrapping_add(1);
                            let backward_prior_topologies =
                                std::mem::take(&mut layer.backward_prior_topologies);

                            post_worker_txs[worker_idx]
                                .send(PostWorkerTask {
                                    seq,
                                    layer,
                                    backward_prior_topologies,
                                    prior_topologies,
                                    future_topologies,
                                    future_bounds,
                                    futures_have_topology,
                                    cross_blend_cfg,
                                })
                                .map_err(|_| {
                                    SlicerV3Error::LayerPreview(
                                        "3DAA post worker task channel unexpectedly closed"
                                            .to_string(),
                                    )
                                })?;

                            let drain_t0 = std::time::Instant::now();
                            if let Some(rx) = post_worker_rx.as_ref() {
                                while let Ok(done) = rx.try_recv() {
                                    post_done_reorder.insert(done.seq, done);
                                    while let Some(next_done) =
                                        post_done_reorder.remove(&post_next_emit_seq)
                                    {
                                        forward_to_encode(
                                            next_done,
                                            &mut emitted_topologies,
                                            &mut topology_reuse_pool,
                                            cross_blend_cfg.is_some(),
                                            look_back,
                                            &encode_tx,
                                            &z_blend_backward_ns,
                                            &z_blend_forward_ns,
                                            &cross_blend_ns,
                                            &cross_blend_touched_pixels,
                                            &cross_blend_contributing_layers,
                                            &post_blur_ns,
                                            &support_merge_ns,
                                            forwarded_layers.as_ref(),
                                        )?;
                                        post_next_emit_seq = post_next_emit_seq.wrapping_add(1);
                                    }
                                }
                            }
                            callback_drain_ns.fetch_add(
                                drain_t0.elapsed().as_nanos().min(u64::MAX as u128) as u64,
                                Ordering::Relaxed,
                            );
                        } else {
                            let future_topologies: Vec<&[u8]> = pending_layers
                                .iter()
                                .take(look_back)
                                .map(|future| future.topology.as_slice())
                                .collect();
                            let prior_topologies: Vec<&[u8]> = emitted_topologies
                                .iter()
                                .rev()
                                .take(look_back)
                                .map(|prior| prior.as_slice())
                                .collect();
                            // Take ownership of backward priors before moving `layer` into process_pending_layer_post.
                            let backward_prior_owned =
                                std::mem::take(&mut layer.backward_prior_topologies);
                            let backward_prior_slices: Vec<&[u8]> =
                                backward_prior_owned.iter().map(|v| v.as_slice()).collect();
                            let future_bounds: Vec<TopologyBounds> = pending_layers
                                .iter()
                                .take(look_back)
                                .map(|future| future.topology_bounds)
                                .collect();
                            let futures_have_topology = pending_layers
                                .iter()
                                .take(look_back)
                                .any(|future| future.topology_non_empty);
                            let workspace = workspace.get_or_insert_with(|| {
                                z_blend::ZBlendWorkspace::new(width, height)
                            });
                            let cross_blend_ws = cross_blend_ws.get_or_insert_with(|| {
                                cross_blend::CrossBlendWorkspace::new(width, height)
                            });
                            let processed = process_pending_layer_post(
                                layer,
                                &prior_topologies,
                                &backward_prior_slices,
                                &future_topologies,
                                &future_bounds,
                                futures_have_topology,
                                width,
                                height,
                                fade_px,
                                blur_radius,
                                min_aa_alpha_u8,
                                z_blend_min_alpha_u8,
                                has_custom_lut,
                                debug_color_overlay,
                                &lut,
                                workspace,
                                cross_blend_cfg.as_ref(),
                                cross_blend_ws,
                            );
                            forward_to_encode(
                                processed,
                                &mut emitted_topologies,
                                &mut topology_reuse_pool,
                                cross_blend_cfg.is_some(),
                                look_back,
                                &encode_tx,
                                &z_blend_backward_ns,
                                &z_blend_forward_ns,
                                &cross_blend_ns,
                                &cross_blend_touched_pixels,
                                &cross_blend_contributing_layers,
                                &post_blur_ns,
                                &support_merge_ns,
                                forwarded_layers.as_ref(),
                            )?;
                        }
                    }

                    Ok(())
                })();
                callback_total_ns.fetch_add(
                    callback_t0.elapsed().as_nanos().min(u64::MAX as u128) as u64,
                    Ordering::Relaxed,
                );
                result?;

                // ── Periodic queue-depth diagnostic (every 2 s) ────────────────────
                // Shows internal pump buffer depths so we can catch startup spikes
                // where post_done_reorder or pending_layers grow unexpectedly large.
                if pump_diag_last.elapsed() >= std::time::Duration::from_secs(2) {
                    let in_flight = post_next_send_seq.wrapping_sub(post_next_emit_seq);
                    let reorder_depth = post_done_reorder.len();
                    let pending_depth = pending_layers.len();
                    let emitted_depth = emitted_topologies.len();
                    let forwarded = forwarded_layers.load(Ordering::Relaxed);
                    // Estimate bytes held per slot: each PendingLayer has a full mask;
                    // each reorder slot holds a processed mask + possible contrib.
                    let pending_mb = (pending_depth * pixels_per_layer) as f64 / 1_048_576.0;
                    let reorder_mb = (reorder_depth * pixels_per_layer * 2) as f64 / 1_048_576.0;
                    eprintln!(
                        "[3DAA pump]  layer={layer_index} fwd={forwarded} | \
                         pending={pending_depth} ({pending_mb:.0}MB) | \
                         reorder={reorder_depth} ({reorder_mb:.0}MB) in-flight={in_flight} | \
                         emitted={emitted_depth}",
                    );
                    pump_diag_last = std::time::Instant::now();
                }
            }

            // ── Tail flush ─────────────────────────────────────────────────────────
            // raw_pump_rx has closed (rasterizer finished); flush any layers still
            // in the pending queue with a shrinking future window.
            while let Some(mut layer) = pending_layers.pop_front() {
                if !post_worker_txs.is_empty() {
                    let prior_topologies: Vec<Arc<Vec<u8>>> = emitted_topologies
                        .iter()
                        .rev()
                        .take(look_back)
                        .map(Arc::clone)
                        .collect();
                    let future_topologies: Vec<Arc<Vec<u8>>> = pending_layers
                        .iter()
                        .take(look_back)
                        .map(|future| Arc::clone(&future.topology))
                        .collect();
                    let future_bounds: Vec<TopologyBounds> = pending_layers
                        .iter()
                        .take(look_back)
                        .map(|future| future.topology_bounds)
                        .collect();
                    let futures_have_topology = pending_layers
                        .iter()
                        .take(look_back)
                        .any(|future| future.topology_non_empty);

                    let worker_idx = post_rr_index % post_worker_txs.len();
                    post_rr_index = post_rr_index.wrapping_add(1);
                    let seq = post_next_send_seq;
                    post_next_send_seq = post_next_send_seq.wrapping_add(1);
                    let backward_prior_topologies =
                        std::mem::take(&mut layer.backward_prior_topologies);

                    post_worker_txs[worker_idx]
                        .send(PostWorkerTask {
                            seq,
                            layer,
                            backward_prior_topologies,
                            prior_topologies,
                            future_topologies,
                            future_bounds,
                            futures_have_topology,
                            cross_blend_cfg,
                        })
                        .map_err(|_| {
                            SlicerV3Error::LayerPreview(
                        "3DAA post worker task channel unexpectedly closed during tail flush"
                            .to_string(),
                    )
                        })?;

                    // Drain completed layers between tail-flush sends.  Without this, the
                    // done channel (capacity = worker_depth = 1) fills up while the main
                    // thread is still sending tasks, causing a deadlock: the worker blocks
                    // on done_tx.send() while the main thread blocks on task_tx.send().
                    // This was masked before because the main thread's backward EDT was
                    // slow enough to keep the done channel drained via timing alone.
                    if let Some(rx) = post_worker_rx.as_ref() {
                        while let Ok(done) = rx.try_recv() {
                            post_done_reorder.insert(done.seq, done);
                            while let Some(next_done) =
                                post_done_reorder.remove(&post_next_emit_seq)
                            {
                                forward_to_encode(
                                    next_done,
                                    &mut emitted_topologies,
                                    &mut topology_reuse_pool,
                                    cross_blend_cfg.is_some(),
                                    look_back,
                                    &encode_tx,
                                    &z_blend_backward_ns,
                                    &z_blend_forward_ns,
                                    &cross_blend_ns,
                                    &cross_blend_touched_pixels,
                                    &cross_blend_contributing_layers,
                                    &post_blur_ns,
                                    &support_merge_ns,
                                    forwarded_layers.as_ref(),
                                )?;
                                post_next_emit_seq = post_next_emit_seq.wrapping_add(1);
                            }
                        }
                    }
                } else {
                    let future_topologies: Vec<&[u8]> = pending_layers
                        .iter()
                        .take(look_back)
                        .map(|future| future.topology.as_slice())
                        .collect();
                    let prior_topologies: Vec<&[u8]> = emitted_topologies
                        .iter()
                        .rev()
                        .take(look_back)
                        .map(|prior| prior.as_slice())
                        .collect();
                    // Take ownership of backward priors before moving `layer` into process_pending_layer_post.
                    let backward_prior_owned = std::mem::take(&mut layer.backward_prior_topologies);
                    let backward_prior_slices: Vec<&[u8]> =
                        backward_prior_owned.iter().map(|v| v.as_slice()).collect();
                    let future_bounds: Vec<TopologyBounds> = pending_layers
                        .iter()
                        .take(look_back)
                        .map(|future| future.topology_bounds)
                        .collect();
                    let futures_have_topology = pending_layers
                        .iter()
                        .take(look_back)
                        .any(|future| future.topology_non_empty);
                    let workspace = workspace
                        .get_or_insert_with(|| z_blend::ZBlendWorkspace::new(width, height));
                    let cross_blend_ws = cross_blend_ws.get_or_insert_with(|| {
                        cross_blend::CrossBlendWorkspace::new(width, height)
                    });
                    let processed = process_pending_layer_post(
                        layer,
                        &prior_topologies,
                        &backward_prior_slices,
                        &future_topologies,
                        &future_bounds,
                        futures_have_topology,
                        width,
                        height,
                        fade_px,
                        blur_radius,
                        min_aa_alpha_u8,
                        z_blend_min_alpha_u8,
                        has_custom_lut,
                        debug_color_overlay,
                        &lut,
                        workspace,
                        cross_blend_cfg.as_ref(),
                        cross_blend_ws,
                    );
                    forward_to_encode(
                        processed,
                        &mut emitted_topologies,
                        &mut topology_reuse_pool,
                        cross_blend_cfg.is_some(),
                        look_back,
                        &encode_tx,
                        &z_blend_backward_ns,
                        &z_blend_forward_ns,
                        &cross_blend_ns,
                        &cross_blend_touched_pixels,
                        &cross_blend_contributing_layers,
                        &post_blur_ns,
                        &support_merge_ns,
                        forwarded_layers.as_ref(),
                    )?;
                }
            }

            if !post_worker_txs.is_empty() {
                post_worker_txs.clear();
            }
            if let Some(rx) = post_worker_rx.take() {
                while let Ok(done) = rx.recv() {
                    post_done_reorder.insert(done.seq, done);
                    while let Some(next_done) = post_done_reorder.remove(&post_next_emit_seq) {
                        forward_to_encode(
                            next_done,
                            &mut emitted_topologies,
                            &mut topology_reuse_pool,
                            cross_blend_cfg.is_some(),
                            look_back,
                            &encode_tx,
                            &z_blend_backward_ns,
                            &z_blend_forward_ns,
                            &cross_blend_ns,
                            &cross_blend_touched_pixels,
                            &cross_blend_contributing_layers,
                            &post_blur_ns,
                            &support_merge_ns,
                            forwarded_layers.as_ref(),
                        )?;
                        post_next_emit_seq = post_next_emit_seq.wrapping_add(1);
                    }
                }
            }

            // Signal the encode thread that all layers have been forwarded.
            drop(encode_tx);

            Ok(PumpStats {
                z_blend_backward_ns: z_blend_backward_ns.load(Ordering::Relaxed),
                z_blend_forward_ns: z_blend_forward_ns.load(Ordering::Relaxed),
                cross_blend_ns: cross_blend_ns.load(Ordering::Relaxed),
                cross_blend_touched_pixels: cross_blend_touched_pixels.load(Ordering::Relaxed),
                cross_blend_contributing_layers: cross_blend_contributing_layers
                    .load(Ordering::Relaxed),
                post_blur_ns: post_blur_ns.load(Ordering::Relaxed),
                support_merge_ns: support_merge_ns.load(Ordering::Relaxed),
                callback_sweep_ns: callback_sweep_ns.load(Ordering::Relaxed),
                callback_drain_ns: callback_drain_ns.load(Ordering::Relaxed),
                callback_total_ns: callback_total_ns.load(Ordering::Relaxed),
            })
        })
        .map_err(|e| {
            SlicerV3Error::LayerPreview(format!("failed to spawn 3DAA pump thread: {e}"))
        })?;

    // Trivial raster callback: hands the raw mask to the pump thread and
    // returns immediately.  All 3DAA processing overlaps with rasterization.
    let rasterize_result = {
        let mut on_raw_mask_layer = move |layer_index: u32,
                                          raw_mask: Vec<u8>,
                                          raster_stats: LayerAreaStatsV3|
              -> Result<(), SlicerV3Error> {
            raw_pump_tx
                .send((layer_index, raw_mask, raster_stats))
                .map_err(|_| {
                    SlicerV3Error::LayerPreview("3DAA pump channel closed unexpectedly".to_string())
                })
        };
        slice_and_rasterize_v3_owned(
            raster_job,
            raster_triangles_xyz,
            requires_area_stats,
            false,
            false,
            Some(&mut on_raw_mask_layer),
            on_progress,
            cancel_flag,
        )
        // raw_pump_tx is dropped here (moved into on_raw_mask_layer), closing
        // the channel and signalling the pump thread to begin the tail flush.
    };

    // Always join the pump thread even on rasterizer error, to prevent it from
    // running indefinitely and to ensure encode_tx is dropped before we try to
    // join the encode thread via encode_handle_guard.
    let pump_result = pump_thread
        .join()
        .map_err(|_| SlicerV3Error::LayerPreview("3DAA pump thread panicked".to_string()))?;
    let (_rendered, layer_area_stats, mut perf) = rasterize_result?;
    let pump_stats = pump_result?;

    // Pump thread already dropped encode_tx; join the encode thread to recover
    // png_layers / raw_mask_layers and propagate any encoding errors.
    let (png_layers, raw_mask_layers) = encode_handle_guard.finish()?;

    perf.z_blend_backward_ns = pump_stats.z_blend_backward_ns;
    perf.z_blend_forward_ns = pump_stats.z_blend_forward_ns;
    perf.cross_blend_ns = pump_stats.cross_blend_ns;
    perf.cross_blend_touched_pixels = pump_stats.cross_blend_touched_pixels;
    perf.cross_blend_contributing_layers = pump_stats.cross_blend_contributing_layers;
    perf.post_blur_ns = pump_stats.post_blur_ns;
    perf.support_merge_ns = pump_stats.support_merge_ns;
    perf.daa_post_threads = post_worker_count as u32;
    perf.daa_post_buffer_depth = post_buffer_depth as u32;

    // ── 3DAA pipeline diagnostics (completion) ─────────────────────────────────
    {
        let elapsed_s = pipeline_wall_start.elapsed().as_secs_f64();
        let n = job.total_layers.max(1) as f64;
        let workers = perf.daa_post_threads.max(1) as f64;
        let ms = |ns: u64| ns as f64 / 1_000_000.0;
        let backward_ms = ms(perf.z_blend_backward_ns);
        let forward_ms = ms(perf.z_blend_forward_ns);
        let blur_ms = ms(perf.post_blur_ns);
        let support_ms = ms(perf.support_merge_ns);
        let raster_ms = ms(perf.render_ns);
        let wall_ms = elapsed_s * 1000.0;
        let wall_per_layer = wall_ms / n;
        // EDT CPU time accumulated across all workers (sum, not wall).
        // Divide by workers to estimate per-layer wall-equivalent EDT time.
        let edt_cpu_per_layer = (backward_ms + forward_ms) / n;
        let edt_wall_per_layer = edt_cpu_per_layer / workers;
        let sched_overhead = wall_per_layer - edt_wall_per_layer - blur_ms / n - support_ms / n;
        eprintln!(
            "[3DAA] done {:.2}s | {:.1} l/s | {:.1}ms/layer (wall)",
            elapsed_s,
            n / elapsed_s,
            wall_per_layer,
        );
        eprintln!(
            "[3DAA]   cpu/layer → backward={:.1}ms fwd={:.1}ms blur={:.1}ms support={:.1}ms",
            backward_ms / n,
            forward_ms / n,
            blur_ms / n,
            support_ms / n,
        );
        eprintln!(
            "[3DAA]   workers={} | EDT wall≈{:.1}ms/layer | EDT cpu-util={:.0}% | \
             scheduling+raster overhead≈{:.1}ms/layer",
            workers as u32,
            edt_wall_per_layer,
            edt_wall_per_layer / wall_per_layer * 100.0,
            sched_overhead.max(0.0),
        );
        eprintln!(
            "[3DAA]   raster/layer → cpu={:.1}ms render-wall={:.1}ms avg-parallelism≈{:.1}×",
            raster_ms / n,
            ms(perf.render_wall_ns) / n,
            raster_ms / ms(perf.render_wall_ns).max(1e-9),
        );
        let sweep_ms = ms(pump_stats.callback_sweep_ns);
        let drain_ms = ms(pump_stats.callback_drain_ns);
        eprintln!(
            "[3DAA]   callback/layer → topo-sweep={:.1}ms fwd-to-enc={:.1}ms other={:.1}ms",
            sweep_ms / n,
            drain_ms / n,
            (sched_overhead - sweep_ms / n - drain_ms / n).max(0.0),
        );
        let pump_ms_per_layer = ms(pump_stats.callback_total_ns) / n;
        eprintln!(
            "[3DAA]   pump/layer ≈ {:.1}ms (3DAA pump thread; overlaps with raster)",
            pump_ms_per_layer,
        );
        let ws_actual_max_mb = workspace_max_bytes.load(Ordering::Relaxed) as f64 / 1_000_000.0;
        if ws_actual_max_mb > 0.0 {
            eprintln!(
                "[3DAA]   ws_actual_max≈{:.0}MB/worker (ROI-local, vs. worst-case ceiling)",
                ws_actual_max_mb,
            );
        }
    }
    // ──────────────────────────────────────────────────────────────────────────

    Ok((
        RenderedLayersV3 {
            png_layers,
            raw_mask_layers,
        },
        layer_area_stats,
        perf,
    ))
}

/// Clean-room V3 entry point with full pipeline:
/// parse triangles -> build layer index -> bounded parallel render -> zip archive encode.
pub fn slice_with_progress_v3(
    job: &SliceJobV3,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SliceArtifactV3, SlicerV3Error> {
    let Some(encoder) = find_encoder(&job.output_format) else {
        return Err(SlicerV3Error::UnsupportedOutput(format!(
            "{} (supported: {})",
            job.output_format,
            supported_output_formats().join(", ")
        )));
    };
    let requires_area_stats = encoder.requires_area_stats();
    let requires_png_layers = encoder.requires_png_layers();
    let requires_raw_mask_layers = encoder.requires_raw_mask_layers();

    let is_3daa = is_vertical_aa_mode(&job.anti_aliasing_mode);

    // Pre-compute Coverage raster job for Vertical2. Doing this before the RLE
    // guard means the streaming path can reuse it without duplication.
    //
    // 3DAA owns the antialiasing in the post-process (EDT + ROI blur).  Keep
    // the internal raster pass binary; otherwise a 4x/8x Coverage pre-pass pays
    // supersampling cost on every layer and then gets processed again by 3DAA.
    let raster_job_owned: Option<SliceJobV3> = if is_3daa {
        let mut j = job.clone();
        j.anti_aliasing_level = "Off".to_string();
        j.anti_aliasing_mode = "Coverage".to_string();
        j.blur_brush_radius_px = 0;
        j.minimum_aa_alpha_percent = 0.0;
        // Don't keep a redundant copy of triangles_xyz in the clone — it can be
        // several GB for dense 12K jobs.  We pass job.triangles_xyz separately
        // to rasterize_vertical_aa_streaming_v3, which frees it right after
        // parse_triangles (i.e., before the multi-minute render loop).
        j.triangles_xyz = Vec::new();
        Some(j)
    } else {
        None
    };
    let raster_job: &SliceJobV3 = raster_job_owned.as_ref().unwrap_or(job);

    // RLE streaming path — no full-image pixel buffer.
    // Vertical2/3DAA can also stream to RLE by z-blending each layer
    // individually and encoding the result before moving on.
    if !requires_png_layers {
        if let Some(mut rle_enc) = encoder.create_rle_stream_encoder(job)? {
            let total_start = std::time::Instant::now();
            let job_total_layers = job.total_layers;
            let progress_total = job_total_layers.saturating_add(1);

            let slicing_progress = on_progress.as_ref().map(|cb| {
                let cb = cb.clone();
                Arc::new(move |update: SliceProgressUpdateV3| {
                    cb(SliceProgressUpdateV3 {
                        done: update.done.min(job_total_layers),
                        total: progress_total,
                        phase: SliceProgressPhaseV3::Slicing,
                    });
                }) as ProgressCallbackV3
            });

            // Parallel-encode path: rasterize + encode PNG in rayon workers.
            let (_rendered_layers, layer_area_stats, mut perf) = if is_3daa {
                // Vertical2 streaming: z-blend + XY blur per layer, then
                // immediately encode to RLE.  This avoids materializing all
                // layers in memory simultaneously.
                let width = raster_job.effective_render_width_px() as usize;
                let height = raster_job.source_height_px as usize;
                let mut on_mask = |idx: u32,
                                   mask: Vec<u8>,
                                   bounds: TopologyBounds|
                 -> Result<(), SlicerV3Error> {
                    let runs = encode_mask_to_rle_in_bounds(&mask, width, height, bounds);
                    let res = rle_enc.consume_rle_layer(idx, runs);
                    crate::pipeline::return_mask_to_pool(mask);
                    res
                };
                rasterize_vertical_aa_streaming_v3(
                    job,
                    raster_job,
                    job.triangles_xyz.clone(),
                    requires_area_stats,
                    false,
                    false,
                    Some(
                        &mut on_mask
                            as &mut dyn FnMut(
                                u32,
                                Vec<u8>,
                                TopologyBounds,
                            )
                                -> Result<(), SlicerV3Error>,
                    ),
                    slicing_progress,
                    cancel_flag,
                )?
            } else if let Some(encode_fn) = rle_enc.parallel_encode_fn() {
                let mut store_sink = |idx: u32, bytes: Vec<u8>| -> Result<(), SlicerV3Error> {
                    rle_enc.store_encoded_layer(idx, bytes);
                    Ok(())
                };
                slice_and_rasterize_rle_encoded_v3(
                    job,
                    requires_area_stats,
                    encode_fn,
                    &mut store_sink,
                    slicing_progress,
                    cancel_flag,
                )?
            } else {
                let mut rle_sink =
                    |idx: u32, runs: Vec<crate::rle::RleRun>| rle_enc.consume_rle_layer(idx, runs);
                slice_and_rasterize_rle_v3(
                    job,
                    requires_area_stats,
                    &mut rle_sink,
                    slicing_progress,
                    cancel_flag,
                )?
            };

            rle_enc.set_area_stats(layer_area_stats);

            if let Some(cb) = on_progress.as_ref() {
                cb(SliceProgressUpdateV3 {
                    done: job_total_layers,
                    total: progress_total,
                    phase: SliceProgressPhaseV3::Finalizing,
                });
            }

            let encode_start = std::time::Instant::now();
            let bytes = rle_enc.finalize_to_bytes()?;

            if let Some(cb) = on_progress.as_ref() {
                cb(SliceProgressUpdateV3 {
                    done: progress_total,
                    total: progress_total,
                    phase: SliceProgressPhaseV3::Finalizing,
                });
            }

            perf.archive_encode_ns = encode_start.elapsed().as_nanos() as u64;
            perf.total_ns = total_start.elapsed().as_nanos() as u64;
            perf.layers = job.total_layers;

            return Ok(SliceArtifactV3 { bytes, perf });
        }
    }

    if !is_3daa && !requires_png_layers && requires_raw_mask_layers {
        if let Some(mut stream_encoder) = encoder.create_raw_mask_stream_encoder(job)? {
            let total_start = std::time::Instant::now();
            let job_total_layers = job.total_layers;
            let progress_total = job_total_layers.saturating_add(1);
            let mut raw_mask_sink =
                |layer_index: u32, raw_mask: Vec<u8>, _stats: LayerAreaStatsV3| {
                    stream_encoder.consume_raw_mask_layer(layer_index, raw_mask)
                };

            let slicing_progress = on_progress.as_ref().map(|cb| {
                let cb = cb.clone();
                Arc::new(move |update: SliceProgressUpdateV3| {
                    cb(SliceProgressUpdateV3 {
                        done: update.done.min(job_total_layers),
                        total: progress_total,
                        phase: SliceProgressPhaseV3::Slicing,
                    });
                }) as ProgressCallbackV3
            });

            let (_rendered_layers, _layer_area_stats, mut perf) = slice_and_rasterize_v3(
                job,
                false,
                requires_png_layers,
                false,
                Some(&mut raw_mask_sink),
                slicing_progress,
                cancel_flag,
            )?;

            if let Some(cb) = on_progress.as_ref() {
                cb(SliceProgressUpdateV3 {
                    done: job_total_layers,
                    total: progress_total,
                    phase: SliceProgressPhaseV3::Finalizing,
                });
            }

            let encode_start = std::time::Instant::now();
            let bytes = stream_encoder.finalize_to_bytes()?;

            if let Some(cb) = on_progress.as_ref() {
                cb(SliceProgressUpdateV3 {
                    done: progress_total,
                    total: progress_total,
                    phase: SliceProgressPhaseV3::Finalizing,
                });
            }

            perf.archive_encode_ns = encode_start.elapsed().as_nanos() as u64;
            perf.total_ns = total_start.elapsed().as_nanos() as u64;
            perf.layers = job.total_layers;

            return Ok(SliceArtifactV3 { bytes, perf });
        }
    }

    let total_start = std::time::Instant::now();

    // raster_job_owned / raster_job were computed before the RLE guard above.
    let (rendered_layers, layer_area_stats, mut perf) = if is_3daa {
        rasterize_vertical_aa_streaming_v3(
            job,
            raster_job,
            job.triangles_xyz.clone(),
            requires_area_stats,
            requires_png_layers,
            requires_raw_mask_layers,
            None, // on_processed_mask — full-buffer path collects into rendered_layers
            on_progress.clone(),
            cancel_flag,
        )?
    } else {
        slice_and_rasterize_v3(
            raster_job,
            requires_area_stats,
            requires_png_layers,
            requires_raw_mask_layers,
            None,
            on_progress.clone(),
            cancel_flag,
        )?
    };

    let encode_units = encoder
        .estimate_encode_progress_units(&rendered_layers)
        .max(1);
    let progress_total = job.total_layers.saturating_add(encode_units);

    let encode_progress = on_progress.as_ref().map(|cb| {
        let cb = cb.clone();
        move |done: u32, total: u32| {
            let safe_total = total.max(1);
            let clamped_done = done.min(safe_total);
            let normalized =
                ((clamped_done as u64) * (encode_units as u64) / (safe_total as u64)) as u32;
            cb(SliceProgressUpdateV3 {
                done: job.total_layers.saturating_add(normalized),
                total: progress_total,
                phase: SliceProgressPhaseV3::Encoding,
            });
        }
    });

    let encode_start = std::time::Instant::now();
    let bytes = dispatch_encode_by_format(
        job,
        &rendered_layers,
        &layer_area_stats,
        encode_progress.as_ref().map(|cb| cb as &dyn Fn(u32, u32)),
    )?;

    if let Some(cb) = on_progress.as_ref() {
        cb(SliceProgressUpdateV3 {
            done: progress_total,
            total: progress_total,
            phase: SliceProgressPhaseV3::Finalizing,
        });
    }

    perf.archive_encode_ns = encode_start.elapsed().as_nanos() as u64;
    perf.total_ns = total_start.elapsed().as_nanos() as u64;
    perf.layers = job.total_layers;

    Ok(SliceArtifactV3 { bytes, perf })
}

/// Fast raster stage that produces RLE runs per layer — no pixel buffers.
pub fn slice_and_rasterize_rle_v3(
    job: &SliceJobV3,
    compute_area_stats: bool,
    mut on_rle_layer: impl FnMut(u32, Vec<crate::rle::RleRun>) -> Result<(), SlicerV3Error>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    validate_job(job)?;

    // 3DAA modes run their own vertical pipeline — no SSAA here.
    let ssaa_factor = if is_vertical_aa_mode(&job.anti_aliasing_mode) {
        1usize
    } else {
        (job.configured_xy_aa_steps() as usize).max(1)
    };
    let blur_radius = if job.anti_aliasing_mode_is_blur() && job.blur_brush_radius_px > 0 {
        job.blur_brush_radius_px.max(1) as usize
    } else {
        0
    };
    let min_alpha_u8 =
        ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;

    // Build the job that drives the rasterizer.  When SSAA is active we scale
    // the pixel dimensions up by `ssaa_factor` and force the rasterizer into
    // binary mode (AA settings cleared), so the ultra-fast streaming binary RLE
    // engine is used unchanged.  Triangles are NOT copied here — they're parsed
    // from the original `job` below and then projected at the (potentially
    // super-resolved) raster dimensions.
    let raster_job_owned: Option<SliceJobV3> = if ssaa_factor > 1 || blur_radius > 0 {
        let mut j = job.clone();
        j.triangles_xyz = Vec::new(); // avoid copying potentially-GB mesh data
        j.anti_aliasing_level = "Off".to_string();
        j.anti_aliasing_mode = "Coverage".to_string();
        j.blur_brush_radius_px = 0;
        j.minimum_aa_alpha_percent = 0.0;
        if ssaa_factor > 1 {
            j.source_width_px = job.source_width_px.saturating_mul(ssaa_factor as u32);
            j.source_height_px = job.source_height_px.saturating_mul(ssaa_factor as u32);
            j.width_px = job.width_px.saturating_mul(ssaa_factor as u32);
            j.height_px = job.height_px.saturating_mul(ssaa_factor as u32);
        }
        Some(j)
    } else {
        None
    };
    let raster_job = raster_job_owned.as_ref().unwrap_or(job);

    let mut triangles = parse_triangles(&job.triangles_xyz);
    project_triangles_inplace(&mut triangles, raster_job);
    let index_start = std::time::Instant::now();
    let layer_index = build_layer_index(
        &triangles,
        raster_job.total_layers,
        raster_job.layer_height_mm,
    );
    let index_ns = index_start.elapsed().as_nanos() as u64;

    let super_width = raster_job.effective_render_width_px() as usize;
    let super_height = raster_job.source_height_px as usize;
    let out_width = job.effective_render_width_px() as usize;
    let out_height = job.source_height_px as usize;

    // Wrap on_rle_layer to downsample (if ssaa_factor > 1) and/or blur before
    // forwarding.  When neither applies the closure is a thin pass-through.
    let mut wrapped_on_rle = |layer_idx: u32, raster_runs: Vec<crate::rle::RleRun>| {
        let gray_runs = if ssaa_factor > 1 {
            downsample_binary_rle_to_gray_rle(
                &raster_runs,
                super_width,
                super_height,
                ssaa_factor,
                min_alpha_u8,
            )
        } else {
            raster_runs
        };

        let final_runs = if blur_radius > 0 {
            // Streaming separable box blur: O((2r+1)×width) memory, no full-image allocation.
            blur_gray_rle_streaming(&gray_runs, out_width, out_height, blur_radius, min_alpha_u8)
        } else {
            gray_runs
        };

        on_rle_layer(layer_idx, final_runs)
    };

    let (rendered_layers, layer_area_stats, mut perf) = render_layers_rle(
        raster_job,
        &triangles,
        &layer_index,
        compute_area_stats,
        &mut wrapped_on_rle,
        on_progress,
        cancel_flag,
    )?;
    perf.index_build_ns = index_ns;

    Ok((rendered_layers, layer_area_stats, perf))
}

/// Fast raster stage that encodes RLE runs into layer bytes in parallel rayon workers.
pub fn slice_and_rasterize_rle_encoded_v3(
    job: &SliceJobV3,
    compute_area_stats: bool,
    encode_fn: Arc<
        dyn Fn(u32, &[crate::rle::RleRun]) -> Result<Vec<u8>, SlicerV3Error> + Send + Sync,
    >,
    on_encoded_layer: impl FnMut(u32, Vec<u8>) -> Result<(), SlicerV3Error>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    validate_job(job)?;

    // 3DAA modes run their own vertical pipeline — no SSAA here.
    let ssaa_factor = if is_vertical_aa_mode(&job.anti_aliasing_mode) {
        1usize
    } else {
        (job.configured_xy_aa_steps() as usize).max(1)
    };
    let blur_radius = if job.anti_aliasing_mode_is_blur() && job.blur_brush_radius_px > 0 {
        job.blur_brush_radius_px.max(1) as usize
    } else {
        0
    };
    let min_alpha_u8 =
        ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;

    // Build super-resolution raster job when SSAA or blur is active.
    let raster_job_owned: Option<SliceJobV3> = if ssaa_factor > 1 || blur_radius > 0 {
        let mut j = job.clone();
        j.triangles_xyz = Vec::new();
        j.anti_aliasing_level = "Off".to_string();
        j.anti_aliasing_mode = "Coverage".to_string();
        j.blur_brush_radius_px = 0;
        j.minimum_aa_alpha_percent = 0.0;
        if ssaa_factor > 1 {
            j.source_width_px = job.source_width_px.saturating_mul(ssaa_factor as u32);
            j.source_height_px = job.source_height_px.saturating_mul(ssaa_factor as u32);
            j.width_px = job.width_px.saturating_mul(ssaa_factor as u32);
            j.height_px = job.height_px.saturating_mul(ssaa_factor as u32);
        }
        Some(j)
    } else {
        None
    };
    let raster_job = raster_job_owned.as_ref().unwrap_or(job);

    let mut triangles = parse_triangles(&job.triangles_xyz);
    project_triangles_inplace(&mut triangles, raster_job);
    let index_start = std::time::Instant::now();
    let layer_index = build_layer_index(
        &triangles,
        raster_job.total_layers,
        raster_job.layer_height_mm,
    );
    let index_ns = index_start.elapsed().as_nanos() as u64;

    // When SSAA or blur is active, wrap encode_fn to downsample + blur the
    // super-resolution binary RLE before forwarding to the encoder.  The Arc
    // clone is cheap (reference count bump); the heavy work happens per-layer
    // inside the rayon worker pool.
    let effective_encode_fn: Arc<
        dyn Fn(u32, &[crate::rle::RleRun]) -> Result<Vec<u8>, SlicerV3Error> + Send + Sync,
    > = if ssaa_factor > 1 || blur_radius > 0 {
        let super_width = raster_job.effective_render_width_px() as usize;
        let super_height = raster_job.source_height_px as usize;
        let out_width = job.effective_render_width_px() as usize;
        let out_height = job.source_height_px as usize;
        let inner = encode_fn.clone();
        Arc::new(move |layer_idx: u32, super_runs: &[crate::rle::RleRun]| {
            let gray_runs = if ssaa_factor > 1 {
                downsample_binary_rle_to_gray_rle(
                    super_runs,
                    super_width,
                    super_height,
                    ssaa_factor,
                    min_alpha_u8,
                )
            } else {
                super_runs.to_vec()
            };

            let final_runs = if blur_radius > 0 {
                // Streaming separable box blur: O((2r+1)×width) memory, no full-image allocation.
                blur_gray_rle_streaming(
                    &gray_runs,
                    out_width,
                    out_height,
                    blur_radius,
                    min_alpha_u8,
                )
            } else {
                gray_runs
            };

            inner(layer_idx, &final_runs)
        })
    } else {
        encode_fn
    };

    let (rendered_layers, layer_area_stats, mut perf) = render_layers_rle_encoded(
        raster_job,
        &triangles,
        &layer_index,
        compute_area_stats,
        effective_encode_fn,
        on_encoded_layer,
        on_progress,
        cancel_flag,
    )?;
    perf.index_build_ns = index_ns;

    Ok((rendered_layers, layer_area_stats, perf))
}

/// Format-agnostic geometry/index/raster stage that outputs layer PNG bytes.
/// Internal variant that takes `triangles_xyz` by value so the raw float data
/// can be freed as soon as `parse_triangles` finishes — before the potentially
/// multi-minute `render_layers_bounded` call.  This avoids keeping a full clone
/// of the raw mesh data alive for the entire slicing run (which can be several
/// GB for complex 12K jobs with dense support structures).
fn slice_and_rasterize_v3_owned(
    job: &SliceJobV3,
    triangles_xyz: Vec<f32>,
    requires_area_stats: bool,
    emit_png_layers: bool,
    emit_raw_mask_layers: bool,
    on_raw_mask_layer: Option<
        &mut dyn FnMut(u32, Vec<u8>, LayerAreaStatsV3) -> Result<(), SlicerV3Error>,
    >,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    let mut triangles = parse_triangles(&triangles_xyz);
    let tri_count = triangles.len();
    let xyz_mb = (triangles_xyz.len() * std::mem::size_of::<f32>()) as f64 / 1_048_576.0;
    project_triangles_inplace(&mut triangles, job);
    let index_start = std::time::Instant::now();
    let layer_index = build_layer_index(&triangles, job.total_layers, job.layer_height_mm);
    let index_ns = index_start.elapsed().as_nanos() as u64;
    let tri_mb =
        (tri_count * std::mem::size_of::<crate::geometry::Triangle>()) as f64 / 1_048_576.0;
    eprintln!(
        "[slicer] {} triangles | xyz freed={:.0}MB | tri-store={:.0}MB (held for render)",
        tri_count, xyz_mb, tri_mb,
    );
    // Drop the raw float data now — `triangles` (Vec<Triangle>) carries all the
    // geometry needed by the rasterizer.  This can free several GB for large jobs.
    drop(triangles_xyz);

    let (rendered_layers, layer_area_stats, mut perf) = render_layers_bounded(
        job,
        &triangles,
        &layer_index,
        requires_area_stats,
        emit_png_layers,
        emit_raw_mask_layers,
        on_raw_mask_layer,
        on_progress,
        cancel_flag,
    )?;
    perf.index_build_ns = index_ns;

    Ok((rendered_layers, layer_area_stats, perf))
}

pub fn slice_and_rasterize_v3(
    job: &SliceJobV3,
    requires_area_stats: bool,
    emit_png_layers: bool,
    emit_raw_mask_layers: bool,
    on_raw_mask_layer: Option<
        &mut dyn FnMut(u32, Vec<u8>, LayerAreaStatsV3) -> Result<(), SlicerV3Error>,
    >,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    validate_job(job)?;
    slice_and_rasterize_v3_owned(
        job,
        job.triangles_xyz.clone(),
        requires_area_stats,
        emit_png_layers,
        emit_raw_mask_layers,
        on_raw_mask_layer,
        on_progress,
        cancel_flag,
    )
}

/// Decode a single 1-based layer preview PNG from an encoded print artifact,
/// dispatching through the registered format plugin by hint or file extension.
pub fn read_layer_preview_png_by_format_hint(
    source_path: &Path,
    layer_number: u32,
    format_hint: &str,
) -> Result<Vec<u8>, SlicerV3Error> {
    let Some(encoder) = find_encoder_by_hint_or_source(format_hint, source_path) else {
        let requested = format_hint.trim();
        let requested_display = if requested.is_empty() {
            source_path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| format!(".{}", ext.trim_start_matches('.')))
                .unwrap_or_else(|| "(unknown)".to_string())
        } else {
            requested.to_string()
        };

        return Err(SlicerV3Error::UnsupportedOutput(format!(
            "{} (supported: {})",
            requested_display,
            supported_output_formats().join(", ")
        )));
    };

    encoder.read_layer_preview_png(source_path, layer_number)
}

/// Encode rendered layers through a registered format encoder.
pub fn dispatch_encode_by_format(
    job: &SliceJobV3,
    rendered_layers: &RenderedLayersV3,
    layer_area_stats: &[LayerAreaStatsV3],
    on_encode_progress: Option<&dyn Fn(u32, u32)>,
) -> Result<Vec<u8>, SlicerV3Error> {
    let Some(encoder) = find_encoder(&job.output_format) else {
        return Err(SlicerV3Error::UnsupportedOutput(format!(
            "{} (supported: {})",
            job.output_format,
            supported_output_formats().join(", ")
        )));
    };
    encoder.encode_container_from_rendered_layers_with_progress(
        job,
        rendered_layers,
        layer_area_stats,
        on_encode_progress,
    )
}

/// Encode rendered layers through a registered format encoder directly to disk.
pub fn dispatch_encode_by_format_to_path(
    job: &SliceJobV3,
    rendered_layers: &RenderedLayersV3,
    layer_area_stats: &[LayerAreaStatsV3],
    output_path: &Path,
    on_encode_progress: Option<&dyn Fn(u32, u32)>,
) -> Result<(), SlicerV3Error> {
    let Some(encoder) = find_encoder(&job.output_format) else {
        return Err(SlicerV3Error::UnsupportedOutput(format!(
            "{} (supported: {})",
            job.output_format,
            supported_output_formats().join(", ")
        )));
    };
    encoder.encode_container_to_path_with_progress(
        job,
        rendered_layers,
        layer_area_stats,
        output_path,
        on_encode_progress,
    )
}

/// Path-oriented entrypoint that writes final archive bytes directly to disk.
///
/// This avoids materializing the final encoded artifact in-memory at the call
/// boundary, reducing bridge and copy overhead in desktop/Tauri flows.
pub fn slice_with_progress_v3_to_path(
    job: &SliceJobV3,
    output_path: &Path,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SlicingPerfV3, SlicerV3Error> {
    let Some(encoder) = find_encoder(&job.output_format) else {
        return Err(SlicerV3Error::UnsupportedOutput(format!(
            "{} (supported: {})",
            job.output_format,
            supported_output_formats().join(", ")
        )));
    };
    let requires_area_stats = encoder.requires_area_stats();
    let requires_png_layers = encoder.requires_png_layers();
    let requires_raw_mask_layers = encoder.requires_raw_mask_layers();

    // 3DAA mode needs full raw masks for all layers so the EDT inter-layer
    // blend pass can run before final container encoding.
    let is_3daa = is_vertical_aa_mode(&job.anti_aliasing_mode);

    // Pre-compute Coverage raster job for Vertical2 (needed by both the
    // streaming RLE path and the full-buffer fallback path below).
    //
    // 3DAA owns the antialiasing in the post-process (EDT + ROI blur).  Keep
    // the internal raster pass binary; otherwise a 4x/8x Coverage pre-pass pays
    // supersampling cost on every layer and then gets processed again by 3DAA.
    let raster_job_owned: Option<SliceJobV3> = if is_3daa {
        let mut j = job.clone();
        j.anti_aliasing_level = "Off".to_string();
        j.anti_aliasing_mode = "Coverage".to_string();
        j.blur_brush_radius_px = 0;
        j.minimum_aa_alpha_percent = 0.0;
        // Don't keep a redundant copy of triangles_xyz in the clone — it can be
        // several GB for dense 12K jobs.  We pass job.triangles_xyz separately
        // to rasterize_vertical_aa_streaming_v3, which frees it right after
        // parse_triangles (i.e., before the multi-minute render loop).
        j.triangles_xyz = Vec::new();
        Some(j)
    } else {
        None
    };
    let raster_job: &SliceJobV3 = raster_job_owned.as_ref().unwrap_or(job);

    // RLE path: no full-image pixel buffer — fastest for formats like CTBv5.
    if !requires_png_layers {
        if let Some(mut rle_enc) = encoder.create_rle_stream_encoder(job)? {
            let total_start = std::time::Instant::now();
            let job_total_layers = job.total_layers;
            let progress_total = job_total_layers.saturating_add(1);

            let slicing_progress = on_progress.as_ref().map(|cb| {
                let cb = cb.clone();
                Arc::new(move |update: SliceProgressUpdateV3| {
                    cb(SliceProgressUpdateV3 {
                        done: update.done.min(job_total_layers),
                        total: progress_total,
                        phase: SliceProgressPhaseV3::Slicing,
                    });
                }) as ProgressCallbackV3
            });

            let (_rendered_layers, layer_area_stats, mut perf) = if is_3daa {
                // Vertical2 streaming: z-blend + XY blur per layer, then
                // immediately encode to RLE.
                let width = raster_job.effective_render_width_px() as usize;
                let height = raster_job.source_height_px as usize;
                let mut on_mask = |idx: u32,
                                   mask: Vec<u8>,
                                   bounds: TopologyBounds|
                 -> Result<(), SlicerV3Error> {
                    let runs = encode_mask_to_rle_in_bounds(&mask, width, height, bounds);
                    let res = rle_enc.consume_rle_layer(idx, runs);
                    crate::pipeline::return_mask_to_pool(mask);
                    res
                };
                rasterize_vertical_aa_streaming_v3(
                    job,
                    raster_job,
                    job.triangles_xyz.clone(),
                    requires_area_stats,
                    false,
                    false,
                    Some(
                        &mut on_mask
                            as &mut dyn FnMut(
                                u32,
                                Vec<u8>,
                                TopologyBounds,
                            )
                                -> Result<(), SlicerV3Error>,
                    ),
                    slicing_progress,
                    cancel_flag,
                )?
            } else if let Some(encode_fn) = rle_enc.parallel_encode_fn() {
                let mut store_sink = |idx: u32, bytes: Vec<u8>| -> Result<(), SlicerV3Error> {
                    rle_enc.store_encoded_layer(idx, bytes);
                    Ok(())
                };
                slice_and_rasterize_rle_encoded_v3(
                    job,
                    requires_area_stats,
                    encode_fn,
                    &mut store_sink,
                    slicing_progress,
                    cancel_flag,
                )?
            } else {
                let mut rle_sink =
                    |idx: u32, runs: Vec<crate::rle::RleRun>| rle_enc.consume_rle_layer(idx, runs);
                slice_and_rasterize_rle_v3(
                    job,
                    requires_area_stats,
                    &mut rle_sink,
                    slicing_progress,
                    cancel_flag,
                )?
            };

            rle_enc.set_area_stats(layer_area_stats);

            if let Some(cb) = on_progress.as_ref() {
                cb(SliceProgressUpdateV3 {
                    done: job_total_layers,
                    total: progress_total,
                    phase: SliceProgressPhaseV3::Finalizing,
                });
            }

            let encode_start = std::time::Instant::now();
            rle_enc.finalize_to_path(output_path)?;

            if let Some(cb) = on_progress.as_ref() {
                cb(SliceProgressUpdateV3 {
                    done: progress_total,
                    total: progress_total,
                    phase: SliceProgressPhaseV3::Finalizing,
                });
            }

            perf.archive_encode_ns = encode_start.elapsed().as_nanos() as u64;
            perf.total_ns = total_start.elapsed().as_nanos() as u64;
            perf.layers = job.total_layers;

            return Ok(perf);
        }
    }

    if !is_3daa && !requires_png_layers && requires_raw_mask_layers {
        if let Some(mut stream_encoder) = encoder.create_raw_mask_stream_encoder(job)? {
            let total_start = std::time::Instant::now();
            let job_total_layers = job.total_layers;
            let progress_total = job_total_layers.saturating_add(1);
            let mut raw_mask_sink =
                |layer_index: u32, raw_mask: Vec<u8>, _stats: LayerAreaStatsV3| {
                    stream_encoder.consume_raw_mask_layer(layer_index, raw_mask)
                };

            let slicing_progress = on_progress.as_ref().map(|cb| {
                let cb = cb.clone();
                Arc::new(move |update: SliceProgressUpdateV3| {
                    cb(SliceProgressUpdateV3 {
                        done: update.done.min(job_total_layers),
                        total: progress_total,
                        phase: SliceProgressPhaseV3::Slicing,
                    });
                }) as ProgressCallbackV3
            });

            let (_rendered_layers, _layer_area_stats, mut perf) = slice_and_rasterize_v3(
                job,
                false,
                requires_png_layers,
                false,
                Some(&mut raw_mask_sink),
                slicing_progress,
                cancel_flag,
            )?;

            if let Some(cb) = on_progress.as_ref() {
                cb(SliceProgressUpdateV3 {
                    done: job_total_layers,
                    total: progress_total,
                    phase: SliceProgressPhaseV3::Finalizing,
                });
            }

            let encode_start = std::time::Instant::now();
            stream_encoder.finalize_to_path(output_path)?;

            if let Some(cb) = on_progress.as_ref() {
                cb(SliceProgressUpdateV3 {
                    done: progress_total,
                    total: progress_total,
                    phase: SliceProgressPhaseV3::Finalizing,
                });
            }

            perf.archive_encode_ns = encode_start.elapsed().as_nanos() as u64;
            perf.total_ns = total_start.elapsed().as_nanos() as u64;
            perf.layers = job.total_layers;

            return Ok(perf);
        }
    }

    let total_start = std::time::Instant::now();

    // raster_job_owned / raster_job were computed before the RLE guard above.
    let (rendered_layers, layer_area_stats, mut perf) = if is_3daa {
        rasterize_vertical_aa_streaming_v3(
            job,
            raster_job,
            job.triangles_xyz.clone(),
            requires_area_stats,
            requires_png_layers,
            requires_raw_mask_layers,
            None, // on_processed_mask — full-buffer path collects into rendered_layers
            on_progress.clone(),
            cancel_flag,
        )?
    } else {
        slice_and_rasterize_v3(
            raster_job,
            requires_area_stats,
            requires_png_layers,
            requires_raw_mask_layers,
            None,
            on_progress.clone(),
            cancel_flag,
        )?
    };

    let encode_units = encoder
        .estimate_encode_progress_units(&rendered_layers)
        .max(1);
    let progress_total = job.total_layers.saturating_add(encode_units);

    let encode_progress = on_progress.as_ref().map(|cb| {
        let cb = cb.clone();
        move |done: u32, total: u32| {
            let safe_total = total.max(1);
            let clamped_done = done.min(safe_total);
            let normalized =
                ((clamped_done as u64) * (encode_units as u64) / (safe_total as u64)) as u32;
            cb(SliceProgressUpdateV3 {
                done: job.total_layers.saturating_add(normalized),
                total: progress_total,
                phase: SliceProgressPhaseV3::Encoding,
            });
        }
    });

    let encode_start = std::time::Instant::now();
    dispatch_encode_by_format_to_path(
        job,
        &rendered_layers,
        &layer_area_stats,
        output_path,
        encode_progress.as_ref().map(|cb| cb as &dyn Fn(u32, u32)),
    )?;

    if let Some(cb) = on_progress.as_ref() {
        cb(SliceProgressUpdateV3 {
            done: progress_total,
            total: progress_total,
            phase: SliceProgressPhaseV3::Finalizing,
        });
    }

    perf.archive_encode_ns = encode_start.elapsed().as_nanos() as u64;
    perf.total_ns = total_start.elapsed().as_nanos() as u64;
    perf.layers = job.total_layers;

    Ok(perf)
}

impl From<zip::result::ZipError> for SlicerV3Error {
    fn from(value: zip::result::ZipError) -> Self {
        Self::Zip(value.to_string())
    }
}

impl From<std::io::Error> for SlicerV3Error {
    fn from(value: std::io::Error) -> Self {
        Self::Zip(value.to_string())
    }
}

impl From<serde_json::Error> for SlicerV3Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value.to_string())
    }
}

#[allow(dead_code)]
fn _empty_perf() -> SlicingPerfV3 {
    SlicingPerfV3::default()
}
