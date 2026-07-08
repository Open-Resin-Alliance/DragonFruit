mod common;

use common::{punched_sphere, uv_sphere};
use dragonfruit_mesh_repair::core::bvh::Bvh;
use dragonfruit_mesh_repair::core::halfedge::Topology;
use dragonfruit_mesh_repair::volumetric::band::{apply_sign, build_narrow_band, BandParams};
use dragonfruit_mesh_repair::volumetric::close::morphological_close;
use dragonfruit_mesh_repair::volumetric::dc::{dual_contour, DcOptions};
use dragonfruit_mesh_repair::volumetric::gwn::WindingTree;
use dragonfruit_mesh_repair::{IndexedMesh, Vec3};

const O: Vec3 = Vec3::ZERO;

fn signed_band(
    mesh: &IndexedMesh,
    voxel: f32,
    halfwidth: f32,
) -> dragonfruit_mesh_repair::volumetric::band::SparseBand {
    let bvh = Bvh::build(mesh);
    let mut band = build_narrow_band(
        mesh,
        &bvh,
        &BandParams {
            voxel,
            halfwidth_voxels: halfwidth,
            max_corners: 20_000_000,
        },
    )
    .expect("band");
    let tree = WindingTree::build(mesh);
    apply_sign(&mut band, &tree);
    band
}

#[test]
fn punched_sphere_seals_watertight_with_close() {
    // North cap removed (2 rings ≈ hole diameter ~0.5 ≈ 6 voxels at 0.08).
    let mesh = punched_sphere(O, 1.0, 16, 24, 48);
    let voxel = 0.08;
    let mut band = signed_band(&mesh, voxel, 3.0 + 2.0);
    morphological_close(&mut band, 2);
    let out = dual_contour(&band, None, &DcOptions { manifold: true }).expect("dc");
    let topo = Topology::build(&out);
    assert_eq!(topo.boundary_edges().len(), 0, "hole must be sealed");
    assert_eq!(topo.non_manifold_edges().len(), 0);
    let vol = out.signed_volume();
    let expected = 4.0 / 3.0 * std::f64::consts::PI;
    assert!(
        (vol - expected).abs() / expected < 0.10,
        "sealed volume {vol} vs sphere {expected}"
    );
}

#[test]
fn close_is_noop_on_closed_sphere_volume() {
    let mesh = uv_sphere(O, 1.0, 24, 32);
    let voxel = 0.06;
    let mut band = signed_band(&mesh, voxel, 5.0);
    let before = dual_contour(&band, None, &DcOptions { manifold: true })
        .expect("dc")
        .signed_volume();
    morphological_close(&mut band, 2);
    let after = dual_contour(&band, None, &DcOptions { manifold: true })
        .expect("dc")
        .signed_volume();
    assert!(
        ((after - before) / before).abs() < 0.02,
        "close changed closed-sphere volume {before} -> {after}"
    );
}

#[test]
fn close_radius_zero_is_identity() {
    let mesh = uv_sphere(O, 1.0, 12, 18);
    let mut band = signed_band(&mesh, 0.1, 3.0);
    let flags = band.inside.clone();
    morphological_close(&mut band, 0);
    assert_eq!(flags, band.inside);
}
