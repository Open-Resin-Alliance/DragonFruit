//! `dragonfruit-mesh-repair` CLI. Useful for benchmarking, batch repair,
//! and CI golden-file checks.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

use dragonfruit_mesh_repair::{analyze_path, io::write_positions_file, repair_path, RepairOptions};

#[derive(Debug, Parser)]
#[command(
    name = "dragonfruit-mesh-repair",
    about = "DragonFruit mesh repair engine"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Analyze a mesh and print a JSON diagnostic report.
    Analyze {
        input: PathBuf,
        #[arg(long)]
        pretty: bool,
    },
    /// Run the full repair pipeline and emit repaired mesh + report.
    Repair {
        input: PathBuf,
        /// Output binary STL path. If omitted, only the JSON report is produced.
        #[arg(long)]
        out_stl: Option<PathBuf>,
        /// Output raw staged positions (LE f32, 9 per tri). Optional.
        #[arg(long)]
        out_positions: Option<PathBuf>,
        /// Output JSON report path. If omitted, the report is printed to stdout.
        #[arg(long)]
        out_report: Option<PathBuf>,
        #[arg(long)]
        pretty: bool,
        #[arg(long, default_value_t = 1e-5)]
        weld_epsilon: f32,
        #[arg(long, default_value_t = 64)]
        fill_holes_max_edges: usize,
        #[arg(long)]
        keep_largest_n: Option<usize>,
        #[arg(long, default_value_t = true)]
        repair_orientation: bool,
        #[arg(long, default_value_t = false)]
        resolve_self_intersections: bool,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Analyze { input, pretty } => {
            let report = analyze_path(input)?;
            let s = if pretty {
                serde_json::to_string_pretty(&report)?
            } else {
                serde_json::to_string(&report)?
            };
            println!("{s}");
        }
        Command::Repair {
            input,
            out_stl,
            out_positions,
            out_report,
            pretty,
            weld_epsilon,
            fill_holes_max_edges,
            keep_largest_n,
            repair_orientation,
            resolve_self_intersections,
        } => {
            let options = RepairOptions {
                weld_epsilon,
                fill_holes_max_edges,
                keep_largest_n_components: keep_largest_n,
                repair_orientation,
                resolve_self_intersections,
            };
            let outcome = repair_path(&input, &options)?;
            if let Some(p) = &out_stl {
                dragonfruit_mesh_repair::io::stl::write_binary(&outcome.mesh, p)?;
            }
            if let Some(p) = &out_positions {
                write_positions_file(&outcome.mesh, p)?;
            }
            let s = if pretty {
                serde_json::to_string_pretty(&outcome.report)?
            } else {
                serde_json::to_string(&outcome.report)?
            };
            match out_report {
                Some(p) => std::fs::write(p, s)?,
                None => println!("{s}"),
            }
        }
    }
    Ok(())
}
