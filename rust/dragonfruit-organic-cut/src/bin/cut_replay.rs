//! Replay an organic cut captured from the app, outside the app.
//!
//! The Tauri command writes `cut-<n>.bin` (the staged mesh as raw LE f32 soup)
//! and `cut-<n>.json` (the cut options, loop points included) when `DF_CUT_DUMP`
//! names a directory. Together they are the whole input of a cut, so running them
//! here reproduces exactly what the user saw — with the `DF_CUT_DEBUG` trace on.
//!
//!     cargo run --features manifold --bin cut_replay -- /tmp/cuts/cut-0.bin /tmp/cuts/cut-0.json

use std::path::Path;

use dragonfruit_mesh_core::mesh::IndexedMesh;
use dragonfruit_organic_cut::{organic_cut, OrganicCutOptions};

/// Vertex merge distance the app's staged loader uses
/// (`dragonfruit_mesh_repair::io::DEFAULT_MERGE_EPSILON`). Must match, or the
/// replayed mesh is welded differently from the one the cut ran on.
const MERGE_EPSILON: f32 = 1e-5;

/// The triangle count of each connected shell of `mesh`, joined through shared
/// vertices.
fn shell_sizes(mesh: &IndexedMesh) -> Vec<usize> {
    let mut parent: Vec<u32> = (0..mesh.positions.len() as u32).collect();
    fn find(parent: &mut Vec<u32>, mut v: u32) -> u32 {
        while parent[v as usize] != v {
            parent[v as usize] = parent[parent[v as usize] as usize];
            v = parent[v as usize];
        }
        v
    }
    for t in &mesh.triangles {
        for k in 1..3 {
            let (a, b) = (find(&mut parent, t[0]), find(&mut parent, t[k]));
            if a != b {
                parent[a as usize] = b;
            }
        }
    }
    let mut count: std::collections::HashMap<u32, usize> = Default::default();
    for t in &mesh.triangles {
        *count.entry(find(&mut parent, t[0])).or_default() += 1;
    }
    count.into_values().collect()
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mesh_path, options_path, out_prefix) = match args.as_slice() {
        [m, o] => (m, o, None),
        [m, o, p] => (m, o, Some(p)),
        _ => return Err("usage: cut_replay <cut-N.bin> <cut-N.json> [out-prefix]".to_string()),
    };

    let bytes = std::fs::read(Path::new(mesh_path)).map_err(|e| format!("{mesh_path}: {e}"))?;
    let floats: &[f32] = bytemuck::try_cast_slice(&bytes).map_err(|e| format!("{mesh_path}: {e}"))?;
    let mesh = IndexedMesh::from_triangle_soup(floats, MERGE_EPSILON);
    let json = std::fs::read_to_string(Path::new(options_path))
        .map_err(|e| format!("{options_path}: {e}"))?;
    let options: OrganicCutOptions =
        serde_json::from_str(&json).map_err(|e| format!("{options_path}: {e}"))?;

    let bbox = mesh.bbox();
    eprintln!(
        "[cut] model: {} tris, {} verts, bbox ({:.2}, {:.2}, {:.2}) .. ({:.2}, {:.2}, {:.2})",
        mesh.triangle_count(),
        mesh.positions.len(),
        bbox.min.x,
        bbox.min.y,
        bbox.min.z,
        bbox.max.x,
        bbox.max.y,
        bbox.max.z
    );
    eprintln!(
        "[cut] loop: {} points, {} extra loops, mode {:?}, thickness {} mm, density {}",
        options.cut.loop_points.len(),
        options.cut.extra_loops.len(),
        options.cut.mode,
        options.cut.joint_clearance_mm,
        options.cut.density
    );

    // The trace inside `contour_split` is what we came for.
    std::env::set_var("DF_CUT_DEBUG", "1");
    let outcome = organic_cut(mesh, &options);

    // What each part is actually MADE of. A part that comes back as several
    // disconnected shells is the loose islands the user sees floating beside the
    // model, and they are invisible in a triangle count.
    for (i, part) in outcome.parts.iter().enumerate() {
        let mut shells = shell_sizes(part);
        shells.sort_unstable_by(|a, b| b.cmp(a));
        let small: Vec<usize> = shells.iter().skip(1).copied().collect();
        eprintln!(
            "[cut] part {i}: {} tris in {} shell(s){}",
            part.triangle_count(),
            shells.len(),
            if small.is_empty() { String::new() } else { format!(", the loose ones {small:?}") },
        );
    }

    // Each resulting part as raw LE f32 soup, the same format the dump uses, so the
    // pieces can be rendered or diffed outside the app.
    if let Some(prefix) = out_prefix {
        for (i, part) in outcome.parts.iter().enumerate() {
            let path = format!("{prefix}-part{i}.bin");
            let soup = part.to_triangle_soup();
            std::fs::write(&path, bytemuck::cast_slice::<f32, u8>(&soup))
                .map_err(|e| format!("{path}: {e}"))?;
            eprintln!("[cut] wrote {path} ({} tris)", part.triangle_count());
        }
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&outcome.report).map_err(|e| e.to_string())?
    );
    Ok(())
}
