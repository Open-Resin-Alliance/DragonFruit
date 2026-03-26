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
    pub centroid_sum_z: f64,
    pub centroid_count: u64,
    pub centroid: Option<Centroid>,
    pub last_layer_centroid: Option<Centroid>,
    pub seed_voxel: Option<Centroid>,
}

impl Island {
    pub fn new(
        id: IslandId,
        layer: u32,
        area_mm2: f64,
        comp: Option<&ComponentInfo>,
    ) -> Self {
        let (centroid_sum_x, centroid_sum_y, centroid_sum_z, centroid_count, last_layer_centroid) =
            if let Some(c) = comp {
                let count = c.size as u64;
                let llc = if c.size > 0 {
                    Some(Centroid {
                        x: c.centroid_sum_x / c.size as f64,
                        y: c.centroid_sum_y / c.size as f64,
                        z: layer as f64,
                    })
                } else {
                    None
                };
                (
                    c.centroid_sum_x,
                    c.centroid_sum_y,
                    count as f64 * layer as f64,
                    count,
                    llc,
                )
            } else {
                (0.0, 0.0, 0.0, 0, None)
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
            seed_voxel: None,
        }
    }

    /// Update island with new layer data (continuation).
    pub fn update(&mut self, layer: u32, area_mm2: f64, comp: Option<&ComponentInfo>) {
        self.last_layer = layer;
        self.total_area_mm2 += area_mm2;
        self.per_layer_area_mm2.insert(layer, area_mm2);

        if self.max_area_mm2.map_or(true, |m| area_mm2 > m) {
            self.max_area_mm2 = Some(area_mm2);
            self.max_area_layer = Some(layer);
        }

        if let Some(c) = comp {
            self.centroid_sum_x += c.centroid_sum_x;
            self.centroid_sum_y += c.centroid_sum_y;
            self.centroid_sum_z += c.size as f64 * layer as f64;
            self.centroid_count += c.size as u64;

            if c.size > 0 {
                self.last_layer_centroid = Some(Centroid {
                    x: c.centroid_sum_x / c.size as f64,
                    y: c.centroid_sum_y / c.size as f64,
                    z: layer as f64,
                });
            }
        }
    }

    /// Compute final global centroid from accumulators.
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
