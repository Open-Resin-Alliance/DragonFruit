use std::collections::{HashMap, HashSet};
use crate::model::*;
use crate::scan::scan_layer;
use crate::tracker::IslandTracker;
use crate::rasterize::rasterize_layer_for_island_scan;
use dragonfruit_slicing_engine::geometry::Triangle;

/// Run the island scan using a streaming pipeline.
///
/// Slicing and rasterization are performed sequentially, keeping only the
/// current and previous layer masks in memory.
///
/// - `job`: The island scan configuration.
/// - `triangles`: The parsed model triangles.
/// - `bbox_min_z`: The Z minimum of the model.
/// - `store_labels`: If true, the full 3D labels volume `island_labels_per_layer`
///   is retained and returned (used for Volume Analysis visual overlays).
///   If false, masks are immediately discarded to achieve O(1) memory scalability.
/// - `on_progress`: Progress callback.
pub fn run_island_scan_streaming(
    job: &IslandScanJob,
    triangles: &[Triangle],
    bbox_min_z: f64,
    store_labels: bool,
    on_progress: Option<&(dyn Fn(u32, u32) + Sync)>,
) -> IslandScanResult {
    let num_layers = job.num_layers as usize;

    let mut tracker = IslandTracker::new(
        job.px_mm,
        job.min_overlap_px,
        job.overlap_neighborhood_px,
    );

    let mut prev_mask: Option<RleMask> = None;
    let mut prev_island_labels: Option<RleLabels> = None;
    let mut island_labels_per_layer = Vec::with_capacity(if store_labels { num_layers } else { 0 });

    for l in 0..num_layers {
        // Match TS: z = zOffset + (idx + 1) * layerHeight + 1e-6
        let z = bbox_min_z + (l as f64 + 1.0) * job.layer_height_mm + 1e-6;

        // 1. Slice and rasterize the current layer
        let current_mask = rasterize_layer_for_island_scan(
            triangles,
            z,
            job.grid.width,
            job.grid.height,
            job.grid.origin_x,
            job.grid.origin_z,
            job.px_mm,
        );

        // 2. Scan candidates against previous layer
        let lr = scan_layer(
            &current_mask,
            prev_mask.as_ref(),
            job.px_mm,
            job.support_buffer_mm,
            job.connectivity,
        );

        // 3. Track islands sequentially
        let island_labels = tracker.process_layer(
            l as u32,
            &lr.labels,
            &lr.components,
            prev_island_labels.as_ref(),
            &lr.solid_mask,
            job.candidate_only,
        );

        // 4. Update window (older layers are dropped from memory here)
        prev_mask = Some(current_mask);
        prev_island_labels = Some(island_labels.clone());

        if store_labels {
            island_labels_per_layer.push(island_labels);
        }

        if let Some(cb) = on_progress {
            cb(l as u32 + 1, num_layers as u32);
        }
    }

    tracker.finalize_islands(num_layers.saturating_sub(1) as u32);
    let mut islands = tracker.get_islands();

    // Calculate volume
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

    // Reassign placeholder pixels and filter small island pixels if stored
    if store_labels {
        use rayon::prelude::*;
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
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Connectivity;

    #[test]
    fn test_streaming_cube() {
        // Minimal valid job setup
        let job = IslandScanJob {
            px_mm: 0.05,
            support_buffer_mm: 0.1,
            connectivity: Connectivity::Four,
            min_island_area_mm2: 0.0001,
            layer_height_mm: 0.05,
            grid: GridRef {
                origin_x: 0.0,
                origin_z: 0.0,
                width: 5,
                height: 5,
                px_mm: 0.05,
            },
            num_layers: 3,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: false,
        };

        // No triangles means empty scan result
        let result = run_island_scan_streaming(&job, &[], 0.0, false, None);
        assert!(result.islands.is_empty());
    }
}
