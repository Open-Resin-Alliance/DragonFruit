mod common;

use common::{concat, cube_at, nested_cubes, punched_sphere, two_overlapping_cubes, uv_sphere};
use dragonfruit_mesh_repair::analyze;
use dragonfruit_mesh_repair::volumetric::{wrap_cluster, WrapError, WrapOptions};
use dragonfruit_mesh_repair::Vec3;

const O: Vec3 = Vec3::ZERO;

#[test]
fn wrap_self_intersecting_cubes_become_one_clean_shell() {
    let mesh = two_overlapping_cubes();
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.voxel_mm = 0.08;
    opts.fidelity_max_dist = 2.0 * opts.voxel_mm;
    let (out, report) = wrap_cluster(&mesh, &opts).expect("wrap");
    let a = analyze(&out);
    assert!(a.is_watertight, "watertight");
    assert_eq!(a.non_manifold_edges, 0);
    assert_eq!(a.self_intersection_triangles, 0, "intersections dissolved");
    assert_eq!(a.connected_components, 1, "single unioned shell");
    // Union volume of two 2³ cubes overlapping 0.8×2×2.
    let expected = 8.0 + 8.0 - 0.8 * 2.0 * 2.0;
    let vol = out.signed_volume();
    assert!(
        (vol - expected).abs() / expected < 0.05,
        "union volume {vol} vs {expected}"
    );
    assert!(report.out_triangles > 0 && report.active_corners > 0);
}

#[test]
fn wrap_open_shell_closes() {
    let mesh = punched_sphere(O, 1.0, 16, 24, 48);
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.voxel_mm = 0.08;
    opts.close_radius_voxels = 2;
    opts.fidelity_max_dist = 3.0 * opts.voxel_mm;
    let (out, _) = wrap_cluster(&mesh, &opts).expect("wrap");
    let a = analyze(&out);
    assert!(a.is_watertight, "hole sealed");
    assert_eq!(a.non_manifold_edges, 0);
    let vol = out.signed_volume();
    let expected = 4.0 / 3.0 * std::f64::consts::PI;
    assert!(
        (vol - expected).abs() / expected < 0.12,
        "sealed volume {vol} vs sphere {expected}"
    );
}

#[test]
fn wrap_dissolves_interior_debris() {
    let mesh = nested_cubes();
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.voxel_mm = 0.15;
    let (out, _) = wrap_cluster(&mesh, &opts).expect("wrap");
    let a = analyze(&out);
    assert!(a.is_watertight);
    assert_eq!(a.connected_components, 1, "inner debris cube dissolved");
    let vol = out.signed_volume();
    assert!((vol - 64.0).abs() / 64.0 < 0.05, "outer volume {vol} vs 64");
}

#[test]
fn wrap_respects_corner_budget() {
    let mesh = uv_sphere(O, 1.0, 16, 24);
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.voxel_mm = 0.01;
    opts.max_active_corners = 5_000;
    let (err, _) = wrap_cluster(&mesh, &opts).unwrap_err();
    assert!(matches!(err, WrapError::BudgetExceeded { .. }));
}

#[test]
fn wrap_fidelity_gate_rejects_rather_than_ships_junk() {
    // Absurdly tight gate: the wrap must refuse, not silently ship.
    let mesh = uv_sphere(O, 1.0, 16, 24);
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.voxel_mm = 0.2;
    opts.fidelity_max_dist = 1e-4;
    let (err, _) = wrap_cluster(&mesh, &opts).unwrap_err();
    assert!(matches!(err, WrapError::FidelityRegression { .. }));
}

#[test]
fn wrap_output_respects_triangle_budget() {
    let mesh = uv_sphere(O, 1.0, 32, 48);
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.voxel_mm = 0.04;
    opts.target_triangles = 3_000;
    opts.fidelity_max_dist = 3.0 * opts.voxel_mm;
    let (out, report) = wrap_cluster(&mesh, &opts).expect("wrap");
    assert!(
        out.triangle_count() <= 3_600,
        "budget missed: {}",
        out.triangle_count()
    );
    assert!(report.dc_triangles > out.triangle_count(), "decimation happened");
    let a = analyze(&out);
    assert!(a.is_watertight);
    assert_eq!(a.non_manifold_edges, 0);
}

#[test]
fn wrap_thin_walls_flagged_and_close_skipped() {
    // Hollow shell: sphere with an inverted inner sphere 0.15 apart — a
    // 0.15 mm wall. At voxel 0.08, 2.5 voxels = 0.2 > wall ⇒ thin.
    let outer = uv_sphere(O, 1.0, 24, 32);
    let inner = {
        let mut m = uv_sphere(O, 0.85, 24, 32);
        for t in &mut m.triangles {
            t.swap(1, 2);
        }
        m
    };
    let mesh = concat(&[outer, inner]);
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.voxel_mm = 0.05;
    opts.close_radius_voxels = 2;
    opts.fidelity_max_dist = 3.0 * opts.voxel_mm;
    let (out, report) = wrap_cluster(&mesh, &opts).expect("wrap");
    assert!(
        report.thin_wall_fraction > 0.5,
        "thin walls undetected: {}",
        report.thin_wall_fraction
    );
    assert!(report.close_skipped_for_thin_walls, "close must be skipped");
    let a = analyze(&out);
    assert!(a.is_watertight);
    assert_eq!(
        a.connected_components, 2,
        "hollow shell preserved (outer + inner surface)"
    );
}

#[test]
fn wrap_preserves_sharp_cube_geometry() {
    let mesh = cube_at(O, 2.0);
    let mut opts = WrapOptions::for_diagonal(mesh.bbox().diag());
    opts.voxel_mm = 0.1;
    opts.fidelity_max_dist = 2.0 * opts.voxel_mm;
    let (out, _) = wrap_cluster(&mesh, &opts).expect("wrap");
    let a = analyze(&out);
    assert!(a.is_watertight);
    let vol = out.signed_volume();
    assert!((vol - 8.0).abs() / 8.0 < 0.03, "cube volume {vol} vs 8");
}
