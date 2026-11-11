//! Binary scanlines with one independently progressing layer-row per SIMD lane.
//!
//! Only the current crossing/advance packet lives on the stack. CSR storage,
//! reusable spans, repair history and output remain owned by each raster.

use std::sync::atomic::{AtomicBool, Ordering};

use pulp::{Simd, WithSimd};

use crate::pulp_simd::Backend;
use crate::raster::{restore_active_edges_sorted, BinaryScanlineRaster, RowSpan};
use crate::SlicerV3Error;

pub(crate) const MAX_SCANLINE_LANES: usize = 4;

/// Dispatch once on the executing worker, including for partial layer batches.
/// Wider x86 feature proofs are narrowed to four native f32 lanes, not padded
/// into eight/sixteen-layer allocations. Other vector widths use the real scalar
/// renderer rather than emulating four streams with scalar SIMD operations.
pub(crate) fn render_scanline_batch(
    rasters: &mut [BinaryScanlineRaster],
    backend: Backend,
    cancel: Option<&AtomicBool>,
) -> Result<(), SlicerV3Error> {
    assert!(rasters.len() <= MAX_SCANLINE_LANES);
    backend.for_layer_scanline().dispatch(ScanlineBatch { rasters, cancel })
}

struct ScanlineBatch<'a> {
    rasters: &'a mut [BinaryScanlineRaster],
    cancel: Option<&'a AtomicBool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Crossings,
    Advance,
    Done,
}

#[inline]
fn check_cancel(cancel: Option<&AtomicBool>) -> Result<(), SlicerV3Error> {
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        Err(SlicerV3Error::Cancelled)
    } else {
        Ok(())
    }
}

#[inline(always)]
fn lane_mask<S: Simd>(simd: S, lanes: &[i32; MAX_SCANLINE_LANES]) -> S::m32s {
    // Select/comparison masks also work on backends with compact mask registers.
    simd.equal_i32s(simd.partial_load_i32s(lanes), simd.splat_i32s(1))
}

impl WithSimd for ScanlineBatch<'_> {
    type Output = Result<(), SlicerV3Error>;

    #[inline(always)]
    fn with_simd<S: Simd>(self, simd: S) -> Self::Output {
        check_cancel(self.cancel)?;
        if S::IS_SCALAR || S::F32_LANES != MAX_SCANLINE_LANES {
            for raster in self.rasters {
                raster.render_scalar(self.cancel)?;
            }
            return Ok(());
        }
        render_with_simd(simd, self.rasters, self.cancel)
    }
}

#[inline(always)]
fn render_with_simd<S: Simd>(
    simd: S,
    rasters: &mut [BinaryScanlineRaster],
    cancel: Option<&AtomicBool>,
) -> Result<(), SlicerV3Error> {
    let zero = simd.splat_i32s(0);
    let one = simd.splat_i32s(1);
    let zero_f = simd.splat_f32s(0.0);
    let half = simd.splat_f32s(0.5);
    let finite_limit = simd.splat_f32s(f32::MAX);
    let mut stage = [Stage::Done; MAX_SCANLINE_LANES];
    let mut cursor = [0usize; MAX_SCANLINE_LANES];
    let mut widths = [0i32; MAX_SCANLINE_LANES];
    let mut float_widths = [0.0; MAX_SCANLINE_LANES];
    for (lane, raster) in rasters.iter_mut().enumerate() {
        widths[lane] = raster.width as i32;
        float_widths[lane] = raster.width as f32;
        if raster.prepare_row() {
            stage[lane] = Stage::Crossings;
        }
    }
    let widths = simd.partial_load_i32s(&widths);
    let float_widths = simd.partial_load_f32s(&float_widths);
    let last_columns = simd.sub_i32s(widths, one);
    let mut winding = zero;
    let mut min_winding = zero;
    let mut max_winding = zero;
    let mut cancel_countdown = 0usize;

    while stage.iter().any(|&value| value != Stage::Done) {
        // Bound cancellation latency even on a single extremely wide edge list;
        // no timer, dispatch, allocation or atomic operation per crossing.
        if cancel_countdown == 0 {
            check_cancel(cancel)?;
            cancel_countdown = 256;
        }
        cancel_countdown -= 1;

        let mut left = [0.0; MAX_SCANLINE_LANES];
        let mut right = [0.0; MAX_SCANLINE_LANES];
        let mut winds = [0i32; MAX_SCANLINE_LANES];
        let mut pairs = [0i32; MAX_SCANLINE_LANES];
        let mut last = [0i32; MAX_SCANLINE_LANES];
        let mut advancing = [0i32; MAX_SCANLINE_LANES];
        let mut edge_x = [0.0; MAX_SCANLINE_LANES];
        let mut edge_dx = [0.0; MAX_SCANLINE_LANES];
        for (lane, raster) in rasters.iter_mut().enumerate() {
            match stage[lane] {
                Stage::Crossings => {
                    let edges = &raster.active_edges;
                    if cursor[lane] < edges.len().saturating_sub(1) {
                        pairs[lane] = 1;
                        left[lane] = edges[cursor[lane]].x;
                        right[lane] = edges[cursor[lane] + 1].x;
                        winds[lane] = edges[cursor[lane]].wind;
                    } else {
                        // The finite last edge is included even after an early
                        // nonfinite break, exactly like the scalar closure pass.
                        last[lane] = 1;
                        if let Some(edge) = edges.last() {
                            left[lane] = edge.x;
                            winds[lane] = edge.wind;
                        }
                    }
                }
                Stage::Advance => {
                    advancing[lane] = 1;
                    let edge = &mut raster.active_edges[cursor[lane]];
                    if edge.x.is_finite() && edge.dx_dy.is_finite() {
                        edge_x[lane] = edge.x;
                        edge_dx[lane] = edge.dx_dy;
                    } else {
                        // Preserve the original add on exceptional operands,
                        // without feeding them into otherwise inactive lanes.
                        edge.x += edge.dx_dy;
                        advancing[lane] = 2;
                    }
                }
                Stage::Done => {}
            }
        }

        if pairs.contains(&1) || last.contains(&1) {
            let pair_mask = lane_mask(simd, &pairs);
            let last_mask = lane_mask(simd, &last);
            let left_raw = simd.partial_load_f32s(&left);
            let right_raw = simd.partial_load_f32s(&right);
            let left_finite = simd.less_than_or_equal_f32s(simd.abs_f32s(left_raw), finite_limit);
            let right_finite = simd.less_than_or_equal_f32s(simd.abs_f32s(right_raw), finite_limit);
            let consume = simd.and_m32s(simd.or_m32s(pair_mask, last_mask), left_finite);
            winding = simd.add_i32s(winding, simd.select_i32s(consume, simd.partial_load_i32s(&winds), zero));
            // Winding and closure are identical up to the final closure-only
            // edge. Update extrema after each consumed edge, not after a sum.
            min_winding = simd.select_i32s(consume, simd.min_i32s(min_winding, winding), min_winding);
            max_winding = simd.select_i32s(consume, simd.max_i32s(max_winding, winding), max_winding);
            let nonzero = simd.not_m32s(simd.equal_i32s(winding, zero));
            let stopped = simd.and_m32s(pair_mask, simd.or_m32s(
                simd.not_m32s(left_finite),
                simd.and_m32s(nonzero, simd.not_m32s(right_finite)),
            ));
            let mut stop_lanes = [0i32; MAX_SCANLINE_LANES];
            simd.partial_store_i32s(&mut stop_lanes, simd.select_i32s(stopped, one, zero));

            // Sanitize before min/max/subtraction: neither tails nor a scalar
            // early-break crossing may contaminate span boundary arithmetic.
            let left = simd.select_f32s(left_finite, left_raw, zero_f);
            let right = simd.select_f32s(right_finite, right_raw, zero_f);
            let a = simd.max_f32s(simd.min_f32s(left, right), zero_f);
            let b = simd.min_f32s(simd.max_f32s(left, right), float_widths);
            let candidate = simd.and_m32s(pair_mask, simd.and_m32s(nonzero,
                simd.and_m32s(left_finite, simd.and_m32s(right_finite, simd.greater_than_f32s(b, a)))));
            let a_safe = simd.select_f32s(candidate, a, zero_f);
            let b_safe = simd.select_f32s(candidate, b, zero_f);
            let mut starts = [0.0; MAX_SCANLINE_LANES];
            let mut ends = [0.0; MAX_SCANLINE_LANES];
            simd.partial_store_f32s(&mut starts, simd.sub_f32s(a_safe, half));
            simd.partial_store_f32s(&mut ends, simd.sub_f32s(b_safe, half));
            // Pulp's generic Simd API has no ceil or saturating float-to-int
            // conversion. Retain Rust's exact ceil/as semantics at that boundary;
            // clipping, half-center arithmetic and predicates remain vectorized.
            let starts = starts.map(|value| value.ceil() as i32);
            let ends = ends.map(|value| value.ceil() as i32);
            let starts = simd.partial_load_i32s(&starts);
            let ends = simd.partial_load_i32s(&ends);
            let clipped_start = simd.max_i32s(starts, zero);
            let clipped_end = simd.min_i32s(simd.sub_i32s(ends, one), last_columns);
            let valid = simd.and_m32s(candidate, simd.and_m32s(
                simd.greater_than_i32s(ends, starts), simd.and_m32s(
                    simd.greater_than_i32s(ends, zero), simd.and_m32s(
                        simd.less_than_i32s(starts, widths),
                        simd.greater_than_or_equal_i32s(clipped_end, clipped_start),
                    ),
                ),
            ));
            let mut valid_lanes = [0i32; MAX_SCANLINE_LANES];
            let mut starts = [0i32; MAX_SCANLINE_LANES];
            let mut ends = [0i32; MAX_SCANLINE_LANES];
            let mut aa = [0.0; MAX_SCANLINE_LANES];
            let mut bb = [0.0; MAX_SCANLINE_LANES];
            simd.partial_store_i32s(&mut valid_lanes, simd.select_i32s(valid, one, zero));
            simd.partial_store_i32s(&mut starts, clipped_start);
            simd.partial_store_i32s(&mut ends, clipped_end);
            simd.partial_store_f32s(&mut aa, a);
            simd.partial_store_f32s(&mut bb, b);
            for (lane, raster) in rasters.iter_mut().enumerate() {
                if valid_lanes[lane] != 0 {
                    raster.spans.push(RowSpan {
                        a: aa[lane], b: bb[lane],
                        start: starts[lane] as usize, end: ends[lane] as usize,
                    });
                }
                if pairs[lane] != 0 {
                    cursor[lane] = if stop_lanes[lane] != 0 {
                        raster.active_edges.len().saturating_sub(1)
                    } else {
                        cursor[lane] + 1
                    };
                }
            }

            if last.contains(&1) {
                let mut closure = [0i32; MAX_SCANLINE_LANES];
                let mut minimum = [0i32; MAX_SCANLINE_LANES];
                let mut maximum = [0i32; MAX_SCANLINE_LANES];
                simd.partial_store_i32s(&mut closure, winding);
                simd.partial_store_i32s(&mut minimum, min_winding);
                simd.partial_store_i32s(&mut maximum, max_winding);
                for (lane, raster) in rasters.iter_mut().enumerate() {
                    if last[lane] == 0 { continue; }
                    raster.repair_row_spans(closure[lane], minimum[lane], maximum[lane]);
                    raster.commit_row();
                    cursor[lane] = 0;
                    stage[lane] = if !raster.active_edges.is_empty() {
                        Stage::Advance
                    } else if raster.prepare_row() {
                        Stage::Crossings
                    } else {
                        Stage::Done
                    };
                }
                winding = simd.select_i32s(last_mask, zero, winding);
                min_winding = simd.select_i32s(last_mask, zero, min_winding);
                max_winding = simd.select_i32s(last_mask, zero, max_winding);
            }
        }

        if advancing.iter().any(|&value| value != 0) {
            // Exactly one addition per edge per committed row. Never replace
            // repeated additions with x0 + row*dx, or fuse setup arithmetic.
            let updated = simd.add_f32s(simd.partial_load_f32s(&edge_x), simd.partial_load_f32s(&edge_dx));
            let mut updated_x = [0.0; MAX_SCANLINE_LANES];
            simd.partial_store_f32s(&mut updated_x, updated);
            for (lane, raster) in rasters.iter_mut().enumerate() {
                if advancing[lane] == 0 { continue; }
                if advancing[lane] == 1 {
                    raster.active_edges[cursor[lane]].x = updated_x[lane];
                }
                cursor[lane] += 1;
                if cursor[lane] == raster.active_edges.len() {
                    restore_active_edges_sorted(&mut raster.active_edges);
                    cursor[lane] = 0;
                    stage[lane] = if raster.prepare_row() { Stage::Crossings } else { Stage::Done };
                }
            }
        }
    }
    check_cancel(cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster::Segment;
    use crate::rle::{expand_rle_to_mask, RleBlockSpec, RleRun};
    use crate::types::{LayerAreaStatsV3, SliceJobV3};

    fn job(width: u32, height: u32) -> SliceJobV3 {
        SliceJobV3 {
            source_width_px: width, source_height_px: height,
            width_px: width, height_px: height,
            build_width_mm: width as f32 * 0.25,
            build_depth_mm: height as f32 * 0.5,
            anti_aliasing_level: "Off".into(),
            anti_aliasing_mode: "Blur".into(),
            x_packing_mode: "none".into(),
            ..Default::default()
        }
    }

    fn edge(x: f32, wind: i32, y_min: f32, y_max: f32, dx: f32) -> Segment {
        Segment { x1: x, y1: y_min, dx_dy: dx, y_min, y_max, wind }
    }

    fn walls(left: f32, right: f32, y_min: f32, y_max: f32, dx: f32) -> Vec<Segment> {
        vec![edge(left, 1, y_min, y_max, dx), edge(right, -1, y_min, y_max, dx)]
    }

    fn assert_stats(actual: &LayerAreaStatsV3, expected: &LayerAreaStatsV3) {
        assert_eq!(actual.total_solid_pixels, expected.total_solid_pixels);
        assert_eq!(actual.total_solid_area_mm2.to_bits(), expected.total_solid_area_mm2.to_bits());
        assert_eq!(actual.largest_area_mm2.to_bits(), expected.largest_area_mm2.to_bits());
        assert_eq!(actual.smallest_area_mm2.to_bits(), expected.smallest_area_mm2.to_bits());
        assert_eq!((actual.min_x, actual.min_y, actual.max_x, actual.max_y, actual.area_count),
            (expected.min_x, expected.min_y, expected.max_x, expected.max_y, expected.area_count));
    }

    fn scalar(
        job: &SliceJobV3, segments: &[Segment], stats: bool, block: Option<RleBlockSpec>,
    ) -> (Vec<RleRun>, LayerAreaStatsV3) {
        let mut raster = BinaryScanlineRaster::new_rle(job, segments, stats, block);
        raster.render_scalar(None).unwrap();
        raster.finish_rle()
    }

    fn assert_canonical(runs: &[RleRun], pixels: usize) {
        assert!(runs.iter().all(|run| run.length != 0));
        assert!(runs.windows(2).all(|pair| pair[0].value != pair[1].value));
        assert_eq!(runs.iter().map(|run| run.length as usize).sum::<usize>(), pixels);
    }

    fn assert_parity(
        jobs: &[SliceJobV3], layers: &[Vec<Segment>], stats: bool, block: Option<RleBlockSpec>,
    ) -> Vec<(Vec<RleRun>, LayerAreaStatsV3)> {
        assert_eq!(jobs.len(), layers.len());
        let expected: Vec<_> = jobs.iter().zip(layers).map(|(job, segments)| scalar(job, segments, stats, block)).collect();
        for backend in Backend::supported_for_tests() {
            let mut rasters: Vec<_> = jobs.iter().zip(layers).map(|(job, segments)|
                BinaryScanlineRaster::new_rle(job, segments, stats, block)).collect();
            render_scanline_batch(&mut rasters, backend, None).unwrap();
            for (lane, raster) in rasters.into_iter().enumerate() {
                let (runs, area) = raster.finish_rle();
                let width = block.map_or(jobs[lane].width_px, |value| value.width) as usize;
                let pixels = width * jobs[lane].height_px as usize;
                assert_canonical(&runs, pixels);
                assert_eq!(runs, expected[lane].0, "lane {lane}, backend {backend:?}");
                assert_eq!(expand_rle_to_mask(&runs, pixels), expand_rle_to_mask(&expected[lane].0, pixels));
                assert_stats(&area, &expected[lane].1);
            }
        }
        expected
    }

    #[test]
    fn binary_half_centers_clipping_and_subpixel_intervals() {
        let mut segments = Vec::new();
        for (left, right) in [(-2.0, 0.5), (0.5, 1.5), (2.49999, 2.50001),
            (3.5, 4.5), (5.50001, 6.49999), (7.5, 10.0)] {
            segments.extend(walls(left, right, 0.0, 2.0, 0.0));
        }
        let result = assert_parity(&[job(8, 2)], &[segments], true, None);
        let row = [255, 0, 255, 255, 0, 0, 0, 255];
        assert_eq!(expand_rle_to_mask(&result[0].0, 16), row.repeat(2));
        assert_eq!(result[0].1.total_solid_pixels, 8);
    }

    #[test]
    fn partial_batches_progress_independently_across_different_rows_and_edges() {
        let mut hole = walls(-1.0, 17.0, 0.0, 13.0, 0.0625);
        hole.extend([edge(4.0, -1, 2.0, 8.0, 0.0), edge(10.0, 1, 2.0, 8.0, 0.0)]);
        hole.extend(walls(21.0, 26.0, 5.0, 12.0, -0.375));
        let mut crossings = walls(1.0, 5.0, 0.0, 17.0, 0.75);
        crossings.extend(walls(14.0, 19.0, 0.0, 17.0, -0.625));
        crossings.extend(walls(3.0, 8.0, 9.0, 11.0, 0.0));
        let jobs = [job(23, 5), job(29, 13), job(21, 17), job(7, 9)];
        let layers = [Vec::new(), hole, crossings, walls(0.5, 6.5, 6.0, 8.0, 0.0)];
        for count in 0..=MAX_SCANLINE_LANES {
            for offset in 0..MAX_SCANLINE_LANES {
                let selected_jobs: Vec<_> = (0..count).map(|lane| jobs[(lane + offset) % 4].clone()).collect();
                let selected_layers: Vec<_> = (0..count).map(|lane| layers[(lane + offset) % 4].clone()).collect();
                assert_parity(&selected_jobs, &selected_layers, true, None);
            }
        }
    }

    #[test]
    fn defective_rows_keep_full_row_history_but_blocks_remain_context_free() {
        let mut segments = walls(10.0, 14.0, 0.0, 1.0, 0.0);
        segments.extend([
            edge(1.0, 1, 1.0, 3.0, 0.0), edge(5.0, -1, 1.0, 3.0, 0.0),
            edge(10.0, -1, 1.0, 3.0, 0.0), edge(14.0, 1, 1.0, 3.0, 0.0),
        ]);
        let mut orphan = walls(3.0, 7.0, 0.0, 5.0, 0.0);
        orphan.extend(walls(12.0, 16.0, 0.0, 5.0, 0.0));
        orphan.extend([edge(1.0, 1, 1.0, 4.0, 0.0), edge(18.0, 1, 1.0, 4.0, 0.0)]);
        let layers = [segments.clone(), orphan, walls(2.0, 2.2, 0.0, 5.0, 0.0), Vec::new()];
        let jobs = [job(20, 5), job(20, 5), job(20, 5), job(20, 5)];
        let full = assert_parity(&jobs, &layers, true, None);
        let pixels = expand_rle_to_mask(&full[0].0, 100);
        assert!(pixels[20 + 10..20 + 14].iter().all(|&value| value == 255));
        assert!(pixels[20 + 1..20 + 5].iter().all(|&value| value == 0));
        let block = assert_parity(&jobs, &layers, true, Some(RleBlockSpec { start_col: 1, width: 15 }));
        let pixels = expand_rle_to_mask(&block[0].0, 75);
        assert!(pixels[15..19].iter().all(|&value| value == 255));
        assert!(pixels[24..28].iter().all(|&value| value == 0));
        assert_parity(&jobs, &layers, false, Some(RleBlockSpec { start_col: 13, width: 7 }));
    }

    #[test]
    fn nonfinite_crossings_and_advances_do_not_poison_other_streams() {
        let mut nan = walls(1.0, 6.0, 0.0, 7.0, 0.1);
        nan.extend([edge(f32::NAN, 1, 0.0, 7.0, 0.0), edge(f32::INFINITY, -1, 0.0, 7.0, 0.0)]);
        let inf = vec![edge(f32::NEG_INFINITY, -1, 0.0, 9.0, 0.0),
            edge(3.0, 1, 0.0, 9.0, 0.0), edge(8.0, -1, 0.0, 9.0, 0.0)];
        let mut overflow = walls(0.5, 4.5, 0.0, 11.0, 0.0);
        overflow.extend([edge(f32::MAX * 0.5, 1, 0.0, 11.0, f32::MAX * 0.5),
            edge(2.0, -1, 0.0, 11.0, f32::INFINITY)]);
        let near_centers = walls(0.49999997, 4.5000005, 0.0, 31.0, 0.000000059604645);
        assert_parity(&[job(13, 7), job(11, 9), job(15, 11), job(9, 31)],
            &[nan, inf, overflow, near_centers], true, None);
    }

    #[test]
    fn generated_crossings_preserve_rle_pixels_and_every_area_stat() {
        let jobs = [job(41, 33), job(37, 29), job(43, 21), job(31, 35)];
        for seed in 0..12usize {
            let layers: Vec<Vec<Segment>> = (0..4).map(|lane| {
                let mut segments = Vec::new();
                for shape in 0..(2 + (seed + lane * 3) % 11) {
                    let left = ((shape * 17 + lane * 7 + seed * 3) % 49) as f32 - 7.5;
                    let width = 0.0002 + ((shape * 11 + seed) % 13) as f32;
                    let y_min = ((shape * 7 + seed + lane) % 15) as f32 - 2.0;
                    let y_max = y_min + 1.0 + ((shape * 3 + lane + seed) % 19) as f32;
                    let dx = ((shape + lane + seed) % 9) as f32 * 0.1171875 - 0.46875;
                    let orientation = if (shape + seed) % 5 == 0 { -1 } else { 1 };
                    segments.extend([edge(left, orientation, y_min, y_max, dx),
                        edge(left + width, -orientation, y_min, y_max, -dx)]);
                }
                segments
            }).collect();
            assert_parity(&jobs, &layers, true, None);
            assert_parity(&jobs[..3], &layers[..3], false, Some(RleBlockSpec { start_col: 7, width: 19 }));
        }
    }

    #[test]
    fn cancellation_precedes_mutation_and_empty_batches_are_supported() {
        let job = job(9, 5);
        let segments = walls(0.5, 7.5, 0.0, 5.0, 0.125);
        let expected = scalar(&job, &segments, true, None);
        for backend in Backend::supported_for_tests() {
            let cancel = AtomicBool::new(true);
            let mut rasters = [BinaryScanlineRaster::new_rle(&job, &segments, true, None)];
            assert!(matches!(render_scanline_batch(&mut rasters, backend, Some(&cancel)), Err(SlicerV3Error::Cancelled)));
            cancel.store(false, Ordering::Relaxed);
            render_scanline_batch(&mut rasters, backend, Some(&cancel)).unwrap();
            let [(runs, stats)] = rasters.map(BinaryScanlineRaster::finish_rle);
            assert_eq!(runs, expected.0);
            assert_stats(&stats, &expected.1);
            render_scanline_batch(&mut [], backend, None).unwrap();
        }
    }
}
