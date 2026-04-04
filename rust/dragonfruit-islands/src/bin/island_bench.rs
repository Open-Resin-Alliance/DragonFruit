//! Island detection speed benchmark.
//!
//! Usage:
//!   cargo run --release --bin island_bench

use dragonfruit_islands::model::*;
use dragonfruit_islands::pipeline::run_island_scan;
use dragonfruit_islands::rle::rle_encode;
use std::time::Instant;

struct BenchCase {
    name: &'static str,
    width: i32,
    height: i32,
    num_layers: u32,
    masks: Vec<RleMask>,
}

fn gen_solid_block(w: i32, h: i32, layers: u32, x0: i32, y0: i32, x1: i32, y1: i32) -> BenchCase {
    let masks: Vec<RleMask> = (0..layers)
        .map(|_| {
            let mut data = vec![0u8; (w * h) as usize];
            for y in y0..y1 { for x in x0..x1 { data[(y * w + x) as usize] = 1; } }
            rle_encode(&data, w, h)
        })
        .collect();
    BenchCase { name: "", width: w, height: h, num_layers: layers, masks }
}

fn gen_two_blocks_merging(w: i32, h: i32, layers: u32) -> BenchCase {
    let mid = w / 2;
    let gap = 4;
    let masks: Vec<RleMask> = (0..layers).map(|l| {
        let mut data = vec![0u8; (w * h) as usize];
        let h4 = h / 4; let h34 = 3 * h / 4;
        for y in h4..h34 { for x in 2..(mid - gap) { data[(y * w + x) as usize] = 1; } }
        for y in h4..h34 { for x in (mid + gap)..(w - 2) { data[(y * w + x) as usize] = 1; } }
        if l as f32 > layers as f32 * 0.6 {
            for y in (h / 2 - 1)..(h / 2 + 1) { for x in 2..(w - 2) { data[(y * w + x) as usize] = 1; } }
        }
        rle_encode(&data, w, h)
    }).collect();
    BenchCase { name: "", width: w, height: h, num_layers: layers, masks }
}

fn gen_many_islands(w: i32, h: i32, layers: u32, count: i32) -> BenchCase {
    let n = (count as f64).sqrt().ceil() as i32;
    let dx = w / n; let dy = h / n; let pad = 2;
    let masks: Vec<RleMask> = (0..layers).map(|_| {
        let mut data = vec![0u8; (w * h) as usize];
        for iy in 0..n { for ix in 0..n {
            let x0 = ix * dx + pad; let y0 = iy * dy + pad;
            let x1 = (ix + 1) * dx - pad; let y1 = (iy + 1) * dy - pad;
            for y in y0..y1.min(h) { for x in x0..x1.min(w) { data[(y * w + x) as usize] = 1; } }
        }}
        rle_encode(&data, w, h)
    }).collect();
    BenchCase { name: "", width: w, height: h, num_layers: layers, masks }
}

fn make_job(case: &BenchCase) -> IslandScanJob {
    IslandScanJob {
        px_mm: 0.05, support_buffer_mm: 0.1,
        connectivity: Connectivity::Four, min_island_area_mm2: 0.0001,
        layer_height_mm: 0.05,
        grid: GridRef { origin_x: 0.0, origin_z: 0.0, width: case.width, height: case.height, px_mm: 0.05 },
        num_layers: case.num_layers, min_overlap_px: 1, overlap_neighborhood_px: 1,
    }
}

struct BenchResult { time_ms: f64, layers_per_sec: f64, mpx_per_sec: f64, island_count: usize }

fn bench_cpu(case: &BenchCase) -> BenchResult {
    let job = make_job(case);
    let _ = run_island_scan(&job, &case.masks, None);
    let mut best = f64::MAX;
    let mut result = None;
    for _ in 0..3 {
        let t0 = Instant::now();
        let r = run_island_scan(&job, &case.masks, None);
        let elapsed = t0.elapsed().as_secs_f64();
        if elapsed < best { best = elapsed; result = Some(r); }
    }
    let r = result.unwrap();
    let total_px: u64 = case.masks.iter().map(|m| m.pixel_count()).sum();
    BenchResult {
        time_ms: best * 1000.0, layers_per_sec: case.num_layers as f64 / best,
        mpx_per_sec: total_px as f64 / best / 1_000_000.0, island_count: r.islands.len(),
    }
}

fn main() {
    println!("Island Detection Speed Benchmark");
    println!("================================\n");

    let names = [
        "small_single_block (100x100, 50L)",
        "medium_single_block (500x500, 200L)",
        "large_single_block (1920x1080, 500L)",
        "medium_merge (500x500, 200L)",
        "many_islands_25 (500x500, 100L)",
        "stress_100_islands (1920x1080, 100L)",
    ];

    let mut cases = vec![
        gen_solid_block(100, 100, 50, 10, 10, 90, 90),
        gen_solid_block(500, 500, 200, 50, 50, 450, 450),
        gen_solid_block(1920, 1080, 500, 100, 100, 1820, 980),
        gen_two_blocks_merging(500, 500, 200),
        gen_many_islands(500, 500, 100, 25),
        gen_many_islands(1920, 1080, 100, 100),
    ];
    for (i, c) in cases.iter_mut().enumerate() { c.name = names[i]; }

    for case in &cases {
        println!("{}", case.name);
        let cpu = bench_cpu(case);
        println!("  CPU (rayon):     {:>8.3} ms  |  {:>6.0} layers/s  |  {:>7.1} Mpx/s  |  {} islands",
            cpu.time_ms, cpu.layers_per_sec, cpu.mpx_per_sec, cpu.island_count);
        println!();
    }
}
