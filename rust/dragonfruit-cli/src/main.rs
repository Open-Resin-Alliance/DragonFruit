//! DragonFruit CLI — every pipeline stage observable.
//!
//! Wraps existing Rust backend functions as CLI subcommands with JSON I/O.
//! Only exposes operations that have real Rust implementations — scene/support
//! management lives in TypeScript and is not duplicated here.
//!
//! Usage:
//!   dragonfruit-cli mesh read-stl model.stl -o /tmp/s1
//!   dragonfruit-cli mesh info /tmp/s1 --json
//!   dragonfruit-cli mesh export-stl -i /tmp/s1 -o model_out.stl
//!   dragonfruit-cli island full model.stl -o /tmp/all --json
//!   dragonfruit-cli slice run model.stl -o /tmp/out.nanodlp --json
//!   dragonfruit-cli print read-layer /tmp/out.nanodlp --layer 1 -o /tmp/layer1.png
//!   dragonfruit-cli info

use clap::{Parser, Subcommand};
use std::io::Read as IoRead;
use std::path::PathBuf;
use std::time::Instant;

use dragonfruit_cli::io::*;
use dragonfruit_slicing_engine::geometry::parse_triangles;
use dragonfruit_islands::model::*;
use dragonfruit_islands::rasterize::rasterize_for_island_scan;
use dragonfruit_islands::rle;
use dragonfruit_islands::scan::scan_layer;
use dragonfruit_islands::tracker::IslandTracker;

#[derive(Parser)]
#[command(name = "dragonfruit-cli", about = "DragonFruit pipeline CLI — every stage observable")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Mesh I/O (STL read/write, bounding box, stats)
    Mesh {
        #[command(subcommand)]
        command: MeshCommands,
    },

    /// Island detection pipeline
    Island {
        #[command(subcommand)]
        command: IslandCommands,
    },

    /// Slicing pipeline (wraps engine::slice_with_progress_v3_to_path)
    Slice {
        #[command(subcommand)]
        command: SliceCommands,
    },

    /// Print file operations (ZIP archive read/write, temp cleanup)
    Print {
        #[command(subcommand)]
        command: PrintCommands,
    },

    /// Synthetic slicer benchmark (wraps benchmark::run_benchmark_v3)
    Benchmark {
        #[arg(long, default_value = "200")]
        layers: u32,
        #[arg(long, default_value = "1920")]
        width_px: u32,
        #[arg(long, default_value = "1080")]
        height_px: u32,
        #[arg(long, default_value = "218.88")]
        build_width_mm: f32,
        #[arg(long, default_value = "122.904")]
        build_depth_mm: f32,
        #[arg(long, default_value = "0.05")]
        layer_height: f32,
        #[arg(long, default_value = "400")]
        cube_count: u32,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },

    /// Print defaults and supported formats
    Info,
}

// ===========================================================================
// Mesh subcommands — wraps cli.rs STL I/O + geometry::parse_triangles
// ===========================================================================

#[derive(Subcommand)]
enum MeshCommands {
    /// Parse binary STL to positions.bin + mesh-info.json
    ReadStl {
        /// Input STL file
        input: PathBuf,
        /// Output directory
        #[arg(short, long)]
        output: PathBuf,
    },

    /// Print mesh statistics (triangles, bbox, volume)
    Info {
        /// Input directory (from read-stl) or STL file
        input: PathBuf,
        /// Output as JSON to stdout
        #[arg(long)]
        json: bool,
    },

    /// Export positions.bin back to binary STL
    ExportStl {
        /// Input directory (with positions.bin)
        #[arg(short, long)]
        input: PathBuf,
        /// Output STL file path
        #[arg(short, long)]
        output: PathBuf,
    },

    /// Export positions.bin to 3MF
    #[command(name = "export-3mf")]
    Export3mf {
        /// Input directory (with positions.bin)
        #[arg(short, long)]
        input: PathBuf,
        /// Output 3MF file path
        #[arg(short, long)]
        output: PathBuf,
    },
}

// ===========================================================================
// Island subcommands — wraps islands::rasterize, scan, tracker, pipeline
// ===========================================================================

#[derive(Subcommand)]
enum IslandCommands {
    /// Rasterize triangles to per-layer RLE masks
    Rasterize {
        #[arg(short, long)]
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "0.1")]
        px_mm: f64,
        #[arg(long, default_value = "0.05")]
        layer_height: f64,
    },

    /// Per-layer candidate detection (support subtraction + CCL)
    Scan {
        #[arg(short, long)]
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "0.6")]
        buffer: f64,
        #[arg(long, default_value = "4")]
        connectivity: u8,
    },

    /// Cross-layer island tracking
    Track {
        #[arg(short, long)]
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "4")]
        overlap: i32,
        #[arg(long, default_value = "1")]
        neighborhood: i32,
    },

    /// Volume calculation + filtering → result.json
    Analyze {
        #[arg(short, long)]
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "0.0")]
        min_area: f64,
    },

    /// Full pipeline: STL → islands (all stages)
    Full {
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "0.1")]
        px_mm: f64,
        #[arg(long, default_value = "0.05")]
        layer_height: f64,
        #[arg(long, default_value = "0.6")]
        buffer: f64,
        #[arg(long, default_value = "4")]
        connectivity: u8,
        #[arg(long, default_value = "4")]
        overlap: i32,
        #[arg(long, default_value = "1")]
        neighborhood: i32,
        #[arg(long, default_value = "0.0")]
        min_area: f64,
        #[arg(long)]
        params_json: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },

    /// Benchmark each pipeline stage with timing breakdown
    Bench {
        input: PathBuf,
        #[arg(long, default_value = "0.1")]
        px_mm: f64,
        #[arg(long, default_value = "0.05")]
        layer_height: f64,
        #[arg(long, default_value = "0.6")]
        buffer: f64,
        #[arg(long, default_value = "4")]
        connectivity: u8,
        #[arg(long, default_value = "4")]
        overlap: i32,
        #[arg(long, default_value = "1")]
        neighborhood: i32,
        #[arg(long, default_value = "0.0")]
        min_area: f64,
        #[arg(long, default_value = "3")]
        iterations: u32,
        #[arg(long)]
        json: bool,
    },

    /// Batch island scan on multiple STL files
    Batch {
        /// Input STL files
        inputs: Vec<PathBuf>,
        /// Output directory
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "0.1")]
        px_mm: f64,
        #[arg(long, default_value = "0.05")]
        layer_height: f64,
        #[arg(long, default_value = "0.6")]
        buffer: f64,
        #[arg(long, default_value = "4")]
        connectivity: u8,
        #[arg(long, default_value = "4")]
        overlap: i32,
        #[arg(long, default_value = "1")]
        neighborhood: i32,
        #[arg(long, default_value = "0.0")]
        min_area: f64,
        #[arg(long)]
        json: bool,
    },

    /// Connected component labeling on an RLE mask (wraps rle_label_components)
    #[command(name = "rle-label")]
    RleLabel {
        /// Input RLE mask JSON file
        #[arg(short, long)]
        input: PathBuf,
        /// Output directory (components.json + labels.rle.json)
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "4")]
        connectivity: u8,
        #[arg(long)]
        json: bool,
    },

    /// Subtract one RLE mask from another (wraps rle_subtract)
    #[command(name = "rle-subtract")]
    RleSubtract {
        /// Mask A (minuend)
        #[arg(short = 'a', long)]
        mask_a: PathBuf,
        /// Mask B (subtrahend)
        #[arg(short = 'b', long)]
        mask_b: PathBuf,
        /// Output mask JSON
        #[arg(short, long)]
        output: PathBuf,
    },
}

// ===========================================================================
// Slice subcommands — wraps engine::slice_with_progress_v3_to_path
// ===========================================================================

#[derive(Subcommand)]
enum SliceCommands {
    /// Slice STL or positions.bin → rasterize → encode → archive file
    Run {
        /// Input file (STL or raw positions.bin from mesh read-stl / scene merge)
        input: PathBuf,
        /// Output archive path (extension determines format)
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long, default_value = "0.05")]
        layer_height: f32,
        #[arg(long, default_value = "218.0")]
        build_width_mm: f32,
        #[arg(long, default_value = "122.0")]
        build_depth_mm: f32,
        /// Source raster width in pixels
        #[arg(long, default_value = "11400")]
        source_width_px: u32,
        /// Source raster height in pixels
        #[arg(long, default_value = "6400")]
        source_height_px: u32,
        /// PNG compression strategy (fastest, balanced, smallest, optimal)
        #[arg(long, default_value = "balanced")]
        png_compression: String,
        /// Anti-aliasing level (Off, 2x, 4x, 8x)
        #[arg(long, default_value = "Off")]
        anti_aliasing: String,
        /// X-axis sub-pixel packing mode.
        ///
        /// - `none` (default): raw grayscale at source resolution; width_px = source_width_px.
        /// - `rgb8_div3`: 3 sub-pixels packed into 1 RGB pixel; width_px = source_width_px / 3.
        /// - `gray3_div2`: 2 sub-pixels packed into 1 grayscale pixel; width_px = source_width_px / 2.
        #[arg(long, default_value = "none")]
        x_packing_mode: String,
        /// Mirror X
        #[arg(long)]
        mirror_x: bool,
        /// Mirror Y
        #[arg(long)]
        mirror_y: bool,
        /// Format version (e.g. v5enc for encrypted CTB)
        #[arg(long)]
        format_version: Option<String>,
        /// Minimum AA alpha threshold (percent, 0-100)
        #[arg(long, default_value = "0.0")]
        min_aa_alpha: f32,
        /// Metadata JSON string
        #[arg(long, default_value = "{}")]
        metadata_json: String,
        /// Output as JSON to stdout
        #[arg(long)]
        json: bool,
    },

    /// List supported output formats with capabilities
    Formats,

    /// Extract single layer PNG from archive (same as Tauri read_print_layer_png)
    PreviewLayer {
        /// Input archive file
        input: PathBuf,
        /// Layer number (1-based, matching Tauri convention)
        #[arg(short, long)]
        layer: u32,
        /// Output PNG path
        #[arg(short, long)]
        output: PathBuf,
    },

    /// List supported output formats + defaults
    Info,
}

// ===========================================================================
// Print subcommands — wraps Tauri print file ops
// ===========================================================================

#[derive(Subcommand)]
enum PrintCommands {
    /// Copy archive to final output path (equivalent to save_print_file_from_path)
    Save {
        /// Source archive file
        input: PathBuf,
        /// Destination path
        #[arg(short, long)]
        output: PathBuf,
    },

    /// Read raw bytes from print file (equivalent to read_print_file_bytes)
    ReadBytes {
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
    },

    /// Read a single layer PNG from archive (equivalent to read_print_layer_png)
    ReadLayer {
        input: PathBuf,
        /// Layer number (1-based)
        #[arg(short, long)]
        layer: u32,
        #[arg(short, long)]
        output: PathBuf,
    },

    /// Inspect archive contents and metadata
    Inspect {
        input: PathBuf,
        #[arg(long)]
        json: bool,
    },

    /// Clean up temp files (equivalent to cleanup_*_print_temp_files)
    Cleanup {
        /// Delete a specific dragonfruit temp artifact (equivalent to delete_print_temp_file)
        #[arg(long)]
        path: Option<PathBuf>,
        /// Remove all dragonfruit temp artifacts (equivalent to cleanup_all_print_temp_files)
        #[arg(long)]
        all: bool,
        /// Remove stale artifacts older than N seconds (equivalent to cleanup_stale_print_temp_files)
        #[arg(long)]
        max_age_seconds: Option<u64>,
    },
}

// ===========================================================================
// Mesh command implementations — wraps cli.rs
// ===========================================================================

fn cmd_mesh_read_stl(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    ensure_dir(output)?;

    let flat = load_binary_stl(input)?;
    let triangles = parse_triangles(&flat);
    let bbox = compute_bbox(&triangles);

    write_positions_bin(&output.join("positions.bin"), &flat)?;

    let info = serde_json::json!({
        "triangles": triangles.len(),
        "bbox": bbox,
        "file_size_bytes": std::fs::metadata(input).map(|m| m.len()).unwrap_or(0),
    });
    write_json(&output.join("mesh-info.json"), &info)?;

    eprintln!("read-stl: {} triangles, bbox ({:.2},{:.2},{:.2})-({:.2},{:.2},{:.2})",
        triangles.len(), bbox.min_x, bbox.min_y, bbox.min_z, bbox.max_x, bbox.max_y, bbox.max_z);
    Ok(())
}

fn cmd_mesh_info(input: &PathBuf, json_output: bool) -> Result<(), String> {
    let (flat, source) = if input.is_dir() {
        (read_positions_bin(&input.join("positions.bin"))?, "directory")
    } else {
        (load_binary_stl(input)?, "stl")
    };

    let triangles = parse_triangles(&flat);
    let bbox = compute_bbox(&triangles);

    // Volume via signed-volume divergence theorem (same geometry crate)
    let mut volume = 0.0f64;
    for tri in &triangles {
        let v321 = tri.c.x as f64 * tri.b.y as f64 * tri.a.z as f64;
        let v231 = tri.b.x as f64 * tri.c.y as f64 * tri.a.z as f64;
        let v312 = tri.c.x as f64 * tri.a.y as f64 * tri.b.z as f64;
        let v132 = tri.a.x as f64 * tri.c.y as f64 * tri.b.z as f64;
        let v213 = tri.b.x as f64 * tri.a.y as f64 * tri.c.z as f64;
        let v123 = tri.a.x as f64 * tri.b.y as f64 * tri.c.z as f64;
        volume += (-v321 + v231 + v312 - v132 - v213 + v123) / 6.0;
    }

    let info = serde_json::json!({
        "source": source,
        "triangles": triangles.len(),
        "vertices": triangles.len() * 3,
        "bbox": {
            "min": [bbox.min_x, bbox.min_y, bbox.min_z],
            "max": [bbox.max_x, bbox.max_y, bbox.max_z],
            "size": [bbox.max_x - bbox.min_x, bbox.max_y - bbox.min_y, bbox.max_z - bbox.min_z],
        },
        "volume_mm3": volume.abs(),
    });

    if json_output {
        println!("{}", serde_json::to_string_pretty(&info).unwrap());
    } else {
        eprintln!("mesh info ({}):", source);
        eprintln!("  triangles: {}", triangles.len());
        eprintln!("  bbox: ({:.2},{:.2},{:.2}) to ({:.2},{:.2},{:.2})",
            bbox.min_x, bbox.min_y, bbox.min_z, bbox.max_x, bbox.max_y, bbox.max_z);
        eprintln!("  size: {:.2} x {:.2} x {:.2} mm",
            bbox.max_x - bbox.min_x, bbox.max_y - bbox.min_y, bbox.max_z - bbox.min_z);
        eprintln!("  volume: {:.2} mm^3", volume.abs());
    }
    Ok(())
}

fn cmd_mesh_export_stl(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let positions = read_positions_bin(&input.join("positions.bin"))?;
    write_binary_stl(output, &positions)?;
    eprintln!("export-stl: {} triangles -> {}", positions.len() / 9, output.display());
    Ok(())
}

fn cmd_mesh_export_3mf(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let positions = read_positions_bin(&input.join("positions.bin"))?;
    write_3mf(output, &positions)?;
    eprintln!("export-3mf: {} triangles -> {}", positions.len() / 9, output.display());
    Ok(())
}

// ===========================================================================
// Island command implementations — wraps islands::* (unchanged from original)
// ===========================================================================

fn cmd_rasterize(input: &PathBuf, output: &PathBuf, px_mm: f64, layer_height: f64) -> Result<(), String> {
    ensure_dir(output)?;
    ensure_dir(&output.join("layers"))?;

    let flat = read_positions_bin(&input.join("positions.bin"))?;
    let info: serde_json::Value = read_json(&input.join("mesh-info.json"))?;
    let bbox: BBox = serde_json::from_value(info["bbox"].clone())
        .map_err(|e| format!("Parse bbox: {e}"))?;

    let triangles = parse_triangles(&flat);

    let t0 = Instant::now();
    let (masks, grid_width, grid_height, num_layers, origin_x, origin_z) =
        rasterize_for_island_scan(
            &triangles,
            bbox.min_x as f64, bbox.max_x as f64,
            bbox.min_y as f64, bbox.max_y as f64,
            bbox.min_z as f64, bbox.max_z as f64,
            px_mm, layer_height,
        );
    let raster_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let params = serde_json::json!({
        "px_mm": px_mm,
        "layer_height_mm": layer_height,
        "grid_width": grid_width,
        "grid_height": grid_height,
        "origin_x": origin_x,
        "origin_z": origin_z,
        "num_layers": num_layers,
        "bbox": bbox,
    });
    write_json(&output.join("params.json"), &params)?;

    let total_px: u64 = masks.iter().map(|m| m.pixel_count()).sum();
    for (i, mask) in masks.iter().enumerate() {
        write_rle_mask_json(&output.join("layers").join(format!("{:03}.mask.rle.json", i)), mask)?;
    }

    let summary = serde_json::json!({
        "layers": num_layers,
        "grid": { "width": grid_width, "height": grid_height },
        "total_solid_px": total_px,
        "raster_ms": raster_ms,
    });
    write_json(&output.join("raster-summary.json"), &summary)?;

    eprintln!("rasterize: {}x{}, {} layers, {} solid px, {:.0}ms",
        grid_width, grid_height, num_layers, total_px, raster_ms);
    Ok(())
}

fn cmd_scan(input: &PathBuf, output: &PathBuf, buffer_mm: f64, connectivity: u8) -> Result<(), String> {
    ensure_dir(&output.join("layers"))?;

    let params: serde_json::Value = read_json(&input.join("params.json"))?;
    let px_mm = params["px_mm"].as_f64().unwrap();
    let num_layers = params["num_layers"].as_u64().unwrap() as usize;
    let conn = if connectivity == 8 { Connectivity::Eight } else { Connectivity::Four };

    let t0 = Instant::now();
    let mut prev_mask: Option<RleMask> = None;
    let mut total_candidates = 0u64;

    for l in 0..num_layers {
        let mask = read_rle_mask_json(&input.join("layers").join(format!("{:03}.mask.rle.json", l)))?;
        let result = scan_layer(&mask, prev_mask.as_ref(), px_mm, buffer_mm, conn);

        write_rle_labels_json(
            &output.join("layers").join(format!("{:03}.candidates.rle.json", l)),
            &result.labels,
        )?;
        write_json(
            &output.join("layers").join(format!("{:03}.components.json", l)),
            &result.components,
        )?;

        total_candidates += result.components.iter().map(|c| c.area_px as u64).sum::<u64>();
        prev_mask = Some(mask);
    }
    let scan_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let mut out_params: serde_json::Value = read_json(&input.join("params.json"))?;
    out_params["support_buffer_mm"] = serde_json::json!(buffer_mm);
    out_params["connectivity"] = serde_json::json!(connectivity);
    if output != input {
        for l in 0..num_layers {
            let src = input.join("layers").join(format!("{:03}.mask.rle.json", l));
            let dst = output.join("layers").join(format!("{:03}.mask.rle.json", l));
            if src != dst { let _ = std::fs::copy(&src, &dst); }
        }
    }
    write_json(&output.join("params.json"), &out_params)?;

    let summary = serde_json::json!({
        "layers": num_layers,
        "total_candidate_px": total_candidates,
        "scan_ms": scan_ms,
    });
    write_json(&output.join("scan-summary.json"), &summary)?;

    eprintln!("scan: {} layers, {} candidate px, {:.0}ms", num_layers, total_candidates, scan_ms);
    Ok(())
}

fn cmd_track(input: &PathBuf, output: &PathBuf, overlap: i32, neighborhood: i32) -> Result<(), String> {
    ensure_dir(&output.join("layers"))?;
    ensure_dir(&output.join("tracker-state"))?;

    let params: serde_json::Value = read_json(&input.join("params.json"))?;
    let px_mm = params["px_mm"].as_f64().unwrap();
    let num_layers = params["num_layers"].as_u64().unwrap() as usize;

    let mut tracker = IslandTracker::new(px_mm, overlap, neighborhood);
    let mut island_labels_all: Vec<RleLabels> = Vec::new();

    let t0 = Instant::now();
    for l in 0..num_layers {
        let mask = read_rle_mask_json(&input.join("layers").join(format!("{:03}.mask.rle.json", l)))?;
        let candidates = read_rle_labels_json(&input.join("layers").join(format!("{:03}.candidates.rle.json", l)))?;
        let components: Vec<ComponentInfo> = read_json(&input.join("layers").join(format!("{:03}.components.json", l)))?;

        let prev_labels = if l > 0 { Some(&island_labels_all[l - 1]) } else { None };
        let island_labels = tracker.process_layer(l as u32, &candidates, &components, prev_labels, &mask);

        write_rle_labels_json(
            &output.join("layers").join(format!("{:03}.island-labels.rle.json", l)),
            &island_labels,
        )?;
        island_labels_all.push(island_labels);

        let islands = tracker.get_islands();
        write_json(&output.join("tracker-state").join(format!("{:03}.islands.json", l)), &islands)?;
    }
    let track_ms = t0.elapsed().as_secs_f64() * 1000.0;

    tracker.finalize_islands(num_layers.saturating_sub(1) as u32);
    let islands = tracker.get_islands();
    write_json(&output.join("islands.json"), &islands)?;

    let mut out_params: serde_json::Value = read_json(&input.join("params.json"))?;
    out_params["min_overlap_px"] = serde_json::json!(overlap);
    out_params["overlap_neighborhood_px"] = serde_json::json!(neighborhood);
    write_json(&output.join("params.json"), &out_params)?;

    let summary = serde_json::json!({
        "islands_total": islands.len(),
        "track_ms": track_ms,
    });
    write_json(&output.join("track-summary.json"), &summary)?;

    eprintln!("track: {} islands, {:.0}ms", islands.len(), track_ms);
    Ok(())
}

fn cmd_analyze(input: &PathBuf, output: &PathBuf, min_area: f64) -> Result<(), String> {
    ensure_dir(output)?;

    let params: serde_json::Value = read_json(&input.join("params.json"))?;
    let layer_height = params["layer_height_mm"].as_f64().unwrap();

    let mut islands: Vec<Island> = read_json(&input.join("islands.json"))?;

    for island in &mut islands {
        let vol: f64 = island.per_layer_area_mm2.values().map(|&a| a * layer_height).sum();
        island.volume_mm3 = Some(vol);
        let max_area = island.per_layer_area_mm2.values().copied().fold(0.0_f64, f64::max);
        island.max_area_mm2 = Some(max_area);
        island.compute_centroid();
    }

    let filtered: Vec<&Island> = islands.iter()
        .filter(|i| !i.is_merged_placeholder && i.max_area_mm2.unwrap_or(0.0) >= min_area)
        .collect();

    let result = serde_json::json!({
        "islands_total": islands.len(),
        "islands_filtered": filtered.len(),
        "min_area_mm2": min_area,
        "islands": filtered,
    });
    write_json(&output.join("result.json"), &result)?;

    eprintln!("analyze: {} total -> {} filtered (min_area={} mm2)", islands.len(), filtered.len(), min_area);
    Ok(())
}

fn cmd_island_full(
    input: &PathBuf, output: &PathBuf,
    px_mm: f64, layer_height: f64, buffer: f64, connectivity: u8,
    overlap: i32, neighborhood: i32, min_area: f64,
    params_json: &Option<PathBuf>, json_output: bool,
) -> Result<(), String> {
    ensure_dir(output)?;
    ensure_dir(&output.join("layers"))?;
    ensure_dir(&output.join("tracker-state"))?;

    let (px_mm, layer_height, buffer, connectivity, overlap, neighborhood, min_area) =
        if let Some(pj) = params_json {
            let p: serde_json::Value = read_json(pj)?;
            (
                p.get("px_mm").and_then(|v| v.as_f64()).unwrap_or(px_mm),
                p.get("layer_height_mm").and_then(|v| v.as_f64()).unwrap_or(layer_height),
                p.get("support_buffer_mm").and_then(|v| v.as_f64()).unwrap_or(buffer),
                p.get("connectivity").and_then(|v| v.as_u64()).unwrap_or(connectivity as u64) as u8,
                p.get("min_overlap_px").and_then(|v| v.as_i64()).unwrap_or(overlap as i64) as i32,
                p.get("overlap_neighborhood_px").and_then(|v| v.as_i64()).unwrap_or(neighborhood as i64) as i32,
                p.get("min_island_area_mm2").and_then(|v| v.as_f64()).unwrap_or(min_area),
            )
        } else {
            (px_mm, layer_height, buffer, connectivity, overlap, neighborhood, min_area)
        };

    let flat = load_binary_stl(input)?;
    let triangles = parse_triangles(&flat);
    let bbox = compute_bbox(&triangles);

    write_positions_bin(&output.join("positions.bin"), &flat)?;
    write_json(&output.join("mesh-info.json"), &serde_json::json!({
        "triangles": triangles.len(), "bbox": bbox,
    }))?;

    let t_raster = Instant::now();
    let (masks, gw, gh, nl, ox, oz) = rasterize_for_island_scan(
        &triangles,
        bbox.min_x as f64, bbox.max_x as f64,
        bbox.min_y as f64, bbox.max_y as f64,
        bbox.min_z as f64, bbox.max_z as f64,
        px_mm, layer_height,
    );
    let raster_ms = t_raster.elapsed().as_secs_f64() * 1000.0;
    let total_px: u64 = masks.iter().map(|m| m.pixel_count()).sum();

    for (i, mask) in masks.iter().enumerate() {
        write_rle_mask_json(&output.join("layers").join(format!("{:03}.mask.rle.json", i)), mask)?;
    }

    let conn = if connectivity == 8 { Connectivity::Eight } else { Connectivity::Four };

    let t_scan = Instant::now();
    let mut layer_results = Vec::new();
    for (i, mask) in masks.iter().enumerate() {
        let prev = if i > 0 { Some(&masks[i - 1]) } else { None };
        let r = scan_layer(mask, prev, px_mm, buffer, conn);
        write_rle_labels_json(&output.join("layers").join(format!("{:03}.candidates.rle.json", i)), &r.labels)?;
        write_json(&output.join("layers").join(format!("{:03}.components.json", i)), &r.components)?;
        layer_results.push(r);
    }

    let mut tracker = IslandTracker::new(px_mm, overlap, neighborhood);
    let mut island_labels_all: Vec<RleLabels> = Vec::new();

    for (l, lr) in layer_results.iter().enumerate() {
        let prev_labels = if l > 0 { Some(&island_labels_all[l - 1]) } else { None };
        let island_labels = tracker.process_layer(l as u32, &lr.labels, &lr.components, prev_labels, &lr.solid_mask);
        write_rle_labels_json(&output.join("layers").join(format!("{:03}.island-labels.rle.json", l)), &island_labels)?;
        let snap = tracker.get_islands();
        write_json(&output.join("tracker-state").join(format!("{:03}.islands.json", l)), &snap)?;
        island_labels_all.push(island_labels);
    }
    tracker.finalize_islands(nl.saturating_sub(1) as u32);
    let mut islands = tracker.get_islands();
    let scan_ms = t_scan.elapsed().as_secs_f64() * 1000.0;

    for island in &mut islands {
        let vol: f64 = island.per_layer_area_mm2.values().map(|&a| a * layer_height).sum();
        island.volume_mm3 = Some(vol);
        let max_a = island.per_layer_area_mm2.values().copied().fold(0.0_f64, f64::max);
        island.max_area_mm2 = Some(max_a);
        island.compute_centroid();
    }
    let filtered: Vec<&Island> = islands.iter()
        .filter(|i| !i.is_merged_placeholder && i.max_area_mm2.unwrap_or(0.0) >= min_area)
        .collect();

    write_json(&output.join("islands.json"), &islands)?;

    let params_out = serde_json::json!({
        "px_mm": px_mm, "layer_height_mm": layer_height,
        "support_buffer_mm": buffer, "connectivity": connectivity,
        "min_overlap_px": overlap, "overlap_neighborhood_px": neighborhood,
        "min_island_area_mm2": min_area,
        "grid_width": gw, "grid_height": gh,
        "origin_x": ox, "origin_z": oz,
        "num_layers": nl, "bbox": bbox,
    });
    write_json(&output.join("params.json"), &params_out)?;

    let result = serde_json::json!({
        "stl": input.display().to_string(),
        "triangles": triangles.len(),
        "grid": { "width": gw, "height": gh },
        "layers": nl,
        "solid_pixels": total_px,
        "islands_total": islands.len(),
        "islands_filtered": filtered.len(),
        "raster_ms": raster_ms,
        "scan_ms": scan_ms,
        "total_ms": raster_ms + scan_ms,
        "params": params_out,
        "islands": filtered,
    });
    write_json(&output.join("result.json"), &result)?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        eprintln!("full: {} tris, {}x{}, {} layers, {} solid px", triangles.len(), gw, gh, nl, total_px);
        eprintln!("  raster={:.0}ms scan={:.0}ms total={:.0}ms", raster_ms, scan_ms, raster_ms + scan_ms);
        eprintln!("  islands: {} total, {} filtered", islands.len(), filtered.len());
    }
    Ok(())
}

fn cmd_island_bench(
    input: &PathBuf, px_mm: f64, layer_height: f64, buffer: f64,
    connectivity: u8, overlap: i32, neighborhood: i32, min_area: f64,
    iterations: u32, json_output: bool,
) -> Result<(), String> {
    let flat = load_binary_stl(input)?;
    let triangles = parse_triangles(&flat);
    let bbox = compute_bbox(&triangles);
    let conn = if connectivity == 8 { Connectivity::Eight } else { Connectivity::Four };

    if !json_output {
        eprintln!("Benchmarking: {} ({} triangles)", input.display(), triangles.len());
        eprintln!("  px_mm={} layer_h={} buffer={} conn={} overlap={} neighborhood={}",
            px_mm, layer_height, buffer, connectivity, overlap, neighborhood);
        eprintln!("  {} iterations, reporting best\n", iterations);
    }

    let mut best_read_ms = f64::MAX;
    let mut best_raster_ms = f64::MAX;
    let mut best_scan_ms = f64::MAX;
    let mut best_track_ms = f64::MAX;
    let mut best_analyze_ms = f64::MAX;
    let mut best_total_ms = f64::MAX;
    let mut final_layers = 0usize;
    let mut final_grid = (0i32, 0i32);
    let mut final_solid_px = 0u64;
    let mut final_islands_total = 0usize;
    let mut final_islands_filtered = 0usize;

    for iter in 0..iterations {
        let t0 = Instant::now();
        let flat2 = load_binary_stl(input)?;
        let tris = parse_triangles(&flat2);
        let read_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let t1 = Instant::now();
        let (masks, gw, gh, nl, _ox, _oz) = rasterize_for_island_scan(
            &tris,
            bbox.min_x as f64, bbox.max_x as f64,
            bbox.min_y as f64, bbox.max_y as f64,
            bbox.min_z as f64, bbox.max_z as f64,
            px_mm, layer_height,
        );
        let raster_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = Instant::now();
        let mut layer_results = Vec::with_capacity(nl);
        for (i, mask) in masks.iter().enumerate() {
            let prev = if i > 0 { Some(&masks[i - 1]) } else { None };
            layer_results.push(scan_layer(mask, prev, px_mm, buffer, conn));
        }
        let scan_ms = t2.elapsed().as_secs_f64() * 1000.0;

        let t3 = Instant::now();
        let mut tracker = IslandTracker::new(px_mm, overlap, neighborhood);
        let mut island_labels: Vec<RleLabels> = Vec::with_capacity(nl);
        for (l, lr) in layer_results.iter().enumerate() {
            let prev = if l > 0 { Some(&island_labels[l - 1]) } else { None };
            let il = tracker.process_layer(l as u32, &lr.labels, &lr.components, prev, &lr.solid_mask);
            island_labels.push(il);
        }
        tracker.finalize_islands(nl.saturating_sub(1) as u32);
        let mut islands = tracker.get_islands();
        let track_ms = t3.elapsed().as_secs_f64() * 1000.0;

        let t4 = Instant::now();
        for island in &mut islands {
            let vol: f64 = island.per_layer_area_mm2.values().map(|&a| a * layer_height).sum();
            island.volume_mm3 = Some(vol);
            let max_a = island.per_layer_area_mm2.values().copied().fold(0.0_f64, f64::max);
            island.max_area_mm2 = Some(max_a);
            island.compute_centroid();
        }
        let filtered_count = islands.iter()
            .filter(|i| !i.is_merged_placeholder && i.max_area_mm2.unwrap_or(0.0) >= min_area)
            .count();
        let analyze_ms = t4.elapsed().as_secs_f64() * 1000.0;

        let total_ms = read_ms + raster_ms + scan_ms + track_ms + analyze_ms;
        if total_ms < best_total_ms {
            best_read_ms = read_ms;
            best_raster_ms = raster_ms;
            best_scan_ms = scan_ms;
            best_track_ms = track_ms;
            best_analyze_ms = analyze_ms;
            best_total_ms = total_ms;
            final_layers = nl;
            final_grid = (gw, gh);
            final_solid_px = masks.iter().map(|m| m.pixel_count()).sum();
            final_islands_total = islands.len();
            final_islands_filtered = filtered_count;
        }

        if !json_output {
            eprintln!("  iter {}: read={:.0} raster={:.0} scan={:.0} track={:.0} analyze={:.0} total={:.0}ms",
                iter + 1, read_ms, raster_ms, scan_ms, track_ms, analyze_ms, total_ms);
        }
    }

    if json_output {
        let result = serde_json::json!({
            "stl": input.display().to_string(),
            "triangles": triangles.len(),
            "grid": { "width": final_grid.0, "height": final_grid.1 },
            "layers": final_layers,
            "solid_pixels": final_solid_px,
            "islands_total": final_islands_total,
            "islands_filtered": final_islands_filtered,
            "iterations": iterations,
            "best_ms": {
                "read_stl": best_read_ms,
                "rasterize": best_raster_ms,
                "scan": best_scan_ms,
                "track": best_track_ms,
                "analyze": best_analyze_ms,
                "total": best_total_ms,
            },
            "throughput": {
                "layers_per_sec": final_layers as f64 / (best_total_ms / 1000.0),
                "mpx_per_sec": final_solid_px as f64 / (best_total_ms / 1000.0) / 1e6,
            },
            "params": {
                "px_mm": px_mm, "layer_height_mm": layer_height,
                "support_buffer_mm": buffer, "connectivity": connectivity,
                "min_overlap_px": overlap, "overlap_neighborhood_px": neighborhood,
                "min_island_area_mm2": min_area,
            },
        });
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        eprintln!();
        eprintln!("=== Best of {} ============================", iterations);
        eprintln!("  read-stl:    {:>8.1} ms", best_read_ms);
        eprintln!("  rasterize:   {:>8.1} ms", best_raster_ms);
        eprintln!("  scan:        {:>8.1} ms", best_scan_ms);
        eprintln!("  track:       {:>8.1} ms", best_track_ms);
        eprintln!("  analyze:     {:>8.1} ms", best_analyze_ms);
        eprintln!("  -------------------------");
        eprintln!("  total:       {:>8.1} ms", best_total_ms);
        eprintln!();
        eprintln!("  {}x{} grid, {} layers, {} solid px", final_grid.0, final_grid.1, final_layers, final_solid_px);
        eprintln!("  {} islands ({} filtered)", final_islands_total, final_islands_filtered);
        eprintln!("  {:.0} layers/s, {:.1} Mpx/s",
            final_layers as f64 / (best_total_ms / 1000.0),
            final_solid_px as f64 / (best_total_ms / 1000.0) / 1e6);
    }
    Ok(())
}

// ===========================================================================
// Island RLE debug commands — wraps islands::rle
// ===========================================================================

fn cmd_rle_label(input: &PathBuf, output: &PathBuf, connectivity: u8, json_output: bool) -> Result<(), String> {
    ensure_dir(output)?;
    let mask = read_rle_mask_json(input)?;
    let conn = if connectivity == 8 { Connectivity::Eight } else { Connectivity::Four };
    let (labels, components) = rle::rle_label_components(&mask, conn);

    write_rle_labels_json(&output.join("labels.rle.json"), &labels)?;
    write_json(&output.join("components.json"), &components)?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "components": components.len(),
            "connectivity": connectivity,
            "grid": { "width": mask.width, "height": mask.height },
        })).unwrap());
    } else {
        eprintln!("rle-label: {} components ({}x{}, {}-connected)",
            components.len(), mask.width, mask.height, connectivity);
    }
    Ok(())
}

fn cmd_rle_subtract(mask_a: &PathBuf, mask_b: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let a = read_rle_mask_json(mask_a)?;
    let b = read_rle_mask_json(mask_b)?;
    let result = rle::rle_subtract(&a, &b);
    write_rle_mask_json(output, &result)?;
    eprintln!("rle-subtract: {} px - {} px = {} px",
        a.pixel_count(), b.pixel_count(), result.pixel_count());
    Ok(())
}

// ===========================================================================
// Slice command implementations — wraps engine::slice_with_progress_v3_to_path
// ===========================================================================

fn cmd_slice_run(
    input: &PathBuf,
    output: &PathBuf,
    layer_height: f32,
    build_width_mm: f32,
    build_depth_mm: f32,
    source_width_px: u32,
    source_height_px: u32,
    png_compression: &str,
    anti_aliasing: &str,
    x_packing_mode: &str,
    mirror_x: bool,
    mirror_y: bool,
    format_version: &Option<String>,
    min_aa_alpha: f32,
    metadata_json: &str,
    json_output: bool,
) -> Result<(), String> {
    let width_px = match x_packing_mode {
        "none" => source_width_px,
        "rgb8_div3" => {
            if source_width_px % 3 != 0 {
                return Err(format!(
                    "source_width_px ({source_width_px}) must be divisible by 3 for x_packing_mode=rgb8_div3"
                ));
            }
            source_width_px / 3
        }
        "gray3_div2" => {
            if source_width_px % 2 != 0 {
                return Err(format!(
                    "source_width_px ({source_width_px}) must be divisible by 2 for x_packing_mode=gray3_div2"
                ));
            }
            source_width_px / 2
        }
        other => {
            return Err(format!(
                "Invalid x_packing_mode '{other}': expected one of none, rgb8_div3, gray3_div2"
            ));
        }
    };
    use dragonfruit_slicing_engine::engine::slice_with_progress_v3_to_path;
    use dragonfruit_slicing_engine::types::SliceJobV3;

    // Same flow as Tauri's slice_solid_native_to_temp_path:
    // load STL or positions.bin → build SliceJobV3 → dispatch to engine
    let is_positions_bin = input.extension()
        .and_then(|e| e.to_str())
        .map(|e| e == "bin")
        .unwrap_or(false);

    let flat = if is_positions_bin {
        read_positions_bin(input)?
    } else {
        load_binary_stl(input)?
    };
    if flat.len() % 9 != 0 {
        return Err(format!("Invalid triangle buffer length: {}", flat.len()));
    }

    let triangles = parse_triangles(&flat);
    let bbox = compute_bbox(&triangles);

    let model_height = bbox.max_z - bbox.min_z;
    let total_layers = (model_height / layer_height).ceil() as u32;
    if total_layers == 0 {
        return Err("Model has zero height".into());
    }

    // Determine output format from extension (same as Tauri: ext → find_encoder)
    let ext = output.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_else(|| ".nanodlp".to_string());

    let job = SliceJobV3 {
        output_format: ext.clone(),
        source_width_px,
        source_height_px,
        width_px,
        height_px: source_height_px,
        x_packing_mode: x_packing_mode.to_string(),
        build_width_mm,
        build_depth_mm,
        layer_height_mm: layer_height,
        total_layers,
        export_thumbnail_png_base64: None,
        png_compression_strategy: png_compression.to_string(),
        container_compression_level: 2,
        anti_aliasing_level: anti_aliasing.to_string(),
        anti_aliasing_mode: "Blur".to_string(),
        blur_brush_radius_px: 1,
        aa_on_supports: false,
        model_triangle_count: (flat.len() / 9) as u32,
        mirror_x,
        mirror_y,
        triangles_xyz: flat,
        metadata_json: metadata_json.to_string(),
        format_version: format_version.clone(),
        minimum_aa_alpha_percent: min_aa_alpha,
    };

    let t0 = Instant::now();
    let perf = slice_with_progress_v3_to_path(&job, output, None, None)
        .map_err(|e| format!("Slice failed: {e}"))?;
    let wall_s = t0.elapsed().as_secs_f64();

    let result = serde_json::json!({
        "output": output.display().to_string(),
        "format": ext,
        "layers": total_layers,
        "layer_height_mm": layer_height,
        "build_width_mm": build_width_mm,
        "build_depth_mm": build_depth_mm,
        "resolution_px": [source_width_px, source_height_px],
        "total_s": perf.total_s(),
        "wall_s": wall_s,
        "layers_per_second": perf.layers_per_second(),
        "perf": {
            "total_ns": perf.total_ns,
            "index_build_ns": perf.index_build_ns,
            "render_wall_ns": perf.render_wall_ns,
            "render_ns": perf.render_ns,
            "png_encode_ns": perf.png_encode_ns,
            "archive_encode_ns": perf.archive_encode_ns,
        },
    });

    if json_output {
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        eprintln!("slice: {} layers, {:.2}s ({:.0} layers/s) -> {}",
            total_layers, perf.total_s(), perf.layers_per_second(), output.display());
    }
    Ok(())
}

/// Extract layer PNG from ZIP archive — same logic as Tauri's read_print_layer_png
fn extract_layer_png(archive_path: &PathBuf, layer: u32, output: &PathBuf) -> Result<(), String> {
    if layer == 0 {
        return Err("Layer number must be >= 1".into());
    }

    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("Failed to open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP: {e}"))?;

    // Tauri uses "{layer}.png" (1-based)
    let entry_name = format!("{}.png", layer);

    // Collect file listing first (before borrowing archive mutably for entry read)
    let file_listing: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
        .take(20)
        .collect();

    let mut entry = archive
        .by_name(&entry_name)
        .map_err(|_| format!("Layer '{}' not found. Available: {}", entry_name, file_listing.join(", ")))?;

    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read entry: {e}"))?;

    std::fs::write(output, &buf)
        .map_err(|e| format!("Failed to write PNG: {e}"))?;

    eprintln!("extract: layer {} ({} bytes) -> {}", layer, buf.len(), output.display());
    Ok(())
}

fn cmd_slice_formats() {
    use dragonfruit_slicing_engine::encoders::registry::{find_encoder, supported_output_formats};

    let format_names = supported_output_formats();
    let mut formats = Vec::new();

    for name in &format_names {
        if let Some(enc) = find_encoder(name) {
            let mut info = serde_json::json!({
                "extension": name,
                "requires_area_stats": enc.requires_area_stats(),
                "requires_png_layers": enc.requires_png_layers(),
                "requires_raw_mask_layers": enc.requires_raw_mask_layers(),
            });
            // Add known version info for specific formats
            match *name {
                ".ctb" => { info["versions"] = serde_json::json!(["v4", "v5", "v5enc"]); }
                _ => {}
            }
            formats.push(info);
        }
    }

    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "formats": formats,
    })).unwrap());
}

fn cmd_print_inspect(input: &PathBuf, json_output: bool) -> Result<(), String> {
    let file = std::fs::File::open(input)
        .map_err(|e| format!("Failed to open: {e}"))?;
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Not a valid ZIP archive: {e}"))?;

    let total_entries = archive.len();
    let mut layer_count = 0u32;
    let mut total_uncompressed = 0u64;
    let mut entries_info: Vec<serde_json::Value> = Vec::new();
    let mut manifest: Option<serde_json::Value> = None;

    let mut manifest_index: Option<usize> = None;

    for i in 0..total_entries {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            let size = entry.size();
            total_uncompressed += size;

            if name.ends_with(".png") {
                layer_count += 1;
            }
            if name == "manifest.json" || name == "metadata.json" {
                manifest_index = Some(i);
            }

            entries_info.push(serde_json::json!({
                "name": name,
                "size": size,
            }));
        }
    }

    // Second pass: read manifest if found
    if let Some(idx) = manifest_index {
        if let Ok(mut entry) = archive.by_index(idx) {
            let mut content = String::new();
            std::io::Read::read_to_string(&mut entry, &mut content).ok();
            manifest = serde_json::from_str(&content).ok();
        }
    }

    let compression_ratio = if total_uncompressed > 0 {
        file_size as f64 / total_uncompressed as f64
    } else {
        1.0
    };

    if json_output {
        let mut result = serde_json::json!({
            "file": input.display().to_string(),
            "file_size_bytes": file_size,
            "format": "zip",
            "total_entries": total_entries,
            "layer_count": layer_count,
            "total_uncompressed_bytes": total_uncompressed,
            "compression_ratio": format!("{:.2}", compression_ratio),
        });
        if let Some(m) = &manifest {
            result["manifest"] = m.clone();
        }
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        eprintln!("inspect: {}", input.display());
        eprintln!("  format: ZIP ({} entries)", total_entries);
        eprintln!("  layers: {}", layer_count);
        eprintln!("  size: {} bytes (uncompressed: {}, ratio: {:.2})",
            file_size, total_uncompressed, compression_ratio);
        if manifest.is_some() {
            eprintln!("  manifest: present");
        }
    }
    Ok(())
}

fn cmd_island_batch(
    inputs: &[PathBuf],
    output: &PathBuf,
    px_mm: f64, layer_height: f64, buffer: f64, connectivity: u8,
    overlap: i32, neighborhood: i32, min_area: f64,
    json_output: bool,
) -> Result<(), String> {
    ensure_dir(output)?;

    let mut results = Vec::new();

    for input in inputs {
        let t0 = Instant::now();
        let sub_output = output.join(
            input.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
        );

        match cmd_island_full(
            input, &sub_output,
            px_mm, layer_height, buffer, connectivity,
            overlap, neighborhood, min_area,
            &None, false, // no params_json, no json (we collect results ourselves)
        ) {
            Ok(()) => {
                let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
                // Read result.json from the sub-output
                let result_path = sub_output.join("result.json");
                let result: serde_json::Value = if result_path.exists() {
                    read_json(&result_path)?
                } else {
                    serde_json::json!({"error": "no result.json"})
                };
                let mut entry = serde_json::json!({
                    "stl": input.display().to_string(),
                    "elapsed_ms": elapsed_ms,
                });
                if let Some(obj) = result.as_object() {
                    for (k, v) in obj {
                        entry[k] = v.clone();
                    }
                }
                results.push(entry);
            }
            Err(e) => {
                results.push(serde_json::json!({
                    "stl": input.display().to_string(),
                    "error": e,
                }));
            }
        }
    }

    if json_output {
        println!("{}", serde_json::to_string_pretty(&results).unwrap());
    } else {
        for r in &results {
            let stl = r["stl"].as_str().unwrap_or("?");
            if let Some(e) = r["error"].as_str() {
                eprintln!("  {} ERROR: {}", stl, e);
            } else {
                let filtered = r["islands_filtered"].as_u64().unwrap_or(0);
                let ms = r["elapsed_ms"].as_f64().unwrap_or(0.0);
                eprintln!("  {} {} islands {:.0}ms", stl, filtered, ms);
            }
        }
    }
    Ok(())
}

fn cmd_slice_info() {
    use dragonfruit_slicing_engine::encoders::registry::supported_output_formats;
    let formats = supported_output_formats();

    let info = serde_json::json!({
        "supported_formats": formats,
        "defaults": {
            "layer_height_mm": 0.05,
            "build_width_mm": 218.0,
            "build_depth_mm": 122.0,
            "source_width_px": 11400,
            "source_height_px": 6400,
            "png_compression": "balanced",
            "container_compression_level": 2,
            "anti_aliasing": "Off",
        },
    });
    println!("{}", serde_json::to_string_pretty(&info).unwrap());
}

// ===========================================================================
// Print command implementations — wraps Tauri temp-artifact ops
// ===========================================================================

/// Same safety check as Tauri's is_dragonfruit_temp_artifact
fn is_dragonfruit_temp_artifact(path: &std::path::Path) -> bool {
    let file_name_ok = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("dragonfruit-slice-"))
        .unwrap_or(false);
    let in_temp_dir = path.starts_with(std::env::temp_dir());
    file_name_ok && in_temp_dir
}

/// Same logic as Tauri's sweep_stale_temp_artifacts
fn sweep_stale_temp_artifacts(max_age_seconds: u64) -> u32 {
    let mut removed = 0u32;
    let temp_dir = std::env::temp_dir();
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(max_age_seconds))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

    let entries = match std::fs::read_dir(&temp_dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_dragonfruit_temp_artifact(&path) {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|modified| modified <= cutoff)
            .unwrap_or(false);
        if stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Same logic as Tauri's sweep_all_temp_artifacts
fn sweep_all_temp_artifacts() -> u32 {
    let mut removed = 0u32;
    let temp_dir = std::env::temp_dir();
    let entries = match std::fs::read_dir(&temp_dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_dragonfruit_temp_artifact(&path) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn cmd_print_save(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    // Same as Tauri save_print_file_from_path (minus dialog)
    if !input.exists() {
        return Err("Source print file no longer exists on disk".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating destination folder: {e}"))?;
    }
    std::fs::copy(input, output)
        .map_err(|e| format!("Failed saving print file: {e}"))?;
    eprintln!("print save: {} -> {}", input.display(), output.display());
    Ok(())
}

fn cmd_print_read_bytes(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    // Same as Tauri read_print_file_bytes
    if !input.exists() {
        return Err("Source print file no longer exists on disk".into());
    }
    let bytes = std::fs::read(input)
        .map_err(|e| format!("Failed reading print file: {e}"))?;
    std::fs::write(output, &bytes)
        .map_err(|e| format!("Failed writing: {e}"))?;
    eprintln!("read-bytes: {} bytes -> {}", bytes.len(), output.display());
    Ok(())
}

fn cmd_print_cleanup(path: &Option<PathBuf>, all: bool, max_age_seconds: Option<u64>) -> Result<(), String> {
    if let Some(p) = path {
        // Same as Tauri delete_print_temp_file — refuses non-dragonfruit artifacts
        if !p.exists() {
            eprintln!("cleanup: file does not exist");
            return Ok(());
        }
        if !is_dragonfruit_temp_artifact(p) {
            return Err("Refusing to delete non-DragonFruit temp artifact path".into());
        }
        std::fs::remove_file(p).map_err(|e| format!("Failed deleting temp artifact: {e}"))?;
        eprintln!("cleanup: deleted {}", p.display());
    } else if all {
        let removed = sweep_all_temp_artifacts();
        eprintln!("cleanup --all: removed {} temp files", removed);
    } else if let Some(age) = max_age_seconds {
        let removed = sweep_stale_temp_artifacts(age.max(60));
        eprintln!("cleanup --max-age-seconds {}: removed {} stale files", age, removed);
    } else {
        eprintln!("cleanup: specify --path, --all, or --max-age-seconds");
    }
    Ok(())
}

// ===========================================================================
// Info
// ===========================================================================

fn cmd_benchmark(
    layers: u32, width_px: u32, height_px: u32,
    build_width_mm: f32, build_depth_mm: f32, layer_height: f32,
    cube_count: u32, json_output: bool,
) -> Result<(), String> {
    use dragonfruit_slicing_engine::benchmark::{run_benchmark_v3, BenchmarkConfigV3};

    let cfg = BenchmarkConfigV3 {
        layers,
        source_width_px: width_px,
        source_height_px: height_px,
        output_width_px: width_px,
        output_height_px: height_px,
        build_width_mm,
        build_depth_mm,
        layer_height_mm: layer_height,
        cube_count,
    };

    if !json_output {
        eprintln!("benchmark: {}x{} px, {} layers, {} cubes", width_px, height_px, layers, cube_count);
    }

    let result = run_benchmark_v3(cfg).map_err(|e| format!("Benchmark failed: {e}"))?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "artifact_bytes": result.artifact_bytes,
            "total_s": result.total_s,
            "layers_per_second": result.layers_per_second,
            "render_s": result.render_s,
            "png_s": result.png_s,
            "archive_s": result.archive_s,
            "config": {
                "layers": layers,
                "width_px": width_px,
                "height_px": height_px,
                "build_width_mm": build_width_mm,
                "build_depth_mm": build_depth_mm,
                "layer_height_mm": layer_height,
                "cube_count": cube_count,
            },
        })).unwrap());
    } else {
        eprintln!("  total: {:.2}s ({:.0} layers/s)", result.total_s, result.layers_per_second);
        eprintln!("  render: {:.2}s, png: {:.2}s, archive: {:.2}s",
            result.render_s, result.png_s, result.archive_s);
        eprintln!("  artifact: {} bytes", result.artifact_bytes);
    }
    Ok(())
}

fn cmd_info() {
    use dragonfruit_slicing_engine::encoders::registry::supported_output_formats;
    let formats = supported_output_formats();

    let info = serde_json::json!({
        "name": "dragonfruit-cli",
        "version": env!("CARGO_PKG_VERSION"),
        "commands": ["mesh", "island", "slice", "print", "info"],
        "supported_formats": formats,
        "island_defaults": {
            "px_mm": 0.1,
            "layer_height": 0.05,
            "buffer": 0.6,
            "connectivity": 4,
            "overlap": 4,
            "neighborhood": 1,
            "min_area": 0.0,
        },
        "slice_defaults": {
            "layer_height_mm": 0.05,
            "build_width_mm": 218.0,
            "build_depth_mm": 122.0,
            "source_width_px": 11400,
            "source_height_px": 6400,
        },
    });
    println!("{}", serde_json::to_string_pretty(&info).unwrap());
}

// ===========================================================================
// Main
// ===========================================================================

fn main() {
    let cli = Cli::parse();
    let t0 = Instant::now();

    let command_label = match &cli.command {
        Commands::Mesh { command } => match command {
            MeshCommands::ReadStl { .. } => "mesh read-stl",
            MeshCommands::Info { .. } => "mesh info",
            MeshCommands::ExportStl { .. } => "mesh export-stl",
            MeshCommands::Export3mf { .. } => "mesh export-3mf",
        },
        Commands::Benchmark { .. } => "benchmark",
        Commands::Island { command } => match command {
            IslandCommands::Rasterize { .. } => "island rasterize",
            IslandCommands::Scan { .. } => "island scan",
            IslandCommands::Track { .. } => "island track",
            IslandCommands::Analyze { .. } => "island analyze",
            IslandCommands::Full { .. } => "island full",
            IslandCommands::Bench { .. } => "island bench",
            IslandCommands::Batch { .. } => "island batch",
            IslandCommands::RleLabel { .. } => "island rle-label",
            IslandCommands::RleSubtract { .. } => "island rle-subtract",
        },
        Commands::Slice { command } => match command {
            SliceCommands::Run { .. } => "slice run",
            SliceCommands::PreviewLayer { .. } => "slice preview-layer",
            SliceCommands::Formats => "slice formats",
            SliceCommands::Info => "slice info",
        },
        Commands::Print { command } => match command {
            PrintCommands::Save { .. } => "print save",
            PrintCommands::ReadBytes { .. } => "print read-bytes",
            PrintCommands::ReadLayer { .. } => "print read-layer",
            PrintCommands::Inspect { .. } => "print inspect",
            PrintCommands::Cleanup { .. } => "print cleanup",
        },
        Commands::Info => "info",
    };

    let result = match cli.command {
        Commands::Mesh { command } => match command {
            MeshCommands::ReadStl { input, output } => cmd_mesh_read_stl(&input, &output),
            MeshCommands::Info { input, json } => cmd_mesh_info(&input, json),
            MeshCommands::ExportStl { input, output } => cmd_mesh_export_stl(&input, &output),
            MeshCommands::Export3mf { input, output } => cmd_mesh_export_3mf(&input, &output),
        },

        Commands::Benchmark { layers, width_px, height_px, build_width_mm, build_depth_mm,
            layer_height, cube_count, json } =>
            cmd_benchmark(layers, width_px, height_px, build_width_mm, build_depth_mm,
                layer_height, cube_count, json),

        Commands::Island { command } => match command {
            IslandCommands::Rasterize { input, output, px_mm, layer_height } =>
                cmd_rasterize(&input, &output, px_mm, layer_height),
            IslandCommands::Scan { input, output, buffer, connectivity } =>
                cmd_scan(&input, &output, buffer, connectivity),
            IslandCommands::Track { input, output, overlap, neighborhood } =>
                cmd_track(&input, &output, overlap, neighborhood),
            IslandCommands::Analyze { input, output, min_area } =>
                cmd_analyze(&input, &output, min_area),
            IslandCommands::Full { input, output, px_mm, layer_height, buffer, connectivity,
                overlap, neighborhood, min_area, params_json, json } =>
                cmd_island_full(&input, &output, px_mm, layer_height, buffer, connectivity,
                    overlap, neighborhood, min_area, &params_json, json),
            IslandCommands::Bench { input, px_mm, layer_height, buffer, connectivity,
                overlap, neighborhood, min_area, iterations, json } =>
                cmd_island_bench(&input, px_mm, layer_height, buffer, connectivity,
                    overlap, neighborhood, min_area, iterations, json),
            IslandCommands::Batch { inputs, output, px_mm, layer_height, buffer, connectivity,
                overlap, neighborhood, min_area, json } =>
                cmd_island_batch(&inputs, &output, px_mm, layer_height, buffer, connectivity,
                    overlap, neighborhood, min_area, json),
            IslandCommands::RleLabel { input, output, connectivity, json } =>
                cmd_rle_label(&input, &output, connectivity, json),
            IslandCommands::RleSubtract { mask_a, mask_b, output } =>
                cmd_rle_subtract(&mask_a, &mask_b, &output),
        },

        Commands::Slice { command } => match command {
            SliceCommands::Run { input, output, layer_height, build_width_mm, build_depth_mm,
                source_width_px, source_height_px, png_compression, anti_aliasing,
                x_packing_mode, mirror_x, mirror_y, format_version, min_aa_alpha, metadata_json, json } =>
                cmd_slice_run(&input, &output, layer_height, build_width_mm, build_depth_mm,
                    source_width_px, source_height_px, &png_compression, &anti_aliasing,
                    &x_packing_mode, mirror_x, mirror_y, &format_version, min_aa_alpha, &metadata_json, json),
            SliceCommands::Formats => { cmd_slice_formats(); Ok(()) },
            SliceCommands::PreviewLayer { input, layer, output } =>
                extract_layer_png(&input, layer, &output),
            SliceCommands::Info => { cmd_slice_info(); Ok(()) },
        },

        Commands::Print { command } => match command {
            PrintCommands::Save { input, output } => cmd_print_save(&input, &output),
            PrintCommands::ReadBytes { input, output } => cmd_print_read_bytes(&input, &output),
            PrintCommands::ReadLayer { input, layer, output } =>
                extract_layer_png(&input, layer, &output),
            PrintCommands::Inspect { input, json } => cmd_print_inspect(&input, json),
            PrintCommands::Cleanup { path, all, max_age_seconds } =>
                cmd_print_cleanup(&path, all, max_age_seconds),
        },

        Commands::Info => { cmd_info(); Ok(()) },
    };

    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;

    match &result {
        Ok(()) => eprintln!("  [{}] {:.1}ms", command_label, elapsed_ms),
        Err(e) => {
            eprintln!("  [{}] FAILED {:.1}ms", command_label, elapsed_ms);
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}
