//! Semantic diff comparator — compares TS golden output with Rust output.
//!
//! Usage:
//!   cargo run --bin island_diff -- --golden fixtures/island-scan/cube/ --actual fixtures/island-scan/cube/rust-output/

#![allow(dead_code)]

use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// JSON types (matching exporter output format)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RleMaskJson {
    width: i32,
    height: i32,
    rows: Vec<Vec<i32>>,
}

#[derive(Deserialize)]
struct RleLabelsJson {
    width: i32,
    height: i32,
    rows: Vec<Vec<i32>>,
}

#[derive(Deserialize, Debug)]
struct ComponentInfoJson {
    id: i32,
    area_px: i32,
    #[serde(alias = "centroidSumX", alias = "centroid_sum_x")]
    centroid_sum_x: f64,
    #[serde(alias = "centroidSumY", alias = "centroid_sum_y")]
    centroid_sum_y: f64,
}

#[derive(Deserialize, Debug)]
struct IslandJson {
    id: u32,
    #[serde(alias = "firstLayer", alias = "first_layer")]
    first_layer: u32,
    #[serde(alias = "lastLayer", alias = "last_layer")]
    last_layer: u32,
    status: String,
    #[serde(alias = "totalAreaMm2", alias = "total_area_mm2")]
    total_area_mm2: f64,
    #[serde(alias = "parentId", alias = "parent_id")]
    parent_id: Option<u32>,
    #[serde(alias = "childIds", alias = "child_ids")]
    child_ids: Vec<u32>,
    #[serde(alias = "volumeMm3", alias = "volume_mm3")]
    volume_mm3: Option<f64>,
    #[serde(alias = "maxAreaMm2", alias = "max_area_mm2")]
    max_area_mm2: Option<f64>,
    #[serde(alias = "isMergedPlaceholder", alias = "is_merged_placeholder")]
    is_merged_placeholder: Option<bool>,
}

#[derive(Deserialize)]
struct ResultJson {
    num_islands: usize,
    islands: Vec<IslandJson>,
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

struct DiffStats {
    passed: u32,
    failed: u32,
    messages: Vec<String>,
}

impl DiffStats {
    fn new() -> Self {
        Self {
            passed: 0,
            failed: 0,
            messages: Vec::new(),
        }
    }

    fn pass(&mut self, msg: String) {
        self.passed += 1;
        self.messages.push(format!("\x1b[32m  OK\x1b[0m {}", msg));
    }

    fn fail(&mut self, msg: String) {
        self.failed += 1;
        self.messages.push(format!("\x1b[31mFAIL\x1b[0m {}", msg));
    }

    fn print_summary(&self) {
        for msg in &self.messages {
            println!("{}", msg);
        }
        println!();
        if self.failed == 0 {
            println!(
                "\x1b[32mAll {} checks passed!\x1b[0m",
                self.passed
            );
        } else {
            println!(
                "\x1b[31m{} failed\x1b[0m, {} passed",
                self.failed, self.passed
            );
        }
    }
}

fn pixel_count(mask: &RleMaskJson) -> i64 {
    mask.rows
        .iter()
        .flat_map(|row| row.chunks(2))
        .map(|chunk| chunk.get(1).copied().unwrap_or(0) as i64)
        .sum()
}

fn label_pixel_count(labels: &RleLabelsJson) -> i64 {
    labels
        .rows
        .iter()
        .flat_map(|row| row.chunks(3))
        .map(|chunk| chunk.get(1).copied().unwrap_or(0) as i64)
        .sum()
}

fn run_count(mask: &RleMaskJson) -> usize {
    mask.rows.iter().map(|row| row.len() / 2).sum()
}

// ---------------------------------------------------------------------------
// Layer-level comparisons
// ---------------------------------------------------------------------------

fn compare_masks(
    stats: &mut DiffStats,
    layer: u32,
    golden_path: &Path,
    actual_path: &Path,
) {
    let golden: RleMaskJson = match fs::read_to_string(golden_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(m) => m,
        None => return,
    };
    let actual: RleMaskJson = match fs::read_to_string(actual_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(m) => m,
        None => return, // Skip if actual doesn't have this file (stage-dependent)
    };

    let g_px = pixel_count(&golden);
    let a_px = pixel_count(&actual);

    if g_px == a_px {
        stats.pass(format!("Layer {}: mask pixels match ({} px)", layer, g_px));
    } else {
        stats.fail(format!(
            "Layer {}: mask pixel count mismatch (TS: {}, Rust: {})",
            layer, g_px, a_px
        ));
    }
}

fn compare_components(
    stats: &mut DiffStats,
    layer: u32,
    golden_path: &Path,
    actual_path: &Path,
) {
    let golden: Vec<ComponentInfoJson> = match fs::read_to_string(golden_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(c) => c,
        None => return,
    };
    let actual: Vec<ComponentInfoJson> = match fs::read_to_string(actual_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(c) => c,
        None => return, // Skip if actual doesn't have this file
    };

    if golden.len() == actual.len() {
        stats.pass(format!(
            "Layer {}: {} components match",
            layer,
            golden.len()
        ));
    } else {
        stats.fail(format!(
            "Layer {}: component count mismatch (TS: {}, Rust: {})",
            layer,
            golden.len(),
            actual.len()
        ));
    }

    // Compare total area
    let g_area: i32 = golden.iter().map(|c| c.area_px).sum();
    let a_area: i32 = actual.iter().map(|c| c.area_px).sum();
    if g_area == a_area {
        stats.pass(format!(
            "Layer {}: total component area match ({} px)",
            layer, g_area
        ));
    } else {
        stats.fail(format!(
            "Layer {}: total component area mismatch (TS: {}, Rust: {})",
            layer, g_area, a_area
        ));
    }
}

fn compare_island_labels(
    stats: &mut DiffStats,
    layer: u32,
    golden_path: &Path,
    actual_path: &Path,
) {
    let golden: RleLabelsJson = match fs::read_to_string(golden_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(l) => l,
        None => return,
    };
    let actual: RleLabelsJson = match fs::read_to_string(actual_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(l) => l,
        None => return, // Skip if actual doesn't have this file
    };

    let g_px = label_pixel_count(&golden);
    let a_px = label_pixel_count(&actual);

    if g_px == a_px {
        stats.pass(format!(
            "Layer {}: island label pixels match ({} px)",
            layer, g_px
        ));
    } else {
        stats.fail(format!(
            "Layer {}: island label pixel count mismatch (TS: {}, Rust: {})",
            layer, g_px, a_px
        ));
    }
}

// ---------------------------------------------------------------------------
// Result-level comparison
// ---------------------------------------------------------------------------

fn compare_results(stats: &mut DiffStats, golden_path: &Path, actual_path: &Path) {
    let golden: ResultJson = match fs::read_to_string(golden_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(r) => r,
        None => {
            stats.fail("Golden result.json missing or malformed".to_string());
            return;
        }
    };
    let actual: ResultJson = match fs::read_to_string(actual_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(r) => r,
        None => {
            stats.fail("Actual result.json missing or malformed".to_string());
            return;
        }
    };

    if golden.num_islands == actual.num_islands {
        stats.pass(format!(
            "Island count match: {}",
            golden.num_islands
        ));
    } else {
        stats.fail(format!(
            "Island count mismatch (TS: {}, Rust: {})",
            golden.num_islands, actual.num_islands
        ));
    }

    // Build maps by sorted position (can't compare IDs directly since they may differ)
    let mut g_sorted: Vec<&IslandJson> = golden.islands.iter().collect();
    let mut a_sorted: Vec<&IslandJson> = actual.islands.iter().collect();
    g_sorted.sort_by_key(|i| (i.first_layer, i.id));
    a_sorted.sort_by_key(|i| (i.first_layer, i.id));

    let n = g_sorted.len().min(a_sorted.len());
    for idx in 0..n {
        let gi = g_sorted[idx];
        let ai = a_sorted[idx];

        // Layer range
        if gi.first_layer == ai.first_layer && gi.last_layer == ai.last_layer {
            stats.pass(format!(
                "Island {} (TS #{} / Rust #{}): layers {}-{} match",
                idx, gi.id, ai.id, gi.first_layer, gi.last_layer
            ));
        } else {
            stats.fail(format!(
                "Island {} layer range mismatch (TS: {}-{}, Rust: {}-{})",
                idx, gi.first_layer, gi.last_layer, ai.first_layer, ai.last_layer
            ));
        }

        // Total area (within tolerance)
        let area_diff = (gi.total_area_mm2 - ai.total_area_mm2).abs();
        let tolerance = gi.total_area_mm2.abs() * 0.001 + 1e-9;
        if area_diff <= tolerance {
            stats.pass(format!(
                "Island {}: totalAreaMm2 match ({:.6})",
                idx, gi.total_area_mm2
            ));
        } else {
            stats.fail(format!(
                "Island {}: totalAreaMm2 mismatch (TS: {:.6}, Rust: {:.6}, diff: {:.6})",
                idx, gi.total_area_mm2, ai.total_area_mm2, area_diff
            ));
        }

        // Volume (within tolerance)
        if let (Some(gv), Some(av)) = (gi.volume_mm3, ai.volume_mm3) {
            let vdiff = (gv - av).abs();
            let vtol = gv.abs() * 0.001 + 1e-9;
            if vdiff <= vtol {
                stats.pass(format!("Island {}: volumeMm3 match ({:.6})", idx, gv));
            } else {
                stats.fail(format!(
                    "Island {}: volumeMm3 mismatch (TS: {:.6}, Rust: {:.6})",
                    idx, gv, av
                ));
            }
        }

        // Status
        if gi.status == ai.status {
            stats.pass(format!("Island {}: status match ({})", idx, gi.status));
        } else {
            stats.fail(format!(
                "Island {}: status mismatch (TS: {}, Rust: {})",
                idx, gi.status, ai.status
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut golden_dir = PathBuf::new();
    let mut actual_dir = PathBuf::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--golden" => {
                i += 1;
                golden_dir = PathBuf::from(&args[i]);
            }
            "--actual" => {
                i += 1;
                actual_dir = PathBuf::from(&args[i]);
            }
            _ => {}
        }
        i += 1;
    }

    if golden_dir.as_os_str().is_empty() || actual_dir.as_os_str().is_empty() {
        eprintln!("Usage: island_diff --golden <dir> --actual <dir>");
        std::process::exit(1);
    }

    println!("Golden: {}", golden_dir.display());
    println!("Actual: {}", actual_dir.display());
    println!();

    let mut stats = DiffStats::new();

    // Read input.json to determine layer count
    let input_path = golden_dir.join("input.json");
    #[derive(Deserialize)]
    struct InputJson {
        num_layers: u32,
    }
    let input: InputJson =
        serde_json::from_str(&fs::read_to_string(&input_path).unwrap()).unwrap();

    // Compare per-layer data
    for l in 0..input.num_layers {
        let pad = format!("{:03}", l);

        compare_masks(
            &mut stats,
            l,
            &golden_dir.join("layers").join(format!("{}-mask.rle.json", pad)),
            &actual_dir.join("layers").join(format!("{}-mask.rle.json", pad)),
        );

        compare_components(
            &mut stats,
            l,
            &golden_dir.join("layers").join(format!("{}-components.json", pad)),
            &actual_dir.join("layers").join(format!("{}-components.json", pad)),
        );

        compare_island_labels(
            &mut stats,
            l,
            &golden_dir.join("layers").join(format!("{}-island-labels.rle.json", pad)),
            &actual_dir.join("layers").join(format!("{}-island-labels.rle.json", pad)),
        );
    }

    // Compare final results
    compare_results(
        &mut stats,
        &golden_dir.join("result.json"),
        &actual_dir.join("result.json"),
    );

    println!();
    stats.print_summary();

    if stats.failed > 0 {
        std::process::exit(1);
    }
}
