//! `dragonfruit-mesh-repair` CLI. Useful for benchmarking, batch repair,
//! and CI golden-file checks.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

use dragonfruit_mesh_repair::{
    analyze_path, io::write_positions_file, reconstruct_supports_path, repair_path, RepairOptions,
    SupportReconstructionOptions,
};

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
        #[arg(long, default_value_t = true)]
        solidify_fragmented_components: bool,
        #[arg(long, default_value_t = 256)]
        solidify_component_threshold: usize,
        #[arg(long, default_value_t = 128)]
        solidify_self_intersection_threshold: usize,
    },
    /// Analyze separate model/support meshes and emit reconstruction diagnostics.
    ReconstructSupports {
        /// Model mesh used for future contact projection.
        model: PathBuf,
        /// Baked support-only mesh to analyze.
        support: PathBuf,
        /// Build-plane Z in the input meshes' coordinate system.
        #[arg(long, default_value_t = 0.0)]
        plate_z: f32,
        /// Output JSON path. If omitted, diagnostics are printed to stdout.
        #[arg(long)]
        out_report: Option<PathBuf>,
        #[arg(long)]
        pretty: bool,
        #[arg(long, default_value_t = 1e-5)]
        weld_epsilon_relative: f32,
        #[arg(long, default_value_t = 0.25)]
        plate_tolerance_mm: f32,
        #[arg(long, default_value_t = 8)]
        min_component_triangles: usize,
        #[arg(long, default_value_t = 0.55)]
        min_axial_confidence: f32,
        #[arg(long, default_value_t = 0.75)]
        model_contact_tolerance_mm: f32,
        #[arg(long, default_value_t = 0.5)]
        min_endpoint_confidence: f32,
        #[arg(long, default_value_t = 0.6)]
        support_attachment_tolerance_mm: f32,
        #[arg(long, default_value_t = 0.55)]
        min_attachment_confidence: f32,
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
            solidify_fragmented_components,
            solidify_component_threshold,
            solidify_self_intersection_threshold,
        } => {
            let options = RepairOptions {
                weld_epsilon,
                fill_holes_max_edges,
                keep_largest_n_components: keep_largest_n,
                repair_orientation,
                resolve_self_intersections,
                solidify_fragmented_components,
                solidify_component_threshold,
                solidify_self_intersection_threshold,
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
        Command::ReconstructSupports {
            model,
            support,
            plate_z,
            out_report,
            pretty,
            weld_epsilon_relative,
            plate_tolerance_mm,
            min_component_triangles,
            min_axial_confidence,
            model_contact_tolerance_mm,
            min_endpoint_confidence,
            support_attachment_tolerance_mm,
            min_attachment_confidence,
        } => {
            let options = SupportReconstructionOptions {
                weld_epsilon_relative,
                plate_tolerance_mm,
                min_component_triangles,
                min_axial_confidence,
                model_contact_tolerance_mm,
                min_endpoint_confidence,
                support_attachment_tolerance_mm,
                min_attachment_confidence,
                ..SupportReconstructionOptions::default()
            };
            let result = reconstruct_supports_path(model, support, plate_z, &options)?;
            let serialized = if pretty {
                serde_json::to_string_pretty(&result)?
            } else {
                serde_json::to_string(&result)?
            };
            match out_report {
                Some(path) => std::fs::write(path, serialized)?,
                None => println!("{serialized}"),
            }
        }
    }
    Ok(())
}
