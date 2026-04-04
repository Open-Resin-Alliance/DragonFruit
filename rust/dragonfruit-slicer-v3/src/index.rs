//! Layer indexing utilities.
//!
//! The index maps each layer to the subset of triangles that can intersect its
//! slicing plane, reducing per-layer raster work.

use crate::geometry::Triangle;
use std::mem::size_of;

const DEFAULT_LAYER_INDEX_BUDGET_MB: u64 = 768; // Increased budget since IPC chunking prevents peak RAM spike
const MIN_LAYER_INDEX_BUDGET_MB: u64 = 32;
const MAX_BAND_SIZE_LAYERS: u32 = 1024;

#[derive(Debug, Clone)]
pub enum LayerIndex {
    Dense(Vec<Vec<usize>>),
    Banded {
        band_size_layers: u32,
        bands: Vec<Vec<usize>>,
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
fn round_up_pow2_u32(value: u32) -> u32 {
    if value <= 1 {
        return 1;
    }
    value.next_power_of_two()
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

    let required_factor = ((estimated_dense_entries + max_dense_entries - 1) / max_dense_entries)
        .clamp(1, total_layers.max(1) as u64);
    let mut band_size_layers = round_up_pow2_u32(required_factor as u32);
    band_size_layers = band_size_layers.clamp(1, MAX_BAND_SIZE_LAYERS.min(total_layers.max(1)));

    let band_count = ((total_layers + band_size_layers - 1) / band_size_layers) as usize;

    let mut band_sizes = vec![0usize; band_count];
    for range in &ranges {
        if let Some((start, end)) = range {
            let band_start = (*start / band_size_layers) as usize;
            let band_end = (*end / band_size_layers) as usize;
            for band in band_start..=band_end {
                band_sizes[band] += 1;
            }
        }
    }

    let mut bands: Vec<Vec<usize>> = band_sizes
        .into_iter()
        .map(|sz| Vec::with_capacity(sz))
        .collect();

    for (idx, range) in ranges.iter().enumerate() {
        if let Some((start, end)) = range {
            let band_start = (*start / band_size_layers) as usize;
            let band_end = (*end / band_size_layers) as usize;
            for band in band_start..=band_end {
                bands[band].push(idx);
            }
        }
    }

    eprintln!(
        "[SlicerV3] Layer index switched to banded mode: estimated_dense_entries={} max_dense_entries={} band_size_layers={} bands={}",
        estimated_dense_entries,
        max_dense_entries,
        band_size_layers,
        band_count,
    );

    LayerIndex::Banded {
        band_size_layers,
        bands,
    }
}
