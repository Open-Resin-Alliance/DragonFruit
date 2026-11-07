//! Opt-in tests execute the real native backend, never its CPU fallback.
use super::*;
use crate::{engine::slice_and_rasterize_rle_v3, rle::{crop_rle_columns, expand_rle_to_mask, make_rle_block}};
use std::sync::atomic::{AtomicBool, Ordering};

fn box_job() -> SliceJobV3 {
    let vertices = [
        [-10.0, -8.0, -0.5], [10.0, -8.0, -0.5], [10.0, 8.0, -0.5], [-10.0, 8.0, -0.5],
        [-10.0, -8.0, 4.5], [10.0, -8.0, 4.5], [10.0, 8.0, 4.5], [-10.0, 8.0, 4.5],
    ];
    let faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    let mut triangles_xyz = Vec::new();
    for face in faces { for index in face { triangles_xyz.extend_from_slice(&vertices[index]); } }
    SliceJobV3 { source_width_px: 65, source_height_px: 49, width_px: 65, height_px: 49,
        build_width_mm: 40.0, build_depth_mm: 32.0, layer_height_mm: 1.0, total_layers: 5,
        anti_aliasing_level: "Off".into(), anti_aliasing_mode: "Coverage".into(),
        tank_count: 1, x_packing_mode: "none".into(), triangles_xyz,
        dither_device_gamma: 3.0, ..Default::default() }
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn binary_half_open_centers_mirroring_and_empty_terminal_layer_match_cpu() {
    for mirror_x in [false, true] { for mirror_y in [false, true] {
        let mut job = box_job();
        job.mirror_x = mirror_x;
        job.mirror_y = mirror_y;
        let mut reference = Vec::new();
        slice_and_rasterize_rle_v3(&job, false, |index, runs| {
            reference.push((index, runs)); Ok(())
        }, None, None).unwrap();
        reference.sort_by_key(|entry| entry.0);
        let mut actual = Vec::new();
        render(&job, &[], false, 0, None, |output| {
            actual.push((output.layer_index, output.runs)); Ok(())
        }).unwrap();
        assert_eq!(actual, reference);
    } }
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn blur_final_grayscale_stays_within_one_byte_of_cpu() {
    for gaussian in [false, true] {
        let mut job = box_job();
        job.anti_aliasing_mode = "Blur".into();
        job.blur_brush_radius_px = 2;
        job.blur_brush_kernel = if gaussian { "gaussian" } else { "box" }.into();
        job.blur_brush_sigma_x = 0.8;
        job.blur_brush_sigma_y = 1.1;
        let mut reference = vec![Vec::new(); job.total_layers as usize];
        slice_and_rasterize_rle_v3(&job, false, |index, runs| {
            reference[index as usize] = expand_rle_to_mask(&runs, 65 * 49); Ok(())
        }, None, None).unwrap();
        render(&job, &[], false, 0, None, |output| {
            let actual = expand_rle_to_mask(&output.runs, 65 * 49);
            for (&actual, &expected) in actual.iter().zip(&reference[output.layer_index as usize]) {
                assert!(actual.abs_diff(expected) <= 1, "actual={actual}, expected={expected}");
            }
            Ok(())
        }).unwrap();
    }
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn dither_column_blocks_keep_global_energy_phase_and_border_regions() {
    let mut job = box_job();
    job.anti_aliasing_mode = "Blur".into();
    job.blur_brush_radius_px = 2;
    job.blur_brush_kernel = "box".into();
    job.dither_enabled = true;
    job.dither_bit_depth = Some(3);
    let mut full = vec![Vec::new(); job.total_layers as usize];
    render(&job, &[], false, 0, None, |output| {
        full[output.layer_index as usize] = output.runs; Ok(())
    }).unwrap();
    let blocks = [make_rle_block(0, 31), make_rle_block(31, 34)];
    render(&job, &blocks, false, 0, None, |output| {
        let block = blocks[output.block_index as usize];
        let expected = crop_rle_columns(&full[output.layer_index as usize], 65,
            block.start_col, 65 - block.start_col - block.width);
        assert_eq!(output.runs, expected);
        Ok(())
    }).unwrap();
    job.dither_enabled = false;
    render(&job, &[], false, 0, None, |output| {
        let requested = expand_rle_to_mask(&output.runs, 65 * 49);
        let quantized = expand_rle_to_mask(&full[output.layer_index as usize], 65 * 49);
        let energy = |pixels: &[u8]| pixels.iter().map(|&pixel|
            (pixel as f64 / 255.0).powf(job.dither_device_gamma)).sum::<f64>() / pixels.len() as f64;
        assert!((energy(&requested) - energy(&quantized)).abs() <= 0.01);
        for (&requested, &actual) in requested.iter().zip(&quantized) {
            if requested == 0 || requested == 255 { assert_eq!(actual, requested); }
        }
        Ok(())
    }).unwrap();
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn cancellation_drains_native_leases_before_reusing_original_input() {
    let job = box_job();
    let cancel = AtomicBool::new(false);
    let result = render(&job, &[], false, 0, Some(&cancel), |_| {
        cancel.store(true, Ordering::Relaxed); Ok(())
    });
    assert!(matches!(result, Err(crate::engine::SlicerV3Error::Cancelled)));
    let mut layers = 0;
    render(&job, &[], false, 0, None, |_| { layers += 1; Ok(()) }).unwrap();
    assert_eq!(layers, job.total_layers);
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn legacy_dense_gaussian_blur_matches_its_cpu_reference() {
    let mut job = box_job();
    job.anti_aliasing_mode = "Blur".into();
    job.blur_brush_radius_px = 2;
    job.blur_brush_kernel = "gaussian".into();
    job.blur_brush_sigma_x = 0.8;
    job.blur_brush_sigma_y = 1.1;
    let (reference, _, _) = crate::engine::slice_and_rasterize_v3(
        &job, false, false, true, None, None, None).unwrap();
    let reference = reference.raw_mask_layers.unwrap();
    render(&job, &[], false, 1, None, |output| {
        let actual = expand_rle_to_mask(&output.runs, 65 * 49);
        for (&actual, &expected) in actual.iter().zip(&reference[output.layer_index as usize]) {
            assert!(actual.abs_diff(expected) <= 1, "actual={actual}, expected={expected}");
        }
        Ok(())
    }).unwrap();
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn perturbation_patterns_duplicate_z_and_missing_neighbors_match_cpu() {
    for pattern in ["uniform", "halton", "base2"] { for duplicate in [false, true] {
        let mut job = box_job();
        job.anti_aliasing_mode = "3DAA".into();
        job.anti_aliasing_level = "16x".into();
        job.zaa_pattern = Some(pattern.into());
        job.zaa_duplicate_z = Some(duplicate);
        job.blur_brush_radius_px = 2;
        job.z_blur_radius_layers = 2;
        job.z_blur_kernel = "gaussian".into();
        job.z_blur_sigma = 0.7;
        let mut reference = vec![Vec::new(); job.total_layers as usize];
        crate::engine::slice_and_rasterize_perturb_3daa_rle_v3(&job, false, |index, runs| {
            reference[index as usize] = expand_rle_to_mask(&runs, 65 * 49); Ok(())
        }, None, None, None, None).unwrap();
        render(&job, &[], false, 0, None, |output| {
            let actual = expand_rle_to_mask(&output.runs, 65 * 49);
            for (&actual, &expected) in actual.iter().zip(&reference[output.layer_index as usize]) {
                assert!(actual.abs_diff(expected) <= 1,
                    "pattern={pattern} duplicate={duplicate}: actual={actual}, expected={expected}");
            }
            Ok(())
        }).unwrap();
    } }
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn explicitly_empty_cure_lut_is_not_an_absent_lut() {
    let mut job = box_job();
    job.anti_aliasing_mode = "Blur".into();
    job.blur_brush_radius_px = 2;
    job.z_blend_custom_lut = Some(Vec::new());
    let mut reference = vec![Vec::new(); job.total_layers as usize];
    slice_and_rasterize_rle_v3(&job, false, |index, runs| {
        reference[index as usize] = expand_rle_to_mask(&runs, 65 * 49); Ok(())
    }, None, None).unwrap();
    render(&job, &[], false, 0, None, |output| {
        let actual = expand_rle_to_mask(&output.runs, 65 * 49);
        assert_eq!(actual, reference[output.layer_index as usize]);
        assert!(actual.iter().all(|&value| value == 0 || value == 255));
        Ok(())
    }).unwrap();
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn legacy_direct_png_without_support_bypass_keeps_binary_reference_pixels() {
    for mode in ["Coverage", "Blur"] {
        let mut job = box_job();
        job.anti_aliasing_mode = mode.into();
        job.anti_aliasing_level = "4x".into();
        job.blur_brush_radius_px = 2;
        job.dither_enabled = true;
        job.dither_bit_depth = Some(3);
        job.z_blend_custom_lut = Some(Vec::new());
        let mut triangles = crate::geometry::parse_triangles(&job.triangles_xyz);
        crate::geometry::project_triangles_inplace(&mut triangles, &job);
        let indices: Vec<usize> = (0..triangles.len()).collect();
        render(&job, &[], false, 2, None, |output| {
            let (expected, _) = crate::raster::rasterize_layer_rle(
                &job, &triangles, &indices, output.layer_index, false);
            assert_eq!(output.runs, expected);
            assert!(output.runs.iter().all(|run| run.value == 0 || run.value == 255));
            Ok(())
        }).unwrap();
    }
}
