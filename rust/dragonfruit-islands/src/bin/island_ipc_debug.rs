//! Reproduce island scan from IPC debug dump.
//!
//! Reads the positions.bin + params.json dumped by run_island_scan_native
//! and runs the exact same pipeline for offline debugging.
//!
//! Usage:
//!   cargo run --release --bin island_ipc_debug -- /tmp/dragonfruit-island-debug/
//!
//! Or with a custom dump dir:
//!   cargo run --release --bin island_ipc_debug -- path/to/dump/

use dragonfruit_islands::geometry::parse_triangles;
use dragonfruit_islands::model::*;
use dragonfruit_islands::pipeline::run_island_scan;
use dragonfruit_islands::rasterize::rasterize_for_island_scan;

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Params {
    px_mm: f64,
    support_buffer_mm: f64,
    #[serde(default = "default_4")]
    connectivity: u8,
    #[serde(default)]
    min_island_area_mm2: f64,
    #[serde(default = "default_1")]
    min_overlap_px: i32,
    #[serde(default = "default_1")]
    overlap_neighborhood_px: i32,
    layer_height_mm: f64,
    bbox_min_x: f64,
    bbox_max_x: f64,
    bbox_min_y: f64,
    bbox_max_y: f64,
    bbox_min_z: f64,
    bbox_max_z: f64,
}

fn default_4() -> u8 { 4 }
fn default_1() -> i32 { 1 }

fn bytes_to_f32_vec(bytes: &[u8]) -> Vec<f32> {
    let count = bytes.len() / 4;
    let mut floats = vec![0.0f32; count];
    unsafe {
        std::ptr::copy_nonoverlapping(
            bytes.as_ptr(),
            floats.as_mut_ptr() as *mut u8,
            bytes.len(),
        );
    }
    floats
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dump_dir = if args.len() > 1 {
        PathBuf::from(&args[1])
    } else {
        std::env::temp_dir().join("dragonfruit-island-debug")
    };

    println!("Island IPC Debug — Reproducing from dump");
    println!("=========================================\n");
    println!("Dump dir: {}\n", dump_dir.display());

    // Read params
    let params_json = fs::read_to_string(dump_dir.join("params.json"))
        .expect("Failed to read params.json");
    let params: Params = serde_json::from_str(&params_json)
        .expect("Failed to parse params.json");

    // Read positions
    let pos_bytes = fs::read(dump_dir.join("positions.bin"))
        .expect("Failed to read positions.bin");
    let triangles_xyz = bytes_to_f32_vec(&pos_bytes);
    let triangles = parse_triangles(&triangles_xyz);

    println!("Params:");
    println!("  px_mm: {}", params.px_mm);
    println!("  support_buffer_mm: {}", params.support_buffer_mm);
    println!("  connectivity: {}", params.connectivity);
    println!("  min_island_area_mm2: {}", params.min_island_area_mm2);
    println!("  min_overlap_px: {}", params.min_overlap_px);
    println!("  overlap_neighborhood_px: {}", params.overlap_neighborhood_px);
    println!("  layer_height_mm: {}", params.layer_height_mm);
    println!("  bbox: ({:.4}, {:.4}, {:.4}) - ({:.4}, {:.4}, {:.4})",
        params.bbox_min_x, params.bbox_min_y, params.bbox_min_z,
        params.bbox_max_x, params.bbox_max_y, params.bbox_max_z);
    println!("  triangles: {}", triangles.len());
    println!();

    // Rasterize (same code path as IPC)
    println!("Rasterizing...");
    let t0 = std::time::Instant::now();
    let (masks, grid_width, grid_height, num_layers, origin_x, origin_z) =
        rasterize_for_island_scan(
            &triangles,
            params.bbox_min_x, params.bbox_max_x,
            params.bbox_min_y, params.bbox_max_y,
            params.bbox_min_z, params.bbox_max_z,
            params.px_mm,
            params.layer_height_mm,
        );
    let raster_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let total_px: u64 = masks.iter().map(|m| m.pixel_count()).sum();
    println!("  Grid: {}x{}", grid_width, grid_height);
    println!("  Layers: {}", num_layers);
    println!("  Origin: ({:.6}, {:.6})", origin_x, origin_z);
    println!("  Total solid pixels: {}", total_px);
    println!("  Rasterize: {:.1}ms", raster_ms);

    // Per-layer pixel counts (first/last 5 + any empty)
    let mut empty_layers = Vec::new();
    for (i, m) in masks.iter().enumerate() {
        let px = m.pixel_count();
        if px == 0 { empty_layers.push(i); }
        if i < 3 || i >= num_layers - 3 {
            println!("  Layer {:>4}: {} px", i, px);
        }
    }
    if !empty_layers.is_empty() {
        println!("  Empty layers: {} (first: {}, last: {})",
            empty_layers.len(), empty_layers[0], empty_layers.last().unwrap());
    }
    println!();

    // Island scan
    let connectivity = if params.connectivity == 8 {
        Connectivity::Eight
    } else {
        Connectivity::Four
    };

    let job = IslandScanJob {
        px_mm: params.px_mm,
        support_buffer_mm: params.support_buffer_mm,
        connectivity,
        min_island_area_mm2: params.min_island_area_mm2,
        layer_height_mm: params.layer_height_mm,
        grid: GridRef {
            origin_x,
            origin_z,
            width: grid_width,
            height: grid_height,
            px_mm: params.px_mm,
        },
        num_layers: num_layers as u32,
        min_overlap_px: params.min_overlap_px,
        overlap_neighborhood_px: params.overlap_neighborhood_px,
    };

    println!("Running island scan...");
    let t1 = std::time::Instant::now();
    let result = run_island_scan(&job, &masks, None);
    let scan_ms = t1.elapsed().as_secs_f64() * 1000.0;

    println!("  Islands: {}", result.islands.len());
    println!("  Scan: {:.1}ms", scan_ms);
    println!();

    // Dump per-layer results for diffing
    let out_dir = dump_dir.join("rust-debug");
    let _ = fs::create_dir_all(&out_dir);

    // Write summary
    let summary = format!(
        "triangles: {}\ngrid: {}x{}\nlayers: {}\nsolid_px: {}\nislands: {}\nparams: {}\n",
        triangles.len(), grid_width, grid_height, num_layers, total_px,
        result.islands.len(), params_json.trim(),
    );
    let _ = fs::write(out_dir.join("summary.txt"), &summary);

    // Write per-layer pixel counts
    let layer_px: Vec<String> = masks.iter().enumerate()
        .map(|(i, m)| format!("{}: {}", i, m.pixel_count()))
        .collect();
    let _ = fs::write(out_dir.join("layer_pixels.txt"), layer_px.join("\n"));

    println!("Debug output: {}", out_dir.display());
    println!("\nTo compare with TS, run:");
    println!("  npx tsx scripts/island-ipc-debug.ts {}", dump_dir.display());
}
