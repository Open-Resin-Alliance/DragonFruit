//! Borrowed, one-output/one-transfer adapter for df_cuda_slicer ABI version 1.
//! Native code owns all numerical work; encoder-facing runs receive DMA directly.

use crate::{rle::{RleBlockSpec, RleRun}, types::{LayerAreaStatsV3, SliceJobV3}};
use thiserror::Error;

mod lifecycle;
pub(crate) use lifecycle::{announce_fallback, slice_attempt};
#[cfg(all(test, feature = "cuda", target_os = "windows"))]
mod conformance;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CudaFailureKind { InvalidArgument, Unavailable, OutOfMemory, Execution, Numerical }

#[derive(Debug, Error)]
#[error("CUDA {kind:?}: {message}")]
pub struct CudaFailure {
    pub kind: CudaFailureKind,
    pub message: String,
}

#[derive(Debug)]
pub(crate) struct Output {
    pub layer_index: u32,
    pub tank_index: u32,
    pub block_index: u32,
    pub runs: Vec<RleRun>,
    pub stats: LayerAreaStatsV3,
}

#[cfg(all(feature = "cuda", target_os = "windows"))]
mod native {
    use super::*;
    use crate::{engine::SlicerV3Error, zaa};
    use std::{ffi::{c_char, c_void}, marker::PhantomData, mem::size_of, ptr::NonNull,
        sync::{atomic::{AtomicBool, Ordering}, mpsc}, time::Duration};

    #[repr(C)]
    struct Config {
        abi_version: u32, struct_size: u32, width: u32, height: u32,
        total_layers: u32, tank_count: u32, model_triangle_count: u32,
        raster_mode: u32, aa_samples: u32, sample_pattern: u32,
        duplicate_terminal_z: u32, mirror_x: u32, mirror_y: u32,
        aa_on_supports: u32, xy_blur_radius: u32, xy_blur_gaussian: u32,
        z_blur_radius: u32, z_blur_gaussian: u32, dither_bit_depth: u32,
        custom_lut_count: u32, compute_area_stats: u32, dense_raster_semantics: u32,
        look_back: u32, reserved: u32,
        build_width_mm: f32, build_depth_mm: f32, layer_height_mm: f32,
        minimum_aa_alpha_percent: f32, z_blend_minimum_alpha_percent: f32,
        z_blend_maximum_alpha_percent: f32, xy_sigma_x: f64, xy_sigma_y: f64,
        z_sigma: f64, dither_gamma: f64, generic_z_center_weight_scale: f64,
        custom_lut: [u8; 256],
    }
    #[repr(C)]
    struct Block { start_column: u32, width: u32 }
    #[repr(C)]
    #[derive(Default)]
    struct AreaStats {
        total_solid_pixels: u64, total_solid_area_mm2: f64,
        largest_area_mm2: f64, smallest_area_mm2: f64,
        min_x: i32, min_y: i32, max_x: i32, max_y: i32,
        area_count: u32, reserved: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Descriptor {
        token: u64, run_count: u64, max_transfer_runs: u64,
        layer_index: u32, tank_index: u32, block_index: u32,
        start_column: u32, width: u32, height: u32, area_stats: AreaStats,
    }
    #[repr(C)]
    struct Error { code: i32, message: [c_char; 512] }
    const _: () = {
        assert!(size_of::<Config>() == 416);
        assert!(size_of::<Block>() == 8);
        assert!(size_of::<AreaStats>() == 56);
        assert!(size_of::<Descriptor>() == 104);
        assert!(size_of::<Error>() == 516);
    };
    impl Default for Error {
        fn default() -> Self { Self { code: 0, message: [0; 512] } }
    }
    extern "C" {
        fn df_cuda_create(config: *const Config, xyz: *const f32, float_count: u64,
            tanks: *const u32, tank_count: u64, blocks: *const Block, block_count: u64,
            job: *mut *mut c_void, error: *mut Error) -> i32;
        fn df_cuda_next_output(job: *mut c_void, output: *mut Descriptor, error: *mut Error) -> i32;
        fn df_cuda_read_runs_async(job: *mut c_void, output_token: u64, first_run: u64,
            run_count: u64, destination: *mut RleRun, destination_capacity: u64,
            transfer_token: *mut u64, error: *mut Error) -> i32;
        fn df_cuda_wait_transfer(job: *mut c_void, transfer_token: u64, error: *mut Error) -> i32;
        fn df_cuda_release_output(job: *mut c_void, output_token: u64, error: *mut Error) -> i32;
        fn df_cuda_cancel(job: *mut c_void);
        fn df_cuda_destroy(job: *mut c_void);
    }
    fn failure(kind: CudaFailureKind, message: impl Into<String>) -> SlicerV3Error {
        SlicerV3Error::Cuda(CudaFailure { kind, message: message.into() })
    }
    fn check(status: i32, error: &Error) -> Result<(), SlicerV3Error> {
        if status == 0 { return Ok(()); }
        if status == 6 { return Err(SlicerV3Error::Cancelled); }
        let kind = match status {
            2 => CudaFailureKind::InvalidArgument, 3 => CudaFailureKind::Unavailable,
            4 => CudaFailureKind::OutOfMemory, 7 => CudaFailureKind::Numerical,
            _ => CudaFailureKind::Execution,
        };
        let bytes: Vec<u8> = error.message.iter().take_while(|&&byte| byte != 0)
            .map(|&byte| byte as u8).collect();
        Err(failure(kind, String::from_utf8_lossy(&bytes).into_owned()))
    }
    // Inputs and block storage are retained until destroy returns. The pointer
    // never escapes this adapter except to its scoped atomic-only cancel worker.
    pub(super) struct Job<'a> {
        handle: NonNull<c_void>,
        _input: PhantomData<&'a SliceJobV3>,
        _config: Box<Config>,
        _blocks: Vec<Block>,
        // Failed reads retain their allocation until destroy drains every lease.
        destination: Vec<RleRun>,
    }
    impl<'a> Job<'a> {
        pub(super) fn create(job: &'a SliceJobV3, blocks: &[RleBlockSpec], stats: bool,
            dense_raster_semantics: u32) -> Result<Self, SlicerV3Error> {
            let perturb = job.anti_aliasing_mode_is_vertical();
            let samples = job.configured_xy_aa_steps().max(1) as u32;
            let custom = job.normalized_custom_cure_lut();
            let config = Box::new(Config {
                abi_version: 1, struct_size: size_of::<Config>() as u32,
                width: job.effective_render_width_px(), height: job.source_height_px,
                total_layers: job.total_layers, tank_count: job.tank_count.max(1),
                model_triangle_count: job.model_triangle_count,
                raster_mode: if perturb { 3 } else if job.anti_aliasing_mode_is_blur() { 2 }
                    else if samples > 1 { 1 } else { 0 },
                aa_samples: samples,
                sample_pattern: match zaa::perturbation_pattern(job) {
                    zaa::ZaaPerturbationPattern::Uniform => 0,
                    zaa::ZaaPerturbationPattern::Halton => 1,
                    zaa::ZaaPerturbationPattern::Base2 => 2,
                },
                duplicate_terminal_z: zaa::duplicate_terminal_z_samples(job, samples as usize) as u32,
                mirror_x: job.mirror_x as u32, mirror_y: job.mirror_y as u32,
                aa_on_supports: job.aa_on_supports as u32,
                xy_blur_radius: job.blur_brush_radius_px,
                xy_blur_gaussian: job.blur_brush_kernel_is_gaussian() as u32,
                z_blur_radius: job.z_blur_radius_layers,
                z_blur_gaussian: job.z_blur_kernel_is_gaussian() as u32,
                dither_bit_depth: job.effective_dither_bit_depth().unwrap_or(0),
                custom_lut_count: if custom.is_some() { 256 } else { 0 },
                compute_area_stats: stats as u32, dense_raster_semantics,
                look_back: job.z_blend_look_back, reserved: 0,
                build_width_mm: job.build_width_mm, build_depth_mm: job.build_depth_mm,
                layer_height_mm: job.layer_height_mm,
                minimum_aa_alpha_percent: job.minimum_aa_alpha_percent,
                z_blend_minimum_alpha_percent: job.z_blend_minimum_alpha_percent,
                z_blend_maximum_alpha_percent: job.z_blend_max_alpha_percent,
                xy_sigma_x: job.blur_brush_sigma_x, xy_sigma_y: job.blur_brush_sigma_y,
                z_sigma: job.z_blur_sigma, dither_gamma: job.dither_device_gamma,
                generic_z_center_weight_scale: std::env::var("DF_3DAA_Z_BLUR_CENTER_WEIGHT_SCALE")
                    .ok().and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .unwrap_or(0.8).clamp(0.1, 2.0),
                custom_lut: custom.unwrap_or([0; 256]),
            });
            let blocks: Vec<Block> = blocks.iter().map(|block| Block {
                start_column: block.start_col, width: block.width,
            }).collect();
            let mut handle = std::ptr::null_mut();
            let mut error = Error::default();
            let status = unsafe { df_cuda_create(config.as_ref(), job.triangles_xyz.as_ptr(),
                job.triangles_xyz.len() as u64, job.triangle_tank_index.as_ptr(),
                job.triangle_tank_index.len() as u64, blocks.as_ptr(), blocks.len() as u64,
                &mut handle, &mut error) };
            if status != 0 {
                if !handle.is_null() { unsafe { df_cuda_destroy(handle); } }
                check(status, &error)?;
            }
            let handle = NonNull::new(handle).ok_or_else(|| failure(
                CudaFailureKind::Execution, "native create returned no job"))?;
            Ok(Self { handle, _input: PhantomData, _config: config, _blocks: blocks,
                destination: Vec::new() })
        }
        pub(super) fn with_cancellation<T>(&mut self, cancel: Option<&AtomicBool>,
            operation: impl FnOnce(&mut Self) -> Result<T, SlicerV3Error>) -> Result<T, SlicerV3Error> {
            let Some(cancel) = cancel else { return operation(self); };
            std::thread::scope(|scope| {
                let pointer = self.handle.as_ptr() as usize;
                let (stop, stopped) = mpsc::channel::<()>();
                scope.spawn(move || loop {
                    if cancel.load(Ordering::Relaxed) {
                        unsafe { df_cuda_cancel(pointer as *mut c_void); }
                        break;
                    }
                    match stopped.recv_timeout(Duration::from_millis(10)) {
                        Err(mpsc::RecvTimeoutError::Timeout) => {}, _ => break,
                    }
                });
                let result = operation(self);
                drop(stop);
                if cancel.load(Ordering::Relaxed) { Err(SlicerV3Error::Cancelled) } else { result }
            })
        }
        pub(super) fn next(&mut self) -> Result<Option<Output>, SlicerV3Error> {
            let mut output = Descriptor::default();
            let mut error = Error::default();
            let status = unsafe { df_cuda_next_output(self.handle.as_ptr(), &mut output, &mut error) };
            if status == 1 { return Ok(None); }
            check(status, &error)?;
            let count = usize::try_from(output.run_count).map_err(|_| failure(
                CudaFailureKind::Execution, "native run count exceeds host address space"))?;
            self.destination.try_reserve_exact(count)
                .map_err(|error| SlicerV3Error::HostAllocation(error.to_string()))?;
            if output.run_count > 0 && output.max_transfer_runs == 0 {
                return Err(failure(CudaFailureKind::Execution, "zero native transfer allowance"));
            }
            let mut first = 0u64;
            while first < output.run_count {
                let chunk = (output.run_count - first).min(output.max_transfer_runs);
                let mut transfer = 0u64;
                // The Vec's uninitialized final storage is never read/resized
                // while native owns the destination lease. wait always drains
                // and unregisters, including on a reported transfer failure.
                check(unsafe { df_cuda_read_runs_async(self.handle.as_ptr(), output.token,
                    first, chunk, self.destination.as_mut_ptr().add(first as usize), chunk,
                    &mut transfer, &mut error) }, &error)?;
                check(unsafe { df_cuda_wait_transfer(self.handle.as_ptr(), transfer, &mut error) }, &error)?;
                first += chunk;
            }
            unsafe { self.destination.set_len(count); }
            check(unsafe { df_cuda_release_output(self.handle.as_ptr(), output.token, &mut error) }, &error)?;
            let runs = std::mem::take(&mut self.destination);
            let stats = output.area_stats;
            Ok(Some(Output { layer_index: output.layer_index, tank_index: output.tank_index,
                block_index: output.block_index, runs, stats: LayerAreaStatsV3 {
                    total_solid_pixels: stats.total_solid_pixels.min(u32::MAX as u64) as u32,
                    total_solid_area_mm2: stats.total_solid_area_mm2,
                    largest_area_mm2: stats.largest_area_mm2, smallest_area_mm2: stats.smallest_area_mm2,
                    min_x: stats.min_x, min_y: stats.min_y, max_x: stats.max_x, max_y: stats.max_y,
                    area_count: stats.area_count,
                } }))
        }
    }
    impl Drop for Job<'_> {
        fn drop(&mut self) { unsafe { df_cuda_destroy(self.handle.as_ptr()); } }
    }
}

pub(crate) fn render(job: &SliceJobV3, blocks: &[RleBlockSpec], compute_stats: bool,
    dense_raster_semantics: u32, cancel: Option<&std::sync::atomic::AtomicBool>,
    mut consume: impl FnMut(Output) -> Result<(), crate::engine::SlicerV3Error>)
    -> Result<(), crate::engine::SlicerV3Error> {
    use crate::engine::SlicerV3Error;
    if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
        return Err(SlicerV3Error::Cancelled);
    }
    #[cfg(all(feature = "cuda", target_os = "windows"))]
    {
        let mut trace_start = (std::env::var("DF_CUDA_TRACE").as_deref() == Ok("1"))
            .then(std::time::Instant::now);
        let mut native = native::Job::create(job, blocks, compute_stats, dense_raster_semantics)?;
        native.with_cancellation(cancel, |native| {
            while let Some(output) = native.next()? {
                let first_output = trace_start.take();
                if let Some(start) = first_output {
                    eprintln!("[DF_CUDA_TRACE] HOST adapter={:p} elapsed_ms={:.3} event=encoder.begin layer={} tank={} block={} runs={}",
                        job, start.elapsed().as_secs_f64() * 1000.0, output.layer_index,
                        output.tank_index, output.block_index, output.runs.len());
                }
                let result = consume(output);
                if let Some(start) = first_output {
                    eprintln!("[DF_CUDA_TRACE] HOST adapter={:p} elapsed_ms={:.3} event=encoder.{}",
                        job, start.elapsed().as_secs_f64() * 1000.0,
                        if result.is_ok() { "done" } else { "error" });
                }
                result?;
            }
            Ok(())
        })
    }
    #[cfg(not(all(feature = "cuda", target_os = "windows")))]
    {
        let _ = (job, blocks, compute_stats, dense_raster_semantics, &mut consume);
        Err(SlicerV3Error::Cuda(CudaFailure { kind: CudaFailureKind::Unavailable,
            message: "this build has no Windows CUDA backend; enable the cuda Cargo feature on Windows".into() }))
    }
}
