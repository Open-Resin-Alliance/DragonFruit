use crate::{cuda::{self, CudaFailure, CudaFailureKind}, engine::SlicerV3Error,
    encoders::{registry::find_encoder, RleStreamEncoder, RawMaskStreamEncoder},
    metrics::SlicingPerfV3, rle::RleBlockSpec,
    types::{ComputeBackend, LayerAreaStatsV3, ProgressCallbackV3, RenderedLayersV3,
        SliceArtifactV3, SliceJobV3, SliceProgressPhaseV3, SliceProgressUpdateV3}};
use std::{path::Path, sync::atomic::{AtomicBool, Ordering}, time::Instant};

fn progress(callback: &Option<ProgressCallbackV3>, done: u32, total: u32,
    phase: SliceProgressPhaseV3) {
    if let Some(callback) = callback { callback(SliceProgressUpdateV3 { done, total, phase }); }
}

fn check_cancelled(cancel: Option<&AtomicBool>) -> Result<(), SlicerV3Error> {
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        Err(SlicerV3Error::Cancelled)
    } else { Ok(()) }
}

fn png(job: &SliceJobV3, runs: &[crate::rle::RleRun]) -> Result<Vec<u8>, SlicerV3Error> {
    match job.x_packing_mode.as_str() {
        "rgb8_div3" => crate::encode::encode_truecolor_packed_png_from_rle(
            job.width_px, job.source_height_px, runs, 3),
        "gray3_div2" => crate::encode::encode_grayscale_averaged_png_from_rle(
            job.width_px, job.source_height_px, runs),
        _ => crate::encode::encode_grayscale_png_from_rle(job.source_width_px,
            job.source_height_px, runs, &job.png_compression_strategy, job.produces_binary_output()),
    }
}

enum Sink {
    Rle(Box<dyn RleStreamEncoder>),
    Raw(Box<dyn RawMaskStreamEncoder>),
    Layers(RenderedLayersV3),
}

/// Owns the entire attempt's encoder and output. Any native failure unwinds
/// this function, destroying all GPU leases and attempt-owned output before
/// the caller starts a fresh CPU job from the same borrowed input.
pub(crate) fn slice_attempt(job: &SliceJobV3, output_path: Option<&Path>,
    callback: Option<ProgressCallbackV3>, cancel: Option<&AtomicBool>)
    -> Result<SliceArtifactV3, SlicerV3Error> {
    let started = Instant::now();
    check_cancelled(cancel)?;
    let encoder = find_encoder(&job.output_format)
        .ok_or_else(|| SlicerV3Error::UnsupportedOutput(job.output_format.clone()))?;
    let requires_stats = encoder.requires_area_stats();
    let requires_png = encoder.requires_png_layers();
    let requires_raw = encoder.requires_raw_mask_layers();
    let mut sink = Sink::Layers(RenderedLayersV3 {
        png_layers: requires_png.then(Vec::new), raw_mask_layers: requires_raw.then(Vec::new),
    });
    if !requires_png {
        if let Some(rle) = encoder.create_rle_stream_encoder(job)? { sink = Sink::Rle(rle); }
        else if !job.anti_aliasing_mode_is_vertical() && requires_raw {
            if let Some(raw) = encoder.create_raw_mask_stream_encoder(job)? { sink = Sink::Raw(raw); }
        }
    }
    // Match the CPU's selected numerical path, not just its payload storage.
    // Native owns the direct-PNG support-split bypass and mode normalization.
    let dense_raster_semantics = match &sink {
        Sink::Rle(_) => 0,
        Sink::Layers(layers) if !job.anti_aliasing_mode_is_vertical()
            && layers.png_layers.is_some() && layers.raw_mask_layers.is_none() => 2,
        _ => 1,
    };
    let blocks: Vec<RleBlockSpec> = match &sink {
        Sink::Rle(rle) if !job.anti_aliasing_mode_is_vertical() && !job.is_multi_tank() =>
            rle.rle_blocks(job).unwrap_or_default(),
        _ => Vec::new(),
    };
    if job.is_multi_tank() && !matches!(&sink, Sink::Rle(rle) if rle.supports_multi_tank()) {
        return Err(SlicerV3Error::UnsupportedOutput(format!(
            "{} needs a multi-tank RLE stream encoder", encoder.output_format())));
    }
    let encode_layer = match &sink { Sink::Rle(rle) => rle.parallel_encode_fn(), _ => None };
    let encode_block = match &sink { Sink::Rle(rle) => rle.parallel_encode_block_fn(), _ => None };
    let units = job.total_layers.saturating_mul(job.tank_count.max(1));
    let mut total = units.saturating_add(1);
    progress(&callback, 0, total, SliceProgressPhaseV3::Slicing);
    let mut stats = if requires_stats { vec![LayerAreaStatsV3::default(); job.total_layers as usize] }
        else { Vec::new() };
    let mut perf = SlicingPerfV3 { compute_backend: ComputeBackend::Cuda,
        layers: job.total_layers, ..Default::default() };
    let mut expected_output = 0u64;
    let block_count = blocks.len().max(1) as u64;
    let render_started = Instant::now();
    cuda::render(job, &blocks, requires_stats, dense_raster_semantics, cancel, |output| {
        check_cancelled(cancel)?;
        // Native output is tank-major, then layer-major, then encoder block
        // order. Never feed a partial/reordered native attempt into a codec.
        let unit = expected_output / block_count;
        let expected_layer = (unit % job.total_layers as u64) as u32;
        let expected_tank = (unit / job.total_layers as u64) as u32;
        let expected_block = (expected_output % block_count) as u32;
        if output.layer_index != expected_layer || output.tank_index != expected_tank
            || output.block_index != expected_block || unit >= units as u64 {
            return Err(SlicerV3Error::Cuda(CudaFailure { kind: CudaFailureKind::Execution,
                message: "native output order does not match encoder lifecycle".into() }));
        }
        if requires_stats && expected_block == 0 {
            crate::engine::accumulate_block_stats(&mut stats[expected_layer as usize], &output.stats);
        }
        let encode_started = Instant::now();
        match &mut sink {
            Sink::Rle(rle) if job.is_multi_tank() =>
                rle.consume_rle_tank_layer(output.layer_index, output.tank_index, output.runs)?,
            Sink::Rle(rle) if !blocks.is_empty() => {
                if let Some(encode) = &encode_block {
                    let bytes = encode(output.layer_index, output.block_index, &output.runs)?;
                    rle.store_encoded_block(output.layer_index, output.block_index, bytes);
                } else { rle.consume_rle_block(output.layer_index, output.block_index, output.runs)?; }
            },
            Sink::Rle(rle) => {
                if let Some(encode) = &encode_layer {
                    let bytes = encode(output.layer_index, &output.runs)?;
                    rle.store_encoded_layer(output.layer_index, bytes);
                } else { rle.consume_rle_layer(output.layer_index, output.runs)?; }
            },
            Sink::Raw(raw) => raw.consume_raw_mask_layer(output.layer_index,
                crate::rle::expand_rle_to_mask(&output.runs,
                    job.source_width_px as usize * job.source_height_px as usize))?,
            Sink::Layers(layers) => {
                if let Some(pngs) = &mut layers.png_layers { pngs.push(png(job, &output.runs)?); }
                if let Some(masks) = &mut layers.raw_mask_layers {
                    masks.push(crate::rle::expand_rle_to_mask(&output.runs,
                        job.source_width_px as usize * job.source_height_px as usize));
                }
            },
        }
        perf.png_encode_ns = perf.png_encode_ns.saturating_add(encode_started.elapsed().as_nanos() as u64);
        expected_output += 1;
        if expected_output % block_count == 0 {
            progress(&callback, (expected_output / block_count) as u32, total, SliceProgressPhaseV3::Slicing);
        }
        Ok(())
    })?;
    if expected_output != units as u64 * block_count {
        return Err(SlicerV3Error::Cuda(CudaFailure { kind: CudaFailureKind::Execution,
            message: "native output ended before all layer/tank/block payloads".into() }));
    }
    check_cancelled(cancel)?;
    perf.render_wall_ns = render_started.elapsed().as_nanos() as u64;
    perf.render_ns = perf.render_wall_ns.saturating_sub(perf.png_encode_ns);
    perf.encode_format_ns = perf.png_encode_ns;
    let encode_started = Instant::now();
    let bytes = match sink {
        Sink::Rle(mut rle) => {
            rle.set_area_stats(stats);
            progress(&callback, units, total, SliceProgressPhaseV3::Finalizing);
            if let Some(path) = output_path { rle.finalize_to_path(path)?; Vec::new() }
            else { rle.finalize_to_bytes()? }
        },
        Sink::Raw(raw) => {
            progress(&callback, units, total, SliceProgressPhaseV3::Finalizing);
            if let Some(path) = output_path { raw.finalize_to_path(path)?; Vec::new() }
            else { raw.finalize_to_bytes()? }
        },
        Sink::Layers(layers) => {
            let encode_units = encoder.estimate_encode_progress_units(&layers).max(1);
            total = units.saturating_add(encode_units);
            let encode_progress = |done: u32, count: u32| {
                let normalized = (done.min(count.max(1)) as u64 * encode_units as u64
                    / count.max(1) as u64) as u32;
                progress(&callback, units.saturating_add(normalized), total, SliceProgressPhaseV3::Encoding);
            };
            if let Some(path) = output_path {
                encoder.encode_container_to_path_with_progress(job, &layers, &stats,
                    path, Some(&encode_progress))?;
                Vec::new()
            } else {
                encoder.encode_container_from_rendered_layers_with_progress(job, &layers,
                    &stats, Some(&encode_progress))?
            }
        },
    };
    progress(&callback, total, total, SliceProgressPhaseV3::Finalizing);
    perf.archive_encode_ns = encode_started.elapsed().as_nanos() as u64;
    perf.total_ns = started.elapsed().as_nanos() as u64;
    Ok(SliceArtifactV3 { bytes, perf })
}

pub(crate) fn announce_fallback(job: &SliceJobV3, failure: &CudaFailure,
    callback: &Option<ProgressCallbackV3>, cancel: Option<&AtomicBool>) -> Result<(), SlicerV3Error> {
    eprintln!("[CUDA] slicing attempt failed: {failure}");
    check_cancelled(cancel)?;
    eprintln!("[CUDA] restarting the complete job on CPU; progress reset");
    progress(callback, 0, job.total_layers.saturating_mul(job.tank_count.max(1)).saturating_add(1),
        SliceProgressPhaseV3::CpuFallback);
    Ok(())
}
