//! Benchmark-style integration: analyze + repair a large random-ish mesh
//! and assert the pipeline finishes within a generous budget. The budget
//! here is deliberately lenient (30s on `cargo test`) so this doesn't
//! flake on CI; for a real perf gate, run the `dragonfruit-mesh-repair
//! repair` CLI and watch the `total_ms` field of the report.

use dragonfruit_mesh_repair::core::mesh::Aabb;
use dragonfruit_mesh_repair::{analyze, repair, IndexedMesh, RepairOptions, Vec3};
use rayon::prelude::*;

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

/// Build a raw (unwelded) subdivided-cube soup with ~`6·subdiv²·2` triangles.
fn build_cube_soup(subdiv: usize) -> Vec<f32> {
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
            let u0 = i as f32 / s;
            let u1 = (i + 1) as f32 / s;
            let v0 = j as f32 / s;
            let v1 = (j + 1) as f32 / s;
            push_quad([u0, v0, 1.0], [u1, v0, 1.0], [u1, v1, 1.0], [u0, v1, 1.0], &mut positions);
            push_quad([u0, v1, 0.0], [u1, v1, 0.0], [u1, v0, 0.0], [u0, v0, 0.0], &mut positions);
            push_quad([1.0, v0, u0], [1.0, v1, u0], [1.0, v1, u1], [1.0, v0, u1], &mut positions);
            push_quad([0.0, v0, u1], [0.0, v1, u1], [0.0, v1, u0], [0.0, v0, u0], &mut positions);
            push_quad([u0, 1.0, v1], [u1, 1.0, v1], [u1, 1.0, v0], [u0, 1.0, v0], &mut positions);
            push_quad([u0, 0.0, v0], [u1, 0.0, v0], [u1, 0.0, v1], [u0, 0.0, v1], &mut positions);
        }
    }
    positions
}

/// CP5 measurement (not a gate): isolates the bbox-pass reclaim the parallel
/// reduction buys, and reports it against the full serial weld for context.
/// Run: `cargo test --test bench -- --ignored --nocapture`.
#[test]
#[ignore = "perf measurement; run with --ignored --nocapture"]
fn bench_weld_bbox_parallel_vs_serial() {
    let subdiv = 512; // ~3.15M triangles
    let soup = build_cube_soup(subdiv);
    let tri_count = soup.len() / 9;

    let serial_bbox = |soup: &[f32]| -> Aabb {
        let mut bbox = Aabb::empty();
        for t in soup.chunks_exact(9) {
            for c in 0..3 {
                bbox.expand(Vec3::new(t[c * 3], t[c * 3 + 1], t[c * 3 + 2]));
            }
        }
        bbox
    };
    let parallel_bbox = |soup: &[f32]| -> Aabb {
        soup.par_chunks_exact(9)
            .fold(Aabb::empty, |mut acc, t| {
                acc.expand(Vec3::new(t[0], t[1], t[2]));
                acc.expand(Vec3::new(t[3], t[4], t[5]));
                acc.expand(Vec3::new(t[6], t[7], t[8]));
                acc
            })
            .reduce(Aabb::empty, |mut a, b| {
                a.union(&b);
                a
            })
    };

    // Warm caches, then take a best-of-3 for each.
    let mut ser = f64::MAX;
    let mut par = f64::MAX;
    let (mut db_s, mut db_p) = (0.0f32, 0.0f32);
    for _ in 0..3 {
        let t = std::time::Instant::now();
        db_s = serial_bbox(&soup).diag();
        ser = ser.min(t.elapsed().as_secs_f64() * 1000.0);
        let t = std::time::Instant::now();
        db_p = parallel_bbox(&soup).diag();
        par = par.min(t.elapsed().as_secs_f64() * 1000.0);
    }
    assert_eq!(db_s, db_p, "parallel bbox diag must byte-match serial");

    let t = std::time::Instant::now();
    let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
    let full_ms = t.elapsed().as_secs_f64() * 1000.0;

    println!(
        "[CP5 bench] tris={tri_count} verts={} | bbox serial={ser:.1}ms parallel={par:.1}ms \
         reclaim={:.1}ms ({:.0}%) | full weld (parallel bbox)={full_ms:.1}ms",
        mesh.vertex_count(),
        ser - par,
        if ser > 0.0 { (ser - par) / ser * 100.0 } else { 0.0 },
    );
}
