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
