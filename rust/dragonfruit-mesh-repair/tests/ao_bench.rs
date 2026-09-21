//! Where the occlusion bake's time goes on real geometry.
//!
//! Throwaway unless someone is optimizing the bake again: point it at any mesh
//! and it reports the phase split (weld, tree build, bake) and a checksum of the
//! output, so a change can be shown to be both faster and the same estimator.
//!
//! `DF_AO_MODEL=<path> cargo test --release --test ao_bench -- --ignored --nocapture`
//!
//! Timings are minima over several runs: this machine varies by more than 10%
//! from run to run, which is more than most of the differences worth acting on.

use dragonfruit_mesh_core::mesh::IndexedMesh;
use dragonfruit_mesh_core::vertex_occlusion::{
    bake_vertex_occlusion, bake_vertex_occlusion_for_soup, DEFAULT_RAYS,
};
use std::time::Instant;

/// FNV-1a over the values' bits, so "the same estimator" is a claim with a number
/// behind it: a rewritten one that is merely close would pass a mean.
fn checksum(values: &[f32]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for value in values {
        for byte in value.to_bits().to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
    }
    hash
}

#[test]
#[ignore]
fn ao_bench() {
    let Ok(path) = std::env::var("DF_AO_MODEL") else {
        println!("set DF_AO_MODEL=<mesh path> to run this");
        return;
    };
    let mesh = dragonfruit_mesh_repair::io::load_mesh_from_path(std::path::Path::new(&path))
        .expect("load");
    println!(
        "model: {} faces, {} vertices",
        mesh.triangles.len(),
        mesh.positions.len()
    );

    // The soup the frontend sends.
    let mut soup = Vec::with_capacity(mesh.triangles.len() * 9);
    for triangle in &mesh.triangles {
        for vertex in triangle {
            let p = mesh.positions[*vertex as usize];
            soup.extend_from_slice(&[p.x, p.y, p.z]);
        }
    }

    let started = Instant::now();
    let welded = IndexedMesh::from_triangle_soup(&soup, 1e-5);
    let weld_ms = started.elapsed().as_secs_f64() * 1e3;
    println!(
        "  weld          {weld_ms:>8.1} ms  ({} corners -> {} vertices)",
        soup.len() / 3,
        welded.positions.len()
    );

    let started = Instant::now();
    let tree = dragonfruit_mesh_core::bvh::Bvh::build(&welded);
    let build_ms = started.elapsed().as_secs_f64() * 1e3;
    println!("  bvh build     {build_ms:>8.1} ms");
    std::hint::black_box(&tree);

    let mut best_ms = f64::MAX;
    let mut values = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        values = bake_vertex_occlusion(&welded, DEFAULT_RAYS, None);
        best_ms = best_ms.min(started.elapsed().as_secs_f64() * 1e3);
    }
    println!(
        "  bake          {best_ms:>8.1} ms  ({:.0} ns/vertex, min of 5)",
        best_ms * 1e6 / welded.positions.len() as f64
    );
    std::hint::black_box(&values);

    let started = Instant::now();
    let (out, welded_vertices) = bake_vertex_occlusion_for_soup(&soup, DEFAULT_RAYS, None);
    let total_ms = started.elapsed().as_secs_f64() * 1e3;
    println!(
        "  total         {total_ms:>8.1} ms  ({welded_vertices} welded vertices, {} values)",
        out.len()
    );

    let unoccluded = values.iter().filter(|v| **v > 0.999).count();
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    println!(
        "  signal        mean {mean:.4}, {:.1}% open sky",
        100.0 * unoccluded as f32 / values.len() as f32
    );
    println!("  checksum      {:016x}", checksum(&values));
}
