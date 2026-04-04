//! Rust CLI Test Harness — reads golden fixtures, runs island detection, dumps output.
//!
//! Usage:
//!   cargo run --bin island_harness -- --fixture fixtures/island-scan/cube/ --stage full --output fixtures/island-scan/cube/rust-output/

use dragonfruit_islands::model::*;
use dragonfruit_islands::pipeline::run_island_scan;
use dragonfruit_islands::rle::rle_label_components;
use dragonfruit_islands::scan::scan_layer;
use dragonfruit_islands::tracker::IslandTracker;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// JSON schema types matching the TS exporter output
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct InputJson {
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: u8,
    layer_height_mm: f64,
    width: i32,
    height: i32,
    num_layers: u32,
    min_overlap_px: Option<i32>,
    overlap_neighborhood_px: Option<i32>,
}

/// Flat JSON representation of RleMask (rows as Vec<Vec<i32>>)
#[derive(Deserialize, Serialize)]
struct RleMaskJson {
    width: i32,
    height: i32,
    rows: Vec<Vec<i32>>,
}

/// Flat JSON representation of RleLabels
#[derive(Deserialize, Serialize)]
struct RleLabelsJson {
    width: i32,
    height: i32,
    rows: Vec<Vec<i32>>,
}

#[derive(Serialize)]
struct IslandJson {
    id: u32,
    #[serde(rename = "firstLayer")]
    first_layer: u32,
    #[serde(rename = "lastLayer")]
    last_layer: u32,
    status: String,
    #[serde(rename = "totalAreaMm2")]
    total_area_mm2: f64,
    #[serde(rename = "perLayerAreaMm2")]
    per_layer_area_mm2: HashMap<String, f64>,
    #[serde(rename = "parentId")]
    parent_id: Option<u32>,
    #[serde(rename = "childIds")]
    child_ids: Vec<u32>,
    #[serde(rename = "volumeMm3")]
    volume_mm3: Option<f64>,
    #[serde(rename = "maxAreaMm2")]
    max_area_mm2: Option<f64>,
    #[serde(rename = "maxAreaLayer")]
    max_area_layer: Option<u32>,
    #[serde(rename = "isMergedPlaceholder")]
    is_merged_placeholder: bool,
    #[serde(rename = "centroidSumX")]
    centroid_sum_x: f64,
    #[serde(rename = "centroidSumY")]
    centroid_sum_y: f64,
    #[serde(rename = "centroidSumZ")]
    centroid_sum_z: f64,
    #[serde(rename = "centroidCount")]
    centroid_count: u64,
    centroid: Option<CentroidJson>,
    #[serde(rename = "lastLayerCentroid")]
    last_layer_centroid: Option<CentroidJson>,
}

#[derive(Serialize)]
struct CentroidJson {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Serialize)]
struct ResultJson {
    num_islands: usize,
    islands: Vec<IslandJson>,
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

fn json_to_rle_mask(j: &RleMaskJson) -> RleMask {
    let mut rows = Vec::with_capacity(j.height as usize);
    for flat in &j.rows {
        let mut row = Vec::new();
        let mut i = 0;
        while i + 1 < flat.len() {
            row.push(RleRun {
                start: flat[i],
                length: flat[i + 1],
            });
            i += 2;
        }
        rows.push(row);
    }
    RleMask {
        rows,
        width: j.width,
        height: j.height,
    }
}

fn rle_mask_to_json(m: &RleMask) -> RleMaskJson {
    RleMaskJson {
        width: m.width,
        height: m.height,
        rows: m
            .rows
            .iter()
            .map(|row| {
                let mut flat = Vec::new();
                for r in row {
                    flat.push(r.start);
                    flat.push(r.length);
                }
                flat
            })
            .collect(),
    }
}

fn rle_labels_to_json(l: &RleLabels) -> RleLabelsJson {
    RleLabelsJson {
        width: l.width,
        height: l.height,
        rows: l
            .rows
            .iter()
            .map(|row| {
                let mut flat = Vec::new();
                for r in row {
                    flat.push(r.start);
                    flat.push(r.length);
                    flat.push(r.id);
                }
                flat
            })
            .collect(),
    }
}

fn island_to_json(island: &Island) -> IslandJson {
    IslandJson {
        id: island.id.0,
        first_layer: island.first_layer,
        last_layer: island.last_layer,
        status: match island.status {
            IslandStatus::Active => "active".into(),
            IslandStatus::Complete => "complete".into(),
        },
        total_area_mm2: island.total_area_mm2,
        per_layer_area_mm2: island
            .per_layer_area_mm2
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect(),
        parent_id: island.parent_id.map(|id| id.0),
        child_ids: island.child_ids.iter().map(|id| id.0).collect(),
        volume_mm3: island.volume_mm3,
        max_area_mm2: island.max_area_mm2,
        max_area_layer: island.max_area_layer,
        is_merged_placeholder: island.is_merged_placeholder,
        centroid_sum_x: island.centroid_sum_x,
        centroid_sum_y: island.centroid_sum_y,
        centroid_sum_z: island.centroid_sum_z,
        centroid_count: island.centroid_count,
        centroid: island.centroid.map(|c| CentroidJson {
            x: c.x,
            y: c.y,
            z: c.z,
        }),
        last_layer_centroid: island.last_layer_centroid.map(|c| CentroidJson {
            x: c.x,
            y: c.y,
            z: c.z,
        }),
    }
}

// ---------------------------------------------------------------------------
// Stage runners
// ---------------------------------------------------------------------------

fn run_stage_rle(fixture_dir: &Path, output_dir: &Path, input: &InputJson) {
    println!("Running stage: rle");
    fs::create_dir_all(output_dir.join("layers")).unwrap();

    for l in 0..input.num_layers {
        let pad = format!("{:03}", l);
        let mask_path = fixture_dir.join("layers").join(format!("{}-mask.rle.json", pad));
        if !mask_path.exists() {
            continue;
        }

        let mask_json: RleMaskJson =
            serde_json::from_str(&fs::read_to_string(&mask_path).unwrap()).unwrap();
        let mask = json_to_rle_mask(&mask_json);

        // Re-encode to verify roundtrip
        let re_encoded = rle_mask_to_json(&mask);
        fs::write(
            output_dir.join("layers").join(format!("{}-mask.rle.json", pad)),
            serde_json::to_string_pretty(&re_encoded).unwrap(),
        )
        .unwrap();

        // Test label components
        let conn = if input.connectivity == 8 {
            Connectivity::Eight
        } else {
            Connectivity::Four
        };
        let (labels, components) = rle_label_components(&mask, conn);

        fs::write(
            output_dir.join("layers").join(format!("{}-candidates.rle.json", pad)),
            serde_json::to_string_pretty(&rle_labels_to_json(&labels)).unwrap(),
        )
        .unwrap();
        fs::write(
            output_dir.join("layers").join(format!("{}-components.json", pad)),
            serde_json::to_string_pretty(&components).unwrap(),
        )
        .unwrap();
    }
}

fn run_stage_scan(fixture_dir: &Path, output_dir: &Path, input: &InputJson) {
    println!("Running stage: scan");
    fs::create_dir_all(output_dir.join("layers")).unwrap();

    let conn = if input.connectivity == 8 {
        Connectivity::Eight
    } else {
        Connectivity::Four
    };

    let mut prev_mask: Option<RleMask> = None;

    for l in 0..input.num_layers {
        let pad = format!("{:03}", l);
        let mask_path = fixture_dir.join("layers").join(format!("{}-mask.rle.json", pad));
        if !mask_path.exists() {
            continue;
        }

        let mask_json: RleMaskJson =
            serde_json::from_str(&fs::read_to_string(&mask_path).unwrap()).unwrap();
        let mask = json_to_rle_mask(&mask_json);

        let result = scan_layer(
            &mask,
            prev_mask.as_ref(),
            input.px_mm,
            input.support_buffer_mm,
            conn,
        );

        fs::write(
            output_dir.join("layers").join(format!("{}-candidates.rle.json", pad)),
            serde_json::to_string_pretty(&rle_labels_to_json(&result.labels)).unwrap(),
        )
        .unwrap();
        fs::write(
            output_dir.join("layers").join(format!("{}-components.json", pad)),
            serde_json::to_string_pretty(&result.components).unwrap(),
        )
        .unwrap();

        prev_mask = Some(mask);
    }
}

fn run_stage_tracker(fixture_dir: &Path, output_dir: &Path, input: &InputJson) {
    println!("Running stage: tracker");
    fs::create_dir_all(output_dir.join("layers")).unwrap();
    fs::create_dir_all(output_dir.join("tracker-state")).unwrap();

    let conn = if input.connectivity == 8 {
        Connectivity::Eight
    } else {
        Connectivity::Four
    };

    // Load all masks first
    let mut masks = Vec::new();
    for l in 0..input.num_layers {
        let pad = format!("{:03}", l);
        let mask_path = fixture_dir.join("layers").join(format!("{}-mask.rle.json", pad));
        let mask_json: RleMaskJson =
            serde_json::from_str(&fs::read_to_string(&mask_path).unwrap()).unwrap();
        masks.push(json_to_rle_mask(&mask_json));
    }

    // Phase 1: Per-layer scan
    let mut layer_results = Vec::new();
    for (i, mask) in masks.iter().enumerate() {
        let prev = if i > 0 { Some(&masks[i - 1]) } else { None };
        layer_results.push(scan_layer(mask, prev, input.px_mm, input.support_buffer_mm, conn));
    }

    // Phase 2: Island tracking
    let mut tracker = IslandTracker::new(
        input.px_mm,
        input.min_overlap_px.unwrap_or(1),
        input.overlap_neighborhood_px.unwrap_or(1),
    );
    let mut island_labels_per_layer: Vec<RleLabels> = Vec::new();

    for (l, lr) in layer_results.iter().enumerate() {
        let prev_labels = if l > 0 {
            Some(&island_labels_per_layer[l - 1])
        } else {
            None
        };

        let island_labels =
            tracker.process_layer(l as u32, &lr.labels, &lr.components, prev_labels, &lr.solid_mask);

        let pad = format!("{:03}", l);
        fs::write(
            output_dir.join("layers").join(format!("{}-island-labels.rle.json", pad)),
            serde_json::to_string_pretty(&rle_labels_to_json(&island_labels)).unwrap(),
        )
        .unwrap();

        island_labels_per_layer.push(island_labels);

        // Snapshot tracker state
        let islands = tracker.get_islands();
        let islands_json: Vec<IslandJson> = islands.iter().map(|i| island_to_json(i)).collect();
        fs::write(
            output_dir.join("tracker-state").join(format!("{}-islands.json", pad)),
            serde_json::to_string_pretty(&islands_json).unwrap(),
        )
        .unwrap();
    }

    // Final result
    let islands = tracker.get_islands();
    let result = ResultJson {
        num_islands: islands.len(),
        islands: islands.iter().map(|i| island_to_json(i)).collect(),
    };
    fs::write(
        output_dir.join("result.json"),
        serde_json::to_string_pretty(&result).unwrap(),
    )
    .unwrap();
}

fn run_stage_full(fixture_dir: &Path, output_dir: &Path, input: &InputJson) {
    println!("Running stage: full");
    fs::create_dir_all(output_dir.join("layers")).unwrap();

    let conn = if input.connectivity == 8 {
        Connectivity::Eight
    } else {
        Connectivity::Four
    };

    // Load all masks
    let mut masks = Vec::new();
    for l in 0..input.num_layers {
        let pad = format!("{:03}", l);
        let mask_path = fixture_dir.join("layers").join(format!("{}-mask.rle.json", pad));
        let mask_json: RleMaskJson =
            serde_json::from_str(&fs::read_to_string(&mask_path).unwrap()).unwrap();
        masks.push(json_to_rle_mask(&mask_json));
    }

    let job = IslandScanJob {
        px_mm: input.px_mm,
        support_buffer_mm: input.support_buffer_mm,
        connectivity: conn,
        min_island_area_mm2: 0.0001,
        layer_height_mm: input.layer_height_mm,
        grid: GridRef {
            origin_x: 0.0,
            origin_z: 0.0,
            width: input.width,
            height: input.height,
            px_mm: input.px_mm,
        },
        num_layers: input.num_layers,
        min_overlap_px: input.min_overlap_px.unwrap_or(1),
        overlap_neighborhood_px: input.overlap_neighborhood_px.unwrap_or(1),
    };

    let result = run_island_scan(&job, &masks, None);

    // Write island labels per layer
    for (l, labels) in result.island_labels_per_layer.iter().enumerate() {
        let pad = format!("{:03}", l);
        fs::write(
            output_dir.join("layers").join(format!("{}-island-labels.rle.json", pad)),
            serde_json::to_string_pretty(&rle_labels_to_json(labels)).unwrap(),
        )
        .unwrap();
    }

    // Write final result
    let result_json = ResultJson {
        num_islands: result.islands.len(),
        islands: result.islands.iter().map(|i| island_to_json(i)).collect(),
    };
    fs::write(
        output_dir.join("result.json"),
        serde_json::to_string_pretty(&result_json).unwrap(),
    )
    .unwrap();

    println!("  Islands: {}", result.islands.len());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut fixture_dir = PathBuf::new();
    let mut output_dir = PathBuf::new();
    let mut stage = "full".to_string();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--fixture" => {
                i += 1;
                fixture_dir = PathBuf::from(&args[i]);
            }
            "--output" => {
                i += 1;
                output_dir = PathBuf::from(&args[i]);
            }
            "--stage" => {
                i += 1;
                stage = args[i].clone();
            }
            _ => {}
        }
        i += 1;
    }

    if fixture_dir.as_os_str().is_empty() {
        eprintln!("Usage: island_harness --fixture <dir> [--stage rle|scan|tracker|full] [--output <dir>]");
        std::process::exit(1);
    }

    if output_dir.as_os_str().is_empty() {
        output_dir = fixture_dir.join("rust-output");
    }
    fs::create_dir_all(&output_dir).unwrap();

    // Read input.json
    let input_path = fixture_dir.join("input.json");
    let input: InputJson =
        serde_json::from_str(&fs::read_to_string(&input_path).unwrap()).unwrap();

    println!("Fixture: {}", fixture_dir.display());
    println!("Output:  {}", output_dir.display());
    println!("Stage:   {}", stage);
    println!("Grid:    {}x{}, {} layers", input.width, input.height, input.num_layers);

    match stage.as_str() {
        "rle" => run_stage_rle(&fixture_dir, &output_dir, &input),
        "scan" => run_stage_scan(&fixture_dir, &output_dir, &input),
        "tracker" => run_stage_tracker(&fixture_dir, &output_dir, &input),
        "full" => run_stage_full(&fixture_dir, &output_dir, &input),
        _ => {
            eprintln!("Unknown stage: {}. Use: rle, scan, tracker, full", stage);
            std::process::exit(1);
        }
    }

    println!("Done!");
}
