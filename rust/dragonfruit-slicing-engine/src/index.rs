//! Layer indexing utilities.
//!
//! The index maps each layer to the subset of triangles that can intersect its
//! slicing plane, reducing per-layer raster work.

use crate::geometry::Triangle;
use std::mem::size_of;

const DEFAULT_LAYER_INDEX_BUDGET_MB: u64 = 768; // Increased budget since IPC chunking prevents peak RAM spike
const MIN_LAYER_INDEX_BUDGET_MB: u64 = 32;

/// Fixed bin count for the ZBins index variant.
const ZBIN_COUNT: usize = 256;

#[derive(Debug, Clone)]
pub enum LayerIndex {
    Dense(Vec<Vec<usize>>),
    Banded {
        band_size_layers: u32,
        bands: Vec<Vec<usize>>,
    },
    /// Spatially-bucketed index: fixed Z-bins over the model extent.
    ///
    /// Used as fallback when Dense would exceed the memory budget.
    /// Uses O(triangles × avg_bins_per_triangle) memory regardless of
    /// total_layers, and is strictly better than Banded for tall models.
    ZBins {
        z_min: f32,
        bin_height: f32,
        layer_height_mm: f32,
        bins: Vec<Vec<usize>>,
    },
}

impl LayerIndex {
    #[inline]
    pub fn candidates_for_layer(&self, layer: u32) -> &[usize] {
        match self {
            LayerIndex::Dense(buckets) => buckets
                .get(layer as usize)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            LayerIndex::Banded {
                band_size_layers,
                bands,
            } => {
                let band = (layer / *band_size_layers) as usize;
                bands.get(band).map(Vec::as_slice).unwrap_or(&[])
            }
            LayerIndex::ZBins {
                z_min,
                bin_height,
                layer_height_mm,
                bins,
            } => {
                let center_z = (layer as f32 + 0.5) * layer_height_mm;
                let bin = ((center_z - z_min) / bin_height)
                    .floor()
                    .clamp(0.0, (bins.len().saturating_sub(1)) as f32)
                    as usize;
                bins.get(bin).map(Vec::as_slice).unwrap_or(&[])
            }
        }
    }
}

fn resolve_layer_index_budget_bytes() -> u64 {
    let mb = std::env::var("DF_V3_LAYER_INDEX_BUDGET_MB")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v >= MIN_LAYER_INDEX_BUDGET_MB)
        .unwrap_or(DEFAULT_LAYER_INDEX_BUDGET_MB);

    mb.saturating_mul(1024 * 1024)
}

#[inline]
fn layer_range_for_triangle(
    tri: &Triangle,
    layer_height_mm: f32,
    total_layers: u32,
) -> Option<(u32, u32)> {
    if total_layers == 0 {
        return None;
    }
    let last = (total_layers as i32) - 1;
    let start = ((tri.z_min / layer_height_mm) - 0.5).ceil() as i32;
    let end = ((tri.z_max / layer_height_mm) - 0.5).floor() as i32;
    if end < 0 || start > last {
        return None;
    }
    let clamped_start = start.clamp(0, last) as u32;
    let clamped_end = end.clamp(0, last) as u32;
    if clamped_end < clamped_start {
        None
    } else {
        Some((clamped_start, clamped_end))
    }
}

/// Build a per-layer triangle lookup table using z-range overlap.
pub fn build_layer_index(
    triangles: &[Triangle],
    total_layers: u32,
    layer_height_mm: f32,
) -> LayerIndex {
    let mut ranges = Vec::<Option<(u32, u32)>>::with_capacity(triangles.len());
    let mut estimated_dense_entries = 0u64;

    for tri in triangles {
        if let Some((start, end)) = layer_range_for_triangle(tri, layer_height_mm, total_layers) {
            estimated_dense_entries = estimated_dense_entries
                .saturating_add((end.saturating_sub(start).saturating_add(1)) as u64);
            ranges.push(Some((start, end)));
        } else {
            ranges.push(None);
        }
    }

    let budget_bytes = resolve_layer_index_budget_bytes();
    let bytes_per_entry = (size_of::<usize>() as u64).max(1);
    let max_dense_entries = (budget_bytes / bytes_per_entry).max(1);

    if estimated_dense_entries <= max_dense_entries {
        let mut bucket_sizes = vec![0usize; total_layers as usize];
        for range in &ranges {
            if let Some((start, end)) = range {
                for l in *start..=*end {
                    bucket_sizes[l as usize] += 1;
                }
            }
        }

        let mut buckets: Vec<Vec<usize>> = bucket_sizes
            .into_iter()
            .map(|sz| Vec::with_capacity(sz))
            .collect();

        for (idx, range) in ranges.iter().enumerate() {
            if let Some((start, end)) = range {
                for l in *start..=*end {
                    buckets[l as usize].push(idx);
                }
            }
        }

        return LayerIndex::Dense(buckets);
    }

    build_zbin_index_from_ranges(
        triangles,
        layer_height_mm,
        estimated_dense_entries,
        max_dense_entries,
    )
}

/// Build a Z-bin spatial index as a memory-efficient fallback when Dense is too large.
fn build_zbin_index_from_ranges(
    triangles: &[Triangle],
    layer_height_mm: f32,
    estimated_dense_entries: u64,
    max_dense_entries: u64,
) -> LayerIndex {
    let z_min_model = triangles
        .iter()
        .map(|t| t.z_min)
        .fold(f32::INFINITY, f32::min);
    let z_max_model = triangles
        .iter()
        .map(|t| t.z_max)
        .fold(f32::NEG_INFINITY, f32::max);
    let z_range = (z_max_model - z_min_model).max(layer_height_mm);
    let bin_height = z_range / (ZBIN_COUNT as f32);

    let mut bin_sizes = vec![0usize; ZBIN_COUNT];
    for tri in triangles.iter() {
        let b_start = ((tri.z_min - z_min_model) / bin_height)
            .floor()
            .clamp(0.0, (ZBIN_COUNT - 1) as f32) as usize;
        let b_end = ((tri.z_max - z_min_model) / bin_height)
            .floor()
            .clamp(0.0, (ZBIN_COUNT - 1) as f32) as usize;
        for b in b_start..=b_end {
            bin_sizes[b] += 1;
        }
    }

    let mut bins: Vec<Vec<usize>> = bin_sizes
        .into_iter()
        .map(|sz| Vec::with_capacity(sz))
        .collect();

    for (idx, tri) in triangles.iter().enumerate() {
        let b_start = ((tri.z_min - z_min_model) / bin_height)
            .floor()
            .clamp(0.0, (ZBIN_COUNT - 1) as f32) as usize;
        let b_end = ((tri.z_max - z_min_model) / bin_height)
            .floor()
            .clamp(0.0, (ZBIN_COUNT - 1) as f32) as usize;
        for b in b_start..=b_end {
            bins[b].push(idx);
        }
    }

    eprintln!(
        "[SlicerV3] Layer index switched to ZBins mode: estimated_dense_entries={} max_dense_entries={} bins={} bin_height_mm={:.4}",
        estimated_dense_entries,
        max_dense_entries,
        ZBIN_COUNT,
        bin_height,
    );

    LayerIndex::ZBins {
        z_min: z_min_model,
        bin_height,
        layer_height_mm,
        bins,
    }
}
