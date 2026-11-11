//! Bounded parallel layer rendering pipeline.
//!
//! This stage rasterizes layers and emits requested payloads (PNG and/or raw
//! masks) with controlled in-flight work, ordered output assembly, progress
//! reporting, and cooperative cancellation.

use crate::encode::{encode_binary_grayscale_png_1bit, encode_grayscale_png};
use crate::engine::SlicerV3Error;
use crate::geometry::Triangle;
use crate::index::LayerIndex;
use crate::metrics::SlicingPerfV3;
use crate::raster::{
    rasterize_layer_rle, rasterize_layer_with_stats, recompute_layer_stats_from_rle,
};
use crate::raw_layers::LayerSegments;
use crate::raster::BinaryScanlineRaster;
use crate::scanline_simd::{render_scanline_batch, MAX_SCANLINE_LANES};
use crate::pulp_simd::Backend;
use crate::rle::{RleAccum, RleRun};
use crate::types::{
    LayerAreaStatsV3, ProgressCallbackV3, RenderedLayersV3, SliceJobV3, SliceProgressPhaseV3,
    SliceProgressUpdateV3,
};
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

static MASK_POOL: OnceLock<Mutex<Vec<Vec<u8>>>> = OnceLock::new();

pub fn return_mask_to_pool(mask: Vec<u8>) {
    if mask.is_empty() {
        return;
    }
    // Large masks (≥32 MB, i.e. full-frame 8K–12K layers) are allocated via OS
    // mmap and their physical pages are returned to the OS promptly when the Vec
    // is dropped. Capping the pool at 4 for these prevents the pool from holding
    // 16 × 59 MB = 944 MB of idle buffers for the lifetime of a job. A pool of
    // 4 is still enough to satisfy raster worker recycling (effective parallelism
    // at 12K is ~2–3×, so at most 2–3 masks are recycled per cycle).
    let max_pool = if mask.len() >= 32 * 1024 * 1024 {
        4
    } else {
        16
    };
    if let Ok(mut pool) = MASK_POOL.get_or_init(|| Mutex::new(Vec::new())).lock() {
        if pool.len() < max_pool {
            // Keep the capacity, don't drop
            pool.push(mask);
        }
    }
}

pub fn get_recycled_mask(size: usize) -> Vec<u8> {
    if let Ok(mut pool) = MASK_POOL.get_or_init(|| Mutex::new(Vec::new())).lock() {
        while let Some(mut m) = pool.pop() {
            if m.len() == size {
                m.fill(0);
                return m;
            }
        }
    }
    vec![0u8; size]
}

fn merge_rle_max(lhs_runs: &[RleRun], rhs_runs: &[RleRun]) -> Vec<RleRun> {
    let mut out = RleAccum::new();
    let mut lhs_index = 0usize;
    let mut rhs_index = 0usize;
    let mut lhs_remaining = 0u32;
    let mut rhs_remaining = 0u32;
    let mut lhs_value = 0u8;
    let mut rhs_value = 0u8;

    loop {
        if lhs_remaining == 0 {
            if let Some(run) = lhs_runs.get(lhs_index) {
                lhs_remaining = run.length;
                lhs_value = run.value;
                lhs_index += 1;
            }
        }

        if rhs_remaining == 0 {
            if let Some(run) = rhs_runs.get(rhs_index) {
                rhs_remaining = run.length;
                rhs_value = run.value;
                rhs_index += 1;
            }
        }

        if lhs_remaining == 0 && rhs_remaining == 0 {
            break;
        }

        let chunk = match (lhs_remaining, rhs_remaining) {
            (0, rhs) => rhs,
            (lhs, 0) => lhs,
            (lhs, rhs) => lhs.min(rhs),
        };
        out.push_run(chunk, lhs_value.max(rhs_value));

        if lhs_remaining > 0 {
            lhs_remaining -= chunk;
            if lhs_remaining == 0 {
                lhs_value = 0;
            }
        }
        if rhs_remaining > 0 {
            rhs_remaining -= chunk;
            if rhs_remaining == 0 {
                rhs_value = 0;
            }
        }
    }

    out.finish()
}

fn compute_rle_max_basic_stats(
    lhs_runs: &[RleRun],
    rhs_runs: &[RleRun],
    width: usize,
    height: usize,
    pixel_area_mm2: f64,
) -> LayerAreaStatsV3 {
    let mut stats = LayerAreaStatsV3::default();
    if width == 0 || height == 0 {
        return stats;
    }

    let total_pixels = width.saturating_mul(height);
    let mut lhs_index = 0usize;
    let mut rhs_index = 0usize;
    let mut lhs_remaining = 0u32;
    let mut rhs_remaining = 0u32;
    let mut lhs_value = 0u8;
    let mut rhs_value = 0u8;
    let mut pos = 0usize;
    let mut any_non_zero = false;
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0usize;
    let mut max_y = 0usize;

    loop {
        if lhs_remaining == 0 {
            if let Some(run) = lhs_runs.get(lhs_index) {
                lhs_remaining = run.length;
                lhs_value = run.value;
                lhs_index += 1;
            }
        }

        if rhs_remaining == 0 {
            if let Some(run) = rhs_runs.get(rhs_index) {
                rhs_remaining = run.length;
                rhs_value = run.value;
                rhs_index += 1;
            }
        }

        if lhs_remaining == 0 && rhs_remaining == 0 {
            break;
        }

        let chunk = match (lhs_remaining, rhs_remaining) {
            (0, rhs) => rhs,
            (lhs, 0) => lhs,
            (lhs, rhs) => lhs.min(rhs),
        };
        let out_value = lhs_value.max(rhs_value);

        if out_value > 0 {
            any_non_zero = true;
            let chunk_len = (chunk as usize).min(total_pixels.saturating_sub(pos));
            stats.total_solid_pixels = stats.total_solid_pixels.saturating_add(chunk_len as u32);

            let mut cur = pos;
            let end = pos + chunk_len;
            while cur < end {
                let row = cur / width;
                let col = cur % width;
                let take = (end - cur).min(width - col);
                min_x = min_x.min(col);
                max_x = max_x.max(col + take - 1);
                min_y = min_y.min(row);
                max_y = max_y.max(row);
                cur += take;
            }
        }

        pos = pos.saturating_add(chunk as usize);

        if lhs_remaining > 0 {
            lhs_remaining -= chunk;
            if lhs_remaining == 0 {
                lhs_value = 0;
            }
        }
        if rhs_remaining > 0 {
            rhs_remaining -= chunk;
            if rhs_remaining == 0 {
                rhs_value = 0;
            }
        }
    }

    if !any_non_zero {
        return stats;
    }

    let total_area = (stats.total_solid_pixels as f64) * pixel_area_mm2;
    stats.total_solid_area_mm2 = total_area;
    stats.largest_area_mm2 = total_area;
    stats.smallest_area_mm2 = total_area;
    stats.area_count = 1;
    stats.min_x = min_x as i32;
    stats.min_y = min_y as i32;
    stats.max_x = max_x as i32;
    stats.max_y = max_y as i32;
    stats
}

fn encode_zero_rle(width: usize, height: usize) -> Vec<RleRun> {
    let mut out = RleAccum::new();
    crate::rle::emit_zero_rows(&mut out, height, width);
    out.finish()
}

struct PerturbSupportSplitJobs {
    model: SliceJobV3,
    support: SliceJobV3,
}

impl PerturbSupportSplitJobs {
    fn for_job(job: &SliceJobV3, split: Option<usize>) -> Option<Self> {
        if split.is_none() || job.aa_on_supports || !crate::zaa::use_raster_perturbation(job)
            || job.effective_xy_aa_steps() <= 1
        {
            return None;
        }
        let mut model = job.clone();
        model.triangles_xyz = Vec::new();
        // Candidates are already partitioned. Do not re-enter the generic
        // support bypass, which materializes a full-frame model mask.
        model.aa_on_supports = true;
        model.model_triangle_count = 0;
        let support = binary_support_raster_job(&model);
        Some(Self { model, support })
    }
}

fn binary_support_raster_job(job: &SliceJobV3) -> SliceJobV3 {
    let mut support = job.clone();
    support.anti_aliasing_level = "Off".to_string();
    support.anti_aliasing_mode = "Coverage".to_string();
    support.blur_brush_radius_px = 0;
    support.minimum_aa_alpha_percent = 100.0;
    support.aa_on_supports = true;
    support.model_triangle_count = 0;
    support
}

fn rasterize_layer_rle_with_support_split(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_candidates: &[usize],
    layer: u32,
    compute_area_stats: bool,
    model_triangle_count: usize,
    split_jobs: Option<&PerturbSupportSplitJobs>,
) -> (Vec<RleRun>, Option<Vec<RleRun>>, LayerAreaStatsV3) {
    let model_job = split_jobs.map_or(job, |jobs| &jobs.model);
    if split_jobs.is_some() && !layer_candidates.iter().any(|&i| i >= model_triangle_count) {
        let (runs, stats) = rasterize_layer_rle(
            model_job, triangles, layer_candidates, layer, compute_area_stats,
        );
        return (runs, None, stats);
    }
    let mut model_layer_indices = Vec::with_capacity(layer_candidates.len());
    let mut support_layer_indices = Vec::with_capacity(layer_candidates.len());
    for &candidate in layer_candidates {
        if candidate < model_triangle_count {
            model_layer_indices.push(candidate);
        } else {
            support_layer_indices.push(candidate);
        }
    }

    if support_layer_indices.is_empty() {
        let (runs, stats) =
            rasterize_layer_rle(model_job, triangles, layer_candidates, layer, compute_area_stats);
        return (runs, None, stats);
    }

    let width = job.effective_render_width_px() as usize;
    let height = job.source_height_px as usize;
    let pixel_area_mm2 = ((job.build_width_mm as f64)
        / (job.effective_render_width_px().max(1) as f64))
        * ((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));

    let model_runs = if model_layer_indices.is_empty() {
        encode_zero_rle(width, height)
    } else {
        rasterize_layer_rle(model_job, triangles, &model_layer_indices, layer, false).0
    };

    // Raw/2D callers retain the original per-layer binary job behavior.
    let owned_support_job;
    let support_job = if let Some(jobs) = split_jobs {
        &jobs.support
    } else {
        owned_support_job = binary_support_raster_job(job);
        &owned_support_job
    };

    let (support_runs, support_stats) = rasterize_layer_rle(
        support_job,
        triangles,
        &support_layer_indices,
        layer,
        compute_area_stats && split_jobs.is_none(),
    );

    if model_layer_indices.is_empty() {
        let stats = if compute_area_stats && split_jobs.is_some() {
            recompute_layer_stats_from_rle(&support_runs, width, height, pixel_area_mm2, true)
        } else {
            support_stats
        };
        return (model_runs, Some(support_runs), stats);
    }

    let stats = if compute_area_stats {
        let merged_runs = merge_rle_max(&model_runs, &support_runs);
        recompute_layer_stats_from_rle(&merged_runs, width, height, pixel_area_mm2, true)
    } else {
        compute_rle_max_basic_stats(&model_runs, &support_runs, width, height, pixel_area_mm2)
    };

    (model_runs, Some(support_runs), stats)
}

#[cfg(test)]
fn rasterize_raw_layer_segments(
    job: &SliceJobV3, layer: &LayerSegments, compute_area_stats: bool,
) -> (Vec<RleRun>, Option<Vec<RleRun>>, LayerAreaStatsV3) {
    let (runs, model_stats) = crate::raster::rasterize_binary_layer_rle_from_segments(
        job, &layer.model, compute_area_stats && layer.support.is_none(),
    );
    let Some(support) = layer.support.as_ref() else { return (runs, None, model_stats); };
    let (support_runs, support_stats) = crate::raster::rasterize_binary_layer_rle_from_segments(
        job, support, compute_area_stats && layer.model_candidates == 0,
    );
    if layer.model_candidates == 0 { return (runs, Some(support_runs), support_stats); }
    let width = job.effective_render_width_px() as usize;
    let height = job.source_height_px as usize;
    let pixel_area_mm2 = ((job.build_width_mm as f64) / (job.effective_render_width_px().max(1) as f64))
        * ((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));
    let stats = if compute_area_stats {
        let merged = merge_rle_max(&runs, &support_runs);
        recompute_layer_stats_from_rle(&merged, width, height, pixel_area_mm2, true)
    } else {
        compute_rle_max_basic_stats(&runs, &support_runs, width, height, pixel_area_mm2)
    };
    (runs, Some(support_runs), stats)
}

enum RawOutput {
    Rle(Vec<RleRun>),
    Mask(Vec<u8>),
}

struct RenderedRawLayer {
    layer_index: u32,
    output: RawOutput,
    support: Option<Vec<RleRun>>,
    stats: LayerAreaStatsV3,
}

impl RenderedRawLayer {
    fn into_rle(self) -> (Vec<RleRun>, Option<Vec<RleRun>>, LayerAreaStatsV3) {
        let RawOutput::Rle(runs) = self.output else { panic!("expected RAW runs"); };
        (runs, self.support, self.stats)
    }

    fn into_mask(self) -> (Vec<u8>, LayerAreaStatsV3) {
        let RawOutput::Mask(mask) = self.output else { panic!("expected RAW mask"); };
        (mask, self.stats)
    }
}

/// Only these long-lived jobs may hold a group. Nested preparation/encoding
/// uses the same Rayon pool, so live raster layers never exceed the old cap.
fn for_each_layer_group(
    total_layers: u32, max_concurrent: usize, raw_eligible: bool,
    process: impl Fn(u32, u32) -> Result<(), SlicerV3Error> + Sync,
) -> Result<(), SlicerV3Error> {
    let cap = max_concurrent.max(1);
    let grain = if raw_eligible {
        MAX_SCANLINE_LANES.min(cap).min(total_layers.max(1) as usize)
    } else { 1 };
    let slots = (cap / grain).max(1);
    let next = AtomicU32::new(0);
    let stopped = AtomicBool::new(false);
    (0..slots).into_par_iter().try_for_each(|_| {
        while !stopped.load(Ordering::Relaxed) {
            let start = next.fetch_add(grain as u32, Ordering::Relaxed);
            if start >= total_layers { break; }
            if let Err(error) = process(start, (start + grain as u32).min(total_layers)) {
                stopped.store(true, Ordering::Relaxed);
                return Err(error);
            }
        }
        Ok(())
    })
}

fn prepare_raw_layers(
    job: &SliceJobV3, triangles: &[Triangle], layer_index: &LayerIndex,
    start: u32, end: u32, support_split: Option<usize>, cancel: Option<&AtomicBool>,
    raster_ns: &AtomicU64, raw_geometry_ns: &AtomicU64,
) -> Result<Vec<LayerSegments>, SlicerV3Error> {
    (start..end).into_par_iter().map(|layer| {
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err(SlicerV3Error::Cancelled);
        }
        let timer = std::time::Instant::now();
        let result = crate::raw_layers::prepare_layer(job, triangles,
            layer_index.candidates_for_layer(layer), layer, support_split, cancel);
        let elapsed = timer.elapsed().as_nanos() as u64;
        raster_ns.fetch_add(elapsed, Ordering::Relaxed);
        raw_geometry_ns.fetch_add(elapsed, Ordering::Relaxed);
        result
    }).collect()
}

fn render_raw_batch(
    job: &SliceJobV3, layers: Vec<LayerSegments>, compute_area_stats: bool, mask: bool,
    backend: Backend, cancel: Option<&AtomicBool>,
    raster_ns: &AtomicU64, raw_scanline_ns: &AtomicU64,
) -> Result<Vec<RenderedRawLayer>, SlicerV3Error> {
    let timer = std::time::Instant::now();
    let mut support_slots = Vec::with_capacity(layers.len());
    let mut support_rasters = Vec::with_capacity(layers.len());
    let mut metadata = Vec::with_capacity(layers.len());
    let mut rasters: Vec<_> = layers.into_par_iter().map(|layer| {
        let raster = if mask && layer.model_candidates > 0 {
            BinaryScanlineRaster::new_mask(job, &layer.model, compute_area_stats)
        } else {
            BinaryScanlineRaster::new_rle(job, &layer.model,
                compute_area_stats && layer.support.is_none(), None)
        };
        let support = layer.support.map(|segments| BinaryScanlineRaster::new_rle(
            job, &segments, compute_area_stats && layer.model_candidates == 0, None));
        (layer.layer_index, layer.model_candidates, raster, support)
    }).collect();
    let mut models = Vec::with_capacity(rasters.len());
    for (layer, model_candidates, raster, support) in rasters.drain(..) {
        metadata.push((layer, model_candidates));
        models.push(raster);
        support_slots.push(support.is_some());
        if let Some(support) = support { support_rasters.push(support); }
    }
    render_scanline_batch(&mut models, backend, cancel)?;
    render_scanline_batch(&mut support_rasters, backend, cancel)?;
    let mut supports = support_rasters.into_iter();
    let width = job.effective_render_width_px() as usize;
    let height = job.source_height_px as usize;
    let pixel_area = (job.build_width_mm as f64 / job.effective_render_width_px().max(1) as f64)
        * (job.build_depth_mm as f64 / job.source_height_px.max(1) as f64);
    let output = models.into_iter().zip(metadata).zip(support_slots).map(|((raster, (layer_index, model_candidates)), has_support)| {
        if mask {
            // Guaranteed-empty candidates retain the existing no-mask sentinel.
            let (mask, stats) = if model_candidates == 0 {
                let (_, stats) = raster.finish_rle();
                (Vec::new(), stats)
            } else { raster.finish_mask() };
            return RenderedRawLayer { layer_index, output: RawOutput::Mask(mask), support: None, stats };
        }
        let (runs, mut stats) = raster.finish_rle();
        let support = if has_support {
            let (support, support_stats) = supports.next().expect("prepared support raster").finish_rle();
            stats = if model_candidates == 0 { support_stats } else if compute_area_stats {
                let merged = merge_rle_max(&runs, &support);
                recompute_layer_stats_from_rle(&merged, width, height, pixel_area, true)
            } else {
                compute_rle_max_basic_stats(&runs, &support, width, height, pixel_area)
            };
            Some(support)
        } else { None };
        RenderedRawLayer { layer_index, output: RawOutput::Rle(runs), support, stats }
    }).collect();
    let elapsed = timer.elapsed().as_nanos() as u64;
    raster_ns.fetch_add(elapsed, Ordering::Relaxed);
    raw_scanline_ns.fetch_add(elapsed, Ordering::Relaxed);
    Ok(output)
}

fn for_each_rendered_layer(
    job: &SliceJobV3, triangles: &[Triangle], layer_index: &LayerIndex,
    start: u32, end: u32, support_split: Option<usize>, backend: Backend,
    compute_area_stats: bool, mask: bool, cancel: Option<&AtomicBool>,
    raster_ns: &AtomicU64, raw_geometry_ns: &AtomicU64, raw_scanline_ns: &AtomicU64,
    emit: impl Fn(u32, Option<RenderedRawLayer>) -> Result<(), SlicerV3Error> + Sync,
) -> Result<(), SlicerV3Error> {
    if !crate::raster::raw_binary_geometry_eligible(job, triangles.len()) {
        return (start..end).into_par_iter().try_for_each(|layer| emit(layer, None));
    }
    let layers = prepare_raw_layers(job, triangles, layer_index, start, end, support_split,
        cancel, raster_ns, raw_geometry_ns)?;
    render_raw_batch(job, layers, compute_area_stats, mask, backend, cancel, raster_ns, raw_scanline_ns)?
        .into_par_iter().try_for_each(|layer| emit(layer.layer_index, Some(layer)))
}

fn encode_uniform_png_cached(
    width: u32,
    height: u32,
    png_compression_strategy: &str,
    uniform_value: u8,
    cache: &Mutex<Option<Vec<u8>>>,
) -> Result<Vec<u8>, SlicerV3Error> {
    if let Some(bytes) = cache.lock().ok().and_then(|guard| guard.clone()) {
        return Ok(bytes);
    }

    let pixels = vec![uniform_value; (width as usize) * (height as usize)];
    let encoded =
        encode_binary_grayscale_png_1bit(width, height, &pixels, png_compression_strategy)?;

    if let Ok(mut guard) = cache.lock() {
        if guard.is_none() {
            *guard = Some(encoded.clone());
        }
    }

    Ok(encoded)
}

fn choose_max_concurrent() -> usize {
    let hw = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let env = std::env::var("DF_V3_MAX_CONCURRENT")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(hw);
    env.clamp(1, hw)
}

fn cap_concurrency_for_mask_bytes(
    requested: usize,
    layer_pixels_len: usize,
    streaming_raw_mask_sink: bool,
) -> usize {
    let bytes_per_mask = layer_pixels_len;
    let mut capped = requested.max(1);

    // Optional override: memory budget for in-flight raw masks (MB).
    // Lets high-RAM workstations use more cores for giant layers.
    let budget_override = std::env::var("DF_V3_MAX_MASK_INFLIGHT_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 64)
        .map(|mb| mb.saturating_mul(1024 * 1024));

    // By default, keep non-streaming formats (e.g. NanoDLP PNG path)
    // unconstrained so they can use available CPU cores. We only apply
    // aggressive large-mask caps automatically in streaming raw-mask mode
    // where giant buffers can pile up and crash.
    if !streaming_raw_mask_sink && budget_override.is_none() {
        return capped;
    }

    if let Some(budget_bytes) = budget_override {
        let allowed = (budget_bytes / bytes_per_mask.max(1)).max(1);
        capped = capped.min(allowed);
    }

    // Concurrency caps for large raw-mask layers.  The goal is to keep peak
    // raster-buffer memory (max_concurrent × bytes_per_mask) reasonable while
    // still saturating available cores.
    //
    // In streaming 3DAA mode the consumer callback (topology sweep + BFS dispatch)
    // frees each mask quickly, but the pump processes layers sequentially, so
    // measured avg-parallelism at 8K–12K is typically 2–3× even with 8 workers.
    // Capping at 4 for the largest frames captures the same effective throughput
    // while halving the peak in-flight mask memory:
    //
    // Rough peak: (max_concurrent + buffer) × bytes_per_mask
    //   48 MB × (4+4) = 384 MB  (was 8+8 = 768 MB)
    //   59 MB × (4+4) = 472 MB  (was 8+8 = 944 MB)
    //   74 MB × (4+4) = 592 MB  (was 8+8 = 1184 MB)
    if budget_override.is_none() {
        if bytes_per_mask >= 48 * 1024 * 1024 {
            // 8K–12K class: pump-bound pipeline makes avg effective parallelism
            // ~2–3×, so 4 workers is more than enough to saturate the rasteriser.
            // This halves the raster-phase mask memory (was 8+8=16 masks × 59 MB).
            capped = capped.min(4);
        } else if bytes_per_mask >= 24 * 1024 * 1024 {
            capped = capped.min(6);
        } else if bytes_per_mask >= 12 * 1024 * 1024 {
            capped = capped.min(8);
        }
    }

    capped.max(1)
}

fn choose_streaming_buffer_depth_for_mask_bytes(
    layer_pixels_len: usize,
    max_concurrent: usize,
) -> usize {
    let bytes_per_mask = layer_pixels_len;
    if let Ok(v) = std::env::var("DF_V3_STREAMING_BUFFER_DEPTH") {
        if let Ok(parsed) = v.parse::<usize>() {
            return parsed.clamp(1, 32);
        }
    }
    if bytes_per_mask >= 48 * 1024 * 1024 {
        // 8K-12K-class: cap at 4 to match the reduced raster_concurrent cap.
        // With raster_concurrent=4 and buffer=4, peak = 8 × 59 MB = 472 MB
        // (down from 8+8=16 × 59 MB = 944 MB with the old caps).
        max_concurrent.clamp(2, 4)
    } else if bytes_per_mask >= 24 * 1024 * 1024 {
        4
    } else {
        4
    }
}

/// Render all layers into requested payload buffers while preserving order.
pub fn render_layers_bounded(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_index: &LayerIndex,
    compute_area_stats: bool,
    emit_png_layers: bool,
    emit_raw_mask_layers: bool,
    mut on_raw_mask_layer: Option<
        &mut dyn FnMut(u32, Vec<u8>, LayerAreaStatsV3) -> Result<(), SlicerV3Error>,
    >,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    let render_wall_start = std::time::Instant::now();
    let total_layers = job.total_layers;

    let layer_pixels =
        (job.effective_render_width_px() as usize).saturating_mul(job.source_height_px as usize);
    let mut max_concurrent = choose_max_concurrent();

    let need_raw_masks = emit_raw_mask_layers || on_raw_mask_layer.is_some();
    // When PNG layers are needed but raw pixel masks are not, we can take the
    // fast path: `rasterize_layer_rle` (O(width) memory) + direct deflate
    // PNG encoder, avoiding the 56 MB full-frame pixel buffer entirely.
    let use_rle_png_path = emit_png_layers && !need_raw_masks;

    // For high-resolution renders that materialise full pixel masks, reduce
    // thread count to avoid memory explosion.  The RLE-PNG path never
    // allocates these masks, so it can use all available cores.
    if !use_rle_png_path && layer_pixels > 12_000_000 && max_concurrent > 2 {
        // 12M pixels ≈ 4000x3000. For each extra concurrent worker with a 56MB
        // mask (plus potential PNG encoding), memory usage grows rapidly.
        max_concurrent = max_concurrent / 2;
    }

    let streaming_raw_mask_sink = on_raw_mask_layer.is_some() && !emit_raw_mask_layers;
    max_concurrent =
        cap_concurrency_for_mask_bytes(max_concurrent, layer_pixels, streaming_raw_mask_sink);

    // RLE-PNG path produces tiny channel messages (small Vec<u8> PNGs), so it
    // can use a generous buffer matching render_layers_rle.  Streaming raw
    // masks need a tight buffer to avoid accumulating 56MB masks.
    let buffer = if streaming_raw_mask_sink {
        choose_streaming_buffer_depth_for_mask_bytes(layer_pixels, max_concurrent)
    } else if use_rle_png_path {
        (max_concurrent * 4).clamp(4, 64)
    } else {
        (max_concurrent * 2).clamp(2, 16)
    };

    let progress = AtomicU32::new(0);
    let raster_ns = AtomicU64::new(0);
    let raw_geometry_ns = AtomicU64::new(0);
    let raw_scanline_ns = AtomicU64::new(0);
    let png_ns = AtomicU64::new(0);
    let layer_pixels_len =
        (job.effective_render_width_px() as usize) * (job.source_height_px as usize);
    let binary_png_expected = job.produces_binary_output();

    let empty_png_cache = emit_png_layers.then(|| Mutex::<Option<Vec<u8>>>::new(None));
    let full_png_cache = emit_png_layers.then(|| Mutex::<Option<Vec<u8>>>::new(None));

    let progress_on_drain = streaming_raw_mask_sink;

    let mut out_pngs = emit_png_layers.then(|| vec![Vec::<u8>::new(); total_layers as usize]);
    let mut out_masks = emit_raw_mask_layers.then(|| vec![Vec::<u8>::new(); total_layers as usize]);
    let mut area_stats = vec![LayerAreaStatsV3::default(); total_layers as usize];
    let (tx, rx) = std::sync::mpsc::sync_channel::<
        Result<(u32, Option<Vec<u8>>, Option<Vec<u8>>, LayerAreaStatsV3), SlicerV3Error>,
    >(buffer);

    let mut pipeline_error: Result<(), SlicerV3Error> = Ok(());
    rayon::in_place_scope(|s| {
        s.spawn(|_| {
            let produce = |tx: std::sync::mpsc::SyncSender<
                Result<(u32, Option<Vec<u8>>, Option<Vec<u8>>, LayerAreaStatsV3), SlicerV3Error>,
            >| {
                let result = for_each_layer_group(total_layers, max_concurrent,
                    crate::raster::raw_binary_geometry_eligible(job, triangles.len()), |start, end| {
                    for_each_rendered_layer(
                        job, triangles, layer_index, start, end, None, Backend::detected(),
                        compute_area_stats, !use_rle_png_path, cancel_flag,
                        &raster_ns, &raw_geometry_ns, &raw_scanline_ns, |layer, prepared| {
                        let result = (|| -> Result<
                            (u32, Option<Vec<u8>>, Option<Vec<u8>>, LayerAreaStatsV3),
                            SlicerV3Error,
                        > {
                            if cancel_flag
                                .map(|flag| flag.load(Ordering::Relaxed))
                                .unwrap_or(false)
                            {
                                return Err(SlicerV3Error::Cancelled);
                            }

                            let layer_candidates = layer_index.candidates_for_layer(layer);

                            if layer_candidates.is_empty() {
                                let stats = LayerAreaStatsV3::default();
                                let png = if emit_png_layers {
                                    let png_start = std::time::Instant::now();
                                    let bytes = encode_uniform_png_cached(
                                        job.effective_render_width_px(),
                                        job.source_height_px,
                                        &job.png_compression_strategy,
                                        0,
                                        empty_png_cache.as_ref().expect(
                                            "png cache should exist when PNG output is enabled",
                                        ),
                                    )?;
                                    png_ns.fetch_add(
                                        png_start.elapsed().as_nanos() as u64,
                                        Ordering::Relaxed,
                                    );
                                    Some(bytes)
                                } else {
                                    None
                                };

                                let raw_mask = if need_raw_masks {
                                    if streaming_raw_mask_sink {
                                        // Sentinel for guaranteed-empty layer in streaming mode:
                                        // CTB workers can encode a full black run without
                                        // materializing a full-size zero mask.
                                        Some(Vec::new())
                                    } else {
                                        Some(crate::pipeline::get_recycled_mask(layer_pixels_len))
                                    }
                                } else {
                                    None
                                };

                                return Ok((layer, png, raw_mask, stats));
                            }

                            // ── Fast path: RLE rasteriser + streaming PNG ──
                            if use_rle_png_path {
                                let raster_start = prepared.is_none().then(std::time::Instant::now);
                                let (runs, stats) = if let Some(prepared) = prepared {
                                    let (runs, _, stats) = prepared.into_rle();
                                    (runs, stats)
                                } else {
                                    rasterize_layer_rle(job, triangles, layer_candidates, layer, compute_area_stats)
                                };
                                if let Some(start) = raster_start {
                                    raster_ns.fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                                }
                                let png_start = std::time::Instant::now();
                                let png = crate::encode::encode_grayscale_png_from_rle(
                                    job.effective_render_width_px(),
                                    job.source_height_px,
                                    &runs,
                                    &job.png_compression_strategy,
                                    binary_png_expected,
                                )?;
                                png_ns.fetch_add(
                                    png_start.elapsed().as_nanos() as u64,
                                    Ordering::Relaxed,
                                );
                                return Ok((layer, Some(png), None, stats));
                            }

                            let raster_start = prepared.is_none().then(std::time::Instant::now);
                            let (mask, stats) = if let Some(prepared) = prepared {
                                let (mut mask, stats) = prepared.into_mask();
                                let post_start = std::time::Instant::now();
                                let stats = crate::raster::postprocess_binary_mask(job, &mut mask, stats, compute_area_stats);
                                raster_ns.fetch_add(post_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                                (mask, stats)
                            } else {
                                rasterize_layer_with_stats(job, triangles, layer_candidates, layer, compute_area_stats)
                            };
                            if let Some(start) = raster_start {
                                raster_ns.fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                            }

                            let png = if emit_png_layers {
                                let png_start = std::time::Instant::now();
                                let is_all_black = stats.total_solid_pixels == 0;
                                let is_all_white = compute_area_stats
                                    && (stats.total_solid_pixels as usize == layer_pixels_len);

                                let png = if is_all_black {
                                    encode_uniform_png_cached(
                                        job.effective_render_width_px(),
                                        job.source_height_px,
                                        &job.png_compression_strategy,
                                        0,
                                        empty_png_cache.as_ref().expect(
                                            "png cache should exist when PNG output is enabled",
                                        ),
                                    )?
                                } else if is_all_white {
                                    encode_uniform_png_cached(
                                        job.effective_render_width_px(),
                                        job.source_height_px,
                                        &job.png_compression_strategy,
                                        255,
                                        full_png_cache.as_ref().expect(
                                            "png cache should exist when PNG output is enabled",
                                        ),
                                    )?
                                } else if binary_png_expected {
                                    encode_binary_grayscale_png_1bit(
                                        job.effective_render_width_px(),
                                        job.source_height_px,
                                        &mask,
                                        &job.png_compression_strategy,
                                    )?
                                } else {
                                    encode_grayscale_png(
                                        job.effective_render_width_px(),
                                        job.source_height_px,
                                        &mask,
                                        &job.png_compression_strategy,
                                        false,
                                    )?
                                };
                                png_ns.fetch_add(
                                    png_start.elapsed().as_nanos() as u64,
                                    Ordering::Relaxed,
                                );
                                Some(png)
                            } else {
                                None
                            };

                            let raw_mask = if need_raw_masks { Some(mask) } else { None };

                            Ok((layer, png, raw_mask, stats))
                        })();
                        let output = result?;
                        tx.send(Ok(output)).map_err(|_| SlicerV3Error::Cancelled)
                    })
                });
                if let Err(error) = result { let _ = tx.send(Err(error)); }
            };

            match ThreadPoolBuilder::new().num_threads(max_concurrent).build() {
                Ok(pool) => {
                    pool.install(|| produce(tx));
                }
                Err(_) => {
                    produce(tx);
                }
            }
        });

        let mut pending: Vec<Option<(Option<Vec<u8>>, Option<Vec<u8>>, LayerAreaStatsV3)>> =
            Vec::with_capacity(total_layers as usize);
        pending.resize_with(total_layers as usize, || None);
        let mut next = 0u32;
        for msg in &rx {
            if pipeline_error.is_err() {
                continue;
            }
            match msg {
                Err(e) => pipeline_error = Err(e),
                Ok((layer, png, raw_mask, stats)) => {
                    // In streaming mode, report progress when layers are actually
                    // drained and consumed by the sink (encode work complete).
                    // In non-streaming mode, report on arrival for responsive UI.
                    if !progress_on_drain {
                        let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
                        if let Some(ref cb) = on_progress {
                            cb(SliceProgressUpdateV3 {
                                done,
                                total: total_layers,
                                phase: SliceProgressPhaseV3::Slicing,
                            });
                        }
                    }

                    pending[layer as usize] = Some((png, raw_mask, stats));
                    while next < total_layers {
                        let Some((png, raw_mask, stats)) = pending[next as usize].take() else {
                            break;
                        };
                        if let (Some(ref mut out), Some(png)) = (out_pngs.as_mut(), png) {
                            out[next as usize] = png;
                        }
                        match (out_masks.as_mut(), raw_mask) {
                            (Some(out), Some(mask)) => {
                                out[next as usize] = mask;
                            }
                            (None, Some(mask)) => {
                                if let Some(ref mut sink) = on_raw_mask_layer {
                                    if let Err(err) = sink(next, mask, stats.clone()) {
                                        pipeline_error = Err(err);
                                        break;
                                    }
                                }
                            }
                            _ => {}
                        }
                        area_stats[next as usize] = stats;
                        if cancel_flag
                            .map(|flag| flag.load(Ordering::Relaxed))
                            .unwrap_or(false)
                        {
                            pipeline_error = Err(SlicerV3Error::Cancelled);
                            break;
                        }

                        if progress_on_drain {
                            let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
                            if let Some(ref cb) = on_progress {
                                cb(SliceProgressUpdateV3 {
                                    done,
                                    total: total_layers,
                                    phase: SliceProgressPhaseV3::Slicing,
                                });
                            }
                        }

                        next += 1;
                    }
                }
            }
        }
    });

    pipeline_error?;

    let perf = SlicingPerfV3 {
        render_wall_ns: render_wall_start.elapsed().as_nanos() as u64,
        render_ns: raster_ns.load(Ordering::Relaxed),
        raw_geometry_ns: raw_geometry_ns.load(Ordering::Relaxed),
        raw_scanline_ns: raw_scanline_ns.load(Ordering::Relaxed),
        png_encode_ns: png_ns.load(Ordering::Relaxed),
        layers: total_layers,
        ..Default::default()
    };

    Ok((
        RenderedLayersV3 {
            png_layers: out_pngs,
            raw_mask_layers: out_masks,
        },
        area_stats,
        perf,
    ))
}

/// Parallel pipeline that calls `rasterize_layer_rle()` and delivers
/// `Vec<RleRun>` per layer in display order — no full-image mask buffer needed.
pub fn render_layers_rle(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_index: &LayerIndex,
    compute_area_stats: bool,
    support_split_model_triangle_count: Option<usize>,
    on_rle_layer: impl FnMut(u32, Vec<RleRun>, Option<Vec<RleRun>>) -> Result<(), SlicerV3Error>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    render_layers_rle_with_execution(
        job, triangles, layer_index, compute_area_stats, support_split_model_triangle_count,
        on_rle_layer, on_progress, cancel_flag, choose_max_concurrent(), Backend::detected(),
    )
}

fn render_layers_rle_with_execution(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_index: &LayerIndex,
    compute_area_stats: bool,
    support_split_model_triangle_count: Option<usize>,
    mut on_rle_layer: impl FnMut(u32, Vec<RleRun>, Option<Vec<RleRun>>) -> Result<(), SlicerV3Error>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
    max_concurrent: usize,
    backend: Backend,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    let render_wall_start = std::time::Instant::now();
    let total_layers = job.total_layers;
    // RLE output is small; allow a generous channel buffer so producers stay fed.
    let buffer = (max_concurrent * 4).clamp(4, 64);

    let raster_ns = AtomicU64::new(0);
    let raw_geometry_ns = AtomicU64::new(0);
    let raw_scanline_ns = AtomicU64::new(0);
    let progress = AtomicU32::new(0);
    let support_split_model_triangle_count =
        support_split_model_triangle_count.filter(|&count| count > 0 && count < triangles.len());
    let split_jobs = PerturbSupportSplitJobs::for_job(job, support_split_model_triangle_count);
    let split_jobs = split_jobs.as_ref();

    let (tx, rx) = std::sync::mpsc::sync_channel::<
        Result<(u32, Vec<RleRun>, Option<Vec<RleRun>>, LayerAreaStatsV3), SlicerV3Error>,
    >(buffer);

    let mut pipeline_error: Result<(), SlicerV3Error> = Ok(());
    let mut area_stats = vec![LayerAreaStatsV3::default(); total_layers as usize];

    rayon::in_place_scope(|s| {
        s.spawn(|_| {
            let produce = |tx: std::sync::mpsc::SyncSender<
                Result<(u32, Vec<RleRun>, Option<Vec<RleRun>>, LayerAreaStatsV3), SlicerV3Error>,
            >| {
                let result = for_each_layer_group(total_layers, max_concurrent,
                    crate::raster::raw_binary_geometry_eligible(job, triangles.len()), |start, end| {
                    for_each_rendered_layer(
                        job, triangles, layer_index, start, end, support_split_model_triangle_count, backend,
                        compute_area_stats, false, cancel_flag,
                        &raster_ns, &raw_geometry_ns, &raw_scanline_ns, |layer, prepared| {
                        let result =
                            (|| -> Result<
                                (u32, Vec<RleRun>, Option<Vec<RleRun>>, LayerAreaStatsV3),
                                SlicerV3Error,
                            > {
                                if cancel_flag
                                    .map(|flag| flag.load(Ordering::Relaxed))
                                    .unwrap_or(false)
                                {
                                    return Err(SlicerV3Error::Cancelled);
                                }

                                let layer_candidates = layer_index.candidates_for_layer(layer);
                                let raster_start = prepared.is_none().then(std::time::Instant::now);
                                let (runs, support_runs, stats) =
                                    if let Some(prepared) = prepared {
                                        prepared.into_rle()
                                    } else if let Some(model_triangle_count) = support_split_model_triangle_count {
                                        rasterize_layer_rle_with_support_split(
                                            job,
                                            triangles,
                                            layer_candidates,
                                            layer,
                                            compute_area_stats,
                                            model_triangle_count,
                                            split_jobs,
                                        )
                                    } else {
                                        let (runs, stats) = rasterize_layer_rle(
                                            job,
                                            triangles,
                                            layer_candidates,
                                            layer,
                                            compute_area_stats,
                                        );
                                        (runs, None, stats)
                                    };
                                if let Some(start) = raster_start {
                                    raster_ns.fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                                }

                                Ok((layer, runs, support_runs, stats))
                            })();
                        let output = result?;
                        tx.send(Ok(output)).map_err(|_| SlicerV3Error::Cancelled)
                    })
                });
                if let Err(error) = result { let _ = tx.send(Err(error)); }
            };

            match ThreadPoolBuilder::new().num_threads(max_concurrent).build() {
                Ok(pool) => pool.install(|| produce(tx)),
                Err(_) => produce(tx),
            }
        });

        let mut pending: Vec<Option<(Vec<RleRun>, Option<Vec<RleRun>>, LayerAreaStatsV3)>> =
            Vec::with_capacity(total_layers as usize);
        pending.resize_with(total_layers as usize, || None);
        let mut next = 0u32;

        for msg in &rx {
            if pipeline_error.is_err() {
                continue;
            }
            match msg {
                Err(e) => pipeline_error = Err(e),
                Ok((layer, runs, support_runs, stats)) => {
                    pending[layer as usize] = Some((runs, support_runs, stats));
                    // Report on arrival so progress reflects actual work done,
                    // not just the contiguous drain position.
                    let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(ref cb) = on_progress {
                        cb(SliceProgressUpdateV3 {
                            done,
                            total: total_layers,
                            phase: SliceProgressPhaseV3::Slicing,
                        });
                    }

                    while next < total_layers {
                        let Some((runs, support_runs, stats)) = pending[next as usize].take()
                        else {
                            break;
                        };
                        if let Err(e) = on_rle_layer(next, runs, support_runs) {
                            pipeline_error = Err(e);
                            break;
                        }
                        area_stats[next as usize] = stats;
                        if cancel_flag
                            .map(|flag| flag.load(Ordering::Relaxed))
                            .unwrap_or(false)
                        {
                            pipeline_error = Err(SlicerV3Error::Cancelled);
                            break;
                        }
                        next += 1;
                    }
                }
            }
        }
    });

    pipeline_error?;

    let perf = SlicingPerfV3 {
        render_wall_ns: render_wall_start.elapsed().as_nanos() as u64,
        render_ns: raster_ns.load(Ordering::Relaxed),
        raw_geometry_ns: raw_geometry_ns.load(Ordering::Relaxed),
        raw_scanline_ns: raw_scanline_ns.load(Ordering::Relaxed),
        layers: total_layers,
        ..Default::default()
    };

    Ok((
        RenderedLayersV3 {
            png_layers: None,
            raw_mask_layers: None,
        },
        area_stats,
        perf,
    ))
}

/// Parallel pipeline that rasterises AND encodes each layer inside rayon
/// workers.  The serial drain receives pre-encoded `Vec<u8>` (e.g. PNG
/// bytes) and simply stores them, eliminating the serial encode bottleneck.
pub fn render_layers_rle_encoded(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_index: &LayerIndex,
    compute_area_stats: bool,
    support_split_model_triangle_count: Option<usize>,
    encode_fn: std::sync::Arc<
        dyn Fn(u32, &[RleRun], Option<&[RleRun]>) -> Result<Vec<u8>, SlicerV3Error> + Send + Sync,
    >,
    mut on_encoded_layer: impl FnMut(u32, Vec<u8>) -> Result<(), SlicerV3Error>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    let render_wall_start = std::time::Instant::now();
    let total_layers = job.total_layers;
    let max_concurrent = choose_max_concurrent();
    let buffer = (max_concurrent * 4).clamp(4, 64);

    let raster_ns = AtomicU64::new(0);
    let raw_geometry_ns = AtomicU64::new(0);
    let raw_scanline_ns = AtomicU64::new(0);
    let encode_ns = AtomicU64::new(0);
    let progress = AtomicU32::new(0);
    let support_split_model_triangle_count =
        support_split_model_triangle_count.filter(|&count| count > 0 && count < triangles.len());
    let split_jobs = PerturbSupportSplitJobs::for_job(job, support_split_model_triangle_count);
    let split_jobs = split_jobs.as_ref();

    let (tx, rx) = std::sync::mpsc::sync_channel::<
        Result<(u32, Vec<u8>, LayerAreaStatsV3), SlicerV3Error>,
    >(buffer);

    let mut pipeline_error: Result<(), SlicerV3Error> = Ok(());
    let mut area_stats = vec![LayerAreaStatsV3::default(); total_layers as usize];

    rayon::in_place_scope(|s| {
        s.spawn(|_| {
            let produce = |tx: std::sync::mpsc::SyncSender<
                Result<(u32, Vec<u8>, LayerAreaStatsV3), SlicerV3Error>,
            >| {
                let encode_fn = &encode_fn;
                let result = for_each_layer_group(total_layers, max_concurrent,
                    crate::raster::raw_binary_geometry_eligible(job, triangles.len()), |start, end| {
                    for_each_rendered_layer(
                        job, triangles, layer_index, start, end, support_split_model_triangle_count, Backend::detected(),
                        compute_area_stats, false, cancel_flag,
                        &raster_ns, &raw_geometry_ns, &raw_scanline_ns, |layer, prepared| {
                        let result =
                            (|| -> Result<(u32, Vec<u8>, LayerAreaStatsV3), SlicerV3Error> {
                                if cancel_flag
                                    .map(|flag| flag.load(Ordering::Relaxed))
                                    .unwrap_or(false)
                                {
                                    return Err(SlicerV3Error::Cancelled);
                                }

                                let layer_candidates = layer_index.candidates_for_layer(layer);
                                let raster_start = prepared.is_none().then(std::time::Instant::now);
                                let (runs, support_runs, stats) =
                                    if let Some(prepared) = prepared {
                                        prepared.into_rle()
                                    } else if let Some(model_triangle_count) = support_split_model_triangle_count {
                                        rasterize_layer_rle_with_support_split(
                                            job,
                                            triangles,
                                            layer_candidates,
                                            layer,
                                            compute_area_stats,
                                            model_triangle_count,
                                            split_jobs,
                                        )
                                    } else {
                                        let (runs, stats) = rasterize_layer_rle(
                                            job,
                                            triangles,
                                            layer_candidates,
                                            layer,
                                            compute_area_stats,
                                        );
                                        (runs, None, stats)
                                    };
                                if let Some(start) = raster_start {
                                    raster_ns.fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                                }

                                let encode_start = std::time::Instant::now();
                                let bytes = encode_fn(layer, &runs, support_runs.as_deref())?;
                                encode_ns.fetch_add(
                                    encode_start.elapsed().as_nanos() as u64,
                                    Ordering::Relaxed,
                                );

                                Ok((layer, bytes, stats))
                            })();
                        let output = result?;
                        tx.send(Ok(output)).map_err(|_| SlicerV3Error::Cancelled)
                    })
                });
                if let Err(error) = result { let _ = tx.send(Err(error)); }
            };

            match ThreadPoolBuilder::new().num_threads(max_concurrent).build() {
                Ok(pool) => pool.install(|| produce(tx)),
                Err(_) => produce(tx),
            }
        });

        let mut pending: Vec<Option<(Vec<u8>, LayerAreaStatsV3)>> =
            Vec::with_capacity(total_layers as usize);
        pending.resize_with(total_layers as usize, || None);
        let mut next = 0u32;

        for msg in &rx {
            if pipeline_error.is_err() {
                continue;
            }
            match msg {
                Err(e) => pipeline_error = Err(e),
                Ok((layer, bytes, stats)) => {
                    pending[layer as usize] = Some((bytes, stats));

                    // Report on arrival so progress reflects actual work done,
                    // not just the contiguous drain position.
                    let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(ref cb) = on_progress {
                        cb(SliceProgressUpdateV3 {
                            done,
                            total: total_layers,
                            phase: SliceProgressPhaseV3::Slicing,
                        });
                    }

                    while next < total_layers {
                        let Some((bytes, stats)) = pending[next as usize].take() else {
                            break;
                        };
                        if let Err(e) = on_encoded_layer(next, bytes) {
                            pipeline_error = Err(e);
                            break;
                        }
                        area_stats[next as usize] = stats;
                        if cancel_flag
                            .map(|flag| flag.load(Ordering::Relaxed))
                            .unwrap_or(false)
                        {
                            pipeline_error = Err(SlicerV3Error::Cancelled);
                            break;
                        }
                        next += 1;
                    }
                }
            }
        }
    });

    pipeline_error?;

    let perf = SlicingPerfV3 {
        render_wall_ns: render_wall_start.elapsed().as_nanos() as u64,
        render_ns: raster_ns.load(Ordering::Relaxed),
        raw_geometry_ns: raw_geometry_ns.load(Ordering::Relaxed),
        raw_scanline_ns: raw_scanline_ns.load(Ordering::Relaxed),
        png_encode_ns: encode_ns.load(Ordering::Relaxed),
        layers: total_layers,
        ..Default::default()
    };

    Ok((
        RenderedLayersV3 {
            png_layers: None,
            raw_mask_layers: None,
        },
        area_stats,
        perf,
    ))
}

/// One delivered payload for a (layer, block) pair on the block-partitioned
/// RLE path: either window-relative runs, or bytes pre-encoded inside a
/// parallel worker by `RleStreamEncoder::parallel_encode_block_fn`.
pub enum RleBlockPayload {
    Runs(Vec<RleRun>),
    Encoded(Vec<u8>),
}

/// Bounded groups retain scalar geometry across windows and render the same
/// block across independent real layers. The producer's RAW timer excludes
/// postprocessing, format encoding and channel waits.
pub(crate) fn render_layers_rle_blocks(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_index: &LayerIndex,
    support_split: Option<usize>,
    produce_layers: impl Fn(Vec<(u32, Option<LayerSegments>)>)
        -> Result<(Vec<(u32, Vec<RleBlockPayload>, LayerAreaStatsV3)>, u64), SlicerV3Error> + Sync,
    mut on_block: impl FnMut(u32, u32, RleBlockPayload) -> Result<(), SlicerV3Error>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    let render_wall_start = std::time::Instant::now();
    let total_layers = job.total_layers;
    let max_concurrent = choose_max_concurrent();
    let buffer = (max_concurrent * 4).clamp(4, 64);

    let raster_ns = AtomicU64::new(0);
    let raw_geometry_ns = AtomicU64::new(0);
    let raw_scanline_ns = AtomicU64::new(0);
    let progress = AtomicU32::new(0);

    let (tx, rx) = std::sync::mpsc::sync_channel::<
        Result<(u32, Vec<RleBlockPayload>, LayerAreaStatsV3), SlicerV3Error>,
    >(buffer);

    let mut pipeline_error: Result<(), SlicerV3Error> = Ok(());
    let mut area_stats = vec![LayerAreaStatsV3::default(); total_layers as usize];

    rayon::in_place_scope(|s| {
        s.spawn(|_| {
            let produce = |tx: std::sync::mpsc::SyncSender<
                Result<(u32, Vec<RleBlockPayload>, LayerAreaStatsV3), SlicerV3Error>,
            >| {
                let eligible = crate::raster::raw_binary_geometry_eligible(job, triangles.len());
                let result = for_each_layer_group(total_layers, max_concurrent, eligible, |start, end| {
                    if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                        return Err(SlicerV3Error::Cancelled);
                    }
                    let layers = if eligible {
                        prepare_raw_layers(job, triangles, layer_index, start, end, support_split,
                            cancel_flag, &raster_ns, &raw_geometry_ns)?
                            .into_iter().map(|layer| (layer.layer_index, Some(layer))).collect()
                    } else {
                        (start..end).map(|layer| (layer, None)).collect()
                    };
                    let raster_start = std::time::Instant::now();
                    let (outputs, scanline_ns) = produce_layers(layers)?;
                    raster_ns.fetch_add(raster_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                    raw_scanline_ns.fetch_add(scanline_ns, Ordering::Relaxed);
                    outputs.into_par_iter().try_for_each(|output| {
                        tx.send(Ok(output)).map_err(|_| SlicerV3Error::Cancelled)
                    })
                });
                if let Err(error) = result { let _ = tx.send(Err(error)); }
            };

            match ThreadPoolBuilder::new().num_threads(max_concurrent).build() {
                Ok(pool) => pool.install(|| produce(tx)),
                Err(_) => produce(tx),
            }
        });

        let mut pending: Vec<Option<(Vec<RleBlockPayload>, LayerAreaStatsV3)>> =
            Vec::with_capacity(total_layers as usize);
        pending.resize_with(total_layers as usize, || None);
        let mut next = 0u32;

        for msg in &rx {
            if pipeline_error.is_err() {
                continue;
            }
            match msg {
                Err(e) => pipeline_error = Err(e),
                Ok((layer, payloads, stats)) => {
                    pending[layer as usize] = Some((payloads, stats));
                    let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(ref cb) = on_progress {
                        cb(SliceProgressUpdateV3 {
                            done,
                            total: total_layers,
                            phase: SliceProgressPhaseV3::Slicing,
                        });
                    }

                    while next < total_layers {
                        let Some((payloads, stats)) = pending[next as usize].take() else {
                            break;
                        };
                        for (block_index, payload) in payloads.into_iter().enumerate() {
                            if let Err(e) = on_block(next, block_index as u32, payload) {
                                pipeline_error = Err(e);
                                break;
                            }
                        }
                        if pipeline_error.is_err() {
                            break;
                        }
                        area_stats[next as usize] = stats;
                        if cancel_flag
                            .map(|flag| flag.load(Ordering::Relaxed))
                            .unwrap_or(false)
                        {
                            pipeline_error = Err(SlicerV3Error::Cancelled);
                            break;
                        }
                        next += 1;
                    }
                }
            }
        }
    });

    pipeline_error?;

    let perf = SlicingPerfV3 {
        render_wall_ns: render_wall_start.elapsed().as_nanos() as u64,
        render_ns: raster_ns.load(Ordering::Relaxed),
        raw_geometry_ns: raw_geometry_ns.load(Ordering::Relaxed),
        raw_scanline_ns: raw_scanline_ns.load(Ordering::Relaxed),
        layers: total_layers,
        ..Default::default()
    };

    Ok((area_stats, perf))
}

#[cfg(test)]
mod raw_consumer_tests {
    use super::*;
    use crate::geometry::{parse_triangles, project_triangles_inplace};
    use crate::raster::{push_segment_for_triangle_at_z, rasterize_binary_layer_rle_block_from_segments};
    use crate::rle::{expand_rle_to_mask, make_rle_block};
    use std::sync::Arc;

    fn add_box(xyz: &mut Vec<f32>, x0: f32, x1: f32, y0: f32, y1: f32, z0: f32, z1: f32) {
        let vertices = [[x0,y0,z0], [x1,y0,z0], [x1,y1,z0], [x0,y1,z0],
            [x0,y0,z1], [x1,y0,z1], [x1,y1,z1], [x0,y1,z1]];
        for [a,b,c] in [[0,1,2], [0,2,3], [4,6,5], [4,7,6], [0,4,5], [0,5,1],
            [1,5,6], [1,6,2], [2,6,7], [2,7,3], [3,7,4], [3,4,0]] {
            for vertex in [a,b,c] { xyz.extend_from_slice(&vertices[vertex]); }
        }
    }

    fn fixture(mirror_x: bool, mirror_y: bool) -> (SliceJobV3, Vec<Triangle>, LayerIndex, usize) {
        let mut job = SliceJobV3 {
            source_width_px: 17, source_height_px: 13, width_px: 17, height_px: 13,
            build_width_mm: 16.0, build_depth_mm: 12.0, layer_height_mm: 1.0,
            total_layers: 11, anti_aliasing_level: "Off".into(), anti_aliasing_mode: "Coverage".into(),
            blur_brush_radius_px: 0, aa_on_supports: true, mirror_x, mirror_y,
            png_compression_strategy: "fastest".into(), ..Default::default()
        };
        add_box(&mut job.triangles_xyz, -5.5, -5.4, -4.0, 3.0, 0.5, 2.5);
        add_box(&mut job.triangles_xyz, -4.0, 1.5, -3.0, 4.0, 0.0, 8.5);
        add_box(&mut job.triangles_xyz, -1.0, 4.0, -4.0, 2.0, 1.5, 7.5);
        add_box(&mut job.triangles_xyz, 5.0, 7.0, 2.0, 5.0, 0.0, 11.0);
        // An inverted wall exercises the real winding repair, not only healthy unions.
        for axis in 0..3 { job.triangles_xyz.swap(6 * 9 + 3 + axis, 6 * 9 + 6 + axis); }
        let split = job.triangles_xyz.len() / 9;
        job.model_triangle_count = split as u32;
        add_box(&mut job.triangles_xyz, -2.0, 6.0, -1.0, 1.0, 0.0, 11.0);
        job.triangles_xyz.extend_from_slice(&[0.0,0.0,0.5, 1.0,1.0,0.5, 2.0,2.0,0.5]);
        let mut triangles = parse_triangles(&job.triangles_xyz);
        project_triangles_inplace(&mut triangles, &job);
        let all: Vec<usize> = (0..triangles.len()).rev().collect();
        let mut permuted = all.clone();
        permuted.rotate_left(7);
        permuted.extend_from_slice(&[6, 6, split + 6]);
        let buckets = vec![all.clone(), permuted.clone(), vec![6], all.clone(), vec![],
            permuted, vec![split + 6, split + 7], all, vec![],
            (split..triangles.len()).collect(), vec![triangles.len() - 1]];
        (job, triangles, LayerIndex::Dense(buckets), split)
    }

    fn scalar_layer(job: &SliceJobV3, triangles: &[Triangle], candidates: &[usize],
        layer_index: u32, split: Option<usize>) -> LayerSegments {
        let mut model = Vec::new();
        let mut support = None;
        let mut model_candidates = 0;
        for &candidate in candidates {
            let output = if split.is_some_and(|split| candidate >= split) {
                support.get_or_insert_with(Vec::new)
            } else {
                model_candidates += 1;
                &mut model
            };
            push_segment_for_triangle_at_z(job, &triangles[candidate],
                (layer_index as f32 + 0.5) * job.layer_height_mm, output);
        }
        LayerSegments { layer_index, model_candidates, model, support }
    }

    fn assert_stats(actual: &LayerAreaStatsV3, expected: &LayerAreaStatsV3) {
        assert_eq!(serde_json::to_value(actual).unwrap(), serde_json::to_value(expected).unwrap());
    }

    #[test]
    fn raw_rle_consumers_match_scalar_all_backends_splits_indices_low_caps_and_tails() {
        for mirror in [(false,false), (true,false), (false,true), (true,true)] {
            let (job, triangles, index, split) = fixture(mirror.0, mirror.1);
            let banded = match &index {
                LayerIndex::Dense(buckets) => LayerIndex::Banded { band_size_layers: 1, bands: buckets.clone() },
                _ => unreachable!(),
            };
            for index in [&index, &banded] {
                for split in [None, Some(split)] {
                    for compute_area_stats in [false, true] {
                        let golden: Vec<_> = (0..job.total_layers).map(|layer| {
                            let segments = scalar_layer(&job, &triangles, index.candidates_for_layer(layer), layer, split);
                            rasterize_raw_layer_segments(&job, &segments, compute_area_stats)
                        }).collect();
                        for backend in Backend::supported_for_tests() {
                            for cap in [1, 2, 3, 8] {
                                let completions = Arc::new(Mutex::new(Vec::new()));
                                let recorded = Arc::clone(&completions);
                                let total = job.total_layers;
                                let progress: ProgressCallbackV3 = Arc::new(move |update| {
                                    assert_eq!(update.total, total);
                                    assert_eq!(update.phase, SliceProgressPhaseV3::Slicing);
                                    recorded.lock().unwrap().push(update.done);
                                });
                                let mut next = 0;
                                let (_, stats, _) = render_layers_rle_with_execution(
                                    &job, &triangles, index, compute_area_stats, split,
                                    |layer, runs, support| {
                                        assert_eq!(layer, next);
                                        assert_eq!(runs, golden[layer as usize].0, "{backend:?}, cap={cap}, layer={layer}");
                                        assert_eq!(support, golden[layer as usize].1);
                                        assert!(runs.iter().all(|run| run.value == 0 || run.value == 255));
                                        assert_eq!(expand_rle_to_mask(&runs, 17*13),
                                            expand_rle_to_mask(&golden[layer as usize].0, 17*13));
                                        next += 1;
                                        Ok(())
                                    }, Some(progress), None, cap, backend,
                                ).unwrap();
                                assert_eq!(next, job.total_layers);
                                assert_eq!(*completions.lock().unwrap(), (1..=job.total_layers).collect::<Vec<_>>());
                                for (actual, expected) in stats.iter().zip(&golden) { assert_stats(actual, &expected.2); }
                            }
                        }
                        if split.is_some() {
                            assert!(golden[10].1.as_ref().unwrap().iter().all(|run| run.value == 0));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn raw_pipeline_low_cap_sink_errors_and_cancellation_stop_ordered_drain() {
        let (job, triangles, index, split) = fixture(false, false);
        for backend in Backend::supported_for_tests() {
            for cap in [1, 2, 3] {
                let mut seen = Vec::new();
                let result = render_layers_rle_with_execution(&job, &triangles, &index, true, Some(split),
                    |layer, _, _| {
                        seen.push(layer);
                        Err(SlicerV3Error::ExternalEncoder("raw sink failure".into()))
                    }, None, None, cap, backend);
                assert!(matches!(result, Err(SlicerV3Error::ExternalEncoder(message)) if message == "raw sink failure"));
                assert_eq!(seen, [0]);
                let cancel = AtomicBool::new(false);
                seen.clear();
                let result = render_layers_rle_with_execution(&job, &triangles, &index, false, Some(split),
                    |layer, _, _| { seen.push(layer); cancel.store(true, Ordering::Relaxed); Ok(()) },
                    None, Some(&cancel), cap, backend);
                assert!(matches!(result, Err(SlicerV3Error::Cancelled)));
                assert_eq!(seen, [0]);
                let result = render_layers_rle(&job, &triangles, &index, false, None,
                    |_, _, _| panic!("pre-cancelled pipeline delivered a layer"), None, Some(&cancel));
                assert!(matches!(result, Err(SlicerV3Error::Cancelled)));
            }
        }
    }

    #[test]
    fn raw_encoded_pipeline_matches_scalar_real_png_and_propagates_encoder_failure() {
        let (job, triangles, index, split) = fixture(true, true);
        let encode = Arc::new(|_: u32, runs: &[RleRun], support: Option<&[RleRun]>| {
            let merged;
            let runs: &[RleRun] = if let Some(support) = support {
                merged = merge_rle_max(runs, support);
                &merged
            } else { runs };
            crate::encode::encode_grayscale_png_from_rle(17, 13, runs, "fastest", true)
        });
        let golden: Vec<_> = (0..job.total_layers).map(|layer| {
            let segments = scalar_layer(&job, &triangles, index.candidates_for_layer(layer), layer, Some(split));
            let (runs, support, stats) = rasterize_raw_layer_segments(&job, &segments, true);
            (encode(layer, &runs, support.as_deref()).unwrap(), stats)
        }).collect();
        let mut next = 0;
        let (_, stats, _) = render_layers_rle_encoded(&job, &triangles, &index, true, Some(split), encode,
            |layer, bytes| { assert_eq!(layer, next); assert_eq!(bytes, golden[layer as usize].0); next += 1; Ok(()) },
            None, None).unwrap();
        assert_eq!(next, job.total_layers);
        for (actual, expected) in stats.iter().zip(&golden) { assert_stats(actual, &expected.1); }
        let result = render_layers_rle_encoded(&job, &triangles, &index, false, None,
            Arc::new(|_, _, _| Err(SlicerV3Error::ExternalEncoder("raw encode failure".into()))),
            |_, _| panic!("failed encoder delivered a layer"), None, None);
        assert!(matches!(result, Err(SlicerV3Error::ExternalEncoder(message)) if message == "raw encode failure"));
    }

    #[test]
    fn raw_scanline_masks_and_blocks_match_scalar_backends_splits_and_tails() {
        let (job, triangles, index, split) = fixture(true, true);
        let blocks = [make_rle_block(0,0), make_rle_block(0,5), make_rle_block(5,7),
            make_rle_block(12,5), make_rle_block(15,20), make_rle_block(30,1)];
        for backend in Backend::supported_for_tests() {
            for split in [None, Some(split)] {
                let timer = AtomicU64::new(0);
                let geometry_timer = AtomicU64::new(0);
                let scanline_timer = AtomicU64::new(0);
                for start in (0..job.total_layers).step_by(MAX_SCANLINE_LANES) {
                    let end = (start + MAX_SCANLINE_LANES as u32).min(job.total_layers);
                    let prepared = prepare_raw_layers(&job, &triangles, &index, start, end, split,
                        None, &timer, &geometry_timer).unwrap();
                    let scalar: Vec<_> = (start..end).map(|layer| scalar_layer(&job, &triangles,
                        index.candidates_for_layer(layer), layer, split)).collect();
                    for block in blocks {
                        let mut rasters: Vec<_> = prepared.iter().map(|layer|
                            BinaryScanlineRaster::new_rle(&job, &layer.model, true, Some(block))).collect();
                        render_scanline_batch(&mut rasters, backend, None).unwrap();
                        for (raster, expected) in rasters.into_iter().zip(&scalar) {
                            let (runs, stats) = raster.finish_rle();
                            let (expected_runs, expected_stats) = rasterize_binary_layer_rle_block_from_segments(
                                &job, &expected.model, true, block);
                            assert_eq!(runs, expected_runs, "{backend:?}, block={block:?}");
                            assert_stats(&stats, &expected_stats);
                        }
                    }
                    for (actual, expected) in prepared.iter().zip(&scalar) {
                        assert_eq!(actual.support.is_some(), expected.support.is_some());
                        assert_eq!(actual.model_candidates, expected.model_candidates);
                    }
                    if split.is_none() {
                        let rendered = render_raw_batch(&job, prepared, true, true, backend, None,
                            &timer, &scanline_timer).unwrap();
                        for (actual, expected) in rendered.into_iter().zip(&scalar) {
                            let (mask, stats) = actual.into_mask();
                            let mask = if mask.is_empty() { vec![0; 17 * 13] } else { mask };
                            let (expected_mask, expected_stats) = crate::raster::rasterize_layer_with_stats_from_segments(
                                &job, &expected.model, true);
                            assert_eq!(mask, expected_mask, "{backend:?}");
                            assert_stats(&stats, &expected_stats);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn raw_bounded_consumers_match_scalar_masks_and_png() {
        let (job, triangles, index, _) = fixture(false, true);
        let golden: Vec<_> = (0..job.total_layers).map(|layer| {
            let segments = scalar_layer(&job, &triangles, index.candidates_for_layer(layer), layer, None);
            crate::raster::rasterize_layer_with_stats_from_segments(&job, &segments.model, true)
        }).collect();
        let mut next = 0;
        let mut sink = |layer: u32, mask: Vec<u8>, stats: LayerAreaStatsV3| {
            assert_eq!(layer, next);
            let mask = if mask.is_empty() { vec![0;17*13] } else { mask };
            assert_eq!(mask, golden[layer as usize].0);
            assert_stats(&stats, &golden[layer as usize].1);
            next += 1;
            Ok(())
        };
        render_layers_bounded(&job, &triangles, &index, true, false, false, Some(&mut sink), None, None).unwrap();
        assert_eq!(next, job.total_layers);
        let (rendered, stats, _) = render_layers_bounded(&job, &triangles, &index, true, true, false, None, None, None).unwrap();
        for (layer, png) in rendered.png_layers.unwrap().iter().enumerate() {
            let segments = scalar_layer(&job, &triangles, index.candidates_for_layer(layer as u32), layer as u32, None);
            let (runs, _, _) = rasterize_raw_layer_segments(&job, &segments, true);
            let expected = if index.candidates_for_layer(layer as u32).is_empty() {
                crate::encode::encode_binary_grayscale_png_1bit(17,13,&vec![0;17*13],"fastest").unwrap()
            } else { crate::encode::encode_grayscale_png_from_rle(17,13,&runs,"fastest",true).unwrap() };
            assert_eq!(*png, expected);
            assert_stats(&stats[layer], &golden[layer].1);
        }
        let mut delivered = 0;
        let mut failing_sink = |_: u32, _: Vec<u8>, _: LayerAreaStatsV3| {
            delivered += 1;
            Err(SlicerV3Error::ExternalEncoder("bounded raw sink failure".into()))
        };
        let result = render_layers_bounded(&job, &triangles, &index, false, false, false,
            Some(&mut failing_sink), None, None);
        assert!(matches!(result, Err(SlicerV3Error::ExternalEncoder(message)) if message == "bounded raw sink failure"));
        assert_eq!(delivered, 1);
        let cancel = AtomicBool::new(false);
        let mut delivered = Vec::new();
        let mut cancelling_sink = |layer: u32, _: Vec<u8>, _: LayerAreaStatsV3| {
            delivered.push(layer); cancel.store(true, Ordering::Relaxed); Ok(())
        };
        let result = render_layers_bounded(&job, &triangles, &index, false, false, false,
            Some(&mut cancelling_sink), None, Some(&cancel));
        assert!(matches!(result, Err(SlicerV3Error::Cancelled)));
        assert_eq!(delivered, [0]);
    }

    #[test]
    fn raw_engine_blocks_match_scalar_global_windows_empty_blocks_and_order() {
        let (job, triangles, _, _) = fixture(true, false);
        let blocks = [make_rle_block(0,0), make_rle_block(0,5), make_rle_block(5,7), make_rle_block(12,5)];
        let all: Vec<_> = (0..triangles.len()).collect();
        let golden: Vec<_> = (0..job.total_layers).map(|layer| {
            let segments = scalar_layer(&job, &triangles, &all, layer, None);
            blocks.iter().map(|&block| rasterize_binary_layer_rle_block_from_segments(&job, &segments.model, true, block)).collect::<Vec<_>>()
        }).collect();
        let mut next = (0,0);
        let (stats, _) = crate::engine::slice_and_rasterize_rle_blocks_v3(&job, &blocks, true, None,
            |layer, block, payload| {
                assert_eq!((layer,block), next);
                let RleBlockPayload::Runs(runs) = payload else { panic!("expected runs"); };
                assert_eq!(runs, golden[layer as usize][block as usize].0);
                next = if block + 1 == blocks.len() as u32 { (layer+1,0) } else { (layer,block+1) };
                Ok(())
            }, None, None).unwrap();
        assert_eq!(next, (job.total_layers,0));
        for (layer, actual) in stats.iter().enumerate() {
            let parts = &golden[layer];
            assert_eq!(actual.total_solid_pixels, parts.iter().map(|part| part.1.total_solid_pixels).sum::<u32>());
            assert_eq!(actual.area_count, parts.iter().map(|part| part.1.area_count).sum::<u32>());
            let nonempty: Vec<_> = parts.iter().filter(|part| part.1.total_solid_pixels > 0).collect();
            if !nonempty.is_empty() {
                assert_eq!(actual.min_x, nonempty.iter().map(|part| part.1.min_x).min().unwrap());
                assert_eq!(actual.max_x, nonempty.iter().map(|part| part.1.max_x).max().unwrap());
            }
        }
        let mut seen = 0;
        let result = crate::engine::slice_and_rasterize_rle_blocks_v3(&job, &blocks, false, None,
            |_, _, _| { seen += 1; Err(SlicerV3Error::ExternalEncoder("block sink failure".into())) }, None, None);
        assert!(matches!(result, Err(SlicerV3Error::ExternalEncoder(message)) if message == "block sink failure"));
        assert_eq!(seen, 1);
        let cancel = AtomicBool::new(false);
        let mut layers = Vec::new();
        let result = crate::engine::slice_and_rasterize_rle_blocks_v3(&job, &blocks, false, None,
            |layer, _, _| { layers.push(layer); cancel.store(true, Ordering::Relaxed); Ok(()) },
            None, Some(&cancel));
        assert!(matches!(result, Err(SlicerV3Error::Cancelled)));
        assert!(!layers.is_empty());
        assert!(layers.iter().all(|&layer| layer == 0));
    }

    #[test]
    fn raw_engine_prepared_geometry_preserves_ssaa_support_and_blur_halo_pixels() {
        let (mut base, _, _, _) = fixture(true, true);
        // Full-frame/block row-history policies differ only on defective rows;
        // compare the post-process seam on correctly wound, overlapping geometry.
        for axis in 0..3 { base.triangles_xyz.swap(6 * 9 + 3 + axis, 6 * 9 + 6 + axis); }
        base.aa_on_supports = false;
        base.minimum_aa_alpha_percent = 35.0;
        let blocks = [make_rle_block(0,5), make_rle_block(5,7), make_rle_block(12,5)];
        for (mode, level, radius) in [("Coverage","4x",0), ("Blur","Off",2), ("3DAA","4x",2)] {
            let mut job = base.clone();
            job.anti_aliasing_mode = mode.into();
            job.anti_aliasing_level = level.into();
            job.blur_brush_radius_px = radius;
            let mut full = vec![Vec::new(); job.total_layers as usize];
            crate::engine::slice_and_rasterize_rle_v3(&job, false,
                |layer, runs| { full[layer as usize] = expand_rle_to_mask(&runs,17*13); Ok(()) }, None, None).unwrap();
            let mut assembled = vec![vec![0;17*13]; job.total_layers as usize];
            crate::engine::slice_and_rasterize_rle_blocks_v3(&job, &blocks, false, None,
                |layer, block, payload| {
                    let RleBlockPayload::Runs(runs) = payload else { panic!("expected runs"); };
                    let block = blocks[block as usize];
                    let width = block.width as usize;
                    let mask = expand_rle_to_mask(&runs,width*13);
                    for y in 0..13 {
                        let start = y*17 + block.start_col as usize;
                        assembled[layer as usize][start..start+width].copy_from_slice(&mask[y*width..(y+1)*width]);
                    }
                    Ok(())
                }, None, None).unwrap();
            assert_eq!(assembled, full, "mode={mode}, level={level}");
        }
    }
}
