//! IslandTracker — Aggregate Root managing cross-layer island ID propagation.
//!
//! Ported from `IslandScan/islandTracker.ts`.
//! Owns all `Island` entities; enforces merge invariants and parent-child topology.

use std::collections::{HashMap, HashSet};

use crate::model::*;
use crate::rle::rle_label_components;

/// Internal representation of a pending merge awaiting finalization.
struct PendingMerge {
    merge_layer: u32,
    candidate_ids: Vec<IslandId>,
    merged_island_id: IslandId,
    overlap_counts: HashMap<IslandId, u64>,
    pre_merge_labels: RleLabels,
}

/// Aggregate Root for island tracking across layers.
///
/// All island creation, update, and merge logic flows through this type.
/// External code only reads islands via `get_islands()`.
pub struct IslandTracker {
    islands: HashMap<IslandId, Island>,
    next_id: u32,
    px_mm: f64,
    min_overlap_px: i32,
    overlap_neighborhood_px: i32,
    pending_merges: Vec<PendingMerge>,
    merge_eval_window: u32,
}

impl IslandTracker {
    pub fn new(px_mm: f64, min_overlap_px: i32, overlap_neighborhood_px: i32) -> Self {
        Self {
            islands: HashMap::new(),
            next_id: 1,
            px_mm,
            min_overlap_px: min_overlap_px.max(1),
            overlap_neighborhood_px: overlap_neighborhood_px.max(0),
            pending_merges: Vec::new(),
            merge_eval_window: 30,
        }
    }

    /// Process a new layer and return island-labeled RLE for that layer.
    pub fn process_layer(
        &mut self,
        layer_index: u32,
        current_labels: &RleLabels,
        current_components: &[ComponentInfo],
        prev_island_labels: Option<&RleLabels>,
        solid_mask: &RleMask,
    ) -> RleLabels {
        let width = current_labels.width;
        let height = current_labels.height;

        match prev_island_labels {
            None => self.process_first_layer(layer_index, current_labels, current_components, width, height),
            Some(prev) => self.process_subsequent_layer(layer_index, current_labels, current_components, prev, solid_mask, width, height),
        }
    }

    fn process_first_layer(
        &mut self,
        layer_index: u32,
        current_labels: &RleLabels,
        current_components: &[ComponentInfo],
        width: i32,
        height: i32,
    ) -> RleLabels {
        let mut comp_to_island: HashMap<i32, IslandId> = HashMap::new();

        for comp in current_components {
            let area_mm2 = comp.area_px as f64 * self.px_mm * self.px_mm;
            let island_id = self.create_new_island(layer_index, area_mm2, Some(comp));
            comp_to_island.insert(comp.id, island_id);
        }

        self.map_labels_to_islands(current_labels, &comp_to_island, width, height)
    }

    fn process_subsequent_layer(
        &mut self,
        layer_index: u32,
        _current_labels: &RleLabels,
        _current_components: &[ComponentInfo],
        prev_island_labels: &RleLabels,
        solid_mask: &RleMask,
        width: i32,
        height: i32,
    ) -> RleLabels {
        // Label connected solid components
        let (solid_labels, solid_comps) =
            rle_label_components(solid_mask, Connectivity::Four);

        let mut solid_comp_to_island: HashMap<i32, IslandId> = HashMap::new();

        for component in &solid_comps {
            let prev_id_overlaps =
                self.find_overlapping_island_ids(component.id, &solid_labels, prev_island_labels);

            let mut prev_ids: HashSet<IslandId> = HashSet::new();
            for (&id, &count) in &prev_id_overlaps {
                if count >= self.min_overlap_px as u64 {
                    prev_ids.insert(id);
                }
            }

            // Filter for active islands
            let active_prev_ids: HashSet<IslandId> = prev_ids
                .iter()
                .copied()
                .filter(|id| {
                    self.islands
                        .get(id)
                        .map_or(false, |i| i.status == IslandStatus::Active)
                })
                .collect();

            let area_mm2 = component.area_px as f64 * self.px_mm * self.px_mm;

            let assigned_id = if active_prev_ids.is_empty() {
                if !prev_ids.is_empty() {
                    // Overlaps only non-active islands — resolve to parent chain
                    let first = *prev_ids.iter().next().unwrap();
                    let target = self.resolve_parent(first);
                    self.update_island(target, layer_index, area_mm2, Some(component));
                    target
                } else {
                    self.create_new_island(layer_index, area_mm2, Some(component))
                }
            } else if active_prev_ids.len() == 1 {
                let id = *active_prev_ids.iter().next().unwrap();
                self.update_island(id, layer_index, area_mm2, Some(component));
                id
            } else {
                // Merge: resolve all to ultimate parents
                let resolved: HashSet<IslandId> = active_prev_ids
                    .iter()
                    .map(|&id| self.resolve_parent(id))
                    .collect();
                self.merge_islands(layer_index, &resolved, prev_island_labels, area_mm2, Some(component))
            };

            solid_comp_to_island.insert(component.id, assigned_id);

            // Track overlaps for pending merges
            self.track_pending_merge_overlaps(component.id, &solid_labels, prev_island_labels);
        }

        // Check and finalize pending merges
        self.evaluate_pending_merges(layer_index);

        self.map_labels_to_islands(&solid_labels, &solid_comp_to_island, width, height)
    }

    // -----------------------------------------------------------------------
    // Island lifecycle
    // -----------------------------------------------------------------------

    fn create_new_island(
        &mut self,
        layer: u32,
        area_mm2: f64,
        comp: Option<&ComponentInfo>,
    ) -> IslandId {
        let id = IslandId(self.next_id);
        self.next_id += 1;
        let island = Island::new(id, layer, area_mm2, comp);
        self.islands.insert(id, island);
        id
    }

    fn update_island(
        &mut self,
        id: IslandId,
        layer: u32,
        area_mm2: f64,
        comp: Option<&ComponentInfo>,
    ) {
        if let Some(island) = self.islands.get_mut(&id) {
            island.update(layer, area_mm2, comp);
        }
    }

    fn merge_islands(
        &mut self,
        layer: u32,
        prev_ids: &HashSet<IslandId>,
        prev_island_labels: &RleLabels,
        area_mm2: f64,
        comp: Option<&ComponentInfo>,
    ) -> IslandId {
        // Deep copy pre-merge labels
        let pre_merge_labels = RleLabels {
            width: prev_island_labels.width,
            height: prev_island_labels.height,
            rows: prev_island_labels
                .rows
                .iter()
                .map(|row| row.clone())
                .collect(),
        };

        // Mark merging islands as complete
        for &id in prev_ids {
            if let Some(island) = self.islands.get_mut(&id) {
                island.status = IslandStatus::Complete;
                if layer > 0 {
                    island.last_layer = layer - 1;
                }
            }
        }

        // Create merged placeholder
        let merged_id = self.create_new_island(layer, area_mm2, comp);
        if let Some(island) = self.islands.get_mut(&merged_id) {
            island.is_merged_placeholder = true;
        }

        let mut overlap_counts = HashMap::new();
        for &id in prev_ids {
            overlap_counts.insert(id, 0);
        }

        self.pending_merges.push(PendingMerge {
            merge_layer: layer,
            candidate_ids: prev_ids.iter().copied().collect(),
            merged_island_id: merged_id,
            overlap_counts,
            pre_merge_labels,
        });

        merged_id
    }

    fn evaluate_pending_merges(&mut self, current_layer: u32) {
        let mut to_finalize = Vec::new();

        for (i, pending) in self.pending_merges.iter().enumerate() {
            if current_layer.saturating_sub(pending.merge_layer) >= self.merge_eval_window {
                to_finalize.push(i);
            }
        }

        // Process in reverse to preserve indices
        for &i in to_finalize.iter().rev() {
            let pending = self.pending_merges.remove(i);

            // Determine parent = candidate with highest overlap count
            let parent_id = pending
                .overlap_counts
                .iter()
                .max_by_key(|(_, &count)| count)
                .map(|(&id, _)| id)
                .unwrap_or(IslandId(0));

            // Set parent on non-parent candidates
            for &candidate_id in &pending.candidate_ids {
                if candidate_id != parent_id {
                    if let Some(child) = self.islands.get_mut(&candidate_id) {
                        child.parent_id = Some(parent_id);
                    }
                }
            }

            // Set parent on merged placeholder
            if let Some(merged) = self.islands.get_mut(&pending.merged_island_id) {
                merged.parent_id = Some(parent_id);
            }

            // Merge data into parent
            // We need to clone merged island data before borrowing parent mutably
            let merged_data = self.islands.get(&pending.merged_island_id).cloned();

            if let (Some(parent), Some(merged)) =
                (self.islands.get_mut(&parent_id), merged_data.as_ref())
            {
                for &candidate_id in &pending.candidate_ids {
                    if candidate_id != parent_id && !parent.child_ids.contains(&candidate_id) {
                        parent.child_ids.push(candidate_id);
                    }
                }
                if !parent.child_ids.contains(&pending.merged_island_id) {
                    parent.child_ids.push(pending.merged_island_id);
                }

                parent.last_layer = merged.last_layer;
                parent.status = merged.status;

                for (&layer, &area_mm2) in &merged.per_layer_area_mm2 {
                    parent.per_layer_area_mm2.insert(layer, area_mm2);
                    parent.total_area_mm2 += area_mm2;
                    if parent.max_area_mm2.map_or(true, |m| area_mm2 > m) {
                        parent.max_area_mm2 = Some(area_mm2);
                        parent.max_area_layer = Some(layer);
                    }
                }

                if merged.centroid_count > 0 {
                    parent.centroid_sum_x += merged.centroid_sum_x;
                    parent.centroid_sum_y += merged.centroid_sum_y;
                    parent.centroid_sum_z += merged.centroid_sum_z;
                    parent.centroid_count += merged.centroid_count;
                }

                if let Some(ref llc) = merged.last_layer_centroid {
                    parent.last_layer_centroid = Some(*llc);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Overlap detection
    // -----------------------------------------------------------------------

    fn find_overlapping_island_ids(
        &self,
        comp_id: i32,
        solid_labels: &RleLabels,
        prev_island_labels: &RleLabels,
    ) -> HashMap<IslandId, u64> {
        let mut counts: HashMap<IslandId, u64> = HashMap::new();
        let height = solid_labels.height;
        let neighborhood = self.overlap_neighborhood_px;

        for y in 0..height {
            let solid_row = &solid_labels.rows[y as usize];
            if solid_row.is_empty() {
                continue;
            }

            for run in solid_row {
                if run.id != comp_id {
                    continue;
                }

                let start = run.start;
                let end = start + run.length;
                let search_start = start - neighborhood;
                let search_end = end + neighborhood;

                let y_start = (y - neighborhood).max(0);
                let y_end = (y + neighborhood).min(height - 1);

                for py in y_start..=y_end {
                    let p_row = &prev_island_labels.rows[py as usize];
                    if p_row.is_empty() {
                        continue;
                    }

                    for p_run in p_row {
                        let p_start = p_run.start;
                        let p_end = p_start + p_run.length;
                        let p_id = p_run.id;

                        let overlap_start = search_start.max(p_start);
                        let overlap_end = search_end.min(p_end);

                        if overlap_start < overlap_end && p_id > 0 {
                            let overlap_px = (overlap_end - overlap_start) as u64;
                            *counts.entry(IslandId(p_id as u32)).or_insert(0) += overlap_px;
                        }

                        if p_start >= search_end {
                            break;
                        }
                    }
                }
            }
        }

        counts
    }

    fn track_pending_merge_overlaps(
        &mut self,
        comp_id: i32,
        solid_labels: &RleLabels,
        _prev_island_labels: &RleLabels,
    ) {
        if self.pending_merges.is_empty() {
            return;
        }

        // We need to iterate pending merges and find overlaps with pre-merge labels.
        // To avoid borrow conflicts, collect the overlap counts first.
        let updates: Vec<(usize, HashMap<IslandId, u64>)> = self
            .pending_merges
            .iter()
            .enumerate()
            .map(|(i, pending)| {
                let overlaps = self.find_overlapping_island_ids_static(
                    comp_id,
                    solid_labels,
                    &pending.pre_merge_labels,
                    self.overlap_neighborhood_px,
                );
                (i, overlaps)
            })
            .collect();

        for (i, overlaps) in updates {
            let pending = &mut self.pending_merges[i];
            for (id, count) in overlaps {
                if pending.overlap_counts.contains_key(&id) {
                    *pending.overlap_counts.entry(id).or_insert(0) += count;
                }
            }
        }
    }

    /// Static version of overlap detection that doesn't borrow self.
    fn find_overlapping_island_ids_static(
        &self,
        comp_id: i32,
        solid_labels: &RleLabels,
        prev_island_labels: &RleLabels,
        neighborhood: i32,
    ) -> HashMap<IslandId, u64> {
        let mut counts: HashMap<IslandId, u64> = HashMap::new();
        let height = solid_labels.height;

        for y in 0..height {
            let solid_row = &solid_labels.rows[y as usize];
            if solid_row.is_empty() {
                continue;
            }

            for run in solid_row {
                if run.id != comp_id {
                    continue;
                }

                let start = run.start;
                let end = start + run.length;
                let search_start = start - neighborhood;
                let search_end = end + neighborhood;

                let y_start = (y - neighborhood).max(0);
                let y_end = (y + neighborhood).min(height - 1);

                for py in y_start..=y_end {
                    let p_row = &prev_island_labels.rows[py as usize];
                    for p_run in p_row {
                        let p_start = p_run.start;
                        let p_end = p_start + p_run.length;
                        let p_id = p_run.id;

                        let overlap_start = search_start.max(p_start);
                        let overlap_end = search_end.min(p_end);

                        if overlap_start < overlap_end && p_id > 0 {
                            let overlap_px = (overlap_end - overlap_start) as u64;
                            *counts.entry(IslandId(p_id as u32)).or_insert(0) += overlap_px;
                        }

                        if p_start >= search_end {
                            break;
                        }
                    }
                }
            }
        }

        counts
    }

    // -----------------------------------------------------------------------
    // Parent resolution
    // -----------------------------------------------------------------------

    fn resolve_parent(&self, start_id: IslandId) -> IslandId {
        let mut current = start_id;
        let mut visited = HashSet::new();
        loop {
            if visited.contains(&current) {
                break;
            }
            visited.insert(current);
            match self.islands.get(&current).and_then(|i| i.parent_id) {
                Some(parent) => current = parent,
                None => break,
            }
        }
        current
    }

    // -----------------------------------------------------------------------
    // Label mapping
    // -----------------------------------------------------------------------

    fn map_labels_to_islands(
        &self,
        source_labels: &RleLabels,
        comp_to_island: &HashMap<i32, IslandId>,
        width: i32,
        height: i32,
    ) -> RleLabels {
        let mut rows = Vec::with_capacity(height as usize);
        for y in 0..height as usize {
            let row = &source_labels.rows[y];
            let mut new_row = Vec::new();
            for run in row {
                if let Some(&island_id) = comp_to_island.get(&run.id) {
                    if island_id.0 > 0 {
                        new_row.push(RleLabelRun {
                            start: run.start,
                            length: run.length,
                            id: island_id.0 as i32,
                        });
                    }
                }
            }
            rows.push(new_row);
        }
        RleLabels {
            rows,
            width,
            height,
        }
    }

    // -----------------------------------------------------------------------
    // Public accessors
    // -----------------------------------------------------------------------

    /// Compute final centroids and return all islands.
    pub fn get_islands(&mut self) -> Vec<Island> {
        for island in self.islands.values_mut() {
            island.compute_centroid();
        }
        self.islands.values().cloned().collect()
    }

    pub fn finalize_islands(&mut self, _final_layer: u32) {
        // No-op (matches TS)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::model::*;
    use crate::rle::*;
    use crate::tracker::*;
    use crate::rle::rle_encode;
    use crate::scan::scan_layer;

    fn make_tracker() -> IslandTracker {
        IslandTracker::new(0.05, 1, 1)
    }

    #[test]
    fn single_island_tracked_across_layers() {
        let mut tracker = make_tracker();
        let w = 5;
        let h = 3;

        // Layer 0
        #[rustfmt::skip]
        let mask0 = rle_encode(&[
            0,1,1,0,0,
            0,1,1,0,0,
            0,0,0,0,0,
        ], w, h);
        let r0 = scan_layer(&mask0, None, 0.05, 0.1, Connectivity::Four);
        let il0 = tracker.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask);

        // Layer 1 (same shape)
        let r1 = scan_layer(&mask0, Some(&mask0), 0.05, 0.1, Connectivity::Four);
        let _il1 = tracker.process_layer(1, &r1.labels, &r1.components, Some(&il0), &r1.solid_mask);

        let islands = tracker.get_islands();
        // Everything supported after layer 0, so no new island candidates on layer 1.
        // But the tracker tracks solid components, so the original island continues.
        assert!(!islands.is_empty());
        let main = islands.iter().find(|i| i.first_layer == 0).unwrap();
        assert_eq!(main.status, IslandStatus::Active);
        assert_eq!(main.last_layer, 1);
    }

    #[test]
    fn two_separate_islands() {
        let mut tracker = make_tracker();
        let w = 10;
        let h = 1;

        // Two separated blobs
        #[rustfmt::skip]
        let data: Vec<u8> = vec![1,1,0,0,0,0,0,0,1,1];
        let mask = rle_encode(&data, w, h);
        let r = scan_layer(&mask, None, 0.05, 0.1, Connectivity::Four);
        let _il = tracker.process_layer(0, &r.labels, &r.components, None, &r.solid_mask);

        let islands = tracker.get_islands();
        assert_eq!(islands.len(), 2);
    }
}
