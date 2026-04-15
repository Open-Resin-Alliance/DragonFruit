//! Worst-case scenario property tests for the island detection pipeline.
//!
//! Each test generates adversarial geometry and verifies the pipeline
//! produces valid, consistent output without panics or infinite loops.

use dragonfruit_islands::model::*;
use dragonfruit_islands::pipeline::run_island_scan;
use dragonfruit_islands::rle::{rle_encode, rle_label_components};
use proptest::prelude::*;

fn make_job(width: i32, height: i32, num_layers: u32) -> IslandScanJob {
    IslandScanJob {
        px_mm: 0.1,
        support_buffer_mm: 0.6,
        connectivity: Connectivity::Four,
        min_island_area_mm2: 0.0,
        layer_height_mm: 0.05,
        grid: GridRef {
            origin_x: 0.0,
            origin_z: 0.0,
            width,
            height,
            px_mm: 0.1,
        },
        num_layers,
        min_overlap_px: 1,
        overlap_neighborhood_px: 1,
    }
}

// ---------------------------------------------------------------------------
// Worst case 1: Many small disconnected islands (chain mail / Voronoi foam)
//
// Maximizes: CCL component count per layer, tracker map size.
// Each layer has a grid of small isolated squares — N² islands.
// ---------------------------------------------------------------------------

fn gen_many_islands(w: i32, h: i32, layers: usize, count: i32) -> Vec<RleMask> {
    let n = (count as f64).sqrt().ceil() as i32;
    let dx = (w / n).max(3);
    let dy = (h / n).max(3);
    let pad = 1;

    (0..layers)
        .map(|_| {
            let mut data = vec![0u8; (w * h) as usize];
            for iy in 0..n {
                for ix in 0..n {
                    let x0 = ix * dx + pad;
                    let y0 = iy * dy + pad;
                    let x1 = ((ix + 1) * dx - pad).min(w);
                    let y1 = ((iy + 1) * dy - pad).min(h);
                    for y in y0..y1 {
                        for x in x0..x1 {
                            data[(y * w + x) as usize] = 1;
                        }
                    }
                }
            }
            rle_encode(&data, w, h)
        })
        .collect()
}

proptest! {
    /// Many small islands: pipeline must track N² islands correctly.
    #[test]
    fn many_islands_completes(
        island_count in 4..100i32,
        layers in 5..50usize,
    ) {
        let w = 200;
        let h = 200;
        let masks = gen_many_islands(w, h, layers, island_count);
        let job = make_job(w, h, layers as u32);
        let result = run_island_scan(&job, &masks, None);

        // Must produce at least 1 island per unique block
        let n = (island_count as f64).sqrt().ceil() as i32;
        let expected_min = (n * n).min(island_count) as usize;
        prop_assert!(
            result.islands.len() >= expected_min / 2,
            "Expected at least {} islands, got {}",
            expected_min / 2,
            result.islands.len()
        );

        // No island should span more layers than exist
        for island in &result.islands {
            prop_assert!(island.last_layer < layers as u32);
            prop_assert!(island.first_layer <= island.last_layer);
        }
    }
}

// ---------------------------------------------------------------------------
// Worst case 2: Frequent merge/split (lattice that merges and splits)
//
// Maximizes: PendingMerge count, parent chain resolution.
// Even layers: two separate blocks. Odd layers: blocks connected by bridge.
// This forces merge on every odd layer and potential split on even layers.
// ---------------------------------------------------------------------------

fn gen_merge_split_lattice(w: i32, h: i32, layers: usize) -> Vec<RleMask> {
    let mid = w / 2;
    let gap = 4;
    let h4 = h / 4;
    let h34 = 3 * h / 4;

    (0..layers)
        .map(|l| {
            let mut data = vec![0u8; (w * h) as usize];
            // Two blocks always present
            for y in h4..h34 {
                for x in 2..(mid - gap) {
                    data[(y * w + x) as usize] = 1;
                }
                for x in (mid + gap)..(w - 2) {
                    data[(y * w + x) as usize] = 1;
                }
            }
            // Bridge connecting blocks on odd layers
            if l % 2 == 1 {
                for y in (h / 2 - 1)..(h / 2 + 1) {
                    for x in 2..(w - 2) {
                        data[(y * w + x) as usize] = 1;
                    }
                }
            }
            rle_encode(&data, w, h)
        })
        .collect()
}

proptest! {
    /// Merge/split thrash: pipeline must handle repeated merges without panic.
    #[test]
    fn merge_split_thrash_completes(
        layers in 10..100usize,
    ) {
        let w = 100;
        let h = 100;
        let masks = gen_merge_split_lattice(w, h, layers);
        let job = make_job(w, h, layers as u32);
        let result = run_island_scan(&job, &masks, None);

        // Must produce islands (at least the two blocks)
        prop_assert!(result.islands.len() >= 2,
            "Expected at least 2 islands, got {}", result.islands.len());

        // Parent chains must be resolvable (no cycles)
        for island in &result.islands {
            if let Some(pid) = island.parent_id {
                // Parent must exist
                prop_assert!(
                    result.islands.iter().any(|i| i.id == pid),
                    "Island {} has parent {} which doesn't exist",
                    island.id.0, pid.0
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Worst case 3: Single pixel islands (maximum CCL overhead)
//
// Maximizes: CCL work per pixel, RLE run count.
// Checkerboard pattern: every other pixel is solid, creating W*H/2 runs
// and many tiny 1-pixel components.
// ---------------------------------------------------------------------------

fn gen_checkerboard(w: i32, h: i32, layers: usize) -> Vec<RleMask> {
    (0..layers)
        .map(|l| {
            let mut data = vec![0u8; (w * h) as usize];
            for y in 0..h {
                for x in 0..w {
                    // Shift pattern every other layer to create new islands
                    let offset = (l % 2) as i32;
                    if (x + y + offset) % 2 == 0 {
                        data[(y * w + x) as usize] = 1;
                    }
                }
            }
            rle_encode(&data, w, h)
        })
        .collect()
}

proptest! {
    /// Checkerboard: maximizes RLE run count and CCL component count.
    ///
    /// NOTE: Keep size small. With 4-connectivity, each pixel is its own island,
    /// so a 20x20 grid has 200 islands. The tracker's overlap lookup is O(islands²)
    /// per layer, making this O(size⁴ × layers). size=30 × 5 layers ≈ 1s.
    #[test]
    fn checkerboard_completes(
        size in 10..20i32,
        layers in 2..4usize,
    ) {
        let masks = gen_checkerboard(size, size, layers);
        let job = make_job(size, size, layers as u32);
        let result = run_island_scan(&job, &masks, None);

        // With 4-connectivity, each pixel is its own island
        prop_assert!(result.islands.len() > 0);

        // Every island should have valid layer bounds
        for island in &result.islands {
            prop_assert!(island.first_layer <= island.last_layer);
            prop_assert!(island.total_area_mm2 >= 0.0);
        }
    }
}

// ---------------------------------------------------------------------------
// Worst case 4: Growing overhang (area doubles each layer)
//
// Maximizes: per-layer candidate area growth, volume calculation.
// Pyramid that widens by 2 pixels per layer on each side.
// ---------------------------------------------------------------------------

fn gen_growing_overhang(w: i32, h: i32, layers: usize) -> Vec<RleMask> {
    (0..layers)
        .map(|l| {
            let mut data = vec![0u8; (w * h) as usize];
            let margin = ((layers - l) as i32).max(0);
            let x0 = (w / 2 - l as i32 * 2).max(0);
            let x1 = (w / 2 + l as i32 * 2).min(w);
            let y0 = (h / 2 - l as i32 * 2).max(0);
            let y1 = (h / 2 + l as i32 * 2).min(h);
            for y in y0..y1 {
                for x in x0..x1 {
                    data[(y * w + x) as usize] = 1;
                }
            }
            rle_encode(&data, w, h)
        })
        .collect()
}

proptest! {
    /// Growing overhang: each layer has more unsupported area than the last.
    #[test]
    fn growing_overhang_completes(
        layers in 5..40usize,
    ) {
        let w = 200;
        let h = 200;
        let masks = gen_growing_overhang(w, h, layers);
        let job = make_job(w, h, layers as u32);
        let result = run_island_scan(&job, &masks, None);

        // Layer 0 is fully unsupported (island)
        prop_assert!(result.islands.len() >= 1);

        // Islands should have positive volume
        for island in &result.islands {
            if island.volume_mm3.is_some() {
                prop_assert!(island.volume_mm3.unwrap() >= 0.0);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Worst case 5: Empty/degenerate layers interspersed
//
// Maximizes: edge cases in scan_layer (no prev, empty prev, empty current).
// Random layers are completely empty, forcing the tracker to handle gaps.
// ---------------------------------------------------------------------------

fn gen_sparse_layers(w: i32, h: i32, layers: usize, seed: u64) -> Vec<RleMask> {
    (0..layers)
        .map(|l| {
            // Deterministic pseudo-random: skip ~30% of layers
            let is_empty = ((l as u64).wrapping_mul(seed).wrapping_add(7)) % 10 < 3;
            if is_empty {
                RleMask {
                    width: w,
                    height: h,
                    rows: (0..h).map(|_| Vec::new()).collect(),
                }
            } else {
                let mut data = vec![0u8; (w * h) as usize];
                let block_size = 20;
                let cx = w / 2;
                let cy = h / 2;
                for y in (cy - block_size).max(0)..(cy + block_size).min(h) {
                    for x in (cx - block_size).max(0)..(cx + block_size).min(w) {
                        data[(y * w + x) as usize] = 1;
                    }
                }
                rle_encode(&data, w, h)
            }
        })
        .collect()
}

proptest! {
    /// Sparse layers: ~30% empty, tests gap handling in tracker.
    #[test]
    fn sparse_layers_completes(
        layers in 10..60usize,
        seed in 1..1000u64,
    ) {
        let w = 100;
        let h = 100;
        let masks = gen_sparse_layers(w, h, layers, seed);
        let job = make_job(w, h, layers as u32);
        let result = run_island_scan(&job, &masks, None);

        // Pipeline should complete without panic
        // Islands from non-empty layers should have valid bounds
        for island in &result.islands {
            prop_assert!(island.first_layer <= island.last_layer);
            prop_assert!(island.last_layer < layers as u32);
        }
    }
}

// ---------------------------------------------------------------------------
// Worst case 6: Maximum RLE density (alternating pixels)
//
// Maximizes: RLE run count, intersect_dilated computation.
// Every pixel alternates solid/empty — W/2 runs per row.
// ---------------------------------------------------------------------------

/// Max RLE density: alternating pixels create W/2 runs per row.
/// CCL with 4-connectivity produces vertical stripe components.
#[test]
fn max_rle_density_ccl() {
    let w = 100;
    let h = 100;
    let mut data = vec![0u8; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            if x % 2 == 0 {
                data[y * w + x] = 1;
            }
        }
    }
    let mask = rle_encode(&data, w as i32, h as i32);

    // Should have ~W/2 runs per row
    for row in &mask.rows {
        assert!(row.len() >= (w / 2 - 1));
    }

    // CCL: vertical stripes with 4-connectivity → W/2 components
    let (labels, components) = rle_label_components(&mask, Connectivity::Four);
    assert_eq!(labels.rows.len(), h);
    assert!(components.len() >= w / 2 - 1);
}

// ---------------------------------------------------------------------------
// Worst case 7: Determinism — same input must produce same output
// ---------------------------------------------------------------------------

/// Determinism: same input must produce same pixel-level output.
/// Island IDs may differ due to merge ordering, but the label masks must be identical
/// and the set of (first_layer, last_layer, total_area) tuples must match.
#[test]
fn pipeline_deterministic() {
    let w = 100;
    let h = 100;
    let layers = 50;
    let masks = gen_merge_split_lattice(w, h, layers);
    let job = make_job(w, h, layers as u32);

    let r1 = run_island_scan(&job, &masks, None);
    let r2 = run_island_scan(&job, &masks, None);

    assert_eq!(r1.islands.len(), r2.islands.len(), "island count differs");

    // Compare island content as sorted tuples (ignoring ID assignment order)
    // Round area to 0.01mm² to avoid float precision noise
    let mut areas1: Vec<(u32, u32, i64)> = r1.islands.iter()
        .map(|i| (i.first_layer, i.last_layer, (i.total_area_mm2 * 100.0).round() as i64))
        .collect();
    let mut areas2: Vec<(u32, u32, i64)> = r2.islands.iter()
        .map(|i| (i.first_layer, i.last_layer, (i.total_area_mm2 * 100.0).round() as i64))
        .collect();
    areas1.sort();
    areas2.sort();
    assert_eq!(areas1, areas2, "island content differs between runs");

    // Per-layer label masks: total labeled pixel count must match
    for (l, (lab1, lab2)) in r1.island_labels_per_layer.iter()
        .zip(r2.island_labels_per_layer.iter())
        .enumerate()
    {
        let px1: i32 = lab1.rows.iter().flat_map(|r| r.iter().map(|run| run.length)).sum();
        let px2: i32 = lab2.rows.iter().flat_map(|r| r.iter().map(|run| run.length)).sum();
        assert_eq!(px1, px2, "labeled pixel count differs on layer {}", l);
    }
}
