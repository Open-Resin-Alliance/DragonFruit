//! Bounded parallel layer rendering pipeline.
//!
//! This stage rasterizes layers and emits requested payloads (PNG and/or raw
//! masks) with controlled in-flight work, ordered output assembly, progress
//! reporting, and cooperative cancellation.

use crate::encode::encode_grayscale_png;
use crate::engine::SlicerV3Error;
use crate::geometry::Triangle;
use crate::metrics::SlicingPerfV3;
use crate::raster::rasterize_layer_with_stats;
use crate::types::{LayerAreaStatsV3, ProgressCallbackV3, RenderedLayersV3, SliceJobV3};
use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;

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
    let encoded = encode_grayscale_png(width, height, &pixels, png_compression_strategy)?;

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

/// Render all layers into requested payload buffers while preserving order.
pub fn render_layers_bounded(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_index: &[Vec<usize>],
    compute_area_stats: bool,
    emit_png_layers: bool,
    emit_raw_mask_layers: bool,
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(RenderedLayersV3, Vec<LayerAreaStatsV3>, SlicingPerfV3), SlicerV3Error> {
    let render_wall_start = std::time::Instant::now();
    let total_layers = job.total_layers;
    let max_concurrent = choose_max_concurrent();
    let buffer = (max_concurrent * 2).clamp(2, 16);

    let progress = AtomicU32::new(0);
    let raster_ns = AtomicU64::new(0);
    let png_ns = AtomicU64::new(0);
    let layer_pixels_len = (job.source_width_px as usize) * (job.source_height_px as usize);

    let empty_png_cache = emit_png_layers.then(|| Mutex::<Option<Vec<u8>>>::new(None));
    let full_png_cache = emit_png_layers.then(|| Mutex::<Option<Vec<u8>>>::new(None));

    let mut out_pngs = emit_png_layers.then(|| vec![Vec::<u8>::new(); total_layers as usize]);
    let mut out_masks = emit_raw_mask_layers.then(|| vec![Vec::<u8>::new(); total_layers as usize]);
    let mut area_stats = vec![LayerAreaStatsV3::default(); total_layers as usize];
    let (tx, rx) = std::sync::mpsc::sync_channel::<
        Result<(u32, Option<Vec<u8>>, Option<Vec<u8>>, LayerAreaStatsV3), SlicerV3Error>,
    >(buffer);

    let mut pipeline_error: Result<(), SlicerV3Error> = Ok(());
    rayon::in_place_scope(|s| {
        s.spawn(|_| {
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

                        if layer_index[layer as usize].is_empty() {
                            let stats = LayerAreaStatsV3::default();
                            let png = if emit_png_layers {
                                let png_start = std::time::Instant::now();
                                let bytes = encode_uniform_png_cached(
                                    job.source_width_px,
                                    job.source_height_px,
                                    &job.png_compression_strategy,
                                    0,
                                    empty_png_cache
                                        .as_ref()
                                        .expect("png cache should exist when PNG output is enabled"),
                                )?;
                                png_ns.fetch_add(
                                    png_start.elapsed().as_nanos() as u64,
                                    Ordering::Relaxed,
                                );
                                Some(bytes)
                            } else {
                                None
                            };

                            let raw_mask = if emit_raw_mask_layers {
                                Some(vec![0u8; layer_pixels_len])
                            } else {
                                None
                            };

                            return Ok((layer, png, raw_mask, stats));
                        }

                        let raster_start = std::time::Instant::now();
                        let (mask, stats) = rasterize_layer_with_stats(
                            job,
                            triangles,
                            &layer_index[layer as usize],
                            layer,
                            compute_area_stats,
                        );
                        raster_ns
                            .fetch_add(raster_start.elapsed().as_nanos() as u64, Ordering::Relaxed);

                        let png = if emit_png_layers {
                            let png_start = std::time::Instant::now();
                            let is_all_black = stats.total_solid_pixels == 0;
                            let is_all_white = compute_area_stats
                                && (stats.total_solid_pixels as usize == layer_pixels_len);

                            let png = if is_all_black {
                                encode_uniform_png_cached(
                                    job.source_width_px,
                                    job.source_height_px,
                                    &job.png_compression_strategy,
                                    0,
                                    empty_png_cache
                                        .as_ref()
                                        .expect("png cache should exist when PNG output is enabled"),
                                )?
                            } else if is_all_white {
                                encode_uniform_png_cached(
                                    job.source_width_px,
                                    job.source_height_px,
                                    &job.png_compression_strategy,
                                    255,
                                    full_png_cache
                                        .as_ref()
                                        .expect("png cache should exist when PNG output is enabled"),
                                )?
                            } else {
                                encode_grayscale_png(
                                    job.source_width_px,
                                    job.source_height_px,
                                    &mask,
                                    &job.png_compression_strategy,
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

                        let raw_mask = if emit_raw_mask_layers {
                            Some(mask)
                        } else {
                            None
                        };

                        Ok((layer, png, raw_mask, stats))
                    })();
                    let _ = tx.send(result);
                });
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
                    // Report progress on completed layers as they arrive, not when
                    // they are later drained in-order from the reorder buffer.
                    // This prevents large UI jumps when many out-of-order layers
                    // flush at once behind a delayed lower-index layer.
                    let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(ref cb) = on_progress {
                        cb(done, total_layers);
                    }

                    pending[layer as usize] = Some((png, raw_mask, stats));
                    while next < total_layers {
                        let Some((png, raw_mask, stats)) = pending[next as usize].take() else {
                            break;
                        };
                        if let (Some(ref mut out), Some(png)) = (out_pngs.as_mut(), png) {
                            out[next as usize] = png;
                        }
                        if let (Some(ref mut out), Some(mask)) = (out_masks.as_mut(), raw_mask) {
                            out[next as usize] = mask;
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
