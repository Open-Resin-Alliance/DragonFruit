//! Island scan Application Service — orchestrates the full pipeline.
//!
//! Ported from `IslandScan/ScanOrchestrator.ts`.
//! Coordinates Phase 1 (per-layer scan) and Phase 2 (island tracking).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};

use rayon::prelude::*;

use crate::model::*;
use crate::scan::scan_layer;
use crate::tracker::IslandTracker;

/// Run the full island detection pipeline.
///
/// Phase 1: Per-layer scan (**parallel** via rayon)
/// Phase 2: Sequential island tracking
/// Phase 3: Volume calculation and filtering
pub fn run_island_scan(
    job: &IslandScanJob,
    masks: &[RleMask],
    on_progress: Option<&(dyn Fn(u32, u32) + Sync)>,
) -> IslandScanResult {
    let num_layers = masks.len();

    // Phase 1: Per-layer scan — embarrassingly parallel.
    // Each layer only reads masks[i] and masks[i-1] (immutable input).
    let progress = AtomicU32::new(0);
    let layer_results: Vec<ScanLayerResult> = (0..num_layers)
        .into_par_iter()
        .map(|i| {
            let prev = if i > 0 { Some(&masks[i - 1]) } else { None };
            let result = scan_layer(
                &masks[i],
                prev,
                job.px_mm,
                job.support_buffer_mm,
                job.connectivity,
            );
            let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some(cb) = on_progress {
                cb(done, num_layers as u32 * 2);
            }
            result
        })
        .collect();

    // Phase 2: Sequential island tracking
    let mut tracker = IslandTracker::with_candidate_reach(
        job.px_mm,
        job.min_overlap_px,
        job.overlap_neighborhood_px,
        job.cantilever_overlap_neighborhood_px(),
        job.connectivity,
    );
    let mut island_labels_per_layer: Vec<RleLabels> = Vec::with_capacity(num_layers);

    for (l, lr) in layer_results.iter().enumerate() {
        let prev_labels = if l > 0 {
            Some(&island_labels_per_layer[l - 1])
        } else {
            None
        };

        let island_labels = tracker.process_layer(
            l as u32,
            &lr.labels,
            &lr.components,
            prev_labels,
            &lr.solid_mask,
            job.candidate_only,
        );
        island_labels_per_layer.push(island_labels);

        if let Some(cb) = on_progress {
            cb(num_layers as u32 + l as u32 + 1, num_layers as u32 * 2);
        }
    }

    tracker.finalize_islands(num_layers.saturating_sub(1) as u32);

    // Phase 3: Volume calculation, max-area, placeholder resolution, and
    // min-area filtering — shared with the streaming pipeline.
    postprocess_with_mode(
        job.grid.clone(),
        tracker.get_islands(),
        island_labels_per_layer,
        job.layer_height_mm,
        job.min_island_area_mm2,
        job.candidate_only,
    )
}

/// Phase 3 of the island pipeline: volume calculation, max-area, placeholder
/// dropping, true-parent resolution, and min-area filtering. Shared by the
/// batch (`run_island_scan`) and streaming (`run_island_scan_streaming`)
/// orchestrators so both produce identical post-processing.
pub fn postprocess(
    grid: GridRef,
    islands: Vec<Island>,
    island_labels_per_layer: Vec<RleLabels>,
    layer_height_mm: f64,
    min_island_area_mm2: f64,
) -> IslandScanResult {
    postprocess_with_mode(
        grid,
        islands,
        island_labels_per_layer,
        layer_height_mm,
        min_island_area_mm2,
        false,
    )
}

pub fn postprocess_with_mode(
    grid: GridRef,
    mut islands: Vec<Island>,
    mut island_labels_per_layer: Vec<RleLabels>,
    layer_height_mm: f64,
    min_island_area_mm2: f64,
    candidate_only: bool,
) -> IslandScanResult {
    // Volume: Σ per-layer area × layer height
    for island in &mut islands {
        let mut volume = 0.0;
        for &area_mm2 in island.per_layer_area_mm2.values() {
            volume += area_mm2 * layer_height_mm;
        }
        island.volume_mm3 = Some(volume);
    }

    // Max area (overwrites the incremental max with the true per-layer max)
    for island in &mut islands {
        let mut max_area = 0.0_f64;
        for &area in island.per_layer_area_mm2.values() {
            if area > max_area {
                max_area = area;
            }
        }
        island.max_area_mm2 = Some(max_area);
    }

    // Filter placeholders and small islands
    let real_islands: Vec<&Island> = islands
        .iter()
        .filter(|i| !i.is_merged_placeholder)
        .collect();

    // Build placeholder-to-parent map
    let placeholder_to_parent: HashMap<IslandId, IslandId> = islands
        .iter()
        .filter(|i| i.is_merged_placeholder && i.parent_id.is_some())
        .map(|i| (i.id, i.parent_id.unwrap()))
        .collect();

    let filtered_islands: Vec<Island> = real_islands
        .iter()
        .filter(|i| {
            let effective_area = if candidate_only {
                i.pre_merge_max_area_mm2.or(i.max_area_mm2)
            } else {
                i.max_area_mm2
            }
            .unwrap_or(0.0);
            (candidate_only && i.is_detached && i.max_area_mm2.unwrap_or(0.0) > 0.0)
                || effective_area >= min_island_area_mm2
        })
        .cloned()
        .cloned()
        .collect();

    let filtered_ids: HashSet<IslandId> = filtered_islands.iter().map(|i| i.id).collect();

    // Reassign placeholder pixels and filter small island pixels (parallel per layer)
    island_labels_per_layer.par_iter_mut().for_each(|layer_labels| {
        for row in &mut layer_labels.rows {
            for run in row.iter_mut() {
                if run.id > 0 {
                    let island_id = IslandId(run.id as u32);
                    if placeholder_to_parent.contains_key(&island_id) {
                        let resolved = resolve_true_parent(island_id, &placeholder_to_parent);
                        run.id = resolved.0 as i32;
                    } else if !filtered_ids.contains(&island_id) {
                        run.id = 0;
                    }
                }
            }
        }
    });

    IslandScanResult {
        grid,
        islands: filtered_islands,
        island_labels_per_layer,
    }
}

/// Resolve placeholder chains to find the true parent.
fn resolve_true_parent(
    island_id: IslandId,
    placeholder_to_parent: &HashMap<IslandId, IslandId>,
) -> IslandId {
    let mut current = island_id;
    let mut visited = HashSet::new();

    while let Some(&parent) = placeholder_to_parent.get(&current) {
        if visited.contains(&current) {
            break;
        }
        visited.insert(current);
        current = parent;
    }
    current
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::pipeline::*;
    use crate::rle::rle_encode;

    fn make_job(width: i32, height: i32, num_layers: u32) -> IslandScanJob {
        IslandScanJob {
            px_mm: 0.05,
            support_buffer_mm: 0.1,
            connectivity: Connectivity::Four,
            min_island_area_mm2: 0.0001,
            layer_height_mm: 0.05,
            grid: GridRef {
                origin_x: 0.0,
                origin_z: 0.0,
                width,
                height,
                px_mm: 0.05,
            },
            num_layers,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: false,
        }
    }

    #[test]
    fn pipeline_single_cube_no_islands_after_layer_0() {
        let w = 5;
        let h = 5;
        // A solid 3x3 block present on all layers
        #[rustfmt::skip]
        let data: Vec<u8> = vec![
            0,0,0,0,0,
            0,1,1,1,0,
            0,1,1,1,0,
            0,1,1,1,0,
            0,0,0,0,0,
        ];
        let mask = rle_encode(&data, w, h);
        let masks = vec![mask.clone(), mask.clone(), mask.clone()];

        let job = make_job(w, h, 3);
        let result = run_island_scan(&job, &masks, None);

        // Layer 0 creates one island (everything unsupported).
        // Layers 1-2 are fully supported → no new candidates, but the island continues.
        assert!(!result.islands.is_empty());
        let main = &result.islands[0];
        assert_eq!(main.first_layer, 0);
    }

    #[test]
    fn pipeline_two_separated_cubes() {
        let w = 10;
        let h = 1;
        #[rustfmt::skip]
        let data: Vec<u8> = vec![1,1,0,0,0,0,0,0,1,1];
        let mask = rle_encode(&data, w, h);
        let masks = vec![mask.clone(), mask.clone()];

        let job = make_job(w, h, 2);
        let result = run_island_scan(&job, &masks, None);

        assert_eq!(result.islands.len(), 2);
    }

    #[test]
    fn pipeline_overhang_creates_new_island() {
        let w = 10;
        let h = 1;
        // Layer 0: narrow base
        let base: Vec<u8> = vec![0, 0, 0, 1, 1, 1, 0, 0, 0, 0];
        // Layer 1: wider (overhangs on both sides with 0 buffer)
        let wide: Vec<u8> = vec![0, 1, 1, 1, 1, 1, 1, 1, 0, 0];

        let mask0 = rle_encode(&base, w, h);
        let mask1 = rle_encode(&wide, w, h);
        let masks = vec![mask0, mask1];

        let job = IslandScanJob {
            support_buffer_mm: 0.0, // No buffer → strict overhang detection
            ..make_job(w, h, 2)
        };
        let result = run_island_scan(&job, &masks, None);

        // Should have the base island from layer 0, plus overhang candidates from layer 1
        assert!(result.islands.len() >= 1);
    }

    #[test]
    fn nbr01_candidate_moat_chains_sloped_cantilever_across_layers() {
        // B = 0.25 / 0.05 = 5 px; stepping 6 px/layer leaves a 5-px support moat
        // between consecutive layers' candidate strips.
        let w = 64;
        let h = 4;
        let px_mm = 0.05;
        let support_buffer_mm = 0.25;

        let mut masks = Vec::new();
        for l in 0..5i32 {
            let mut data = vec![0u8; (w * h) as usize];
            let x_start = l * 6;
            let x_end = x_start + 12;
            for y in 1..3 {
                for x in x_start..x_end {
                    data[(y * w + x) as usize] = 1;
                }
            }
            masks.push(rle_encode(&data, w, h));
        }

        let job = IslandScanJob {
            px_mm,
            support_buffer_mm,
            connectivity: Connectivity::Eight,
            min_island_area_mm2: 0.0001,
            layer_height_mm: 0.05,
            grid: GridRef {
                origin_x: 0.0,
                origin_z: 0.0,
                width: w,
                height: h,
                px_mm,
            },
            num_layers: 5,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: true,
        };

        let result = run_island_scan(&job, &masks, None);
        assert_eq!(job.cantilever_overlap_neighborhood_px(), 6);
        assert_eq!(
            result.islands.len(),
            1,
            "expected 1 chained cantilever island, got {}",
            result.islands.len(),
        );
        assert_eq!(result.islands[0].first_layer, 0);
        assert_eq!(result.islands[0].last_layer, 4);

        // In solid mode (candidate_only: false), two columns separated by a 4-px
        // gap must stay separate instead of merging via inflated B + 1 = 6 neighborhood.
        let mut col_data = vec![0u8; (w * h) as usize];
        for y in 1..3 {
            for x in 2..6 {
                col_data[(y * w + x) as usize] = 1;
            }
            for x in 10..14 {
                col_data[(y * w + x) as usize] = 1;
            }
        }
        let col_mask = rle_encode(&col_data, w, h);
        let solid_masks = vec![col_mask.clone(), col_mask.clone(), col_mask];
        let solid_job = IslandScanJob {
            num_layers: 3,
            candidate_only: false,
            ..job
        };
        assert_eq!(solid_job.overlap_neighborhood_px, 1);
        assert_eq!(solid_job.cantilever_overlap_neighborhood_px(), 6);
        let solid_result = run_island_scan(&solid_job, &solid_masks, None);
        assert_eq!(solid_result.islands.len(), 2);
    }

    #[test]
    fn nbr03_oblique_staircase_edge_unifies_under_eight_connectivity() {
        let w = 24;
        let h = 4;
        // Layer 0: [0, 10) at row 1
        let mut d0 = vec![0u8; (w * h) as usize];
        for x in 0..10 {
            d0[w as usize + x] = 1;
        }
        // Layer 1: [0, 10) at row 1 and [10, 20) at row 2 (diagonal corner at (9,1)-(10,2))
        let mut d1 = d0.clone();
        for x in 10..20 {
            d1[2 * w as usize + x] = 1;
        }
        let m0 = rle_encode(&d0, w, h);
        let m1 = rle_encode(&d1, w, h);

        let base_job = IslandScanJob {
            support_buffer_mm: 0.0,
            overlap_neighborhood_px: 0,
            num_layers: 2,
            ..make_job(w, h, 2)
        };

        // Single-layer staircase: 2 islands under Four, 1 island under Eight
        let single_four = run_island_scan(
            &IslandScanJob {
                num_layers: 1,
                connectivity: Connectivity::Four,
                ..base_job.clone()
            },
            &[m1.clone()],
            None,
        );
        assert_eq!(single_four.islands.len(), 2);

        let single_eight = run_island_scan(
            &IslandScanJob {
                num_layers: 1,
                connectivity: Connectivity::Eight,
                ..base_job.clone()
            },
            &[m1.clone()],
            None,
        );
        assert_eq!(single_eight.islands.len(), 1);

        // Multi-layer solid-mode: process_subsequent_layer must also respect Eight vs Four
        let multi_four = run_island_scan(
            &IslandScanJob {
                connectivity: Connectivity::Four,
                ..base_job.clone()
            },
            &[m0.clone(), m1.clone()],
            None,
        );
        assert_eq!(multi_four.islands.len(), 2);

        let multi_eight = run_island_scan(
            &IslandScanJob {
                connectivity: Connectivity::Eight,
                ..base_job
            },
            &[m0, m1],
            None,
        );
        assert_eq!(multi_eight.islands.len(), 1);
    }

    #[test]
    fn c2_cantilever_saddle_merge_direct_completion_and_pre_merge_area_gate() {
        let w = 48;
        let h = 24;
        let px_mm = 0.05; // 1px = 0.0025 mm2
        let support_buffer_mm = 0.25; // B = 5 -> cantilever reach = 6

        let paint_rect = |data: &mut Vec<u8>, x0: i32, x1: i32, y0: i32, y1: i32| {
            for y in y0..y1 {
                for x in x0..x1 {
                    data[(y * w + x) as usize] = 1;
                }
            }
        };

        // Layer 0 & 1: two distant vertical pillars
        let mut d0 = vec![0u8; (w * h) as usize];
        paint_rect(&mut d0, 1, 4, 2, 10);
        paint_rect(&mut d0, 34, 37, 2, 10);
        let m0 = rle_encode(&d0, w, h);
        let m1 = m0.clone();

        // Layer 2: two tiny attached cantilever prongs (C_2 left: x=9..11, y=5 => 2px = 0.005 mm2;
        // C_2 right: x=27..29, y=5 => 2px = 0.005 mm2)
        let mut d2 = d0.clone();
        paint_rect(&mut d2, 1, 11, 5, 6);
        paint_rect(&mut d2, 27, 37, 5, 6);
        let m2 = rle_encode(&d2, w, h);

        // Layer 3: unified bridge stepping out in +Y to y=11..13 (dy=6 > B=5 from y=5, <= B+1=6)
        let mut d3 = d2.clone();
        paint_rect(&mut d3, 1, 37, 5, 13);
        let m3 = rle_encode(&d3, w, h);

        // Layer 4: bridge steps further out to y=18..20 (C_4 rim)
        let mut d4 = d3.clone();
        paint_rect(&mut d4, 1, 37, 5, 20);
        let m4 = rle_encode(&d4, w, h);

        let masks = vec![m0, m1, m2, m3, m4];

        // Case 1: min_island_area_mm2 below pre_merge_max_area_mm2 (0.002 < 0.005)
        // Both L2 cantilever prongs must survive with zero PendingMerge placeholders, and survivor reaches L4.
        let low_gate_job = IslandScanJob {
            px_mm,
            support_buffer_mm,
            connectivity: Connectivity::Eight,
            min_island_area_mm2: 0.002,
            layer_height_mm: 0.05,
            grid: GridRef {
                origin_x: 0.0,
                origin_z: 0.0,
                width: w,
                height: h,
                px_mm,
            },
            num_layers: 5,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: true,
        };
        let low_res = run_island_scan(&low_gate_job, &masks, None);
        let l2_islands: Vec<&Island> = low_res
            .islands
            .iter()
            .filter(|i| i.first_layer == 2)
            .collect();
        assert_eq!(l2_islands.len(), 2, "both L2 cantilever prongs must survive direct saddle completion");
        assert!(
            low_res.islands.iter().all(|i| !i.is_merged_placeholder),
            "candidate_only saddle merge must NOT leave PendingMerge placeholders"
        );
        assert!(
            l2_islands.iter().any(|i| i.last_layer == 4),
            "surviving ancestor must continue through layer 4"
        );
        for prong in &l2_islands {
            assert!(!prong.is_detached);
            assert!(prong.parent_id.is_none());
            assert!(
                (prong.pre_merge_max_area_mm2.unwrap_or(0.0) - 0.005).abs() < 1e-6,
                "pre_merge_max_area_mm2 must stay frozen at 0.005 mm2, got {:?}",
                prong.pre_merge_max_area_mm2
            );
        }

        // Case 2: min_island_area_mm2 above pre_merge_max_area_mm2 (0.02 > 0.005) yet below post-merge saddle (0.09)
        // Sub-threshold CantileverFringe prongs must be filtered out instead of bypassing min_area via merged bridge!
        let high_gate_job = IslandScanJob {
            min_island_area_mm2: 0.02,
            ..low_gate_job
        };
        let high_res = run_island_scan(&high_gate_job, &masks, None);
        assert!(
            !high_res.islands.iter().any(|i| i.first_layer == 2),
            "sub-threshold CantileverFringe prongs must NOT bypass min_island_area_mm2 via post-merge saddle area"
        );
    }

    #[test]
    fn c2_detached_tip_rescued_from_wall_halo_chains_upper_rings_and_preserves_detached() {
        let w = 32;
        let h = 16;
        let px_mm = 0.05;
        let support_buffer_mm = 0.25; // B = 5 -> cantilever reach = 6

        let paint_rect = |data: &mut Vec<u8>, x0: i32, x1: i32, y0: i32, y1: i32| {
            for y in y0..y1 {
                for x in x0..x1 {
                    data[(y * w + x) as usize] = 1;
                }
            }
        };

        // Layer 0: vertical wall x=1..5, y=2..14
        let mut d0 = vec![0u8; (w * h) as usize];
        paint_rect(&mut d0, 1, 5, 2, 14);
        let m0 = rle_encode(&d0, w, h);

        // Layer 1: wall continues + detached needle at x=7..9, y=6..8 (2px from wall -> inside B=5 halo)
        let mut d1 = d0.clone();
        paint_rect(&mut d1, 7, 9, 6, 8);
        let m1 = rle_encode(&d1, w, h);

        // Layer 2: wall continues + needle widens rightward to x=7..16, y=5..9 (C_2 outer rim at x=14..16, 6px from x=8)
        let mut d2 = d1.clone();
        paint_rect(&mut d2, 7, 16, 5, 9);
        let m2 = rle_encode(&d2, w, h);

        let job = IslandScanJob {
            px_mm,
            support_buffer_mm,
            connectivity: Connectivity::Eight,
            min_island_area_mm2: 0.05, // larger than birth tip (4px = 0.01 mm2)
            layer_height_mm: 0.05,
            grid: GridRef {
                origin_x: 0.0,
                origin_z: 0.0,
                width: w,
                height: h,
                px_mm,
            },
            num_layers: 3,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: true,
        };

        let res = run_island_scan(&job, &[m0, m1, m2], None);
        let tip = res
            .islands
            .iter()
            .find(|i| i.first_layer == 1)
            .expect("detached tip born at layer 1 must survive");
        assert!(tip.is_detached, "chained upper rings must preserve birth is_detached");
        assert_eq!(tip.last_layer, 2);
    }

    #[test]
    fn c2_solid_mode_pending_merge_uses_max_area_not_pre_merge_max_area() {
        let w = 12;
        let h = 10;
        let px_mm = 0.05; // 1 px = 0.0025 mm2

        let paint_rect = |data: &mut Vec<u8>, x0: i32, x1: i32, y0: i32, y1: i32| {
            for y in y0..y1 {
                for x in x0..x1 {
                    data[(y * w + x) as usize] = 1;
                }
            }
        };

        // Layer 0: two tiny 2-px islands (0.005 mm2 each < min_island_area_mm2 = 0.02)
        let mut d0 = vec![0u8; (w * h) as usize];
        paint_rect(&mut d0, 1, 3, 4, 5);
        paint_rect(&mut d0, 9, 11, 4, 5);
        let m0 = rle_encode(&d0, w, h);

        // Layers 1..=32 (past merge_eval_window = 30): merged solid block of 36 px (0.09 mm2 >= 0.02)
        let mut d_solid = vec![0u8; (w * h) as usize];
        paint_rect(&mut d_solid, 1, 11, 3, 7); // 10 x 4 = 40 px = 0.10 mm2
        let m_solid = rle_encode(&d_solid, w, h);

        let mut masks = Vec::with_capacity(33);
        masks.push(m0);
        for _ in 1..33 {
            masks.push(m_solid.clone());
        }

        let job = IslandScanJob {
            px_mm,
            support_buffer_mm: 0.1,
            connectivity: Connectivity::Eight,
            min_island_area_mm2: 0.02,
            layer_height_mm: 0.05,
            grid: GridRef {
                origin_x: 0.0,
                origin_z: 0.0,
                width: w,
                height: h,
                px_mm,
            },
            num_layers: masks.len() as u32,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: false,
        };

        let res = run_island_scan(&job, &masks, None);
        assert!(
            !res.islands.is_empty(),
            "solid-mode PendingMerge growth (0.10 mm2 >= 0.02) must NOT be blocked by pre_merge_max_area_mm2"
        );
        assert!(res.islands[0].max_area_mm2.unwrap_or(0.0) >= 0.09);
    }
}
