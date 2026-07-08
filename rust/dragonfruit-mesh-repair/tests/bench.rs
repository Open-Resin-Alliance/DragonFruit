//! Benchmark-style integration: analyze + repair a large random-ish mesh
//! and assert the pipeline finishes within a generous budget. The budget
//! here is deliberately lenient (30s on `cargo test`) so this doesn't
//! flake on CI; for a real perf gate, run the `dragonfruit-mesh-repair
//! repair` CLI and watch the `total_ms` field of the report.

use dragonfruit_mesh_repair::{analyze, repair, IndexedMesh, RepairOptions};

fn build_cube(subdiv: usize) -> IndexedMesh {
    // Generate a subdivided cube as a triangle soup, deliberately without
    // welding so the repair pipeline has work to do.
    let mut positions: Vec<f32> = Vec::with_capacity(subdiv * subdiv * 36 * 6);
    let s = subdiv as f32;

    let push_quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3], out: &mut Vec<f32>| {        out.extend_from_slice(&a);
        out.extend_from_slice(&b);
        out.extend_from_slice(&c);
        out.extend_from_slice(&a);
        out.extend_from_slice(&c);
        out.extend_from_slice(&d);
    };

    for i in 0..subdiv {
        for j in 0..subdiv {
            let u0 = i as f32 / s;
            let u1 = (i + 1) as f32 / s;
            let v0 = j as f32 / s;
            let v1 = (j + 1) as f32 / s;
            // +Z face
            push_quad([u0, v0, 1.0], [u1, v0, 1.0], [u1, v1, 1.0], [u0, v1, 1.0], &mut positions);
            // -Z face
            push_quad([u0, v1, 0.0], [u1, v1, 0.0], [u1, v0, 0.0], [u0, v0, 0.0], &mut positions);
            // +X face
            push_quad([1.0, v0, u0], [1.0, v1, u0], [1.0, v1, u1], [1.0, v0, u1], &mut positions);
            // -X face
            push_quad([0.0, v0, u1], [0.0, v1, u1], [0.0, v1, u0], [0.0, v0, u0], &mut positions);
            // +Y face
            push_quad([u0, 1.0, v1], [u1, 1.0, v1], [u1, 1.0, v0], [u0, 1.0, v0], &mut positions);
            // -Y face
            push_quad([u0, 0.0, v0], [u1, 0.0, v0], [u1, 0.0, v1], [u0, 0.0, v1], &mut positions);
        }
    }

    IndexedMesh::from_triangle_soup(&positions, 1e-5)
}

mod common;

#[test]
fn gwn_tree_build_and_queries_bounded() {
    use dragonfruit_mesh_repair::volumetric::gwn::WindingTree;
    use dragonfruit_mesh_repair::Vec3;
    // ~30k-tri sphere; 200k winding queries.
    let sphere = common::uv_sphere(Vec3::ZERO, 1.0, 120, 128);
    assert!(sphere.triangle_count() > 29_000);
    let t = std::time::Instant::now();
    let tree = WindingTree::build(&sphere);
    let build = t.elapsed();

    use rayon::prelude::*;
    let t = std::time::Instant::now();
    let inside: usize = (0..200_000usize)
        .into_par_iter()
        .filter(|i| {
            let f = *i as f32 / 200_000.0;
            let p = Vec3::new(f * 2.0 - 1.0, (f * 7.0).sin() * 0.9, (f * 13.0).cos() * 0.9);
            tree.winding(p) > 0.5
        })
        .count();
    let query = t.elapsed();
    assert!(inside > 0);
    assert!(
        build.as_secs() < 5 && query.as_secs() < 10,
        "GWN perf: build {build:?}, 200k queries {query:?}"
    );
}

#[test]
fn wrap_cluster_100k_shell_bounded() {
    use dragonfruit_mesh_repair::volumetric::{wrap_cluster, WrapOptions};
    use dragonfruit_mesh_repair::Vec3;
    // ~101k-tri open sphere (cap removed) — a big broken shell.
    let mut mesh = common::uv_sphere(Vec3::ZERO, 10.0, 225, 225);
    mesh.triangles.drain(0..300);
    assert!(mesh.triangle_count() > 100_000);
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.close_radius_voxels = 2;
    opts.fidelity_max_dist = 3.0 * opts.voxel_mm;

    let t = std::time::Instant::now();
    let (out, report) = wrap_cluster(&mesh, &opts).expect("wrap");
    let elapsed = t.elapsed();
    assert!(out.triangle_count() > 0);
    assert!(
        elapsed.as_secs() < 60,
        "wrap of 100k-tri shell took {elapsed:?} (band {}ms, sign {}ms, dc {}ms, remesh {}ms, validate {}ms)",
        report.timings_ms[0] as u64,
        report.timings_ms[1] as u64,
        report.timings_ms[2] as u64,
        report.timings_ms[3] as u64,
        report.timings_ms[4] as u64,
    );
}

#[test]
fn fragmented_soup_routing_is_selective_and_bounded() {
    use dragonfruit_mesh_repair::{repair, RepairOptions, Vec3};
    // 120 clean shells + 1 broken cluster: routing must pass the clean ones
    // through and only deep-repair the cluster.
    let mut parts = Vec::new();
    for i in 0..120 {
        let x = (i % 12) as f32 * 4.0;
        let y = (i / 12) as f32 * 4.0;
        parts.push(common::uv_sphere(Vec3::new(x, y, 20.0), 0.8, 12, 16));
    }
    parts.push(common::uv_sphere(Vec3::new(100.0, 0.0, 20.0), 1.0, 16, 24));
    parts.push(common::uv_sphere(Vec3::new(101.1, 0.0, 20.0), 1.0, 16, 24));
    let mesh = common::concat(&parts);

    let t = std::time::Instant::now();
    let outcome = repair(mesh, &RepairOptions::default());
    let elapsed = t.elapsed();
    assert!(outcome.report.shells_passthrough >= 120);
    assert!(
        outcome.report.shells_wrapped + outcome.report.shells_unioned >= 1,
        "broken cluster deep-repaired"
    );
    // Lenient soft budget: unoptimized `cargo test` runs this concurrently
    // with the 100k-shell wrap bench. In `--release` this finishes in ~2s.
    assert!(
        elapsed.as_secs() < 90,
        "selective routing took {elapsed:?} on a 122-shell soup"
    );
}

#[test]
fn large_cube_analyze_and_repair_is_bounded() {
    // 64^2 per face × 6 faces × 2 tris = ~49k tris. Small enough to keep
    // CI fast but still exercise the full topology + BVH paths.
    let subdiv = 64;
    let mesh = build_cube(subdiv);
    let pre = analyze(&mesh);
    assert!(pre.triangle_count > 40_000);

    let start = std::time::Instant::now();
    let outcome = repair(mesh, &RepairOptions::default());
    let elapsed = start.elapsed();

    assert!(
        outcome.report.post.is_watertight,
        "subdivided cube should be watertight after repair; residuals: {:?}",
        outcome.report.residual_issues,
    );
    assert!(
        elapsed.as_secs() < 30,
        "analyze+repair took {elapsed:?}; over the 30s soft budget",
    );
}
