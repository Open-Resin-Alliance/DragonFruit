mod common;

use common::{cube_at, uv_sphere};
use dragonfruit_mesh_repair::core::bvh::Bvh;
use dragonfruit_mesh_repair::core::halfedge::Topology;
use dragonfruit_mesh_repair::volumetric::band::{apply_sign, build_narrow_band, BandParams};
use dragonfruit_mesh_repair::volumetric::dc::{dual_contour, DcOptions, HermiteSource};
use dragonfruit_mesh_repair::volumetric::gwn::WindingTree;
use dragonfruit_mesh_repair::{IndexedMesh, Vec3};

const O: Vec3 = Vec3::ZERO;

fn contour(mesh: &IndexedMesh, voxel: f32, hermite: bool, manifold: bool) -> IndexedMesh {
    let bvh = Bvh::build(mesh);
    let mut band = build_narrow_band(
        mesh,
        &bvh,
        &BandParams {
            voxel,
            halfwidth_voxels: 3.0,
            max_corners: 20_000_000,
        },
    )
    .expect("band");
    let tree = WindingTree::build(mesh);
    apply_sign(&mut band, &tree);
    let src = HermiteSource { mesh, bvh: &bvh };
    dual_contour(
        &band,
        if hermite { Some(&src) } else { None },
        &DcOptions { manifold },
    )
    .expect("dc")
}

fn assert_watertight_manifold(m: &IndexedMesh) {
    let topo = Topology::build(m);
    assert_eq!(
        topo.boundary_edges().len(),
        0,
        "boundary edges in DC output"
    );
    assert_eq!(
        topo.non_manifold_edges().len(),
        0,
        "non-manifold edges in DC output"
    );
}

#[test]
fn dc_sphere_is_watertight_masspoint() {
    let sphere = uv_sphere(O, 1.0, 24, 32);
    let out = contour(&sphere, 0.08, false, false);
    assert!(out.triangle_count() > 100);
    assert_watertight_manifold(&out);
    assert!(out.signed_volume() > 0.0, "outward orientation by construction");
}

#[test]
fn dc_sphere_volume_within_5pct() {
    let sphere = uv_sphere(O, 1.0, 32, 48);
    let out = contour(&sphere, 0.05, false, false);
    let vol = out.signed_volume();
    let expected = 4.0 / 3.0 * std::f64::consts::PI;
    assert!(
        (vol - expected).abs() / expected < 0.05,
        "volume {vol} vs sphere {expected}"
    );
}

#[test]
fn dc_sphere_watertight_with_hermite_qef() {
    let sphere = uv_sphere(O, 1.0, 24, 32);
    let out = contour(&sphere, 0.08, true, false);
    assert_watertight_manifold(&out);
    assert!(out.signed_volume() > 0.0);
}

#[test]
fn dc_cube_recovers_sharp_geometry() {
    let cube = cube_at(O, 2.0);
    let voxel = 0.11; // deliberately off-grid from the cube faces
    let out = contour(&cube, voxel, true, false);
    assert_watertight_manifold(&out);
    // Every output vertex should lie on (or extremely near) the true cube
    // surface: max coordinate magnitude ≈ 1.
    let mut worst = 0.0f32;
    for p in &out.positions {
        let linf = p.x.abs().max(p.y.abs()).max(p.z.abs());
        worst = worst.max((linf - 1.0).abs());
    }
    assert!(
        worst < 0.3 * voxel,
        "hermite QEF should pin vertices to cube faces, worst deviation {worst}"
    );
    // Corners: some vertex must sit within half a voxel of each true corner.
    for sx in [-1.0f32, 1.0] {
        for sy in [-1.0f32, 1.0] {
            for sz in [-1.0f32, 1.0] {
                let corner = Vec3::new(sx, sy, sz);
                let best = out
                    .positions
                    .iter()
                    .map(|p| p.sub(corner).length())
                    .fold(f32::INFINITY, f32::min);
                assert!(
                    best < 0.5 * voxel,
                    "no vertex near corner {corner:?} (best {best})"
                );
            }
        }
    }
    let vol = out.signed_volume();
    assert!((vol - 8.0).abs() / 8.0 < 0.02, "cube volume {vol} vs 8");
}

#[test]
fn dc_masspoint_cube_rounds_corners() {
    // Sanity contrast for the hermite test: without hermite data the cube
    // corners round off — worst deviation should be clearly larger.
    let cube = cube_at(O, 2.0);
    let voxel = 0.11;
    let out = contour(&cube, voxel, false, false);
    assert_watertight_manifold(&out);
    let mut worst = 0.0f32;
    for p in &out.positions {
        let linf = p.x.abs().max(p.y.abs()).max(p.z.abs());
        worst = worst.max((linf - 1.0).abs());
    }
    assert!(
        worst > 0.3 * voxel,
        "mass-point placement unexpectedly sharp ({worst}) — hermite test may be vacuous"
    );
}

#[test]
fn dc_manifold_thin_plate_stays_manifold() {
    // Thin slab ~1.4 voxels thick: opposing surfaces run through the same
    // cells, which is exactly where single-vertex-per-cell DC pinches.
    let voxel = 0.1;
    let slab = cube_at(Vec3::new(0.0, 0.0, 0.0), 1.0);
    let slab = {
        let mut m = slab;
        for p in &mut m.positions {
            p.z *= 0.14; // 1.4 voxels thick
        }
        m
    };
    let out = contour(&slab, voxel, true, true);
    assert!(out.triangle_count() > 0);
    assert_watertight_manifold(&out);
}

#[test]
fn dc_near_tangent_spheres_manifold() {
    let voxel = 0.08;
    let m = common::concat(&[
        uv_sphere(Vec3::new(0.0, 0.0, 0.0), 1.0, 24, 32),
        uv_sphere(Vec3::new(2.05, 0.0, 0.0), 1.0, 24, 32),
    ]);
    let out = contour(&m, voxel, true, true);
    assert_watertight_manifold(&out);
}
