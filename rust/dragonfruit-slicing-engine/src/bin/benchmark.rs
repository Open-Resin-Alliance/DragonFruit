//! CLI entrypoint for quick local V3 benchmark runs.

use dragonfruit_slicing_engine::benchmark::{run_benchmark_v3, BenchmarkConfigV3};

fn parse_arg_u32(args: &[String], name: &str, default: u32) -> u32 {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let mut cfg = BenchmarkConfigV3::default();
    cfg.layers = parse_arg_u32(&args, "--layers", cfg.layers);
    cfg.source_width_px = parse_arg_u32(&args, "--srcw", cfg.source_width_px);
    cfg.source_height_px = parse_arg_u32(&args, "--srch", cfg.source_height_px);
    cfg.output_width_px = parse_arg_u32(&args, "--outw", cfg.output_width_px);
    cfg.output_height_px = parse_arg_u32(&args, "--outh", cfg.output_height_px);
    cfg.cube_count = parse_arg_u32(&args, "--cubes", cfg.cube_count);

    match run_benchmark_v3(cfg) {
        Ok(r) => {
            println!("[V3Bench] artifact_bytes={} total_s={:.3} layers_per_second={:.3} render_s={:.3} png_s={:.3} archive_s={:.3}",
                r.artifact_bytes,
                r.total_s,
                r.layers_per_second,
                r.render_s,
                r.png_s,
                r.archive_s,
            );
        }
        Err(e) => {
            eprintln!("[V3Bench] error: {e}");
            std::process::exit(1);
        }
    }
}
