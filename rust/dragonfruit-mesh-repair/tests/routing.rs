mod common;

use common::{concat, model_with_posts, punched_sphere, two_overlapping_cubes, uv_sphere};
use dragonfruit_mesh_repair::{analyze, repair, IndexedMesh, RepairOptions, Vec3, WrapMode};

/// Multiset of triangles keyed by exact position bytes — "bit-identical"
/// means the same triangles exist regardless of index remapping/order.
fn triangle_bytes(mesh: &IndexedMesh) -> Vec<[u8; 36]> {
    let mut out: Vec<[u8; 36]> = mesh
        .triangles
        .iter()
        .map(|t| {
            let mut b = [0u8; 36];
            for (i, &v) in t.iter().enumerate() {
                let p = mesh.positions[v as usize];
                b[i * 12..i * 12 + 4].copy_from_slice(&p.x.to_le_bytes());
                b[i * 12 + 4..i * 12 + 8].copy_from_slice(&p.y.to_le_bytes());
                b[i * 12 + 8..i * 12 + 12].copy_from_slice(&p.z.to_le_bytes());
            }
            b
        })
        .collect();
    out.sort_unstable();
    out
}

#[test]
fn healthy_shells_pass_through_bit_identical() {
    // 20 clean spheres far apart + one badly self-intersecting pair of cubes
    // (the trigger). Only the broken cluster may be touched.
    let mut parts: Vec<IndexedMesh> = Vec::new();
    for i in 0..20 {
        let x = (i % 5) as f32 * 5.0;
        let y = (i / 5) as f32 * 5.0;
        parts.push(uv_sphere(Vec3::new(x, y, 30.0), 1.0, 10, 14));
    }
    let clean = concat(&parts);
    let clean_tris = triangle_bytes(&clean);
    // Broken cluster: two dense overlapping spheres (plenty of
    // self-intersections to trip the trigger), well clear of the clean ones.
    let broken = concat(&[
        uv_sphere(Vec3::new(50.0, 0.0, 30.0), 1.0, 16, 24),
        uv_sphere(Vec3::new(51.1, 0.0, 30.0), 1.0, 16, 24),
    ]);
    let mesh = concat(&[clean.clone(), broken]);

    let outcome = repair(mesh, &RepairOptions::default());
    assert!(outcome
        .report
        .steps
        .iter()
        .any(|s| s.name == "route_shells"));
    assert!(
        outcome.report.shells_passthrough >= 20,
        "expected >= 20 passthrough shells, got {}",
        outcome.report.shells_passthrough
    );

    let out_tris = triangle_bytes(&outcome.mesh);
    let mut missing = 0;
    let mut idx = 0;
    for t in &clean_tris {
        while idx < out_tris.len() && &out_tris[idx] < t {
            idx += 1;
        }
        if idx >= out_tris.len() || &out_tris[idx] != t {
            missing += 1;
        } else {
            idx += 1;
        }
    }
    assert_eq!(
        missing, 0,
        "clean shells must survive bit-identical ({missing} of {} triangles lost)",
        clean_tris.len()
    );
    // And the broken cluster actually got repaired.
    let post = analyze(&outcome.mesh);
    assert_eq!(post.self_intersection_triangles, 0, "intersections resolved");
}

#[test]
fn intersecting_open_shells_cluster_and_wrap_together() {
    // Two overlapping spheres, both with holes: not unionable (open), so the
    // cluster must wrap into a single watertight body.
    let mesh = concat(&[
        punched_sphere(Vec3::new(0.0, 0.0, 10.0), 1.0, 16, 24, 24),
        punched_sphere(Vec3::new(1.2, 0.0, 10.0), 1.0, 16, 24, 24),
    ]);
    let options = RepairOptions {
        fill_holes_max_edges: 8, // keep the holes open into the deep path
        ..RepairOptions::default()
    };
    let outcome = repair(mesh, &options);
    assert!(
        outcome.report.shells_wrapped >= 1,
        "cluster should wrap: {:?}",
        outcome.report.steps.iter().map(|s| &s.name).collect::<Vec<_>>()
    );
    let post = analyze(&outcome.mesh);
    assert!(post.is_watertight, "wrap output watertight");
    assert_eq!(post.connected_components, 1, "shells fused into one body");
    assert_eq!(post.self_intersection_triangles, 0);
    assert_eq!(post.non_manifold_edges, 0);
}

#[test]
fn model_support_groups_never_merge() {
    // Intra-group intersections in BOTH groups; groups must repair
    // independently and never fuse across the model/support boundary.
    let mesh = model_with_posts(true, true);
    let outcome = repair(mesh, &RepairOptions::default());

    let mtc = outcome
        .report
        .model_triangle_count
        .expect("model/support split must survive routing");
    assert!(mtc > 0 && mtc < outcome.mesh.triangles.len());

    // No connected component may span the model/support section boundary.
    let comps = {
        // triangle_components is crate-private; recompute via analyze-level
        // union-find: shared vertices ⇒ same component.
        let mut parent: Vec<u32> = (0..outcome.mesh.triangles.len() as u32).collect();
        fn find(p: &mut Vec<u32>, x: u32) -> u32 {
            let mut r = x;
            while p[r as usize] != r {
                r = p[r as usize];
            }
            let mut c = x;
            while p[c as usize] != r {
                let n = p[c as usize];
                p[c as usize] = r;
                c = n;
            }
            r
        }
        let mut vert_owner: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
        for (fi, t) in outcome.mesh.triangles.iter().enumerate() {
            for &v in t {
                match vert_owner.entry(v) {
                    std::collections::hash_map::Entry::Occupied(e) => {
                        let a = find(&mut parent, *e.get());
                        let b = find(&mut parent, fi as u32);
                        if a != b {
                            parent[a as usize] = b;
                        }
                    }
                    std::collections::hash_map::Entry::Vacant(e) => {
                        e.insert(fi as u32);
                    }
                }
            }
        }
        (0..outcome.mesh.triangles.len() as u32)
            .map(|f| find(&mut parent, f))
            .collect::<Vec<u32>>()
    };
    let mut span_min: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    let mut span_max: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for (fi, root) in comps.iter().enumerate() {
        span_min.entry(*root).or_insert(fi);
        span_max.insert(*root, fi);
    }
    for (root, &lo) in &span_min {
        let hi = span_max[root];
        assert!(
            (lo < mtc) == (hi < mtc),
            "component spans the model/support boundary (faces {lo}..{hi}, split at {mtc})"
        );
    }

    // The model section sits high, the support section low.
    let section_z = |from: usize, to: usize| -> (f32, f32) {
        let mut lo = f32::INFINITY;
        let mut hi = f32::NEG_INFINITY;
        for t in &outcome.mesh.triangles[from..to] {
            for &v in t {
                let z = outcome.mesh.positions[v as usize].z;
                lo = lo.min(z);
                hi = hi.max(z);
            }
        }
        (lo, hi)
    };
    let (model_lo, _) = section_z(0, mtc);
    let (support_lo, support_hi) = section_z(mtc, outcome.mesh.triangles.len());
    assert!(model_lo > 6.5, "model section should be the high sphere body");
    assert!(support_lo < 0.5 && support_hi < 7.0, "support section = posts");

    // Both groups actually got their intersections resolved.
    let post = analyze(&outcome.mesh);
    assert_eq!(
        post.self_intersection_triangles,
        0,
        "steps: {:?} flags: {:?} shells: pt={} local={} union={} wrap={} fb={}",
        outcome
            .report
            .steps
            .iter()
            .map(|s| format!("{}:{}", s.name, s.notes.clone().unwrap_or_default()))
            .collect::<Vec<_>>(),
        outcome.report.wrap_flags,
        outcome.report.shells_passthrough,
        outcome.report.shells_local,
        outcome.report.shells_unioned,
        outcome.report.shells_wrapped,
        outcome.report.shells_fallback,
    );
}

#[test]
fn debris_not_individually_wrapped() {
    // One big broken cluster + tiny broken debris shells. Only the big
    // cluster gets a wrap/union; debris ships verbatim.
    let mut parts: Vec<IndexedMesh> = vec![{
        let mut b = two_overlapping_cubes();
        for p in &mut b.positions {
            p.z += 20.0;
        }
        b
    }];
    for i in 0..12 {
        // 8-triangle open fans (< wrap_min_shell_triangles, > shard size).
        let base = Vec3::new(i as f32 * 3.0, 10.0, 20.0);
        let mut fan = IndexedMesh::new();
        fan.positions.push(base);
        for k in 0..9 {
            let a = k as f32 * 0.5;
            fan.positions
                .push(Vec3::new(base.x + a.cos() * 0.1, base.y + a.sin() * 0.1, base.z));
        }
        for k in 0..8u32 {
            fan.triangles.push([0, k + 1, k + 2]);
        }
        parts.push(fan);
    }
    let mesh = concat(&parts);
    let outcome = repair(mesh, &RepairOptions::default());
    assert!(
        outcome.report.shells_wrapped + outcome.report.shells_unioned <= 1,
        "only the big cluster may be deep-repaired (wrapped={}, unioned={})",
        outcome.report.shells_wrapped,
        outcome.report.shells_unioned
    );
    assert!(outcome.mesh.triangle_count() > 0);
}

#[test]
fn wrap_failure_falls_back_to_original_with_residual_flag() {
    let mesh = punched_sphere(Vec3::new(0.0, 0.0, 10.0), 1.0, 24, 32, 48);
    let in_tris = mesh.triangle_count();
    let options = RepairOptions {
        fill_holes_max_edges: 8,
        wrap_max_cells_per_cluster: 64, // impossible budget ⇒ wrap must fail
        wrap_max_cells_total: 64,
        ..RepairOptions::default()
    };
    let outcome = repair(mesh, &options);
    assert!(
        outcome.report.shells_fallback >= 1,
        "wrap failure must fall back: {:?}",
        outcome.report.wrap_flags
    );
    assert!(
        outcome
            .report
            .wrap_flags
            .iter()
            .any(|f| f.starts_with("cluster_kept_original") || f == "wrap_budget_exhausted"),
        "flags: {:?}",
        outcome.report.wrap_flags
    );
    // Geometry preserved, not dropped.
    assert!(
        outcome.mesh.triangle_count() >= in_tris * 9 / 10,
        "original geometry must survive the fallback"
    );
}

#[test]
fn wrap_off_preserves_legacy_path() {
    let mesh = two_overlapping_cubes();
    let options = RepairOptions {
        wrap_mode: WrapMode::Off,
        ..RepairOptions::default()
    };
    let outcome = repair(mesh, &options);
    assert!(
        !outcome.report.steps.iter().any(|s| s.name == "route_shells"),
        "routing must not run with wrap_mode=off"
    );
    assert_eq!(outcome.report.shells_total, 0);
}

#[test]
fn open_mesh_triggers_deep_path_via_widened_signals() {
    // Large hole (loop > fill_holes_max_edges), zero self-intersections:
    // the legacy trigger would skip this mesh entirely; the widened trigger
    // routes it and the wrap seals it.
    let mesh = punched_sphere(Vec3::new(0.0, 0.0, 10.0), 1.0, 24, 96, 192);
    let pre = analyze(&mesh);
    assert_eq!(pre.self_intersection_triangles, 0);
    assert!(pre.largest_boundary_loop > 64, "fixture must have a big hole");

    let outcome = repair(mesh, &RepairOptions::default());
    assert!(
        outcome.report.steps.iter().any(|s| s.name == "route_shells"),
        "widened trigger should engage the deep path"
    );
    let post = analyze(&outcome.mesh);
    assert!(post.is_watertight, "big hole should be sealed by the wrap");
    assert_eq!(post.non_manifold_edges, 0);
}
