//! Benchmark island detection on a real STL file.
//!
//! Uses the shared `islands::rasterize` module (same code as Tauri IPC command).
//!
//! Usage: cargo run --release --bin island_stl_bench -- path/to/model.stl

use dragonfruit_islands::geometry::parse_triangles;
use dragonfruit_islands::model::*;
use dragonfruit_islands::pipeline::run_island_scan;
use dragonfruit_islands::rasterize::rasterize_for_island_scan;

use std::fs;
use std::path::Path;
use std::time::Instant;

fn load_binary_stl(path: &Path) -> Vec<f32> {
    let data = fs::read(path).expect("Failed to read STL file");
    assert!(data.len() >= 84, "STL file too small");
    let num_triangles = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    println!("  Triangles: {}", num_triangles);
    let mut flat = Vec::with_capacity(num_triangles * 9);
    let mut offset = 84;
    for _ in 0..num_triangles {
        offset += 12; // skip normal
        for _ in 0..3 {
            let x = f32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]);
            let y = f32::from_le_bytes([data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]]);
            let z = f32::from_le_bytes([data[offset + 8], data[offset + 9], data[offset + 10], data[offset + 11]]);
            flat.push(x); flat.push(y); flat.push(z);
            offset += 12;
        }
        offset += 2; // attribute
    }
    flat
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let stl_path = if args.len() > 1 { &args[1] } else { "../../lilith-lilith-leftwing.stl" };

    println!("Island Detection — Real STL Benchmark");
    println!("======================================\n");

    println!("Loading: {}", stl_path);
    let flat = load_binary_stl(Path::new(stl_path));
    let triangles = parse_triangles(&flat);

    // Bounding box
    let mut min_x = f32::MAX; let mut max_x = f32::MIN;
    let mut min_y = f32::MAX; let mut max_y = f32::MIN;
    let mut min_z = f32::MAX; let mut max_z = f32::MIN;
    for tri in &triangles {
        for v in &[tri.a, tri.b, tri.c] {
            min_x = min_x.min(v.x); max_x = max_x.max(v.x);
            min_y = min_y.min(v.y); max_y = max_y.max(v.y);
            min_z = min_z.min(v.z); max_z = max_z.max(v.z);
        }
    }

    let px_mm = 0.05;
    let layer_height_mm = 0.05;
    let support_buffer_mm = 0.1;

    println!("  Bounding box: ({:.2}, {:.2}, {:.2}) - ({:.2}, {:.2}, {:.2})",
        min_x, min_y, min_z, max_x, max_y, max_z);

    // Phase A: Rasterize (shared code with Tauri IPC)
    println!("\nRasterizing (parallel)...");
    let t_raster = Instant::now();
    let (masks, grid_width, grid_height, num_layers, origin_x, origin_z) =
        rasterize_for_island_scan(
            &triangles,
            min_x as f64, max_x as f64,
            min_y as f64, max_y as f64,
            min_z as f64, max_z as f64,
            px_mm, layer_height_mm,
        );
    let raster_ms = t_raster.elapsed().as_secs_f64() * 1000.0;

    let total_px: u64 = masks.iter().map(|m| m.pixel_count()).sum();
    let w = grid_width as usize;
    let h = grid_height as usize;
    println!("  Grid: {}x{} ({:.1}mm x {:.1}mm) @ {:.3}mm/px",
        w, h, max_x - min_x, max_y - min_y, px_mm);
    println!("  Layers: {} ({:.1}mm @ {:.3}mm/layer)", num_layers, max_z - min_z, layer_height_mm);
    println!("  Rasterization: {:.1}ms ({:.0} layers/s)", raster_ms, num_layers as f64 / (raster_ms / 1000.0));
    println!("  Total solid pixels: {} ({:.1}M)", total_px, total_px as f64 / 1_000_000.0);
    println!("  Avg fill: {:.1}%", total_px as f64 / (w as f64 * h as f64 * num_layers as f64) * 100.0);

    // Phase B: Island scan
    let job = IslandScanJob {
        px_mm, support_buffer_mm,
        connectivity: Connectivity::Four,
        min_island_area_mm2: 0.01,
        layer_height_mm,
        grid: GridRef { origin_x, origin_z, width: grid_width, height: grid_height, px_mm },
        num_layers: num_layers as u32,
        min_overlap_px: 1,
        overlap_neighborhood_px: 1,
    };

    println!("\nIsland scan (warmup)...");
    let _ = run_island_scan(&job, &masks, None);

    println!("Island scan (best of 3)...");
    let mut best = f64::MAX;
    let mut best_result = None;
    for i in 0..3 {
        let t0 = Instant::now();
        let r = run_island_scan(&job, &masks, None);
        let elapsed = t0.elapsed().as_secs_f64();
        println!("  Run {}: {:.1}ms", i + 1, elapsed * 1000.0);
        if elapsed < best { best = elapsed; best_result = Some(r); }
    }

    let result = best_result.unwrap();
    let scan_ms = best * 1000.0;

    println!("\n═══ Results ═══════════════════════════════════════");
    println!("  Islands found:     {}", result.islands.len());
    for island in result.islands.iter().take(10) {
        println!("    #{}: layers {}-{}, area={:.3}mm², vol={:.4}mm³, status={:?}",
            island.id, island.first_layer, island.last_layer,
            island.max_area_mm2.unwrap_or(0.0),
            island.volume_mm3.unwrap_or(0.0),
            island.status);
    }
    if result.islands.len() > 10 { println!("    ... and {} more", result.islands.len() - 10); }

    println!("\n═══ Performance ═══════════════════════════════════");
    println!("  Rasterization:     {:>8.1} ms", raster_ms);
    println!("  Island scan:       {:>8.1} ms", scan_ms);
    println!("  Total:             {:>8.1} ms", raster_ms + scan_ms);
    println!("  Scan layers/s:     {:>8.0}", num_layers as f64 / (scan_ms / 1000.0));
    println!("  Scan Mpx/s:        {:>8.1}", total_px as f64 / (scan_ms / 1000.0) / 1_000_000.0);
}
