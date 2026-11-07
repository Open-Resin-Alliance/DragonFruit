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

fn append_prism(job: &mut SliceJobV3, bottom: [[f32; 2]; 4], top: [[f32; 2]; 4],
    z0: f32, z1: f32) {
    let vertices: [[f32; 3]; 8] = std::array::from_fn(|index| {
        let point = if index < 4 { bottom[index] } else { top[index - 4] };
        [point[0], point[1], if index < 4 { z0 } else { z1 }]
    });
    let faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    for face in faces {
        for index in face { job.triangles_xyz.extend_from_slice(&vertices[index]); }
    }
}

fn rectangle(x0: f32, x1: f32, y0: f32, y1: f32) -> [[f32; 2]; 4] {
    [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

fn energy_regions(size: usize) -> Vec<std::ops::Range<usize>> {
    let mut boundaries: Vec<usize> = (0..size).step_by(16).collect();
    if boundaries.len() > 1 && size - boundaries[boundaries.len() - 1] < 16 {
        boundaries.pop();
    }
    boundaries.push(size);
    boundaries.windows(2).map(|pair| pair[0]..pair[1]).collect()
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
    job.anti_aliasing_mode = "3DAA".into();
    job.anti_aliasing_level = "4x".into();
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
        let palette: [u8; 8] = std::array::from_fn(|level|
            (level as f64 * (255.0 / 7.0)).round() as u8);
        assert!(quantized.iter().all(|value| palette.contains(value)),
            "dithering must emit the requested palette, not bypass quantization");
        let columns = energy_regions(65);
        for rows in energy_regions(49) {
            for columns in &columns {
                let mut requested_energy = 0.0;
                let mut actual_energy = 0.0;
                for y in rows.clone() {
                    for x in columns.clone() {
                        let index = y * 65 + x;
                        requested_energy += (requested[index] as f64 / 255.0)
                            .powf(job.dither_device_gamma);
                        actual_energy += (quantized[index] as f64 / 255.0)
                            .powf(job.dither_device_gamma);
                    }
                }
                let count = rows.len() * columns.len();
                assert!((requested_energy - actual_energy).abs() <= 0.01 * count as f64,
                    "regional exposure differs at x={columns:?}, y={rows:?}");
            }
        }
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
    let mut reference = Vec::new();
    slice_and_rasterize_rle_v3(&job, false, |index, runs| {
        reference.push((index, runs)); Ok(())
    }, None, None).unwrap();
    reference.sort_by_key(|entry| entry.0);
    let mut actual = Vec::new();
    render(&job, &[], false, 0, None, |output| {
        actual.push((output.layer_index, output.runs)); Ok(())
    }).unwrap();
    assert_eq!(actual, reference, "cancelled pooled work must not contaminate a fresh job");
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

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn pooled_sloped_layers_preserve_centers_and_subrow_band_boundaries() {
    for aa in ["Off", "4x"] {
        let mut job = box_job();
        job.source_width_px = 257;
        job.width_px = 257;
        job.source_height_px = 4097;
        job.height_px = 4097;
        job.layer_height_mm = 0.5;
        job.total_layers = 8;
        job.anti_aliasing_level = aa.into();
        job.minimum_aa_alpha_percent = 0.0;
        job.triangles_xyz.clear();
        let bottom = [[-12.0, -15.0], [-3.0, -15.0], [5.0, 15.0], [-10.0, 15.0]];
        let top = bottom.map(|point| [point[0] + 4.0, point[1] - 1.0]);
        append_prism(&mut job, bottom, top, -0.5, 3.75);
        let right = rectangle(12.0, 17.0, -8.0, 9.0);
        append_prism(&mut job, right, right, -0.5, 2.25);
        let count = job.source_width_px as usize * job.source_height_px as usize;
        let mut reference = vec![Vec::new(); job.total_layers as usize];
        slice_and_rasterize_rle_v3(&job, false, |index, runs| {
            reference[index as usize] = expand_rle_to_mask(&runs, count); Ok(())
        }, None, None).unwrap();
        let mut order = Vec::new();
        render(&job, &[], false, 0, None, |output| {
            order.push(output.layer_index);
            let actual = expand_rle_to_mask(&output.runs, count);
            let tolerance = if aa == "Off" { 0 } else { 1 };
            for (pixel, (&actual, &expected)) in actual.iter()
                .zip(&reference[output.layer_index as usize]).enumerate() {
                assert!(actual.abs_diff(expected) <= tolerance,
                    "aa={aa} layer={} pixel={pixel}: actual={actual}, expected={expected}",
                    output.layer_index);
            }
            Ok(())
        }).unwrap();
        assert_eq!(order, (0..job.total_layers).collect::<Vec<_>>());
    }
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn component_bands_preserve_merges_splits_and_extrema_across_layers() {
    let mut job = box_job();
    job.source_width_px = 257;
    job.width_px = 257;
    job.source_height_px = 4097;
    job.height_px = 4097;
    job.triangles_xyz.clear();
    for (x0, x1) in [(-10.0, -6.0), (6.0, 10.0)] {
        let side = rectangle(x0, x1, -8.0, 8.0);
        append_prism(&mut job, side, side, -0.5, 4.5);
    }
    // The crossbar straddles the central row boundary and disappears at Z=1.5:
    // one connected film becomes two independently counted components.
    let bridge = rectangle(-10.0, 10.0, -0.03125, 0.03125);
    append_prism(&mut job, bridge, bridge, -0.5, 1.5);
    let (_, reference, _) = slice_and_rasterize_rle_v3(&job, true, |_, _| Ok(()),
        None, None).unwrap();
    assert_eq!(reference.iter().map(|stats| stats.area_count).collect::<Vec<_>>(),
        vec![1, 2, 2, 2, 0]);
    let pixel_area = (job.build_width_mm as f64 / job.source_width_px as f64)
        * (job.build_depth_mm as f64 / job.source_height_px as f64);
    render(&job, &[], true, 0, None, |output| {
        let actual = &output.stats;
        let expected = &reference[output.layer_index as usize];
        assert_eq!(actual.total_solid_pixels, expected.total_solid_pixels);
        assert_eq!(actual.area_count, expected.area_count);
        assert_eq!((actual.min_x, actual.min_y, actual.max_x, actual.max_y),
            (expected.min_x, expected.min_y, expected.max_x, expected.max_y));
        for (actual, expected) in [(actual.total_solid_area_mm2, expected.total_solid_area_mm2),
            (actual.largest_area_mm2, expected.largest_area_mm2),
            (actual.smallest_area_mm2, expected.smallest_area_mm2)] {
            assert!((actual - expected).abs() <= pixel_area * 1e-9);
        }
        Ok(())
    }).unwrap();
}

#[test]
#[ignore = "requires an eligible NVIDIA GPU and CUDA 12.9 Windows runtime"]
fn pooled_tank_masks_and_raw_supports_match_cpu_without_cross_tank_cache_reuse() {
    let mut job = box_job();
    job.triangles_xyz.clear();
    let left = rectangle(-18.0, -2.0, -8.0, 8.0);
    let right = rectangle(2.0, 18.0, -8.0, 8.0);
    append_prism(&mut job, left, left, -0.5, 4.5);
    append_prism(&mut job, right, right, -0.5, 4.5);
    job.model_triangle_count = job.triangle_count() as u32;
    let support = rectangle(-1.0, 1.0, -4.0, 4.0);
    append_prism(&mut job, support, support, -0.5, 4.5);
    job.tank_count = 2;
    job.triangle_tank_index = (0..job.triangle_count()).map(|index|
        if index < 12 { 0 } else { 1 }).collect();
    let mut reference = Vec::new();
    crate::engine::slice_and_rasterize_rle_multi_tank_v3(&job, false,
        |layer, tank, runs| { reference.push((tank, layer, runs)); Ok(()) },
        None, None).unwrap();
    reference.sort_by_key(|entry| (entry.0, entry.1));
    let mut actual = Vec::new();
    render(&job, &[], false, 0, None, |output| {
        actual.push((output.tank_index, output.layer_index, output.runs)); Ok(())
    }).unwrap();
    assert_eq!(actual, reference);
}
