//! Interactive hollow-preview benchmark.
//!
//! Ignored by default; run it to see where a parameter change spends its time:
//!
//! ```sh
//! cargo test --release --test hollow_bench -- --ignored --nocapture
//! ```
//!
//! The preview path in the app uses `preview_voxel_spheres` (no output mesh),
//! so this measures the session build (voxel size changes) and `run` (shell
//! thickness changes) separately, plus the byte serialization the command does.

use dragonfruit_mesh_repair::{HollowOptions, HollowSession, IndexedMesh};
use std::time::Instant;

/// A subdivided, welded cube of `size` mm per side.
fn build_cube(subdiv: usize, size: f32) -> IndexedMesh {
    let mut positions: Vec<f32> = Vec::with_capacity(subdiv * subdiv * 36 * 6);
    let s = subdiv as f32;

    let push_quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3], out: &mut Vec<f32>| {
        out.extend_from_slice(&a);
        out.extend_from_slice(&b);
        out.extend_from_slice(&c);
        out.extend_from_slice(&a);
        out.extend_from_slice(&c);
        out.extend_from_slice(&d);
    };

    for i in 0..subdiv {
        for j in 0..subdiv {
            let u0 = i as f32 / s * size;
            let u1 = (i + 1) as f32 / s * size;
            let v0 = j as f32 / s * size;
            let v1 = (j + 1) as f32 / s * size;
            let z1 = size;
            // +Z
            push_quad([u0, v0, z1], [u1, v0, z1], [u1, v1, z1], [u0, v1, z1], &mut positions);
            // -Z
            push_quad([u0, v1, 0.0], [u1, v1, 0.0], [u1, v0, 0.0], [u0, v0, 0.0], &mut positions);
            // +X
            push_quad([z1, v0, u0], [z1, v1, u0], [z1, v1, u1], [z1, v0, u1], &mut positions);
            // -X
            push_quad([0.0, v0, u1], [0.0, v1, u1], [0.0, v1, u0], [0.0, v0, u0], &mut positions);
            // +Y
            push_quad([u0, z1, v1], [u1, z1, v1], [u1, z1, v0], [u0, z1, v0], &mut positions);
            // -Y
            push_quad([u0, 0.0, v0], [u1, 0.0, v0], [u1, 0.0, v1], [u0, 0.0, v1], &mut positions);
        }
    }

    IndexedMesh::from_triangle_soup(&positions, 1e-5)
}

fn preview_options(resolution: u16, shell_mm: f32) -> HollowOptions {
    HollowOptions {
        voxel_resolution: resolution,
        shell_thickness_mm: shell_mm,
        preview_voxel_spheres: true,
        preview_cavity_only: true,
        ..HollowOptions::default()
    }
}

#[test]
#[ignore]
fn hollow_preview_bench() {
    let subdiv = 128; // ~98k triangles
    let mesh = build_cube(subdiv, 80.0);
    println!("mesh: {} triangles, {} vertices", mesh.triangle_count(), mesh.positions.len());

    for resolution in [64u16, 96, 144, 192] {
        let started = Instant::now();
        let session = HollowSession::with_rotation(mesh.clone(), resolution, [0.0, 0.0, 0.0, 1.0]);
        let build = started.elapsed();

        let mut runs = Vec::new();
        for shell in [1.0f32, 2.0, 3.0] {
            let options = preview_options(resolution, shell);
            let started = Instant::now();
            let outcome = session.run(&options);
            let elapsed = started.elapsed();
            runs.push((shell, elapsed, outcome.removed_voxel_centers.len()));
        }

        // The command's byte work: source soup + the collected arrays.
        let options = preview_options(resolution, 2.0);
        let outcome = session.run(&options);
        let started = Instant::now();
        let soup = outcome.mesh.to_triangle_soup();
        let positions_bytes = bytemuck::cast_slice::<f32, u8>(&soup).to_vec();
        let centers_bytes = bytemuck::cast_slice::<f32, u8>(&outcome.removed_voxel_centers).to_vec();
        let indices_bytes = bytemuck::cast_slice::<u32, u8>(&outcome.removed_voxel_indices).to_vec();
        let serialize = started.elapsed();

        println!(
            "res {resolution:3}: session build {build:>9.2?} | {} | serialize {:>7.2?} ({} + {} + {} bytes)",
            runs.iter()
                .map(|(shell, elapsed, removed)| format!("shell {shell}: run {elapsed:>8.2?} ({removed} removed)"))
                .collect::<Vec<_>>()
                .join(" | "),
            serialize,
            positions_bytes.len(),
            centers_bytes.len(),
            indices_bytes.len(),
        );
    }
}
