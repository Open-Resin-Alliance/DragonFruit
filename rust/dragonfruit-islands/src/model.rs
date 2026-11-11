//! Core domain types for island detection.
//!
//! DDD Building Block Mapping:
//! - `IslandId`        — Value Object (Newtype ID)
//! - `RleRun`          — Value Object
//! - `RleMask`         — Value Object
//! - `RleLabelRun`     — Value Object
//! - `RleLabels`       — Value Object
//! - `ComponentInfo`   — Value Object
//! - `Island`          — Entity (has identity, mutable lifecycle)
//! - `IslandStatus`    — Value Object (enum)
//! - `Centroid`        — Value Object
//! - `IslandScanJob`   — Value Object (Command)
//! - `IslandScanResult`— Value Object (Result)
//! - `GridRef`         — Value Object

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/// Pixel connectivity for connected component labeling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Connectivity {
    Four = 4,
    Eight = 8,
}

// ---------------------------------------------------------------------------
// RLE Value Objects
// ---------------------------------------------------------------------------

/// A single run in a binary RLE row: [start, length).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RleRun {
    pub start: i32,
    pub length: i32,
}

/// A single row of binary RLE data — a sorted sequence of non-overlapping runs.
pub type RleRow = Vec<RleRun>;

/// Binary RLE mask over a 2D grid. Rows indexed by Y coordinate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RleMask {
    pub rows: Vec<RleRow>,
    pub width: i32,
    pub height: i32,
}

impl RleMask {
    pub fn empty(width: i32, height: i32) -> Self {
        Self {
            rows: vec![Vec::new(); height as usize],
            width,
            height,
        }
    }

    /// Total number of ON pixels.
    pub fn pixel_count(&self) -> u64 {
        self.rows
            .iter()
            .flat_map(|row| row.iter())
            .map(|r| r.length as u64)
            .sum()
    }
}

/// A single run in a labeled RLE row: [start, length, id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RleLabelRun {
    pub start: i32,
    pub length: i32,
    pub id: i32,
}

/// A single row of labeled RLE data.
pub type RleLabelRow = Vec<RleLabelRun>;

/// Labeled RLE over a 2D grid. Each run carries a component/island ID.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RleLabels {
    pub rows: Vec<RleLabelRow>,
    pub width: i32,
    pub height: i32,
}

impl RleLabels {
    pub fn empty(width: i32, height: i32) -> Self {
        Self {
            rows: vec![Vec::new(); height as usize],
            width,
            height,
        }
    }
}

// ---------------------------------------------------------------------------
// Component Info (Value Object)
// ---------------------------------------------------------------------------

/// Per-component statistics produced by connected component labeling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentInfo {
    pub id: i32,
    pub label: i32,
    pub area_px: i32,
    pub size: i32,
    pub centroid_sum_x: f64,
    pub centroid_sum_y: f64,
}

// ---------------------------------------------------------------------------
// Island ID (Newtype Value Object)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct IslandId(pub u32);

impl std::fmt::Display for IslandId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

// ---------------------------------------------------------------------------
// Island Status (Value Object)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IslandStatus {
    Active,
    Complete,
}

// ---------------------------------------------------------------------------
// Centroid (Value Object)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Centroid {
    pub x: f64,
    pub y: f64,
    /// Z in **layer-index units**, not mm (matches `centroid_sum_z`).
    /// Multiply by `layer_height_mm` (and add `bbox_min_z`) for world Z.
    pub z: f64,
}

// ---------------------------------------------------------------------------
// Island (Entity)
// ---------------------------------------------------------------------------

/// An island entity tracked across layers. Has identity (`id`) and a mutable lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Island {
    pub id: IslandId,
    pub first_layer: u32,
    pub last_layer: u32,
    pub status: IslandStatus,
    pub total_area_mm2: f64,
    pub per_layer_area_mm2: HashMap<u32, f64>,
    pub parent_id: Option<IslandId>,
    pub child_ids: Vec<IslandId>,
    pub volume_mm3: Option<f64>,
    pub max_area_mm2: Option<f64>,
    pub max_area_layer: Option<u32>,
    pub is_merged_placeholder: bool,
    pub centroid_sum_x: f64,
    pub centroid_sum_y: f64,
    /// Accumulated Z in **layer-index units** (Σ size × layer_index), NOT mm.
    /// Convert to world Z via `bbox_min_z + layer_index * layer_height_mm`
    /// (the consumer derives world Z from `first_layer`).
    pub centroid_sum_z: f64,
    pub centroid_count: u64,
    pub centroid: Option<Centroid>,
    pub last_layer_centroid: Option<Centroid>,
    /// First-layer (birth) centroid in **pixel coordinates** (x, y) with Z as
    /// the **`first_layer` index** (not a world-space coordinate). Used for
    /// support contact snapping; world Z conversion must use `first_layer`:
    /// `bbox_min_z + first_layer * layer_height_mm` for the contact base.
    pub seed_voxel: Option<Centroid>,
    #[serde(skip)]
    birth_centroid_sum_x: f64,
    #[serde(skip)]
    birth_centroid_sum_y: f64,
    #[serde(skip)]
    birth_centroid_count: u64,
}

impl Island {
    pub fn new(
        id: IslandId,
        layer: u32,
        area_mm2: f64,
        comp: Option<&ComponentInfo>,
    ) -> Self {
        let (
            centroid_sum_x,
            centroid_sum_y,
            centroid_sum_z,
            centroid_count,
            last_layer_centroid,
            birth_centroid_sum_x,
            birth_centroid_sum_y,
            birth_centroid_count,
        ) = if let Some(c) = comp {
            let count = c.size as u64;
            let (llc, bx, by, bc) = if c.size > 0 {
                (
                    Some(Centroid {
                        x: c.centroid_sum_x / c.size as f64,
                        y: c.centroid_sum_y / c.size as f64,
                        z: layer as f64,
                    }),
                    c.centroid_sum_x,
                    c.centroid_sum_y,
                    count,
                )
            } else {
                (None, 0.0, 0.0, 0)
            };
            (
                c.centroid_sum_x,
                c.centroid_sum_y,
                count as f64 * layer as f64,
                count,
                llc,
                bx,
                by,
                bc,
            )
        } else {
            (0.0, 0.0, 0.0, 0, None, 0.0, 0.0, 0)
        };

        let mut per_layer = HashMap::new();
        per_layer.insert(layer, area_mm2);

        Self {
            id,
            first_layer: layer,
            last_layer: layer,
            status: IslandStatus::Active,
            total_area_mm2: area_mm2,
            per_layer_area_mm2: per_layer,
            parent_id: None,
            child_ids: Vec::new(),
            volume_mm3: None,
            max_area_mm2: Some(area_mm2),
            max_area_layer: Some(layer),
            is_merged_placeholder: false,
            centroid_sum_x,
            centroid_sum_y,
            centroid_sum_z,
            centroid_count,
            centroid: None,
            last_layer_centroid,
            seed_voxel: last_layer_centroid,
            birth_centroid_sum_x,
            birth_centroid_sum_y,
            birth_centroid_count,
        }
    }

    /// Update island with new layer data (continuation).
    pub fn update(&mut self, layer: u32, area_mm2: f64, comp: Option<&ComponentInfo>) {
        let prev_first_layer = self.first_layer;
        if layer < self.first_layer {
            self.first_layer = layer;
        }
        if layer >= self.last_layer {
            self.last_layer = layer;
        }
        self.total_area_mm2 += area_mm2;
        let layer_area = match self.per_layer_area_mm2.entry(layer) {
            std::collections::hash_map::Entry::Occupied(mut e) => {
                *e.get_mut() += area_mm2;
                *e.get()
            }
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(area_mm2);
                area_mm2
            }
        };

        if self.max_area_mm2.map_or(true, |m| layer_area > m) {
            self.max_area_mm2 = Some(layer_area);
            self.max_area_layer = Some(layer);
        }

        if let Some(c) = comp {
            self.centroid_sum_x += c.centroid_sum_x;
            self.centroid_sum_y += c.centroid_sum_y;
            self.centroid_sum_z += c.size as f64 * layer as f64;
            self.centroid_count += c.size as u64;

            if c.size > 0 {
                let layer_centroid = Centroid {
                    x: c.centroid_sum_x / c.size as f64,
                    y: c.centroid_sum_y / c.size as f64,
                    z: layer as f64,
                };
                if layer >= self.last_layer {
                    self.last_layer_centroid = Some(layer_centroid);
                }

                if layer < prev_first_layer {
                    self.birth_centroid_sum_x = c.centroid_sum_x;
                    self.birth_centroid_sum_y = c.centroid_sum_y;
                    self.birth_centroid_count = c.size as u64;
                    self.seed_voxel = Some(layer_centroid);
                } else if layer == prev_first_layer {
                    self.birth_centroid_sum_x += c.centroid_sum_x;
                    self.birth_centroid_sum_y += c.centroid_sum_y;
                    self.birth_centroid_count += c.size as u64;
                    self.seed_voxel = Some(Centroid {
                        x: self.birth_centroid_sum_x / self.birth_centroid_count as f64,
                        y: self.birth_centroid_sum_y / self.birth_centroid_count as f64,
                        z: layer as f64,
                    });
                } else if self.seed_voxel.is_none() {
                    self.birth_centroid_sum_x = c.centroid_sum_x;
                    self.birth_centroid_sum_y = c.centroid_sum_y;
                    self.birth_centroid_count = c.size as u64;
                    self.seed_voxel = Some(layer_centroid);
                }
            }
        }
    }

    /// Compute final global centroid from accumulators.
    ///
    /// Note: `centroid.z` is in layer-index units (as accumulated by
    /// `centroid_sum_z`); convert to world Z with `first_layer` /
    /// `layer_height_mm` as documented on `seed_voxel`.
    pub fn compute_centroid(&mut self) {
        if self.centroid_count > 0 {
            self.centroid = Some(Centroid {
                x: self.centroid_sum_x / self.centroid_count as f64,
                y: self.centroid_sum_y / self.centroid_count as f64,
                z: self.centroid_sum_z / self.centroid_count as f64,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Grid Reference (Value Object)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridRef {
    pub origin_x: f64,
    pub origin_z: f64,
    pub width: i32,
    pub height: i32,
    pub px_mm: f64,
}

// ---------------------------------------------------------------------------
// Island Scan Job (Value Object / Command)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IslandScanJob {
    pub px_mm: f64,
    pub support_buffer_mm: f64,
    pub connectivity: Connectivity,
    pub min_island_area_mm2: f64,
    pub layer_height_mm: f64,
    pub grid: GridRef,
    pub num_layers: u32,
    pub min_overlap_px: i32,
    pub overlap_neighborhood_px: i32,
    #[serde(default)]
    pub candidate_only: bool,
}

impl IslandScanJob {
    pub fn support_buffer_px(&self) -> i32 {
        (self.support_buffer_mm / self.px_mm).round().max(0.0) as i32
    }
}

// ---------------------------------------------------------------------------
// Scan Layer Result (Value Object)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanLayerResult {
    pub labels: RleLabels,
    pub components: Vec<ComponentInfo>,
    pub solid_mask: RleMask,
}

// ---------------------------------------------------------------------------
// Island Scan Result (Value Object)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IslandScanResult {
    pub grid: GridRef,
    pub islands: Vec<Island>,
    pub island_labels_per_layer: Vec<RleLabels>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comp(id: i32, size: i32, cx: f64, cy: f64) -> ComponentInfo {
        ComponentInfo {
            id,
            label: id,
            area_px: size,
            size,
            centroid_sum_x: cx * size as f64,
            centroid_sum_y: cy * size as f64,
        }
    }

    #[test]
    fn island_birth_layer_update_computes_canonical_seed_voxel() {
        // Born at layer 2 with a single corner pixel at (1, 1), then updated on
        // the same birth layer 2 with a 3-pixel body centered at (5, 3), and then
        // continued onto higher layer 3 at (50, 50). `seed_voxel` must reflect the
        // pixel-weighted birth-layer centroid ((1*1 + 3*5)/4 = 4.0, (1*1 + 3*3)/4 = 2.5)
        // at z = 2.0, neither locked to (1, 1) nor overwritten by layer 3.
        let corner = comp(1, 1, 1.0, 1.0);
        let birth_body = comp(2, 3, 5.0, 3.0);
        let upper = comp(3, 10, 50.0, 50.0);

        let mut island = Island::new(IslandId(1), 2, 0.05, Some(&corner));
        island.update(2, 0.15, Some(&birth_body));
        island.update(3, 0.50, Some(&upper));

        assert_eq!(island.first_layer, 2);
        assert_eq!(island.last_layer, 3);
        let seed = island.seed_voxel.expect("seed_voxel present");
        assert!((seed.x - 4.0).abs() < 1e-9, "seed.x = {}", seed.x);
        assert!((seed.y - 2.5).abs() < 1e-9, "seed.y = {}", seed.y);
        assert!((seed.z - 2.0).abs() < 1e-9, "seed.z = {}", seed.z);
    }

    #[test]
    fn island_update_anchors_seed_voxel_to_first_layer_and_backfills_none() {
        // 1. Backfill when Island::new starts with comp = None, then lock to
        //    that seed rather than overwriting on upper layers.
        let mut from_none = Island::new(IslandId(10), 2, 0.0, None);
        assert!(from_none.seed_voxel.is_none());
        let c_fill = comp(1, 4, 6.5, 8.25);
        from_none.update(3, 0.20, Some(&c_fill));
        from_none.update(4, 0.50, Some(&comp(2, 10, 30.0, 40.0)));
        assert_eq!(
            from_none.seed_voxel,
            Some(Centroid {
                x: 6.5,
                y: 8.25,
                z: 3.0,
            })
        );

        // 2. Updating an islandborn at layer 5 with a lower birth layer 2
        //    anchors `first_layer == 2` and `seed_voxel` to layer 2 regardless
        //    of update order.
        let tip_2 = comp(3, 2, 3.5, 7.0);
        let tip_5 = comp(4, 6, 18.0, 14.0);

        let mut a_then_b = Island::new(IslandId(11), 2, 0.10, Some(&tip_2));
        a_then_b.update(5, 0.30, Some(&tip_5));

        let mut b_then_a = Island::new(IslandId(12), 5, 0.30, Some(&tip_5));
        b_then_a.update(2, 0.10, Some(&tip_2));

        let expected_seed = Some(Centroid {
            x: 3.5,
            y: 7.0,
            z: 2.0,
        });
        assert_eq!(a_then_b.first_layer, 2);
        assert_eq!(b_then_a.first_layer, 2);
        assert_eq!(b_then_a.last_layer, 5);
        assert_eq!(a_then_b.seed_voxel, expected_seed);
        assert_eq!(b_then_a.seed_voxel, expected_seed);
    }
}
