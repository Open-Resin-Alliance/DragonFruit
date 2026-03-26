//! Island scan CLI — full pipeline from STL to islands.
//!
//! Usage:
//!   cargo run --release --bin island_scan_cli -- model.stl
//!   cargo run --release --bin island_scan_cli -- model.stl --px-mm 0.1 --buffer 0.6 --overlap 4
//!   cargo run --release --bin island_scan_cli -- model.stl --dump /tmp/island-debug
//!
//! Uses the same rasterizer and pipeline as the Tauri IPC command.

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
    let n = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    let mut flat = Vec::with_capacity(n * 9);
    let mut off = 84;
    for _ in 0..n {
        off += 12;
        for _ in 0..3 {
            flat.push(f32::from_le_bytes([data[off], data[off+1], data[off+2], data[off+3]]));
            flat.push(f32::from_le_bytes([data[off+4], data[off+5], data[off+6], data[off+7]]));
            flat.push(f32::from_le_bytes([data[off+8], data[off+9], data[off+10], data[off+11]]));
            off += 12;
        }
        off += 2;
    }
    flat
}

fn parse_f64(args: &[String], flag: &str, default: f64) -> f64 {
    args.iter().position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn parse_i32(args: &[String], flag: &str, default: i32) -> i32 {
    args.iter().position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn parse_str<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 || args[1] == "--help" || args[1] == "-h" {
        eprintln!("Island Scan CLI — full pipeline from STL to islands");
        eprintln!();
        eprintln!("Usage: island_scan_cli <model.stl> [options]");
        eprintln!();
        eprintln!("Options:");
        eprintln!("  --px-mm <f64>          Pixel size in mm (default: 0.1)");
        eprintln!("  --buffer <f64>         Support buffer in mm (default: 0.6)");
        eprintln!("  --connectivity <4|8>   Pixel connectivity (default: 4)");
        eprintln!("  --min-area <f64>       Min island area mm² (default: 0)");
        eprintln!("  --overlap <i32>        Min overlap pixels (default: 4)");
        eprintln!("  --neighborhood <i32>   Overlap neighborhood px (default: 1)");
        eprintln!("  --layer-height <f64>   Layer height in mm (default: 0.05)");
        eprintln!("  --dump <dir>           Dump debug data for comparison");
        eprintln!("  --json                 Output results as JSON");
        std::process::exit(1);
    }

    let stl_path = &args[1];
    let px_mm = parse_f64(&args, "--px-mm", 0.1);
    let support_buffer_mm = parse_f64(&args, "--buffer", 0.6);
    let connectivity = parse_i32(&args, "--connectivity", 4) as u8;
    let min_island_area_mm2 = parse_f64(&args, "--min-area", 0.0);
    let min_overlap_px = parse_i32(&args, "--overlap", 4);
    let overlap_neighborhood_px = parse_i32(&args, "--neighborhood", 1);
    let layer_height_mm = parse_f64(&args, "--layer-height", 0.05);
    let dump_dir = parse_str(&args, "--dump");
    let json_output = args.iter().any(|a| a == "--json");

    // Load STL
    if !json_output {
        eprintln!("Loading: {}", stl_path);
    }
    let flat = load_binary_stl(Path::new(stl_path));
    let triangles = parse_triangles(&flat);

    // Bounding box
    let (mut min_x, mut max_x) = (f32::MAX, f32::MIN);
    let (mut min_y, mut max_y) = (f32::MAX, f32::MIN);
    let (mut min_z, mut max_z) = (f32::MAX, f32::MIN);
    for tri in &triangles {
        for v in &[tri.a, tri.b, tri.c] {
            min_x = min_x.min(v.x); max_x = max_x.max(v.x);
            min_y = min_y.min(v.y); max_y = max_y.max(v.y);
            min_z = min_z.min(v.z); max_z = max_z.max(v.z);
        }
    }

    if !json_output {
        eprintln!("  Triangles: {}", triangles.len());
        eprintln!("  BBox: ({:.4}, {:.4}, {:.4}) - ({:.4}, {:.4}, {:.4})",
            min_x, min_y, min_z, max_x, max_y, max_z);
        eprintln!("  px_mm={} buffer={} conn={} overlap={} neighborhood={} layer_h={}",
            px_mm, support_buffer_mm, connectivity, min_overlap_px, overlap_neighborhood_px, layer_height_mm);
    }

    // Rasterize
    let t0 = Instant::now();
    let (masks, grid_width, grid_height, num_layers, origin_x, origin_z) =
        rasterize_for_island_scan(
            &triangles,
            min_x as f64, max_x as f64,
            min_y as f64, max_y as f64,
            min_z as f64, max_z as f64,
            px_mm, layer_height_mm,
        );
    let raster_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let total_px: u64 = masks.iter().map(|m| m.pixel_count()).sum();

    if !json_output {
        eprintln!("  Grid: {}x{}, Layers: {}", grid_width, grid_height, num_layers);
        eprintln!("  Solid pixels: {} ({:.1}M)", total_px, total_px as f64 / 1e6);
        eprintln!("  Rasterize: {:.0}ms", raster_ms);
    }

    // Island scan
    let conn = if connectivity == 8 { Connectivity::Eight } else { Connectivity::Four };
    let job = IslandScanJob {
        px_mm, support_buffer_mm, connectivity: conn,
        min_island_area_mm2, layer_height_mm,
        grid: GridRef { origin_x, origin_z, width: grid_width, height: grid_height, px_mm },
        num_layers: num_layers as u32,
        min_overlap_px, overlap_neighborhood_px,
    };

    let t1 = Instant::now();
    let result = run_island_scan(&job, &masks, None);
    let scan_ms = t1.elapsed().as_secs_f64() * 1000.0;

    if !json_output {
        eprintln!("  Islands: {}", result.islands.len());
        eprintln!("  Scan: {:.0}ms", scan_ms);
        eprintln!("  Total: {:.0}ms", raster_ms + scan_ms);
    }

    // Dump debug data
    if let Some(dir) = dump_dir {
        let dump_path = std::path::PathBuf::from(dir);
        let _ = fs::create_dir_all(&dump_path);

        // Params JSON (same format as IPC debug)
        let params = serde_json::json!({
            "px_mm": px_mm,
            "support_buffer_mm": support_buffer_mm,
            "connectivity": connectivity,
            "min_island_area_mm2": min_island_area_mm2,
            "min_overlap_px": min_overlap_px,
            "overlap_neighborhood_px": overlap_neighborhood_px,
            "layer_height_mm": layer_height_mm,
            "bbox_min_x": min_x, "bbox_max_x": max_x,
            "bbox_min_y": min_y, "bbox_max_y": max_y,
            "bbox_min_z": min_z, "bbox_max_z": max_z,
        });
        let _ = fs::write(dump_path.join("params.json"), serde_json::to_string_pretty(&params).unwrap());

        // Positions binary
        let pos_bytes: Vec<u8> = flat.iter().flat_map(|f| f.to_le_bytes()).collect();
        let _ = fs::write(dump_path.join("positions.bin"), &pos_bytes);

        // Per-layer pixel counts
        let layer_px: Vec<String> = masks.iter().enumerate()
            .map(|(i, m)| format!("{}: {}", i, m.pixel_count())).collect();
        let _ = fs::write(dump_path.join("layer_pixels.txt"), layer_px.join("\n"));

        // Summary
        let summary = format!(
            "triangles: {}\ngrid: {}x{}\nlayers: {}\nsolid_px: {}\nislands: {}\nraster_ms: {:.0}\nscan_ms: {:.0}\n",
            triangles.len(), grid_width, grid_height, num_layers, total_px,
            result.islands.len(), raster_ms, scan_ms,
        );
        let _ = fs::write(dump_path.join("summary.txt"), &summary);

        if !json_output {
            eprintln!("\n  Dump: {}", dump_path.display());
            eprintln!("  Compare: npx tsx scripts/island-ipc-debug.ts {}", dump_path.display());
        }
    }

    // Output
    if json_output {
        let out = serde_json::json!({
            "stl": stl_path,
            "triangles": triangles.len(),
            "grid": { "width": grid_width, "height": grid_height },
            "layers": num_layers,
            "solid_pixels": total_px,
            "islands": result.islands.len(),
            "raster_ms": raster_ms,
            "scan_ms": scan_ms,
            "total_ms": raster_ms + scan_ms,
            "params": {
                "px_mm": px_mm, "support_buffer_mm": support_buffer_mm,
                "connectivity": connectivity, "min_island_area_mm2": min_island_area_mm2,
                "min_overlap_px": min_overlap_px, "overlap_neighborhood_px": overlap_neighborhood_px,
                "layer_height_mm": layer_height_mm,
            },
            "island_details": result.islands.iter().map(|i| serde_json::json!({
                "id": i.id.0, "layers": [i.first_layer, i.last_layer],
                "max_area_mm2": i.max_area_mm2, "volume_mm3": i.volume_mm3,
                "status": format!("{:?}", i.status),
            })).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
    } else {
        println!();
        println!("Islands: {}", result.islands.len());
        for island in result.islands.iter().take(20) {
            println!("  #{}: L{}-{} area={:.3}mm² vol={:.4}mm³ {:?}",
                island.id, island.first_layer, island.last_layer,
                island.max_area_mm2.unwrap_or(0.0),
                island.volume_mm3.unwrap_or(0.0),
                island.status);
        }
        if result.islands.len() > 20 {
            println!("  ... and {} more", result.islands.len() - 20);
        }
    }
}
