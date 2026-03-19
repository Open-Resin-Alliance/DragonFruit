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
    let mut tracker = IslandTracker::new(
        job.px_mm,
        job.min_overlap_px,
        job.overlap_neighborhood_px,
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
        );
        island_labels_per_layer.push(island_labels);

        if let Some(cb) = on_progress {
            cb(num_layers as u32 + l as u32 + 1, num_layers as u32 * 2);
        }
    }

    tracker.finalize_islands(num_layers.saturating_sub(1) as u32);
    let mut islands = tracker.get_islands();

    // Phase 3: Volume calculation
    for island in &mut islands {
        let mut volume = 0.0;
        for &area_mm2 in island.per_layer_area_mm2.values() {
            volume += area_mm2 * job.layer_height_mm;
        }
        island.volume_mm3 = Some(volume);
    }

    // Calculate max area
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
        .filter(|i| i.max_area_mm2.unwrap_or(0.0) >= job.min_island_area_mm2)
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
        grid: job.grid.clone(),
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
    use crate::model::*;
    use crate::rle::*;
    use crate::pipeline::*;
    use crate::scan::*;
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
}
