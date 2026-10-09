//! The GPU bake exists to be faster, not to be a second estimator: it has to
//! agree with the CPU's values on the same mesh and the same fan.
//!
//! Skips (with a printed note) where wgpu finds no adapter, because the CPU path
//! is the shipped one and this crate is an accelerator.

use dragonfruit_mesh_core::mesh::IndexedMesh;
use dragonfruit_mesh_core::vertex_occlusion::bake_vertex_occlusion;

fn slot_fixture() -> IndexedMesh {
    let size = 60.0f32;
    let step = 0.5f32;
    let cells = (size / step) as u32;
    let at = |x: u32, y: u32| [x as f32 * step, y as f32 * step, 0.0];
    let mut soup = Vec::new();
    for x in 0..cells {
        for y in 0..cells {
            let (a, b, c, d) = (at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
            soup.extend_from_slice(&[a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]]);
            soup.extend_from_slice(&[a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]]);
        }
    }
    // Two walls over the middle of the floor, so the field carries real occlusion
    // rather than a constant.
    for (y0, y1) in [(20.0f32, 20.5f32), (26.0, 26.5)] {
        let c = [
            [0.0f32, y0, 0.0],
            [60.0, y0, 0.0],
            [60.0, y1, 0.0],
            [0.0, y1, 0.0],
            [0.0, y0, 8.0],
            [60.0, y0, 8.0],
            [60.0, y1, 8.0],
            [0.0, y1, 8.0],
        ];
        let faces: [[usize; 4]; 6] = [
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [1, 2, 6, 5],
            [2, 3, 7, 6],
            [3, 0, 4, 7],
        ];
        for f in faces {
            for tri in [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] {
                for i in tri {
                    soup.extend_from_slice(&c[i]);
                }
            }
        }
    }
    IndexedMesh::from_triangle_soup(&soup, 1e-5)
}

#[test]
fn the_gpu_bake_agrees_with_the_cpu_one() {
    if !dragonfruit_ao_gpu::available() {
        println!("no GPU adapter here; the CPU path is the shipped one, so this skips");
        return;
    }
    let mesh = slot_fixture();
    let rays = 16;

    let gpu = dragonfruit_ao_gpu::bake_raw(&mesh, rays, false).expect("gpu bake");
    let cpu = bake_vertex_occlusion(&mesh, rays, None);
    assert_eq!(gpu.len(), cpu.len(), "one value per vertex on both sides");

    let mut worst = 0.0f32;
    let mut worst_index = 0usize;
    let mut sum = 0.0f64;
    for (i, (a, b)) in cpu.iter().zip(gpu.iter()).enumerate() {
        let d = (a - b).abs();
        sum += d as f64;
        if d > worst {
            worst = d;
            worst_index = i;
        }
    }
    let mean = sum / cpu.len() as f64;
    println!(
        "adapter {:?}: mean |diff| {mean:.6}, max {worst:.6}",
        dragonfruit_ao_gpu::adapter_name()
    );
    assert!(mean < 1e-4, "the GPU field should track the CPU's: mean {mean}");
    // A single vertex can differ where a grazing ray lands on one side of the
    // epsilon and not the other; the mesh-core measurements put that class of
    // divergence at up to 0.04 on a 2.8M-face model.
    assert!(
        worst < 0.05,
        "one vertex differs by {worst} at {worst_index}: {} against {}",
        cpu[worst_index],
        gpu[worst_index]
    );
}
