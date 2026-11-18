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
    cantilever_neighborhood_px: i32,
    connectivity: Connectivity,
    pending_merges: Vec<PendingMerge>,
    merge_eval_window: u32,
    grounded_islands: HashSet<IslandId>,
}

impl IslandTracker {
    pub fn new(px_mm: f64, min_overlap_px: i32, overlap_neighborhood_px: i32) -> Self {
        Self::with_connectivity(
            px_mm,
            min_overlap_px,
            overlap_neighborhood_px,
            Connectivity::Eight,
        )
    }

    pub fn with_connectivity(
        px_mm: f64,
        min_overlap_px: i32,
        overlap_neighborhood_px: i32,
        connectivity: Connectivity,
    ) -> Self {
        Self::with_candidate_reach(
            px_mm,
            min_overlap_px,
            overlap_neighborhood_px,
            overlap_neighborhood_px,
            connectivity,
        )
    }

    pub fn with_candidate_reach(
        px_mm: f64,
        min_overlap_px: i32,
        overlap_neighborhood_px: i32,
        cantilever_neighborhood_px: i32,
        connectivity: Connectivity,
    ) -> Self {
        Self {
            islands: HashMap::new(),
            next_id: 1,
            px_mm,
            min_overlap_px: min_overlap_px.max(1),
            overlap_neighborhood_px: overlap_neighborhood_px.max(0),
            cantilever_neighborhood_px: cantilever_neighborhood_px.max(0),
            connectivity,
            pending_merges: Vec::new(),
            merge_eval_window: 30,
            grounded_islands: HashSet::new(),
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
        candidate_only: bool,
    ) -> RleLabels {
        let width = current_labels.width;
        let height = current_labels.height;

        if candidate_only {
            match prev_island_labels {
                None => self.process_first_layer(layer_index, current_labels, current_components, width, height),
                Some(prev) => self.process_subsequent_layer_candidates(layer_index, current_labels, current_components, prev, width, height),
            }
        } else {
            match prev_island_labels {
                None => self.process_first_layer(layer_index, current_labels, current_components, width, height),
                Some(prev) => self.process_subsequent_layer(layer_index, current_labels, current_components, prev, solid_mask, width, height),
            }
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
            if layer_index == 0 {
                self.grounded_islands.insert(island_id);
            }
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
        // 1. Label connected solid components & snapshot Active islands at layer entry
        let (solid_labels, solid_comps) =
            rle_label_components(solid_mask, self.connectivity);

        let mut active_at_layer_start: HashSet<IslandId> = self
            .islands
            .iter()
            .filter(|(_, island)| island.status == IslandStatus::Active)
            .map(|(&id, _)| id)
            .collect();

        // 2. Collect initial prev_ids & active_prev_ids without mutating island state
        struct SolidCompInput {
            comp_idx: usize,
            area_mm2: f64,
            prev_ids: HashSet<IslandId>,
            active_prev_ids: HashSet<IslandId>,
        }

        let mut comp_inputs: Vec<SolidCompInput> = Vec::with_capacity(solid_comps.len());
        for (comp_idx, component) in solid_comps.iter().enumerate() {
            let prev_id_overlaps = Self::count_overlapping_labels(
                component.id,
                &solid_labels,
                prev_island_labels,
                self.overlap_neighborhood_px,
            );

            let mut prev_ids: HashSet<IslandId> = HashSet::new();
            for (&id, &count) in &prev_id_overlaps {
                if count >= self.min_overlap_px as u64 {
                    prev_ids.insert(id);
                }
            }

            // Filter for active islands (resolving finalized placeholders / indirect chains)
            let active_prev_ids: HashSet<IslandId> = prev_ids
                .iter()
                .copied()
                .filter(|id| active_at_layer_start.contains(&self.resolve_parent(*id)))
                .collect();

            let area_mm2 = component.area_px as f64 * self.px_mm * self.px_mm;
            comp_inputs.push(SolidCompInput {
                comp_idx,
                area_mm2,
                prev_ids,
                active_prev_ids,
            });
        }

        let mut solid_comp_to_island: HashMap<i32, IslandId> = HashMap::new();
        let mut updated_this_layer: HashSet<IslandId> = HashSet::new();

        // 3. Fixpoint pre-flush: finalize any open PendingMerge whose placeholder participates
        // directly or indirectly in a genuine multi-target merge (resolved.len() >= 2).
        loop {
            let mut to_flush: HashSet<IslandId> = HashSet::new();
            for input in &comp_inputs {
                if input.active_prev_ids.len() >= 2 {
                    let resolved: HashSet<IslandId> = input
                        .active_prev_ids
                        .iter()
                        .map(|&id| self.resolve_parent(id))
                        .collect();
                    if resolved.len() >= 2 {
                        for pending in &self.pending_merges {
                            if resolved.contains(&pending.merged_island_id) {
                                to_flush.insert(pending.merged_island_id);
                            }
                        }
                    }
                }
            }
            if to_flush.is_empty() {
                break;
            }
            let mut i = 0;
            while i < self.pending_merges.len() {
                if to_flush.contains(&self.pending_merges[i].merged_island_id) {
                    let p = self.pending_merges.remove(i);
                    let merged_id = p.merged_island_id;
                    let parent_id = self.finalize_pending_merge(p);
                    if active_at_layer_start.contains(&merged_id) {
                        active_at_layer_start.insert(parent_id);
                    }
                    if updated_this_layer.contains(&merged_id) {
                        updated_this_layer.insert(parent_id);
                    }
                } else {
                    i += 1;
                }
            }
        }

        // 4. Pass 1: create new islands immediately; classify continuations vs merges
        let mut continuations: Vec<(usize, IslandId, f64)> = Vec::new();
        let mut merges: Vec<(usize, HashSet<IslandId>, f64)> = Vec::new();

        for input in &comp_inputs {
            let component = &solid_comps[input.comp_idx];
            if input.active_prev_ids.is_empty() {
                if input.prev_ids.is_empty() {
                    let new_id =
                        self.create_new_island(layer_index, input.area_mm2, Some(component));
                    updated_this_layer.insert(new_id);
                    solid_comp_to_island.insert(component.id, new_id);
                } else {
                    // Overlaps only non-active islands — resolve to parent chain.
                    // Pick the smallest id for determinism (HashSet order is not).
                    let first = *input.prev_ids.iter().min_by_key(|id| id.0).unwrap();
                    let target = self.resolve_parent(first);
                    continuations.push((input.comp_idx, target, input.area_mm2));
                }
            } else {
                let resolved: HashSet<IslandId> = input
                    .active_prev_ids
                    .iter()
                    .map(|&id| self.resolve_parent(id))
                    .collect();
                if resolved.len() == 1 {
                    let target = *resolved.iter().next().unwrap();
                    continuations.push((input.comp_idx, target, input.area_mm2));
                } else {
                    merges.push((input.comp_idx, resolved, input.area_mm2));
                }
            }
        }

        // 5. Pass 2a: execute ALL continuations first
        for (comp_idx, target, area_mm2) in continuations {
            let component = &solid_comps[comp_idx];
            self.update_island(target, layer_index, area_mm2, Some(component));
            updated_this_layer.insert(target);
            solid_comp_to_island.insert(component.id, target);
        }

        // 6. Pass 2b: execute merges (preserving islands updated on this layer)
        for (comp_idx, orig_resolved, area_mm2) in merges {
            let component = &solid_comps[comp_idx];
            let mut resolved: HashSet<IslandId> = orig_resolved
                .iter()
                .map(|&id| self.resolve_parent(id))
                .collect();

            if resolved.len() >= 2 {
                loop {
                    let mut to_flush: HashSet<IslandId> = HashSet::new();
                    for pending in &self.pending_merges {
                        if resolved.contains(&pending.merged_island_id) {
                            to_flush.insert(pending.merged_island_id);
                        }
                    }
                    if to_flush.is_empty() {
                        break;
                    }
                    let mut i = 0;
                    while i < self.pending_merges.len() {
                        if to_flush.contains(&self.pending_merges[i].merged_island_id) {
                            let mut p = self.pending_merges.remove(i);
                            for comp in &solid_comps {
                                let overlaps = Self::count_overlapping_labels(
                                    comp.id,
                                    &solid_labels,
                                    &p.pre_merge_labels,
                                    self.overlap_neighborhood_px,
                                );
                                for (id, count) in overlaps {
                                    if p.overlap_counts.contains_key(&id) {
                                        *p.overlap_counts.entry(id).or_insert(0) += count;
                                    }
                                }
                            }
                            let merged_id = p.merged_island_id;
                            let parent_id = self.finalize_pending_merge(p);
                            if updated_this_layer.contains(&merged_id) {
                                updated_this_layer.insert(parent_id);
                            }
                            for mapped in solid_comp_to_island.values_mut() {
                                if *mapped == merged_id {
                                    *mapped = parent_id;
                                }
                            }
                        } else {
                            i += 1;
                        }
                    }
                    resolved = resolved
                        .iter()
                        .map(|&id| self.resolve_parent(id))
                        .collect();
                    if resolved.len() < 2 {
                        break;
                    }
                }
            }

            let assigned_id = if resolved.len() == 1 {
                let target = *resolved.iter().next().unwrap();
                self.update_island(target, layer_index, area_mm2, Some(component));
                updated_this_layer.insert(target);
                target
            } else {
                let mut sorted_resolved: Vec<IslandId> = resolved.iter().copied().collect();
                sorted_resolved.sort_by_key(|id| id.0);
                let mut grounded: Vec<IslandId> = Vec::new();
                let mut ungrounded: Vec<IslandId> = Vec::new();
                for id in sorted_resolved {
                    if self.grounded_islands.contains(&id) {
                        grounded.push(id);
                    } else {
                        ungrounded.push(id);
                    }
                }

                if grounded.len() == 1 {
                    let gp = grounded[0];
                    for uid in &ungrounded {
                        if let Some(u) = self.islands.get_mut(uid) {
                            u.parent_id = Some(gp);
                            if !updated_this_layer.contains(uid)
                                && !u.per_layer_area_mm2.contains_key(&layer_index)
                            {
                                u.status = IslandStatus::Complete;
                                if layer_index > 0 {
                                    u.last_layer = layer_index - 1;
                                }
                            }
                        }
                        if let Some(g) = self.islands.get_mut(&gp) {
                            if !g.child_ids.contains(uid) {
                                g.child_ids.push(*uid);
                            }
                        }
                    }
                    self.update_island(gp, layer_index, area_mm2, Some(component));
                    updated_this_layer.insert(gp);
                    gp
                } else if grounded.len() >= 2 {
                    let grounded_set: HashSet<IslandId> = grounded.iter().copied().collect();
                    let merged_id = self.merge_islands(
                        layer_index,
                        &grounded_set,
                        prev_island_labels,
                        area_mm2,
                        Some(component),
                        &updated_this_layer,
                    );
                    self.grounded_islands.insert(merged_id);
                    updated_this_layer.insert(merged_id);
                    for uid in &ungrounded {
                        if let Some(u) = self.islands.get_mut(uid) {
                            u.parent_id = Some(merged_id);
                            if !updated_this_layer.contains(uid)
                                && !u.per_layer_area_mm2.contains_key(&layer_index)
                            {
                                u.status = IslandStatus::Complete;
                                if layer_index > 0 {
                                    u.last_layer = layer_index - 1;
                                }
                            }
                        }
                        if let Some(m) = self.islands.get_mut(&merged_id) {
                            if !m.child_ids.contains(uid) {
                                m.child_ids.push(*uid);
                            }
                        }
                    }
                    merged_id
                } else {
                    let merged_id = self.merge_islands(
                        layer_index,
                        &resolved,
                        prev_island_labels,
                        area_mm2,
                        Some(component),
                        &updated_this_layer,
                    );
                    updated_this_layer.insert(merged_id);
                    merged_id
                }
            };

            solid_comp_to_island.insert(component.id, assigned_id);
        }

        // Track overlaps for pending merges after all component assignments
        for component in &solid_comps {
            self.track_pending_merge_overlaps(component.id, &solid_labels, prev_island_labels);
        }

        // Check and finalize pending merges
        self.evaluate_pending_merges(layer_index);

        self.map_labels_to_islands(&solid_labels, &solid_comp_to_island, width, height)
    }

    fn process_subsequent_layer_candidates(
        &mut self,
        layer_index: u32,
        current_labels: &RleLabels,
        current_components: &[ComponentInfo],
        prev_island_labels: &RleLabels,
        width: i32,
        height: i32,
    ) -> RleLabels {
        // Snapshot Active status at the start of the layer so same-layer saddle merges
        // cannot prematurely mark a split sibling Complete before its continuing branch runs.
        let active_at_layer_start: HashSet<IslandId> = self
            .islands
            .iter()
            .filter(|(_, island)| island.status == IslandStatus::Active)
            .map(|(&id, _)| id)
            .collect();

        let mut comp_to_island: HashMap<i32, IslandId> = HashMap::new();
        let mut continuations: Vec<(IslandId, f64, &ComponentInfo)> = Vec::new();
        let mut merges: Vec<(IslandId, HashSet<IslandId>, f64, &ComponentInfo)> = Vec::new();

        for component in current_components {
            let area_mm2 = component.area_px as f64 * self.px_mm * self.px_mm;

            if component.is_detached {
                let assigned_id = self.create_new_island(layer_index, area_mm2, Some(component));
                comp_to_island.insert(component.id, assigned_id);
                continue;
            }

            let prev_id_overlaps = Self::count_overlapping_labels(
                component.id,
                current_labels,
                prev_island_labels,
                self.cantilever_neighborhood_px,
            );

            let mut prev_ids: HashSet<IslandId> = HashSet::new();
            for (&id, &count) in &prev_id_overlaps {
                if count >= self.min_overlap_px as u64 {
                    prev_ids.insert(id);
                }
            }

            // Filter for active islands using start-of-layer snapshot
            let active_prev_ids: HashSet<IslandId> = prev_ids
                .iter()
                .copied()
                .filter(|id| active_at_layer_start.contains(id))
                .collect();

            if active_prev_ids.is_empty() {
                if !prev_ids.is_empty() {
                    // Overlaps only non-active islands — resolve to parent chain.
                    // Pick the smallest id for determinism (HashSet order is not).
                    let first = *prev_ids.iter().min_by_key(|id| id.0).unwrap();
                    let target = self.resolve_parent(first);
                    comp_to_island.insert(component.id, target);
                    continuations.push((target, area_mm2, component));
                } else {
                    let assigned_id =
                        self.create_new_island(layer_index, area_mm2, Some(component));
                    comp_to_island.insert(component.id, assigned_id);
                }
            } else if active_prev_ids.len() == 1 {
                let target = *active_prev_ids.iter().next().unwrap();
                comp_to_island.insert(component.id, target);
                continuations.push((target, area_mm2, component));
            } else {
                // Direct saddle completion in candidate mode (no PendingMerge placeholders):
                // resolve parents and pick deterministic surviving ancestor min by
                // (first_layer, id.0). Final sibling completion is deferred until after all
                // continuations and merges on this layer have been recorded.
                let resolved: HashSet<IslandId> = active_prev_ids
                    .iter()
                    .map(|&id| self.resolve_parent(id))
                    .collect();
                let ancestor = *resolved
                    .iter()
                    .min_by_key(|id| {
                        let first_layer = self.islands.get(id).map_or(u32::MAX, |i| i.first_layer);
                        (first_layer, id.0)
                    })
                    .unwrap();

                comp_to_island.insert(component.id, ancestor);
                merges.push((ancestor, resolved, area_mm2, component));
            }
        }

        let mut updated_this_layer: HashSet<IslandId> = HashSet::new();
        let mut absorbed_this_layer: HashSet<IslandId> = HashSet::new();

        for (target, area_mm2, component) in continuations {
            self.update_island(target, layer_index, area_mm2, Some(component));
            updated_this_layer.insert(target);
        }

        for (ancestor, resolved, area_mm2, component) in merges {
            if resolved.len() > 1 {
                if let Some(island) = self.islands.get_mut(&ancestor) {
                    island.has_saddle_merged = true;
                }
                for &id in &resolved {
                    if id != ancestor {
                        absorbed_this_layer.insert(id);
                    }
                }
            }
            self.update_island(ancestor, layer_index, area_mm2, Some(component));
            updated_this_layer.insert(ancestor);
        }

        for id in absorbed_this_layer {
            if !updated_this_layer.contains(&id) {
                if let Some(island) = self.islands.get_mut(&id) {
                    island.has_saddle_merged = true;
                    island.status = IslandStatus::Complete;
                    island.parent_id = None;
                    if layer_index > 0 {
                        island.last_layer = layer_index - 1;
                    }
                }
            }
        }

        self.map_labels_to_islands(current_labels, &comp_to_island, width, height)
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
        updated_this_layer: &HashSet<IslandId>,
    ) -> IslandId {
        // Deep copy pre-merge labels, remapping any finalized/parented IDs to current roots
        let pre_merge_labels = RleLabels {
            width: prev_island_labels.width,
            height: prev_island_labels.height,
            rows: prev_island_labels
                .rows
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|run| {
                            if run.id > 0 {
                                let resolved = self.resolve_parent(IslandId(run.id as u32));
                                RleLabelRun {
                                    start: run.start,
                                    length: run.length,
                                    id: resolved.0 as i32,
                                }
                            } else {
                                run.clone()
                            }
                        })
                        .collect()
                })
                .collect(),
        };

        // Mark merging islands as complete (unless already updated on this layer)
        for &id in prev_ids {
            if updated_this_layer.contains(&id) {
                continue;
            }
            if let Some(island) = self.islands.get_mut(&id) {
                if island.per_layer_area_mm2.contains_key(&layer) {
                    continue;
                }
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
            // Sort for deterministic iteration (child_ids order, parent selection).
            candidate_ids: {
                let mut ids: Vec<IslandId> = prev_ids.iter().copied().collect();
                ids.sort_by_key(|id| id.0);
                ids
            },
            merged_island_id: merged_id,
            overlap_counts,
            pre_merge_labels,
        });

        merged_id
    }

    fn finalize_pending_merge(&mut self, pending: PendingMerge) -> IslandId {
        // Determine parent = non-placeholder candidate with highest overlap count.
        // Ties break deterministically by smallest id.0.
        let mut resolved_counts: HashMap<IslandId, u64> = HashMap::new();
        for (&raw_id, &count) in &pending.overlap_counts {
            let resolved = self.resolve_parent(raw_id);
            let is_placeholder = self
                .islands
                .get(&resolved)
                .map_or(true, |i| i.is_merged_placeholder);
            if !is_placeholder {
                *resolved_counts.entry(resolved).or_insert(0) += count;
            }
        }

        let has_grounded = resolved_counts
            .keys()
            .any(|id| self.grounded_islands.contains(id));

        let parent_id = resolved_counts
            .iter()
            .filter(|(id, _)| !has_grounded || self.grounded_islands.contains(id))
            .max_by(|(id_a, count_a), (id_b, count_b)| {
                count_a
                    .cmp(count_b)
                    .then_with(|| id_b.0.cmp(&id_a.0))
            })
            .map(|(&id, _)| id)
            .unwrap_or_else(|| {
                pending
                    .candidate_ids
                    .iter()
                    .map(|&cid| self.resolve_parent(cid))
                    .find(|id| {
                        self.islands
                            .get(id)
                            .map_or(false, |i| !i.is_merged_placeholder)
                    })
                    .unwrap_or(IslandId(0))
            });

        // Set parent on non-parent candidates
        for &candidate_id in &pending.candidate_ids {
            if candidate_id != parent_id {
                if let Some(child) = self.islands.get_mut(&candidate_id) {
                    child.parent_id = Some(parent_id);
                }
            }
        }

        // Reparent any existing islands whose parent was the merged placeholder
        for island in self.islands.values_mut() {
            if island.parent_id == Some(pending.merged_island_id) && island.id != parent_id {
                island.parent_id = Some(parent_id);
            }
        }

        // Read merged active state BEFORE completing the placeholder
        let merged_was_active = if let Some(merged) = self.islands.get_mut(&pending.merged_island_id) {
            let was_active = merged.status == IslandStatus::Active;
            merged.parent_id = Some(parent_id);
            merged.status = IslandStatus::Complete;
            was_active
        } else {
            false
        };

        // Merge data into parent
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
            for &child_id in &merged.child_ids {
                if child_id != parent_id && !parent.child_ids.contains(&child_id) {
                    parent.child_ids.push(child_id);
                }
            }

            let prev_parent_last_layer = parent.last_layer;
            parent.last_layer = parent.last_layer.max(merged.last_layer);
            parent.status = if merged_was_active || parent.status == IslandStatus::Active {
                IslandStatus::Active
            } else {
                IslandStatus::Complete
            };

            for (&layer, &area_mm2) in &merged.per_layer_area_mm2 {
                parent.last_layer = parent.last_layer.max(layer);
                let entry = parent.per_layer_area_mm2.entry(layer).or_insert(0.0);
                *entry += area_mm2;
                let layer_area = *entry;
                parent.total_area_mm2 += area_mm2;
                if parent.max_area_mm2.map_or(true, |m| layer_area > m) {
                    parent.max_area_mm2 = Some(layer_area);
                    parent.max_area_layer = Some(layer);
                }
            }

            if merged.centroid_count > 0 {
                parent.centroid_sum_x += merged.centroid_sum_x;
                parent.centroid_sum_y += merged.centroid_sum_y;
                parent.centroid_sum_z += merged.centroid_sum_z;
                parent.centroid_count += merged.centroid_count;
            }

            if merged.last_layer >= prev_parent_last_layer {
                if let Some(ref llc) = merged.last_layer_centroid {
                    parent.last_layer_centroid = Some(*llc);
                }
            }
        }

        if self.grounded_islands.contains(&pending.merged_island_id)
            || pending
                .candidate_ids
                .iter()
                .any(|cid| self.grounded_islands.contains(cid))
        {
            self.grounded_islands.insert(parent_id);
        }

        parent_id
    }

    fn evaluate_pending_merges(&mut self, current_layer: u32) {
        let mut i = 0;
        while i < self.pending_merges.len() {
            if current_layer.saturating_sub(self.pending_merges[i].merge_layer)
                >= self.merge_eval_window
            {
                let pending = self.pending_merges.remove(i);
                self.finalize_pending_merge(pending);
            } else {
                i += 1;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Overlap detection
    // -----------------------------------------------------------------------

    /// Count overlapping previous-layer island pixels within a Euclidean L2
    /// disk of radius `neighborhood` around every run belonging to `comp_id`.
    fn count_overlapping_labels(
        comp_id: i32,
        solid_labels: &RleLabels,
        prev_island_labels: &RleLabels,
        neighborhood: i32,
    ) -> HashMap<IslandId, u64> {
        let mut counts: HashMap<IslandId, u64> = HashMap::new();
        if neighborhood < 0 || solid_labels.height <= 0 || prev_island_labels.height <= 0 {
            return counts;
        }

        let r = neighborhood.max(0);
        let rr = r as i64;
        let height = solid_labels.height.min(solid_labels.rows.len() as i32);
        let prev_height = prev_island_labels.height.min(prev_island_labels.rows.len() as i32);

        for y in 0..height {
            let solid_row = &solid_labels.rows[y as usize];
            if solid_row.is_empty() {
                continue;
            }

            let y_start = y.saturating_sub(r).max(0);
            let y_end = y.saturating_add(r).min(prev_height - 1);

            for run in solid_row {
                if run.id != comp_id {
                    continue;
                }

                let start = run.start;
                let end = start + run.length;

                for py in y_start..=y_end {
                    let p_row = &prev_island_labels.rows[py as usize];
                    if p_row.is_empty() {
                        continue;
                    }

                    let dy = (py - y) as i64;
                    let dx = ((rr * rr - dy * dy) as f64).sqrt().floor() as i32;
                    let search_start = start.saturating_sub(dx);
                    let search_end = end.saturating_add(dx);

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
        let neighborhood = self.overlap_neighborhood_px;
        let updates: Vec<(usize, HashMap<IslandId, u64>)> = self
            .pending_merges
            .iter()
            .enumerate()
            .map(|(i, pending)| {
                let overlaps = Self::count_overlapping_labels(
                    comp_id,
                    solid_labels,
                    &pending.pre_merge_labels,
                    neighborhood,
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
        let pending = std::mem::take(&mut self.pending_merges);
        for p in pending {
            self.finalize_pending_merge(p);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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
        let il0 = tracker.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask, false);

        // Layer 1 (same shape)
        let r1 = scan_layer(&mask0, Some(&mask0), 0.05, 0.1, Connectivity::Four);
        let _il1 = tracker.process_layer(1, &r1.labels, &r1.components, Some(&il0), &r1.solid_mask, false);

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
        let _il = tracker.process_layer(0, &r.labels, &r.components, None, &r.solid_mask, false);

        let islands = tracker.get_islands();
        assert_eq!(islands.len(), 2);
    }

    #[test]
    fn test_candidate_only_tracking() {
        let w = 10;
        let h = 1;

        // 1. Run with candidate_only = false (Solid bulk propagation)
        {
            let mut tracker = IslandTracker::new(0.05, 1, 0);
            // Layer 0: middle base [0,0,0,1,1,1,1,0,0,0]
            let base = rle_encode(&vec![0,0,0,1,1,1,1,0,0,0], w, h);
            // Layer 1: wider overhangs on both sides [0,1,1,1,1,1,1,1,1,0]
            let wide = rle_encode(&vec![0,1,1,1,1,1,1,1,1,0], w, h);

            let r0 = scan_layer(&base, None, 0.05, 0.0, Connectivity::Four);
            let il0 = tracker.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask, false);

            let r1 = scan_layer(&wide, Some(&base), 0.05, 0.0, Connectivity::Four);
            let _il1 = tracker.process_layer(1, &r1.labels, &r1.components, Some(&il0), &r1.solid_mask, false);

            let islands = tracker.get_islands();
            // The overhangs merge with the solid base component, so only 1 island is created
            assert_eq!(islands.len(), 1);
        }

        // 2. Run with candidate_only = true (Candidate connected components)
        {
            let mut tracker = IslandTracker::new(0.05, 1, 0);
            // Layer 0: middle base [0,0,0,1,1,1,1,0,0,0]
            let base = rle_encode(&vec![0,0,0,1,1,1,1,0,0,0], w, h);
            // Layer 1: wider overhangs on both sides [0,1,1,1,1,1,1,1,1,0]
            let wide = rle_encode(&vec![0,1,1,1,1,1,1,1,1,0], w, h);

            let r0 = scan_layer(&base, None, 0.05, 0.0, Connectivity::Four);
            let il0 = tracker.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask, true);

            let r1 = scan_layer(&wide, Some(&base), 0.05, 0.0, Connectivity::Four);
            let _il1 = tracker.process_layer(1, &r1.labels, &r1.components, Some(&il0), &r1.solid_mask, true);

            let islands = tracker.get_islands();
            // The base is 1 island. The two side overhangs do not overlap with candidates below, starting 2 new islands.
            // Total = 3 islands.
            assert_eq!(islands.len(), 3);
        }
    }

    #[test]
    fn nbr02_tracker_euclidean_disk_overlap_search() {
        let w = 12;
        let h = 12;
        let mut tracker = IslandTracker::new(1.0, 1, 5);

        // Layer 0: single pixel at (5, 5)
        let mut d0 = vec![0u8; (w * h) as usize];
        d0[(5 * w + 5) as usize] = 1;
        let m0 = rle_encode(&d0, w, h);
        let r0 = scan_layer(&m0, None, 1.0, 0.0, Connectivity::Eight);
        let il0 = tracker.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask, true);

        // Layer 1: (8, 9) at offset (+3, +4) [d^2=25 <= 25] and (1, 1) at offset (-4, -4) [d^2=32 > 25]
        let mut d1 = vec![0u8; (w * h) as usize];
        d1[(9 * w + 8) as usize] = 1;
        d1[(1 * w + 1) as usize] = 1;
        let m1 = rle_encode(&d1, w, h);
        let mut r1 = scan_layer(&m1, Some(&m0), 1.0, 0.0, Connectivity::Eight);
        // Exercise CantileverFringe L2 overlap reach directly on synthetic non-detached components
        for c in &mut r1.components {
            c.is_detached = false;
        }
        let _il1 =
            tracker.process_layer(1, &r1.labels, &r1.components, Some(&il0), &r1.solid_mask, true);

        let islands = tracker.get_islands();
        assert_eq!(islands.len(), 2);
        let base = islands.iter().find(|i| i.first_layer == 0).unwrap();
        let outside = islands.iter().find(|i| i.first_layer == 1).unwrap();
        assert_eq!(base.last_layer, 1);
        assert_eq!(outside.last_layer, 1);
        let seed = outside.seed_voxel.expect("outside seed voxel present");
        assert!((seed.x - 1.0).abs() < 1e-6 && (seed.y - 1.0).abs() < 1e-6);

        // dy/dx asymmetry check: (dy=0, dx=5) overlaps r=5 while (dy=1, dx=5) [d^2=26>25] does NOT
        let mut tracker_asym = IslandTracker::new(1.0, 1, 5);
        let asym_l0 = tracker_asym.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask, true);
        let mut d_asym = vec![0u8; (w * h) as usize];
        d_asym[(5 * w + 10) as usize] = 1; // (10,5): dx=+5, dy=0 -> 25 <= 25 (continues)
        d_asym[(6 * w + 0) as usize] = 1;  // (0,6): dx=-5, dy=+1 -> 26 > 25 (new island)
        let m_asym = rle_encode(&d_asym, w, h);
        let mut r_asym = scan_layer(&m_asym, Some(&m0), 1.0, 0.0, Connectivity::Eight);
        for c in &mut r_asym.components {
            c.is_detached = false;
        }
        let _il_asym = tracker_asym.process_layer(
            1,
            &r_asym.labels,
            &r_asym.components,
            Some(&asym_l0),
            &r_asym.solid_mask,
            true,
        );
        let asym_islands = tracker_asym.get_islands();
        assert_eq!(asym_islands.len(), 2, "(0,5) hits while (-5,+1) misses Euclidean r=5");
        let asym_outside = asym_islands.iter().find(|i| i.first_layer == 1).unwrap();
        let asym_seed = asym_outside.seed_voxel.unwrap();
        assert!((asym_seed.x - 0.0).abs() < 1e-6 && (asym_seed.y - 6.0).abs() < 1e-6);

        // Mismatched prev_island_labels.height < solid_labels.height never panics
        let small_prev_mask = rle_encode(&vec![1u8; 4 * 2], 4, 2);
        let r_small = scan_layer(&small_prev_mask, None, 1.0, 0.0, Connectivity::Eight);
        let mut t_mismatch = IslandTracker::new(1.0, 1, 2);
        let il_small = t_mismatch.process_layer(
            0,
            &r_small.labels,
            &r_small.components,
            None,
            &r_small.solid_mask,
            true,
        );
        let tall_mask = rle_encode(&vec![1u8; 4 * 6], 4, 6);
        let mut r_tall = scan_layer(&tall_mask, Some(&rle_encode(&vec![0u8; 4 * 6], 4, 6)), 1.0, 0.0, Connectivity::Eight);
        for c in &mut r_tall.components {
            c.is_detached = false;
        }
        let _ = t_mismatch.process_layer(
            1,
            &r_tall.labels,
            &r_tall.components,
            Some(&il_small),
            &r_tall.solid_mask,
            true,
        );
        assert_eq!(t_mismatch.get_islands().len(), 1);
    }

    #[test]
    fn nbr03_tracker_default_new_uses_eight_connectivity_in_solid_mode() {
        let w = 20;
        let h = 4;
        let mut tracker = IslandTracker::new(0.05, 1, 0);

        // Layer 0: [0, 10) at row 1
        let mut d0 = vec![0u8; (w * h) as usize];
        for x in 0..10 {
            d0[w as usize + x] = 1;
        }
        let m0 = rle_encode(&d0, w, h);
        let r0 = scan_layer(&m0, None, 0.05, 0.0, Connectivity::Eight);
        let il0 = tracker.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask, false);

        // Layer 1: [0, 10) at row 1 AND [10, 20) at row 2 (diagonal corner at (9,1)-(10,2))
        let mut d1 = d0;
        for x in 10..20 {
            d1[2 * w as usize + x] = 1;
        }
        let m1 = rle_encode(&d1, w, h);
        let r1 = scan_layer(&m1, Some(&m0), 0.05, 0.0, Connectivity::Eight);
        let _il1 =
            tracker.process_layer(1, &r1.labels, &r1.components, Some(&il0), &r1.solid_mask, false);

        let islands = tracker.get_islands();
        assert_eq!(islands.len(), 1);
        assert_eq!(islands[0].first_layer, 0);
        assert_eq!(islands[0].last_layer, 1);
    }

    #[test]
    fn nbr03_solid_mode_with_connectivity_respects_four_and_eight() {
        let w = 20;
        let h = 4;

        let mut d0 = vec![0u8; (w * h) as usize];
        for x in 0..10 {
            d0[w as usize + x] = 1;
        }
        let m0 = rle_encode(&d0, w, h);

        let mut d1 = d0;
        for x in 10..20 {
            d1[2 * w as usize + x] = 1;
        }
        let m1 = rle_encode(&d1, w, h);

        for (conn, expected_islands) in [(Connectivity::Four, 2), (Connectivity::Eight, 1)] {
            let mut tracker = IslandTracker::with_connectivity(0.05, 1, 0, conn);
            let r0 = scan_layer(&m0, None, 0.05, 0.0, conn);
            let il0 =
                tracker.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask, false);
            let r1 = scan_layer(&m1, Some(&m0), 0.05, 0.0, conn);
            let _il1 = tracker.process_layer(
                1,
                &r1.labels,
                &r1.components,
                Some(&il0),
                &r1.solid_mask,
                false,
            );
            assert_eq!(tracker.get_islands().len(), expected_islands);
        }
    }

    #[test]
    fn nbr01_candidate_moat_chains_sloped_cantilever_across_layers() {
        let w = 64;
        let h = 4;
        let px_mm = 0.05;
        let support_buffer_mm = 0.25; // B = 5 -> moat radius = 6
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

        let mut tracker = IslandTracker::with_candidate_reach(
            job.px_mm,
            job.min_overlap_px,
            job.overlap_neighborhood_px,
            job.cantilever_overlap_neighborhood_px(),
            job.connectivity,
        );
        let mut prev_mask: Option<RleMask> = None;
        let mut prev_il: Option<RleLabels> = None;
        for l in 0..5i32 {
            let mut data = vec![0u8; (w * h) as usize];
            let x_start = l * 6;
            let x_end = x_start + 12;
            for y in 1..3 {
                for x in x_start..x_end {
                    data[(y * w + x) as usize] = 1;
                }
            }
            let mask = rle_encode(&data, w, h);
            let r = scan_layer(
                &mask,
                prev_mask.as_ref(),
                px_mm,
                support_buffer_mm,
                job.connectivity,
            );
            let il = tracker.process_layer(
                l as u32,
                &r.labels,
                &r.components,
                prev_il.as_ref(),
                &r.solid_mask,
                true,
            );
            prev_mask = Some(mask);
            prev_il = Some(il);
        }

        let islands = tracker.get_islands();
        assert_eq!(islands.len(), 1);
        assert_eq!(islands[0].first_layer, 0);
        assert_eq!(islands[0].last_layer, 4);
    }

    #[test]
    fn c2_detached_needle_within_cantilever_reach_is_not_absorbed_by_neighbor() {
        let w = 24;
        let h = 24;
        let px_mm = 0.05;
        let support_buffer_mm = 0.25; // B = 5 -> cantilever reach = 6

        let mut d0 = vec![0u8; (w * h) as usize];
        for y in 2..4 {
            for x in 4..8 {
                d0[(y * w + x) as usize] = 1;
            }
        }
        let m0 = rle_encode(&d0, w, h);
        let m1 = m0.clone(); // Layer 1 wall straight up -> C_1 empty

        // Layer 2: attached cantilever steps out to y=4..10 (C_2 at y=9, 6px from y=3)
        let mut d2 = d0.clone();
        for y in 4..10 {
            for x in 4..8 {
                d2[(y * w + x) as usize] = 1;
            }
        }
        let m2 = rle_encode(&d2, w, h);

        // Layer 3: detached needle at y=15..17 (6px from y=9 -> outside B=5, inside B+1=6)
        let mut d3 = d2.clone();
        for y in 15..17 {
            for x in 4..8 {
                d3[(y * w + x) as usize] = 1;
            }
        }
        let m3 = rle_encode(&d3, w, h);

        let mut tracker = IslandTracker::with_connectivity(px_mm, 1, 6, Connectivity::Eight);
        let mut prev_mask: Option<RleMask> = None;
        let mut prev_il: Option<RleLabels> = None;
        for (l, m) in [m0, m1, m2, m3].iter().enumerate() {
            let r = scan_layer(m, prev_mask.as_ref(), px_mm, support_buffer_mm, Connectivity::Eight);
            let il = tracker.process_layer(
                l as u32,
                &r.labels,
                &r.components,
                prev_il.as_ref(),
                &r.solid_mask,
                true,
            );
            prev_mask = Some(m.clone());
            prev_il = Some(il);
        }

        let islands = tracker.get_islands();
        assert_eq!(
            islands.len(),
            3,
            "expected wall(L0), cantilever(L2), and detached needle(L3); got {:?}",
            islands.iter().map(|i| (i.id.0, i.first_layer, i.last_layer)).collect::<Vec<_>>()
        );
        let cantilever = islands.iter().find(|i| i.first_layer == 2).unwrap();
        let needle = islands.iter().find(|i| i.first_layer == 3).unwrap();
        assert!(!cantilever.is_detached);
        assert!(needle.is_detached);
    }

    #[test]
    fn c2_candidate_same_layer_split_and_saddle_merge_is_order_invariant() {
        let w = 16;
        let h = 12;
        let px_mm = 0.05;

        let build_to_layer_1 = || {
            let mut tracker = IslandTracker::with_connectivity(px_mm, 1, 1, Connectivity::Four);

            // Layer 0: island A at x=2..4, y=4..6 (4px)
            let mut d0 = vec![0u8; (w * h) as usize];
            for y in 4..6 {
                for x in 2..4 {
                    d0[(y * w + x) as usize] = 1;
                }
            }
            let m0 = rle_encode(&d0, w, h);
            let r0 = scan_layer(&m0, None, px_mm, 0.0, Connectivity::Four);
            let il0 = tracker.process_layer(0, &r0.labels, &r0.components, None, &r0.solid_mask, true);

            // Layer 1: A continues at x=4..5, y=4..6; B starts at x=8..10, y=4..6
            let mut d1 = d0.clone();
            for y in 4..6 {
                d1[(y * w + 4) as usize] = 1;
                for x in 8..10 {
                    d1[(y * w + x) as usize] = 1;
                }
            }
            let m1 = rle_encode(&d1, w, h);
            let r1 = scan_layer(&m1, Some(&m0), px_mm, 0.0, Connectivity::Four);
            let il1 = tracker.process_layer(1, &r1.labels, &r1.components, Some(&il0), &r1.solid_mask, true);
            (tracker, d1, m1, il1)
        };

        // Layer 2 synthetic components:
        // - C_branch (id=1): x=9..11, y=2..4 -> overlaps ONLY B (within neighborhood 1)
        // - C_merge  (id=2): x=4..9,  y=6..8 -> overlaps BOTH A and B (within neighborhood 1)
        let mut l2_grid = vec![0i32; (w * h) as usize];
        for y in 2..4 {
            for x in 9..11 {
                l2_grid[(y * w + x) as usize] = 1;
            }
        }
        for y in 6..8 {
            for x in 4..9 {
                l2_grid[(y * w + x) as usize] = 2;
            }
        }
        let mut l2_rows = Vec::with_capacity(h as usize);
        for y in 0..h as usize {
            let mut spans = Vec::new();
            let row_off = y * w as usize;
            let mut run_start: i32 = -1;
            let mut cur_id: i32 = 0;
            for x in 0..w as usize {
                let id = l2_grid[row_off + x];
                if id != cur_id {
                    if cur_id > 0 {
                        spans.push(RleLabelRun {
                            start: run_start,
                            length: x as i32 - run_start,
                            id: cur_id,
                        });
                    }
                    cur_id = id;
                    run_start = x as i32;
                }
            }
            if cur_id > 0 {
                spans.push(RleLabelRun {
                    start: run_start,
                    length: w - run_start,
                    id: cur_id,
                });
            }
            l2_rows.push(spans);
        }
        let l2_labels = RleLabels {
            rows: l2_rows,
            width: w,
            height: h,
        };
        let c_branch = ComponentInfo {
            id: 1,
            label: 1,
            area_px: 4,
            size: 4,
            centroid_sum_x: 38.0,
            centroid_sum_y: 10.0,
            is_detached: false,
        };
        let c_merge = ComponentInfo {
            id: 2,
            label: 2,
            area_px: 10,
            size: 10,
            centroid_sum_x: 60.0,
            centroid_sum_y: 65.0,
            is_detached: false,
        };
        let empty_solid = RleMask {
            rows: vec![Vec::new(); h as usize],
            width: w,
            height: h,
        };

        let run_order = |comps: Vec<ComponentInfo>| {
            let (mut tracker, d1, _m1, il1) = build_to_layer_1();
            let il2 = tracker.process_layer(2, &l2_labels, &comps, Some(&il1), &empty_solid, true);

            let islands_l2 = tracker.get_islands();
            let a_l2 = islands_l2.iter().find(|i| i.first_layer == 0).unwrap().clone();
            let b_l2 = islands_l2.iter().find(|i| i.first_layer == 1).unwrap().clone();

            assert_eq!(a_l2.status, IslandStatus::Active);
            assert_eq!(a_l2.last_layer, 2);
            assert!(a_l2.has_saddle_merged);
            assert_eq!(
                b_l2.status,
                IslandStatus::Active,
                "split sibling B continuing via C_branch must stay Active"
            );
            assert_eq!(
                b_l2.last_layer, 2,
                "split sibling B with layer-2 labels must not rewind last_layer < 2"
            );

            // Layer 3: C_branch continues upward at x=10..12, y=1..3 (overlaps C_branch in il2)
            let mut d3 = d1;
            for y in 2..4 {
                for x in 9..11 {
                    d3[(y * w + x) as usize] = 1;
                }
            }
            for y in 6..8 {
                for x in 4..9 {
                    d3[(y * w + x) as usize] = 1;
                }
            }
            let m2 = rle_encode(&d3, w, h);
            let mut d3_next = d3.clone();
            for y in 1..3 {
                for x in 10..12 {
                    d3_next[(y * w + x) as usize] = 1;
                }
            }
            let m3 = rle_encode(&d3_next, w, h);
            let r3 = scan_layer(&m3, Some(&m2), px_mm, 0.0, Connectivity::Four);
            let _il3 = tracker.process_layer(3, &r3.labels, &r3.components, Some(&il2), &r3.solid_mask, true);

            let islands_l3 = tracker.get_islands();
            let b_l3 = islands_l3.iter().find(|i| i.first_layer == 1).unwrap().clone();
            assert_eq!(b_l3.status, IslandStatus::Active);
            assert_eq!(b_l3.last_layer, 3);
            (il2.rows, b_l2, b_l3)
        };

        let (rows_branch_first, b_l2_bf, b_l3_bf) = run_order(vec![c_branch.clone(), c_merge.clone()]);
        let (rows_merge_first, b_l2_mf, b_l3_mf) = run_order(vec![c_merge, c_branch]);

        assert_eq!(rows_branch_first, rows_merge_first);
        assert_eq!(b_l2_bf.last_layer, b_l2_mf.last_layer);
        assert_eq!(b_l2_bf.status, b_l2_mf.status);
        assert_eq!(b_l2_bf.has_saddle_merged, b_l2_mf.has_saddle_merged);
        assert_eq!(b_l2_bf.pre_merge_max_area_mm2, b_l2_mf.pre_merge_max_area_mm2);
        assert_eq!(b_l3_bf.last_layer, b_l3_mf.last_layer);
    }

    fn paint_box(buf: &mut [u8], w: i32, x0: i32, x1: i32, y0: i32, y1: i32) {
        for y in y0..y1 {
            for x in x0..x1 {
                buf[(y * w + x) as usize] = 1;
            }
        }
    }

    fn run_solid_masks(masks: &[RleMask], finalize: bool) -> (IslandTracker, Vec<RleLabels>) {
        let mut tracker = IslandTracker::new(0.1, 1, 1);
        let mut prev_mask: Option<RleMask> = None;
        let mut prev_il: Option<RleLabels> = None;
        let mut out_labels = Vec::with_capacity(masks.len());

        for (l, mask) in masks.iter().enumerate() {
            let r = scan_layer(mask, prev_mask.as_ref(), 0.1, 0.1, Connectivity::Eight);
            let il = tracker.process_layer(
                l as u32,
                &r.labels,
                &r.components,
                prev_il.as_ref(),
                &r.solid_mask,
                false,
            );
            prev_mask = Some(mask.clone());
            prev_il = Some(il.clone());
            out_labels.push(il);
        }
        if finalize && !masks.is_empty() {
            tracker.finalize_islands((masks.len() - 1) as u32);
        }
        (tracker, out_labels)
    }

    #[test]
    fn fld05_grounded_body_immediately_absorbs_hanging_fold_without_pending_merge() {
        let w = 24;
        let h = 12;
        let num_layers = 36usize;
        let mut masks = Vec::with_capacity(num_layers);

        // L0: small grounded body at x=2..4, y=2..4 (4 px)
        let mut d0 = vec![0u8; (w * h) as usize];
        paint_box(&mut d0, w, 2, 4, 2, 4);
        masks.push(rle_encode(&d0, w, h));

        // L1: grounded body + huge hanging fold at x=10..20, y=2..8 (60 px)
        let mut d1 = d0.clone();
        paint_box(&mut d1, w, 10, 20, 2, 8);
        masks.push(rle_encode(&d1, w, h));

        // L2..35: upper overhang connects body and fold, heavily leaning over fold's XY footprint
        let mut d_upper = vec![0u8; (w * h) as usize];
        paint_box(&mut d_upper, w, 2, 20, 3, 4);
        paint_box(&mut d_upper, w, 10, 20, 2, 8);
        let m_upper = rle_encode(&d_upper, w, h);
        for _ in 2..num_layers {
            masks.push(m_upper.clone());
        }

        let (mut tracker, labels) = run_solid_masks(&masks, true);
        let islands = tracker.get_islands();

        assert!(
            islands.iter().all(|i| !i.is_merged_placeholder),
            "grounded+ungrounded merge must not open a PendingMerge placeholder"
        );
        let body = islands.iter().find(|i| i.first_layer == 0).unwrap();
        let fold = islands.iter().find(|i| i.first_layer == 1).unwrap();

        assert_eq!(body.status, IslandStatus::Active);
        assert_eq!(body.last_layer, 35);
        assert_eq!(body.parent_id, None);
        assert!(body.child_ids.contains(&fold.id));

        assert_eq!(fold.status, IslandStatus::Complete);
        assert_eq!(fold.last_layer, 1);
        assert_eq!(fold.parent_id, Some(body.id));

        for (l, il) in labels.iter().enumerate().skip(2) {
            let ids: Vec<i32> = il.rows.iter().flat_map(|r| r.iter().map(|run| run.id)).collect();
            assert!(!ids.is_empty() && ids.iter().all(|&id| id == body.id.0 as i32), "layer {l} had {:?}", ids);
        }
    }

    #[test]
    fn fld05_two_grounded_bodies_absorb_fold_and_reparent_on_finalize() {
        let w = 24;
        let h = 10;
        let num_layers = 10usize;
        let mut masks = Vec::with_capacity(num_layers);

        // L0: two grounded pillars G1 (x=1..4) and G2 (x=15..19)
        let mut d0 = vec![0u8; (w * h) as usize];
        paint_box(&mut d0, w, 1, 4, 2, 6);
        paint_box(&mut d0, w, 15, 19, 2, 6);
        masks.push(rle_encode(&d0, w, h));

        // L1: G1, G2, plus hanging fold F (x=7..12)
        let mut d1 = d0.clone();
        paint_box(&mut d1, w, 7, 12, 2, 6);
        masks.push(rle_encode(&d1, w, h));

        // L2..9: all three connect into one bar
        let mut d_bar = vec![0u8; (w * h) as usize];
        paint_box(&mut d_bar, w, 1, 19, 2, 6);
        let m_bar = rle_encode(&d_bar, w, h);
        for _ in 2..num_layers {
            masks.push(m_bar.clone());
        }

        // Before finalize: F must already be Complete and reparented to the grounded placeholder
        let (mut pre_fin, _) = run_solid_masks(&masks, false);
        let pre_islands = pre_fin.get_islands();
        let pre_fold = pre_islands.iter().find(|i| i.first_layer == 1 && !i.is_merged_placeholder).unwrap();
        let placeholder = pre_islands.iter().find(|i| i.is_merged_placeholder).unwrap();
        assert_eq!(pre_fold.status, IslandStatus::Complete);
        assert_eq!(pre_fold.last_layer, 1);
        assert_eq!(pre_fold.parent_id, Some(placeholder.id));

        // After finalize: F must be reparented directly to the winning grounded pillar (G2 has more px)
        pre_fin.finalize_islands((num_layers - 1) as u32);
        let post_islands = pre_fin.get_islands();
        let winner = post_islands
            .iter()
            .find(|i| i.first_layer == 0 && i.parent_id.is_none())
            .unwrap();
        let other_grounded = post_islands
            .iter()
            .find(|i| i.first_layer == 0 && i.id != winner.id)
            .unwrap();
        let fold = post_islands.iter().find(|i| i.id == pre_fold.id).unwrap();
        let post_placeholder = post_islands.iter().find(|i| i.id == placeholder.id).unwrap();

        assert_eq!(post_placeholder.status, IslandStatus::Complete);
        assert_eq!(post_placeholder.parent_id, Some(winner.id));
        assert_eq!(fold.parent_id, Some(winner.id));
        assert_eq!(other_grounded.parent_id, Some(winner.id));
        assert!(winner.child_ids.contains(&fold.id));
        assert!(winner.child_ids.contains(&other_grounded.id));
    }

    #[test]
    fn fld05_floating_first_layer_with_none_prev_at_l_gt_0_remains_ungrounded() {
        let w = 24;
        let h = 10;
        let mut tracker = IslandTracker::new(0.1, 1, 1);

        // First call at layer_index = 1 with prev_island_labels = None (floating mesh)
        let mut d1 = vec![0u8; (w * h) as usize];
        paint_box(&mut d1, w, 1, 3, 2, 4);   // small A (4 px)
        paint_box(&mut d1, w, 10, 18, 2, 6); // large B (32 px)
        let m1 = rle_encode(&d1, w, h);
        let r1 = scan_layer(&m1, None, 0.1, 0.1, Connectivity::Eight);
        let il1 = tracker.process_layer(1, &r1.labels, &r1.components, None, &r1.solid_mask, false);

        // Merge at layer 2 over both footprints -> should open PendingMerge (not grounded immunity)
        let mut d2 = vec![0u8; (w * h) as usize];
        paint_box(&mut d2, w, 1, 18, 2, 6);
        let m2 = rle_encode(&d2, w, h);
        let r2 = scan_layer(&m2, Some(&m1), 0.1, 0.1, Connectivity::Eight);
        let _il2 = tracker.process_layer(2, &r2.labels, &r2.components, Some(&il1), &r2.solid_mask, false);

        let islands = tracker.get_islands();
        assert!(
            islands.iter().any(|i| i.is_merged_placeholder),
            "layer_index > 0 floating islands must remain ungrounded and use PendingMerge"
        );
    }

    #[test]
    fn fld05_floating_post_window_placeholder_complete_and_single_parent_resolves_at_31_plus() {
        use crate::pipeline::postprocess_with_mode;

        let w = 20;
        let h = 10;
        let num_layers = 36usize;
        let mut masks = Vec::with_capacity(num_layers);

        // L0 empty so L1 islands are ungrounded
        masks.push(rle_encode(&vec![0u8; (w * h) as usize], w, h));

        // L1: floating A (x=1..7, y=2..6 = 24 px) and B (x=12..14, y=2..4 = 4 px)
        let mut d1 = vec![0u8; (w * h) as usize];
        paint_box(&mut d1, w, 1, 7, 2, 6);
        paint_box(&mut d1, w, 12, 14, 2, 4);
        masks.push(rle_encode(&d1, w, h));

        // L2..35: merged bar spanning A and B
        let mut d_bar = vec![0u8; (w * h) as usize];
        paint_box(&mut d_bar, w, 1, 14, 2, 6);
        let m_bar = rle_encode(&d_bar, w, h);
        for _ in 2..num_layers {
            masks.push(m_bar.clone());
        }

        let (mut tracker, labels) = run_solid_masks(&masks, false);
        let islands = tracker.get_islands();
        let placeholder = islands.iter().find(|i| i.is_merged_placeholder).unwrap();
        let winner = islands
            .iter()
            .find(|i| !i.is_merged_placeholder && i.parent_id.is_none())
            .unwrap();

        assert_eq!(placeholder.status, IslandStatus::Complete);
        assert_eq!(placeholder.parent_id, Some(winner.id));
        assert_eq!(winner.status, IslandStatus::Active);
        assert_eq!(winner.last_layer, 35);
        for l in 33..=35u32 {
            assert!(
                winner.per_layer_area_mm2.contains_key(&l),
                "winner must receive post-window layer {l} area"
            );
        }

        let winner_id = winner.id;
        let grid = GridRef {
            origin_x: 0.0,
            origin_z: 0.0,
            width: w,
            height: h,
            px_mm: 0.1,
        };
        let res = postprocess_with_mode(grid, islands, labels, 0.1, 0.0001, false);
        let post_winner = res.islands.iter().find(|i| i.id == winner_id).unwrap();
        assert_eq!(post_winner.last_layer, 35);
        assert!(post_winner.volume_mm3.unwrap() > 0.0);
    }

    #[test]
    fn fld05_chained_floating_merges_within_window_flush_placeholder_and_remap_pre_merge() {
        use crate::pipeline::postprocess_with_mode;

        let w = 24;
        let h = 10;
        let num_layers = 37usize;
        let mut masks = Vec::with_capacity(num_layers);

        // L0 empty
        masks.push(rle_encode(&vec![0u8; (w * h) as usize], w, h));

        // L1: A (x=1..7, y=2..6 = 24px), B (x=9..11, y=2..4 = 4px), C (x=16..20, y=2..5 = 12px)
        let mut d1 = vec![0u8; (w * h) as usize];
        paint_box(&mut d1, w, 1, 7, 2, 6);
        paint_box(&mut d1, w, 9, 11, 2, 4);
        paint_box(&mut d1, w, 16, 20, 2, 5);
        masks.push(rle_encode(&d1, w, h));

        // L2..4: A+B merge into P1 (x=1..11, y=2..6), C separate (x=16..20, y=2..5)
        let mut d2 = vec![0u8; (w * h) as usize];
        paint_box(&mut d2, w, 1, 11, 2, 6);
        paint_box(&mut d2, w, 16, 20, 2, 5);
        let m2 = rle_encode(&d2, w, h);
        for _ in 2..=4 {
            masks.push(m2.clone());
        }

        // L5..36: P1 merges with C (< 30 layers after L2 merge!)
        let mut d5 = vec![0u8; (w * h) as usize];
        paint_box(&mut d5, w, 1, 20, 2, 6);
        let m5 = rle_encode(&d5, w, h);
        for _ in 5..num_layers {
            masks.push(m5.clone());
        }

        let (mut tracker, labels) = run_solid_masks(&masks, true);
        let islands = tracker.get_islands();

        let placeholders: Vec<&Island> = islands.iter().filter(|i| i.is_merged_placeholder).collect();
        assert_eq!(placeholders.len(), 2);
        for p in &placeholders {
            assert_eq!(p.status, IslandStatus::Complete);
            let pid = p.parent_id.expect("placeholder must have parent");
            let parent = islands.iter().find(|i| i.id == pid).unwrap();
            assert!(
                !parent.is_merged_placeholder,
                "placeholder {} must never win election as parent of {}",
                pid.0, p.id.0
            );
        }

        // A had 24 px vs B's 4 px and C's 12 px, so A must be the sole surviving root
        let roots: Vec<&Island> = islands
            .iter()
            .filter(|i| !i.is_merged_placeholder && i.parent_id.is_none())
            .collect();
        assert_eq!(roots.len(), 1);
        let winner = roots[0];
        let winner_id = winner.id;
        assert_eq!(winner.last_layer, 36);
        assert_eq!(winner.status, IslandStatus::Active);
        assert!(winner.per_layer_area_mm2.get(&1).copied().unwrap_or(0.0) > 0.20); // A (24*0.01 = 0.24)

        let grid = GridRef {
            origin_x: 0.0,
            origin_z: 0.0,
            width: w,
            height: h,
            px_mm: 0.1,
        };
        let res = postprocess_with_mode(grid, islands, labels, 0.1, 0.0001, false);
        assert_eq!(res.islands.len(), 3); // A, B, C (no placeholders)
        let post_winner = res.islands.iter().find(|i| i.id == winner_id).unwrap();
        assert_eq!(post_winner.last_layer, 36);
        // Every layer >= 2 must have solid pixels mapped to winner (not dropped to 0)
        for (l, il) in res.island_labels_per_layer.iter().enumerate().skip(5) {
            let px: i32 = il.rows.iter().flat_map(|r| r.iter().filter(|run| run.id == winner_id.0 as i32).map(|run| run.length)).sum();
            assert!(px > 0, "layer {l} lost pixels after postprocess");
        }
    }

    #[test]
    fn fld05_top_30_finalize_islands_resolves_open_merges() {
        use crate::pipeline::postprocess_with_mode;

        let w = 20;
        let h = 10;
        let num_layers = 11usize; // L0..10 (< 30 layers after merge at L2)
        let mut masks = Vec::with_capacity(num_layers);

        masks.push(rle_encode(&vec![0u8; (w * h) as usize], w, h));

        let mut d1 = vec![0u8; (w * h) as usize];
        paint_box(&mut d1, w, 1, 7, 2, 6);   // A: 24 px
        paint_box(&mut d1, w, 12, 14, 2, 4); // B: 4 px
        masks.push(rle_encode(&d1, w, h));

        let mut d_bar = vec![0u8; (w * h) as usize];
        paint_box(&mut d_bar, w, 1, 14, 2, 6);
        let m_bar = rle_encode(&d_bar, w, h);
        for _ in 2..num_layers {
            masks.push(m_bar.clone());
        }

        let (mut tracker, labels) = run_solid_masks(&masks, true);
        let islands = tracker.get_islands();
        let placeholder = islands.iter().find(|i| i.is_merged_placeholder).unwrap();
        let winner = islands
            .iter()
            .find(|i| !i.is_merged_placeholder && i.parent_id.is_none())
            .unwrap();

        assert_eq!(placeholder.status, IslandStatus::Complete);
        assert_eq!(placeholder.parent_id, Some(winner.id));
        assert_eq!(winner.last_layer, 10);

        let winner_id = winner.id;
        let grid = GridRef {
            origin_x: 0.0,
            origin_z: 0.0,
            width: w,
            height: h,
            px_mm: 0.1,
        };
        let res = postprocess_with_mode(grid, islands, labels, 0.1, 0.0001, false);
        let post_winner = res.islands.iter().find(|i| i.id == winner_id).unwrap();
        assert_eq!(post_winner.last_layer, 10);
        assert!(post_winner.volume_mm3.unwrap() > 0.0);
        for (l, il) in res.island_labels_per_layer.iter().enumerate().skip(2) {
            let any_winner = il.rows.iter().any(|r| r.iter().any(|run| run.id == winner_id.0 as i32));
            assert!(any_winner, "layer {l} must retain winner label after postprocess");
        }
    }

    #[test]
    fn phase_d_indirect_placeholder_reference_flushes_pending_merge_before_next_merge() {
        use crate::pipeline::postprocess_with_mode;

        let w = 44;
        let h = 14;
        let num_layers = 11usize;
        let mut masks = Vec::with_capacity(num_layers);

        // L0: three grounded pillars G1 (x=9..14, y=8..12 = 20px), G2 (x=18..22, y=8..12 = 16px), G3 (x=26..32, y=1..5 = 24px)
        let mut d0 = vec![0u8; (w * h) as usize];
        paint_box(&mut d0, w, 9, 14, 8, 12);
        paint_box(&mut d0, w, 18, 22, 8, 12);
        paint_box(&mut d0, w, 26, 32, 1, 5);
        masks.push(rle_encode(&d0, w, h));

        // L1: G1, G2, G3 + ungrounded U (x=1..5, y=1..12 = 44px)
        let mut d1 = d0.clone();
        paint_box(&mut d1, w, 1, 5, 1, 12);
        masks.push(rle_encode(&d1, w, h));

        // L2: comp_branch continues U at top-left (x=1..5, y=1..4 = 12px);
        // G3 continues at top-right (x=26..32, y=1..5 = 24px);
        // comp_merge connects U, G1, G2 at bottom (x=1..22, y=8..12 = 84px) -> creates P1, sets U.parent_id = P1
        let mut d2 = vec![0u8; (w * h) as usize];
        paint_box(&mut d2, w, 1, 5, 1, 4);
        paint_box(&mut d2, w, 26, 32, 1, 5);
        paint_box(&mut d2, w, 1, 22, 8, 12);
        masks.push(rle_encode(&d2, w, h));

        // L3..10: comp_ug3 merges {U (comp_branch), G3} at top (x=1..32, y=1..5 = 124px);
        // comp_p1 continues P1 at bottom (x=9..22, y=8..12 = 52px)
        let mut d3 = vec![0u8; (w * h) as usize];
        paint_box(&mut d3, w, 1, 32, 1, 5);
        paint_box(&mut d3, w, 9, 22, 8, 12);
        let m3 = rle_encode(&d3, w, h);
        for _ in 3..num_layers {
            masks.push(m3.clone());
        }

        // Run through L3 and inspect state BEFORE finalize_islands
        let (mut t_l3, _) = run_solid_masks(&masks[..=3], false);
        let isl_l3 = t_l3.get_islands();
        let u_l3 = isl_l3.iter().find(|i| i.first_layer == 1 && !i.is_merged_placeholder).unwrap();
        let g1_l3 = isl_l3
            .iter()
            .filter(|i| i.first_layer == 0 && !i.is_merged_placeholder)
            .find(|i| i.per_layer_area_mm2.get(&0).copied().unwrap_or(0.0) > 0.18 && i.per_layer_area_mm2.get(&0).copied().unwrap_or(0.0) < 0.22)
            .unwrap();
        let p1_l3 = isl_l3
            .iter()
            .find(|i| i.is_merged_placeholder && i.first_layer == 2)
            .unwrap();

        assert_eq!(
            p1_l3.status,
            IslandStatus::Complete,
            "P1 must flush before {{U, G3}} merge on L=3"
        );
        assert_eq!(
            p1_l3.parent_id,
            Some(g1_l3.id),
            "P1 must finalize to G1 (not None or 0)"
        );
        assert_eq!(g1_l3.status, IslandStatus::Active);
        assert_eq!(g1_l3.last_layer, 3);
        assert_eq!(u_l3.status, IslandStatus::Active);
        assert_eq!(u_l3.last_layer, 2);
        assert_eq!(u_l3.parent_id, Some(g1_l3.id));

        // Full run + finalize_islands: verify zero double-counting, no parentId=0, exact summed area
        let expected_px: usize = [
            20 + 16 + 24,       // L0
            20 + 16 + 24 + 44,  // L1
            12 + 24 + 84,       // L2
        ]
        .iter()
        .sum::<usize>()
            + (num_layers - 3) * (124 + 52);
        let expected_area_mm2 = expected_px as f64 * 0.1 * 0.1;

        let (mut tracker, labels) = run_solid_masks(&masks, true);
        let islands = tracker.get_islands();
        for p in islands.iter().filter(|i| i.is_merged_placeholder) {
            assert_eq!(p.status, IslandStatus::Complete);
            let pid = p.parent_id.expect("placeholder must have parent_id");
            assert_ne!(pid, IslandId(0), "parent_id must never be 0");
            let parent = islands.iter().find(|i| i.id == pid).unwrap();
            assert!(!parent.is_merged_placeholder);
        }

        let actual_area_mm2: f64 = islands
            .iter()
            .filter(|i| !i.is_merged_placeholder)
            .map(|i| i.total_area_mm2)
            .sum();
        assert!(
            (actual_area_mm2 - expected_area_mm2).abs() < 1e-6,
            "summed non-placeholder area {} must equal exact solid area {}",
            actual_area_mm2,
            expected_area_mm2
        );

        let grid = GridRef {
            origin_x: 0.0,
            origin_z: 0.0,
            width: w,
            height: h,
            px_mm: 0.1,
        };
        let res = postprocess_with_mode(grid, islands, labels, 0.1, 0.0001, false);
        assert!(res.islands.iter().all(|i| !i.is_merged_placeholder));
    }

    #[test]
    fn phase_d_collapse_u_and_p1_to_single_target_does_not_flush_p1_prematurely() {
        let w = 28;
        let h = 12;
        let mut masks = Vec::with_capacity(4);

        // L0: G1 (x=12..16, y=6..10) and G2 (x=19..22, y=6..10)
        let mut d0 = vec![0u8; (w * h) as usize];
        paint_box(&mut d0, w, 12, 16, 6, 10);
        paint_box(&mut d0, w, 19, 22, 6, 10);
        masks.push(rle_encode(&d0, w, h));

        // L1: G1, G2 + U (x=1..9, y=1..7)
        let mut d1 = d0.clone();
        paint_box(&mut d1, w, 1, 9, 1, 7);
        masks.push(rle_encode(&d1, w, h));

        // L2: comp_branch continues U (x=1..4, y=1..3); comp_merge connects {U, G1, G2} (x=7..22, y=5..10) -> P1, U.parent_id = P1
        let mut d2 = vec![0u8; (w * h) as usize];
        paint_box(&mut d2, w, 1, 4, 1, 3);
        paint_box(&mut d2, w, 7, 22, 5, 10);
        masks.push(rle_encode(&d2, w, h));

        // L3: single bridge overlapping both U and P1 -> resolves to {P1} (len == 1)
        let mut d3 = vec![0u8; (w * h) as usize];
        paint_box(&mut d3, w, 1, 22, 1, 10);
        masks.push(rle_encode(&d3, w, h));

        let (mut tracker, _) = run_solid_masks(&masks, false);
        let islands = tracker.get_islands();
        let p1 = islands
            .iter()
            .find(|i| i.is_merged_placeholder && i.first_layer == 2)
            .unwrap();
        assert_eq!(
            p1.status,
            IslandStatus::Active,
            "{{U, P1}} collapsing to {{P1}} must NOT prematurely flush P1"
        );
        assert_eq!(p1.parent_id, None);
        assert_eq!(p1.last_layer, 3);
    }

    #[test]
    fn phase_d_same_layer_split_and_flush_preserves_winner_last_layer_and_volume() {
        use crate::pipeline::postprocess_with_mode;

        let w = 32;
        let h = 12;
        let mut masks = Vec::with_capacity(4);

        // L0: empty (all L1 islands ungrounded)
        masks.push(rle_encode(&vec![0u8; (w * h) as usize], w, h));

        // L1: A (x=1..7, y=2..8 = 36px), B (x=10..12, y=6..8 = 4px), C (x=18..28, y=6..10 = 40px)
        let mut d1 = vec![0u8; (w * h) as usize];
        paint_box(&mut d1, w, 1, 7, 2, 8);
        paint_box(&mut d1, w, 10, 12, 6, 8);
        paint_box(&mut d1, w, 18, 28, 6, 10);
        masks.push(rle_encode(&d1, w, h));

        // L2: {A, B} merge -> P1 (x=1..15, y=2..8); C continues (x=18..28, y=6..10)
        let mut d2 = vec![0u8; (w * h) as usize];
        paint_box(&mut d2, w, 1, 15, 2, 8);
        paint_box(&mut d2, w, 18, 28, 6, 10);
        masks.push(rle_encode(&d2, w, h));

        // L3: comp_1 continues P1 (x=1..6, y=2..4 = 10px);
        // comp_2 flushes P1 -> A and merges {A, C} (x=12..28, y=6..10 = 64px, heavily overlapping C)
        let mut d3 = vec![0u8; (w * h) as usize];
        paint_box(&mut d3, w, 1, 6, 2, 4);
        paint_box(&mut d3, w, 12, 28, 6, 10);
        masks.push(rle_encode(&d3, w, h));

        let (mut tracker, labels) = run_solid_masks(&masks, true);
        let islands = tracker.get_islands();

        // A started at L1 with 36px (area 0.36 at L1)
        let a = islands
            .iter()
            .find(|i| {
                i.first_layer == 1
                    && !i.is_merged_placeholder
                    && (i.per_layer_area_mm2.get(&1).copied().unwrap_or(0.0) - 0.36).abs() < 1e-9
            })
            .unwrap();
        assert_eq!(a.last_layer, 3, "A.last_layer must stay 3 after same-layer split + flush");
        assert!(a.per_layer_area_mm2.contains_key(&3));
        assert_eq!(
            a.last_layer,
            *a.per_layer_area_mm2.keys().max().unwrap(),
            "last_layer must match max(per_layer_area_mm2.keys)"
        );

        let a_id = a.id;
        let grid = GridRef {
            origin_x: 0.0,
            origin_z: 0.0,
            width: w,
            height: h,
            px_mm: 0.1,
        };
        let res = postprocess_with_mode(grid, islands, labels, 0.1, 0.0001, false);
        let post_a = res.islands.iter().find(|i| i.id == a_id).unwrap();
        assert_eq!(post_a.last_layer, 3);
        let expected_a_vol = post_a.per_layer_area_mm2.values().sum::<f64>() * 0.1;
        assert!((post_a.volume_mm3.unwrap() - expected_a_vol).abs() < 1e-9);
    }

    #[test]
    fn phase_d_same_layer_sibling_split_keeps_continuing_branch_active() {
        let w = 24;
        let h = 12;
        let mut masks = Vec::with_capacity(3);

        // L0: A (x=1..5, y=2..6 = 16px), B (x=10..15, y=2..10 = 40px), C (x=18..22, y=7..10 = 12px)
        let mut d0 = vec![0u8; (w * h) as usize];
        paint_box(&mut d0, w, 1, 5, 2, 6);
        paint_box(&mut d0, w, 10, 15, 2, 10);
        paint_box(&mut d0, w, 18, 22, 7, 10);
        masks.push(rle_encode(&d0, w, h));

        // L1: comp_merge at TOP (x=1..15, y=2..5) bridges {A, B};
        // comp_branch at BOTTOM (x=10..15, y=7..10) continues {B}; C continues at (x=18..22, y=7..10)
        let mut d1 = vec![0u8; (w * h) as usize];
        paint_box(&mut d1, w, 1, 15, 2, 5);
        paint_box(&mut d1, w, 10, 15, 7, 10);
        paint_box(&mut d1, w, 18, 22, 7, 10);
        masks.push(rle_encode(&d1, w, h));

        let (mut t_l1, _) = run_solid_masks(&masks[..=1], false);
        let isl_l1 = t_l1.get_islands();
        let b_l1 = isl_l1
            .iter()
            .find(|i| {
                i.first_layer == 0
                    && !i.is_merged_placeholder
                    && (i.per_layer_area_mm2.get(&0).copied().unwrap_or(0.0) - 0.40).abs() < 1e-9
            })
            .unwrap();
        let a_l1 = isl_l1
            .iter()
            .find(|i| {
                i.first_layer == 0
                    && !i.is_merged_placeholder
                    && (i.per_layer_area_mm2.get(&0).copied().unwrap_or(0.0) - 0.16).abs() < 1e-9
            })
            .unwrap();

        assert_eq!(
            b_l1.status,
            IslandStatus::Active,
            "sibling B continuing on L=1 must stay Active even when {{A, B}} merges"
        );
        assert_eq!(b_l1.last_layer, 1);
        assert_eq!(a_l1.status, IslandStatus::Complete);
        assert_eq!(a_l1.last_layer, 0);

        // L2: bridge {B, C} at (x=10..22, y=7..10) + continue P1 at (x=1..15, y=2..5)
        let mut d2 = vec![0u8; (w * h) as usize];
        paint_box(&mut d2, w, 1, 15, 2, 5);
        paint_box(&mut d2, w, 10, 22, 7, 10);
        masks.push(rle_encode(&d2, w, h));

        let (mut t_l2, _) = run_solid_masks(&masks, false);
        let isl_l2 = t_l2.get_islands();
        let placeholders_l2: Vec<&Island> =
            isl_l2.iter().filter(|i| i.is_merged_placeholder).collect();
        assert_eq!(
            placeholders_l2.len(),
            2,
            "L=2 bridge between active branch B and C must open second PendingMerge"
        );
    }
}

