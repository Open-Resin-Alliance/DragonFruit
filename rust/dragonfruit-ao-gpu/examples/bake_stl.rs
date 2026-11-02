//! Bake a binary STL the way the desktop app does, and time it.
//!
//! `cargo run --release --example bake_stl -- model.stl [rays]`
//!
//! The same weld and the same `bake_smoothed` call as `ao_vertex::bake_on_gpu`,
//! without the app around it, so a GPU-side failure on a large model can be
//! reproduced and measured from a terminal.

use dragonfruit_mesh_core::mesh::IndexedMesh;
use dragonfruit_mesh_core::vertex_occlusion::SOUP_MERGE_EPSILON;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: bake_stl <model.stl> [rays]");
    let rays: usize = args.next().map_or(32, |r| r.parse().expect("rays"));

    let bytes = std::fs::read(&path).expect("read STL");
    let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    let count = count.min((bytes.len() - 84) / 50);
    let mut soup = Vec::with_capacity(count * 9);
    for t in 0..count {
        let at = 84 + t * 50 + 12;
        for k in 0..9 {
            let o = at + k * 4;
            soup.push(f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
        }
    }

    let welded_at = std::time::Instant::now();
    let (mesh, _) = IndexedMesh::from_triangle_soup_with_corner_map(&soup, SOUP_MERGE_EPSILON);
    println!(
        "weld {}ms: {} triangles, {} vertices",
        welded_at.elapsed().as_millis(),
        mesh.triangles.len(),
        mesh.positions.len()
    );

    let adapter = dragonfruit_ao_gpu::adapter_name().unwrap_or("none");
    println!("adapter: {adapter}, {rays} rays");
    let baked_at = std::time::Instant::now();
    match dragonfruit_ao_gpu::bake_smoothed(&mesh, rays) {
        Ok(values) => {
            let mean = values.iter().sum::<f32>() / values.len() as f32;
            println!("bake {}ms, mean {mean:.4}", baked_at.elapsed().as_millis());
        }
        Err(e) => println!(
            "bake failed after {}ms: {e}",
            baked_at.elapsed().as_millis()
        ),
    }
}
