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
use crate::raster::{rasterize_layer_rle, rasterize_layer_with_stats};
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
    if let Ok(mut pool) = MASK_POOL.get_or_init(|| Mutex::new(Vec::new())).lock() {
        if pool.len() < 16 {
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

    // Safety-first caps for very large layers (e.g., 7,680x7,680 ~= 56.25 MB/mask).
    // These avoid simultaneous large allocations across many workers.
    if budget_override.is_none() {
        if bytes_per_mask >= 48 * 1024 * 1024 {
            capped = capped.min(1);
        } else if bytes_per_mask >= 24 * 1024 * 1024 {
            capped = capped.min(2);
        } else if bytes_per_mask >= 12 * 1024 * 1024 {
            capped = capped.min(4);
        }
    }

    // In streaming mode, downstream encode work can also retain large buffers.
    // Keep raster producers tighter to prevent queueing huge masks.
    if streaming_raw_mask_sink {
        if budget_override.is_none() {
            if bytes_per_mask >= 48 * 1024 * 1024 {
                capped = capped.min(2);
            } else if bytes_per_mask >= 24 * 1024 * 1024 {
                capped = capped.min(4);
            } else if bytes_per_mask >= 12 * 1024 * 1024 {
                capped = capped.min(8);
            }
        }
    }

    capped.max(1)
}

fn choose_streaming_buffer_depth_for_mask_bytes(layer_pixels_len: usize) -> usize {
    let bytes_per_mask = layer_pixels_len;
    if bytes_per_mask >= 24 * 1024 * 1024 {
        // For giant layers (e.g., 16K-class), keep exactly one queued mask.
        1
    } else {
        2
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
    mut on_raw_mask_layer: Option<&mut dyn FnMut(u32, Vec<u8>) -> Result<(), SlicerV3Error>>,
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
        choose_streaming_buffer_depth_for_mask_bytes(layer_pixels)
    } else if use_rle_png_path {
        (max_concurrent * 4).clamp(4, 64)
    } else {
        (max_concurrent * 2).clamp(2, 16)
    };

    let progress = AtomicU32::new(0);
    let raster_ns = AtomicU64::new(0);
    let png_ns = AtomicU64::new(0);
    let layer_pixels_len =
        (job.effective_render_width_px() as usize) * (job.source_height_px as usize);
    let binary_png_expected = job.anti_aliasing_level.trim() == "Off";

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
                (0..total_layers)
                    .into_par_iter()
                    .for_each_with(tx, |tx, layer| {
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
                                let raster_start = std::time::Instant::now();
                                let (runs, stats) = rasterize_layer_rle(
                                    job,
                                    triangles,
                                    layer_candidates,
                                    layer,
                                );
                                raster_ns.fetch_add(
                                    raster_start.elapsed().as_nanos() as u64,
                                    Ordering::Relaxed,
                                );
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

                            let raster_start = std::time::Instant::now();
                            let (mask, stats) = rasterize_layer_with_stats(
                                job,
                                triangles,
                                layer_candidates,
                                layer,
                                compute_area_stats,
                            );
                            raster_ns.fetch_add(
                                raster_start.elapsed().as_nanos() as u64,
                                Ordering::Relaxed,
                            );

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
                        let _ = tx.send(result);
                    });
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
                                    if let Err(err) = sink(next, mask) {
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
    mut on_rle_layer: impl FnMut(u32, Vec<crate::rle::RleRun>) -> Result<(), SlicerV3Error>,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    use crate::rle::RleRun;

    let render_wall_start = std::time::Instant::now();
    let total_layers = job.total_layers;
    let max_concurrent = choose_max_concurrent();
    // RLE output is small; allow a generous channel buffer so producers stay fed.
    let buffer = (max_concurrent * 4).clamp(4, 64);

    let raster_ns = AtomicU64::new(0);
    let progress = AtomicU32::new(0);

    let (tx, rx) = std::sync::mpsc::sync_channel::<
        Result<(u32, Vec<RleRun>, LayerAreaStatsV3), SlicerV3Error>,
    >(buffer);

    let mut pipeline_error: Result<(), SlicerV3Error> = Ok(());
    let mut area_stats = vec![LayerAreaStatsV3::default(); total_layers as usize];

    rayon::in_place_scope(|s| {
        s.spawn(|_| {
            let produce = |tx: std::sync::mpsc::SyncSender<
                Result<(u32, Vec<RleRun>, LayerAreaStatsV3), SlicerV3Error>,
            >| {
                (0..total_layers)
                    .into_par_iter()
                    .for_each_with(tx, |tx, layer| {
                        let result =
                            (|| -> Result<(u32, Vec<RleRun>, LayerAreaStatsV3), SlicerV3Error> {
                                if cancel_flag
                                    .map(|flag| flag.load(Ordering::Relaxed))
                                    .unwrap_or(false)
                                {
                                    return Err(SlicerV3Error::Cancelled);
                                }

                                let layer_candidates = layer_index.candidates_for_layer(layer);
                                let raster_start = std::time::Instant::now();
                                let (runs, stats) =
                                    rasterize_layer_rle(job, triangles, layer_candidates, layer);
                                raster_ns.fetch_add(
                                    raster_start.elapsed().as_nanos() as u64,
                                    Ordering::Relaxed,
                                );

                                Ok((layer, runs, stats))
                            })();
                        let _ = tx.send(result);
                    });
            };

            match ThreadPoolBuilder::new().num_threads(max_concurrent).build() {
                Ok(pool) => pool.install(|| produce(tx)),
                Err(_) => produce(tx),
            }
        });

        let mut pending: Vec<Option<(Vec<RleRun>, LayerAreaStatsV3)>> =
            Vec::with_capacity(total_layers as usize);
        pending.resize_with(total_layers as usize, || None);
        let mut next = 0u32;

        for msg in &rx {
            if pipeline_error.is_err() {
                continue;
            }
            match msg {
                Err(e) => pipeline_error = Err(e),
                Ok((layer, runs, stats)) => {
                    pending[layer as usize] = Some((runs, stats));
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
                        let Some((runs, stats)) = pending[next as usize].take() else {
                            break;
                        };
                        if let Err(e) = on_rle_layer(next, runs) {
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
    encode_fn: std::sync::Arc<
        dyn Fn(u32, &[crate::rle::RleRun]) -> Result<Vec<u8>, SlicerV3Error> + Send + Sync,
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
    let encode_ns = AtomicU64::new(0);
    let progress = AtomicU32::new(0);

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
                (0..total_layers)
                    .into_par_iter()
                    .for_each_with(tx, |tx, layer| {
                        let result =
                            (|| -> Result<(u32, Vec<u8>, LayerAreaStatsV3), SlicerV3Error> {
                                if cancel_flag
                                    .map(|flag| flag.load(Ordering::Relaxed))
                                    .unwrap_or(false)
                                {
                                    return Err(SlicerV3Error::Cancelled);
                                }

                                let layer_candidates = layer_index.candidates_for_layer(layer);
                                let raster_start = std::time::Instant::now();
                                let (runs, stats) =
                                    rasterize_layer_rle(job, triangles, layer_candidates, layer);
                                raster_ns.fetch_add(
                                    raster_start.elapsed().as_nanos() as u64,
                                    Ordering::Relaxed,
                                );

                                let encode_start = std::time::Instant::now();
                                let bytes = encode_fn(layer, &runs)?;
                                encode_ns.fetch_add(
                                    encode_start.elapsed().as_nanos() as u64,
                                    Ordering::Relaxed,
                                );

                                Ok((layer, bytes, stats))
                            })();
                        let _ = tx.send(result);
                    });
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
