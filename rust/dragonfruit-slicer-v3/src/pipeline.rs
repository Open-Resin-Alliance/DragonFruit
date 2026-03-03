//! Bounded parallel layer rendering pipeline.
//!
//! This stage rasterizes + encodes PNG layers with controlled in-flight work,
//! ordered output assembly, progress reporting, and cooperative cancellation.

use crate::encode::encode_grayscale_png;
use crate::engine::SlicerV3Error;
use crate::geometry::Triangle;
use crate::metrics::SlicingPerfV3;
use crate::raster::rasterize_layer;
use crate::types::{ProgressCallbackV3, SliceJobV3};
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

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

/// Render all layers into PNG byte buffers while preserving layer order.
pub fn render_layers_bounded(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_index: &[Vec<usize>],
    on_progress: Option<ProgressCallbackV3>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(Vec<Vec<u8>>, SlicingPerfV3), SlicerV3Error> {
    let render_wall_start = std::time::Instant::now();
    let total_layers = job.total_layers;
    let max_concurrent = choose_max_concurrent();
    let buffer = (max_concurrent * 2).clamp(2, 16);

    let progress = AtomicU32::new(0);
    let raster_ns = AtomicU64::new(0);
    let png_ns = AtomicU64::new(0);

    let mut out = vec![Vec::<u8>::new(); total_layers as usize];
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(u32, Vec<u8>), SlicerV3Error>>(buffer);

    let mut pipeline_error: Result<(), SlicerV3Error> = Ok(());
    rayon::in_place_scope(|s| {
        s.spawn(|_| {
            (0..total_layers)
                .into_par_iter()
                .for_each_with(tx, |tx, layer| {
                    let result = (|| -> Result<(u32, Vec<u8>), SlicerV3Error> {
                        if cancel_flag
                            .map(|flag| flag.load(Ordering::Relaxed))
                            .unwrap_or(false)
                        {
                            return Err(SlicerV3Error::Cancelled);
                        }

                        let raster_start = std::time::Instant::now();
                        let mask =
                            rasterize_layer(job, triangles, &layer_index[layer as usize], layer);
                        raster_ns
                            .fetch_add(raster_start.elapsed().as_nanos() as u64, Ordering::Relaxed);

                        let png_start = std::time::Instant::now();
                        let png = encode_grayscale_png(
                            job.source_width_px,
                            job.source_height_px,
                            &mask,
                            &job.png_compression_strategy,
                        )?;
                        png_ns.fetch_add(png_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                        Ok((layer, png))
                    })();
                    let _ = tx.send(result);
                });
        });

        let mut reorder: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        let mut next = 0u32;
        for msg in &rx {
            if pipeline_error.is_err() {
                continue;
            }
            match msg {
                Err(e) => pipeline_error = Err(e),
                Ok((layer, png)) => {
                    // Report progress on completed layers as they arrive, not when
                    // they are later drained in-order from the reorder buffer.
                    // This prevents large UI jumps when many out-of-order layers
                    // flush at once behind a delayed lower-index layer.
                    let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(ref cb) = on_progress {
                        cb(done, total_layers);
                    }

                    reorder.insert(layer, png);
                    while let Some(p) = reorder.remove(&next) {
                        out[next as usize] = p;
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

    Ok((out, perf))
}
