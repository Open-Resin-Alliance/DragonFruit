mod common;

use common::uv_sphere;
use dragonfruit_mesh_repair::core::bvh::Bvh;
use dragonfruit_mesh_repair::volumetric::band::{apply_sign, build_narrow_band, BandParams};
use dragonfruit_mesh_repair::volumetric::gwn::WindingTree;
use dragonfruit_mesh_repair::volumetric::WrapError;
use dragonfruit_mesh_repair::Vec3;

const O: Vec3 = Vec3::ZERO;

#[test]
fn band_corner_count_tracks_surface_area() {
    let sphere = uv_sphere(O, 1.0, 32, 48);
    let bvh = Bvh::build(&sphere);
    let voxel = 0.05;
    let halfwidth = 3.0;
    let band = build_narrow_band(
        &sphere,
        &bvh,
        &BandParams {
            voxel,
            halfwidth_voxels: halfwidth,
            max_corners: 10_000_000,
        },
    )
    .expect("band build");
    // ~ area / voxel² × (2·halfwidth) lattice points hug the surface.
    let expected = (4.0 * std::f32::consts::PI / (voxel * voxel)) * (2.0 * halfwidth);
    let n = band.len() as f32;
    assert!(
        n > expected * 0.5 && n < expected * 2.0,
        "corner count {n} vs expected ~{expected}"
    );
}

#[test]
fn band_distances_bounded_and_positive() {
    let sphere = uv_sphere(O, 1.0, 16, 24);
    let bvh = Bvh::build(&sphere);
    let band = build_narrow_band(
        &sphere,
        &bvh,
        &BandParams {
            voxel: 0.08,
            halfwidth_voxels: 3.0,
            max_corners: 10_000_000,
        },
    )
    .expect("band build");
    let limit = 3.0 * 0.08 + 1e-6;
    for (i, &d) in band.dist.iter().enumerate() {
        assert!(d > 0.0, "corner {i} has non-positive distance {d}");
        assert!(d <= limit, "corner {i} distance {d} beyond band {limit}");
    }
}

#[test]
fn band_sign_matches_analytic_sphere() {
    let sphere = uv_sphere(O, 1.0, 24, 32);
    let bvh = Bvh::build(&sphere);
    let voxel = 0.06;
    let mut band = build_narrow_band(
        &sphere,
        &bvh,
        &BandParams {
            voxel,
            halfwidth_voxels: 3.0,
            max_corners: 10_000_000,
        },
    )
    .expect("band build");
    let tree = WindingTree::build(&sphere);
    apply_sign(&mut band, &tree);

    let mut checked = 0;
    for (i, key) in band.keys.iter().enumerate() {
        let p = band.corner_pos(*key);
        let r = p.length();
        // Skip the shell where the tessellated sphere legitimately differs
        // from the analytic one.
        if (r - 1.0).abs() < voxel {
            continue;
        }
        assert_eq!(
            band.inside[i],
            r < 1.0,
            "corner at {p:?} (r={r}) misclassified"
        );
        checked += 1;
    }
    assert!(checked > 1000, "too few corners checked: {checked}");
}

#[test]
fn band_sign_flips_exactly_once_along_wall_probe() {
    let sphere = uv_sphere(O, 1.0, 24, 32);
    let bvh = Bvh::build(&sphere);
    let mut band = build_narrow_band(
        &sphere,
        &bvh,
        &BandParams {
            voxel: 0.06,
            halfwidth_voxels: 3.0,
            max_corners: 10_000_000,
        },
    )
    .expect("band build");
    let tree = WindingTree::build(&sphere);
    apply_sign(&mut band, &tree);

    // Walk +x from inside the band toward outside near (1, 0, 0); the signed
    // field must flip inside→outside exactly once.
    // Find the lattice j,k nearest the x axis.
    let jc = ((0.0 - band.origin.y) / band.voxel).round() as i32;
    let kc = ((0.0 - band.origin.z) / band.voxel).round() as i32;
    let mut states: Vec<bool> = Vec::new();
    let i0 = ((0.8 - band.origin.x) / band.voxel).floor() as i32;
    let i1 = ((1.2 - band.origin.x) / band.voxel).ceil() as i32;
    for i in i0..=i1 {
        if let Some(&idx) = band.index.get(&(i, jc, kc)) {
            states.push(band.inside[idx as usize]);
        }
    }
    assert!(states.len() >= 4, "probe found too few corners");
    let flips = states.windows(2).filter(|w| w[0] != w[1]).count();
    assert_eq!(flips, 1, "expected exactly one sign flip, states {states:?}");
    assert!(states[0], "probe should start inside");
    assert!(!states[states.len() - 1], "probe should end outside");
}

#[test]
fn band_budget_abort() {
    let sphere = uv_sphere(O, 1.0, 24, 32);
    let bvh = Bvh::build(&sphere);
    let err = build_narrow_band(
        &sphere,
        &bvh,
        &BandParams {
            voxel: 0.01,
            halfwidth_voxels: 3.0,
            max_corners: 1_000,
        },
    )
    .unwrap_err();
    assert!(matches!(err, WrapError::BudgetExceeded { .. }));
}
