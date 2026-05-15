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
    apply_blur_postprocess_inplace, apply_blur_postprocess_inplace_with_roi, encode_mask_to_rle,
    rasterize_layer,
};
use crate::types::{
    LayerAreaStatsV3, ProgressCallbackV3, RenderedLayersV3, SliceArtifactV3, SliceJobV3,
    SliceProgressPhaseV3, SliceProgressUpdateV3,
};
use crate::z_blend;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::AtomicBool;
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
        let layer_index = build_layer_index(&triangles, support_job.total_layers, support_job.layer_height_mm);

        Some(Self {
            support_job,
            triangles,
            layer_index,
            model_triangle_count,
            support_candidates: Vec::new(),
        })
    }

    fn rasterize_support_mask(&mut self, layer: u32) -> Option<Vec<u8>> {
        self.support_candidates.clear();
        for &candidate in self.layer_index.candidates_for_layer(layer) {
            if candidate >= self.model_triangle_count {
                self.support_candidates.push(candidate);
            }
        }

        if self.support_candidates.is_empty() {
            return None;
        }

        Some(rasterize_layer(
            &self.support_job,
            &self.triangles,
            &self.support_candidates,
            layer,
        ))
    }
}

#[inline]
fn merge_support_mask_inplace(dst: &mut [u8], support: &[u8]) {
    u8_max_inplace(dst, support);
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

fn rasterize_vertical_aa_streaming_v3(
    job: &SliceJobV3,
    raster_job: &SliceJobV3,
    requires_area_stats: bool,
    collect_png_layers: bool,
    collect_raw_mask_layers: bool,
    // Optional per-layer callback receiving the fully processed (z-blended +
    // blurred) mask. When provided, the mask is forwarded here instead of being
    // appended to `raw_mask_layers`. Use this for streaming RLE or raw-mask
    // output without accumulating all layers in memory.
    on_processed_mask: Option<&mut dyn FnMut(u32, Vec<u8>) -> Result<(), SlicerV3Error>>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    let width = raster_job.effective_render_width_px() as usize;
    let height = raster_job.source_height_px as usize;
    let pixels_per_layer = width.saturating_mul(height);
    let look_back = (job.z_blend_look_back as usize).max(1);
    let fade_px = job.z_blend_fade_px.max(1);
    let blur_radius = job.blur_brush_radius_px as usize;
    let lut = z_blend::default_z_blend_lut();
    let min_aa_alpha_u8 =
        ((job.minimum_aa_alpha_percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
    let debug_color_overlay = job.z_blend_debug_color_overlay && collect_png_layers;
    const TOPOLOGY_ALPHA_THRESHOLD: u8 = 127;

    let mut topology_reuse_pool: Vec<Vec<u8>> = Vec::with_capacity(look_back + 1);
    let mut workspace = z_blend::ZBlendWorkspace::new(width, height);
    let mut debug_rgb_buffer: Vec<u8> = if debug_color_overlay {
        vec![0u8; pixels_per_layer * 3]
    } else {
        Vec::new()
    };
    let mut png_layers: Option<Vec<Vec<u8>>> =
        collect_png_layers.then(|| Vec::with_capacity(job.total_layers as usize));
    // When on_processed_mask is provided it owns the processed masks (streaming
    // to an RLE / raw-mask encoder); fall back to in-memory collection only
    // when the caller explicitly requests it AND no streaming callback exists.
    let use_callback = on_processed_mask.is_some();
    let mut raw_mask_layers: Option<Vec<Vec<u8>>> = (collect_raw_mask_layers && !use_callback)
        .then(|| Vec::with_capacity(job.total_layers as usize));
    let mut on_processed_mask = on_processed_mask; // move into local for closure capture

    let mut support_mask_context = SupportMaskContext::from_job(raster_job);
    let model_active_layer_window = resolve_model_active_layer_window(raster_job);

    // Pending queue for symmetric forward-compensation blending.
    //
    // Each layer is held until up to `look_back` future topologies are available.
    // At emission time we apply forward blend first (lookahead window), then XY
    // blur, then support merge. This keeps forward and backward Z blending
    // symmetric and ensures both happen before blur.
    struct PendingLayer {
        layer_index: u32,
        mask: Vec<u8>,
        topology: Vec<u8>,
        topology_bounds: Option<(usize, usize, usize, usize)>,
        topology_non_empty: bool,
        model_non_empty: bool,
        backward_applied: bool,
        backward_seed_bounds: Option<(usize, usize, usize, usize)>,
        support_mask: Option<Vec<u8>>,
        apply_model_aa: bool,
        backward_contrib: Option<Vec<u8>>,
    }
    let mut pending_layers: VecDeque<PendingLayer> = VecDeque::with_capacity(look_back + 1);

    let mut on_raw_mask_layer = |layer_index: u32,
                                 mut raw_mask: Vec<u8>|
     -> Result<(), SlicerV3Error> {
        if raw_mask.is_empty() {
            raw_mask = vec![0u8; pixels_per_layer];
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
        if let Some(ref support_mask) = support_mask_for_layer {
            for (px, s) in raw_mask.iter_mut().zip(support_mask.iter()) {
                if *s > 0 {
                    *px = 0;
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
        if apply_model_aa {
            for y in 0..height {
                let row = y * width;
                for x in 0..width {
                    let idx = row + x;
                    let src = raw_mask[idx];
                    let dst = &mut topology_mask[idx];
                    if src > 0 {
                        model_non_empty = true;
                    }
                    if src > TOPOLOGY_ALPHA_THRESHOLD {
                        *dst = 255;
                        topology_non_empty = true;
                        topo_min_x = topo_min_x.min(x);
                        topo_max_x = topo_max_x.max(x);
                        topo_min_y = topo_min_y.min(y);
                        topo_max_y = topo_max_y.max(y);
                    } else {
                        *dst = 0;
                    }
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

        let base_mask_for_debug = (debug_color_overlay && apply_model_aa).then(|| raw_mask.clone());

        let priors_have_topology = pending_layers.iter().any(|layer| layer.topology_non_empty);
        let backward_applied = apply_model_aa && (model_non_empty || priors_have_topology);
        let mut backward_seed_bounds = topology_bounds;
        if backward_applied {
            let priors_start = pending_layers.len().saturating_sub(look_back);
            for prior in pending_layers.iter().skip(priors_start) {
                backward_seed_bounds = merge_bounds(backward_seed_bounds, prior.topology_bounds);
            }
        }

        // --- Backward z-blend for the current layer (look-behind window). ---
        if backward_applied {
            let priors_start = pending_layers.len().saturating_sub(look_back);
            let priors: Vec<&[u8]> = pending_layers
                .iter()
                .skip(priors_start)
                .map(|layer| layer.topology.as_slice())
                .collect();
            let blend_pad = fade_px as usize + 1;
            if let Some((min_x, max_x, min_y, max_y)) =
                expand_bounds(backward_seed_bounds, blend_pad, width, height)
            {
                workspace.blend_layer_inplace_with_roi(
                    &mut raw_mask,
                    &priors,
                    width,
                    height,
                    fade_px,
                    Some(&lut),
                    (min_x, max_x, min_y, max_y),
                );
            } else {
                workspace.blend_layer_inplace(
                    &mut raw_mask,
                    &priors,
                    width,
                    height,
                    fade_px,
                    Some(&lut),
                );
            }
        }

        let backward_contrib = if backward_applied {
            if let Some(base_mask) = base_mask_for_debug.as_ref() {
                let mut diff = vec![0u8; pixels_per_layer];
                for ((dst, after), before) in diff
                    .iter_mut()
                    .zip(raw_mask.iter())
                    .zip(base_mask.iter())
                {
                    *dst = after.saturating_sub(*before);
                }
                Some(diff)
            } else {
                None
            }
        } else {
            None
        };

        // Defer emission so we can apply a full lookahead window before blur.
        pending_layers.push_back(PendingLayer {
            layer_index,
            mask: raw_mask,
            topology: topology_mask,
            topology_bounds,
            topology_non_empty,
            model_non_empty,
            backward_applied,
            backward_seed_bounds,
            support_mask: support_mask_for_layer,
            apply_model_aa,
            backward_contrib,
        });

        // Flush once the oldest pending layer has a full future window.
        if pending_layers.len() > look_back {
            let mut layer = pending_layers.pop_front().expect("pending layer exists");
            let futures: Vec<&[u8]> = pending_layers
                .iter()
                .take(look_back)
                .map(|future| future.topology.as_slice())
                .collect();

            let futures_have_topology = pending_layers.iter().any(|future| future.topology_non_empty);
            let forward_applied = layer.apply_model_aa && layer.topology_non_empty && futures_have_topology;

            let mut forward_contrib = if debug_color_overlay && forward_applied {
                Some(vec![0u8; pixels_per_layer])
            } else {
                None
            };

            let effective_look_back = futures.len();
            if forward_applied && effective_look_back > 0 {
                let before_forward = if debug_color_overlay {
                    Some(layer.mask.clone())
                } else {
                    None
                };

                let mut forward_seed_bounds = layer.topology_bounds;
                for future in pending_layers.iter().take(look_back) {
                    forward_seed_bounds = merge_bounds(forward_seed_bounds, future.topology_bounds);
                }
                let blend_pad = fade_px as usize + 1;
                if let Some((min_x, max_x, min_y, max_y)) =
                    expand_bounds(forward_seed_bounds, blend_pad, width, height)
                {
                    workspace.blend_layer_forward_inplace_with_roi(
                        &mut layer.mask,
                        layer.topology.as_slice(),
                        &futures,
                        effective_look_back,
                        width,
                        height,
                        fade_px,
                        Some(&lut),
                        (min_x, max_x, min_y, max_y),
                    );
                } else {
                    workspace.blend_layer_forward_inplace(
                        &mut layer.mask,
                        layer.topology.as_slice(),
                        &futures,
                        effective_look_back,
                        width,
                        height,
                        fade_px,
                        Some(&lut),
                    );
                }

                if let (Some(before), Some(ref mut forward)) =
                    (before_forward.as_ref(), forward_contrib.as_mut())
                {
                    for ((dst, after), prev) in forward
                        .iter_mut()
                        .zip(layer.mask.iter())
                        .zip(before.iter())
                    {
                        *dst = after.saturating_sub(*prev);
                    }
                }
            }

            // XY smoothing runs after both vertical blend directions.
            let should_blur_model =
                layer.apply_model_aa && (layer.model_non_empty || layer.backward_applied || forward_applied);
            if should_blur_model {
                let mut model_blur_seed_bounds = layer.backward_seed_bounds;
                if forward_applied {
                    model_blur_seed_bounds = merge_bounds(model_blur_seed_bounds, layer.topology_bounds);
                    for future in pending_layers.iter().take(look_back) {
                        model_blur_seed_bounds = merge_bounds(model_blur_seed_bounds, future.topology_bounds);
                    }
                }
                let blur_pad = fade_px as usize + blur_radius;
                if let Some((min_x, max_x, min_y, max_y)) =
                    expand_bounds(model_blur_seed_bounds, blur_pad, width, height)
                {
                    apply_blur_postprocess_inplace_with_roi(
                        &mut layer.mask,
                        width,
                        height,
                        min_x,
                        max_x,
                        min_y,
                        max_y,
                        blur_radius,
                        min_aa_alpha_u8,
                    );
                } else {
                    apply_blur_postprocess_inplace(
                        &mut layer.mask,
                        width,
                        height,
                        blur_radius,
                        min_aa_alpha_u8,
                    );
                }
                if blur_radius == 0 {
                    apply_min_alpha_floor(&mut layer.mask, min_aa_alpha_u8);
                }
            }

            if let Some(ref mut backward) = layer.backward_contrib {
                apply_blur_postprocess_inplace(
                    backward,
                    width,
                    height,
                    blur_radius,
                    min_aa_alpha_u8,
                );
                if blur_radius == 0 {
                    apply_min_alpha_floor(backward, min_aa_alpha_u8);
                }
            }
            if let Some(ref mut forward) = forward_contrib {
                apply_blur_postprocess_inplace(
                    forward,
                    width,
                    height,
                    blur_radius,
                    min_aa_alpha_u8,
                );
                if blur_radius == 0 {
                    apply_min_alpha_floor(forward, min_aa_alpha_u8);
                }
            }

            if let Some(support_mask) = layer.support_mask.as_ref() {
                merge_support_mask_inplace(&mut layer.mask, support_mask);
            }

            if let Some(ref mut out_pngs) = png_layers {
                let png = if debug_color_overlay {
                    if let (Some(backward), Some(forward)) =
                        (layer.backward_contrib.as_ref(), forward_contrib.as_ref())
                    {
                        if debug_rgb_buffer.len() != pixels_per_layer * 3 {
                            debug_rgb_buffer.resize(pixels_per_layer * 3, 0);
                        }
                        for i in 0..pixels_per_layer {
                            debug_rgb_buffer[i * 3] = forward[i]; // Red = look-ahead
                            debug_rgb_buffer[i * 3 + 1] = backward[i]; // Green = look-behind
                            debug_rgb_buffer[i * 3 + 2] = 0;
                        }
                        encode_rgb_png_8bit(
                            width as u32,
                            height as u32,
                            &debug_rgb_buffer,
                            &raster_job.png_compression_strategy,
                        )?
                    } else {
                        encode_grayscale_png(
                            width as u32,
                            height as u32,
                            &layer.mask,
                            &raster_job.png_compression_strategy,
                            false,
                        )?
                    }
                } else {
                    encode_grayscale_png(
                        width as u32,
                        height as u32,
                        &layer.mask,
                        &raster_job.png_compression_strategy,
                        false,
                    )?
                };
                out_pngs.push(png);
            }
            if let Some(ref mut emit) = on_processed_mask {
                emit(layer.layer_index, layer.mask)?;
            } else if let Some(ref mut out_masks) = raw_mask_layers {
                out_masks.push(layer.mask);
            }

            topology_reuse_pool.push(layer.topology);
        }

        Ok(())
    };

    let (_rendered, layer_area_stats, perf) = slice_and_rasterize_v3(
        raster_job,
        requires_area_stats,
        false,
        false,
        Some(&mut on_raw_mask_layer),
        on_progress,
        cancel_flag,
    )?;

    // Flush tail layers with the remaining (short) future window.
    while let Some(mut layer) = pending_layers.pop_front() {
        let futures: Vec<&[u8]> = pending_layers
            .iter()
            .take(look_back)
            .map(|future| future.topology.as_slice())
            .collect();

        let futures_have_topology = pending_layers.iter().any(|future| future.topology_non_empty);
        let forward_applied = layer.apply_model_aa && layer.topology_non_empty && futures_have_topology;

        let mut forward_contrib = if debug_color_overlay && forward_applied {
            Some(vec![0u8; pixels_per_layer])
        } else {
            None
        };

        let effective_look_back = futures.len();
        if forward_applied && effective_look_back > 0 {
            let before_forward = if debug_color_overlay {
                Some(layer.mask.clone())
            } else {
                None
            };

            let mut forward_seed_bounds = layer.topology_bounds;
            for future in pending_layers.iter().take(look_back) {
                forward_seed_bounds = merge_bounds(forward_seed_bounds, future.topology_bounds);
            }
            let blend_pad = fade_px as usize + 1;
            if let Some((min_x, max_x, min_y, max_y)) =
                expand_bounds(forward_seed_bounds, blend_pad, width, height)
            {
                workspace.blend_layer_forward_inplace_with_roi(
                    &mut layer.mask,
                    layer.topology.as_slice(),
                    &futures,
                    effective_look_back,
                    width,
                    height,
                    fade_px,
                    Some(&lut),
                    (min_x, max_x, min_y, max_y),
                );
            } else {
                workspace.blend_layer_forward_inplace(
                    &mut layer.mask,
                    layer.topology.as_slice(),
                    &futures,
                    effective_look_back,
                    width,
                    height,
                    fade_px,
                    Some(&lut),
                );
            }

            if let (Some(before), Some(ref mut forward)) =
                (before_forward.as_ref(), forward_contrib.as_mut())
            {
                for ((dst, after), prev) in forward
                    .iter_mut()
                    .zip(layer.mask.iter())
                    .zip(before.iter())
                {
                    *dst = after.saturating_sub(*prev);
                }
            }
        }

        let should_blur_model =
            layer.apply_model_aa && (layer.model_non_empty || layer.backward_applied || forward_applied);
        if should_blur_model {
            let mut model_blur_seed_bounds = layer.backward_seed_bounds;
            if forward_applied {
                model_blur_seed_bounds = merge_bounds(model_blur_seed_bounds, layer.topology_bounds);
                for future in pending_layers.iter().take(look_back) {
                    model_blur_seed_bounds = merge_bounds(model_blur_seed_bounds, future.topology_bounds);
                }
            }
            let blur_pad = fade_px as usize + blur_radius;
            if let Some((min_x, max_x, min_y, max_y)) =
                expand_bounds(model_blur_seed_bounds, blur_pad, width, height)
            {
                apply_blur_postprocess_inplace_with_roi(
                    &mut layer.mask,
                    width,
                    height,
                    min_x,
                    max_x,
                    min_y,
                    max_y,
                    blur_radius,
                    min_aa_alpha_u8,
                );
            } else {
                apply_blur_postprocess_inplace(
                    &mut layer.mask,
                    width,
                    height,
                    blur_radius,
                    min_aa_alpha_u8,
                );
            }
            if blur_radius == 0 {
                apply_min_alpha_floor(&mut layer.mask, min_aa_alpha_u8);
            }
        }

        if let Some(ref mut backward) = layer.backward_contrib {
            apply_blur_postprocess_inplace(
                backward,
                width,
                height,
                blur_radius,
                min_aa_alpha_u8,
            );
            if blur_radius == 0 {
                apply_min_alpha_floor(backward, min_aa_alpha_u8);
            }
        }
        if let Some(ref mut forward) = forward_contrib {
            apply_blur_postprocess_inplace(
                forward,
                width,
                height,
                blur_radius,
                min_aa_alpha_u8,
            );
            if blur_radius == 0 {
                apply_min_alpha_floor(forward, min_aa_alpha_u8);
            }
        }

        if let Some(support_mask) = layer.support_mask.as_ref() {
            merge_support_mask_inplace(&mut layer.mask, support_mask);
        }

        if let Some(ref mut out_pngs) = png_layers {
            let png = if debug_color_overlay {
                if let (Some(backward), Some(forward)) =
                    (layer.backward_contrib.as_ref(), forward_contrib.as_ref())
                {
                    if debug_rgb_buffer.len() != pixels_per_layer * 3 {
                        debug_rgb_buffer.resize(pixels_per_layer * 3, 0);
                    }
                    for i in 0..pixels_per_layer {
                        debug_rgb_buffer[i * 3] = forward[i];
                        debug_rgb_buffer[i * 3 + 1] = backward[i];
                        debug_rgb_buffer[i * 3 + 2] = 0;
                    }
                    encode_rgb_png_8bit(
                        width as u32,
                        height as u32,
                        &debug_rgb_buffer,
                        &raster_job.png_compression_strategy,
                    )?
                } else {
                    encode_grayscale_png(
                        width as u32,
                        height as u32,
                        &layer.mask,
                        &raster_job.png_compression_strategy,
                        false,
                    )?
                }
            } else {
                encode_grayscale_png(
                    width as u32,
                    height as u32,
                    &layer.mask,
                    &raster_job.png_compression_strategy,
                    false,
                )?
            };
            out_pngs.push(png);
        }
        if let Some(ref mut emit) = on_processed_mask {
            emit(layer.layer_index, layer.mask)?;
        } else if let Some(ref mut out_masks) = raw_mask_layers {
            out_masks.push(layer.mask);
        }

        topology_reuse_pool.push(layer.topology);
    }

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
    // Keep the caller-selected AA level intact so "AA Strength" remains
    // meaningful in 3DAA mode (Coverage supersampling first, then Z-blend/blur).
    let raster_job_owned: Option<SliceJobV3> = if is_3daa {
        let mut j = job.clone();
        j.anti_aliasing_mode = "Coverage".to_string();
        j.minimum_aa_alpha_percent = 0.0;
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
                let mut on_mask = |idx: u32, mask: Vec<u8>| -> Result<(), SlicerV3Error> {
                    let runs = encode_mask_to_rle(&mask, width, height);
                    rle_enc.consume_rle_layer(idx, runs)
                };
                rasterize_vertical_aa_streaming_v3(
                    job,
                    raster_job,
                    requires_area_stats,
                    false,
                    false,
                    Some(&mut on_mask as &mut dyn FnMut(u32, Vec<u8>) -> Result<(), SlicerV3Error>),
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
            let mut raw_mask_sink = |layer_index: u32, raw_mask: Vec<u8>| {
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
    on_rle_layer: impl FnMut(u32, Vec<crate::rle::RleRun>) -> Result<(), SlicerV3Error>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    validate_job(job)?;

    let mut triangles = parse_triangles(&job.triangles_xyz);
    project_triangles_inplace(&mut triangles, job);
    let index_start = std::time::Instant::now();
    let layer_index = build_layer_index(&triangles, job.total_layers, job.layer_height_mm);
    let index_ns = index_start.elapsed().as_nanos() as u64;

    let (rendered_layers, layer_area_stats, mut perf) = render_layers_rle(
        job,
        &triangles,
        &layer_index,
        compute_area_stats,
        on_rle_layer,
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

    let mut triangles = parse_triangles(&job.triangles_xyz);
    project_triangles_inplace(&mut triangles, job);
    let index_start = std::time::Instant::now();
    let layer_index = build_layer_index(&triangles, job.total_layers, job.layer_height_mm);
    let index_ns = index_start.elapsed().as_nanos() as u64;

    let (rendered_layers, layer_area_stats, mut perf) = render_layers_rle_encoded(
        job,
        &triangles,
        &layer_index,
        compute_area_stats,
        encode_fn,
        on_encoded_layer,
        on_progress,
        cancel_flag,
    )?;
    perf.index_build_ns = index_ns;

    Ok((rendered_layers, layer_area_stats, perf))
}

/// Format-agnostic geometry/index/raster stage that outputs layer PNG bytes.
pub fn slice_and_rasterize_v3(
    job: &SliceJobV3,
    requires_area_stats: bool,
    emit_png_layers: bool,
    emit_raw_mask_layers: bool,
    on_raw_mask_layer: Option<&mut dyn FnMut(u32, Vec<u8>) -> Result<(), SlicerV3Error>>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    validate_job(job)?;

    let mut triangles = parse_triangles(&job.triangles_xyz);
    project_triangles_inplace(&mut triangles, job);
    let index_start = std::time::Instant::now();
    let layer_index = build_layer_index(&triangles, job.total_layers, job.layer_height_mm);
    let index_ns = index_start.elapsed().as_nanos() as u64;

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
    // Keep the caller-selected AA level intact so "AA Strength" remains
    // meaningful in 3DAA mode (Coverage supersampling first, then Z-blend/blur).
    let raster_job_owned: Option<SliceJobV3> = if is_3daa {
        let mut j = job.clone();
        j.anti_aliasing_mode = "Coverage".to_string();
        j.minimum_aa_alpha_percent = 0.0;
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
                let mut on_mask = |idx: u32, mask: Vec<u8>| -> Result<(), SlicerV3Error> {
                    let runs = encode_mask_to_rle(&mask, width, height);
                    rle_enc.consume_rle_layer(idx, runs)
                };
                rasterize_vertical_aa_streaming_v3(
                    job,
                    raster_job,
                    requires_area_stats,
                    false,
                    false,
                    Some(&mut on_mask as &mut dyn FnMut(u32, Vec<u8>) -> Result<(), SlicerV3Error>),
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
            let mut raw_mask_sink = |layer_index: u32, raw_mask: Vec<u8>| {
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
